import { describe, expect, it } from "vitest";
import type { CommandContext } from "../command.js";
import { MemoryFiles, SHIPPED_DOCTOR, shippedMethod } from "../testing/memory-files.js";
import type { ToolProbe } from "../tools/tool-probe.js";
import { parseDoctorCatalog } from "./catalog.js";
import { commandsIn, diagnoseFailure, type Failure, portsIn } from "./diagnose.js";
import { checkEnvironmentCommand, doctorCommand } from "./doctor-commands.js";
import { MemoryEnvironment } from "./memory-environment.js";
import { runDoctor } from "./report.js";

/**
 * The traps of a machine, each on a simulated environment. Nothing here touches the real
 * machine: no program is started, no setting is read.
 */

const NO_TOOLS: ToolProbe = {
  async which() {
    return undefined;
  },
  async version() {
    return undefined;
  },
  async extensions() {
    return [];
  },
};

function contextOf(environment: MemoryEnvironment, files = new MemoryFiles()): CommandContext {
  return {
    files,
    tools: NO_TOOLS,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
    environment,
  };
}

const catalog = (() => {
  const parsed = parseDoctorCatalog("doctor.yaml", SHIPPED_DOCTOR);
  if (parsed instanceof Error) throw parsed;
  return parsed;
})();

async function diagnose(machine: MemoryEnvironment, failure: Failure, files?: MemoryFiles) {
  const diagnosis = await diagnoseFailure(contextOf(machine, files), catalog, failure);
  if (diagnosis === undefined) throw new Error("no diagnosis");
  return diagnosis;
}

const item = (
  diagnosis: Awaited<ReturnType<typeof diagnose>>,
  id: string,
): { status: string; outcome: string; text: { en: string; fr: string } } | undefined =>
  diagnosis.observed.find((entry) => entry.id === id);

/** A Windows machine whose GitHub CLI sits in an install folder only the system's PATH knows. */
function windowsWithGh(): MemoryEnvironment {
  const machine = MemoryEnvironment.healthy();
  machine.platform = "win32";
  machine.commands.set("gh", {
    path: "C:/Program Files/GitHub CLI/gh.exe",
    version: "gh version 2.60.0",
    onPath: false,
  });
  machine.processFolders = ["C:/Windows/System32"];
  machine.system = ["C:/Windows/System32", "C:/Program Files/GitHub CLI"];
  return machine;
}

describe("trap: PATH not refreshed", () => {
  it("says the tool is installed and known to the system, but not to the program opened before", async () => {
    const diagnosis = await diagnose(windowsWithGh(), { code: "FORGE_NOT_LINKED" });
    expect(diagnosis.matched).toEqual(["forge-not-linked"]);
    expect(item(diagnosis, "forge.cli")).toMatchObject({ status: "warn", outcome: "stale" });
    expect(diagnosis.cause).toBe("found");
    expect(diagnosis.headline.en).toContain("your system knows that folder");
    expect(diagnosis.headline.en).not.toMatch(/not installed/i);
    expect(diagnosis.next?.en).toContain("Close and reopen");
    expect(diagnosis.headline.fr).toContain("ton système connaît ce dossier");
  });

  it("finds a tool the failure names in a folder only the system's PATH holds", async () => {
    const machine = windowsWithGh();
    machine.commands.set("foo", { path: "C:/Tools/foo.exe", version: "foo 1.0.0", onPath: false });
    machine.system = [...(machine.system ?? []), "C:/Tools"];
    const diagnosis = await diagnose(machine, {
      output: "'foo' is not recognized as an internal or external command",
    });
    expect(item(diagnosis, "seen.tool.foo")).toMatchObject({ outcome: "stale", status: "warn" });
  });

  it("tells a folder outside every PATH from one the system knows", async () => {
    const machine = windowsWithGh();
    machine.system = ["C:/Windows/System32"];
    const diagnosis = await diagnose(machine, { code: "FORGE_NOT_LINKED" });
    expect(item(diagnosis, "forge.cli")).toMatchObject({ outcome: "off_path" });
    expect(item(diagnosis, "path.stale")).toMatchObject({ outcome: "ok" });
  });

  it("reports folders the system has and this program does not", async () => {
    const machine = windowsWithGh();
    const report = await runDoctor(contextOf(machine));
    if (report instanceof Error) throw report;
    const stale = report.items.find((entry) => entry.id === "path.stale");
    expect(stale).toMatchObject({ status: "warn", outcome: "stale" });
    expect(stale?.text.en).toContain("C:/Program Files/GitHub CLI");
  });

  it("does not say « not installed » for a tool it did not find anywhere: it says what it looked at", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.commands.delete("gh");
    const diagnosis = await diagnose(machine, { code: "FORGE_NOT_LINKED" });
    expect(item(diagnosis, "forge.cli")?.text.en).toContain("was not found");
    expect(item(diagnosis, "forge.cli")?.text.en).not.toMatch(/not installed/);
  });
});

