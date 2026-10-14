import { describe, expect, it } from "vitest";
import type { CommandContext } from "../command.js";
import { MemoryFiles, SHIPPED_DOCTOR, shippedMethod } from "../testing/memory-files.js";
import type { ToolProbe } from "../tools/tool-probe.js";
import { doctorCommand } from "./doctor-commands.js";
import { MemoryEnvironment } from "./memory-environment.js";
import {
  buildSupportReport,
  FACT_POLICY,
  REDACTIONS,
  type RedactionContext,
  type RedactionKind,
  redactFacts,
  redactionContextOf,
  redactText,
  type SupportReport,
} from "./support-report.js";

/**
 * `doctor --report`, the report to attach to a request for help. Everything personal
 * is made up here (a person called Mallory, a made-up company); the checks run on a simulated machine.
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

function contextOf(environment: MemoryEnvironment | undefined, files = new MemoryFiles()) {
  return {
    files,
    tools: NO_TOOLS,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.2.3",
    interactive: false,
    ...(environment === undefined ? {} : { environment }),
  } satisfies CommandContext;
}

/** A token that is not one, assembled from pieces: the public export refuses a file that holds a real-looking one. */
const FAKE_TOKEN = ["ghp", "_", "abcdefghijklmnopqrstuvwxyz0123456789"].join("");

const HOME = "C:\\Users\\Mallory Dupuis";
const PROJECT =
  "C:\\Users\\Mallory Dupuis\\Documents\\Société Été\\Projet Secret Alpha\\Livrables du premier trimestre de l'année";

/** The words that must never reach a report, whatever the report says. */
const PRIVATE = [
  "mallory",
  "dupuis",
  "société",
  "secret alpha",
  "projet secret",
  "p4ssw0rd",
  "proxy.corp.internal",
  "ghp_",
  "mallory.dupuis@acme-mail.example",
  "acme-internal",
];

/** A Windows machine with a person's name, folders, tokens and a company proxy everywhere. */
function personalMachine(): MemoryEnvironment {
  const machine = MemoryEnvironment.healthy();
  machine.platform = "win32";
  machine.folder = PROJECT;
  machine.machine = { arch: "x64", release: "10.0.26200", home: HOME, user: "Mallory Dupuis" };
  machine.config.set("user.name", "Mallory Dupuis");
  machine.config.set("user.email", "mallory.dupuis@acme-mail.example");
  machine.longPaths = false;
  machine.admin = false;
  machine.variables.set("SHELL", "C:\\Users\\Mallory Dupuis\\bin\\bash.exe");
  machine.variables.set("HTTPS_PROXY", "http://mallory:p4ssw0rd@proxy.corp.internal:3128");
  machine.variables.set("GITHUB_TOKEN", FAKE_TOKEN);
  machine.variables.set("ACME_INTERNAL_API_KEY", "acme-internal-key-0001");
  // Programs in the person's own folders: Git on the PATH, the forge's tool outside it.
  machine.commands.set("git", {
    path: `${HOME}\\Git\\git.exe`,
    version: `git version 2.46.0.windows.1 (${HOME}\\AppData)`,
    onPath: true,
  });
  machine.commands.set("gh", {
    path: `${HOME}\\AppData\\Local\\gh\\gh.exe`,
    version: "gh version 2.60.0",
    onPath: false,
  });
  machine.commands.set("docker", {
    path: `${HOME}\\Docker\\docker.exe`,
    version: "Docker version 27.0.3, build abc",
    onPath: true,
  });
  return machine;
}

async function reportOf(machine: MemoryEnvironment, files?: MemoryFiles): Promise<SupportReport> {
  const report = await buildSupportReport(contextOf(machine, files));
  if (report instanceof Error) throw report;
  return report;
}

