import { toBase64url } from "@agentplugged/crypto";
import {
  CheckpointElicitedPayloadSchema,
  type DecisionPrompt,
  ErrorCode,
  eventTypeUpgrade,
} from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  AgentSession,
  type AgentStateView,
  type AskCreatorResult,
  type CheckpointState,
  type CommandContext,
  type CreatorPrompt,
  type CreatorReply,
  computeProjection,
  createCommandRegistry,
  decisionPrompt,
  formBlocked,
  formDigest,
  historyEntries,
  initCommand,
  MemoryKeyStore,
  MemoryStateStore,
  NOAH_COMMANDS,
  type RecordedEvent,
  readReply,
  resolveProfile,
  type StoryWorkspace,
  type StoryWorkspaceInspection,
  type StoryWorkspaceTarget,
  syncCommand,
  type ToolProbe,
} from "../index.js";
import { ROSE_ACTION } from "../testing/agent-content.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const SEED = toBase64url(new Uint8Array(32).fill(11));
const START = Date.UTC(2026, 9, 4, 12, 0, 0);
const HEAD = "a".repeat(40);

/** The AI tool's form, scripted: each question gets the next reply. */
class ScriptedPrompt implements CreatorPrompt {
  readonly asked: DecisionPrompt[] = [];
  readonly replies: (CreatorReply | ((prompt: DecisionPrompt) => Promise<CreatorReply>))[];

  constructor(
    readonly channel: string,
    replies: (CreatorReply | ((prompt: DecisionPrompt) => Promise<CreatorReply>))[],
  ) {
    this.replies = [...replies];
  }

  async ask(prompt: DecisionPrompt): Promise<CreatorReply> {
    this.asked.push(prompt);
    const next = this.replies.shift();
    if (next === undefined) throw new Error("no reply scripted");
    return typeof next === "function" ? next(prompt) : next;
  }
}

/** The story branches and their heads (the Git port). */
class FakeWorkspace implements StoryWorkspace {
  readonly heads = new Map<string, string>();

  async inspect(target: StoryWorkspaceTarget): Promise<StoryWorkspaceInspection> {
    const head = this.heads.get(target.branch);
    return {
      repository: true,
      prefix: "",
      main: { ref: "main", commit: "c".repeat(40) },
      storyBlob: null,
      branch: head === undefined ? null : { commit: head, merged: false, storyBlob: null },
      checkedOut: null,
      target: { path: `/repos/shop.worktrees/${target.id}`, relative: "", exists: false },
    };
  }
  create = () => Promise.reject(new Error("unused"));
  discard = async () => true;
  readBlob = async () => undefined;
  storyFilesOn = async () => undefined;
  installCommitHook = () => Promise.reject(new Error("unused"));
}

const OPTIONS = [
  { id: "stripe", label: "Stripe", consequence: "Fast to ship." },
  { id: "paddle", label: "Paddle", consequence: "Handles VAT for us." },
];

const DECISION = {
  agent: "main",
  type: "decision",
  risk: "medium",
  title: "Payment provider",
  summary: "Which provider do we launch with?",
  story: "2-6",
  blocks: [{ action: "story.review", story: "2-6" }],
  options: OPTIONS,
  recommendation: "paddle",
};