describe("trap: ports", () => {
  const forbidden =
    "listen tcp 127.0.0.1:54322: bind: An attempt was made to access a socket in a way forbidden by its access permissions.";

  it("names the range Windows keeps when the refused port is inside it", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.platform = "win32";
    machine.ports.set(54322, "refused");
    machine.reserved = [
      { from: 1900, to: 1999 },
      { from: 54299, to: 54398 },
    ];
    const diagnosis = await diagnose(machine, { output: forbidden });
    expect(diagnosis.matched).toContain("port");
    expect(item(diagnosis, "seen.port.54322")).toMatchObject({ outcome: "reserved" });
    expect(diagnosis.headline.en).toContain("54299-54398");
    expect(diagnosis.next?.en).toContain("outside 54299-54398");
  });

  it("tells a busy port from a refused one, and does not blame a range it did not find", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.ports.set(3000, "busy");
    machine.ports.set(4000, "refused");
    machine.reserved = [];
    const busy = await diagnose(machine, {
      output: "Error: listen EADDRINUSE: address already in use :::3000 port 3000",
    });
    expect(item(busy, "seen.port.3000")).toMatchObject({ outcome: "busy" });
    const refused = await diagnose(machine, {
      output: "bind 127.0.0.1:4000 forbidden by its access permissions",
    });
    const four = item(refused, "seen.port.4000");
    expect(four).toMatchObject({ outcome: "refused" });
    expect(four?.text.en).toContain("the cause is not established");
  });

  it("says the port is free now rather than inventing a culprit", async () => {
    const machine = MemoryEnvironment.healthy();
    const diagnosis = await diagnose(machine, { output: "EADDRINUSE 127.0.0.1:5173" });
    expect(item(diagnosis, "seen.port.5173")).toMatchObject({ outcome: "ok" });
    expect(diagnosis.cause).toBe("not_found");
    expect(diagnosis.headline.en).toContain("not established");
  });

  it("reads a reserved port of the stack's prerequisites too", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.ports.set(54322, "refused");
    machine.reserved = [{ from: 54299, to: 54398 }];
    const files = new MemoryFiles({
      ".agentplugged/docs/architecture.md":
        "---\nid: architecture\nkind: architecture\nowner: alex\nlinks: []\nprerequisites:\n  ports: [54322]\n---\n# Architecture\n",
    });
    const report = await runDoctor(contextOf(machine, files));
    if (report instanceof Error) throw report;
    const port = report.items.find((entry) => entry.id === "prerequisite.port.54322");
    expect(port).toMatchObject({ outcome: "reserved", status: "warn" });
    expect(port?.fix?.kind).toBe("steps");
  });
});

