// Tests of the install trials' own machinery: they need no archive, no network and
// no virtual machine. Run by `pnpm smoke` (first) and alone by `pnpm test:trials`.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { describeSpec, TrialFailure, TrialSkip, TrialWarning } from "./lib/harness.mjs";
import { hasRepair, longFolderName, pointOf, SCENARIOS } from "./lib/scenarios.mjs";
import { findOnPath, findShell, folderHolds, lineFor, quoteFor, shellInvocation, SHELLS_BY_PLATFORM } from "./lib/shells.mjs";
import { offlineGh, pathWithout, stoppedDocker, writeShim } from "./lib/shims.mjs";
import { counts, summaryMarkdown } from "./lib/summary.mjs";
import {
  packageToTry,
  parseArguments,
  parseDistributions,
  sandboxConfiguration,
  wslPath,
} from "./local.mjs";
import { chooseShells, play } from "./trial.mjs";

const WINDOWS = process.platform === "win32";
const scratch = () => mkdtempSync(join(tmpdir(), "agentplugged-trials-selftest-"));

describe("terminals", () => {
  it("quotes an argument for the terminal that will read it", () => {
    assert.equal(quoteFor("bash", "--json"), "--json");
    assert.equal(quoteFor("bash", "it's here"), "'it'\\''s here'");
    assert.equal(quoteFor("zsh", ""), "''");
    assert.equal(quoteFor("powershell", "it's here"), "'it''s here'");
    assert.equal(quoteFor("pwsh", "a b"), "'a b'");
    assert.equal(quoteFor("cmd", "a b"), '"a b"');
    assert.equal(quoteFor("cmd", "--yes"), "--yes");
    // cmd cannot carry these inside a quoted argument: refused rather than mangled.
    assert.throws(() => quoteFor("cmd", "50% sure"), /cannot be quoted/);
    assert.throws(() => quoteFor("cmd", "%PATH%"), /cannot be quoted/);
    assert.throws(() => quoteFor("cmd", "C:\\a b\\"), /cannot be quoted/);
  });

  it("types a command as a creator would", () => {
    assert.equal(
      lineFor("bash", ["npx", "agentplugged", "doctor", "--error", "no such file"]),
      "npx agentplugged doctor --error 'no such file'",
    );
    assert.equal(lineFor("cmd", ["npx", "agentplugged", "next"]), "npx agentplugged next");
  });

  it("starts each terminal on one line, and carries the exit code of the last command", () => {
    assert.deepEqual(shellInvocation("bash", "/bin/bash", "echo hi"), {
      command: "/bin/bash",
      args: ["-c", "echo hi"],
      verbatim: false,
    });
    const cmd = shellInvocation("cmd", "C:\\cmd.exe", "npx x");
    assert.deepEqual(cmd.args, ["/d", "/s", "/c", '"npx x"']);
    assert.equal(cmd.verbatim, true);
    for (const shell of ["powershell", "pwsh"]) {
      const invocation = shellInvocation(shell, "ps", "npx x");
      assert.ok(invocation.args.at(-1).endsWith("; exit $LASTEXITCODE"), shell);
      // The machine's own execution policy applies: a blocked npx.ps1 is a finding, not hidden.
      assert.ok(!invocation.args.includes("Bypass"), shell);
      assert.ok(!invocation.args.includes("-ExecutionPolicy"), shell);
    }
  });

  it("lists the terminals of each platform, the native one first", () => {
    assert.deepEqual(SHELLS_BY_PLATFORM.win32, ["powershell", "pwsh", "cmd", "bash"]);
    assert.equal(SHELLS_BY_PLATFORM.darwin[0], "zsh");
    assert.equal(SHELLS_BY_PLATFORM.linux[0], "bash");
    assert.ok(chooseShells("native").length <= 1);
    assert.deepEqual(chooseShells("bash, zsh"), ["bash", "zsh"]);
  });
});