async function product(options: { mode?: string } = {}) {
  const files = new MemoryFiles();
  let clock = START;
  const journalNow = () => {
    clock += 1000;
    return clock;
  };
  const keys = new MemoryKeyStore(SEED);
  const journal = new MemoryStateStore({ keys, now: journalNow });
  const workspace = new FakeWorkspace();
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
    journal,
    keys,
    storyWorkspace: workspace,
  };
  const init = await initCommand.run(human, { profile: resolveProfile("new-product") });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  if (options.mode !== undefined) {
    const text = await files.readText(".agentplugged/method.yaml");
    await files.writeText(
      ".agentplugged/method.yaml",
      `${text}validation:\n  mode: ${options.mode}\n`,
    );
  }
  const synced = await syncCommand.run(human, {});
  if (!synced.ok) throw new Error(`sync failed: ${synced.error.code}`);
  const agent: CommandContext = {
    ...human,
    actor: "agent",
    session: new AgentSession(START),
    now: () => clock + 500,
  };
  const registry = createCommandRegistry();
  const call = (name: string, input: Record<string, unknown>, prompt?: CreatorPrompt) =>
    registry.run(name, prompt === undefined ? agent : { ...agent, creatorPrompt: prompt }, input);
  const open = async (fields: Record<string, unknown> = {}) => {
    const result = await call("open_checkpoint", { ...DECISION, ...fields });
    if (!result.ok)
      throw new Error(
        `open failed: ${result.error.code} ${JSON.stringify(result.error.toPayload().details)}`,
      );
    return (result.value as RecordedEvent).checkpoint as string;
  };
  const ask = async (checkpoint: string, prompt?: CreatorPrompt, agentId = "main") =>
    call("ask_creator", { agent: agentId, checkpoint }, prompt);
  /** Asks in a new session of the AI tool (one MCP server): what an earlier form left is gone. */
  const askFresh = async (checkpoint: string, prompt?: CreatorPrompt) =>
    registry.run(
      "ask_creator",
      {
        ...agent,
        session: new AgentSession(START),
        ...(prompt === undefined ? {} : { creatorPrompt: prompt }),
      },
      { agent: "main", checkpoint },
    );
  const checkpoint = async (id: string) =>
    (
      (await computeProjection((await journal.list()).events)).state.checkpoints as Record<
        string,
        CheckpointState
      >
    )[id] as CheckpointState;
  const productId = (await journal.productId()) as string;
  const start = async (story: string) => {
    workspace.heads.set(`feat/${story}-work`, HEAD);
    await journal.appendAll([
      {
        type: "story.started",
        actor: { kind: "system" },
        product: productId,
        story,
        provenance: "trusted",
        payload: {
          agent: "main",
          branch: `feat/${story}-work`,
          base: "c".repeat(40),
          base_ref: "main",
          worktree: `../shop.worktrees/${story}`,
        },
      },
    ]);
  };
  return { files, journal, agent, call, open, ask, askFresh, checkpoint, start, productId };
}

const accept = (content: Record<string, unknown>): CreatorReply => ({ action: "accept", content });

const resultOf = (result: { ok: boolean; value?: unknown; error?: { code: string } }) => {
  if (!result.ok) throw new Error(`failed: ${result.error?.code}`);
  return result.value as AskCreatorResult;
};