describe("trap: Docker", () => {
  function withDocker(info: { status: number; daemon?: string; memory?: number }) {
    const machine = MemoryEnvironment.healthy();
    machine.commands.set("docker", {
      path: "/usr/bin/docker",
      version: "Docker version 27.0.0",
      onPath: true,
    });
    machine.onRun = (command) => {
      if (command[0] !== "/usr/bin/docker" || command[1] !== "info") return undefined;
      if (info.status !== 0) {
        return {
          status: 1,
          stdout: "",
          stderr:
            "error during connect: Get http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.47/info",
        };
      }
      const format = command[3];
      return {
        status: 0,
        stdout:
          format === "{{.MemTotal}}"
            ? String((info.memory ?? 8) * 1024 ** 3)
            : (info.daemon ?? "27.0.0"),
        stderr: "",
      };
    };
    return machine;
  }

  it("says Docker is installed but its engine does not answer", async () => {
    const diagnosis = await diagnose(withDocker({ status: 1 }), {
      output:
        "error during connect: This error may indicate that the docker daemon is not running.",
    });
    expect(diagnosis.matched).toContain("docker-engine");
    expect(item(diagnosis, "docker.daemon")).toMatchObject({ outcome: "stopped", status: "warn" });
    // Its memory cannot be read while it is down: said by the daemon check, not guessed.
    expect(item(diagnosis, "docker.memory")).toBeUndefined();
    expect(diagnosis.next?.en).toContain("Open Docker Desktop");
  });

  it("recognises a Docker failure on a machine without Docker and says there is nothing to read", async () => {
    const diagnosis = await diagnose(MemoryEnvironment.healthy(), {
      output: "Cannot connect to the Docker daemon",
    });
    expect(diagnosis.matched).toEqual(["docker-engine"]);
    expect(diagnosis.observed).toEqual([]);
    expect(diagnosis.cause).toBe("not_found");
    expect(diagnosis.headline.en).toContain("nothing on your machine I can read");
  });

  it("is left out of the report where Docker is not there", async () => {
    const report = await runDoctor(contextOf(MemoryEnvironment.healthy()));
    if (report instanceof Error) throw report;
    expect(report.items.map((entry) => entry.id)).not.toContain("docker.daemon");
  });

  it("exit code 137 with little memory in Docker: the fact is read, the cause stays a supposition", async () => {
    const diagnosis = await diagnose(withDocker({ status: 0, memory: 2 }), { exit_code: 137 });
    expect(diagnosis.matched).toEqual(["killed"]);
    expect(item(diagnosis, "docker.memory")).toMatchObject({ outcome: "low" });
    // Little memory is a lead, not the proof that the program was killed for lack of it.
    expect(diagnosis.cause).toBe("suspected");
    expect(diagnosis.headline.en).toContain(
      "A lead on your machine, which proves nothing by itself",
    );
    expect(diagnosis.headline.en).toContain("Docker only has 2 GB");
    expect(diagnosis.headline.en).not.toContain("Cause found");
    expect(diagnosis.assumed.map((text) => text.en).join(" ")).toContain("does not prove it");
    expect(diagnosis.failure[0]?.en).toContain("137");
  });

  it("exit code 137 with plenty of memory: no cause is established and none is named", async () => {
    const diagnosis = await diagnose(withDocker({ status: 0, memory: 16 }), { exit_code: 137 });
    expect(diagnosis.cause).toBe("not_found");
    expect(diagnosis.headline.en).toContain("the cause is not established");
    expect(item(diagnosis, "docker.memory")).toMatchObject({ outcome: "ok" });
    expect(diagnosis.assumed.length).toBe(1);
  });

  it("exit code 137 without Docker: only the machine's memory is read", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.memory = 2;
    const diagnosis = await diagnose(machine, { exit_code: 137 });
    expect(item(diagnosis, "machine.memory")).toMatchObject({ outcome: "low" });
    expect(diagnosis.cause).toBe("suspected");
    expect(item(diagnosis, "docker.memory")).toBeUndefined();
  });

  it("Node's own heap limit is not taken for the machine's memory", async () => {
    const diagnosis = await diagnose(MemoryEnvironment.healthy(), {
      output: "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
    });
    expect(diagnosis.matched).toEqual(["node-heap"]);
    expect(diagnosis.assumed[0]?.en).toContain("not necessarily the machine's memory");
  });
});

describe("trap: Git identity", () => {
  it("reads the identity when Git refuses to commit", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.config.clear();
    const diagnosis = await diagnose(machine, {
      output: "Author identity unknown\n*** Please tell me who you are.",
    });
    expect(item(diagnosis, "git.identity")).toMatchObject({ outcome: "unset" });
    expect(diagnosis.cause).toBe("found");
  });

  it("does not blame the identity when it is set", async () => {
    const diagnosis = await diagnose(MemoryEnvironment.healthy(), {
      output: "fatal: unable to auto-detect email address",
    });
    expect(item(diagnosis, "git.identity")).toMatchObject({ outcome: "ok" });
    expect(diagnosis.cause).toBe("not_found");
  });
});

