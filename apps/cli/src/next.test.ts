import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { GitStateStore, NodeKeyStore, NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import { removeTestKeys } from "@agentplugged/adapters-git/test-keychain";
import {
  type CommandContext,
  createCommandRegistry,
  type NextResult,
  RETIRED_DEVELOPERS,
  type RecordedEvent,
} from "@agentplugged/core";
import { createTranslator } from "@agentplugged/i18n";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";
import { main } from "./main.js";
import { agentCall, agentLabel, formatNext, nextJson } from "./next-text.js";

vi.setConfig({ testTimeout: 120_000 });

const bin = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/bin.js");
/** A keychain service of this file only, deleted after each test: never the real entries. */
const service = `agentplugged-test-next-${process.pid}-${Date.now()}`;
const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

let cwd: string;
let home: string;
let env: Record<string, string>;

/** Runs git in the test repository only; never in this one, never on the network. */
function git(args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env, windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** True when this machine has a system keychain (a Linux server may have none). */
async function keychainAvailable(): Promise<boolean> {
  try {
    await new NodeKeyStore({ service }).readHumanSecret();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/platform secure storage|no storage access|secret service|dbus|keyutils/i.test(message)) {
      return false;
    }
    throw error;
  }
}

beforeAll(() => {
  if (!existsSync(bin)) throw new Error(`Build the CLI first: ${bin} is missing`);
});

beforeEach(async (context) => {
  if (!(await keychainAvailable())) context.skip("no system keychain on this machine");
  cwd = await mkdtemp(join(tmpdir(), "agentplugged-next-"));
  home = await mkdtemp(join(tmpdir(), "agentplugged-next-home-"));
  await writeFile(join(home, ".gitconfig"), "");
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(home|userprofile)$/i.test(key)) inherited[key] = value;
  }
  env = {
    ...inherited,
    HOME: home,
    USERPROFILE: home,
    AGENTPLUGGED_LANG: "fr",
    AGENTPLUGGED_KEYCHAIN_SERVICE: service,
    AGENTPLUGGED_PRESENCE: "none",
    AGENTPLUGGED_ENVIRONMENT: "none",
    // Git finds no repository above the temporary folders, and no configuration of this machine.
    GIT_CEILING_DIRECTORIES: await realpath(tmpdir()),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
  };
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Ada"]);
  git(["config", "user.email", "ada@example.com"]);
});

