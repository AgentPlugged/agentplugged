import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GitStateStore, NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import {
  type CommandContext,
  createCommandRegistry,
  DECISION_HOOK_PATH,
  type DecisionLog,
  type DecisionRecord,
  initCommand,
  MemoryKeyStore,
  questionsDigest,
  resolveProfile,
  screenProblem,
  syncCommand,
  type ToolProbe,
} from "@agentplugged/core";
import { toBase64url } from "@agentplugged/crypto";
import { createTranslator } from "@agentplugged/i18n";
import type { DecisionPrompt, StackPrompt } from "@agentplugged/protocol";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./__helpers__/legacy-calls.js";
import { runAgentServer } from "./index.js";
import { renderQuestions, renderStackScreens } from "./question-tool.js";

vi.setConfig({ testTimeout: 120_000 });

const SEED = toBase64url(new Uint8Array(32).fill(9));
const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};
const SESSION = "7d2e-mcp-session";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
};

/** The hook's store, in memory: the records the creator's clicks would leave. */
class FakeDecisionLog implements DecisionLog {
  readonly list: DecisionRecord[] = [];
  async records(session: string): Promise<readonly DecisionRecord[]> {
    return this.list.filter((record) => record.session === session);
  }
}

const saved: Record<string, string | undefined> = {};
let isolated: string;
let cwd: string;
let journal: GitStateStore;
let context: Omit<CommandContext, "actor">;
let decisions: FakeDecisionLog;
const servers: Promise<void>[] = [];
const clients: Client[] = [];