describe("trap: line endings", () => {
  const smell = "/usr/bin/env: 'bash\r': No such file or directory\nbad interpreter";

  it("reads core.autocrlf and the repository's rules, and supposes the rest", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.platform = "win32";
    machine.config.set("core.autocrlf", "true");
    const diagnosis = await diagnose(machine, { output: smell });
    expect(item(diagnosis, "git.line-endings")).toMatchObject({ outcome: "risky" });
    expect(item(diagnosis, "git.line-endings")?.text.en).toContain("core.autocrlf is true");
    expect(diagnosis.cause).toBe("suspected");
    expect(diagnosis.assumed[0]?.en).toContain("I suppose");
  });

  it("is settled by a .gitattributes rule", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.platform = "win32";
    const files = new MemoryFiles({ ".gitattributes": "# lines\n* text=auto eol=lf\n" });
    const diagnosis = await diagnose(machine, { output: smell }, files);
    expect(item(diagnosis, "git.line-endings")).toMatchObject({ outcome: "ok" });
    expect(diagnosis.cause).toBe("not_found");
  });

  it("is not a problem on a Linux machine with Git's default", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.platform = "linux";
    const diagnosis = await diagnose(machine, { output: smell });
    expect(item(diagnosis, "git.line-endings")).toMatchObject({ outcome: "ok" });
  });
});

describe("trap: administrator rights", () => {
  it("states whether the program is an administrator, and says that is not the only right", async () => {
    const denied = await diagnose(MemoryEnvironment.healthy(), {
      output: "EACCES: permission denied, mkdir '/opt/x'",
    });
    expect(item(denied, "admin.rights")).toMatchObject({ outcome: "denied" });
    expect(denied.assumed[0]?.en).toContain("not always administrator rights");
    // Not being an administrator is the usual state: a lead at most, never « the cause ».
    expect(denied.cause).toBe("suspected");
    expect(denied.headline.en).not.toContain("Cause found");
    const machine = MemoryEnvironment.healthy();
    machine.admin = true;
    const granted = await diagnose(machine, { output: "Access is denied." });
    expect(item(granted, "admin.rights")).toMatchObject({ outcome: "ok" });
    expect(granted.cause).toBe("not_found");
  });

  it("says it cannot tell when the system will not", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.admin = undefined;
    const diagnosis = await diagnose(machine, { exit_code: 126 });
    expect(item(diagnosis, "admin.rights")).toMatchObject({ outcome: "unreadable" });
  });
});

describe("trap: path too long", () => {
  it("reads the length of the product's folder on Windows", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.platform = "win32";
    machine.folder = `C:/Users/ada/projects/${"deeply-nested-folder/".repeat(6)}product`;
    machine.longPaths = false;
    const diagnosis = await diagnose(machine, { output: "ENAMETOOLONG: name too long" });
    const long = item(diagnosis, "path.length");
    expect(long).toMatchObject({ outcome: "long" });
    expect(long?.text.en).toContain("long paths enabled in Windows: no");
  });

  it("a short folder is fine, and the check is Windows only", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.platform = "win32";
    const short = await diagnose(machine, { output: "Filename too long" });
    expect(item(short, "path.length")).toMatchObject({ outcome: "ok" });
    machine.platform = "linux";
    const linux = await diagnose(machine, { output: "Filename too long" });
    expect(item(linux, "path.length")).toBeUndefined();
  });
});

