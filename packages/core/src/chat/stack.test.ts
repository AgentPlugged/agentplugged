import { toBase64url } from "@agentplugged/crypto";
import { ErrorCode, MAX_STACK_ITEMS, type StackPrompt } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  AgentSession,
  type AnswerRecorded,
  type AskStackResult,
  type ChatMessage,
  type CheckpointState,
  type CommandContext,
  type CreatorPrompt,
  type CreatorReply,
  computeProjection,
  createCommandRegistry,
  historyEntries,
  initCommand,
  MemoryKeyStore,
  MemoryStateStore,
  messageDigest,
  NOAH_COMMANDS,
  normalizeChatText,
  type RecordedEvent,
  resolveProfile,
  type StackAnswered,
  type StackOpened,
  stackField,
  syncCommand,
  type ToolProbe,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const SEED = toBase64url(new Uint8Array(32).fill(13));
const START = Date.UTC(2026, 9, 4, 12, 0, 0);
const SESSION = "5f0c-stack-session";

/** The hook's store, in memory: messages added as the creator types them. */
class MemoryChatLog {
  readonly list: ChatMessage[] = [];

  say(text: string, at: number, session = SESSION): ChatMessage {
    const normalized = normalizeChatText(text);
    const message = {
      session,
      at: new Date(at).toISOString(),
      digest: messageDigest(normalized),
      text: normalized,
    };
    this.list.push(message);
    return message;
  }

  async messages(session: string): Promise<readonly ChatMessage[]> {
    return this.list.filter((message) => message.session === session);
  }
}

/** The AI tool's forms, scripted: a stack's form gets the next reply. */
class ScriptedPrompt implements CreatorPrompt {
  readonly stacks: StackPrompt[] = [];
  readonly replies: CreatorReply[];

  constructor(
    readonly channel: string,
    replies: CreatorReply[],
  ) {
    this.replies = [...replies];
  }

  async ask(): Promise<CreatorReply> {
    throw new Error("a point's form was not expected");
  }

  async askStack(prompt: StackPrompt): Promise<CreatorReply> {
    this.stacks.push(prompt);
    const next = this.replies.shift();
    if (next === undefined) throw new Error("no reply scripted");
    return next;
  }
}

const accept = (content: Record<string, unknown>): CreatorReply => ({ action: "accept", content });

/** Every box of the form, ticked as `ticked` says. */
const boxes = (size: number, ticked: (n: number) => boolean) =>
  Object.fromEntries(Array.from({ length: size }, (_, i) => [stackField(i + 1), ticked(i + 1)]));

const DOCUMENT = {
  agent: "main",
  type: "document",
  risk: "low",
  title: "A document",
  summary: "Read it, then approve it.",
};

const OPTIONS = [
  { id: "stripe", label: "Stripe", consequence: "Fast to ship." },
  { id: "paddle", label: "Paddle", consequence: "Handles VAT for us." },
];

async function product(options: { hooked?: boolean; installed?: boolean } = {}) {
  const files = new MemoryFiles();
  let clock = START;
  const journalNow = () => {
    clock += 1000;
    return clock;
  };
  const keys = new MemoryKeyStore(SEED);
  const journal = new MemoryStateStore({ keys, now: journalNow });
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
    journal,
    keys,
  };
  const init = await initCommand.run(human, { profile: resolveProfile("new-product") });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const synced = await syncCommand.run(human, {});
  if (!synced.ok) throw new Error(`sync failed: ${synced.error.code}`);
  const log = new MemoryChatLog();
  const now = START + 3_600_000;
  const agent: CommandContext = {
    ...human,
    actor: "agent",
    session: new AgentSession(START),
    now: () => now,
    chat: {
      log,
      hookInstalled: options.installed ?? true,
      ...(options.hooked === undefined ? {} : { hooked: options.hooked }),
    },
  };
  const registry = createCommandRegistry();
  const call = (name: string, input: Record<string, unknown>, prompt?: CreatorPrompt) =>
    registry.run(name, prompt === undefined ? agent : { ...agent, creatorPrompt: prompt }, input);
  const recorded = async (name: string, input: Record<string, unknown>) => {
    const result = await call(name, input);
    if (!result.ok) {
      throw new Error(
        `${name} failed: ${result.error.code} ${JSON.stringify(result.error.toPayload().details)}`,
      );
    }
    return result.value as RecordedEvent;
  };
  const open = async (fields: Record<string, unknown> = {}) =>
    (await recorded("open_checkpoint", { ...DOCUMENT, ...fields })).checkpoint as string;
  /** Opens `count` plain documents. */
  const documents = async (count: number) => {
    const ids: string[] = [];
    for (let i = 1; i <= count; i++) ids.push(await open({ title: `Document ${i}` }));
    return ids;
  };
  const openStack = async (ids: readonly string[]) => {
    const result = await call("open_stack", { agent: "main", checkpoints: ids });
    if (!result.ok) {
      throw new Error(
        `open_stack failed: ${result.error.code} ${JSON.stringify(result.error.toPayload().details)}`,
      );
    }
    return result.value as StackOpened;
  };
  const projection = async () => computeProjection((await journal.list()).events);
  const checkpoint = async (id: string) =>
    ((await projection()).state.checkpoints as Record<string, CheckpointState>)[
      id
    ] as CheckpointState;
  const answerStack = (stack: string, quote: string, extra: Record<string, unknown> = {}) =>
    call("answer_stack", { agent: "main", stack, quote, session: SESSION, ...extra });
  return {
    files,
    journal,
    log,
    call,
    recorded,
    open,
    documents,
    openStack,
    projection,
    checkpoint,
    answerStack,
    /** A moment after the stack opened. */
    after: (opened: StackOpened, ms = 500) => Date.parse(opened.at) + ms,
  };
}

