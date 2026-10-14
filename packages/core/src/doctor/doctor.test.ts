import { describe, expect, it } from "vitest";
import type { CommandContext } from "../command.js";
import { MemoryFiles, SHIPPED_DOCTOR, shippedMethod } from "../testing/memory-files.js";
import type { ToolProbe } from "../tools/tool-probe.js";
import { parseDoctorCatalog } from "./catalog.js";
import { doctorCommand } from "./doctor-commands.js";
import { answerProblem, isAutomatic } from "./fixes.js";
import { MemoryEnvironment } from "./memory-environment.js";
import { runDoctor } from "./report.js";

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

/** A tool probe that finds `claude`, `onPath` or not. */
function toolsWith(found: Record<string, { version: string; onPath?: boolean }>): ToolProbe {
  return {
    async which(names) {
      const name = names.find((candidate) => found[candidate] !== undefined);
      if (name === undefined) return undefined;
      return found[name]?.onPath === false
        ? { name, path: `/home/ada/.local/bin/${name}`, onPath: false }
        : { name, path: `/usr/bin/${name}` };
    },
    async version(path) {
      const name = path.split("/").at(-1) ?? "";
      return found[name]?.version;
    },
    async extensions() {
      return [];
    },
  };
}

function contextOf(
  environment: MemoryEnvironment,
  options: { files?: MemoryFiles; tools?: ToolProbe } = {},
): CommandContext {
  return {
    files: options.files ?? new MemoryFiles(),
    tools: options.tools ?? NO_TOOLS,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
    environment,
  };
}

async function report(context: CommandContext, only?: string[]) {
  const result = await runDoctor(context, only === undefined ? {} : { only });
  if (result instanceof Error) throw result;
  return result;
}

const statusOf = (items: readonly { id: string; status: string }[], id: string) =>
  items.find((item) => item.id === id)?.status;