describe("the support report", () => {
  it("holds the system, the versions and the result of every check, the after-failure ones too", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.commands.set("npm", { path: "/usr/bin/npm", version: "10.9.2", onPath: true });
    machine.variables.set("CI", "true");
    machine.variables.set("SHELL", "/usr/bin/zsh");
    machine.machine = { arch: "arm64", release: "24.1.0" };
    const report = await reportOf(machine);
    expect(report.format).toBe(1);
    expect(report.engine).toBe("1.2.3");
    expect(report.system).toMatchObject({
      platform: "win32",
      arch: "arm64",
      release: "24.1.0",
      node: "v24.1.0",
      shell: "zsh",
      interactive: false,
      ci: true,
    });
    expect(report.versions).toEqual(
      expect.arrayContaining([
        { tool: "git", version: "2.46.0" },
        { tool: "gh", version: "2.60.0" },
        { tool: "npm", version: "10.9.2" },
      ]),
    );
    const ids = report.checks.map((check) => check.id);
    expect(ids).toEqual(expect.arrayContaining(["node", "git.installed", "git.identity"]));
    // Checks that only matter after a failure are in too: a support person needs them.
    expect(ids).toEqual(
      expect.arrayContaining(["admin.rights", "network.proxy", "machine.memory"]),
    );
    expect(report.counts.ok + report.counts.warn + report.counts.fail).toBe(report.checks.length);
    for (const check of report.checks) {
      expect(check.text.en).not.toBe("");
      expect(check.text.fr).not.toBe("");
    }
  });

  it("names nothing personal, on a machine where everything is personal", async () => {
    const report = await reportOf(personalMachine());
    const text = JSON.stringify(report).toLowerCase();
    for (const secret of PRIVATE) expect(text, secret).not.toContain(secret.toLowerCase());
    // …and the points that speak of them are still there, with the right words.
    const byId = (id: string) => report.checks.find((check) => check.id === id);
    expect(byId("git.identity")?.text.en).toBe("Git signs your commits as [name] <[email]>");
    expect(byId("forge.cli")).toMatchObject({ outcome: "off_path" });
    expect(byId("forge.cli")?.text.en).toContain("[home]");
    expect(byId("path.length")?.text.en).toContain("[project]");
    expect(byId("network.proxy")?.text.en).toContain("HTTPS_PROXY ([host])");
    expect(report.system.shell).toBe("bash.exe");
  });

  it("keeps only version numbers of what the programs print", async () => {
    const report = await reportOf(personalMachine());
    expect(report.versions).toContainEqual({ tool: "git", version: "2.46.0" });
    expect(report.versions).toContainEqual({ tool: "docker", version: "27.0.3" });
    // The forge's tool is off the PATH: no version is asked of a program the shell cannot start.
    expect(report.versions.map((entry) => entry.tool)).not.toContain("gh");
    expect(JSON.stringify(report.versions)).not.toMatch(/Users|AppData/i);
  });

  it("hides what the product's architecture says (a prerequisite's reason is product content)", async () => {
    const machine = MemoryEnvironment.healthy();
    const files = new MemoryFiles({
      ".agentplugged/docs/architecture.md":
        "---\nid: architecture\nkind: architecture\nowner: alex\nlinks: []\nprerequisites:\n  tools:\n    - { name: tool-a, min: '9', why: 'the secret ledger of acme-internal' }\n---\n# Architecture\n",
    });
    const report = await reportOf(machine, files);
    // The point is there, with its kind and a number, and not the name of the tool nor its reason.
    const point = report.checks.find((check) => check.id === "prerequisite.tool.1");
    expect(point?.text.en).toContain("[tool]");
    expect(point?.text.fr).toContain("[tool]");
    const text = JSON.stringify(report).toLowerCase();
    for (const word of ["acme-internal", "ledger", "tool-a"])
      expect(text, word).not.toContain(word);
  });

  it("numbers the prerequisites by kind, and keeps the points of a probe that failed in a list of their own", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.port = async () => {
      throw new Error("the probe broke");
    };
    const files = new MemoryFiles({
      ".agentplugged/docs/architecture.md":
        "---\nid: architecture\nkind: architecture\nowner: alex\nlinks: []\nprerequisites:\n  tools:\n    - { name: tool-a, min: '9' }\n    - { name: tool-b, min: '1' }\n  ports: [5432]\n---\n# Architecture\n",
    });
    const report = await reportOf(machine, files);
    const ids = report.checks
      .map((check) => check.id)
      .filter((id) => id.startsWith("prerequisite."));
    expect(ids).toEqual(["prerequisite.tool.1", "prerequisite.tool.2"]);
    expect(report.unreadable).toEqual(["prerequisite.port.1"]);
    expect(JSON.stringify(report)).not.toContain("5432");
  });

  it("says what a secret-looking name is, not every variable with a session or an auth in its name", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.variables.set("XDG_SESSION_TYPE", "wayland");
    machine.variables.set("SSH_AUTH_SOCK", "/run/user/1000/agent");
    machine.variables.set("NO_PROXY", "localhost");
    machine.variables.set("NPM_AUTH_TOKEN", "a-real-looking-secret-value");
    const context = await redactionContextOf(machine);
    const removed = context.values.map((entry) => entry.value);
    expect(removed).toContain("a-real-looking-secret-value");
    for (const word of ["wayland", "/run/user/1000/agent", "localhost"]) {
      expect(removed, word).not.toContain(word);
    }
    // A short value is a word: removing it everywhere would spoil the sentences.
    machine.variables.set("API_TOKEN", "abc");
    expect((await redactionContextOf(machine)).values.map((entry) => entry.value)).not.toContain(
      "abc",
    );
  });

  it("reads CI as a boolean and the shell from SHELL alone", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.variables.set("CI", "false");
    machine.variables.set("ComSpec", "C:\\Windows\\System32\\cmd.exe");
    const report = await reportOf(machine);
    expect(report.system.ci).toBe(false);
    expect(report.system.shell).toBe("?");
    machine.variables.set("CI", "1");
    expect((await reportOf(machine)).system.ci).toBe(true);
  });

  it("plans no repair: no package manager is looked for while the report is made", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.commands.delete("git");
    const searched: string[] = [];
    const find = machine.find.bind(machine);
    machine.find = async (names, extra) => {
      searched.push(...names);
      return find(names, extra);
    };
    const report = await reportOf(machine);
    expect(report.checks.find((check) => check.id === "git.installed")?.outcome).toBe("missing");
    expect(searched).not.toEqual(expect.arrayContaining(["winget"]));
    expect(searched).not.toEqual(expect.arrayContaining(["brew"]));
    expect(searched).not.toEqual(expect.arrayContaining(["apt-get"]));
  });

  it("lists what it removes, in both languages, at the end of the report", async () => {
    const report = await reportOf(MemoryEnvironment.healthy());
    expect(report.removed).toEqual(REDACTIONS);
    expect(REDACTIONS.map((entry) => entry.kind).sort()).toEqual(
      ["email", "home", "host", "name", "path", "project", "secret", "tool", "user"].sort(),
    );
    for (const entry of REDACTIONS) {
      expect(entry.en).not.toBe("");
      expect(entry.fr).not.toBe("");
    }
  });

  it("is a creator's command with no repair and no question: the report alone", async () => {
    const machine = MemoryEnvironment.healthy();
    machine.commands.delete("gh");
    const result = await doctorCommand.run(contextOf(machine), { report: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.support?.checks.length).toBeGreaterThan(5);
    expect(result.value.items).toEqual([]);
    // Nothing was run but version questions.
    expect(machine.terminalRuns).toEqual([]);
    expect(machine.runs.every((run) => run.includes("--version") || run.includes("info"))).toBe(
      true,
    );
  });

  it("cannot be asked together with a failure, and needs a machine to look at", async () => {
    const both = await doctorCommand.run(contextOf(MemoryEnvironment.healthy()), {
      report: true,
      failure: { output: "x" },
    });
    expect(both.ok).toBe(false);
    const none = await doctorCommand.run(contextOf(undefined), { report: true });
    expect(none.ok).toBe(false);
  });
});