const errorCode = (result: { ok: boolean; error?: { code: string } }) =>
  result.ok ? undefined : result.error?.code;
const errorDetails = (result: { ok: boolean; error?: { toPayload(): { details: unknown } } }) =>
  result.ok ? undefined : result.error?.toPayload().details;

describe("open_stack", () => {
  it("opens a stack of open checkpoints, numbered in the order given", async () => {
    const { documents, openStack, projection } = await product();
    const ids = await documents(3);
    const opened = await openStack([ids[2] as string, ids[0] as string, ids[1] as string]);
    expect(opened.stack).toMatch(/^P-[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(opened.items.map((item) => [item.n, item.checkpoint])).toEqual([
      [1, ids[2]],
      [2, ids[0]],
      [3, ids[1]],
    ]);
    expect(opened.items[1]).toMatchObject({ title: "Document 1", risk: "low", type: "document" });
    const state = (await projection()).state.stacks as Record<string, { items: unknown[] }>;
    expect(state[opened.stack]?.items).toHaveLength(3);
  });

  it("holds a decision that carries a recommendation, shown to the creator", async () => {
    const { open, openStack } = await product();
    const first = await open({
      title: "Provider",
      type: "decision",
      options: OPTIONS,
      recommendation: "paddle",
      risk: "medium",
    });
    const second = await open();
    const opened = await openStack([first, second]);
    expect(opened.items[0]?.recommendation).toBe("Paddle");
    expect(opened.items[1]?.recommendation).toBeNull();
  });

  it("refuses fewer than two points, more than sixteen, a point twice, an unknown point", async () => {
    const { documents, call } = await product();
    const ids = await documents(MAX_STACK_ITEMS + 1);
    const stack = (checkpoints: string[]) => call("open_stack", { agent: "main", checkpoints });
    const few = await stack([ids[0] as string]);
    expect(errorCode(few)).toBe(ErrorCode.STACK_INVALID);
    expect(errorDetails(few)).toMatchObject({ reason: "too_few" });
    expect(errorDetails(await stack(ids))).toMatchObject({ reason: "too_many" });
    expect(errorDetails(await stack([ids[0] as string, ids[0] as string]))).toMatchObject({
      reason: "duplicate",
    });
    expect(errorDetails(await stack([ids[0] as string, "G-ZZZZZZZZZZ"]))).toMatchObject({
      reason: "unknown_checkpoint",
    });
    // Eight is the most.
    expect((await stack(ids.slice(0, 8))).ok).toBe(true);
  });

  it("holds a point at a high risk or irreversible outside strict, naming its action", async () => {
    const { documents, open, openStack } = await product();
    const [first] = await documents(1);
    const high = await open({ risk: "high", title: "Risky" });
    const irreversible = await open({ irreversible: true, risk: "medium", title: "No way back" });
    const opened = await openStack([first as string, high, irreversible]);
    expect(opened.items.map((item) => item.risk)).toEqual(["low", "high", "medium"]);
  });

  it("refuses a point at a high risk or irreversible at the strict level: the terminal", async () => {
    const { documents, open, call, journal, files } = await product();
    const text = (await files.readText(".agentplugged/method.yaml")) as string;
    await files.writeText(".agentplugged/method.yaml", `${text}validation:\n  mode: strict\n`);
    const [first] = await documents(1);
    const high = await open({ risk: "high", title: "Risky" });
    const irreversible = await open({ irreversible: true, risk: "medium", title: "No way back" });
    const before = (await journal.list()).events.length;
    const refused = await call("open_stack", { agent: "main", checkpoints: [first, high] });
    expect(errorCode(refused)).toBe(ErrorCode.STACK_INVALID);
    expect(errorDetails(refused)).toMatchObject({ reason: "high_risk", checkpoint: high });
    const other = await call("open_stack", { agent: "main", checkpoints: [first, irreversible] });
    expect(errorDetails(other)).toMatchObject({ reason: "irreversible", checkpoint: irreversible });
    // Nothing was written.
    expect((await journal.list()).events).toHaveLength(before);
  });

  it("refuses an action of the creator's, and a point the creator answered meanwhile", async () => {
    const { documents, call, answerStack, openStack, log } = await product({ hooked: true });
    const [first, second] = await documents(2);
    const request = await call("request_creator_action", {
      agent: "main",
      action: { kind: "profile", installs: "validate" },
      reason: "why not",
    });
    expect(request.ok).toBe(true);
    const requested = (request as { value: { checkpoint: string } }).value.checkpoint;
    expect(
      errorDetails(await call("open_stack", { agent: "main", checkpoints: [first, requested] })),
    ).toMatchObject({ reason: "type", checkpoint: requested });
    // A point answered already (by the creator's own message about it alone) is no longer stackable.
    const opened = await openStack([first as string, second as string]);
    log.say("ok pour le premier", Date.parse(opened.at) + 300);
    await call("answer_checkpoint", {
      agent: "main",
      checkpoint: first,
      decision: "approved",
      quote: "ok pour le premier",
      session: SESSION,
    });
    // One stack at a time: while a point of the first still waits, no other is opened.
    expect(
      errorDetails(await call("open_stack", { agent: "main", checkpoints: [first, second] })),
    ).toMatchObject({ reason: "stack_open", stack: opened.stack });
    log.say("ok pour le second", Date.parse(opened.at) + 600);
    await call("answer_checkpoint", {
      agent: "main",
      checkpoint: second,
      decision: "approved",
      quote: "ok pour le second",
      session: SESSION,
    });
    expect(
      errorDetails(await call("open_stack", { agent: "main", checkpoints: [first, second] })),
    ).toMatchObject({ reason: "not_open", checkpoint: first });
    expect(answerStack).toBeDefined();
  });

  it("is in Noah's contract and not an answer by itself", async () => {
    for (const name of ["open_stack", "ask_stack", "answer_stack"]) {
      expect(NOAH_COMMANDS.has(name), name).toBe(true);
    }
    const { documents, openStack, checkpoint } = await product();
    const ids = await documents(2);
    await openStack(ids);
    expect((await checkpoint(ids[0] as string)).status).toBe("open");
  });
});

describe("answer_stack: the creator's message in the chat", () => {
  it("« j'approuve les 3 » answers the three points with one message, one answer each", async () => {
    const { documents, openStack, answerStack, log, checkpoint, projection, journal } =
      await product({ hooked: true });
    const ids = await documents(3);
    const opened = await openStack(ids);
    log.say("J'approuve les 3", Date.parse(opened.at) + 500);
    const result = await answerStack(opened.stack, "J'approuve les 3");
    expect(result.ok).toBe(true);
    const value = (result as { value: StackAnswered }).value;
    expect(value.approved.map((entry) => entry.n)).toEqual([1, 2, 3]);
    expect(value.remaining).toEqual([]);
    for (const id of ids) {
      const point = await checkpoint(id);
      expect(point.status).toBe("resolved");
      expect(point.resolution).toMatchObject({
        decision: "approved",
        source: "chat",
        assurance: "chat",
        relayed_by: "main",
        quote: "J'approuve les 3",
        stack: opened.stack,
      });
    }
    // One event, one citation: the message cannot answer anything else.
    const events = (await journal.list()).events.filter((event) => event.type === "stack.answered");
    expect(events).toHaveLength(1);
    const state = (await projection()).state;
    expect(state.chat_cited).toHaveLength(1);
    expect((state.validations as unknown[]).length).toBe(3);
    // The history says each answer, with its stack.
    const entries = historyEntries(await projection(), (await journal.list()).events);
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.stack === opened.stack && entry.source === "chat")).toBe(
      true,
    );
  });

  it("« j'approuve 1, 2 et 4 » approves those points and no other", async () => {
    const { documents, openStack, answerStack, log, checkpoint } = await product({ hooked: true });
    const ids = await documents(4);
    const opened = await openStack(ids);
    log.say("j'approuve 1, 2 et 4", Date.parse(opened.at) + 500);
    const result = await answerStack(opened.stack, "j'approuve 1, 2 et 4");
    const value = (result as { value: StackAnswered }).value;
    expect(value.approved.map((entry) => entry.n)).toEqual([1, 2, 4]);
    expect(value.remaining.map((entry) => entry.n)).toEqual([3]);
    expect((await checkpoint(ids[2] as string)).status).toBe("open");
    expect((await checkpoint(ids[3] as string)).status).toBe("resolved");
    // The point left open is answered later, by another message.
    log.say("j'approuve le 3", Date.parse(opened.at) + 5000);
    const rest = await answerStack(opened.stack, "j'approuve le 3");
    expect((rest as { value: StackAnswered }).value.approved.map((entry) => entry.n)).toEqual([3]);
    expect((await checkpoint(ids[2] as string)).status).toBe("resolved");
  });

  it("chooses the recommended option of a decision", async () => {
    const { open, openStack, answerStack, log, checkpoint } = await product({ hooked: true });
    const decision = await open({
      type: "decision",
      title: "Provider",
      options: OPTIONS,
      recommendation: "paddle",
      risk: "medium",
    });
    const plain = await open();
    const opened = await openStack([decision, plain]);
    log.say("j'approuve tout", Date.parse(opened.at) + 500);
    await answerStack(opened.stack, "j'approuve tout");
    expect((await checkpoint(decision)).resolution).toMatchObject({
      decision: "option_chosen",
      option: "paddle",
    });
    expect((await checkpoint(plain)).resolution?.decision).toBe("approved");
  });

  it("refuses a « yes » alone, a negation, a reservation: nothing is written", async () => {
    const { documents, openStack, answerStack, log, journal } = await product({ hooked: true });
    const ids = await documents(3);
    const opened = await openStack(ids);
    const before = (await journal.list()).events.length;
    for (const message of ["oui", "je n'approuve pas le 2", "j'approuve tout mais pas le 2"]) {
      log.say(message, Date.parse(opened.at) + 500);
      const result = await answerStack(opened.stack, message);
      expect(errorCode(result), message).toBe(ErrorCode.STACK_REPLY_UNCLEAR);
      expect(errorDetails(result), message).toMatchObject({ reason: "not_a_selection" });
    }
    log.say("j'approuve les 2", Date.parse(opened.at) + 500);
    expect(errorDetails(await answerStack(opened.stack, "j'approuve les 2"))).toMatchObject({
      reason: "ambiguous_count",
    });
    log.say("j'approuve 1 et 5", Date.parse(opened.at) + 500);
    expect(errorDetails(await answerStack(opened.stack, "j'approuve 1 et 5"))).toMatchObject({
      reason: "out_of_range",
    });
    expect((await journal.list()).events).toHaveLength(before);
  });

  it("never takes a message the creator sent before the stack opened", async () => {
    const { documents, openStack, answerStack, log } = await product({ hooked: true });
    const ids = await documents(2);
    const opened = await openStack(ids);
    log.say("j'approuve tout", Date.parse(opened.at) - 5000);
    const result = await answerStack(opened.stack, "j'approuve tout");
    expect(errorCode(result)).toBe(ErrorCode.CHAT_QUOTE_NOT_FOUND);
    expect(errorDetails(result)).toMatchObject({ reason: "before_opening" });
  });

  it("never takes an invented message, or one no session recorded", async () => {
    const { documents, openStack, answerStack, journal } = await product({ hooked: true });
    const ids = await documents(2);
    const opened = await openStack(ids);
    const before = (await journal.list()).events.length;
    const result = await answerStack(opened.stack, "j'approuve tout");
    expect(errorCode(result)).toBe(ErrorCode.CHAT_QUOTE_NOT_FOUND);
    expect(errorDetails(result)).toMatchObject({ reason: "no_message" });
    expect((await journal.list()).events).toHaveLength(before);
    // The session id is required where the hook records messages.
    const sessionless = await answerStack(opened.stack, "j'approuve tout", { session: undefined });
    expect(errorCode(sessionless)).toBe(ErrorCode.CHAT_SESSION_REQUIRED);
  });

  it("never lets one message answer twice: not another stack, not a single point", async () => {
    const { documents, open, openStack, answerStack, call, log, checkpoint } = await product({
      hooked: true,
    });
    const first = await documents(2);
    const stackA = await openStack(first);
    log.say("j'approuve tout", Date.parse(stackA.at) + 500);
    expect((await answerStack(stackA.stack, "j'approuve tout")).ok).toBe(true);
    // A second stack, opened after: the same message is before its opening, and already cited.
    const more = await documents(2);
    const stackB = await openStack(more);
    const reused = await answerStack(stackB.stack, "j'approuve tout");
    expect(errorCode(reused)).toBe(ErrorCode.CHAT_QUOTE_NOT_FOUND);
    // Nor a lone point, with the words that answered the stack.
    const lone = await open({ title: "Lone" });
    const single = await call("answer_checkpoint", {
      agent: "main",
      checkpoint: lone,
      decision: "approved",
      quote: "j'approuve tout",
      session: SESSION,
    });
    expect(errorCode(single)).toBe(ErrorCode.CHAT_QUOTE_NOT_FOUND);
    expect((await checkpoint(lone)).status).toBe("open");
  });

  it("skips a point the creator answered meanwhile, and approves the rest", async () => {
    const { documents, openStack, answerStack, log, checkpoint, journal, call } = await product({
      hooked: true,
    });
    const ids = await documents(3);
    const opened = await openStack(ids);
    // The creator refuses point 2 on its own (a rejection through the chat).
    log.say("non, pas celui-ci", Date.parse(opened.at) + 400);
    const refusal = await call("answer_checkpoint", {
      agent: "main",
      checkpoint: ids[1],
      decision: "rejected",
      quote: "non, pas celui-ci",
      session: SESSION,
    });
    expect(refusal.ok).toBe(true);
    log.say("j'approuve tout", Date.parse(opened.at) + 800);
    const result = await answerStack(opened.stack, "j'approuve tout");
    const value = (result as { value: StackAnswered }).value;
    expect(value.approved.map((entry) => entry.n)).toEqual([1, 3]);
    expect((await checkpoint(ids[1] as string)).resolution?.decision).toBe("rejected");
    // Everything answered: nothing left to approve.
    log.say("j'approuve tout encore", Date.parse(opened.at) + 1500);
    const closed = await answerStack(opened.stack, "j'approuve tout encore");
    expect(errorCode(closed)).toBe(ErrorCode.STACK_CLOSED);
    expect(
      (await journal.list()).events.filter((event) => event.type === "stack.answered"),
    ).toHaveLength(1);
  });

  it("answer_checkpoint of a point refuses a message that selects other numbers of its stack", async () => {
    const { documents, openStack, call, log, checkpoint } = await product({ hooked: true });
    const ids = await documents(3);
    const opened = await openStack(ids);
    log.say("j'approuve 1 et 2", Date.parse(opened.at) + 500);
    const wrong = await call("answer_checkpoint", {
      agent: "main",
      checkpoint: ids[2],
      decision: "approved",
      quote: "j'approuve 1 et 2",
      session: SESSION,
    });
    expect(errorCode(wrong)).toBe(ErrorCode.STACK_REPLY_UNCLEAR);
    expect(errorDetails(wrong)).toMatchObject({ reason: "not_selected", stack: opened.stack });
    expect((await checkpoint(ids[2] as string)).status).toBe("open");
    // A point the message does select can be answered on its own with it.
    const right = await call("answer_checkpoint", {
      agent: "main",
      checkpoint: ids[0],
      decision: "approved",
      quote: "j'approuve 1 et 2",
      session: SESSION,
    });
    expect((right as { ok: boolean }).ok).toBe(true);
    // A « yes » alone is the answer of one point, in a stack or not.
    log.say("oui", Date.parse(opened.at) + 900);
    const yes = await call("answer_checkpoint", {
      agent: "main",
      checkpoint: ids[2],
      decision: "approved",
      quote: "oui",
      session: SESSION,
    });
    expect((yes as { value: AnswerRecorded }).value.type).toBe("checkpoint.answered");
  });

  it("records an unverified answer in a tool without hooks (the installation case is in installs.test.ts)", async () => {
    const { documents, openStack, answerStack, checkpoint } = await product({ hooked: false });
    const ids = await documents(2);
    const opened = await openStack(ids);
    const result = await answerStack(opened.stack, "j'approuve tout", { session: undefined });
    expect(result.ok).toBe(true);
    expect((await checkpoint(ids[0] as string)).resolution).toMatchObject({
      source: "chat",
      assurance: "chat_unverified",
      proof: null,
    });
  });

  it("says Claude Code has no hook script when the project lacks it", async () => {
    const { documents, openStack, answerStack } = await product({ hooked: true, installed: false });
    const ids = await documents(2);
    const opened = await openStack(ids);
    const result = await answerStack(opened.stack, "j'approuve tout");
    expect(errorCode(result)).toBe(ErrorCode.CHAT_QUOTE_NOT_FOUND);
    expect(errorDetails(result)).toMatchObject({ reason: "hook_missing" });
  });

  it("never lets a selection that cannot be read stand for another point's answer", async () => {
    const { documents, openStack, call, log, checkpoint } = await product({ hooked: true });
    const ids = await documents(4);
    const opened = await openStack(ids);
    // « les 3 » of a stack of four reads as nothing, and is no answer of the fourth point either.
    log.say("j'approuve les 3", Date.parse(opened.at) + 500);
    const count = await call("answer_checkpoint", {
      agent: "main",
      checkpoint: ids[3],
      decision: "approved",
      quote: "j'approuve les 3",
      session: SESSION,
    });
    expect(errorCode(count)).toBe(ErrorCode.STACK_REPLY_UNCLEAR);
    expect(errorDetails(count)).toMatchObject({ reason: "not_selected" });
    // A number the stack does not have, likewise, for the point it does not name.
    log.say("j'approuve 1, 2 et 5", Date.parse(opened.at) + 800);
    const range = await call("answer_checkpoint", {
      agent: "main",
      checkpoint: ids[2],
      decision: "approved",
      quote: "j'approuve 1, 2 et 5",
      session: SESSION,
    });
    expect(errorCode(range)).toBe(ErrorCode.STACK_REPLY_UNCLEAR);
    for (const id of ids) expect((await checkpoint(id)).status).toBe("open");
  });

  it("says which points the message named were left open, and why, and refuses what names only answered ones", async () => {
    const { documents, openStack, call, answerStack, log, checkpoint } = await product({
      hooked: true,
    });
    const ids = await documents(3);
    const opened = await openStack(ids);
    log.say("ok pour le troisième", Date.parse(opened.at) + 300);
    await call("answer_checkpoint", {
      agent: "main",
      checkpoint: ids[2],
      decision: "approved",
      quote: "ok pour le troisième",
      session: SESSION,
    });
    log.say("j'approuve 1 et 3", Date.parse(opened.at) + 600);
    const result = await answerStack(opened.stack, "j'approuve 1 et 3");
    const value = (result as { value: StackAnswered }).value;
    expect(value.approved.map((entry) => entry.n)).toEqual([1]);
    expect(value.skipped).toMatchObject([{ n: 3, reason: "already_answered" }]);
    expect(value.remaining.map((entry) => entry.n)).toEqual([2]);
    // Only an answered point named while another waits: not « closed », a message to ask again.
    log.say("j'approuve le 3", Date.parse(opened.at) + 900);
    const again = await answerStack(opened.stack, "j'approuve le 3");
    expect(errorCode(again)).toBe(ErrorCode.STACK_REPLY_UNCLEAR);
    expect(errorDetails(again)).toMatchObject({ reason: "nothing_open" });
    expect((await checkpoint(ids[1] as string)).status).toBe("open");
  });

  it("knows no stack that was never opened", async () => {
    const { answerStack } = await product({ hooked: true });
    expect(errorCode(await answerStack("P-ZZZZZZZZZZ", "j'approuve tout"))).toBe(
      ErrorCode.STACK_NOT_FOUND,
    );
  });
});