describe("ask_creator: the engine asks the creator in the AI tool's form", () => {
  it("records the option the creator clicked, from the agent that asked, with no quote", async () => {
    const { ask, open, journal, checkpoint } = await product();
    const id = await open();
    const prompt = new ScriptedPrompt("claude-code", [accept({ choice: "option-1" })]);
    const result = resultOf(await ask(id, prompt));
    expect(result).toMatchObject({
      checkpoint: id,
      asked: true,
      answered: true,
      channel: "elicitation",
      tool: "claude-code",
      decision: "option_chosen",
      option: "stripe",
    });
    // The form the engine built: options with their consequence, the recommendation marked.
    const shown = prompt.asked[0] as DecisionPrompt;
    expect(shown.options).toEqual([
      { id: "stripe", label: "Stripe", consequence: "Fast to ship.", recommended: false },
      { id: "paddle", label: "Paddle", consequence: "Handles VAT for us.", recommended: true },
    ]);
    expect(shown.choices.map((choice) => [choice.id, choice.decision, choice.option])).toEqual([
      ["option-1", "option_chosen", "stripe"],
      ["option-2", "option_chosen", "paddle"],
      ["changes", "changes_requested", undefined],
    ]);
    const event = journal.events.at(-1);
    expect(event?.type).toBe("checkpoint.elicited");
    expect(event?.actor).toMatchObject({ kind: "agent", agent: "main" });
    expect(event?.payload).toEqual({
      checkpoint: id,
      decision: "option_chosen",
      option: "stripe",
      source: "elicitation",
      channel: "claude-code",
      form: formDigest(shown),
    });
    expect(CheckpointElicitedPayloadSchema.safeParse(event?.payload).success).toBe(true);
    const resolved = await checkpoint(id);
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolution).toMatchObject({
      decision: "option_chosen",
      option: "stripe",
      source: "elicitation",
      assurance: "elicitation",
      channel: "claude-code",
      quote: null,
      relayed_by: "main",
    });
    expect(resolved.blocks_lifted).toBe(true);
  });

  it("offers approve or ask for changes on a document, and takes the creator's note", async () => {
    const { ask, open, checkpoint } = await product();
    const id = await open({
      type: "document",
      risk: "low",
      title: "PRD",
      summary: "The PRD is ready.",
      options: undefined,
      recommendation: undefined,
      blocks: [],
      story: undefined,
      documents: [{ path: ".agentplugged/docs/prd.md", branch: "main", blob_sha: "d".repeat(40) }],
    });
    const prompt = new ScriptedPrompt("cursor", [
      accept({ choice: "changes", note: "  Add the pricing page.  " }),
    ]);
    const result = resultOf(await ask(id, prompt));
    expect(result).toMatchObject({
      answered: true,
      decision: "changes_requested",
      note: "Add the pricing page.",
    });
    expect((prompt.asked[0] as DecisionPrompt).choices.map((choice) => choice.id)).toEqual([
      "approve",
      "changes",
    ]);
    expect((await checkpoint(id)).resolution).toMatchObject({
      decision: "changes_requested",
      note: "Add the pricing page.",
      source: "elicitation",
    });
  });

  it("records nothing without the form, on decline, cancel, failure or an answer that is no choice", async () => {
    const { ask, askFresh, open, journal, checkpoint } = await product();
    const id = await open();
    const before = journal.events.length;
    expect(resultOf(await ask(id))).toEqual({
      checkpoint: id,
      asked: false,
      answered: false,
      reason: "unavailable",
      channel: "chat",
    });
    const cases: [CreatorReply, string, boolean][] = [
      [{ action: "decline" }, "declined", true],
      [{ action: "cancel" }, "cancelled", true],
      [{ action: "failed" }, "failed", true],
      [{ action: "unavailable" }, "unavailable", false],
      [{ action: "tool_hook" }, "tool_hook", false],
      [accept({}), "invalid", true],
      [accept({ choice: "none" }), "invalid", true],
      [accept({ choice: "option-9" }), "invalid", true],
      [accept({ choice: "paddle" }), "invalid", true],
      [accept({ choice: "changes" }), "note_required", true],
      [accept({ choice: "changes", note: "   " }), "note_required", true],
      [accept({ choice: "option-2", note: 42 }), "invalid", true],
    ];
    for (const [reply, reason, asked] of cases) {
      const result = resultOf(await askFresh(id, new ScriptedPrompt("claude-code", [reply])));
      expect(result).toEqual({ checkpoint: id, asked, answered: false, reason, channel: "chat" });
    }
    // A form that throws is a failure, never an answer.
    const throwing: CreatorPrompt = {
      channel: "claude-code",
      ask: () => Promise.reject(new Error("tool crashed")),
    };
    expect(resultOf(await askFresh(id, throwing))).toMatchObject({
      answered: false,
      reason: "failed",
    });
    expect(journal.events.length).toBe(before);
    expect((await checkpoint(id)).status).toBe("open");
  });

  it("never offers the form for a high risk at the strict level, nor on a closed checkpoint", async () => {
    const { ask, open } = await product({ mode: "strict" });
    const high = await open({ risk: "high" });
    const prompt = new ScriptedPrompt("claude-code", [accept({ choice: "option-1" })]);
    const refused = await ask(high, prompt);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe(ErrorCode.REVIEW_REQUIRED);
      expect(refused.error.toPayload().details).toMatchObject({
        reason: "strict_high_risk",
        command: `npx agentplugged review ${high}`,
      });
    }
    expect(prompt.asked).toEqual([]);
    // The medium risk is asked as at the chat level.
    const medium = await open();
    expect(resultOf(await ask(medium, prompt))).toMatchObject({ answered: true });
    const again = await ask(medium, new ScriptedPrompt("claude-code", []));
    expect(again.ok ? undefined : again.error.code).toBe(ErrorCode.CHECKPOINT_NOT_OPEN);
    const unknown = await ask("G-0000000000", prompt);
    expect(unknown.ok ? undefined : unknown.error.code).toBe(ErrorCode.CHECKPOINT_NOT_FOUND);
  });

  it("writes nothing when the checkpoint was answered while the form was open", async () => {
    const { ask, open, journal, call } = await product();
    const id = await open();
    const prompt = new ScriptedPrompt("claude-code", [
      async () => {
        // Answered meanwhile, in the chat (a tool without the hook).
        const inner = await call("answer_checkpoint", {
          agent: "main",
          checkpoint: id,
          decision: "option_chosen",
          option: "paddle",
          quote: "paddle",
        });
        expect(inner.ok).toBe(true);
        return accept({ choice: "option-1" });
      },
    ]);
    const result = await ask(id, prompt);
    expect(result.ok ? undefined : result.error.code).toBe(ErrorCode.CHECKPOINT_NOT_OPEN);
    expect(journal.events.some((event) => event.type === "checkpoint.elicited")).toBe(false);
  });

  it("takes nothing of the answer from the agent's input", async () => {
    const { call, open } = await product();
    const id = await open();
    const prompt = new ScriptedPrompt("claude-code", [accept({ choice: "option-1" })]);
    for (const extra of [
      { decision: "approved" },
      { option: "paddle" },
      { channel: "terminal" },
      { assurance: "presence" },
    ]) {
      const result = await call("ask_creator", { agent: "main", checkpoint: id, ...extra }, prompt);
      expect(result.ok ? undefined : result.error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
    }
    expect(prompt.asked).toEqual([]);
  });

  it("asks a CI waiver in one form, one click, and carries it out", async () => {
    const { ask, start, call, journal, checkpoint } = await product();
    await start("4-3");
    const requested = await call("request_creator_action", {
      agent: "main",
      action: { kind: "ci_waive", story: "4-3" },
      reason: "the runner is down",
    });
    if (!requested.ok) throw new Error(requested.error.code);
    const id = (requested.value as { checkpoint: string }).checkpoint;
    const clicked = new ScriptedPrompt("claude-code", [accept({ choice: "approve" })]);
    const result = resultOf(await ask(id, clicked));
    expect(result).toMatchObject({ answered: true, decision: "approved" });
    const shown = clicked.asked[0] as DecisionPrompt;
    expect(shown.choices.map((choice) => choice.id)).toEqual(["approve", "reject", "changes"]);
    expect(shown.external_action).toBeNull();
    expect(shown.creator_action).toMatchObject({ kind: "ci_waive", story: "4-3" });
    const [answered, executed] = journal.events.slice(-2);
    expect(answered?.type).toBe("checkpoint.elicited");
    expect(answered?.payload).toMatchObject({ source: "elicitation" });
    expect(answered?.payload).not.toHaveProperty("confirmed");
    expect(executed?.type).toBe("creator_action.executed");
    expect(executed?.v).toBe(12);
    expect(executed?.payload).toMatchObject({ source: "elicitation", checkpoint: id });
    expect(executed?.payload).not.toHaveProperty("quote");
    expect((await checkpoint(id)).executed).toMatchObject({ source: "elicitation" });
    const stories = (await computeProjection((await journal.list()).events)).state.stories;
    expect(JSON.stringify((stories as Record<string, unknown>)["4-3"])).toContain(HEAD);
  });

  it("puts the whole definition of an agent in the form, and leaves one too long to the chat", async () => {
    const { ask, call, files } = await product();
    const requested = await call("request_creator_action", {
      agent: "main",
      action: ROSE_ACTION,
      reason: "voisins testeurs",
    });
    if (!requested.ok) throw new Error(requested.error.code);
    const id = (requested.value as { checkpoint: string }).checkpoint;
    const reply = new ScriptedPrompt("claude-code", [accept({ choice: "approve" })]);
    expect(resultOf(await ask(id, reply))).toMatchObject({
      answered: true,
      decision: "approved",
      executed: { kind: "agent_create", files: { changed: true } },
    });
    // The form was given the definition as recorded; the click wrote exactly it.
    const shown = reply.asked[0] as DecisionPrompt;
    expect(shown.creator_action).toMatchObject({
      kind: "agent_create",
      content: ROSE_ACTION.content,
    });
    expect(await files.readText(".agentplugged/agents/rose/SKILL.md")).toContain(
      ROSE_ACTION.content.overview,
    );
    // Over the form's limit: nothing is asked; the agent shows it whole in the chat.
    const long = Array.from({ length: 10 }, (_, index) => `${index} ${"z".repeat(290)}`);
    const big = await call("request_creator_action", {
      agent: "main",
      action: {
        ...ROSE_ACTION,
        id: "long-one",
        name: "Long One",
        content: { ...ROSE_ACTION.content, produces: long, principles: long },
      },
      reason: "long",
    });
    if (!big.ok) throw new Error(big.error.code);
    const bigId = (big.value as { checkpoint: string }).checkpoint;
    const unused = new ScriptedPrompt("claude-code", []);
    expect(resultOf(await ask(bigId, unused))).toMatchObject({
      asked: false,
      answered: false,
      reason: "content_too_long",
      channel: "chat",
    });
    expect(unused.asked).toEqual([]);
  });

  it("refuses a refusal of an irreversible action without a note, never needs its confirmation", async () => {
    const { ask, start, call } = await product();
    await start("4-3");
    const requested = await call("request_creator_action", {
      agent: "main",
      action: { kind: "ci_waive", story: "4-3" },
      reason: "the runner is down",
    });
    if (!requested.ok) throw new Error(requested.error.code);
    const id = (requested.value as { checkpoint: string }).checkpoint;
    const reply = new ScriptedPrompt("claude-code", [
      accept({ choice: "reject", note: "Fix the runner first." }),
    ]);
    expect(resultOf(await ask(id, reply))).toMatchObject({
      answered: true,
      decision: "rejected",
      note: "Fix the runner first.",
    });
  });

  it("shows the answer « chosen in the tool » in the history and in get_state", async () => {
    const { ask, open, journal, call } = await product();
    const id = await open();
    await ask(id, new ScriptedPrompt("cursor", [accept({ choice: "option-2" })]));
    const events = (await journal.list()).events;
    const entries = historyEntries(await computeProjection(events), events);
    expect(entries[0]).toMatchObject({
      source: "elicitation",
      assurance: "elicitation",
      channel: "cursor",
      quote: null,
      relayed_by: "main",
    });
    const view = await call("get_state", { full: true });
    if (!view.ok) throw new Error(view.error.code);
    expect((view.value as AgentStateView).validation.elicitation).toBe(false);
    const withForm = await call("get_state", { full: true }, new ScriptedPrompt("cursor", []));
    if (!withForm.ok) throw new Error(withForm.error.code);
    expect((withForm.value as AgentStateView).validation.elicitation).toBe(true);
  });

  it("never asks again in a form a checkpoint the creator declined or closed in this session", async () => {
    const { ask, askFresh, open } = await product();
    const id = await open();
    expect(
      resultOf(await ask(id, new ScriptedPrompt("cursor", [{ action: "decline" }]))),
    ).toMatchObject({
      reason: "declined",
    });
    const again = new ScriptedPrompt("cursor", [accept({ choice: "option-1" })]);
    expect(resultOf(await ask(id, again))).toEqual({
      checkpoint: id,
      asked: false,
      answered: false,
      reason: "declined",
      channel: "chat",
    });
    expect(again.asked).toEqual([]);
    // Another session of the tool may ask it.
    expect(resultOf(await askFresh(id, again))).toMatchObject({ answered: true });
  });

  it("keeps one form at a time per session, and one per checkpoint", async () => {
    const { ask, open } = await product();
    const first = await open();
    const second = await open({ title: "Another provider" });
    let release: (reply: CreatorReply) => void = () => undefined;
    let reached: () => void = () => undefined;
    const shown = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const slow = new ScriptedPrompt("cursor", [
      () =>
        new Promise<CreatorReply>((resolve) => {
          release = resolve;
          reached();
        }),
    ]);
    const pending = ask(first, slow);
    await shown;
    const busy = new ScriptedPrompt("cursor", [accept({ choice: "option-1" })]);
    expect(resultOf(await ask(second, busy))).toMatchObject({ reason: "busy", asked: false });
    expect(busy.asked).toEqual([]);
    release(accept({ choice: "option-2" }));
    expect(resultOf(await pending)).toMatchObject({ answered: true, option: "paddle" });
  });

  it("is in Noah's contract, and the constitution tells every agent to let the engine ask", async () => {
    expect(NOAH_COMMANDS.has("ask_creator")).toBe(true);
    const { files } = await product();
    const constitution = files.reference();
    expect(constitution).toContain("call `chat.ask` with the\n   checkpoint");
    expect(constitution).toContain("`validation.elicitation`");
    expect(constitution).toContain("are `chat.ask`");
  });
});

