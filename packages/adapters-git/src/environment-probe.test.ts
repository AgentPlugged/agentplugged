import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeEnvironmentProbe } from "./environment-probe.js";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agentplugged-environment-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const windows = process.platform === "win32";

/** A program in `dir`: a batch file on Windows, a script elsewhere. */
async function program(dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, windows ? `${name}.cmd` : name);
  await writeFile(
    path,
    windows ? "@echo off\r\necho %~1 1.2.3\r\n" : '#!/bin/sh\necho "$1 1.2.3"\n',
  );
  if (!windows) await chmod(path, 0o755);
  return path;
}

const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
};

describe("find", () => {
  it("finds a program on the PATH, and off it only in a folder the catalogue names", async () => {
    const bin = join(root, "bin");
    const path = await program(bin, "agentplugged-fake");
    const onPath = new NodeEnvironmentProbe({
      cwd: root,
      env: { PATH: bin, PATHEXT: ".CMD;.EXE" },
    });
    expect(await onPath.find(["agentplugged-fake"])).toEqual({
      name: "agentplugged-fake",
      path,
      onPath: true,
    });
    const elsewhere = new NodeEnvironmentProbe({
      cwd: root,
      env: { PATH: "", PATHEXT: ".CMD;.EXE", FAKE_BASE: root },
    });
    expect(await elsewhere.find(["agentplugged-fake"])).toBeUndefined();
    expect(
      await elsewhere.find(["agentplugged-fake"], [{ env: "FAKE_BASE", path: ["bin"] }]),
    ).toEqual({ name: "agentplugged-fake", path, onPath: false });
    // A folder meant for another command does not reveal this one.
    expect(
      await elsewhere.find(
        ["agentplugged-fake"],
        [{ for: "other", env: "FAKE_BASE", path: ["bin"] }],
      ),
    ).toBeUndefined();
  });

  it("ignores a relative folder of the PATH: a file of the open repository is no program of the machine", async () => {
    await program(root, "agentplugged-fake");
    const probe = new NodeEnvironmentProbe({
      cwd: root,
      env: { PATH: [".", "relative"].join(windows ? ";" : ":"), PATHEXT: ".CMD;.EXE" },
    });
    expect(await probe.find(["agentplugged-fake"])).toBeUndefined();
  });

  it("answers the folders of the catalogue for this machine only", () => {
    const probe = new NodeEnvironmentProbe({
      cwd: root,
      env: { USERPROFILE: "C:\\Users\\ada", HOME: "/home/ada", BASE: "base" },
    });
    const folders = probe.directories([
      { env: "BASE", path: ["a", "b"] },
      { env: "UNSET_VARIABLE", path: ["c"] },
      { home: true, path: [".local", "bin"] },
      { root: true, path: ["opt", "bin"] },
    ]);
    expect(folders[0]).toMatch(/base[\\/]a[\\/]b$/);
    expect(folders).not.toContain(join("unset", "c"));
    expect(folders.some((folder) => /\.local[\\/]bin$/.test(folder))).toBe(true);
    expect(folders.some((folder) => /^[\\/]opt[\\/]bin$/.test(folder))).toBe(!windows);
  });
});