describe("ask_stack: one form, a box per point", () => {
  it("shows the stack once, every box ticked, and records one answer per box left ticked", async () => {
    const { documents, openStack, call, checkpoint, projection, journal } = await product();
    const ids = await documents(3);
    const opened = await openStack(ids);
    const prompt = new ScriptedPrompt("claude-code", [accept(boxes(3, (n) => n !== 2))]);
    const result = await call("ask_stack", { agent: "main", stack: opened.stack }, prompt);
    const value = (result as { value: AskStackResult }).value as Extract<
      AskStackResult,
      { answered: true }
    >;
    expect(value).toMatchObject({
      asked: true,
      answered: true,
      channel: "elicitation",
      tool: "claude-code",
    });
    expect(value.approved.map((entry) => entry.n)).toEqual([1, 3]);
    expect(value.remaining.map((entry) => entry.n)).toEqual([2]);
    // One form for all three points.
    expect(prompt.stacks).toHaveLength(1);
    expect(prompt.stacks[0]?.items.map((item) => item.n)).toEqual([1, 2, 3]);
    for (const [index, id] of ids.entries()) {
      const point = await checkpoint(id);
      expect(point.status).toBe(index === 1 ? "open" : "resolved");
      if (index !== 1) {
        expect(point.resolution).toMatchObject({
          decision: "approved",
          source: "elicitation",
          assurance: "elicitation",
          channel: "claude-code",
          quote: null,
          stack: opened.stack,
        });
      }
    }
    // One answer per point ticked, in one event.
    expect((await projection()).state.validations).toHaveLength(2);
    expect(
      (await journal.list()).events.filter((event) => event.type === "stack.answered"),
    ).toHaveLength(1);
  });

  it("shows only the points that still wait, with their original numbers", async () => {
    const { documents, openStack, call } = await product({ hooked: true });
    const ids = await documents(3);
    const opened = await openStack(ids);
    await call(
      "ask_stack",
      { agent: "main", stack: opened.stack },
      new ScriptedPrompt("claude-code", [accept(boxes(3, (n) => n === 1))]),
    );
    const prompt = new ScriptedPrompt("claude-code", [
      accept({ [stackField(2)]: true, [stackField(3)]: true }),
    ]);
    const second = await call("ask_stack", { agent: "main", stack: opened.stack }, prompt);
    expect(prompt.stacks[0]?.items.map((item) => item.n)).toEqual([2, 3]);
    expect((second as { ok: boolean }).ok).toBe(true);
    const closed = await call(
      "ask_stack",
      { agent: "main", stack: opened.stack },
      new ScriptedPrompt("claude-code", []),
    );
    expect(errorCode(closed)).toBe(ErrorCode.STACK_CLOSED);
  });

  it("records nothing, and says why, when nothing is ticked, the form is declined or closed, or the tool shows none", async () => {
    const { documents, openStack, call, journal, checkpoint } = await product();
    const ids = await documents(2);
    const opened = await openStack(ids);
    const before = (await journal.list()).events.length;
    const stack = (prompt?: CreatorPrompt) =>
      call("ask_stack", { agent: "main", stack: opened.stack }, prompt);
    const none = await stack(new ScriptedPrompt("claude-code", [accept(boxes(2, () => false))]));
    expect((none as { value: AskStackResult }).value).toMatchObject({
      asked: true,
      answered: false,
      reason: "none_checked",
      channel: "chat",
    });
    const cancelled = await stack(new ScriptedPrompt("claude-code", [{ action: "cancel" }]));
    expect((cancelled as { value: AskStackResult }).value).toMatchObject({ reason: "cancelled" });
    // A stack the creator closed is not asked again in this session.
    const again = await stack(new ScriptedPrompt("claude-code", [accept(boxes(2, () => true))]));
    expect((again as { value: AskStackResult }).value).toMatchObject({
      reason: "declined",
      asked: false,
    });
    const absent = await stack();
    expect((absent as { value: AskStackResult }).value).toMatchObject({
      asked: false,
      reason: "unavailable",
      remaining: [{ n: 1 }, { n: 2 }],
    });
    expect((await journal.list()).events).toHaveLength(before);
    expect((await checkpoint(ids[0] as string)).status).toBe("open");
  });

  it("reads a reply that leaves a box out as no answer: the tool never approves for the creator", async () => {
    const { documents, openStack, call, checkpoint } = await product();
    const ids = await documents(2);
    const opened = await openStack(ids);
    const empty = await call(
      "ask_stack",
      { agent: "main", stack: opened.stack },
      new ScriptedPrompt("cursor", [accept({})]),
    );
    expect((empty as { value: AskStackResult }).value).toMatchObject({
      reason: "invalid",
      answered: false,
    });
    expect((await checkpoint(ids[0] as string)).status).toBe("open");
  });

  it("takes the form's answer to the stack only, never another stack's point", async () => {
    const { documents, openStack, call, checkpoint } = await product();
    const ids = await documents(2);
    const opened = await openStack(ids);
    const result = await call(
      "ask_stack",
      { agent: "main", stack: opened.stack },
      new ScriptedPrompt("cursor", [accept({ ...boxes(2, () => true), [stackField(3)]: true })]),
    );
    expect((result as { ok: boolean }).ok).toBe(true);
    expect((await checkpoint(ids[1] as string)).status).toBe("resolved");
  });
});