describe("checkpoint.elicited in the projection", () => {
  it("ignores an answer that does not come from an agent, or skips the irreversible confirmation", async () => {
    const { open, journal, checkpoint } = await product();
    const id = await open();
    const productId = (await journal.productId()) as string;
    const payload = {
      checkpoint: id,
      decision: "option_chosen",
      option: "paddle",
      source: "elicitation",
      channel: "claude-code",
      form: "f".repeat(64),
    };
    await journal.appendAll([
      {
        type: "checkpoint.elicited",
        actor: { kind: "system" },
        product: productId,
        provenance: "trusted",
        payload,
      },
    ]);
    const projection = await computeProjection((await journal.list()).events);
    expect(projection.ignored.at(-1)?.reason).toBe("invalid");
    expect((await checkpoint(id)).status).toBe("open");
  });

  it("accepts an approval of an irreversible action without any confirmation", async () => {
    const { open, journal, checkpoint } = await product();
    const id = await open({ irreversible: true, risk: "high" });
    const productId = (await journal.productId()) as string;
    await journal.appendAll([
      {
        type: "checkpoint.elicited",
        actor: { kind: "agent", agent: "main" },
        product: productId,
        provenance: "trusted",
        payload: {
          checkpoint: id,
          decision: "option_chosen",
          option: "paddle",
          source: "elicitation",
          channel: "claude-code",
          form: "f".repeat(64),
        },
      },
    ]);
    const projection = await computeProjection((await journal.list()).events);
    expect(projection.ignored).toEqual([]);
    expect((await checkpoint(id)).status).toBe("resolved");
  });

  it("is a new type: an older engine asks for an upgrade, and creator_action.executed is at version 3", () => {
    expect(eventTypeUpgrade("checkpoint.elicited", 1)).toBeUndefined();
    // Version 2 (the question tool): 3 is beyond this engine.
    expect(eventTypeUpgrade("checkpoint.elicited", 2)).toBeUndefined();
    expect(eventTypeUpgrade("checkpoint.elicited", 3)?.code).toBe(ErrorCode.UPGRADE_REQUIRED);
    expect(eventTypeUpgrade("creator_action.executed", 3)).toBeUndefined();
  });
});