describe("what is removed", () => {
  const context: RedactionContext = {
    home: "/home/mallory",
    user: "mallory",
    project: "/work/Projet Secret Alpha",
    values: [
      { value: "Mallory Dupuis", kind: "name" },
      { value: "mallory@acme-mail.example", kind: "email" },
      { value: "hunter2-hunter2", kind: "secret" },
    ],
  };

  /** One sample per kind: what removes it, what must be gone, and what stands in its place. */
  const text = (sample: string) => () => redactText(sample, context);
  const SAMPLES: Record<RedactionKind, { out: () => string; gone: string; token: string }> = {
    user: { out: text("owner mallory is here"), gone: "mallory", token: "[user]" },
    home: { out: text("found in /home/mallory/tools/bin"), gone: "/home/mallory", token: "[home]" },
    project: {
      out: text("the folder /work/Projet Secret Alpha/src holds it"),
      gone: "Secret Alpha",
      token: "[project]",
    },
    path: { out: text("see /srv/data/customers/list.csv"), gone: "customers", token: "[path]" },
    host: {
      out: text("via https://proxy.corp.internal:3128/pac"),
      gone: "corp.internal",
      token: "[host]",
    },
    email: {
      out: text("write to someone@example.org"),
      gone: "someone@example.org",
      token: "[email]",
    },
    name: { out: text("signed as Mallory Dupuis"), gone: "Dupuis", token: "[name]" },
    // The tools the architecture asks for are removed from the facts of their own points.
    tool: {
      out: () => redactFacts({ name: "acme-ledger-cli" }, context, { tool: true }).name ?? "",
      gone: "acme-ledger-cli",
      token: "[tool]",
    },
    secret: { out: text(`token ${FAKE_TOKEN}`), gone: "ghp_", token: "[secret]" },
  };

  it("has a sample for every kind of the list, and each is removed", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(REDACTIONS.map((entry) => entry.kind).sort());
    for (const [kind, sample] of Object.entries(SAMPLES)) {
      const out = sample.out();
      expect(out, kind).not.toContain(sample.gone);
      expect(out, kind).toContain(sample.token);
    }
  });

  it("hides the paths people really have, with spaces and accents, in any separator", () => {
    const windows: RedactionContext = {
      home: HOME,
      user: "Mallory Dupuis",
      project: PROJECT,
      values: [],
    };
    for (const text of [
      `in ${PROJECT}`,
      `in ${PROJECT.replaceAll("\\", "/")}`,
      `in ${PROJECT.toUpperCase()}\\src\\index.ts`,
      `in ${HOME}\\Desktop\\Autre projet`,
      "in D:\\Clients\\Société X\\app",
      "in \\\\nas-maison\\partage\\factures",
      "in ~/Documents/perso",
    ]) {
      const out = redactText(text, windows);
      expect(out.toLowerCase(), text).not.toMatch(
        /mallory|société|clients|nas-maison|perso|factures|autre|projet|app|index/,
      );
    }
    // The whole path goes, to its last word: nothing of a name with a space is left behind.
    expect(redactText("in D:\\Clients\\Société X\\app", windows)).toBe("in [path]");
    expect(redactText(`in ${HOME}\\Desktop\\Autre projet`, windows)).toBe("in [home]");
    expect(redactText("kept: (/srv/my files/x), and more", windows)).toBe(
      "kept: ([path]), and more",
    );
  });

  it("hides an address with an accent, and the keys of the usual services", () => {
    expect(redactText("write to josé@exemple.fr", context)).toBe("write to [email]");
    const stripe = ["sk", "_live_", "0123456789abcdefghijklmn"].join("");
    expect(redactText(`key ${stripe}`, context)).toBe("key [secret]");
  });

  it("keeps the system's own folders, which tell where a tool is without telling who owns the machine", () => {
    const out = redactText(
      "found in C:\\Program Files\\Git\\cmd and /usr/local/bin/gh, not in /opt/homebrew/bin",
      context,
    );
    expect(out).toContain("C:\\Program Files\\Git\\cmd");
    expect(out).toContain("/usr/local/bin/gh");
    expect(out).toContain("/opt/homebrew/bin");
  });

  it("removes the credentials of an address and the secret-looking words, not plain prose", () => {
    expect(redactText("proxy http://u:pw@host.internal:8080/", context)).not.toMatch(
      /u:pw|internal/,
    );
    expect(redactText("password=abc123 and token: xyz", context)).toBe(
      "password=[secret] and token: [secret]",
    );
    expect(redactText("Bearer abcdefghijklmnop1234", context)).toBe("[secret]");
    expect(
      redactText("a 64-hex key 0123456789abcdef0123456789abcdef0123456789abcdef", context),
    ).toBe("a 64-hex key [secret]");
    // Prose and versions stay as they are.
    const prose = "Node v24.1.0 and Git 2.46.0: yes/no, 3.5 Go of memory, port 5432, 80% done";
    expect(redactText(prose, context)).toBe(prose);
    expect(redactText("see https://github.com/x and https://nodejs.org/en", context)).toBe(
      "see https://github.com and https://nodejs.org",
    );
  });
});

