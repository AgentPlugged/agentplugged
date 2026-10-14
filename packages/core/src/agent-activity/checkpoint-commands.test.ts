import { toBase64url } from "@agentplugged/crypto";
import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type AgentStateView,
  type CheckpointState,
  type CommandContext,
  computeProjection,
  createCommandRegistry,
  initCommand,
  MemoryKeyStore,
  MemoryStateStore,
  type RecordedEvent,
  resolveProfile,
  type StateStore,
  type ToolProbe,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const SEED = toBase64url(new Uint8Array(32).fill(9));

function clock() {
  let now = Date.UTC(2026, 9, 3, 12, 0, 0);
  return () => {
    now += 1000;
    return now;
  };
}

async function product() {
  const files = new MemoryFiles();
  const journal = new MemoryStateStore({ keys: new MemoryKeyStore(SEED), now: clock() });
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
  };
  const init = await initCommand.run(human, { profile: resolveProfile("new-product") });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const agent: CommandContext = { ...human, actor: "agent", journal };
  const registry = createCommandRegistry();
  const call = (name: string, input: Record<string, unknown> = {}) =>
    registry.run(name, agent, input);
  const recorded = async (name: string, input: Record<string, unknown>) => {
    const result = await call(name, input);
    if (!result.ok) throw new Error(`${name} failed: ${result.error.code}`);
    return result.value as RecordedEvent;
  };
  const state = async () => {
    const result = await call("get_state", { full: true });
    if (!result.ok) throw new Error(`get_state failed: ${result.error.code}`);
    return result.value as AgentStateView;
  };
  return { files, journal, agent, call, recorded, state };
}

const OPTIONS = [
  { id: "stripe", label: "Stripe", consequence: "Fast to ship." },
  { id: "paddle", label: "Paddle", consequence: "Handles VAT for us." },
  { id: "later", label: "Later", consequence: "No payments at launch." },
];

const DECISION = {
  agent: "iris",
  type: "decision",
  risk: "medium",
  title: "Payment provider",
  summary: "Which provider do we launch with?",
  story: "2-6",
  blocks: [{ action: "story.review", story: "2-6" }],
  options: OPTIONS,
  recommendation: "paddle",
};

const RESULT = {
  agent: "iris",
  story: "2-6",
  summary: "Cannot reach the payment API.",
  assumptions: [],
  open_questions: ["Which API key?"],
  conflicts: [],
};

describe("open_checkpoint", () => {
  it("opens a decision: G- id, product recipient, undoable gesture", async () => {
    const { journal, recorded, state } = await product();
    const opened = await recorded("open_checkpoint", DECISION);
    expect(opened.type).toBe("checkpoint.opened");
    expect(opened.checkpoint).toBe(`G-${opened.id.slice(-10)}`);

    const event = journal.events.at(-1);
    expect(event?.actor).toMatchObject({ kind: "agent", agent: "iris" });
    expect(event?.story).toBe("2-6");
    expect(event?.payload).toMatchObject({
      recipient_role: "product",
      confirmation: ["gesture_undo_10s"],
      irreversible: false,
      documents: [],
    });
    expect(event?.payload).not.toHaveProperty("story");

    const view = await state();
    expect(view.checkpoints[opened.checkpoint as string]).toEqual({
      id: opened.checkpoint,
      type: "decision",
      risk: "medium",
      irreversible: false,
      recipient_role: "product",
      confirmation: ["gesture_undo_10s"],
      title: "Payment provider",
      summary: "Which provider do we launch with?",
      story: "2-6",
      documents: [],
      blocks: [{ action: "story.review", story: "2-6" }],
      options: OPTIONS,
      recommendation: "paddle",
      criteria: null,
      source: null,
      status: "open",
      opened_by: "iris",
      opened_at: opened.at,
      opened_event: opened.id,
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
    });
    expect(view.stories["2-6"]?.waiting_on).toEqual([opened.checkpoint]);
  });

  it.each([
    ["one option", { options: OPTIONS.slice(0, 1) }, "options"],
    [
      "five options",
      {
        options: [
          ...OPTIONS,
          { id: "d", label: "D", consequence: "d" },
          { id: "e", label: "E", consequence: "e" },
        ],
      },
      "options",
    ],
    ["no recommendation", { recommendation: undefined }, "recommendation"],
    ["an id", { id: "G-0000000001" }, "id"],
  ])("refuses a decision with %s, writing nothing", async (_name, change, field) => {
    const { journal, call } = await product();
    const result = await call("open_checkpoint", { ...DECISION, ...change });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
    expect(result.error.details.field).toBe(field);
    expect(journal.events).toEqual([]);
  });

  it("sends a high, irreversible release to tech_lead, with presence and nothing more", async () => {
    const { recorded, state } = await product();
    const opened = await recorded("open_checkpoint", {
      agent: "iris",
      type: "release",
      risk: "high",
      irreversible: true,
      title: "Release 1.0",
      summary: "Ship to production.",
      story: "2-6",
      blocks: [{ action: "release.deploy" }],
    });
    expect((await state()).checkpoints[opened.checkpoint as string]).toMatchObject({
      recipient_role: "tech_lead",
      confirmation: ["presence"],
      irreversible: true,
    });
  });

  it("raises a role too weak for a high risk to tech_lead", async () => {
    const { recorded, state } = await product();
    const opened = await recorded("open_checkpoint", {
      ...DECISION,
      risk: "high",
      recipient_role: "creator",
    });
    expect(
      ((await state()).checkpoints[opened.checkpoint as string] as CheckpointState).recipient_role,
    ).toBe("tech_lead");
  });

  it("refuses an inactive agent", async () => {
    const { call } = await product();
    const result = await call("open_checkpoint", { ...DECISION, agent: "ghost" });
    expect(result.ok ? undefined : result.error.code).toBe(ErrorCode.AGENT_NOT_FOUND);
  });
});

