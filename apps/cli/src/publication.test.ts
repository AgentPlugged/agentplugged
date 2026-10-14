import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { GitStateStore, NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import {
  AgentSession,
  type CheckpointState,
  type CommandContext,
  createCommandRegistry,
  initCommand,
  MemoryKeyStore,
  type NextResult,
  type PublicationShown,
  type RecordedEvent,
  resolveProfile,
  type ToolProbe,
} from "@agentplugged/core";
import { toBase64url } from "@agentplugged/crypto";
import { createTranslator } from "@agentplugged/i18n";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./main.js";
import { formatNext } from "./next-text.js";
import { formatPublicationExported, formatPublicationShown } from "./publication-text.js";
import { formatCard } from "./review-flow.js";

vi.setConfig({ testTimeout: 120_000 });

const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;
const SEED = toBase64url(new Uint8Array(32).fill(3));
const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const PAGE = ".agentplugged/docs/launch/pages/home.md";
const PAGE_TEXT = `---
id: home-page
kind: note
owner: julien
links: [EF-43]
---

# Ship your product without losing your evenings

AgentPlugged turns your idea into a product with a team of agents.
A tab:\tdone.
`;
const PRESENTATION = {
  angle: "Your evenings back",
  audience: "Solo creators",
  short_version: "A team builds your product. You validate each step.",
};

const saved: Record<string, string | undefined> = {};
let isolated: string;
let cwd: string;
let journal: GitStateStore;

function git(args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

beforeAll(async () => {
  isolated = await mkdtemp(join(tmpdir(), "agentplugged-publication-home-"));
  await writeFile(join(isolated, ".gitconfig"), "");
  const env = {
    GIT_CONFIG_GLOBAL: join(isolated, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: await realpath(tmpdir()),
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "agentplugged-publication-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Ada"]);
  git(["config", "user.email", "ada@example.com"]);
});

afterEach(async () => {
  journal?.close();
  await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** The product, the way the agents' server sees it: events written with a software key. */
async function product(): Promise<{
  call: (name: string, input: Record<string, unknown>) => Promise<unknown>;
  open: () => Promise<string>;
}> {
  const keys = new MemoryKeyStore(SEED);
  journal = new GitStateStore({
    cwd,
    keys,
    machineLockPath: join(isolated, "machine-key.lock"),
  });
  const methodDir = dirname(
    createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
  );
  const base: Omit<CommandContext, "actor"> = {
    files: new NodeWorkspaceFiles(cwd),
    tools: NO_TOOL,
    method: new NodeWorkspaceFiles(methodDir),
    engineVersion: VERSION,
    journal,
    keys,
  };
  const init = await initCommand.run(
    { ...base, actor: "human" },
    { profile: resolveProfile("launch-only") },
  );
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const session = new AgentSession(Date.now());
  session.noteClient("cursor");
  const agent: CommandContext = {
    ...base,
    actor: "agent",
    session,
    chat: { log: { messages: async () => [] }, hookInstalled: false },
  };
  const registry = createCommandRegistry();
  const call = async (name: string, input: Record<string, unknown>) => {
    const result = await registry.run(name, agent, input);
    if (!result.ok)
      throw new Error(`${name}: ${result.error.code} ${JSON.stringify(result.error.details)}`);
    return result.value;
  };
  const open = async () => {
    await writeFile(join(cwd, PAGE), PAGE_TEXT).catch(async () => {
      await new NodeWorkspaceFiles(cwd).writeText(PAGE, PAGE_TEXT);
    });
    const blob = git(["hash-object", "-w", PAGE]);
    const opened = (await call("open_checkpoint", {
      agent: "julien",
      type: "publication",
      risk: "medium",
      title: "Home page",
      summary: "The text of the home page.",
      documents: [{ path: PAGE, branch: "main", blob_sha: blob }],
      publication: PRESENTATION,
    })) as RecordedEvent;
    return opened.checkpoint as string;
  };
  return { call, open };
}

async function cli(args: string[], lang = "en") {
  let stdout = "";
  let stderr = "";
  const status = await main({
    argv: args,
    cwd,
    env: { PATH: process.env.PATH ?? "", AGENTPLUGGED_LANG: lang },
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

describe("publication, the full text", () => {
  it("prints the text alone on standard output, the presentation on standard error", async () => {
    const { open } = await product();
    const id = await open();
    const shown = await cli(["publication", id]);
    expect(shown.status).toBe(0);
    expect(shown.stderr).toContain(`Home page (${id}), waiting for your validation`);
    expect(shown.stderr).toContain("Angle: Your evenings back");
    expect(shown.stderr).toContain("Audience: Solo creators");
    expect(shown.stderr).toContain("Short version: A team builds your product.");
    expect(shown.stderr).toContain("Full text: 1 file(s)");
    // The text, without the method's header; a control character made a space.
    expect(shown.stdout).toBe(
      "# Ship your product without losing your evenings\n\nAgentPlugged turns your idea into a product with a team of agents.\nA tab:\tdone.\n",
    );
  });

  it("is the same in French, and keeps the presentation out of the text", async () => {
    const { open } = await product();
    const id = await open();
    const result = await cli(["publication", id.toLowerCase()], "fr");
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("Angle");
  });

  it("says what it cannot show", async () => {
    await product();
    const unknown = await cli(["publication", "G-0000000000"]);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("CHECKPOINT_NOT_FOUND");
    const none = await cli(["publication"]);
    expect(none.status).toBe(1);
    expect(none.stderr).toContain("publication <G-id>");
    const extra = await cli(["publication", "G-0000000000", "more"]);
    expect(extra.status).toBe(1);
    const other = await cli(["next", "--raw"]);
    expect(other.status).toBe(1);
    expect(other.stderr).toContain("--raw");
    const force = await cli(["next", "--force"]);
    expect(force.status).toBe(1);
  });

  it("exports only what the creator validated", async () => {
    const { open, call } = await product();
    const id = await open();
    const refused = await cli(["publication", "export", id]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("only a deliverable you approved");
    await call("answer_checkpoint", {
      agent: "julien",
      checkpoint: id,
      decision: "approved",
      quote: "Valide",
    });
    const unverified = await cli(["publication", "export", id]);
    expect(unverified.status).toBe(1);
    expect(unverified.stderr).toContain("without proof");
    const exported = await cli(["publication", "export", id, "--unverified"]);
    expect(exported.status).toBe(0);
    expect(exported.stdout).toContain(`.agentplugged/exports/${id}`);
    expect(exported.stdout).toContain("publishes, sends and pays nothing");
    const text = await readFile(
      join(cwd, `.agentplugged/exports/${id}/launch/pages/home.md`),
      "utf8",
    );
    expect(text.startsWith("# Ship your product")).toBe(true);
    const sheet = await readFile(join(cwd, `.agentplugged/exports/${id}.md`), "utf8");
    expect(sheet).toContain("Validated: approved");
    // A second export leaves everything as it is; a file edited by hand needs --force.
    expect((await cli(["publication", "export", id, "--unverified"])).status).toBe(0);
    await writeFile(join(cwd, `.agentplugged/exports/${id}/launch/pages/home.md`), "mine\n");
    const edited = await cli(["publication", "export", id, "--unverified"]);
    expect(edited.status).toBe(1);
    expect(edited.stderr).toContain("differs from the validated text");
    expect((await cli(["publication", "export", id, "--unverified", "--force"])).status).toBe(0);
    expect(shownText(await cli(["publication", id, "--raw"]))).toContain("owner: julien");
  });

  it("isolates one file with --file", async () => {
    const { open } = await product();
    const id = await open();
    const one = await cli(["publication", id, "--file", "launch/pages/home.md"]);
    expect(one.status).toBe(0);
    const missing = await cli(["publication", id, "--file", "nope.md"]);
    expect(missing.status).toBe(1);
  });
});

const shownText = (result: { stdout: string }) => result.stdout;

describe("the texts of a deliverable", () => {
  const fr = createTranslator("fr");
  const en = createTranslator("en");
  const checkpoint = {
    id: "G-7M2K9QX4TB",
    type: "publication",
    risk: "medium",
    irreversible: false,
    recipient_role: "product",
    confirmation: ["gesture_undo_10s"],
    title: "Home page",
    summary: "The text of the home page.",
    story: null,
    documents: [{ path: PAGE, branch: "main", blob_sha: "a".repeat(40) }],
    blocks: [],
    options: null,
    recommendation: null,
    criteria: null,
    source: null,
    status: "open",
    opened_by: "julien",
    opened_at: "2026-10-04T08:00:00.000Z",
    opened_event: "01K6KXJ5G0ED25519PAY10AD01",
    measures: {},
    verdict: null,
    resolution: null,
    supersedes: null,
    blocks_lifted: false,
    waived_ms: 0,
    request: null,
    untrusted: null,
    provenance: "trusted",
    publication: {
      angle: "Your evenings back\u001b[2J",
      audience: "Solo creators",
      short_version: "A team builds it.\nYou validate.‮evil",
    },
  } as unknown as CheckpointState;

  it("the card shows title, angle, audience and short version, then the command", () => {
    const card = formatCard(fr, checkpoint).split("\n");
    const at = [
      "Home page",
      "Angle : Your evenings back [2J",
      "Public visé : Solo creators",
      "Version courte (environ 15 secondes de lecture, telle que julien l'a écrite) :",
      "  │ A team builds it.",
      "  │ You validate. evil",
      "Texte complet (1 fichier(s)) : npx agentplugged publication G-7M2K9QX4TB",
    ].map((line) => card.indexOf(line));
    expect(
      at.every((index) => index >= 0),
      JSON.stringify(at),
    ).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(["\u001b", "\u202e"].some((char) => card.join("\n").includes(char))).toBe(false);
    expect(formatCard(en, checkpoint)).toContain("Short version (about 15 seconds of reading");
    // Opened: no presentation, the command all the same.
    const old = { ...checkpoint, publication: undefined } as unknown as CheckpointState;
    expect(formatCard(en, old)).toContain(
      "No presentation was recorded for this deliverable. Read its full text: npx agentplugged publication G-7M2K9QX4TB",
    );
    // Any other checkpoint shows none of it.
    const other = {
      ...checkpoint,
      type: "document",
      publication: undefined,
    } as unknown as CheckpointState;
    expect(formatCard(en, other)).not.toContain("publication G-");
  });

  it("the full text and its presentation", () => {
    const shown = {
      action: "show",
      checkpoint: "G-7M2K9QX4TB",
      title: "Home page",
      status: "resolved",
      decision: "changes_requested",
      assurance: "chat",
      opened_by: "julien",
      publication: { angle: "a", audience: "b", short_version: "c" },
      files: [
        { path: "p/one.md", blob: "a", text: "One\n\n\n", raw: "---\n---\nOne\n", words: 1 },
        { path: "p/two.md", blob: "b", text: "Two\x1b[0m\n", raw: "Two", words: 1 },
      ],
      total_files: 3,
      total_words: 9,
      raw: false,
    } satisfies PublicationShown;
    const output = formatPublicationShown(en, shown);
    expect(output.out).toBe("── p/one.md ──\n\nOne\n\n── p/two.md ──\n\nTwo [0m\n");
    expect(output.err).toContain("Home page (G-7M2K9QX4TB), sent back with an instruction");
    expect(output.err).toContain("Full text: 3 file(s), 9 words.");
    expect(output.err).toContain("Showing 2 of 3 files (--file).");
    expect(formatPublicationShown(fr, { ...shown, publication: null }).err).toContain(
      "Aucune présentation",
    );
  });

  it("the export says it publishes nothing", () => {
    const text = formatPublicationExported(fr, {
      action: "export",
      checkpoint: "G-7M2K9QX4TB",
      title: "Home page",
      directory: ".agentplugged/exports/G-7M2K9QX4TB",
      files: [{ path: "x/y.md", source: "z", blob: "a", status: "written" }],
      sheet: "x/PUBLICATION.md",
      decision: "approved_with_reservations",
      reservations: "Soften it",
    });
    expect(text).toContain("Home page est prêt à publier : 1 fichier(s)");
    expect(text).toContain("écrit : x/y.md");
    expect(text).toContain("Tes réserves : Soften it");
    expect(text).toContain("ne publie, n'envoie et ne paie rien");
  });

  it("next hands the instruction back to the agent, or says the agent is not active", () => {
    const base: NextResult = {
      step: "changes_requested",
      you: false,
      agent: "julien",
      agent_name: "Julien",
      tool: "claude-code",
      waiting: [],
      command: "npx agentplugged history",
      story: null,
      checkpoint: "G-7M2K9QX4TB",
      sync: null,
      missing_tools: [],
      pending_keys: [],
      phase: null,
      phases: [],
      stray: [],
      sprint: null,
      deferred: null,
      publication_feedback: {
        checkpoint: "G-7M2K9QX4TB",
        title: "Home page",
        agent: "julien",
        note: "Shorter\u001b[2J",
        agent_inactive: false,
      },
    };
    const text = formatNext(fr, base);
    expect(text).toContain(
      "Tu as renvoyé le livrable G-7M2K9QX4TB (Home page) : demande à Julien de le reprendre avec ta consigne",
    );
    expect(text).toContain("Ta consigne : Shorter [2J");
    const inactive = formatNext(en, {
      ...base,
      you: true,
      agent: null,
      agent_name: null,
      publication_feedback: {
        checkpoint: "G-7M2K9QX4TB",
        title: "Home page",
        agent: "julien",
        note: null,
        agent_inactive: true,
      },
    });
    expect(inactive).toContain("julien, who produced the deliverable G-7M2K9QX4TB (Home page)");
    expect(inactive).toContain("is not active: enable them first");
  });
});