beforeAll(async () => {
  isolated = await mkdtemp(join(tmpdir(), "agentplugged-qtool-gitconfig-"));
  const global = join(isolated, "gitconfig");
  await writeFile(global, "");
  const env = {
    GIT_CONFIG_GLOBAL: global,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: await realpath(tmpdir()),
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(isolated, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

beforeEach(async () => {
  cwd = await realpath(await mkdtemp(join(tmpdir(), "agentplugged-qtool-")));
  git(cwd, ["init", "-q", "-b", "main"]);
  git(cwd, ["config", "user.name", "Ada"]);
  git(cwd, ["config", "user.email", "ada@example.com"]);
  const files = new NodeWorkspaceFiles(cwd);
  const methodDir = dirname(
    createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
  );
  const keys = new MemoryKeyStore(SEED);
  journal = new GitStateStore({ cwd, keys, machineLockPath: join(isolated, "machine-key.lock") });
  decisions = new FakeDecisionLog();
  context = {
    files,
    tools: NO_TOOL,
    method: new NodeWorkspaceFiles(methodDir),
    engineVersion: "1.0.0",
    journal,
    keys,
    // The hook's store, as the server of a Claude Code session reads it.
    chat: { decisions, project: cwd, hooked: true, hookInstalled: true },
  };
  const init = await initCommand.run(
    { ...context, actor: "human" },
    { profile: resolveProfile("new-product") },
  );
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  // The project holds the hook that records the creator's answers: `sync` writes its script and
  // its handlers (Claude Code is targeted), and the engine checks both.
  const synced = await syncCommand.run({ ...context, actor: "human" }, {});
  if (!synced.ok) throw new Error(`sync failed: ${synced.error.code}`);
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await Promise.all(servers.splice(0));
  journal.close();
  await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/**
 * A client of the server. `form`: how it answers the MCP form (`undefined`: it announces none);
 * the extension of VS Code refuses it at once (`decline`), the terminal shows it.
 */
async function connect(
  name: string,
  options: {
    form?: "decline" | "accept";
    locale?: "en" | "fr";
    modern?: boolean;
    entrypoint?: string;
    questionToolHooked?: () => Promise<boolean>;
  } = {},
) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const forms: unknown[] = [];
  servers.push(
    runAgentServer({
      registry: createCommandRegistry(),
      context,
      engineVersion: "1.0.0",
      errorText: (error) => `message of ${error.message_key}`,
      transport: serverSide,
      formText: createTranslator(options.locale ?? "fr"),
      ...(options.entrypoint === undefined ? {} : { entrypoint: options.entrypoint }),
      ...(options.questionToolHooked === undefined
        ? {}
        : { questionToolHooked: options.questionToolHooked }),
    }),
  );
  const client = new Client(
    { name, version: "2.1.289" },
    {
      ...(options.form === undefined ? {} : { capabilities: { elicitation: { form: {} } } }),
      ...(options.modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {}),
    },
  );
  if (options.form !== undefined) {
    client.setRequestHandler("elicitation/create", async (request) => {
      forms.push(request.params);
      return (
        options.form === "decline"
          ? { action: "decline" }
          : { action: "accept", content: { choice: "option-2" } }
      ) as never;
    });
  }
  await client.connect(clientSide);
  clients.push(client);
  const call = (tool: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name: tool, arguments: args }) as Promise<ToolResult>;
  return { client, call, forms };
}

const DECISION = {
  agent: "iris",
  type: "decision",
  risk: "medium",
  title: "Pick a name",
  summary: "Which name do we ship?",
  options: [
    { id: "a", label: "Aurora", consequence: "Short and free." },
    { id: "b", label: "Beacon", consequence: "Taken in two countries." },
  ],
  recommendation: "b",
};

type Question = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
};

/**
 * The creator's click: what the hook of the tool would record for these questions. A moment after
 * the engine dictated them, never in the future of the call that reads it.
 */
async function click(
  dictation: { fingerprint: string; questions: Question[] },
  answers: readonly string[],
) {
  await new Promise((resolve) => setTimeout(resolve, 5));
  decisions.list.push({
    session: SESSION,
    project: cwd,
    at: new Date().toISOString(),
    fingerprint: dictation.fingerprint,
    answers: dictation.questions.map((question, index) => ({
      question: question.question,
      answer: answers[index] ?? "",
    })),
  });
}

describe("the question tool over MCP: the VS Code extension's case", () => {
  it("dictates the questions when the client refuses the form at once, in the creator's language", async () => {
    const { call, forms } = await connect("claude-code", { form: "decline" });
    const opened = await call("open_checkpoint", DECISION);
    const id = opened.structuredContent?.checkpoint as string;
    // Before any form: the client announced forms, none was tried, the question tool is there.
    const before = await call("get_state", { full: true });
    expect(before.structuredContent).toMatchObject({
      validation: {
        elicitation: true,
        channels: {
          available: ["elicitation", "question_tool", "chat"],
          elicitation: "untested",
          question_tool: "available",
        },
      },
    });
    const asked = await call("ask_creator", { agent: "iris", checkpoint: id });
    expect(asked.isError).toBeFalsy();
    // One attempt at the form, refused at once; the questions come back instead of a failure.
    expect(forms).toHaveLength(1);
    const result = asked.structuredContent as unknown as {
      channel: string;
      via: string;
      reason: string;
      tool: string;
      fingerprint: string;
      questions: Question[];
    };
    expect(result).toMatchObject({
      channel: "question_tool",
      via: "question_tool",
      reason: "declined",
      tool: "AskUserQuestion",
      asked: false,
      answered: false,
    });
    expect(result.fingerprint).toBe(questionsDigest(result.questions));
    const [first] = result.questions;
    expect(first?.header).toBe(id);
    // The recommendation first, marked as the tool does; the others in order, then the changes.
    expect(first?.options.map((option) => option.label)).toEqual([
      "Beacon (Recommandé)",
      "Aurora",
      "Aucune de ces options",
    ]);
    expect(first?.options[0]?.description).toBe("Taken in two countries.");
    expect(first?.question).toContain("AgentPlugged te demande ta décision.");
    expect(first?.question).toContain(`Point ${id}, ouvert par iris, risque : moyen.`);
    expect(first?.question).toContain("> Pick a name");
    // The engine remembers what the client did, and the next call does not try the form again.
    const after = await call("get_state", { full: true });
    expect(after.structuredContent).toMatchObject({
      validation: {
        elicitation: false,
        channels: { available: ["question_tool", "chat"], elicitation: "declined_by_client" },
      },
    });
    const second = await call("open_checkpoint", { ...DECISION, title: "Pick a tagline" });
    const again = await call("ask_creator", {
      agent: "iris",
      checkpoint: second.structuredContent?.checkpoint as string,
    });
    expect(again.structuredContent).toMatchObject({ channel: "question_tool" });
    expect(forms).toHaveLength(1);
    // Nothing is recorded until the creator answered.
    expect((await journal.list()).events.some((e) => e.type === "checkpoint.elicited")).toBe(false);
  });

  it("records the creator's click from the hook's record, and never from the agent", async () => {
    const { call } = await connect("claude-code", { form: "decline" });
    const id = (await call("open_checkpoint", DECISION)).structuredContent?.checkpoint as string;
    const dictation = (await call("ask_creator", { agent: "iris", checkpoint: id }))
      .structuredContent as unknown as { fingerprint: string; questions: Question[] };
    // The agent cannot pass the choice: the schema refuses it.
    const forged = await call("answer_checkpoint", {
      agent: "iris",
      checkpoint: id,
      via: "question_tool",
      decision: "option_chosen",
      option: "a",
      session: SESSION,
    });
    expect(forged.isError).toBe(true);
    // Nothing recorded by the hook yet: nothing counts.
    const none = await call("answer_checkpoint", {
      agent: "iris",
      checkpoint: id,
      via: "question_tool",
      session: SESSION,
    });
    expect(none.isError).toBe(true);
    expect(none.structuredContent).toMatchObject({ code: "CHAT_QUOTE_NOT_FOUND" });
    expect(none.content?.[0]?.text).toContain("no_answer");
    await click(dictation, ["Aurora"]);
    const answered = await call("answer_checkpoint", {
      agent: "iris",
      checkpoint: id,
      via: "question_tool",
      session: SESSION,
    });
    expect(answered.isError).toBeFalsy();
    expect(answered.structuredContent).toMatchObject({
      answered: true,
      channel: "question_tool",
      decision: "option_chosen",
      option: "a",
      tool: "claude-code",
    });
    const event = (await journal.list()).events.at(-1);
    expect(event?.type).toBe("checkpoint.elicited");
    expect(event?.payload).toMatchObject({
      via: "question_tool",
      source: "elicitation",
      option: "a",
      proof: { question: { digest: dictation.fingerprint } },
    });
    const state = await call("get_state", { full: true });
    expect(state.structuredContent).toMatchObject({
      checkpoints: {
        [id]: {
          status: "resolved",
          resolution: { source: "elicitation", assurance: "elicitation", via: "question_tool" },
        },
      },
    });
  });

  it("asks a high risk in one question: the action is named in it, one click answers", async () => {
    const { call } = await connect("claude-code", { form: "decline" });
    const id = (await call("open_checkpoint", { ...DECISION, risk: "high", irreversible: true }))
      .structuredContent?.checkpoint as string;
    const dictation = (await call("ask_creator", { agent: "iris", checkpoint: id }))
      .structuredContent as unknown as { fingerprint: string; questions: Question[] };
    expect(dictation.questions).toHaveLength(1);
    expect(dictation.questions[0]?.question).toContain("irréversible");
    expect(dictation.questions[0]?.question).toContain("Pick a name");
    await click(dictation, ["Beacon (Recommandé)"]);
    const answered = await call("answer_checkpoint", {
      agent: "iris",
      checkpoint: id,
      via: "question_tool",
      session: SESSION,
    });
    expect(answered.structuredContent).toMatchObject({
      answered: true,
      decision: "option_chosen",
    });
    const event = (await journal.list()).events.at(-1);
    expect(event?.payload).toMatchObject({ via: "question_tool" });
    expect(event?.payload).not.toHaveProperty("confirmed");
  });

  it("dictates at once to a client that shows no form, and splits a long stack in screens", async () => {
    const { call } = await connect("claude-code");
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const opened = await call("open_checkpoint", {
        agent: "iris",
        type: "document",
        risk: "low",
        title: `Epic ${i}`,
        summary: "Read it, then approve it.",
      });
      ids.push(opened.structuredContent?.checkpoint as string);
    }
    const state = await call("get_state", { full: true });
    expect(state.structuredContent).toMatchObject({
      validation: {
        channels: {
          available: ["question_tool", "chat"],
          elicitation: "unavailable",
          question_tool: "available",
        },
      },
    });
    const stack = (await call("open_stack", { agent: "iris", checkpoints: ids })).structuredContent
      ?.stack as string;
    const asked = (await call("ask_stack", { agent: "iris", stack }))
      .structuredContent as unknown as {
      channel: string;
      screens: { fingerprint: string; questions: Question[] }[];
    };
    expect(asked.channel).toBe("question_tool");
    expect(asked.screens.map((screen) => screen.questions.length)).toEqual([4, 1]);
    expect(asked.screens[0]?.questions[0]).toMatchObject({
      header: "Point 1",
      options: [{ label: "Approuver" }, { label: "Pas maintenant" }],
    });
    expect(asked.screens[0]?.questions[0]?.question).toContain(
      `Pile ${stack}, point 1 (${ids[0]})`,
    );
    await click(asked.screens[0] as never, [
      "Approuver",
      "Pas maintenant",
      "Approuver",
      "Approuver",
    ]);
    await click(asked.screens[1] as never, ["Approuver"]);
    const answered = await call("answer_stack", {
      agent: "iris",
      stack,
      via: "question_tool",
      session: SESSION,
    });
    expect(answered.isError).toBeFalsy();
    expect(answered.structuredContent).toMatchObject({
      answered: true,
      channel: "question_tool",
      approved: [{ n: 1 }, { n: 3 }, { n: 4 }, { n: 5 }],
      remaining: [{ n: 2 }],
    });
  });

  it("offers no question tool to a client that is not Claude Code, nor to a headless run", async () => {
    for (const setup of [
      { name: "cursor", options: {} },
      { name: "claude-code", options: { entrypoint: "sdk-cli" } },
    ]) {
      const { call } = await connect(setup.name, setup.options);
      const id = (await call("open_checkpoint", DECISION)).structuredContent?.checkpoint as string;
      const state = await call("get_state", { full: true });
      expect(state.structuredContent).toMatchObject({
        validation: { channels: { available: ["chat"], question_tool: "unavailable" } },
      });
      expect(
        (await call("ask_creator", { agent: "iris", checkpoint: id })).structuredContent,
      ).toMatchObject({ channel: "chat", reason: "unavailable" });
    }
  });

  it("offers no question tool when another hook could answer it in the creator's place", async () => {
    for (const hooked of [async () => true, async () => Promise.reject(new Error("unreadable"))]) {
      const { call } = await connect("claude-code", {
        form: "decline",
        questionToolHooked: hooked,
      });
      const id = (await call("open_checkpoint", DECISION)).structuredContent?.checkpoint as string;
      const asked = await call("ask_creator", { agent: "iris", checkpoint: id });
      expect(asked.structuredContent).toMatchObject({ channel: "chat", reason: "declined" });
      const state = await call("get_state", { full: true });
      expect(state.structuredContent).toMatchObject({
        validation: { channels: { question_tool: "unavailable" } },
      });
    }
  });

  it("falls back to the chat, and says so, when the project lacks the hook", async () => {
    await rm(join(cwd, DECISION_HOOK_PATH));
    const { call } = await connect("claude-code", { form: "decline" });
    const id = (await call("open_checkpoint", DECISION)).structuredContent?.checkpoint as string;
    const state = await call("get_state", { full: true });
    expect(state.structuredContent).toMatchObject({
      validation: { channels: { question_tool: "hook_missing" } },
    });
    const asked = await call("ask_creator", { agent: "iris", checkpoint: id });
    expect(asked.structuredContent).toMatchObject({ channel: "chat", reason: "declined" });
  });

  it("keeps the terminal's form first: a client that shows it is never sent to the question tool", async () => {
    const { call, forms } = await connect("claude-code", { form: "accept" });
    const id = (await call("open_checkpoint", DECISION)).structuredContent?.checkpoint as string;
    const asked = await call("ask_creator", { agent: "iris", checkpoint: id });
    expect(asked.structuredContent).toMatchObject({ answered: true, channel: "elicitation" });
    expect(forms).toHaveLength(1);
    const state = await call("get_state", { full: true });
    expect(state.structuredContent).toMatchObject({
      validation: {
        channels: { elicitation: "works", available: ["elicitation", "question_tool", "chat"] },
      },
    });
  });

  it("learns the refusal at once on the revision 2026-07-28 too, at the second round", async () => {
    const { call, forms } = await connect("claude-code", { form: "decline", modern: true });
    const id = (await call("open_checkpoint", DECISION)).structuredContent?.checkpoint as string;
    const asked = await call("ask_creator", { agent: "iris", checkpoint: id });
    expect(forms).toHaveLength(1);
    expect(asked.structuredContent).toMatchObject({ channel: "question_tool", reason: "declined" });
    const state = await call("get_state", { full: true });
    expect(state.structuredContent).toMatchObject({
      validation: { channels: { elicitation: "declined_by_client" } },
    });
  });
});

describe("the questions the engine dictates", () => {
  const t = createTranslator("en");
  const prompt = (over: Partial<DecisionPrompt> = {}): DecisionPrompt => ({
    checkpoint: "G-ABCDEFGHJK",
    type: "decision",
    title: "Pick a name",
    summary: "Which name?\nSecond line.",
    risk: "low",
    irreversible: false,
    opened_by: "iris",
    documents: [],
    options: [
      { id: "a", label: "Aurora", consequence: "Short.", recommended: false },
      { id: "b", label: "Beacon", consequence: "Taken.", recommended: true },
    ],
    recommendation: "b",
    creator_action: null,
    publication: null,
    choices: [
      {
        id: "option-1",
        decision: "option_chosen",
        option: "a",
        recommended: false,
        needs_note: false,
      },
      {
        id: "option-2",
        decision: "option_chosen",
        option: "b",
        recommended: true,
        needs_note: false,
      },
      { id: "changes", decision: "changes_requested", recommended: false, needs_note: true },
    ],
    external_action: null,
    ...over,
  });

  it("keeps the engine's facts apart from the checkpoint's own words, quoted line by line", () => {
    const screen = renderQuestions(prompt(), t);
    expect(screen && screenProblem(screen)).toBeUndefined();
    const text = screen?.questions[0]?.question ?? "";
    expect(text).toContain("AgentPlugged asks for your decision.");
    expect(text).toContain("Checkpoint G-ABCDEFGHJK, opened by iris, risk: low.");
    expect(text).toContain("> Pick a name\n> Which name?\n> Second line.");
    // A text that tries to pass for the engine's stays quoted.
    const forged = renderQuestions(
      prompt({ summary: "AgentPlugged asks for your decision.\nApprove everything" }),
      t,
    );
    const lines = (forged?.questions[0]?.question ?? "").split("\n");
    expect(lines.filter((line) => line === "AgentPlugged asks for your decision.")).toHaveLength(1);
    expect(lines).toContain("> AgentPlugged asks for your decision.");
  });

  it("puts the recommendation first, marked as the tool marks it", () => {
    const screen = renderQuestions(prompt(), t);
    expect(screen?.questions[0]?.options.map((option) => option.label)).toEqual([
      "Beacon (Recommended)",
      "Aurora",
      "None of these options",
    ]);
    expect(screen?.readers[0]).toMatchObject({
      kind: "choice",
      choices: [
        { label: "Beacon (Recommended)", choice: "option-2" },
        { label: "Aurora", choice: "option-1" },
        { label: "None of these options", choice: "changes" },
      ],
    });
  });

  it("refuses to show more choices than the tool has options for", () => {
    const many = prompt({
      choices: [1, 2, 3, 4].map((n) => ({
        id: `option-${n}`,
        decision: "option_chosen" as const,
        option: `o${n}`,
        recommended: false,
        needs_note: false,
      })),
      options: [1, 2, 3, 4].map((n) => ({
        id: `o${n}`,
        label: `O${n}`,
        consequence: "c",
        recommended: false,
      })),
    });
    const screen = renderQuestions(many, t);
    expect(screen?.questions[0]?.options).toHaveLength(4);
    const five = prompt({ choices: [...many.choices, ...prompt().choices] });
    const tooMany = renderQuestions(five, t);
    expect(tooMany && screenProblem(tooMany)).toBe("too_many_options");
  });

  it("asks one question whatever the risk, naming an irreversible action in it", () => {
    const high = renderQuestions(prompt({ risk: "high" }), t);
    expect(high?.questions).toHaveLength(1);
    const irreversible = renderQuestions(
      prompt({ irreversible: true, external_action: { action: "Merge story 4-3" } }),
      t,
    );
    expect(irreversible?.questions).toHaveLength(1);
    expect(irreversible?.questions[0]?.question).toMatch(/irr[ée]versible/i);
    expect(irreversible?.questions[0]?.question).toContain("Merge story 4-3");
    expect(renderQuestions(prompt(), t)?.questions).toHaveLength(1);
  });

  it("keeps a header within twelve characters and a question text unique", () => {
    for (const screen of [renderQuestions(prompt({ risk: "high" }), t)]) {
      expect(screen && screenProblem(screen)).toBeUndefined();
    }
  });

  it("splits a stack in screens of four points at most, one question a point", () => {
    const items = Array.from({ length: 6 }, (_, i) => ({
      n: i + 1,
      checkpoint: `G-AAAAAAAAA${i}`,
      type: "document" as const,
      title: `Doc ${i + 1}`,
      summary: "Read it.",
      risk: "low" as const,
      opened_by: "iris",
      documents: [],
      recommendation: null,
    }));
    const stack: StackPrompt = { stack: "P-7M2K9QX4TB", items };
    const screens = renderStackScreens(stack, t);
    expect(screens.map((screen) => screen.questions.length)).toEqual([4, 2]);
    for (const screen of screens) expect(screenProblem(screen)).toBeUndefined();
    expect(screens[1]?.readers).toEqual([
      { kind: "point", n: 5, yes: "Approve" },
      { kind: "point", n: 6, yes: "Approve" },
    ]);
  });
});