afterEach(async () => {
  await removeTestKeys(service);
  for (const folder of [cwd, home]) {
    if (folder !== undefined) {
      await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
});

/** Runs the CLI in process, without a terminal. */
async function cli(args: string[], lang = "fr", extra: Record<string, string> = {}) {
  let stdout = "";
  let stderr = "";
  const status = await main({
    argv: args,
    cwd,
    env: { ...env, PATH: process.env.PATH ?? "", AGENTPLUGGED_LANG: lang, ...extra },
    engineVersion: VERSION,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    stdin: Readable.from([]),
    interactive: false,
  });
  return { status, stdout, stderr };
}

/** The built binary, as the creator (or an agent's shell) runs it: no terminal. */
function binary(args: string[], lang = "fr") {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    env: { ...env, AGENTPLUGGED_LANG: lang },
    encoding: "utf8",
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** `init`, the four tools targeted whatever this machine has, then `sync`. */
async function installed(): Promise<void> {
  const init = await cli(["init", "--profile", "new-product"]);
  expect(init.status).toBe(0);
  const path = join(cwd, ".agentplugged", "method.yaml");
  const document = parseDocument(await readFile(path, "utf8"));
  document.set("tools", ["claude-code", "codex", "antigravity", "cursor"]);
  await writeFile(path, document.toString());
  const sync = await cli(["sync"]);
  expect(sync.stderr).toBe("");
  expect(sync.status).toBe(0);
}

/** The agents' side, in process: opens a checkpoint as `iris`. */
async function openCheckpoint(input: Record<string, unknown>): Promise<string> {
  const journal = new GitStateStore({
    cwd,
    keys: new NodeKeyStore({ service }),
    machineLockPath: join(home, ".agentplugged", "machine-key.lock"),
  });
  const context: CommandContext = {
    files: new NodeWorkspaceFiles(cwd),
    tools: {
      which: async () => undefined,
      version: async () => undefined,
      extensions: async () => [],
    },
    method: {
      listFiles: () => Promise.reject(new Error("unused")),
      readText: () => Promise.reject(new Error("unused")),
      readBytes: () => Promise.reject(new Error("unused")),
    },
    actor: "agent",
    engineVersion: VERSION,
    journal,
  };
  try {
    const result = await createCommandRegistry().run("open_checkpoint", context, {
      agent: "iris",
      ...input,
    });
    if (!result.ok) throw new Error(`open_checkpoint: ${result.error.code}`);
    return (result.value as RecordedEvent).checkpoint as string;
  } finally {
    journal.close();
  }
}

const ERROR_PREFIX = "Erreur INVALID_ARGUMENTS : Arguments invalides : ";

describe("next: acceptance", () => {
  it("proposes Iris for framing after init and sync, in three lines", async () => {
    await installed();
    const before = git(["for-each-ref"]);
    const next = binary(["next"]);
    expect(next.stderr).toBe("");
    expect(next.status).toBe(0);
    expect(next.stdout).toBe(
      "Phase : Cadrage · Étape : Écrire le brief\nAgent : Iris, avec /iris dans Claude Code\nEn attente de toi : rien\n",
    );
    // A read command: the journal is left as it was.
    expect(git(["for-each-ref"])).toBe(before);
    const english = binary(["next"], "en");
    expect(english.stdout).toBe(
      "Phase: Framing · Step: Write the brief\nAgent: Iris, with /iris in Claude Code\nWaiting for you: nothing\n",
    );
  });

  it("puts a blocking checkpoint first, its title cleaned in text and exact in JSON", async () => {
    await installed();
    const title = "Story 2-6\u001b[2J done‮";
    const id = await openCheckpoint({
      type: "story",
      risk: "low",
      title,
      summary: "Review the work on 2-6.",
      story: "2-6",
      blocks: [{ action: "story.review", story: "2-6" }],
    });
    const next = binary(["next"]);
    expect(next.stderr).toBe("");
    expect(next.stdout).toBe(
      [
        "Phase : Cadrage · Étape : Validation en attente, story 2-6",
        "Agent : toi",
        `En attente de toi : 1 point, ${id} « Story 2-6 [2J done »`,
        // The creator answers in the chat; the terminal stays possible.
        `Réponds dans le chat de ton outil IA : dans le formulaire du moteur quand il s'affiche, sinon par écrit ou en dictée (l'agent cite ta réponse).`,
        "",
      ].join("\n"),
    );
    const json = binary(["next", "--json"]);
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({
      step: "validation",
      you: true,
      agent: null,
      agent_name: null,
      tool: null,
      waiting: [{ id, title, type: "story", risk: "low" }],
      command: `npx agentplugged review ${id}`,
      answer: "chat",
      story: "2-6",
      checkpoint: id,
      sync: null,
      missing_tools: [],
      pending_keys: [],
      phase: "framing",
      phases: [
        { id: "framing", status: "in_progress" },
        { id: "planning", status: "upcoming" },
        { id: "design", status: "upcoming" },
        { id: "build", status: "upcoming" },
        { id: "delivery", status: "upcoming" },
        { id: "launch", status: "upcoming" },
      ],
      stray: [],
      sprint: null,
      deferred: null,
      // The single stack of what waits, and the morning summary.
      pile: { stack: [id], apart: [], more: 0 },
      journey: { skipped: [], skipped_total: 0 },
      git: expect.objectContaining({ chosen: false }),
      morning: {
        since: null,
        done: [],
        done_total: 0,
        decided: [],
        decided_total: 0,
        closed: [],
        closed_total: 0,
        escalated: [],
        waiting: [id],
      },
    });
  });

  it("asks for a sync when the files of Claude Code are missing, in text and JSON", async () => {
    await installed();
    await rm(join(cwd, ".claude"), {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
    const next = await cli(["next"]);
    expect(next.status).toBe(0);
    expect(next.stdout).toBe(
      [
        "Phase : Cadrage · Étape : Synchronisation de la méthode (fichiers manquants pour Claude Code)",
        "Agent : toi",
        "En attente de toi : rien",
        "Commande : npx agentplugged sync",
        "",
      ].join("\n"),
    );
    const json = await cli(["next", "--json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({
      step: "sync",
      you: true,
      sync: "tool_missing",
      missing_tools: ["claude-code"],
      command: "npx agentplugged sync",
    });
  });

  it("says the method is out of sync once an agent changes, until the next sync", async () => {
    await installed();
    const skill = join(cwd, ".agentplugged", "agents", "iris", "SKILL.md");
    const text = await readFile(skill, "utf8");
    // The same bytes written again: nothing to sync.
    await writeFile(skill, text);
    expect((await cli(["next", "--json"])).stdout).toContain('"step": "framing"');
    await writeFile(skill, `${text}\nOne more line.\n`);
    const stale = await cli(["next"]);
    expect(stale.stdout).toContain(
      "Phase : Cadrage · Étape : Synchronisation de la méthode (les agents, compétences, personnalisations ou réglages ont changé depuis le dernier sync)",
    );
    expect((await cli(["sync"])).status).toBe(0);
    expect((await cli(["next", "--json"])).stdout).toContain('"step": "framing"');
    // A file added to an agent's folder, synced, then deleted: out of sync again.
    const extra = join(cwd, ".agentplugged", "agents", "iris", "references", "extra.md");
    await mkdir(dirname(extra), { recursive: true });
    await writeFile(extra, "More.\n");
    expect((await cli(["next", "--json"])).stdout).toContain('"sync": "stale"');
    expect((await cli(["sync"])).status).toBe(0);
    expect((await cli(["next", "--json"])).stdout).toContain('"step": "framing"');
    await rm(extra, { force: true });
    expect((await cli(["next", "--json"])).stdout).toContain('"sync": "stale"');
  });

  it("names a creator's key waiting for its endorsement", async () => {
    await installed();
    // A second creator's key (another keychain) joins the product: it waits for an endorsement.
    const other = `${service}-other`;
    try {
      const init = await cli(["init"], "fr", { AGENTPLUGGED_KEYCHAIN_SERVICE: other });
      expect(init.status).toBe(0);
      const json = JSON.parse((await cli(["next", "--json"])).stdout) as NextResult;
      expect(json).toMatchObject({
        step: "key_endorsement",
        you: true,
        command: "npx agentplugged key endorse",
      });
      expect(json.pending_keys).toHaveLength(1);
      const [key] = json.pending_keys;
      expect(key).toMatch(/^human:/);
      expect((await cli(["next"])).stdout).toBe(
        [
          `Phase : Cadrage · Étape : Approbation d'une clé de créateur (${key})`,
          "Agent : toi",
          "En attente de toi : rien",
          "Commande : npx agentplugged key endorse",
          "",
        ].join("\n"),
      );
    } finally {
      await removeTestKeys(other);
    }
  });

  it("proposes Zoé's knowledge base first after init on an existing product", async () => {
    await writeFile(join(cwd, "package.json"), '{ "name": "ada-shop" }\n');
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "index.js"), "export {};\n");
    const init = await cli(["init", "--profile", "maintenance"]);
    expect(init.status).toBe(0);
    expect(init.stdout).toContain("Produit existant : ses fichiers étaient déjà là");
    expect(init.stdout).toContain("par Zoé");
    expect(init.stdout).toContain("mets `origin: new` dans `.agentplugged/method.yaml`");
    const path = join(cwd, ".agentplugged", "method.yaml");
    const document = parseDocument(await readFile(path, "utf8"));
    expect(document.get("origin")).toBe("existing");
    document.set("tools", ["claude-code", "codex", "antigravity", "cursor"]);
    await writeFile(path, document.toString());
    expect((await cli(["sync"])).status).toBe(0);
    const next = binary(["next"]);
    expect(next.stderr).toBe("");
    expect(next.stdout).toContain("Étape : Générer la base de connaissance");
    expect(next.stdout).toContain("Agent : Zoé, avec /zoe dans Claude Code");
    expect(JSON.parse(binary(["next", "--json"]).stdout)).toMatchObject({
      step: "knowledge_base",
      agent: "zoe",
    });
    // Once the map of the base exists, the work of the phase comes back.
    const map = "---\nid: kb-index\nkind: note\nowner: zoe\nlinks: []\n---\n# Base\n";
    await writeFile(join(cwd, ".agentplugged", "docs", "index.md"), map);
    expect(JSON.parse(binary(["next", "--json"]).stdout).step).not.toBe("knowledge_base");
  });

  it("says nothing of an existing product in an empty folder, nor on a later init", async () => {
    for (const lang of ["fr", "en"]) {
      const init = await cli(["init", "--profile", "new-product"], lang);
      expect(init.status).toBe(0);
      expect(init.stdout).not.toContain("origin: existing");
      expect(init.stdout).not.toMatch(/Produit existant|Existing product/);
    }
    await writeFile(join(cwd, "package.json"), '{ "name": "ada-shop" }\n');
    const again = await cli(["init"]);
    expect(again.status).toBe(0);
    expect(again.stdout).not.toContain("Produit existant");
    expect(await readFile(join(cwd, ".agentplugged", "method.yaml"), "utf8")).not.toContain(
      "origin",
    );
  });

  it("works in a folder without Git", async () => {
    await installed();
    await rm(join(cwd, ".git"), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    const next = await cli(["next", "--json"]);
    expect(next.stderr).toBe("");
    expect(JSON.parse(next.stdout)).toMatchObject({
      step: "framing",
      you: false,
      agent: "iris",
      agent_name: "Iris",
      tool: "claude-code",
      waiting: [],
      command: null,
    });
  });

  it("refuses --json elsewhere, arguments and --profile, saying why", async () => {
    await installed();
    const elsewhere = await cli(["sync", "--json"]);
    expect(elsewhere.status).toBe(1);
    expect(elsewhere.stderr).toContain(`${ERROR_PREFIX}sync: --json`);
    const extra = await cli(["next", "now"]);
    expect(extra.status).toBe(1);
    expect(extra.stderr).toContain(`${ERROR_PREFIX}now`);
    const profile = await cli(["next", "--profile", "maintenance"]);
    expect(profile.status).toBe(1);
    expect(profile.stderr).toContain(`${ERROR_PREFIX}--profile`);
    // With --json, the error is JSON on standard output.
    const json = await cli(["next", "now", "--json"]);
    expect(json.status).toBe(1);
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout)).toEqual({
      error: {
        code: "INVALID_ARGUMENTS",
        message_key: "error.invalid_arguments",
        details: { reason: "now" },
      },
    });
  });

  it("refuses a folder without the method, in text and JSON", async () => {
    const next = await cli(["next"]);
    expect(next.status).toBe(1);
    expect(next.stderr).toContain(
      "Erreur METHOD_NOT_INSTALLED : .agentplugged/method.yaml introuvable.",
    );
    const json = binary(["next", "--json"]);
    expect(json.status).toBe(1);
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout)).toMatchObject({
      error: { code: "METHOD_NOT_INSTALLED", message_key: "error.method_not_installed" },
    });
  });
});