describe("the shipped catalogue", () => {
  it("parses, and every sentence and command only uses facts a detector gives", () => {
    const catalog = parseDoctorCatalog("doctor.yaml", SHIPPED_DOCTOR);
    if (catalog instanceof Error) throw catalog;
    // What each detector can tell, and what a creator's answer can add.
    const facts: Record<string, string[]> = {
      node: ["version", "min"],
      command: ["name", "path", "dir", "version", "min", "why", "needed"],
      "forge-cli": ["name", "path", "dir", "version", "forge", "forge_name", "cli", "host"],
      "forge-login": ["forge", "forge_name", "cli", "host"],
      "git-repo": [],
      "git-config": ["missing", "git_name", "git_email"],
      "ai-tool": ["name", "version", "dir", "names"],
      keychain: [],
      presence: [],
      port: ["port", "from", "to"],
      memory: ["memory", "needed"],
      "path-stale": ["count", "first", "dirs"],
      "docker-daemon": ["path", "dir", "version"],
      "docker-memory": ["memory", "needed"],
      disk: ["free", "needed", "folder"],
      "path-length": ["length", "max", "folder", "windows_long"],
      "line-endings": ["autocrlf", "attributes"],
      administrator: [],
      proxy: ["via"],
    };
    const used = (text: string) => [...text.matchAll(/\{([a-z][a-z0-9_]*)\}/g)].map((m) => m[1]);
    const all = [
      ...catalog.checks.map((check) => ({ ...check, known: facts[check.detect.kind] ?? [] })),
      { ...catalog.templates.tool, known: facts.command ?? [] },
      { ...catalog.templates.port, known: facts.port ?? [] },
      { ...catalog.templates.memory, known: facts.memory ?? [] },
      { ...catalog.templates.seen_tool, known: facts.command ?? [] },
      { ...catalog.templates.seen_port, known: facts.port ?? [] },
    ];
    for (const check of all) {
      for (const [outcome, text] of Object.entries(check.say)) {
        for (const language of [text?.en ?? "", text?.fr ?? ""]) {
          for (const name of used(language)) {
            expect(
              check.known,
              `${outcome} of ${(check as { id?: string }).id}: {${name}}`,
            ).toContain(name);
          }
        }
      }
      for (const fix of check.fix ?? []) {
        for (const option of fix.options ?? []) {
          const asked = (option.ask ?? []).map((ask) => ask.name);
          for (const argument of option.commands.flat()) {
            for (const name of used(argument)) {
              expect([...check.known, ...asked], `command {${name}}`).toContain(name);
            }
          }
        }
        for (const step of [...(fix.steps?.en ?? []), ...(fix.steps?.fr ?? [])]) {
          for (const name of used(step)) expect(check.known, `step {${name}}`).toContain(name);
        }
        for (const text of [fix.done?.en ?? "", fix.done?.fr ?? ""]) {
          for (const name of used(text)) expect(check.known, `done {${name}}`).toContain(name);
        }
      }
    }
  });

  it("gives every sentence in French too, and no command is a shell line", () => {
    const catalog = parseDoctorCatalog("doctor.yaml", SHIPPED_DOCTOR);
    if (catalog instanceof Error) throw catalog;
    const checks = [
      ...catalog.checks,
      catalog.templates.tool,
      catalog.templates.port,
      catalog.templates.memory,
      catalog.templates.seen_tool,
      catalog.templates.seen_port,
    ];
    for (const signature of catalog.signatures) {
      expect(signature.say.fr, signature.id).toBeDefined();
      if (signature.assumed !== undefined) expect(signature.assumed.fr, signature.id).toBeDefined();
    }
    for (const text of Object.values(catalog.diagnosis)) expect(text.fr).toBeDefined();
    for (const check of checks) {
      for (const text of Object.values(check.say)) expect(text?.fr).toBeDefined();
      for (const fix of check.fix ?? []) {
        if (fix.steps !== undefined) expect(fix.steps.fr?.length).toBe(fix.steps.en.length);
        for (const option of fix.options ?? []) {
          for (const command of option.commands) {
            expect(command[0]).not.toMatch(/\s/);
          }
        }
      }
    }
  });

  it("refuses an unknown detector and a check without a sentence for ok", () => {
    const base = SHIPPED_DOCTOR;
    expect(
      parseDoctorCatalog("doctor.yaml", base.replace("kind: keychain", "kind: telepathy")),
    ).toBeInstanceOf(Error);
    expect(
      parseDoctorCatalog(
        "doctor.yaml",
        base.replace(
          / {6}ok:\n {8}en: "System keychain available"\n {8}fr: "Trousseau du système disponible"\n/,
          "",
        ),
      ),
    ).toBeInstanceOf(Error);
  });
});

