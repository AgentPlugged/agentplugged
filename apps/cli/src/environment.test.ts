import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { MemoryEnvironment } from "@agentplugged/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "./main.js";

let cwd: string;
let home: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "agentplugged-environment-"));
  home = await mkdtemp(join(tmpdir(), "agentplugged-home-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** A Linux machine where everything is fine and the folder is a repository. */
function healthy(): MemoryEnvironment {
  const machine = MemoryEnvironment.healthy();
  machine.platform = "linux";
  return machine;
}

/** A machine without Git where winget would install it. */
function withoutGit(): MemoryEnvironment {
  const machine = healthy();
  machine.platform = "win32";
  machine.presenceWorks = true;
  machine.commands.delete("git");
  machine.commands.set("winget", { path: "C:/winget.exe", version: "v1.9", onPath: true });
  machine.onRun = (command) => {
    if (command[0] === "winget") {
      machine.commands.set("git", {
        path: "C:/Program Files/Git/cmd/git.exe",
        version: "git version 2.46.0",
        onPath: true,
      });
    }
    return undefined;
  };
  return machine;
}

interface Options {
  readonly answers?: string[];
  readonly machine?: MemoryEnvironment | undefined;
  readonly lang?: string;
  readonly env?: Record<string, string | undefined>;
}

/** Runs the CLI as a creator would: `answers` typed in a terminal, or a script when there are none. */
async function run(args: string[], options: Options = {}) {
  let stdout = "";
  let stderr = "";
  const status = await main({
    argv: args,
    cwd,
    env: {
      PATH: "",
      HOME: home,
      USERPROFILE: home,
      AGENTPLUGGED_LANG: options.lang ?? "en",
      AGENTPLUGGED_KEYCHAIN_SERVICE: process.env.AGENTPLUGGED_KEYCHAIN_SERVICE,
      AGENTPLUGGED_PRESENCE: "none",
      ...options.env,
    },
    engineVersion: "1.0.0",
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    stdin: Readable.from(
      options.answers === undefined ? [] : [options.answers.map((a) => `${a}\n`).join("")],
    ),
    interactive: options.answers !== undefined,
    ...(options.machine === undefined ? {} : { environmentProbe: options.machine }),
  });
  return { status, stdout, stderr };
}

const config = () => readFile(join(cwd, ".agentplugged/method.yaml"), "utf8");

describe("doctor", () => {
  it("is ✓ everywhere on a machine that is fine, exit code 0", async () => {
    const { status, stdout } = await run(["doctor"], { machine: healthy() });
    expect(status).toBe(0);
    expect(stdout).toContain("Checking your machine\n");
    expect(stdout).toContain("Git\n  ✓ Git 2.46.0\n  ✓ This folder is a Git repository\n");
    expect(stdout).toContain(
      "  ✓ gh 2.60.0, the GitHub command-line tool\n  ✓ gh is connected to github.com\n",
    );
    // No AI tool on the test machine: the one point to improve.
    expect(stdout).toContain("Ready: 8 · To improve: 1 · Blocking: 0");
  });

  it("says what is blocking, gives the steps of what it cannot run for you, and exits with 1", async () => {
    const machine = healthy();
    machine.commands.delete("git");
    const { status, stdout } = await run(["doctor"], { machine });
    expect(status).toBe(1);
    expect(stdout).toContain(
      "  ✗ Git was not found (not in your PATH, nor in its usual folders): the journal and the stories need it\n",
    );
    expect(stdout).toContain(
      "Git was not found (not in your PATH, nor in its usual folders): the journal and the stories need it\n  To do by hand, in this order:\n    1. Install Git from https://git-scm.com/downloads.\n",
    );
    expect(machine.runs.some((run) => run.includes("install"))).toBe(false);
  });

  it("speaks French, and gives the report in JSON for a script", async () => {
    const machine = healthy();
    machine.loggedIn.clear();
    const fr = await run(["doctor"], { machine, lang: "fr" });
    expect(fr.stdout).toContain("Vérification de ta machine");
    expect(fr.stdout).toContain("⚠ gh est installé mais pas connecté à github.com");
    expect(fr.stdout).toContain("Lance `npx agentplugged doctor` quand tu veux");
    const json = await run(["doctor", "--json"], { machine });
    expect(json.status).toBe(0);
    const report = JSON.parse(json.stdout) as {
      blocking: boolean;
      points: { id: string; status: string; fix?: { automatic: boolean; command?: string[] } }[];
    };
    expect(report.blocking).toBe(false);
    const login = report.points.find((point) => point.id === "forge.login");
    expect(login).toMatchObject({
      status: "warn",
      fix: { automatic: false, command: ["gh auth login --hostname github.com --web"] },
    });
  });

  it("shows the command, runs it after a yes, reads the point again and says it", async () => {
    const machine = withoutGit();
    const { status, stdout } = await run(["doctor"], { machine, answers: [""] });
    expect(status).toBe(0);
    expect(stdout).toContain(
      "Repair: Git was not found (not in your PATH, nor in its usual folders): the journal and the stories need it",
    );
    expect(stdout).toContain(
      "  I would run exactly:\n    winget install --id Git.Git -e --source winget --accept-source-agreements --accept-package-agreements\n",
    );
    expect(stdout).toContain("Run it? (Y/n) ");
    // In a terminal the program runs with the terminal as its own.
    expect(machine.terminalRuns).toEqual([
      [
        "winget",
        "install",
        "--id",
        "Git.Git",
        "-e",
        "--source",
        "winget",
        "--accept-source-agreements",
        "--accept-package-agreements",
      ],
    ]);
    expect(stdout).toContain("  ✓ Done. Git 2.46.0\n");
  });

  it("changes nothing after a no", async () => {
    const machine = withoutGit();
    const { status, stdout } = await run(["doctor"], { machine, answers: ["n"] });
    expect(status).toBe(1);
    expect(stdout).toContain("Fine, it stays as it is. Nothing was changed.");
    expect(machine.terminalRuns).toEqual([]);
    expect(machine.runs.some((run) => run[0] === "winget")).toBe(false);
  });

  it("asks the name and e-mail Git needs, and runs exactly what it shows", async () => {
    const machine = healthy();
    machine.config.clear();
    // Git, once told, knows.
    machine.onRun = (command) => {
      if (command[0] === "git" && command[1] === "config") {
        machine.config.set(command[3] ?? "", command[4] ?? "");
      }
      return undefined;
    };
    const { stdout } = await run(["doctor"], {
      machine,
      // Enter runs it (recommended); the two questions then.
      answers: ["", "Ada Lovelace", "ada@example.com"],
    });
    expect(stdout).toContain(
      '    git config --global user.name "<user_name>"\n    git config --global user.email "<user_email>"\n',
    );
    expect(stdout).toContain("Your name, as it will sign your commits: ");
    expect(stdout).toContain("Your e-mail: ");
    expect(stdout).toContain(
      '  With your answers, this is what runs:\n    git config --global user.name "Ada Lovelace"\n    git config --global user.email ada@example.com\n',
    );
    expect(stdout).toContain("  ✓ Done. Git signs your commits as Ada Lovelace <ada@example.com>");
    expect(machine.terminalRuns).toEqual([
      ["git", "config", "--global", "user.name", "Ada Lovelace"],
      ["git", "config", "--global", "user.email", "ada@example.com"],
    ]);
  });

  it("asks again after an e-mail that is not one", async () => {
    const machine = healthy();
    machine.config.clear();
    const { stdout } = await run(["doctor"], {
      machine,
      answers: ["", "Ada", "not-an-email", "ada@example.com"],
    });
    expect(stdout).toContain("That does not look right");
    expect(machine.terminalRuns.at(-1)).toEqual([
      "git",
      "config",
      "--global",
      "user.email",
      "ada@example.com",
    ]);
  });

  it("says a repair that failed, with the steps, and goes on", async () => {
    const machine = withoutGit();
    machine.onRun = () => ({ status: 1, stdout: "", stderr: "denied" });
    const { stdout } = await run(["doctor"], { machine, answers: [""] });
    expect(stdout).toContain("✗ The command stopped (code 1); nothing more was done.");
    expect(stdout).toContain("To do by hand, in this order:");
  });

  it("says the PATH of the account changed but the open windows do not see it yet", async () => {
    const machine = healthy();
    machine.platform = "win32";
    machine.presenceWorks = true;
    machine.commands.set("powershell", { path: "C:/powershell.exe", version: "5.1", onPath: true });
    machine.commands.set("gh", {
      path: "C:\\Program Files\\GitHub CLI\\gh.exe",
      version: "gh version 2.60.0",
      onPath: false,
    });
    const { stdout } = await run(["doctor"], { machine, answers: [""] });
    expect(stdout).toContain("C:\\Program Files\\GitHub CLI is on the PATH of your account");
    expect(machine.terminalRuns[0]?.[0]).toBe("powershell");
  });

  it("says it looks at nothing when the check is turned off", async () => {
    const { status, stdout } = await run(["doctor"], { env: { AGENTPLUGGED_ENVIRONMENT: "none" } });
    expect(status).toBe(0);
    expect(stdout).toContain("The check of the machine is off here");
  });

  it("refuses its own arguments and the options of init", async () => {
    expect((await run(["doctor", "now"])).status).toBe(1);
    expect((await run(["doctor", "--yes"])).stderr).toContain("--yes");
    expect((await run(["sync", "--tools", "codex"])).stderr).toContain("--tools");
  });
});

describe("doctor --error", () => {
  /** The classic case: gh installed and connected, its folder known to Windows, not to this program. */
  function ghHiddenByThePath(): MemoryEnvironment {
    const machine = healthy();
    machine.platform = "win32";
    machine.presenceWorks = true;
    machine.commands.set("gh", {
      path: "C:/Program Files/GitHub CLI/gh.exe",
      version: "gh version 2.60.0",
      onPath: false,
    });
    machine.processFolders = ["C:/Windows/System32"];
    machine.system = ["C:/Windows/System32", "C:/Program Files/GitHub CLI"];
    return machine;
  }

  it("says the cause the machine shows, apart from what it only supposes", async () => {
    const machine = healthy();
    machine.commands.set("docker", { path: "/usr/bin/docker", version: "Docker 27", onPath: true });
    machine.onRun = (command) =>
      command[1] === "info"
        ? {
            status: 0,
            stdout: command[3] === "{{.MemTotal}}" ? String(2 * 1024 ** 3) : "27.0.0",
            stderr: "",
          }
        : undefined;
    const { status, stdout } = await run(["doctor", "--error", "Killed", "--exit-code", "137"], {
      machine,
    });
    expect(status).toBe(0);
    expect(stdout).toContain(
      "Why it failed\n  A lead on your machine, which proves nothing by itself: Docker only has 2 GB of memory",
    );
    expect(stdout).toContain(
      "What the failure says:\n  - The program was stopped by force (exit code 137, signal 9)",
    );
    expect(stdout).toContain("Seen on your machine, just now:\n  ⚠ Docker only has 2 GB of memory");
    expect(stdout).toContain(
      "Supposed, not verified:\n  - Running out of memory is a frequent reason",
    );
    expect(stdout).toContain("To see everything: npx agentplugged doctor");
    // The usual report follows.
    expect(stdout).toContain("Checking your machine");
  });

  it("speaks French, and says the classic gh case with the folder it found", async () => {
    const { stdout } = await run(["doctor", "--error", "gh: command not found"], {
      machine: ghHiddenByThePath(),
      lang: "fr",
    });
    expect(stdout).toContain("Pourquoi ça a échoué");
    expect(stdout).toContain("Constaté sur ta machine, à l'instant :");
    expect(stdout).toContain(
      "gh est dans C:/Program Files/GitHub CLI, un dossier que ton système connaît mais que ce programme n'a pas encore : il a été ouvert avant",
    );
    expect(stdout).toContain("À faire : Ferme puis rouvre ton éditeur et ton terminal");
    expect(stdout).not.toContain("pas installé");
  });

  it("reads the failure from the standard input with `-`, and gives it in JSON without its text", async () => {
    const machine = healthy();
    machine.ports.set(54322, "refused");
    machine.reserved = [{ from: 54299, to: 54398 }];
    let stdout = "";
    const status = await main({
      argv: ["doctor", "--error", "-", "--json"],
      cwd,
      env: {
        PATH: "",
        HOME: home,
        USERPROFILE: home,
        AGENTPLUGGED_LANG: "en",
        AGENTPLUGGED_PRESENCE: "none",
      },
      engineVersion: "1.0.0",
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      stdin: Readable.from([
        "bind 127.0.0.1:54322: forbidden by its access permissions secret=abc123\n",
      ]),
      interactive: false,
      environmentProbe: machine,
    });
    expect(status).toBe(0);
    const json = JSON.parse(stdout) as {
      diagnosis: { matched: string[]; cause: string; headline: { en: string } };
    };
    expect(json.diagnosis.matched).toEqual(["port"]);
    expect(json.diagnosis.cause).toBe("found");
    expect(json.diagnosis.headline.en).toContain("54299-54398");
    expect(stdout).not.toContain("abc123");
  });

  it("recognises nothing it does not know and says so, exit code of the report", async () => {
    const { status, stdout } = await run(["doctor", "--error", "something odd"], {
      machine: healthy(),
    });
    expect(status).toBe(0);
    expect(stdout).toContain("I do not recognise this failure, so I blame nothing");
  });

  it("explains a repair that failed at the terminal, with what the machine shows", async () => {
    const machine = withoutGit();
    machine.memory = 2;
    machine.onRun = () => ({ status: 137, stdout: "", stderr: "Killed" });
    // Not at a terminal: the repair is not run; at one it is, and the failure is explained.
    const { stdout } = await run(["doctor"], { machine, answers: [""] });
    expect(stdout).toContain("✗ The command stopped (code 137); nothing more was done.");
    expect(stdout).toContain("Why it failed");
    expect(stdout).toContain("Only 2 GB of memory on this machine");
    expect(stdout).toContain("Supposed, not verified:");
  });

  it("takes a message that starts with a dash with `=`, and refuses `-` in a terminal", async () => {
    const { stdout } = await run(["doctor", "--error=-bash: gh: command not found"], {
      machine: healthy(),
    });
    expect(stdout).toContain("Why it failed");
    const viaTerminal = await run(["doctor", "--error", "-"], {
      machine: healthy(),
      answers: [""],
    });
    expect(viaTerminal.status).toBe(1);
    expect(viaTerminal.stderr).toContain("--error -");
  });

  it("refuses a bad exit code and the options on another command", async () => {
    expect((await run(["doctor", "--exit-code", "300"])).status).toBe(1);
    expect((await run(["doctor", "--exit-code", "x"])).status).toBe(1);
    expect((await run(["sync", "--error", "boom"])).stderr).toContain("--error");
    expect((await run(["next", "--exit-code", "1"])).stderr).toContain("--exit-code");
  });
});

describe("doctor --report", () => {
  /** A machine full of personal details: the report must carry none of them. */
  function personal(): MemoryEnvironment {
    const machine = healthy();
    machine.folder = cwd;
    machine.machine = { arch: "arm64", release: "24.1.0", home, user: "mallory-dupuis" };
    machine.config.set("user.name", "Mallory Dupuis");
    machine.config.set("user.email", "mallory.dupuis@acme-mail.example");
    machine.variables.set("HTTPS_PROXY", "http://mallory:p4ssw0rd@proxy.corp.internal:3128");
    // Assembled from pieces: the public export refuses a file that looks like it holds a token.
    machine.variables.set(
      "NPM_TOKEN",
      ["npm", "_", "abcdefghijklmnopqrstuvwxyz0123456789"].join(""),
    );
    machine.variables.set("SHELL", "/home/mallory-dupuis/bin/zsh");
    return machine;
  }

  it("prints the report to attach, in Markdown, and repairs nothing whatever the terminal", async () => {
    const machine = personal();
    machine.commands.delete("gh");
    const { status, stdout, stderr } = await run(["doctor", "--report"], {
      machine,
      answers: ["y", "y", "y"],
    });
    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("# AgentPlugged: environment report\n");
    expect(stdout).toContain("## System\n- Engine: agentplugged 1.0.0\n");
    expect(stdout).toContain("- System: linux arm64 (version 24.1.0)\n");
    expect(stdout).toContain("- Shell (SHELL variable): zsh\n");
    expect(stdout).toContain("## Versions\n- git 2.46.0\n");
    expect(stdout).toContain("## Checks (✓ ready, ⚠ to improve, ✗ blocking)\n");
    expect(stdout).toContain("- ✓ `git.installed` (ok): Git 2.46.0\n");
    expect(stdout).toContain(
      "- ✓ `git.identity` (ok): Git signs your commits as [name] <[email]>\n",
    );
    expect(stdout).toContain("`forge.cli` (missing)");
    expect(stdout).toContain("## Removed from this report\n");
    for (const entry of ["your account", "tokens, passwords", "e-mail addresses"]) {
      expect(stdout).toContain(entry);
    }
    // Nothing was run to repair, nothing was asked.
    expect(machine.terminalRuns).toEqual([]);
    expect(stdout).not.toContain("Run it?");
    for (const secret of ["mallory", "dupuis", "p4ssw0rd", "corp.internal", "npm_abc", cwd, home]) {
      expect(stdout.toLowerCase(), secret).not.toContain(secret.toLowerCase());
    }
  });

  it("leaks nothing of the real machine either: the real probe, with planted variables and the real account", async () => {
    // Assembled from pieces: the public export refuses a file that looks like it holds a token.
    const token = ["ghp", "_", "realProbeToken0123456789abcdefghij"].join("");
    // The real probe reads the variables of the process itself: planted there, and put back.
    const planted = {
      GITHUB_TOKEN: token,
      HTTPS_PROXY: "http://someone:realProxyPw@proxy.corp.internal:3128",
    };
    const before = Object.fromEntries(
      Object.keys(planted).map((name) => [name, process.env[name]]),
    );
    Object.assign(process.env, planted);
    let result: Awaited<ReturnType<typeof run>>;
    try {
      result = await run(["doctor", "--report"]);
    } finally {
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    const { status, stdout } = result;
    expect(status).toBe(0);
    expect(stdout).toContain("## Removed from this report");
    expect(stdout).toContain("HTTPS_PROXY ([host])");
    const account = userInfo().username;
    const private_ = [token, "realProxyPw", "corp.internal", cwd, home];
    // An account every machine has says nothing about the person.
    if (account.length >= 3 && !/^(?:root|admin|administrator)$/i.test(account)) {
      private_.push(account);
    }
    for (const secret of private_) {
      expect(stdout.toLowerCase(), secret).not.toContain(secret.toLowerCase());
    }
  });

  it("speaks the creator's language", async () => {
    const { stdout } = await run(["doctor", "--report"], { machine: personal(), lang: "fr" });
    expect(stdout).toContain("# AgentPlugged : rapport d'environnement\n");
    expect(stdout).toContain("## Retiré de ce rapport\n");
    expect(stdout).toContain("le nom de ton compte");
    expect(stdout).not.toMatch(/mallory|dupuis|p4ssw0rd/i);
  });

  it("is refused with a failure to explain, JSON, and on another command", async () => {
    const machine = healthy();
    for (const args of [
      ["doctor", "--report", "--json"],
      ["doctor", "--report", "--error", "boom"],
      ["doctor", "--report", "--exit-code", "1"],
      ["doctor", "--report", "extra"],
    ]) {
      const refused = await run(args, { machine });
      expect(refused.status, args.join(" ")).toBe(1);
      expect(refused.stderr).toContain("--report");
    }
    const other = await run(["sync", "--report"], { machine });
    expect(other.status).toBe(1);
    expect(other.stderr).toContain("--report");
  });

  it("says so when the machine cannot be looked at here", async () => {
    const { status, stdout } = await run(["doctor", "--report"], {
      env: { AGENTPLUGGED_ENVIRONMENT: "none" },
    });
    expect(status).toBe(0);
    expect(stdout).toContain("nothing was looked at");
  });
});

describe("init", () => {
  it("takes a creator from Enter, Enter, Enter… to « noah ? » (tools, profile, levels, permissions, sync)", async () => {
    const machine = healthy();
    const { status, stdout } = await run(["init"], {
      machine,
      answers: ["", "", "", "", "", "", "", "", ""],
    });
    expect(status).toBe(0);
    expect(stdout).toContain("Checking your machine");
    expect(stdout).toContain("AI tools to wire in");
    expect(stdout).toContain("What Claude Code asks before it acts");
    expect(stdout).toContain("Write the files of your AI tools now (sync)? (Y/n) ");
    expect(stdout).toContain("Files of your AI tools written (");
    expect(stdout.trimEnd().split("\n").at(-1)).toBe(
      "Ready. Open one of your tools (Claude Code, Codex, Antigravity CLI, Cursor) in this folder and write: noah ?",
    );
    const yaml = await config();
    expect(yaml).toContain("permissions:\n  mode: protected\n");
    expect(yaml).toContain("tools:\n  - claude-code\n  - codex\n  - antigravity\n  - cursor\n");
    await expect(readFile(join(cwd, ".claude/settings.json"), "utf8")).resolves.toContain(
      '"disableBypassPermissionsMode": "disable"',
    );
  });

  it("wires in the tools the creator ticks, and the sentence names them", async () => {
    const { stdout } = await run(["init"], {
      machine: healthy(),
      // Tools: Cursor only; then Enter to everything else.
      answers: ["4", "", "", "", "", "", "", ""],
    });
    expect(await config()).toContain("tools:\n  - cursor\n");
    // Claude Code is not wired in: nothing to say of its permissions.
    expect(stdout).not.toContain("What Claude Code asks before it acts");
    expect(stdout.trimEnd().split("\n").at(-1)).toBe(
      "Ready. Open Cursor in this folder and write: noah ?",
    );
  });

  it("offers the free mode with what it leaves without a guard, and keeps the choice", async () => {
    const { stdout } = await run(["init"], {
      machine: healthy(),
      answers: ["1", "", "", "", "", "", "", "2", ""],
    });
    expect(stdout).toContain("Free — The mode without questions stays possible in Claude Code");
    expect(stdout).toContain(
      "Permissions: free (the mode without questions of Claude Code is no longer turned off in this project).",
    );
    expect(await config()).toContain("permissions:\n  mode: free\n");
    const settings = await readFile(join(cwd, ".claude/settings.json"), "utf8");
    expect(settings).not.toContain("disableBypassPermissionsMode");
  });

  it("offers the repairs before anything is written, and installs the method whatever is answered", async () => {
    const machine = withoutGit();
    const { status, stdout } = await run(["init"], {
      machine,
      // Do not install Git; Enter for the rest (tools, profile…, permissions, sync, Windows Hello).
      answers: ["n", "", "", "", "", "", "", "", "", "", ""],
    });
    expect(status).toBe(0);
    expect(stdout.indexOf("Repair: Git was not found")).toBeLessThan(
      stdout.indexOf("Method installed in"),
    );
    expect(machine.terminalRuns).toEqual([]);
    await expect(config()).resolves.toContain("engine_version: 1.0.0");
  });

  it("asks nothing in a script: the report, the next step, and the exit code of a blocking point", async () => {
    const machine = withoutGit();
    const { status, stdout, stderr } = await run(["init"], { machine });
    expect(status).toBe(1);
    expect(stdout).toContain(
      "  ✗ Git was not found (not in your PATH, nor in its usual folders): the journal and the stories need it",
    );
    expect(stdout).toContain("Next step: run `npx agentplugged sync`");
    expect(stderr).toContain(
      "A blocking point remains: Git was not found (not in your PATH, nor in its usual folders): the journal and the stories need it.",
    );
    // Nothing was run, not even the harmless repair: only --yes allows that.
    expect(machine.runs.filter((run) => run.includes("install") || run.includes("init"))).toEqual(
      [],
    );
    expect(machine.terminalRuns).toEqual([]);
    // The method is installed all the same.
    await expect(config()).resolves.toContain("engine_version: 1.0.0");
  });

  it("with --yes, asks nothing, runs only git init, writes the tools' files and says what to do", async () => {
    const machine = healthy();
    machine.repository = false;
    machine.loggedIn.clear();
    const { status, stdout } = await run(["init", "--yes", "--tools", "claude-code"], {
      machine,
      answers: [],
    });
    expect(status).toBe(0);
    expect(machine.runs.filter((run) => run[0] === "git")).toEqual([["git", "init"]]);
    // The sign-in of the forge needs the terminal: shown as a warning, never run.
    expect(machine.terminalRuns).toEqual([]);
    expect(stdout).toContain("Repair: This folder is not a Git repository yet");
    expect(stdout).toContain("Files of your AI tools written (");
    expect(stdout.trimEnd().split("\n").at(-1)).toBe(
      "Ready. Open Claude Code in this folder and write: noah ?",
    );
    expect(await config()).toContain("tools:\n  - claude-code\n");
  });

  it("with --yes and a blocking point, exits with 1 after doing everything else", async () => {
    const machine = withoutGit();
    const { status, stdout } = await run(["init", "--yes"], { machine, answers: [] });
    expect(status).toBe(1);
    expect(stdout).toContain("Ready. Open one of your tools");
  });

  it("--no-sync leaves the tools' files out and says how to write them", async () => {
    const { status, stdout } = await run(["init", "--yes", "--no-sync", "--tools", "codex"], {
      machine: healthy(),
    });
    expect(status).toBe(0);
    expect(stdout).toContain("No sync for now: run `npx agentplugged sync` whenever you want.");
    expect(stdout.trimEnd().split("\n").at(-1)).toBe(
      "Next: run `npx agentplugged sync`, then open Codex in this folder and write: noah ?",
    );
    await expect(readFile(join(cwd, "AGENTS.md"), "utf8")).resolves.toContain("agentplugged");
    await expect(readFile(join(cwd, ".codex/config.toml"), "utf8")).rejects.toThrow();
  });

  it("takes --permissions free without a question, and refuses a mode that does not exist", async () => {
    const { status } = await run(
      ["init", "--yes", "--tools", "claude-code", "--permissions", "free"],
      {
        machine: healthy(),
      },
    );
    expect(status).toBe(0);
    expect(await config()).toContain("mode: free");
    const refused = await run(["init", "--permissions", "yolo"], { machine: healthy() });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("permissions.mode");
    const badTool = await run(["init", "--tools", "emacs"], { machine: healthy() });
    expect(badTool.status).toBe(1);
    expect(badTool.stderr).toContain("tools");
  });

  it("looks at nothing when the check is off, and still ends with « noah ? » at a terminal", async () => {
    const { status, stdout } = await run(["init"], {
      answers: ["", "", "", "", "", "", "", "", ""],
      env: { AGENTPLUGGED_ENVIRONMENT: "none" },
    });
    expect(status).toBe(0);
    expect(stdout).not.toContain("Checking your machine");
    expect(stdout).toContain("write: noah ?");
  });
});

describe("profile --permissions", () => {
  it("changes the mode alone, and sync follows", async () => {
    await run(["init", "--yes", "--tools", "claude-code"], { machine: healthy() });
    const free = await run(["profile", "--permissions", "free"]);
    expect(free.status).toBe(0);
    expect(free.stdout).toContain("Permissions: free");
    const sync = await run(["sync"]);
    expect(sync.status).toBe(0);
    await expect(readFile(join(cwd, ".claude/settings.json"), "utf8")).resolves.not.toContain(
      "disableBypassPermissionsMode",
    );
    const back = await run(["profile", "--permissions", "protected"]);
    expect(back.stdout).toContain("Permissions: protected");
  });
});

describe("init --channel and the channel `doctor` reports", () => {
  const channelFile = () => readFile(join(cwd, ".agentplugged/.cache/install-channel"), "utf8");
  const installedBy = async () => {
    const json = await run(["doctor", "--json"], { machine: healthy() });
    return (JSON.parse(json.stdout) as { install_channel: string }).install_channel;
  };

  it("notes the store the method came from, outside the summary of `init`", async () => {
    const withChannel = await run(
      ["init", "--yes", "--tools", "claude-code", "--channel", "claude-plugin"],
      { machine: healthy() },
    );
    expect(withChannel.status).toBe(0);
    await expect(channelFile()).resolves.toBe("claude-plugin\n");
    // The summary is the one `init` gives without the option: the note is not one of its entries.
    expect(withChannel.stdout).not.toContain("install-channel");
    // Running `init` again without the option does not forget where the method came from.
    await run(["init", "--yes", "--tools", "claude-code"], { machine: healthy() });
    await expect(channelFile()).resolves.toBe("claude-plugin\n");
  });

  it("makes `doctor` say how the method was installed, in both languages and in JSON", async () => {
    await run(["init", "--yes", "--tools", "claude-code", "--channel", "claude-plugin"], {
      machine: healthy(),
    });
    const en = await run(["doctor"], { machine: healthy() });
    expect(en.stdout).toContain(
      "Installed from: the AgentPlugged plugin of Claude Code (its welcome skill ran `init`).",
    );
    const fr = await run(["doctor"], { machine: healthy(), lang: "fr" });
    expect(fr.stdout).toContain("Installé depuis : le plugin AgentPlugged de Claude Code");
    expect(await installedBy()).toBe("claude-plugin");
  });

  it("says npm when no store is noted, and ignores a note it does not know", async () => {
    await run(["init", "--yes", "--tools", "claude-code"], { machine: healthy() });
    const npm = await run(["doctor"], { machine: healthy() });
    expect(npm.stdout).toContain("Installed from: npm (`npx agentplugged init`)");
    expect(await installedBy()).toBe("npm");
    await writeFile(join(cwd, ".agentplugged/.cache/install-channel"), "elsewhere\n");
    expect(await installedBy()).toBe("npm");
  });

  it("refuses an unknown store, and the option outside `init`, writing nothing", async () => {
    const unknown = await run(["init", "--yes", "--channel", "somewhere"], { machine: healthy() });
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("--channel");
    await expect(config()).rejects.toThrow();
    const elsewhere = await run(["doctor", "--channel", "claude-plugin"], { machine: healthy() });
    expect(elsewhere.status).toBe(1);
    expect(elsewhere.stderr).toContain("--channel");
  });
});