describe("the decision object and the reading of the answer", () => {
  const base = {
    id: "G-AAAAAAAAAA",
    type: "decision",
    risk: "low",
    irreversible: false,
    recipient_role: "creator",
    confirmation: [],
    title: "Pick",
    summary: "Pick one",
    story: null,
    documents: [],
    blocks: [],
    options: OPTIONS,
    recommendation: "paddle",
    criteria: null,
    source: null,
    status: "open",
    opened_by: "main",
    opened_at: new Date(START).toISOString(),
    opened_event: "01J0000000000000000000000A",
    measures: {},
    verdict: null,
    resolution: null,
    supersedes: null,
    phase: null,
    blocks_lifted: false,
    waived_ms: 0,
    request: null,
    untrusted: null,
    provenance: "trusted",
  } as unknown as CheckpointState;

  it("keeps out of the form only an installation whose request the point keeps cut, never what a session read", () => {
    expect(formBlocked(base)).toBe(false);
    const install = (detail: string) =>
      ({
        ...base,
        source: "untrusted_action",
        request: { action: "install_dependency", detail, digest: "a".repeat(64), sessions: ["s"] },
      }) as unknown as CheckpointState;
    expect(formBlocked(install("npm install left-pad"))).toBe(false);
    expect(formBlocked(install("x".repeat(500)))).toBe(true);
    // A point opened by a session that read outside is answered like any other: nothing blocks it.
    const action = {
      ...base,
      type: "creator_action",
      creator_action: { kind: "ci_waive", story: "4-3", commit: HEAD, reason: "x" },
      untrusted: { reads: [{ tool: "WebFetch", source: "evil.example" }] },
    } as unknown as CheckpointState;
    expect(formBlocked(action)).toBe(false);
  });

  it("never has a default and marks only the recommendation", () => {
    const prompt = decisionPrompt(base, START);
    expect(prompt.choices.filter((choice) => choice.recommended).map((c) => c.option)).toEqual([
      "paddle",
    ]);
    expect(prompt.external_action).toBeNull();
    expect(JSON.stringify(prompt)).not.toContain("default");
  });

  it("offers only refusals on a held merge checkpoint", () => {
    const story = { ...base, type: "story", options: null, recommendation: null };
    const prompt = decisionPrompt(story as CheckpointState, START, {
      merge: { story: "4-3", ci: "failing", review: false },
    });
    expect(prompt.choices.map((choice) => choice.decision)).toEqual(["changes_requested"]);
  });

  it("names an irreversible action in the question and reads one click as the answer", () => {
    const irreversible = { ...base, irreversible: true, options: null, recommendation: null };
    const prompt = decisionPrompt(irreversible as CheckpointState, START);
    expect(prompt.external_action).toEqual({ action: "Pick" });
    expect(readReply(prompt, accept({ choice: "approve" }))).toEqual({ decision: "approved" });
    expect(readReply(prompt, accept({ choice: "changes", note: "No." }))).toEqual({
      decision: "changes_requested",
      note: "No.",
    });
    // A note the form counted in code points is cut to the journal's 2000 units, never lost.
    expect(readReply(prompt, accept({ choice: "approve", note: "x".repeat(2001) }))).toEqual({
      decision: "approved",
      note: "x".repeat(2000),
    });
  });
});