describe("runDoctor", () => {
  it("is ✓ everywhere on a machine that is fine", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.presenceWorks = true;
    const result = await report(
      contextOf(machine, { tools: toolsWith({ claude: { version: "2.1.0 (Claude Code)" } }) }),
    );
    expect(result.items.filter((item) => item.status !== "ok")).toEqual([]);
    expect(result.blocking).toBe(false);
    expect(result.items.map((item) => item.id)).toContain("git.identity");
    expect(result.items.find((item) => item.id === "git.installed")?.text.en).toBe("Git 2.46.0");
  });

  it("makes a missing Git a blocking ✗ with the package manager's command, and skips what depends on it", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.commands.delete("git");
    machine.commands.set("winget", { path: "C:/winget.exe", version: "v1", onPath: true });
    const result = await report(contextOf(machine));
    const git = result.items.find((item) => item.id === "git.installed");
    expect(git?.status).toBe("fail");
    expect(result.blocking).toBe(true);
    expect(git?.fix?.kind).toBe("run");
    expect(git?.fix?.display).toBe(
      "winget install --id Git.Git -e --source winget --accept-source-agreements --accept-package-agreements",
    );
    expect(git?.fix?.recommended).toBe(true);
    expect(isAutomatic(git?.fix as never)).toBe(true);
    // No repository and no identity to speak of without Git.
    expect(result.items.some((item) => item.id === "git.repo" || item.id === "git.identity")).toBe(
      false,
    );
  });

  it("gives steps when no package manager is there", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.commands.delete("git");
    const git = (await report(contextOf(machine))).items.find(
      (item) => item.id === "git.installed",
    );
    expect(git?.fix?.kind).toBe("steps");
    expect(git?.fix?.steps.fr[0]).toContain("git-scm.com");
    expect(git?.fix?.display).toBe("");
  });

  it("picks the repair of the machine it runs on", async () => {
    for (const [platform, manager, expected] of [
      ["darwin", "brew", "brew install git"],
      ["linux", "apt-get", "sudo apt-get install -y git"],
      ["linux", "dnf", "sudo dnf install -y git"],
    ] as const) {
      const machine = MemoryEnvironment.healthy();
      machine.platform = platform;
      machine.commands.delete("git");
      machine.commands.set(manager, { path: `/usr/bin/${manager}`, version: "1", onPath: true });
      const git = (await report(contextOf(machine))).items.find(
        (item) => item.id === "git.installed",
      );
      expect(git?.fix?.display).toBe(expected);
      // sudo asks for a password: the terminal only.
      expect(git?.fix?.interactive).toBe(platform === "linux");
    }
  });

  it("finds the forge's tool installed off the PATH and proposes the PATH of the account", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.commands.set("gh", {
      path: "C:\\Program Files\\GitHub CLI\\gh.exe",
      version: "gh version 2.60.0",
      onPath: false,
    });
    const gh = (await report(contextOf(machine))).items.find((item) => item.id === "forge.cli");
    expect(gh?.status).toBe("warn");
    expect(gh?.outcome).toBe("off_path");
    expect(gh?.text.en).toContain("C:\\Program Files\\GitHub CLI");
    expect(gh?.text.en).toContain("not on your PATH");
    expect(gh?.fix?.kind).toBe("run");
    expect(gh?.fix?.commands[0]?.[0]).toBe("powershell");
    expect(gh?.fix?.commands[0]?.at(-1)).toContain("C:\\Program Files\\GitHub CLI");
    expect(gh?.fix?.done?.en).toContain("reopen your editor");
    // The login is read through the same lookup: connected.
    expect(
      (await report(contextOf(machine))).items.find((item) => item.id === "forge.login")?.status,
    ).toBe("ok");
  });

  it("never builds a command from a folder holding a quote, but gives steps", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.commands.set("gh", {
      path: "C:\\Users\\O'Brien\\bin\\gh.exe",
      version: "gh version 2.60.0",
      onPath: false,
    });
    const gh = (await report(contextOf(machine))).items.find((item) => item.id === "forge.cli");
    expect(gh?.fix?.kind).toBe("steps");
    expect(gh?.fix?.steps.en.join(" ")).toContain("O'Brien");
  });

  it("reads the login from the exit code of the tool alone", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.loggedIn.clear();
    const result = await report(contextOf(machine));
    const login = result.items.find((item) => item.id === "forge.login");
    expect(login?.status).toBe("warn");
    expect(login?.text.fr).toContain("pas connecté à github.com");
    expect(login?.fix?.interactive).toBe(true);
    expect(login?.fix?.display).toBe("gh auth login --hostname github.com --web");
    expect(isAutomatic(login?.fix as never)).toBe(false);
    // No call asks for a token.
    expect(machine.runs.flat().join(" ")).not.toMatch(/token|config get/);
  });

  it("does not call a login missing when the forge cannot be reached", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.loggedIn.clear();
    machine.onRun = (command) =>
      command.includes("auth")
        ? {
            status: 1,
            stdout: "",
            stderr: "error validating token: dial tcp: lookup api.github.com: no such host",
          }
        : undefined;
    const login = (await report(contextOf(machine))).items.find(
      (item) => item.id === "forge.login",
    );
    expect(login?.outcome).toBe("unreadable");
    expect(login?.text.en).toBe("Cannot tell whether gh is connected to github.com (no network?)");
  });

  it("follows the forge of the remote, and says nothing of a forge it does not drive", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.remote = { forge: "gitlab", host: "gitlab.com" };
    machine.commands.set("glab", {
      path: "/usr/bin/glab",
      version: "glab version 1.50.0",
      onPath: true,
    });
    let result = await report(contextOf(machine));
    expect(result.items.find((item) => item.id === "forge.cli")?.text.en).toContain("glab 1.50.0");
    expect(result.items.find((item) => item.id === "forge.login")?.outcome).toBe("logged_out");
    machine.remote = { host: "git.example.org" };
    result = await report(contextOf(machine));
    expect(result.items.some((item) => item.id.startsWith("forge."))).toBe(false);
  });

  it("asks the identity it needs, with what Git already knows as the default", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.config.delete("user.email");
    const identity = (await report(contextOf(machine))).items.find(
      (item) => item.id === "git.identity",
    );
    expect(identity?.status).toBe("warn");
    expect(identity?.text.en).toContain("user.email");
    expect(identity?.fix?.asks.map((ask) => [ask.name, ask.default, ask.type])).toEqual([
      ["user_name", "Ada Lovelace", "text"],
      ["user_email", "", "email"],
    ]);
    expect(identity?.fix?.interactive).toBe(true);
  });

  it("proposes git init as the one repair that --yes may run", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.repository = false;
    const repo = (await report(contextOf(machine))).items.find((item) => item.id === "git.repo");
    expect(repo?.status).toBe("warn");
    expect(repo?.fix).toMatchObject({
      kind: "run",
      display: "git init",
      unattended: true,
      recommended: true,
    });
    const others = (await report(contextOf(machine))).items.filter(
      (item) => item.fix?.unattended === true,
    );
    expect(others.map((item) => item.id)).toEqual(["git.repo"]);
  });

  it("targets the tools the product lists, and the ones found when it lists none", async () => {
    const machine = MemoryEnvironment.healthy();
    const tools = toolsWith({
      claude: { version: "2.1.0" },
      codex: { version: "0.50.0", onPath: false },
    });
    let result = await report(contextOf(machine, { tools }));
    expect(statusOf(result.items, "tools.claude-code")).toBe("ok");
    expect(statusOf(result.items, "tools.codex")).toBe("warn");
    expect(result.items.find((item) => item.id === "tools.codex")?.outcome).toBe("off_path");
    // Cursor is on neither the machine nor the list of the product: nothing to say.
    expect(statusOf(result.items, "tools.cursor")).toBeUndefined();
    const files = new MemoryFiles({
      ".agentplugged/method.yaml":
        "format_version: 2\nengine_version: 1.0.0\ntools:\n  - claude-code\n  - cursor\n",
    });
    result = await report(contextOf(machine, { tools, files }));
    expect(statusOf(result.items, "tools.cursor")).toBe("warn");
    expect(statusOf(result.items, "tools.codex")).toBeUndefined();
    // No tool at all: one line, not four.
    result = await report(contextOf(machine));
    expect(statusOf(result.items, "tools.any")).toBe("warn");
    expect(result.items.filter((item) => item.id.startsWith("tools.")).length).toBe(1);
  });

  it("only checks Windows Hello on Windows, and the keychain everywhere", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.platform = "linux";
    machine.keychainWorks = false;
    const result = await report(contextOf(machine));
    expect(statusOf(result.items, "presence")).toBeUndefined();
    expect(statusOf(result.items, "keychain")).toBe("warn");
  });

  it("makes a Node too old a blocking ✗ with steps", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.node = "v22.3.0";
    const node = (await report(contextOf(machine))).items.find((item) => item.id === "node");
    expect(node?.status).toBe("fail");
    expect(node?.text.en).toBe("Node.js 22.3.0 is too old: AgentPlugged needs 24.0.0 or later");
    expect(node?.fix?.kind).toBe("steps");
  });

  it("reads only the checks asked for", async () => {
    const result = await report(contextOf(MemoryEnvironment.healthy()), ["git.installed"]);
    expect(result.items.map((item) => item.id)).toEqual(["git.installed"]);
  });

  it("fails clearly where the machine cannot be looked at", async () => {
    const context = { ...contextOf(MemoryEnvironment.healthy()), environment: undefined };
    const result = await doctorCommand.run(context, {});
    expect(result.ok).toBe(false);
  });
});

