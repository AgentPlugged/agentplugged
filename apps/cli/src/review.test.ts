import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { GitStateStore, NodeKeyStore, NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import { removeTestKeys } from "@agentplugged/adapters-git/test-keychain";
import {
  type CheckpointState,
  type CommandContext,
  createCommandRegistry,
  type RecordedEvent,
} from "@agentplugged/core";
import { SoftwareAuthenticator } from "@agentplugged/crypto/webauthn-software";
import { createTranslator } from "@agentplugged/i18n";
import { Client } from "@modelcontextprotocol/client";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./__helpers__/legacy-calls.js";
import { main } from "./main.js";
import { formatCard, typeLabel } from "./review-flow.js";

vi.setConfig({ testTimeout: 120_000 });

const bin = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/bin.js");
/** A keychain service of this file only, deleted after each test: never the real entries. */
const service = `agentplugged-test-review-${process.pid}-${Date.now()}`;
const UNDO_MS = 300;
/** The built binary's version: the engine `init` pins, so that `mcp` runs on this product. */
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
  cwd = await mkdtemp(join(tmpdir(), "agentplugged-review-"));
  home = await mkdtemp(join(tmpdir(), "agentplugged-review-home-"));
  await writeFile(join(home, ".gitconfig"), "");
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(home|userprofile)$/i.test(key)) inherited[key] = value;
  }
  env = {
    ...inherited,
    HOME: home,
    USERPROFILE: home,
    AGENTPLUGGED_LANG: "en",
    // The engine asks the npm registry for its latest version: never the real one here.
    npm_config_registry: "http://127.0.0.1:9/",
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
  if (cwd !== undefined)
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  if (home !== undefined)
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** Runs the CLI in process, as if the creator typed `answers` in a terminal. */
async function cli(
  args: string[],
  options: {
    answers?: string[];
    interactive?: boolean;
    lang?: string;
    presence?: SoftwareAuthenticator;
  } = {},
) {
  let stdout = "";
  let stderr = "";
  const answers = options.answers ?? [];
  const status = await main({
    argv: args,
    cwd,
    env: { ...env, PATH: process.env.PATH ?? "", AGENTPLUGGED_LANG: options.lang ?? "en" },
    engineVersion: VERSION,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    stdin: Readable.from(answers.length === 0 ? [] : [answers.map((a) => `${a}\n`).join("")]),
    interactive: options.interactive ?? true,
    undoMs: UNDO_MS,
    ...(options.presence === undefined ? {} : { presence: options.presence }),
  });
  return { status, stdout, stderr };
}

/** The agents' side, in process: opens checkpoints and reports measures as `iris`. */
function agent() {
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
  const registry = createCommandRegistry();
  return {
    async call(name: string, input: Record<string, unknown>) {
      return registry.run(name, context, input);
    },
    async open(input: Record<string, unknown>): Promise<string> {
      const result = await registry.run("open_checkpoint", context, { agent: "iris", ...input });
      if (!result.ok) throw new Error(`open_checkpoint: ${result.error.code}`);
      return (result.value as RecordedEvent).checkpoint as string;
    },
    close: () => journal.close(),
  };
}

async function installed() {
  const init = await cli(["init", "--profile", "new-product"], { interactive: false });
  expect(init.status).toBe(0);
  return init;
}

const STORY = {
  type: "story",
  risk: "low",
  title: "Story 2-6 done",
  summary: "Review the work on 2-6.",
  story: "2-6",
  blocks: [{ action: "story.review", story: "2-6" }],
};

/** The MCP server as an AI tool starts it, and an MCP client on its stdio. */
async function connect(): Promise<{ child: ChildProcess; client: Client }> {
  const child = spawn(process.execPath, [bin, "mcp"], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  if (child.stdout === null || child.stdin === null) throw new Error("no pipes");
  await client.connect(new StdioServerTransport(child.stdout, child.stdin));
  return { child, client };
}

function stop(child: ChildProcess): Promise<number | null> {
  return new Promise((done) => {
    child.once("exit", (code) => done(code));
    child.stdin?.end();
  });
}

describe("review: acceptance", () => {
  it("an agent opens a checkpoint over MCP; review approves it; the blocked action is allowed", async () => {
    await installed();
    const { child, client } = await connect();
    try {
      const opened = (await client.callTool({
        name: "open_checkpoint",
        arguments: { agent: "iris", ...STORY },
      })) as { structuredContent?: { checkpoint?: string } };
      const id = opened.structuredContent?.checkpoint as string;
      expect(id).toMatch(/^G-/);
      const refused = (await client.callTool({
        name: "update_story",
        arguments: { agent: "iris", story: "2-6", status: "in_review" },
      })) as { isError?: boolean; content: Array<{ text?: string }> };
      expect(refused.isError).toBe(true);
      expect(refused.content[0]?.text).toContain("CHECKPOINT_OPEN");

      // The creator: checkpoint 1, « Approve », Enter, then the undo window runs out.
      const review = await cli(["review"], { answers: ["1", "1", ""] });
      expect(review.stderr).toBe("");
      expect(review.status).toBe(0);
      expect(review.stdout).toContain(`${id} · story · low risk · for tech lead`);
      expect(review.stdout).toContain("Tests, QA, security: not measured");
      expect(review.stdout).toContain("Written in 1 s: press a to undo.");
      expect(review.stdout).toContain(
        `Recorded: approved on ${id}, assurance locale (the key in this machine's keychain).`,
      );

      const allowed = (await client.callTool({
        name: "update_story",
        arguments: { agent: "iris", story: "2-6", status: "in_review" },
      })) as { isError?: boolean };
      expect(allowed.isError).toBeFalsy();
    } finally {
      await client.close().catch(() => {});
      await stop(child);
    }
    const status = await cli(["journal", "status"], { interactive: false });
    expect(status.stdout).toMatch(
      /\nValidations \(1\):\n {2}G-\w{10}: approved, assurance locale \(the key in this machine's keychain\), by human:/,
    );
    expect(status.stdout).not.toContain("Events ignored");
  });
});

describe("review", () => {
  it("lists nothing when no checkpoint is open", async () => {
    await installed();
    const review = await cli(["review"]);
    expect(review.stdout).toBe("No open checkpoint: nothing to answer.\n");
  });

  it("a during the 10 s window undoes: nothing is written", async () => {
    await installed();
    const agents = agent();
    try {
      const id = await agents.open(STORY);
      const head = git(["rev-parse", "agentplugged/journal"]);
      const review = await cli(["review", id], { answers: ["1", "", "a"] });
      expect(review.stdout).toContain("Undone: nothing was written.");
      expect(git(["rev-parse", "agentplugged/journal"])).toBe(head);
    } finally {
      agents.close();
    }
  });

  it("irreversible: nothing to type again, the Enter and the undo window are the gesture", async () => {
    await installed();
    const agents = agent();
    try {
      const id = await agents.open({ ...STORY, type: "release", irreversible: true });
      const head = git(["rev-parse", "agentplugged/journal"]);
      const typed = await cli(["review", id], { answers: ["1", "yes"], lang: "fr" });
      expect(typed.stdout).not.toContain("Retape");
      expect(typed.stdout).not.toContain("je confirme");
      expect(git(["rev-parse", "agentplugged/journal"])).toBe(head);

      const right = await cli(["review", id], { answers: ["1", ""], lang: "fr" });
      expect(right.stdout).toContain(`Enregistré : validé sur ${id}, assurance locale`);
    } finally {
      agents.close();
    }
  });

  it("high risk with Windows Hello: what is signed and its fingerprint, then presence", async () => {
    await installed();
    const presence = new SoftwareAuthenticator();
    const linked = await cli(["key", "presence"], { presence });
    expect(linked.stderr).toBe("");
    expect(linked.stdout).toContain("Fingerprint: ");
    expect(linked.stdout).toContain("Windows Hello now protects your validations in this product");
    const agents = agent();
    try {
      const id = await agents.open({ ...STORY, risk: "high" });
      const review = await cli(["review", id], { answers: ["1"], presence });
      expect(review.stderr).toBe("");
      expect(review.stdout).toContain("This checkpoint asks for your presence: Windows Hello");
      const fingerprint = /Fingerprint: (\S{8})\n/.exec(
        review.stdout.slice(review.stdout.indexOf(`You sign: approved on checkpoint ${id}`)),
      )?.[1];
      expect(fingerprint).toBeDefined();
      expect(presence.calls.at(-1)?.challenge?.startsWith(fingerprint as string)).toBe(true);
      expect(review.stdout).toContain(
        `Recorded: approved on ${id}, assurance presence (Windows Hello).`,
      );
      // A failed assertion writes nothing.
      const other = await agents.open({ ...STORY, risk: "high", title: "Second" });
      presence.fail = true;
      const head = git(["rev-parse", "agentplugged/journal"]);
      const failed = await cli(["review", other], { answers: ["1"], presence });
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain("Windows Hello did not verify you");
      expect(git(["rev-parse", "agentplugged/journal"])).toBe(head);
    } finally {
      agents.close();
    }
  });

  it("high risk without Windows Hello: accepted in locale, with a warning", async () => {
    await installed();
    const agents = agent();
    try {
      const id = await agents.open({ ...STORY, risk: "high" });
      const review = await cli(["review", id], { answers: ["1", ""] });
      expect(review.stdout).toContain("Windows Hello is turned off for this process");
      expect(review.stdout).toContain(`Recorded: approved on ${id}, assurance locale`);
      expect(review.stdout).toContain(
        "Warning: a high-risk checkpoint answered with the locale assurance only.",
      );
      const status = await cli(["journal", "status"], { interactive: false });
      expect(status.stdout).toContain(`Checkpoint ${id}: high risk answered with the locale`);
    } finally {
      agents.close();
    }
  });

  it("waiver: refused on a security checkpoint; 30 days at most; written with its deadline", async () => {
    await installed();
    const agents = agent();
    const criteria = [
      { id: "tests", metric: "tests_failed", op: "<=", threshold: 0, severity: "blocking" },
    ];
    try {
      const security = await agents.open({ ...STORY, criteria, recipient_role: "security" });
      await agents.call("report_measures", {
        agent: "iris",
        checkpoint: security,
        measures: { tests_failed: 3 },
      });
      // Actions: 1-4, 5 waive, 6 quit.
      const refused = await cli(["review", security], { answers: ["5", "6"] });
      expect(refused.stdout).toContain("tests_failed at most 0 (blocking): 3, not met");
      expect(refused.stdout).toContain("A waiver is refused on a security checkpoint");
      expect(refused.stdout).toContain("Nothing was written.");

      const story = await agents.open({ ...STORY, criteria, title: "Waivable" });
      await agents.call("report_measures", {
        agent: "iris",
        checkpoint: story,
        measures: { tests_failed: 1 },
      });
      const waived = await cli(["review", story], { answers: ["5", "45", "7", ""] });
      expect(waived.stdout).toContain("A waiver lasts 30 days at most.");
      expect(waived.stdout).toContain(`Recorded: waived on ${story}, assurance locale`);
    } finally {
      agents.close();
    }
  });

  it("decision: one action per option, the recommended one marked", async () => {
    await installed();
    const agents = agent();
    try {
      const id = await agents.open({
        ...STORY,
        type: "decision",
        options: [
          { id: "stripe", label: "Stripe", consequence: "Fast to ship." },
          { id: "paddle", label: "Paddle", consequence: "Handles VAT." },
        ],
        recommendation: "paddle",
      });
      const review = await cli(["review", id], { answers: ["6", ""] });
      expect(review.stdout).toContain("  6. Choose: Paddle (recommended)\n");
      expect(review.stdout).toContain(`Recorded: option chosen on ${id}`);
    } finally {
      agents.close();
    }
  });

  it("refuses without an interactive terminal, before anything", async () => {
    await installed();
    const agents = agent();
    try {
      await agents.open(STORY);
      const head = git(["rev-parse", "agentplugged/journal"]);
      for (const args of [["review"], ["key", "presence"]]) {
        const result = await cli(args, { interactive: false });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Error REVIEW_NOT_INTERACTIVE:");
      }
      expect(git(["rev-parse", "agentplugged/journal"])).toBe(head);
    } finally {
      agents.close();
    }
  });

  it("init proposes Windows Hello at a terminal, and links it", async () => {
    const presence = new SoftwareAuthenticator();
    const init = await cli(["init", "--profile", "new-product"], {
      answers: [""],
      presence,
      lang: "fr",
    });
    expect(init.stderr).toBe("");
    expect(init.stdout).toContain("Ta clé de validation a été créée (human:");
    expect(init.stdout).toContain("Elle est publiée dans le journal de ce produit.");
    expect(init.stdout).toContain("Protéger tes validations avec Windows Hello ? (O/n) ");
    expect(init.stdout).toContain("Windows Hello protège désormais tes validations");
    expect(presence.calls.map((call) => call.kind)).toEqual(["create", "assert"]);
  });
});

describe("review and key: arguments, ids, reset, Hello errors", () => {
  it("refuses extra arguments to key presence", async () => {
    await installed();
    const result = await cli(["key", "presence", "now"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Error INVALID_ARGUMENTS:");
    const reset = await cli(["review", "--reset"]);
    expect(reset.stderr).toContain("Error INVALID_ARGUMENTS:");
  });

  it("matches a checkpoint id typed in lowercase, and reminds to sync with a remote", async () => {
    await installed();
    git(["remote", "add", "origin", join(home, "remote.git")]);
    const agents = agent();
    try {
      const id = await agents.open(STORY);
      const review = await cli(["review", id.toLowerCase()], { answers: ["1", ""] });
      expect(review.stderr).toBe("");
      expect(review.stdout).toContain("This journal has a remote (origin)");
      expect(review.stdout).toContain(`Recorded: approved on ${id}`);
    } finally {
      agents.close();
    }
  });

  it("key presence --reset creates the credential again and links it", async () => {
    await installed();
    const presence = new SoftwareAuthenticator();
    expect((await cli(["key", "presence"], { presence })).status).toBe(0);
    const reset = await cli(["key", "presence", "--reset"], { presence });
    expect(reset.stderr).toBe("");
    expect(reset.stdout).toContain("Windows Hello now protects your validations");
    expect(presence.calls.map((call) => call.kind)).toEqual([
      "create",
      "assert",
      "create",
      "assert",
    ]);
  });

  it("init does not fail when Windows Hello throws", async () => {
    const broken = {
      availability: async () => {
        throw new Error("IsUVPAA failed");
      },
      create: async () => {
        throw new Error("no");
      },
      assert: async () => {
        throw new Error("no");
      },
    } as unknown as SoftwareAuthenticator;
    const init = await cli(["init", "--profile", "new-product"], {
      answers: [""],
      presence: broken,
    });
    expect(init.status).toBe(0);
    expect(init.stdout).toContain("Windows Hello cannot be used (IsUVPAA failed)");
    const failing = new SoftwareAuthenticator({ fail: true });
    const again = await cli(["init"], { answers: [""], presence: failing });
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("Your validations keep the locale assurance.");
  });
});

describe("formatCard", () => {
  it("shows the card of a decision", () => {
    const checkpoint = {
      id: "G-7M2K9QX4TB",
      type: "decision",
      risk: "medium",
      irreversible: false,
      recipient_role: "product",
      confirmation: ["gesture_undo_10s"],
      title: "Payment provider",
      summary: "Which provider do we launch with?",
      story: "2-6",
      documents: [{ path: "docs/payments.md", branch: "main", blob_sha: "a".repeat(40) }],
      blocks: [{ action: "story.review", story: "2-6" }],
      options: [
        { id: "a", label: "Stripe", consequence: "Fast." },
        { id: "b", label: "Paddle", consequence: "VAT." },
      ],
      recommendation: "b",
      criteria: null,
      source: null,
      status: "open",
      opened_by: "iris",
      opened_at: "2026-10-03T08:00:00.000Z",
      opened_event: "01K6KXJ5G0ED25519PAY10AD01",
      measures: {},
      verdict: null,
      resolution: null,
      supersedes: null,
      phase: null,
      blocks_lifted: false,
      waived_ms: 0,
      request: null,
      untrusted: null,
      provenance: "untrusted",
    } as CheckpointState;
    expect(formatCard(createTranslator("fr"), checkpoint)).toBe(
      [
        "G-7M2K9QX4TB · décision · risque moyen · pour produit",
        "Payment provider",
        "",
        "  Which provider do we launch with?",
        "",
        "Ce qui change :",
        "  docs/payments.md (branche main)",
        "Risques : risque moyen, réversible",
        "Tests, QA, sécurité : non mesuré",
        "Options :",
        "  Stripe : Fast.",
        "  Paddle : VAT. (recommandée)",
        "Bloqué jusqu'à ta réponse :",
        "  le passage de la story en revue (story 2-6)",
        "Confirmation demandée : un geste que tu peux annuler pendant 10 secondes",
        "",
      ].join("\n"),
    );
  });

  it("shows one discreet provenance line for a checkpoint an untrusted session opened, nothing waits on it", () => {
    const base = {
      id: "G-7M2K9QX4TB",
      type: "release",
      risk: "high",
      irreversible: false,
      recipient_role: "security",
      confirmation: ["presence"],
      title: "Release",
      summary: "…",
      story: null,
      documents: [],
      blocks: [],
      options: null,
      recommendation: null,
      criteria: null,
      source: null,
      status: "open",
      opened_by: "sam",
      opened_at: "2026-10-03T08:00:00.000Z",
      opened_event: "01K6KXJ5G0ED25519PAY10AD01",
      measures: {},
      verdict: null,
      resolution: null,
      supersedes: null,
      blocks_lifted: false,
      waived_ms: 0,
      request: null,
      untrusted: { reads: [{ tool: "WebFetch", source: "evil.example" }] },
      provenance: "untrusted",
    } as unknown as CheckpointState;
    const head = (checkpoint: CheckpointState) =>
      formatCard(createTranslator("fr"), checkpoint).split("\n").slice(0, 3);
    expect(head(base)).toEqual([
      "Provenance : ouvert par une session qui avait lu un contenu extérieur (une trace pour l'historique, rien n'attend après elle).",
      "",
      "G-7M2K9QX4TB · mise en production · risque élevé · pour sécurité",
    ]);
    // A checkpoint without the mark (every one written) shows no such line.
    const plain = { ...base, untrusted: null } as unknown as CheckpointState;
    expect(head(plain)[0]).toBe("G-7M2K9QX4TB · mise en production · risque élevé · pour sécurité");
  });

  it("names the phase an end of phase closes", () => {
    const end = { type: "phase_end", phase: "planning" } as const;
    expect(typeLabel(createTranslator("fr"), end)).toBe("fin de phase (Planification)");
    expect(typeLabel(createTranslator("en"), end)).toBe("end of phase (Planning)");
    expect(typeLabel(createTranslator("fr"), { type: "story" })).toBe("story");
  });
});