describe("stand-in programs and the PATH around them", () => {
  it("plays the rules it was given and fails on any other call", () => {
    const dir = scratch();
    try {
      offlineGh(dir);
      stoppedDocker(dir);
      const run = (name, ...args) => {
        const path = join(dir, WINDOWS ? `${name}.cmd` : name);
        return WINDOWS
          ? spawnSync("cmd.exe", ["/d", "/s", "/c", `"${path}" ${args.join(" ")}`], { encoding: "utf8", windowsVerbatimArguments: true })
          : spawnSync(path, args, { encoding: "utf8" });
      };
      assert.match(run("gh", "--version").stdout, /gh version 2\.60\.0/);
      const auth = run("gh", "auth", "status");
      assert.equal(auth.status, 1);
      assert.match(auth.stderr, /no such host/);
      assert.equal(run("docker", "info").status, 1);
      assert.match(run("docker", "info").stderr, /dockerDesktopLinuxEngine/);
      assert.equal(run("gh", "pr", "list").status, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cuts the folders that hold a program out of the PATH, and gives up when Node.js would go with them", () => {
    const root = scratch();
    try {
      const withTool = join(root, "with-tool");
      const without = join(root, "without");
      const shims = join(root, "shims");
      for (const dir of [withTool, without, shims]) mkdirSync(dir, { recursive: true });
      writeShim(withTool, "sometool", []);
      // A stand-in for the folder of Node.js and npm (empty files are enough to be found).
      const node = join(root, "node");
      mkdirSync(node, { recursive: true });
      for (const name of ["node", "npm"]) writeShim(node, name, []);
      const base = [withTool, without, node].join(delimiter);
      assert.ok(folderHolds(withTool, ["sometool"]));
      assert.ok(!folderHolds(without, ["sometool"]));
      const cut = pathWithout({ shims: [shims], without: ["sometool"], base });
      assert.deepEqual(cut.path.split(delimiter), [shims, without, node]);
      assert.equal(findOnPath("sometool", cut.path), undefined);
      // Node.js and the tool in one folder: the PATH cannot be cut around the tool, and it is said.
      writeShim(node, "sometool", []);
      const stuck = pathWithout({ without: ["sometool"], base: [node].join(delimiter) });
      assert.equal(stuck.path, undefined);
      assert.match(stuck.skipped, /node lives in the same folder as sometool/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a PATH around a program that shares its folder (Unix)", { skip: WINDOWS }, () => {
  it("replaces the folder by links to everything but the program, in the same place", () => {
    const root = scratch();
    try {
      const shared = join(root, "usr-bin");
      const node = join(root, "node");
      const before = join(root, "before");
      for (const dir of [shared, node, before]) mkdirSync(dir, { recursive: true });
      for (const name of ["git", "gh", "bash"]) writeShim(shared, name, []);
      for (const name of ["node", "npm"]) writeShim(node, name, []);
      const base = [before, shared, node].join(delimiter);
      const cut = pathWithout({
        without: ["gh"],
        needs: ["node", "npm", "git"],
        base,
        farmRoot: join(root, "farm"),
      });
      const entries = cut.path.split(delimiter);
      assert.equal(entries[0], before);
      assert.equal(entries[2], node);
      assert.equal(findOnPath("gh", cut.path), undefined);
      assert.ok(findOnPath("git", cut.path) !== undefined, "git is still there");
      assert.ok(findOnPath("bash", cut.path) !== undefined, "so is the rest of the folder");
      // The program is still where it was: nothing was removed, only left out of the links.
      assert.ok(findOnPath("gh", base) !== undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("scenarios", () => {
  it("reads a doctor answer", () => {
    const answer = {
      points: [
        { id: "git.identity", fix: { command: ["git config --global user.name"], steps: { en: [] } } },
        { id: "keychain", fix: { steps: { en: ["install a secret service"] } } },
        { id: "node" },
      ],
    };
    assert.equal(pointOf(answer, "node").id, "node");
    assert.throws(() => pointOf(answer, "docker.daemon"), TrialFailure);
    assert.ok(hasRepair(pointOf(answer, "git.identity")));
    assert.ok(hasRepair(pointOf(answer, "keychain")));
    assert.ok(!hasRepair(pointOf(answer, "node")));
  });

  it("makes a folder name with spaces and accents that brings the whole path past 100 characters", () => {
    for (const parent of [20, 80, 140]) {
      const name = longFolderName(parent);
      assert.ok(/é|à|ñ|ü/.test(name) && name.includes(" "), name);
      assert.ok(parent + 1 + name.length > 100, `${parent} + ${name.length}`);
      assert.ok(name.length <= 80);
    }
  });

  it("has the imperfect machines of the story, each once, and the flow in every terminal", () => {
    const ids = SCENARIOS.map((scenario) => scenario.id);
    assert.deepEqual(ids, [
      "install-flow",
      "no-git",
      "git-out-of-path",
      "no-github-cli",
      "no-connection",
      "offline-after-install",
      "no-git-identity",
      "docker-stopped",
      "long-path",
      "proxy",
      "administrator",
    ]);
    assert.deepEqual(
      SCENARIOS.filter((scenario) => scenario.everyShell).map((scenario) => scenario.id),
      ["install-flow"],
    );
  });
});

describe("playing the scenarios", () => {
  const machine = { env: process.env };
  const shell = SHELLS_BY_PLATFORM[process.platform]?.find((name) => name !== "cmd" && name !== "powershell" && name !== "pwsh") ?? "bash";

  it("tells passing, failing, skipped and warned steps apart, and stops a terminal that is blocked", async () => {
    const scenarios = [
      { id: "a", title: "A", everyShell: true, run: async () => "fine" },
      { id: "b", title: "B", run: async () => { throw new TrialFailure("expected 1, got 2"); } },
      { id: "c", title: "C", run: async () => { throw new TrialSkip("not here"); } },
      { id: "d", title: "D", run: async () => { throw new TrialWarning("policy"); } },
      { id: "e", title: "E", run: async () => "never" },
    ];
    const lines = [];
    const results = await play({ machine, shells: [shell], scenarios, log: (line) => lines.push(line) });
    const found = results.map((result) => `${result.scenario}:${result.status}`);
    // The shell that warned is blocked: what comes after is skipped, with the reason.
    const shellFound = findOnPathOfShell(shell);
    if (shellFound) {
      assert.deepEqual(found, ["a:pass", "b:fail", "c:skip", "d:warn", "e:skip"]);
      assert.equal(results[0].detail, "fine");
      assert.equal(results[1].detail, "expected 1, got 2");
    } else {
      assert.ok(results.every((result) => result.status === "skip"));
    }
    assert.deepEqual(counts(results).fail, shellFound ? 1 : 0);
  });

  it("names a terminal the machine does not have, never hides it", async () => {
    const results = await play({
      machine,
      shells: ["no-such-terminal"],
      scenarios: [{ id: "a", title: "A", everyShell: true, run: async () => {} }],
      log: () => {},
    });
    assert.equal(results[0].status, "skip");
    assert.match(results[0].detail, /no-such-terminal is not on this machine/);
  });

  it("writes the table the workflow shows in its summary", () => {
    const markdown = summaryMarkdown({
      version: "1.2.3",
      mode: "tarball",
      platform: "linux/x64",
      node: "v24.0.0",
      results: [
        { shell: "bash", title: "flow", status: "pass", detail: "" },
        { shell: "zsh", title: "flow | pipe", status: "fail", detail: "line one\nline two" },
        { shell: "sh", title: "flow", status: "skip", detail: "sh is not on this machine" },
      ],
    });
    assert.match(markdown, /1 passed, 1 failed, 0 warning\(s\), 1 skipped/);
    assert.match(markdown, /\| ❌ \| zsh \| flow \| pipe \| line one \|/);
    assert.match(markdown, /### Failures[\s\S]*line two/);
  });
});

function findOnPathOfShell(shell) {
  return findShell(shell, process.env) !== undefined;
}

describe("the package to try", () => {
  it("is an archive made by pack, or a published version, nothing else", () => {
    // A path of this system: the archive is always given on the machine that runs the trials.
    const archive = join(tmpdir(), "x", "agentplugged-1.2.3.tgz");
    assert.deepEqual(describeSpec(archive), { mode: "tarball", spec: archive, version: "1.2.3" });
    assert.deepEqual(describeSpec("agentplugged@1.2.3-rc.1"), { mode: "registry", spec: "agentplugged@1.2.3-rc.1", version: "1.2.3-rc.1" });
    assert.throws(() => describeSpec("agentplugged"), /agentplugged@<version>/);
    assert.throws(() => describeSpec("left-pad@1.0.0"), /agentplugged@<version>/);
  });

  it("is given as is, or asks for the build first", () => {
    assert.equal(packageToTry("agentplugged@1.2.3").spec, "agentplugged@1.2.3");
  });
});

describe("the local command", () => {
  it("reads its arguments", () => {
    assert.deepEqual(parseArguments([]), { mode: "auto", node: "24", dryRun: false });
    assert.deepEqual(parseArguments(["sandbox", "--dry-run", "--node", "26", "--package", "x.tgz"]), {
      mode: "sandbox",
      node: "26",
      dryRun: true,
      spec: "x.tgz",
    });
    assert.equal(parseArguments(["linux", "--distro", "Ubuntu-24.04"]).distro, "Ubuntu-24.04");
    assert.throws(() => parseArguments(["--node", "latest"]), /major version/);
    assert.throws(() => parseArguments(["--distro", "a b; rm -rf"]), /distribution name/);
    assert.throws(() => parseArguments(["--nope"]), /unknown argument/);
  });

  it("reads the list of WSL distributions (UTF-16), without the ones Docker keeps for itself", () => {
    const utf16 = (text) => Buffer.from(`\uFEFF${text}`, "utf16le");
    assert.deepEqual(parseDistributions(utf16("Ubuntu (Default)\r\ndocker-desktop\r\nDebian\r\n")), ["Ubuntu", "Debian"]);
    assert.deepEqual(parseDistributions(utf16("docker-desktop\r\ndocker-desktop-data\r\n")), []);
    assert.deepEqual(parseDistributions(Buffer.alloc(0)), []);
  });

  it("gives WSL the path of a Windows file", () => {
    assert.equal(wslPath("C:\\Users\\Someone\\a b\\x.sh"), "/mnt/c/Users/Someone/a b/x.sh");
    assert.equal(wslPath("D:/work/x"), "/mnt/d/work/x");
    assert.throws(() => wslPath("/already/posix"), /not a Windows drive path/);
  });

  it("describes the disposable Windows: network on, the trial files read-only, one results folder writable", () => {
    const wsb = sandboxConfiguration({
      inFolder: "C:\\Temp\\in & out",
      outFolder: "C:\\Temp\\out",
      node: "24",
      archive: "C:\\Trial\\in\\agentplugged-1.2.3.tgz",
    });
    assert.match(wsb, /<Networking>Enable<\/Networking>/);
    assert.match(wsb, /<HostFolder>C:\\Temp\\in &amp; out<\/HostFolder>\s*<SandboxFolder>C:\\Trial\\in<\/SandboxFolder>\s*<ReadOnly>true<\/ReadOnly>/);
    assert.match(wsb, /<SandboxFolder>C:\\Trial\\out<\/SandboxFolder>\s*<ReadOnly>false<\/ReadOnly>/);
    assert.match(wsb, /sandbox-bootstrap\.ps1 -Node 24 -Package C:\\Trial\\in\\agentplugged-1\.2\.3\.tgz/);
    // The clipboard is closed: nothing leaves the sandbox but the results folder.
    assert.match(wsb, /<ClipboardRedirection>Disable<\/ClipboardRedirection>/);
  });

  it("writes the Windows Sandbox file and starts nothing with --dry-run", () => {
    const local = join(dirname(fileURLToPath(import.meta.url)), "local.mjs");
    const run = spawnSync(process.execPath, [local, "sandbox", "--dry-run", "--package", "agentplugged@1.2.3"], {
      encoding: "utf8",
    });
    if (WINDOWS) {
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /Windows Sandbox file written: .*agentplugged-trials\.wsb/);
      assert.match(run.stdout, /\(Nothing was started\.\)/);
      // The folder the dry run staged is of no use afterwards.
      const written = /written: (.*agentplugged-trials\.wsb)/.exec(run.stdout)?.[1];
      if (written !== undefined) rmSync(dirname(written), { recursive: true, force: true });
    } else {
      assert.match(run.stdout, /only exists on Windows/);
    }
  });
});