describe("the facts of the sentences", () => {
  it("decides for every placeholder of the shipped catalogue, so that a new one is a choice", () => {
    const used = new Set([...SHIPPED_DOCTOR.matchAll(/\{([a-z][a-z0-9_]*)\}/g)].map((m) => m[1]));
    const unknown = [...used].filter((key) => key !== undefined && !(key in FACT_POLICY));
    expect(unknown).toEqual([]);
  });

  it("drops a fact it does not know, and keeps the fixed ones", () => {
    const context: RedactionContext = { values: [] };
    expect(
      redactFacts({ mystery: "tell nobody", version: "2.46.0", why: "private reason" }, context),
    ).toEqual({ mystery: "[value]", version: "2.46.0", why: "[value]" });
  });

  it("hides the servers of the network settings unless they are public", () => {
    const context: RedactionContext = { values: [] };
    expect(
      redactFacts(
        {
          via: "HTTPS_PROXY (proxy.corp.internal) ; npm registry (registry.npmjs.org)",
          host: "git.corp.internal",
        },
        context,
      ),
    ).toEqual({
      via: "HTTPS_PROXY ([host]) ; npm registry (registry.npmjs.org)",
      host: "[host]",
    });
    expect(redactFacts({ host: "GitHub.com" }, context)).toEqual({ host: "github.com" });
    // A public server with a path after it (an organisation, a repository): the name of the server alone.
    expect(redactFacts({ host: "github.com/mallory/repo-prive" }, context)).toEqual({
      host: "github.com",
    });
  });
});