describe("agents as the creator reads them", () => {
  it("names a developer on a story by the pair, and says a developer is retired", () => {
    const fr = createTranslator("fr");
    const en = createTranslator("en");
    expect(agentLabel(fr, "sam", "Sam", "4-2")).toBe("Sam · story 4-2");
    expect(agentLabel(en, "jade", "Jade", "4-3")).toBe("Jade · story 4-3");
    // Not a developer, or no story: the name alone.
    expect(agentLabel(en, "izzy", "Izzy", "4-2")).toBe("Izzy");
    expect(agentLabel(en, "sam", "Sam", null)).toBe("Sam");
    const retired = RETIRED_DEVELOPERS[0] ?? "";
    expect(agentLabel(fr, retired, "X", "1-1")).toBe("X (développeur retiré)");
    expect(agentLabel(en, retired, "X", null)).toBe("X (retired developer)");
  });
});

describe("next: text", () => {
  const t = createTranslator("fr");
  const base: NextResult = {
    step: "build",
    you: false,
    agent: "sam-2",
    agent_name: "Sam 2",
    tool: "codex",
    waiting: [],
    command: null,
    story: "2-3",
    checkpoint: null,
    sync: null,
    missing_tools: [],
    pending_keys: [],
    phase: null,
    phases: [],
    stray: [],
    sprint: null,
    deferred: null,
  };

  it("says a story is a small change in the fast track, or back in the full lane and why", () => {
    const en = createTranslator("en");
    const active = { status: "active", left_by: null, reasons: [] } as const;
    expect(formatNext(t, { ...base, fast_track: active })).toContain(
      "Voie rapide : un petit changement ; la revue et ta validation avant la fusion restent celles de la voie complète.",
    );
    expect(formatNext(en, { ...base, fast_track: active })).toContain(
      "Fast track: a small change; the review and your validation before the merge stay as in the full lane.",
    );
    const left = {
      status: "left",
      left_by: "engine",
      reasons: ["too_many_files", "dependency_manifest"],
    } as const;
    expect(formatNext(t, { ...base, fast_track: left })).toContain(
      "Retour à la voie complète après la voie rapide (5 fichiers ou plus sont touchés, un manifeste ou un fichier de verrouillage de dépendances est touché), renvoyée par le moteur.",
    );
    expect(formatNext(en, { ...base, fast_track: { ...left, left_by: "agent" } })).toContain(
      "Back in the full lane after the fast track (5 files or more are touched, a dependency manifest or lockfile is touched), sent back by its developer.",
    );
    // A story of the full lane says nothing of it.
    expect(formatNext(t, base)).not.toContain("voie rapide");
    expect(JSON.parse(nextJson({ ...base, fast_track: left })).fast_track).toEqual(left);
  });

  it("speaks of the strict level only at the strict level, and shows the chat path otherwise", () => {
    const en = createTranslator("en");
    const command = "npx agentplugged review G-AAAAAAAAAA";
    const step: NextResult = { ...base, you: true, checkpoint: "G-AAAAAAAAAA", command };
    // The chat: the engine's form or the creator's words quoted; never « au terminal » alone.
    const chat = formatNext(t, { ...step, answer: "chat" });
    expect(chat).toContain("dans le formulaire du moteur");
    expect(chat).toContain("l'agent cite ta réponse");
    expect(chat).not.toContain("strict");
    expect(formatNext(en, { ...step, answer: "chat" })).toContain("in the engine's form");
    // The terminal at the strict level: the sentence about the level.
    const strict = { ...step, answer: "terminal", answer_reason: "strict" } as const;
    expect(formatNext(t, strict)).toContain("Risque élevé au niveau strict : valide au terminal");
    expect(formatNext(en, strict)).toContain(
      "High risk at the strict level: validate at the terminal",
    );
    // The terminal has no other reason than the strict level (a session that read
    // external content is answered in the chat like any other).
    // The JSON gives the reason, and only when there is one.
    expect(JSON.parse(nextJson(strict)).answer_reason).toBe("strict");
    expect(JSON.parse(nextJson({ ...step, answer: "chat" }))).not.toHaveProperty("answer_reason");
  });

  it("shows the sprint in force after the waiting line, and gives it in JSON", () => {
    const sprint = { id: "S-7M2K9QX4TB", goal: "Sign-up", done: 1, total: 3 };
    expect(formatNext(t, { ...base, sprint })).toContain(
      "En attente de toi : rien\nSprint en cours : « Sign-up », 1 story terminée sur 3\n",
    );
    expect(formatNext(t, { ...base, sprint: { ...sprint, done: 2 } })).toContain(
      "2 stories terminées sur 3",
    );
    // Zero: singular in French, plural in English.
    expect(formatNext(t, { ...base, sprint: { ...sprint, done: 0 } })).toContain(
      "0 story terminée sur 3",
    );
    const en = createTranslator("en");
    expect(formatNext(en, { ...base, sprint: { ...sprint, done: 0 } })).toContain(
      "0 stories done out of 3",
    );
    expect(formatNext(en, { ...base, sprint })).toContain("1 story done out of 3");
    expect(JSON.parse(nextJson({ ...base, sprint })).sprint).toEqual(sprint);
    expect(JSON.parse(nextJson(base)).sprint).toBeNull();
  });

  it("names the deferred item that locks a story, and gives it in JSON", () => {
    const lock = {
      item: "D-7M2K9QX4TB",
      title: "Rate-limit \u001b[31m",
      story: "2-3",
      command: "npx agentplugged deferred list 2-3",
    };
    const locked: NextResult = {
      ...base,
      step: "deferred_work",
      deferred: lock,
      command: lock.command,
    };
    expect(formatNext(t, locked)).toBe(
      "Étape : Travail reporté à traiter d'abord, story 2-3\nAgent : Sam 2, appelle Sam 2 par son nom dans Codex\nEn attente de toi : rien\nStory 2-3 verrouillée par D-7M2K9QX4TB (« Rate-limit  [31m ») : npx agentplugged deferred list 2-3 (un point qui t'appartient, tu le fermes ou l'abandonnes aussi dans le chat)\nCommande : npx agentplugged deferred list 2-3\n",
    );
    // A free story proposed, the locked one on a second line.
    const free: NextResult = { ...base, story: "2-4", deferred: lock };
    expect(formatNext(t, free)).toContain(
      "Étape : Développement, story 2-4\nAgent : Sam 2, appelle Sam 2 par son nom dans Codex\nEn attente de toi : rien\nStory 2-3 verrouillée par D-7M2K9QX4TB",
    );
    expect(JSON.parse(nextJson(locked)).deferred).toEqual(lock);
    expect(JSON.parse(nextJson(base)).deferred).toBeNull();
  });

  it("shows no budget, no pause and no cost any more, in the text or in JSON", () => {
    expect(formatNext(t, base)).not.toMatch(/Budget|budget|Coût/);
    expect(formatNext(createTranslator("en"), base)).not.toMatch(/Budget|budget|Cost/);
    expect(JSON.parse(nextJson(base))).not.toHaveProperty("budgets");
  });

  it("names the agent in Codex, and calls it with a mention elsewhere", () => {
    expect(formatNext(t, base)).toBe(
      "Étape : Développement, story 2-3\nAgent : Sam 2, appelle Sam 2 par son nom dans Codex\nEn attente de toi : rien\n",
    );
    expect(formatNext(t, { ...base, tool: null })).toContain(
      "Agent : Sam 2 (aucun outil IA ciblé)",
    );
    expect(agentCall("cursor", "quentin")).toBe("@agent-quentin");
    expect(agentCall("antigravity", "quentin")).toBe("@agent-quentin");
    expect(agentCall("claude-code", "quentin")).toBe("/quentin");
  });

  it("shows the current phase before the step, and its end", () => {
    expect(formatNext(t, { ...base, phase: "build" })).toBe(
      "Phase : Réalisation · Étape : Développement, story 2-3\nAgent : Sam 2, appelle Sam 2 par son nom dans Codex\nEn attente de toi : rien\n",
    );
    const end = formatNext(t, {
      ...base,
      step: "phase_review",
      phase: "planning",
      you: true,
      agent: null,
      story: null,
      checkpoint: "G-AAAAAAAAAA",
      command: "npx agentplugged review G-AAAAAAAAAA",
    });
    expect(end).toContain(
      "Phase : Planification · Étape : Fin de phase en attente de ta validation\n",
    );
    expect(end).toContain("Commande : npx agentplugged review G-AAAAAAAAAA\n");
    const stray = [
      { checkpoint: "G-BBBBBBBBBB", phase: "design", reason: "open_not_current" },
    ] as const;
    expect(formatNext(t, { ...base, phase: "framing", stray })).toContain(
      "\nAttention : G-BBBBBBBBBB, la fin de Conception, est ouvert alors que la phase en cours est Cadrage : il ne ferme rien.\n",
    );
    expect(JSON.parse(nextJson({ ...base, stray })).stray).toEqual(stray);
    const phases = [{ id: "build", status: "in_progress" }] as const;
    const json = JSON.parse(nextJson({ ...base, phase: "build", phases }));
    expect(json).toMatchObject({ phase: "build", phases });
  });

  it("counts the checkpoints and cites the first one; JSON keeps the exact title", () => {
    const waiting = [
      { id: "G-AAAAAAAAAA", title: "Line\nbreak", type: "story", risk: "low" },
      { id: "G-BBBBBBBBBB", title: "Other", type: "decision", risk: "high" },
    ] as const;
    const text = formatNext(t, {
      ...base,
      step: "none",
      agent: null,
      agent_name: null,
      tool: null,
      story: null,
      waiting,
    });
    expect(text).toBe(
      "Étape : Rien à faire pour l'instant.\nAgent : aucun\nEn attente de toi : 2 points, d'abord G-AAAAAAAAAA « Line break »\n",
    );
    expect(JSON.parse(nextJson({ ...base, waiting })).waiting[0].title).toBe("Line\nbreak");
  });

  it("says why a sync is needed, and how many keys wait", () => {
    const yours = { ...base, you: true, agent: null, agent_name: null, tool: null, story: null };
    expect(formatNext(t, { ...yours, step: "sync", sync: "no_tool" })).toBe(
      "Étape : Synchronisation de la méthode (aucun outil IA ciblé : ajoute-en un dans `tools` de .agentplugged/method.yaml)\nAgent : toi\nEn attente de toi : rien\n",
    );
    expect(
      formatNext(t, {
        ...yours,
        step: "key_endorsement",
        pending_keys: ["human:aaa", "human:bbb"],
        command: "npx agentplugged key endorse",
      }),
    ).toContain("Étape : Approbation d'une clé de créateur (2 clés, d'abord human:aaa)");
  });
});