describe("stack events in the projection: what an agent could forge", () => {
  async function forged(
    journal: MemoryStateStore,
    payload: Record<string, unknown>,
    agent = "main",
  ) {
    const productId = (await journal.productId()) as string;
    await journal.appendAll([
      {
        type: "stack.answered",
        actor: { kind: "agent", agent },
        product: productId,
        provenance: "trusted",
        payload,
      },
    ]);
    return (await computeProjection((await journal.list()).events)).ignored.at(-1)?.reason;
  }

  it("ignores an answer that approves more than the creator's message says", async () => {
    const { documents, openStack, log, journal, checkpoint } = await product({ hooked: true });
    const ids = await documents(3);
    const opened = await openStack(ids);
    const message = log.say("j'approuve 1", Date.parse(opened.at) + 500);
    const reason = await forged(journal, {
      stack: opened.stack,
      source: "chat",
      approve: [1, 2, 3],
      quote: "j'approuve 1",
      proof: { message: { digest: message.digest, at: message.at } },
    });
    expect(reason).toBe("invalid");
    for (const id of ids) expect((await checkpoint(id)).status).toBe("open");
  });

  it("ignores a quote that is no approval, a proof of another message, one from before the stack", async () => {
    const { documents, openStack, log, journal, checkpoint } = await product({ hooked: true });
    const ids = await documents(2);
    const opened = await openStack(ids);
    const yes = log.say("oui", Date.parse(opened.at) + 500);
    expect(
      await forged(journal, {
        stack: opened.stack,
        source: "chat",
        approve: [1, 2],
        quote: "oui",
        proof: { message: { digest: yes.digest, at: yes.at } },
      }),
    ).toBe("invalid");
    const real = log.say("j'approuve tout", Date.parse(opened.at) + 600);
    expect(
      await forged(journal, {
        stack: opened.stack,
        source: "chat",
        approve: [1, 2],
        quote: "j'approuve tout",
        // The proof names another message than the quote.
        proof: { message: { digest: yes.digest, at: real.at } },
      }),
    ).toBe("invalid");
    const old = log.say("j'approuve tout", Date.parse(opened.at) - 5000);
    expect(
      await forged(journal, {
        stack: opened.stack,
        source: "chat",
        approve: [1, 2],
        quote: "j'approuve tout",
        proof: { message: { digest: old.digest, at: old.at } },
      }),
    ).toBe("invalid");
    for (const id of ids) expect((await checkpoint(id)).status).toBe("open");
  });

  it("ignores an answer that is not an agent's, a stack never opened, a number outside the stack", async () => {
    const { documents, openStack, journal, checkpoint } = await product({ hooked: true });
    const ids = await documents(2);
    const opened = await openStack(ids);
    const productId = (await journal.productId()) as string;
    await journal.appendAll([
      {
        type: "stack.answered",
        actor: { kind: "system" },
        product: productId,
        provenance: "trusted",
        payload: {
          stack: opened.stack,
          source: "elicitation",
          approve: [1],
          channel: "claude-code",
          form: "f".repeat(64),
        },
      },
    ]);
    expect((await computeProjection((await journal.list()).events)).ignored.at(-1)?.reason).toBe(
      "invalid",
    );
    expect(
      await forged(journal, {
        stack: "P-ZZZZZZZZZZ",
        source: "elicitation",
        approve: [1],
        channel: "claude-code",
        form: "f".repeat(64),
      }),
    ).toBe("invalid");
    expect(
      await forged(journal, {
        stack: opened.stack,
        source: "elicitation",
        approve: [3],
        channel: "claude-code",
        form: "f".repeat(64),
      }),
    ).toBe("invalid");
    for (const id of ids) expect((await checkpoint(id)).status).toBe("open");
  });

  it("ignores a stack opened over a high-risk point, or with a digest that is not what the point says", async () => {
    const { documents, open, journal, checkpoint } = await product({ hooked: true });
    const [first] = await documents(1);
    const risky = await open({ risk: "high", title: "Risky" });
    const productId = (await journal.productId()) as string;
    const digest = "a".repeat(64);
    const draft = (items: unknown[]) => ({
      type: "stack.opened",
      actor: { kind: "agent" as const, agent: "main" },
      product: productId,
      provenance: "trusted" as const,
      payload: { items },
    });
    await journal.appendAll([
      draft([
        { n: 1, checkpoint: first, digest },
        { n: 2, checkpoint: risky, digest },
      ]),
    ]);
    const projection = await computeProjection((await journal.list()).events);
    expect(projection.ignored.at(-1)?.reason).toBe("invalid");
    expect(projection.state.stacks).toBeUndefined();
    // A stack that digests nothing the checkpoints say is no stack either.
    const [a, b] = await documents(2);
    await journal.appendAll([
      draft([
        { n: 1, checkpoint: a, digest },
        { n: 2, checkpoint: b, digest },
      ]),
    ]);
    expect((await computeProjection((await journal.list()).events)).state.stacks).toBeUndefined();
    expect((await checkpoint(first as string)).status).toBe("open");
  });

  it("answers a stack only once: the same points cannot be approved again by another event", async () => {
    const { documents, openStack, call, journal } = await product();
    const ids = await documents(2);
    const opened = await openStack(ids);
    await call(
      "ask_stack",
      { agent: "main", stack: opened.stack },
      new ScriptedPrompt("claude-code", [accept(boxes(2, () => true))]),
    );
    const reason = await forged(journal, {
      stack: opened.stack,
      source: "elicitation",
      approve: [1, 2],
      channel: "claude-code",
      form: "f".repeat(64),
    });
    expect(reason).toBe("already_resolved");
  });
});