describe("what is put in a command", () => {
  it("never lets a typed answer or a fact of the machine read as an option", () => {
    const ask = { name: "user_name", say: { en: "", fr: "" }, default: "", type: "text" as const };
    expect(answerProblem(ask, "-x")).toBe(true);
    expect(answerProblem(ask, "--config=evil")).toBe(true);
    expect(answerProblem(ask, "Ada Lovelace")).toBe(false);
    expect(answerProblem(ask, "")).toBe(true);
    expect(answerProblem({ ...ask, type: "email" }, "ada@example.com")).toBe(false);
    expect(answerProblem({ ...ask, type: "email" }, "ada")).toBe(true);
  });

  it("gives steps, not a command, when a folder found on the machine starts with a dash", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.platform = "win32";
    machine.presenceWorks = true;
    machine.commands.set("gh", {
      path: "-weird\\gh.exe",
      version: "gh version 2.60.0",
      onPath: false,
    });
    const gh = (await report(contextOf(machine))).items.find((item) => item.id === "forge.cli");
    expect(gh?.fix?.kind).toBe("steps");
  });
});

describe("the prerequisites of the stack", () => {
  const architecture = (header: string) =>
    new MemoryFiles({
      ".agentplugged/docs/architecture.md": `---\nid: architecture\nkind: architecture\nowner: alex\nlinks: []\n${header}---\n# Architecture\n`,
    });

  it("adds one line per tool, port and memory the architect declared, with steps only", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.commands.set("docker", {
      path: "/usr/bin/docker",
      version: "Docker version 24.0.2, build x",
      onPath: true,
    });
    machine.ports.set(5432, "busy");
    machine.ports.set(54320, "refused");
    machine.memory = 4;
    const files = architecture(
      "prerequisites:\n  tools:\n    - { name: docker, min: 25, why: 'the local database' }\n    - { name: supabase }\n  ports: [5432, 54320, 3000]\n  memory_gb: 8\n",
    );
    const result = await report(contextOf(machine, { files }));
    const prerequisites = result.items.filter((item) => item.group === "prerequisites");
    expect(prerequisites.map((item) => [item.id, item.status])).toEqual([
      ["prerequisite.tool.docker", "warn"],
      ["prerequisite.tool.supabase", "warn"],
      ["prerequisite.port.5432", "warn"],
      ["prerequisite.port.54320", "warn"],
      ["prerequisite.port.3000", "ok"],
      ["prerequisite.memory", "warn"],
    ]);
    expect(prerequisites[0]?.text.en).toBe(
      "Your stack needs docker 25 or later; 24.0.2 is installed. the local database".replace(
        "installed. the",
        "installed. the",
      ),
    );
    expect(prerequisites[1]?.text.en).toBe(
      "Your stack needs supabase and it was not found (not in your PATH, nor in its usual folders).",
    );
    expect(prerequisites[2]?.text.fr).toContain("déjà utilisé");
    expect(prerequisites[3]?.text.en).toContain("refused by the system");
    expect(prerequisites[5]?.text.en).toBe("Only 4 GB of memory; your stack needs 8 GB");
    // What a document names is never run: steps only.
    for (const item of prerequisites.filter((entry) => entry.fix !== undefined)) {
      expect(item.fix?.kind).toBe("steps");
    }
    expect(result.blocking).toBe(false);
  });

  it("ignores an invalid header, and a name that is not a command", async () => {
    const machine = MemoryEnvironment.healthy();
    for (const header of [
      "prerequisites:\n  tools:\n    - { name: '../x' }\n",
      "prerequisites:\n  ports: [70000]\n",
      "prerequisites: yes\n",
    ]) {
      const result = await report(contextOf(machine, { files: architecture(header) }));
      expect(result.items.some((item) => item.group === "prerequisites")).toBe(false);
    }
  });
});