describe("blocking", () => {
  it("refuses update_story to in_review on a blocked story, writing nothing", async () => {
    const { journal, call, recorded } = await product();
    const opened = await recorded("open_checkpoint", DECISION);
    const before = journal.events.length;
    const refused = await call("update_story", {
      agent: "iris",
      story: "2-6",
      status: "in_review",
    });
    expect(refused.ok ? undefined : refused.error.toPayload()).toEqual({
      code: ErrorCode.CHECKPOINT_OPEN,
      message_key: "error.checkpoint_open",
      details: { checkpoint: opened.checkpoint, action: "story.review" },
    });
    expect(journal.events).toHaveLength(before);
  });

  it("lets the agent move on elsewhere: another story, another action", async () => {
    const { call, recorded } = await product();
    await recorded("open_checkpoint", DECISION);
    for (const [name, input] of [
      ["update_story", { agent: "iris", story: "2-7", status: "in_review" }],
      ["update_story", { agent: "iris", story: "2-6", status: "in_progress" }],
      // 2-6 was never started (`start_story`): iris's complete result does not move it to review
      //, so the checkpoint on its review does not refuse it.
      ["submit_result", { ...RESULT, status: "complete" }],
      ["report_progress", { agent: "iris", story: "2-6", note: "Still going" }],
    ] as const) {
      const result = await call(name, input);
      expect(result.ok, `${name}: ${result.ok ? "" : result.error.code}`).toBe(true);
    }
  });

  it("refuses a complete result while a checkpoint blocks completing the story", async () => {
    const { call, recorded } = await product();
    const opened = await recorded("open_checkpoint", {
      ...DECISION,
      blocks: [{ action: "story.complete" }],
    });
    const refused = await call("submit_result", { ...RESULT, status: "complete" });
    expect(refused.ok ? undefined : refused.error.details).toEqual({
      checkpoint: opened.checkpoint,
      action: "story.complete",
    });
    // A partial result is not a completion.
    expect((await call("submit_result", { ...RESULT, status: "partial" })).ok).toBe(true);
  });

  it("refuses a complete result without a story while any checkpoint blocks completing one", async () => {
    const { call, recorded } = await product();
    const opened = await recorded("open_checkpoint", {
      ...DECISION,
      blocks: [{ action: "story.complete", story: "2-6" }],
    });
    const { story: _story, ...storyless } = RESULT;
    const refused = await call("submit_result", { ...storyless, status: "complete" });
    expect(refused.ok ? undefined : refused.error.details).toEqual({
      checkpoint: opened.checkpoint,
      action: "story.complete",
    });
  });

  it("refuses a block without a story on a checkpoint without one, writing nothing", async () => {
    const { journal, call } = await product();
    const result = await call("open_checkpoint", {
      ...DECISION,
      story: undefined,
      blocks: [{ action: "story.review" }],
    });
    expect(result.ok ? undefined : result.error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
    expect(result.ok ? undefined : result.error.details.field).toBe("blocks.0.story");
    expect(journal.events).toEqual([]);
  });

  it("checks under the write, on the journal as written: a checkpoint opened meanwhile blocks", async () => {
    const { journal, agent } = await product();
    // Another process opens a checkpoint between this call's start and its write.
    const registry = createCommandRegistry();
    let opened: RecordedEvent | undefined;
    const racing: StateStore = {
      append: (draft) => journal.append(draft),
      appendAll: async (drafts, options) => {
        const other = await registry.run("open_checkpoint", { ...agent, journal }, DECISION);
        opened = (other as { value: RecordedEvent }).value;
        return journal.appendAll(drafts, options);
      },
      appendHuman: (events, options) => journal.appendHuman(events, options),
      list: () => journal.list(),
      head: () => journal.head(),
      productId: () => journal.productId(),
      projected: () => journal.projected(),
      markProjected: (position, previous) => journal.markProjected(position, previous),
      history: (from, to) => journal.history(from, to),
    };
    const before = journal.events.length;
    const refused = await registry.run(
      "update_story",
      { ...agent, journal: racing },
      { agent: "iris", story: "2-6", status: "in_review" },
    );
    expect(refused.ok ? undefined : refused.error.details).toEqual({
      checkpoint: opened?.checkpoint,
      action: "story.review",
    });
    // Only the other process's events (its device, product and checkpoint) were written.
    expect(journal.events.slice(before).map((event) => event.type)).not.toContain(
      "story.status_changed",
    );
  });
});

describe("submit_result with blocked", () => {
  it("opens a story checkpoint in the same write; the story waits on it", async () => {
    const { journal, call, recorded, state } = await product();
    const before = journal.events.length;
    const result = await recorded("submit_result", { ...RESULT, status: "blocked" });
    const written = journal.events.slice(before);
    // Device and product first, then the result and its checkpoint, chained in one append.
    expect(written.map((event) => event.type).slice(-2)).toEqual([
      "agent.result_recorded",
      "checkpoint.opened",
    ]);
    const [recordedEvent, opening] = written.slice(-2);
    expect(result.id).toBe(recordedEvent?.id);
    expect(result.checkpoint).toBe(`G-${opening?.id.slice(-10)}`);
    expect(opening?.story).toBe("2-6");

    const view = await state();
    expect(view.checkpoints[result.checkpoint as string]).toMatchObject({
      type: "story",
      risk: "medium",
      recipient_role: "tech_lead",
      title: "Blocked: 2-6",
      summary: "Cannot reach the payment API.\n\nOpen questions:\n- Which API key?",
      blocks: [
        { action: "story.complete", story: "2-6" },
        { action: "story.review", story: "2-6" },
      ],
      source: "blocked_result",
      status: "open",
      opened_by: "iris",
    });
    expect(view.stories["2-6"]?.waiting_on).toEqual([result.checkpoint]);
    const review = await call("update_story", { agent: "iris", story: "2-6", status: "in_review" });
    expect(review.ok ? undefined : review.error.code).toBe(ErrorCode.CHECKPOINT_OPEN);
    expect((await computeProjection(journal.events)).ignored).toEqual([]);
  });

  it("reuses its open checkpoint when the same agent is blocked again on the story", async () => {
    const { journal, recorded, state } = await product();
    const first = await recorded("submit_result", { ...RESULT, status: "blocked" });
    const second = await recorded("submit_result", {
      ...RESULT,
      status: "blocked",
      summary: "Still no key.",
    });
    expect(second.checkpoint).toBe(first.checkpoint);
    expect(journal.events.filter((event) => event.type === "checkpoint.opened")).toHaveLength(1);
    const view = await state();
    expect(Object.keys(view.checkpoints)).toEqual([first.checkpoint]);
    // The result itself is recorded.
    expect(view.stories["2-6"]?.results?.iris?.summary).toBe("Still no key.");
    // Another agent, or another story, gets its own.
    const other = await recorded("submit_result", { ...RESULT, agent: "main", status: "blocked" });
    expect(other.checkpoint).not.toBe(first.checkpoint);
  });

  it("writes neither event when the second draft is refused (all or none)", async () => {
    const { journal, recorded } = await product();
    await recorded("report_status", { agent: "iris", status: "working" });
    const before = journal.events.length;
    const product_id = journal.events[0]?.product as string;
    const valid = {
      type: "agent.status_reported",
      actor: { kind: "agent" as const, agent: "iris" },
      product: product_id,
      provenance: "untrusted" as const,
      payload: { status: "idle" },
    };
    await expect(
      journal.appendAll([valid, { ...valid, type: "checkpoint.opened", payload: { type: "x" } }]),
    ).rejects.toMatchObject({ code: ErrorCode.EVENT_INVALID });
    expect(journal.events).toHaveLength(before);
  });

  it("refuses an empty write with the same coded error as the Git journal", async () => {
    const { journal } = await product();
    await expect(journal.appendAll([])).rejects.toMatchObject({
      code: ErrorCode.UNEXPECTED,
      message_key: "error.unexpected",
      details: { reason: "no event to append" },
    });
  });
});

describe("report_measures and the verdict", () => {
  const CRITERIA = [
    { id: "tests", metric: "tests_failed", op: "<=", threshold: 0, severity: "blocking" },
    { id: "coverage", metric: "coverage", op: ">=", threshold: 80, severity: "reservation" },
  ];
  const MEASURED = {
    agent: "iris",
    type: "story",
    risk: "low",
    title: "Story 2-6 ready",
    summary: "Tests and coverage.",
    story: "2-6",
    criteria: CRITERIA,
  };

  it("fails while a measure is missing, then passes with reservations", async () => {
    const { recorded, state } = await product();
    const opened = await recorded("open_checkpoint", MEASURED);
    const id = opened.checkpoint as string;
    expect(((await state()).checkpoints[id] as CheckpointState).verdict?.result).toBe("fail");

    const measured = await recorded("report_measures", {
      agent: "iris",
      checkpoint: id,
      measures: { tests_failed: 0 },
    });
    expect(measured.type).toBe("checkpoint.measured");
    expect(measured.checkpoint).toBeUndefined();
    let checkpoint = (await state()).checkpoints[id] as CheckpointState;
    expect(checkpoint?.verdict).toMatchObject({ result: "fail", reasons: ["missing:coverage"] });

    const second = await recorded("report_measures", {
      agent: "main",
      checkpoint: id,
      measures: { coverage: 72 },
    });
    checkpoint = (await state()).checkpoints[id] as CheckpointState;
    expect(checkpoint?.measures).toEqual({
      tests_failed: { value: 0, measured_by: "iris", measured_at: measured.at },
      coverage: { value: 72, measured_by: "main", measured_at: second.at },
    });
    expect(checkpoint?.verdict).toEqual({
      result: "pass_with_reservations",
      reasons: [],
      criteria: [
        { ...CRITERIA[0], measure: 0, satisfied: true, reason: null },
        { ...CRITERIA[1], measure: 72, satisfied: false, reason: null },
      ],
    });
  });

  it("refuses an unknown checkpoint, a checkpoint without criteria, and unknown metrics", async () => {
    const { journal, call, recorded } = await product();
    const unknown = await call("report_measures", {
      agent: "iris",
      checkpoint: "G-0000000000",
      measures: { coverage: 72 },
    });
    expect(unknown.ok ? undefined : unknown.error.toPayload()).toEqual({
      code: ErrorCode.CHECKPOINT_NOT_FOUND,
      message_key: "error.checkpoint_not_found",
      details: { checkpoint: "G-0000000000" },
    });
    const plain = await recorded("open_checkpoint", DECISION);
    const measured = await recorded("open_checkpoint", MEASURED);
    const before = journal.events.length;
    for (const [checkpoint, measures] of [
      [plain.checkpoint, { coverage: 72 }],
      [measured.checkpoint, { coverage: 72, lint_errors: 3 }],
    ] as const) {
      const result = await call("report_measures", { agent: "iris", checkpoint, measures });
      expect(result.ok ? undefined : result.error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
      expect(result.ok ? undefined : result.error.details.field).toBe("measures");
    }
    expect(journal.events).toHaveLength(before);
  });
});

describe("projection of checkpoints", () => {
  const product_of = (journal: MemoryStateStore) => journal.events[0]?.product as string;
  const opening = (product: string, payload: Record<string, unknown>, story = "2-6") => ({
    type: "checkpoint.opened",
    actor: { kind: "agent" as const, agent: "iris" },
    product,
    story,
    provenance: "untrusted" as const,
    payload,
  });
  const PAYLOAD = {
    type: "story",
    risk: "low",
    irreversible: false,
    recipient_role: "tech_lead",
    confirmation: ["gesture_undo_10s"],
    title: "Ready?",
    summary: "Tests.",
    documents: [],
    blocks: [{ action: "story.review" }],
    criteria: [
      { id: "tests", metric: "tests_failed", op: "<=", threshold: 0, severity: "blocking" },
    ],
  };

  it("raises a weak signed payload to the rules, with a warning", async () => {
    const { journal, recorded } = await product();
    await recorded("report_status", { agent: "iris", status: "working" });
    const event = await journal.append(
      opening(product_of(journal), {
        ...PAYLOAD,
        type: "decision",
        risk: "high",
        recipient_role: "creator",
        confirmation: ["gesture_undo_10s"],
        options: [
          { id: "a", label: "A", consequence: "a" },
          { id: "b", label: "B", consequence: "b" },
        ],
        recommendation: "a",
      }),
    );
    const projection = await computeProjection(journal.events);
    const id = `G-${event.id.slice(-10)}`;
    const checkpoints = projection.state.checkpoints as Record<string, CheckpointState>;
    expect(checkpoints[id]?.recipient_role).toBe("tech_lead");
    expect(checkpoints[id]?.confirmation).toContain("presence");
    expect(projection.warnings).toContainEqual({
      code: "checkpoint_weak_payload",
      checkpoint: id,
      id: event.id,
      fields: ["recipient_role", "confirmation"],
    });
  });

  it("ignores a second checkpoint with the same id, with a warning", async () => {
    const { journal, recorded } = await product();
    await recorded("report_status", { agent: "iris", status: "working" });
    // Two ULIDs that end alike: the factory gives them on demand.
    const ids = ["01JZ8X4M7QK3V9T2N6R5W8Y0AB", "01JZ8X4M7RK3V9T2N6R5W8Y0AB"];
    const colliding = new MemoryStateStore({
      keys: new MemoryKeyStore(SEED),
      newId: (() => {
        let next = 0;
        return () => ids[next++] as string;
      })(),
    });
    colliding.rewrite(journal.events);
    const productId = product_of(journal);
    await colliding.append(opening(productId, PAYLOAD));
    await colliding.append(opening(productId, { ...PAYLOAD, title: "Second" }));
    const projection = await computeProjection(colliding.events);
    const checkpoints = projection.state.checkpoints as Record<string, CheckpointState>;
    expect(checkpoints["G-N6R5W8Y0AB"]?.title).toBe("Ready?");
    expect(projection.ignored).toContainEqual({ id: ids[1], reason: "checkpoint_id_collision" });
    expect(projection.warnings).toContainEqual({
      code: "checkpoint_id_collision",
      checkpoint: "G-N6R5W8Y0AB",
      ids,
    });
    expect(projection.applied).toBe(colliding.events.length - 1);
  });

  it("applies measures sorted before their checkpoint opened when it opens", async () => {
    const { journal, recorded } = await product();
    await recorded("report_status", { agent: "iris", status: "working" });
    const productId = product_of(journal);
    // Device B's clock is behind: its measures sort before the checkpoint device A opens.
    const other = new MemoryStateStore({
      keys: new MemoryKeyStore(toBase64url(new Uint8Array(32).fill(3))),
      now: () => Date.UTC(2026, 0, 1),
    });
    other.rewrite(journal.events);
    const opened = await journal.append(opening(productId, PAYLOAD));
    const id = `G-${opened.id.slice(-10)}`;
    other.rewrite([...journal.events]);
    const measured = await other.append({
      type: "checkpoint.measured",
      actor: { kind: "agent", agent: "main" },
      product: productId,
      provenance: "untrusted",
      payload: { checkpoint: id, measures: { tests_failed: 0 } },
    });
    expect(measured.id < opened.id).toBe(true);
    const projection = await computeProjection(other.events);
    const checkpoint = (projection.state.checkpoints as Record<string, CheckpointState>)[id];
    expect(checkpoint?.measures.tests_failed).toEqual({
      value: 0,
      measured_by: "main",
      measured_at: measured.at,
    });
    expect(checkpoint?.verdict?.result).toBe("pass");
  });

  it("lists waiting_on in opening order, not in id order", async () => {
    const { journal, recorded } = await product();
    await recorded("report_status", { agent: "iris", status: "working" });
    const ids = ["01JZ8X4M7QK3V9T2N6R5W8Y0ZZ", "01JZ8X4M7RK3V9T2N6R5W8Y000"];
    const ordered = new MemoryStateStore({
      keys: new MemoryKeyStore(SEED),
      newId: (() => {
        let next = 0;
        return () => ids[next++] as string;
      })(),
    });
    ordered.rewrite(journal.events);
    const productId = product_of(journal);
    await ordered.append(opening(productId, PAYLOAD));
    await ordered.append(opening(productId, PAYLOAD));
    const projection = await computeProjection(ordered.events);
    const stories = projection.state.stories as Record<string, { waiting_on: string[] }>;
    expect(stories["2-6"]?.waiting_on).toEqual(["G-N6R5W8Y0ZZ", "G-N6R5W8Y000"]);
  });
});

describe("no resolution", () => {
  it("exposes one tool only that answers a checkpoint: answer_checkpoint, from the chat", async () => {
    const registry = createCommandRegistry();
    const names = registry.agentCommands().map((command) => command.name);
    // 18 since `open_pull_request`, after `start_story` and the tools that follow it;
    // 19 with `check_ci`; 20 with `answer_checkpoint`, the only
    // one that answers a checkpoint: the creator's quoted words, never a waiver nor a signature;
    // 23 with the traceability tools (a deviation is lifted, never a checkpoint).
    // 24 with `request_creator_action`: it opens a checkpoint, never answers one;
    // 26 with Noah's `next` and `delegate`, neither of which answers one; 31 with
    // the review's tools: a review closes a pass, never a checkpoint; 32 with
    // `ask_creator`: the engine asks the creator in the AI tool's form and records
    // their click, taking nothing of the answer from the agent (its input: agent, checkpoint);
    // 37 with the memory's tools: they open a `memory` checkpoint or carry out an
    // approved one, and answer none; 38 with `leave_fast_track`: it opens the
    // checkpoint that explains the way back to the full lane, and answers none. 40 with the order
    // of the merges: one reads the queue, the other qualifies a conflict and opens a
    // `decision` for the creator. 43 with the stack to validate: `open_stack` presents
    // checkpoints it checked together, `ask_stack` and `answer_stack` record the creator's answer
    // to it, read by the engine from their own click or message (the agent gives no number and no
    // decision), and none answers a checkpoint by itself. 44 with `decide_checkpoint`:
    // the agent responsible for a point the creator did not keep decides it, as itself, never as the
    // creator (its source and its assurance are `agent`). 45 with `measure_usage`: the
    // engine reads the AI tool's traces and writes what a session consumed, and answers nothing. 46 with
    // `check_environment`: it reads the machine and writes nothing.
    // 51 with `critique`: it records a report and the creator's gestures on objections, answers no checkpoint.
    // 52 with `run_proof_command`: the engine runs a command the creator accepted and records the proof, answers no checkpoint.
    // 54 with `check_write`: the hook before a write, it refuses a write and answers no checkpoint.
    // 55 with `correct_course`: it records a change of course and the creator's gestures on its stack, answers no checkpoint.
    // 56 with `round_table`: it records the end of a round table and who takes its gesture, answers no checkpoint.
    // 58 with `review_tests`: it records the marks of a review of the tests and the work to decide, answers no checkpoint.
    // 59 with `loop`: it records a stop of the bounded loop or an approach tried, answers no checkpoint.
    // 60 with `ready`: it records the readiness report and the creator's gestures, opens a decision, answers no checkpoint.
    // 61 with `export_review`: it writes a review request that stands alone in a file, answers no checkpoint.
    // 62 with `acceptance_qa`: it records the closed report of the acceptance QA in a browser, answers no checkpoint.
    expect(names).toHaveLength(62);
    const answering = names.filter((name) =>
      /resolve|validate|waive|close|approve|answer|decide|ask_creator|ask_stack/.test(name),
    );
    expect(answering).toEqual([
      "answer_checkpoint",
      "decide_checkpoint",
      "ask_creator",
      "ask_stack",
      "answer_stack",
    ]);
    // The stack tools take the stack and, from the chat, the creator's words: no number, no decision.
    const shapeOf = (name: string) =>
      Object.keys(
        ((
          registry.agentCommands().find((command) => command.name === name)?.inputSchema as
            | { shape: object }
            | undefined
        )?.shape ?? {}) as object,
      ).sort();
    expect(shapeOf("ask_stack")).toEqual(["agent", "stack"]);
    // `via: "question_tool"` records the answers the tool's hook proved, without a quote.
    expect(shapeOf("answer_stack")).toEqual(["agent", "quote", "session", "stack", "via"]);
    expect(shapeOf("open_stack")).toEqual(["agent", "checkpoints"]);
    const ask = registry.agentCommands().find((command) => command.name === "ask_creator");
    const shape = (ask?.inputSchema as { shape: object } | undefined)?.shape ?? {};
    expect(Object.keys(shape).sort()).toEqual(["agent", "checkpoint"]);
  });
});