describe("run", () => {
  const probe = () => new NodeEnvironmentProbe({ cwd: root });

  it("captures what a program prints and its exit code", async () => {
    const result = await probe().run([
      process.execPath,
      "-e",
      "console.log('hello'); console.error('careful'); process.exit(2)",
    ]);
    expect(result).toMatchObject({
      status: 2,
      stdout: expect.stringContaining("hello"),
      stderr: "careful",
    });
  });

  it("starts a batch file or script, arguments escaped, without a shell line", async () => {
    const bin = join(root, "bin");
    const path = await program(bin, "agentplugged-echo");
    const result = await probe().run([path, "--version"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--version");
    // A shell metacharacter in an argument is only text.
    const tricky = await probe().run([path, "a&b|c"]);
    expect(tricky.stdout).toContain("a&b|c");
  });

  it("says a program is missing, and stops one that takes too long", async () => {
    expect(await probe().run(["agentplugged-no-such-program", "--version"])).toMatchObject({
      status: null,
      missing: true,
    });
    const slow = await probe().run([process.execPath, "-e", "setTimeout(() => {}, 30000)"], {
      timeoutMs: 300,
    });
    expect(slow).toMatchObject({ status: null, timedOut: true });
  });

  it("runs in the terminal and returns the exit code", async () => {
    expect(await probe().runInTerminal([process.execPath, "-e", "process.exit(3)"])).toEqual({
      status: 3,
    });
    expect(await probe().runInTerminal(["agentplugged-no-such-program"])).toEqual({
      status: null,
      missing: true,
    });
  });
});

describe("Git questions", () => {
  it("knows whether the folder is a repository, and the settings Git has", async () => {
    const probe = new NodeEnvironmentProbe({ cwd: root });
    // A temporary folder is inside no repository.
    expect(await probe.isRepository()).toBe(false);
    git(root, "init", "-q");
    git(root, "config", "user.name", "Ada Lovelace");
    git(root, "config", "user.email", "");
    expect(await probe.isRepository()).toBe(true);
    expect(await probe.gitConfig("user.name")).toBe("Ada Lovelace");
    // Empty is unset.
    expect(await probe.gitConfig("user.email")).toBeUndefined();
    expect(await probe.gitConfig("agentplugged.nothing")).toBeUndefined();
  });

  it("reads the forge and the host of the remote Git pushes to", async () => {
    const probe = new NodeEnvironmentProbe({ cwd: root });
    git(root, "init", "-q");
    expect(await probe.forge()).toEqual({});
    git(root, "remote", "add", "origin", "git@github.com:ada/shop.git");
    expect(await probe.forge()).toEqual({ forge: "github", host: "github.com" });
    git(root, "remote", "set-url", "origin", "https://gitlab.example.org/ada/shop.git");
    expect(await probe.forge()).toEqual({ forge: "gitlab", host: "gitlab.example.org" });
    git(root, "remote", "set-url", "origin", "https://git.example.org/ada/shop.git");
    expect(await probe.forge()).toEqual({ host: "git.example.org" });
  });
});

describe("the rest of the machine", () => {
  it("tells a port that is taken from one that is free", async () => {
    const probe = new NodeEnvironmentProbe({ cwd: root });
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const taken = (server.address() as { port: number }).port;
    expect(await probe.port(taken)).toBe("busy");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await probe.port(taken)).toBe("free");
  });

  it("does not call a port free that it cannot test", async () => {
    const probe = new NodeEnvironmentProbe({ cwd: root });
    expect(await probe.port(70_000)).toBe("refused");
    expect(await probe.port(-1)).toBe("refused");
  });

  it("reports the memory, Node and the keychain and Windows Hello it is given", async () => {
    const probe = new NodeEnvironmentProbe({
      cwd: root,
      keys: {
        async readMachineSecret() {
          return undefined;
        },
      },
      presence: {
        availability: async () => ({ available: true }),
        create: () => Promise.reject(new Error("no")),
        assert: () => Promise.reject(new Error("no")),
      },
    });
    expect(probe.memoryGb()).toBeGreaterThan(0);
    expect(probe.nodeVersion()).toBe(process.version);
    expect(await probe.keychain()).toBe(true);
    expect(await probe.presence()).toBe(true);
    const broken = new NodeEnvironmentProbe({
      cwd: root,
      keys: {
        async readMachineSecret() {
          throw new Error("no secret service");
        },
      },
    });
    expect(await broken.keychain()).toBe(false);
    expect(await broken.presence()).toBe(false);
  });
});

describe("what the probe reads of the machine", () => {
  /** Windows as the probe sees it, with the answers of `reg`, `netsh` and `fltmc` played. */
  class PlayedWindows extends NodeEnvironmentProbe {
    constructor(
      cwd: string,
      private readonly played: (
        command: readonly string[],
      ) => { status: number | null; stdout: string; missing?: boolean } | undefined,
      env: Record<string, string> = {},
    ) {
      super({ cwd, platform: "win32", env });
    }
    override async run(command: readonly string[]) {
      const answer = this.played(command) ?? { status: 1, stdout: "" };
      return { ...answer, stderr: "" };
    }
  }

  it("reads the environment, the folders of the PATH, and finds a program in given folders", async () => {
    const bin = join(root, "elsewhere");
    const path = await program(bin, "agentplugged-fake");
    const probe = new NodeEnvironmentProbe({
      cwd: root,
      env: {
        PATH: `${join(root, "one")}${windows ? ";" : ":"}relative`,
        PATHEXT: ".CMD",
        HTTPS_PROXY: " ",
        X: "y",
      },
    });
    expect(probe.env("X")).toBe("y");
    // Empty is unset.
    expect(probe.env("HTTPS_PROXY")).toBeUndefined();
    expect(probe.processPath()).toEqual([join(root, "one")]);
    expect(await probe.findIn(["agentplugged-fake"], [bin])).toEqual({
      name: "agentplugged-fake",
      path,
      onPath: false,
    });
    // A relative folder is never searched.
    expect(await probe.findIn(["agentplugged-fake"], ["elsewhere"])).toBeUndefined();
    expect(probe.workingFolder()).toBe(root);
  });

  it("reads the free room of the disk", async () => {
    const free = await new NodeEnvironmentProbe({ cwd: root }).diskFreeGb();
    expect(free).toBeGreaterThan(0);
    expect(
      await new NodeEnvironmentProbe({ cwd: join(root, "nope") }).diskFreeGb(),
    ).toBeUndefined();
  });

  it("reads the ranges Windows keeps, in any language, and says nothing where there are none", async () => {
    const netsh = [
      "",
      "Plage de ports d'exclusion de protocole tcp",
      "",
      "Début      Fin",
      "----------    --------",
      "      1900        1999",
      "     54299       54398",
      "     50000       50059     *",
      "",
      "* - Exclusions de ports administrées.",
    ].join("\r\n");
    const asked: string[][] = [];
    const played = new PlayedWindows(root, (command) => {
      asked.push([...command]);
      return command[0] === "netsh" ? { status: 0, stdout: netsh } : undefined;
    });
    expect(await played.reservedPortRanges()).toEqual([
      { from: 1900, to: 1999 },
      { from: 54299, to: 54398 },
      { from: 50000, to: 50059 },
    ]);
    expect(asked[0]).toEqual([
      "netsh",
      "interface",
      "ipv4",
      "show",
      "excludedportrange",
      "protocol=tcp",
    ]);
    expect(await new PlayedWindows(root, () => undefined).reservedPortRanges()).toBeUndefined();
    expect(
      await new NodeEnvironmentProbe({ cwd: root, platform: "linux" }).reservedPortRanges(),
    ).toBeUndefined();
  });

  it("tells administrator rights and long paths on Windows from the answers of the system", async () => {
    const elevated = new PlayedWindows(root, (command) =>
      command[0] === "fltmc" ? { status: 0, stdout: "" } : undefined,
    );
    expect(await elevated.isAdministrator()).toBe(true);
    expect(await new PlayedWindows(root, () => undefined).isAdministrator()).toBe(false);
    expect(
      await new PlayedWindows(root, () => ({
        status: null,
        stdout: "",
        missing: true,
      })).isAdministrator(),
    ).toBeUndefined();
    const on = new PlayedWindows(root, () => ({
      status: 0,
      stdout: "\r\n    LongPathsEnabled    REG_DWORD    0x1\r\n",
    }));
    expect(await on.longPathsEnabled()).toBe(true);
    const off = new PlayedWindows(root, () => ({
      status: 0,
      stdout: "    LongPathsEnabled    REG_DWORD    0x0\r\n",
    }));
    expect(await off.longPathsEnabled()).toBe(false);
    expect(await new PlayedWindows(root, () => undefined).longPathsEnabled()).toBeUndefined();
  });

  it("reads the PATH the system holds, expanded, keeping the folders that exist", async () => {
    const here = join(root, "tools");
    await mkdir(here, { recursive: true });
    const machinePath = `    Path    REG_EXPAND_SZ    %SystemRoot%\\NoSuchFolderForAgentPlugged;${here};%UNKNOWN%\\x\r\n`;
    const played = new PlayedWindows(root, () => ({ status: 0, stdout: machinePath }), {
      SystemRoot: "C:\\Windows",
    });
    expect(await played.systemPath()).toEqual([here]);
    expect(await new PlayedWindows(root, () => undefined).systemPath()).toBeUndefined();
    expect(
      await new NodeEnvironmentProbe({ cwd: root, platform: "linux" }).systemPath(),
    ).toBeUndefined();
  });
});

describe("describeMachine and envNames", () => {
  it("tells the system, the home folder named by the environment and the names of the variables", () => {
    const probe = new NodeEnvironmentProbe({
      cwd: root,
      env: { HOME: "/home/someone", USERPROFILE: "C:\\Users\\Someone", API_TOKEN: "x", EMPTY: "" },
    });
    const machine = probe.describeMachine();
    expect(machine.arch).toMatch(/^[a-z0-9_]+$/);
    expect(machine.release).not.toBe("");
    expect(machine.home).toBe(windows ? "C:\\Users\\Someone" : "/home/someone");
    expect(typeof machine.user === "string" || machine.user === undefined).toBe(true);
    // Names only: the value of a variable never leaves the probe through this door.
    expect(probe.envNames()).toEqual(["HOME", "USERPROFILE", "API_TOKEN", "EMPTY"]);
  });
});