describe("trap: proxy or company registry", () => {
  it("names the proxy host and the registry, never the credentials", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.variables.set("HTTPS_PROXY", "http://ada:s3cret-pass@proxy.corp.local:3128");
    machine.variables.set("npm_config_registry", "https://registry.corp.local/npm/");
    machine.config.set("http.proxy", "http://user2:hunter2@git-proxy.corp.local:8080");
    const diagnosis = await diagnose(machine, {
      output: "request to https://registry.npmjs.org failed, reason: connect ETIMEDOUT",
    });
    const proxy = item(diagnosis, "network.proxy");
    expect(proxy).toMatchObject({ outcome: "proxy" });
    expect(diagnosis.cause).toBe("suspected");
    expect(proxy?.text.en).toContain("HTTPS_PROXY (proxy.corp.local)");
    expect(proxy?.text.en).toContain("git http.proxy (git-proxy.corp.local)");
    expect(proxy?.text.en).toContain("npm registry (registry.corp.local)");
    const everything = JSON.stringify(diagnosis);
    for (const secret of ["s3cret-pass", "hunter2", "ada:", "user2"]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("finds nothing set and says the network itself was not looked at", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.commands.set("npm", { path: "/usr/bin/npm", version: "10.0.0", onPath: true });
    machine.onRun = (command) =>
      command[1] === "config"
        ? { status: 0, stdout: "https://registry.npmjs.org/\n", stderr: "" }
        : undefined;
    const diagnosis = await diagnose(machine, { output: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
    expect(item(diagnosis, "network.proxy")).toMatchObject({ outcome: "ok" });
    expect(diagnosis.cause).toBe("not_found");
    expect(diagnosis.assumed[0]?.en).toContain("not at the network itself");
  });
});

describe("trap: full disk", () => {
  it("reads the free room of the product's disk", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.diskGb = 0.3;
    const diagnosis = await diagnose(machine, { output: "ENOSPC: no space left on device, write" });
    expect(item(diagnosis, "disk.space")).toMatchObject({ outcome: "full" });
    expect(diagnosis.headline.en).toContain("Only 0.3 GB free");
    machine.diskGb = 50;
    const roomy = await diagnose(machine, { output: "ENOSPC" });
    expect(roomy.cause).toBe("not_found");
  });

  it("says when it cannot read the room, and shows it in the routine report", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.diskGb = undefined;
    const report = await runDoctor(contextOf(machine));
    if (report instanceof Error) throw report;
    expect(report.items.find((entry) => entry.id === "disk.space")).toMatchObject({
      outcome: "unreadable",
    });
  });
});

describe("what a failure is allowed to do", () => {
  it("does not recognise what it does not know, and blames nothing", async () => {
    const diagnosis = await diagnose(MemoryEnvironment.healthy(), {
      output: "something odd happened",
      exit_code: 3,
    });
    expect(diagnosis.cause).toBe("unknown");
    expect(diagnosis.observed).toEqual([]);
    expect(diagnosis.headline.en).toContain("blame nothing");
  });

  it("never repeats the failure's text", async () => {
    const machine = MemoryEnvironment.healthy();
    const diagnosis = await diagnose(machine, {
      output: "token=ghp_SECRETSECRET0123\nfoo: command not found",
    });
    expect(JSON.stringify(diagnosis)).not.toContain("ghp_SECRET");
  });

  it("takes only plain program names and ports out of a message", () => {
    expect(commandsIn("'gh' is not recognized as an internal or external command")).toEqual(["gh"]);
    expect(commandsIn("bash: supabase: command not found")).toEqual(["supabase"]);
    expect(commandsIn("Error: spawn docker ENOENT")).toEqual(["docker"]);
    expect(commandsIn("zsh: command not found: pnpm")).toEqual(["pnpm"]);
    expect(
      commandsIn("'$(rm -rf x)' is not recognized as an internal or external command"),
    ).toEqual([]);
    expect(commandsIn("'../evil' is not recognized as an internal or external command")).toEqual(
      [],
    );
    expect(portsIn("bind 127.0.0.1:54322 and port 8080, localhost:99999, at 12:30")).toEqual([
      8080, 54322,
    ]);
  });

  it("leaves the checks that only matter after a failure out of the routine report", async () => {
    const report = await runDoctor(contextOf(MemoryEnvironment.healthy()));
    if (report instanceof Error) throw report;
    const ids = report.items.map((entry) => entry.id);
    for (const quiet of ["admin.rights", "git.line-endings", "network.proxy", "machine.memory"]) {
      expect(ids).not.toContain(quiet);
    }
    const asked = await runDoctor(contextOf(MemoryEnvironment.healthy()), {
      only: ["admin.rights"],
    });
    if (asked instanceof Error) throw asked;
    expect(asked.items.map((entry) => entry.id)).toEqual(["admin.rights"]);
  });

  it("every signature of the catalogue is recognised by an example, and reads checks that exist", async () => {
    const examples: Record<string, Failure> = {
      "forge-not-linked": { code: "FORGE_NOT_LINKED" },
      "command-not-found": { exit_code: 127 },
      killed: { exit_code: 137 },
      "node-heap": { output: "JavaScript heap out of memory" },
      port: { output: "EADDRINUSE" },
      "docker-engine": {
        output: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
      },
      "git-identity": { output: "Author identity unknown" },
      "line-endings": { output: "bad interpreter: /bin/sh^M" },
      rights: { output: "EPERM: operation not permitted" },
      "path-too-long": { output: "The specified path, file name, or both are too long" },
      network: { output: "getaddrinfo ENOTFOUND registry.npmjs.org" },
      "disk-full": { output: "No space left on device" },
    };
    expect(Object.keys(examples).sort()).toEqual(
      catalog.signatures.map((entry) => entry.id).sort(),
    );
    for (const [id, failure] of Object.entries(examples)) {
      const diagnosis = await diagnose(MemoryEnvironment.healthy(), failure);
      expect(diagnosis.matched, id).toContain(id);
    }
  });
});

describe("the doctor and check_environment commands with a failure", () => {
  it("gives an agent the cause in English, the facts apart from the suppositions, and no new tool", async () => {
    const result = await checkEnvironmentCommand.run(contextOf(windowsWithGh()), {
      agent: "noah",
      failure: { code: "FORGE_NOT_LINKED", output: "gh: command not found" },
    });
    if (!result.ok) throw result.error;
    const value = result.value;
    expect(value.diagnosis?.cause).toBe("found");
    expect(value.diagnosis?.headline).toContain("your system knows that folder");
    expect(value.points.map((point) => point.id)).toEqual(
      expect.arrayContaining(["forge.cli", "path.stale"]),
    );
    expect(value.points.find((point) => point.id === "forge.cli")?.fix?.how).toBe("steps");
    expect(value.diagnosis?.doctor).toContain("npx agentplugged doctor");
  });

  it("refuses a failure with something else in it", async () => {
    const result = await checkEnvironmentCommand.run(contextOf(MemoryEnvironment.healthy()), {
      failure: { output: "x", command: "rm -rf" },
    });
    expect(result.ok).toBe(false);
  });

  it("doctor returns the usual report with the diagnosis next to it", async () => {
    const result = await doctorCommand.run(contextOf(MemoryEnvironment.healthy()), {
      failure: { exit_code: 137 },
    });
    if (!result.ok) throw result.error;
    expect(result.value.diagnosis?.matched).toEqual(["killed"]);
    expect(result.value.items.length).toBeGreaterThan(3);
  });
});

describe("after the review", () => {
  it("never starts a program whose name only comes from a failure's text", async () => {
    const machine = windowsWithGh();
    machine.commands.set("foo", { path: "C:/Tools/foo.exe", version: "foo 1.0.0", onPath: false });
    machine.system = [...(machine.system ?? []), "C:/Tools"];
    await diagnose(machine, {
      output: "'foo' is not recognized as an internal or external command",
    });
    expect(machine.runs.some((run) => run[0] === "C:/Tools/foo.exe")).toBe(false);
  });

  it("does not blame a PATH that is stale for a program that is simply not there", async () => {
    const diagnosis = await diagnose(windowsWithGh(), {
      output: "'zzz' is not recognized as an internal or external command",
    });
    expect(diagnosis.cause).toBe("found");
    expect(diagnosis.headline.en).toContain("zzz was not found");
    // The stale PATH is read, and shown, as a lead only.
    expect(item(diagnosis, "path.stale")).toMatchObject({ outcome: "stale" });
  });

  it("calls a stale PATH a lead when the forge's tool itself is fine", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.platform = "win32";
    machine.processFolders = ["C:/Windows/System32"];
    machine.system = ["C:/Windows/System32", "C:/Tools"];
    const diagnosis = await diagnose(machine, { code: "FORGE_NOT_LINKED" });
    expect(item(diagnosis, "forge.cli")).toMatchObject({ outcome: "ok" });
    expect(diagnosis.cause).toBe("suspected");
    expect(diagnosis.next).toBeUndefined();
  });

  it("does not turn a reading it could not make into a cause", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.diskGb = undefined;
    const diagnosis = await diagnose(machine, { output: "ENOSPC" });
    expect(item(diagnosis, "disk.space")).toMatchObject({ outcome: "unreadable" });
    expect(diagnosis.cause).toBe("not_found");
  });

  it("offers no repair for a lead", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.memory = 2;
    const diagnosis = await diagnose(machine, { exit_code: 137 });
    expect(diagnosis.cause).toBe("suspected");
    expect(diagnosis.next).toBeUndefined();
  });

  it("recognises a bare « Killed », and nothing in a harmless output", async () => {
    const machine = MemoryEnvironment.healthy();
    expect((await diagnose(machine, { output: "Killed" })).matched).toEqual(["killed"]);
    for (const harmless of [
      "all good: 12 files in 3 folders",
      "the temperature is fine",
      "compiled in 3s, 0 warnings",
    ]) {
      expect((await diagnose(machine, { output: harmless })).matched, harmless).toEqual([]);
    }
  });

  it("tells a tool of the AI tools that the system knows from one it does not", async () => {
    const tools: ToolProbe = {
      async which(names) {
        return names.includes("claude")
          ? { name: "claude", path: "/home/ada/.local/bin/claude", onPath: false }
          : undefined;
      },
      async version() {
        return "2.1.0 (Claude Code)";
      },
      async extensions() {
        return [];
      },
    };
    const machine = MemoryEnvironment.healthy();
    machine.platform = "linux";
    machine.system = ["/home/ada/.local/bin"];
    const known = await runDoctor(
      { ...contextOf(machine), tools },
      { only: ["tools.claude-code"] },
    );
    if (known instanceof Error) throw known;
    expect(known.items[0]).toMatchObject({ outcome: "stale", status: "warn" });
    machine.system = ["/usr/bin"];
    const unknown = await runDoctor(
      { ...contextOf(machine), tools },
      { only: ["tools.claude-code"] },
    );
    if (unknown instanceof Error) throw unknown;
    expect(unknown.items[0]).toMatchObject({ outcome: "off_path" });
  });

  it("tells a Docker that refuses access, or that is too slow, from one that is stopped", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.commands.set("docker", { path: "/usr/bin/docker", version: "Docker 27", onPath: true });
    machine.onRun = () => ({
      status: 1,
      stdout: "",
      stderr: "permission denied while trying to connect to the Docker daemon socket",
    });
    const refused = await diagnose(machine, { output: "Cannot connect to the Docker daemon" });
    expect(item(refused, "docker.daemon")).toMatchObject({ outcome: "denied" });
    expect(refused.next?.en).toContain("docker group");
    machine.onRun = () => ({ status: null, stdout: "", stderr: "", timedOut: true });
    const slow = await diagnose(machine, { output: "Cannot connect to the Docker daemon" });
    expect(item(slow, "docker.daemon")).toMatchObject({ outcome: "unreadable" });
    // A reading that timed out is not a cause.
    expect(slow.cause).toBe("not_found");
  });

  it("keeps Docker out of the usual report unless the stack names it", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.commands.set("docker", { path: "/usr/bin/docker", version: "Docker 27", onPath: true });
    machine.onRun = () => ({ status: 1, stdout: "", stderr: "error during connect" });
    const plain = await runDoctor(contextOf(machine));
    if (plain instanceof Error) throw plain;
    expect(plain.items.map((entry) => entry.id)).not.toContain("docker.daemon");
    const files = new MemoryFiles({
      ".agentplugged/docs/architecture.md":
        "---\nid: architecture\nkind: architecture\nowner: alex\nlinks: []\nprerequisites:\n  tools:\n    - { name: docker }\n---\n# Architecture\n",
    });
    const named = await runDoctor(contextOf(machine, files));
    if (named instanceof Error) throw named;
    expect(named.items.find((entry) => entry.id === "docker.daemon")).toMatchObject({
      outcome: "stopped",
    });
  });

  it("settles line endings by autocrlf input, and only a rule for every file or an eol rule", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.platform = "win32";
    machine.config.set("core.autocrlf", "input");
    const input = await diagnose(machine, { output: "bad interpreter" });
    expect(item(input, "git.line-endings")).toMatchObject({ outcome: "ok" });
    machine.config.set("core.autocrlf", "true");
    const binaryOnly = new MemoryFiles({ ".gitattributes": "*.png -text\n" });
    expect(
      item(await diagnose(machine, { output: "bad interpreter" }, binaryOnly), "git.line-endings"),
    ).toMatchObject({ outcome: "risky" });
    const forShell = new MemoryFiles({ ".gitattributes": "*.sh text eol=lf\n" });
    expect(
      item(await diagnose(machine, { output: "bad interpreter" }, forShell), "git.line-endings"),
    ).toMatchObject({ outcome: "ok" });
  });

  it("does not take the proxy off an empty Git setting", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.config.set("http.proxy", "");
    const diagnosis = await diagnose(machine, { output: "ETIMEDOUT" });
    expect(item(diagnosis, "network.proxy")).toMatchObject({ outcome: "ok" });
  });
});
