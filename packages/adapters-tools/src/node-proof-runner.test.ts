import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { ProofRunRequest } from "@agentplugged/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NodeProofRunner } from "./node-proof-runner.js";

/**
 * The runner that really starts the commands of the project, with real short
 * commands on the platform the tests run on (Node itself is the program: it is everywhere).
 */

const NODE = process.execPath;
const windows = process.platform === "win32";
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "agentplugged-proof-"));
  mkdirSync(join(root, "sub"));
});

afterAll(async () => {
  // On Windows a folder a process still runs in cannot go until that process ends.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
});

const request = (
  overrides: Partial<ProofRunRequest> & { script?: string } = {},
): ProofRunRequest => {
  const { script, ...rest } = overrides;
  return {
    line: "node",
    argv: [NODE, "-e", script ?? "console.log('hello')"],
    cwd: ".",
    timeoutMs: 20_000,
    maxOutputBytes: 64 * 1024,
    ...rest,
  };
};

const runner = (env: NodeJS.ProcessEnv = process.env) => new NodeProofRunner({ root, env });
const text = (result: { head: string; tail: string }) => result.head + result.tail;

/** True while a process with this pid exists. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

describe("a command that ends by itself", () => {
  it("gives its exit code, its duration and what it printed, without a shell", async () => {
    const result = await runner().run(request());
    expect(result).toMatchObject({ ended: "exit", exit: 0, omitted: 0 });
    expect(text(result).trim()).toBe("hello");
    expect(result.ms).toBeGreaterThanOrEqual(0);
    const failed = await runner().run(
      request({ script: "console.error('boom'); process.exit(3)" }),
    );
    expect(failed).toMatchObject({ ended: "exit", exit: 3 });
    expect(text(failed)).toContain("boom");
  });

  it("starts the program with its arguments as they are: a quote or a separator is only text", async () => {
    const result = await runner().run(
      request({
        argv: [NODE, "-e", "console.log(process.argv[1])", "a && echo injected; $(x) `y`"],
      }),
    );
    expect(text(result).trim()).toBe("a && echo injected; $(x) `y`");
  });

  it("runs in the folder it is given, inside the project", async () => {
    writeFileSync(join(root, "sub", "marker.txt"), "inside");
    const result = await runner().run(
      request({
        cwd: "sub",
        script: "console.log(require('fs').readFileSync('marker.txt','utf8'))",
      }),
    );
    expect(text(result).trim()).toBe("inside");
  });

  it("goes through the shell for a line that needs it", async () => {
    const result = await runner().run(request({ line: "echo one && echo two", argv: null }));
    expect(result).toMatchObject({ ended: "exit", exit: 0 });
    expect(text(result).replace(/\s+/g, " ")).toContain("one two");
    const failing = await runner().run(
      request({ line: 'node -e "process.exit(4)" || exit 4', argv: null }),
    );
    expect(failing.exit).toBe(4);
  });

  it("has no keyboard: a program that reads its input meets the end at once", async () => {
    const result = await runner().run(
      request({
        script: "process.stdin.on('data',()=>{});process.stdin.on('end',()=>console.log('eof'))",
      }),
    );
    expect(text(result).trim()).toBe("eof");
  });

  it.runIf(windows)("starts a script such as npm.cmd through the shell on Windows", async () => {
    writeFileSync(join(root, "tool.cmd"), "@echo from-cmd %1\r\n");
    const path = `${root}${delimiter}${process.env.PATH ?? ""}`;
    const result = await runner({ ...process.env, PATH: path }).run(
      request({ line: "tool arg", argv: ["tool", "arg"] }),
    );
    expect(result).toMatchObject({ ended: "exit", exit: 0 });
    expect(text(result)).toContain("from-cmd arg");
  });
});

describe("the environment of a command: nothing that looks like a secret", () => {
  it("leaves the secrets of the machine behind and keeps the rest", async () => {
    const env = {
      ...process.env,
      GITHUB_TOKEN: "ghp_secretvalue",
      NPM_TOKEN: "npm_secretvalue",
      AWS_SECRET_ACCESS_KEY: "aws-secretvalue",
      DATABASE_URL: "postgres://user:pass@host/db",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      KEEP_ME: "kept",
    };
    const script =
      "console.log(JSON.stringify({keep:process.env.KEEP_ME,ci:process.env.CI,path:Boolean(process.env.PATH),secrets:Object.keys(process.env).filter(n=>/TOKEN|SECRET|DATABASE_URL|AUTH_SOCK/i.test(n))}))";
    const result = await runner(env).run(request({ script }));
    expect(JSON.parse(text(result).trim())).toEqual({
      keep: "kept",
      ci: "1",
      path: true,
      secrets: [],
    });
    expect(text(result)).not.toContain("secretvalue");
  });
});

describe("the output of a command is bounded", () => {
  it("keeps the start and the end of a long output and says how much it dropped", async () => {
    const script =
      "const line='x'.repeat(99)+'\\n';process.stdout.write('START\\n');for(let i=0;i<20000;i++)process.stdout.write(line);process.stdout.write('END\\n')";
    const result = await runner().run(request({ script, maxOutputBytes: 10_000 }));
    expect(result).toMatchObject({ ended: "exit", exit: 0 });
    expect(Buffer.byteLength(result.head) + Buffer.byteLength(result.tail)).toBeLessThanOrEqual(
      10_000,
    );
    expect(result.head.startsWith("START")).toBe(true);
    expect(result.tail.trimEnd().endsWith("END")).toBe(true);
    expect(result.omitted).toBeGreaterThan(1_900_000);
  });
});

describe("a command that runs too long is stopped with everything it started", () => {
  it("stops the tree of processes at the time limit", async () => {
    const pidFile = join(root, "child.pid");
    rmSync(pidFile, { force: true });
    const script = [
      "const {spawn}=require('child_process');",
      "const child=spawn(process.execPath,['-e','setTimeout(()=>{},120000)'],{stdio:'ignore'});",
      `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));`,
      "console.log('parent running');setTimeout(()=>{},120000);",
    ].join("");
    const started = Date.now();
    const result = await runner().run(request({ script, timeoutMs: 2000 }));
    expect(result).toMatchObject({ ended: "timeout", exit: null });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(text(result)).toContain("parent running");
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(0);
    expect(await until(() => !alive(pid), 8000)).toBe(true);
  });

  it("stops a line that went through the shell, too", async () => {
    const started = Date.now();
    const result = await runner().run(
      request({
        line: `"${NODE}" -e "setTimeout(()=>{},120000)" && echo never`,
        argv: null,
        timeoutMs: 1500,
      }),
    );
    expect(result).toMatchObject({ ended: "timeout", exit: null });
    expect(text(result)).not.toContain("never");
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("is not kept waiting by what a command that ended left running", async () => {
    const script = [
      "const {spawn}=require('child_process');",
      "spawn(process.execPath,['-e','setTimeout(()=>{},2000)'],{stdio:'inherit',detached:true}).unref();",
      "console.log('done');",
    ].join("");
    const started = Date.now();
    const result = await runner().run(request({ script, timeoutMs: 30_000 }));
    expect(result).toMatchObject({ ended: "exit", exit: 0 });
    expect(text(result)).toContain("done");
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});

describe("a command that cannot start, or a folder that is not the project's", () => {
  it("says it never started", async () => {
    const result = await runner().run(request({ argv: ["agentplugged-no-such-program-xyz"] }));
    expect(result).toMatchObject({ ended: "error", exit: null });
    expect(result.detail).toMatch(/ENOENT|not found|not recognized/i);
  });

  it("refuses a folder outside the project or that does not exist", async () => {
    const outside = await runner().run(request({ cwd: ".." }));
    expect(outside).toMatchObject({ ended: "error", detail: "the folder is outside the project" });
    const missing = await runner().run(request({ cwd: "nowhere" }));
    expect(missing).toMatchObject({ ended: "error" });
    expect(missing.detail).toContain("nowhere");
  });

  it("refuses a link that leads outside the project", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "agentplugged-outside-"));
    try {
      symlinkSync(outsideDir, join(root, "escape"), "junction");
    } catch {
      rmSync(outsideDir, { recursive: true, force: true });
      return; // no right to make a link here
    }
    const result = await runner().run(request({ cwd: "escape" }));
    expect(result).toMatchObject({ ended: "error", detail: "the folder is outside the project" });
    rmSync(outsideDir, { recursive: true, force: true });
  });
});

describe("the working copy", () => {
  it("tells the commit and whether anything was left uncommitted", async () => {
    const repository = mkdtempSync(join(tmpdir(), "agentplugged-repo-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
          cwd: repository,
          stdio: "ignore",
        });
      git("init", "-q");
      writeFileSync(join(repository, "a.txt"), "a");
      git("add", ".");
      git("commit", "-q", "-m", "first");
      const probe = new NodeProofRunner({ root: repository });
      const clean = await probe.workingCopy();
      expect(clean.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(clean.clean).toBe(true);
      writeFileSync(join(repository, "b.txt"), "new file");
      expect((await probe.workingCopy()).clean).toBe(false);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
    const outside = mkdtempSync(join(tmpdir(), "agentplugged-nogit-"));
    try {
      const none = await new NodeProofRunner({
        root: outside,
        env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() },
      }).workingCopy();
      expect(none.commit).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
