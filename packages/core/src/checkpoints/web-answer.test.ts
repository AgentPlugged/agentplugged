import { toBase64url } from "@agentplugged/crypto";
import { ANSWER_ORDER_CODES, type AnswerCheckpointParams } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  AgentSession,
  answeredElsewhere,
  type CheckpointState,
  type CommandContext,
  carryOutWebAnswers,
  computeProjection,
  createCommandRegistry,
  initCommand,
  MemoryKeyStore,
  MemoryStateStore,
  nextAgentCommand,
  type RecordedEvent,
  resolveProfile,
  syncCommand,
  type ToolProbe,
  undoWebAnswer,
  writeWebAnswer,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";

/**
 * An answer given from the web view: one signed order, recorded by the machine with its source
 * and the order that carried it, for every kind of point the web answers by itself.
 */

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const SEED = toBase64url(new Uint8Array(32).fill(23));
const START = Date.UTC(2026, 9, 18, 9, 0, 0);
const ORDER = "01J9ZQ4V8E3M5N7P9R1S3T5V80";
const UNDO_ORDER = "01J9ZQ4V8E3M5N7P9R1S3T5V81";
const DEVICE = "browser:abcdefghijklmnop";

const OPTIONS = [
  { id: "stripe", label: "Stripe", consequence: "Fast to ship." },
  { id: "paddle", label: "Paddle", consequence: "Handles VAT for us." },
];

async function product() {
  const files = new MemoryFiles();
  let clock = START;
  let step = 1000;
  const keys = new MemoryKeyStore(SEED);
  const journal = new MemoryStateStore({
    keys,
    now: () => {
      clock += step;
      return clock;
    },
  });
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
  const agent: CommandContext = {
    ...human,
    actor: "agent",
    session: new AgentSession(START),
    now: () => START + 3_600_000,
  };
  const registry = createCommandRegistry();
  const open = async (fields: Record<string, unknown> = {}) => {
    const result = await registry.run("open_checkpoint", agent, {
      agent: "main",
      type: "decision",
      risk: "medium",
      title: "Which payment provider?",
      summary: "Stripe or Paddle.",
      options: OPTIONS,
      recommendation: "paddle",
      ...fields,
    });
    if (!result.ok) throw new Error(`open_checkpoint failed: ${result.error.code}`);
    return (result.value as RecordedEvent).checkpoint as string;
  };
  const productId = async () => (await journal.productId()) as string;
  const checkpoint = async (id: string) =>
    (
      (await computeProjection((await journal.list()).events)).state.checkpoints as Record<
        string,
        CheckpointState
      >
    )[id] as CheckpointState;
  // Answers and lets the undo window pass, as the machine does: the answer is decided.
  const answer = async (params: AnswerCheckpointParams, at = START + 7_200_000) => {
    const written = await writeWebAnswer(
      journal,
      await productId(),
      { params, order: ORDER, device: DEVICE },
      () => at,
    );
    if (written.ok && written.held) await carryOutWebAnswers(journal, await productId(), () => at);
    return written;
  };
  // The clock the window is measured on: one millisecond per event from `ms`.
  const time = (ms: number) => {
    clock = ms;
    step = 1;
  };
  const hold = async (
    params: AnswerCheckpointParams,
    order = ORDER,
    at = () => clock,
    device = DEVICE,
  ) => writeWebAnswer(journal, await productId(), { params, order, device }, at);
  const undo = async (checkpoint: string, at = () => clock, device = DEVICE) =>
    undoWebAnswer(
      journal,
      await productId(),
      { params: { checkpoint }, order: UNDO_ORDER, device },
      at,
    );
  const carryOut = async (at = () => clock) => carryOutWebAnswers(journal, await productId(), at);
  return { journal, open, checkpoint, answer, productId, time, hold, undo, carryOut, agent };
}

describe("answering from the web", () => {
  it("records a choice with its source, its assurance, the order and the device", async () => {
    const p = await product();
    const id = await p.open();
    const written = await p.answer({ checkpoint: id, decision: "option_chosen", option: "paddle" });
    expect(written).toMatchObject({ ok: true });
    const point = await p.checkpoint(id);
    expect(point.status).toBe("resolved");
    expect(point.resolution).toMatchObject({
      decision: "option_chosen",
      option: "paddle",
      source: "web",
      assurance: "device",
    });
    const events = (await p.journal.list()).events;
    const event = events.find((entry) => entry.type === "checkpoint.web_answered");
    expect(event?.actor.kind).toBe("system");
    expect(event?.payload).toMatchObject({ source: "web", order: ORDER, device: DEVICE });
  });

  it("answers an irreversible, high-risk point with the same single gesture", async () => {
    const p = await product();
    const id = await p.open({
      type: "release",
      risk: "high",
      title: "Deploy to production",
      options: undefined,
      recommendation: undefined,
    });
    const written = await p.answer({ checkpoint: id, decision: "approved" });
    expect(written).toMatchObject({ ok: true });
    expect((await p.checkpoint(id)).resolution?.source).toBe("web");
  });

  it("keeps the note given with a refusal", async () => {
    const p = await product();
    const id = await p.open();
    const written = await p.answer({ checkpoint: id, decision: "rejected", note: "Not now." });
    expect(written).toMatchObject({ ok: true });
    expect((await p.checkpoint(id)).resolution?.note).toBe("Not now.");
  });

  it("writes nothing for a point already answered, unknown, or an option it lacks", async () => {
    const p = await product();
    const id = await p.open();
    expect(await p.answer({ checkpoint: id, decision: "option_chosen", option: "nope" })).toEqual({
      ok: false,
      code: ANSWER_ORDER_CODES.refused,
    });
    expect(await p.answer({ checkpoint: "G-0000000000", decision: "approved" })).toEqual({
      ok: false,
      code: ANSWER_ORDER_CODES.notFound,
    });
    expect(
      (await p.answer({ checkpoint: id, decision: "option_chosen", option: "stripe" })).ok,
    ).toBe(true);
    const before = (await p.journal.list()).events.length;
    expect(await p.answer({ checkpoint: id, decision: "option_chosen", option: "paddle" })).toEqual(
      { ok: false, code: ANSWER_ORDER_CODES.notOpen },
    );
    expect((await p.journal.list()).events).toHaveLength(before);
  });

  it("reads the journal again when it writes: an answer that lands in between wins, the other writes nothing", async () => {
    const p = await product();
    const id = await p.open();
    // The second order first reads a listing from before the first answer was written.
    const stale = await p.journal.list();
    let first = true;
    const lagging = new Proxy(p.journal, {
      get(target, key) {
        if (key === "list") {
          return async () => {
            if (!first) return await target.list();
            first = false;
            return stale;
          };
        }
        const value = Reflect.get(target, key) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(
      (await p.answer({ checkpoint: id, decision: "option_chosen", option: "stripe" })).ok,
    ).toBe(true);
    const late = await writeWebAnswer(
      lagging,
      await p.productId(),
      {
        params: { checkpoint: id, decision: "option_chosen", option: "paddle" },
        order: ORDER,
        device: DEVICE,
      },
      () => START + 7_200_000,
    );
    expect(late).toEqual({ ok: false, code: ANSWER_ORDER_CODES.notOpen });
    const written = (await p.journal.list()).events.filter(
      (event) => event.type === "checkpoint.web_answered",
    );
    expect(written).toHaveLength(1);
  });

  it("ignores an answer that is not the machine's, so that no agent can answer for the creator", async () => {
    const p = await product();
    const id = await p.open();
    await p.journal.appendAll([
      {
        type: "checkpoint.web_answered",
        actor: { kind: "agent", agent: "main" },
        product: await p.productId(),
        provenance: "trusted",
        payload: {
          checkpoint: id,
          decision: "approved",
          source: "web",
          order: ORDER,
          device: DEVICE,
        },
      },
    ]);
    const point = await p.checkpoint(id);
    expect(point.status).toBe("open");
    expect(point.resolution).toBeNull();
    const state = await computeProjection((await p.journal.list()).events);
    expect(state.ignored.map((entry) => entry.reason)).toContain("invalid");
  });

  it("leaves to other gestures the points the web does not answer by itself", () => {
    const base = { type: "decision", source: null, request: null } as const;
    // A story's merge is answered from the web: the machine merges before it writes the answer.
    expect(answeredElsewhere({ ...base, type: "story", source: "merge" }, "approved")).toBe(false);
    expect(answeredElsewhere({ ...base, type: "memory" }, "approved")).toBe(true);
    const action = { kind: "step_skip" } as never;
    expect(answeredElsewhere({ ...base, creator_action: action }, "approved")).toBe(true);
    // Refusing an action carries nothing out: the web does it.
    expect(answeredElsewhere({ ...base, creator_action: action }, "rejected")).toBe(false);
    expect(answeredElsewhere(base, "approved")).toBe(false);
  });
});

describe("holding an answer for the undo window", () => {
  const CHOICE = { decision: "option_chosen", option: "paddle" } as const;
  const T0 = START + 10_000_000;

  it("holds the answer of a point that can be undone and leaves the point open", async () => {
    const p = await product();
    const id = await p.open();
    p.time(T0);
    const written = await p.hold({ checkpoint: id, ...CHOICE });
    expect(written).toMatchObject({ ok: true, held: true });
    const point = await p.checkpoint(id);
    expect(point.status).toBe("open");
    expect(point.resolution).toBeNull();
    expect(point.blocks_lifted).toBe(false);
    expect(point.pending_answer).toMatchObject({ decision: "option_chosen", option: "paddle" });
    const until = Date.parse(point.pending_answer?.until ?? "");
    expect(until - Date.parse(point.pending_answer?.at ?? "")).toBe(10_000);
    // No validation is recorded before the answer is decided.
    const events = (await p.journal.list()).events.map((event) => event.type);
    expect(events).toContain("checkpoint.web_held");
    expect(events).not.toContain("checkpoint.web_answered");
  });

  it("decides a high-risk or irreversible point at once, with no window", async () => {
    const p = await product();
    const risky = await p.open({
      type: "release",
      risk: "high",
      options: undefined,
      recommendation: undefined,
    });
    const written = await p.hold({ checkpoint: risky, decision: "approved" });
    expect(written).toMatchObject({ ok: true, held: false });
    expect((await p.checkpoint(risky)).status).toBe("resolved");
  });

  it("takes the held answer back inside the window: nothing was ever decided", async () => {
    const p = await product();
    const id = await p.open();
    p.time(T0);
    await p.hold({ checkpoint: id, ...CHOICE });
    const undone = await p.undo(id);
    expect(undone).toMatchObject({ ok: true });
    const point = await p.checkpoint(id);
    expect(point.status).toBe("open");
    expect(point.pending_answer ?? null).toBeNull();
    expect(point.resolution).toBeNull();
    // Nothing is left for the end of the window to carry out.
    expect(await p.carryOut(() => T0 + 100_000)).toMatchObject({ decided: 0 });
    expect((await p.checkpoint(id)).status).toBe("open");
    // The point can be answered again.
    expect(await p.hold({ checkpoint: id, decision: "approved" })).toMatchObject({
      ok: true,
      held: true,
    });
  });

  it("refuses to take back an answer after the window, or when none is held", async () => {
    const p = await product();
    const id = await p.open();
    p.time(T0);
    expect(await p.undo(id)).toEqual({ ok: false, code: ANSWER_ORDER_CODES.notHeld });
    await p.hold({ checkpoint: id, ...CHOICE });
    const before = (await p.journal.list()).events.length;
    const late = await p.undo(id, () => T0 + 10_500);
    expect(late).toEqual({ ok: false, code: ANSWER_ORDER_CODES.notHeld });
    expect((await p.journal.list()).events).toHaveLength(before);
  });

  it("decides the answer when the window is over, once, even if nobody is looking", async () => {
    const p = await product();
    const id = await p.open();
    p.time(T0);
    await p.hold({ checkpoint: id, ...CHOICE });
    const early = await p.carryOut(() => T0 + 5_000);
    expect(early.decided).toBe(0);
    expect(early.next).toBeGreaterThan(T0);
    expect((await p.checkpoint(id)).status).toBe("open");
    const done = await p.carryOut(() => T0 + 11_000);
    expect(done).toEqual({ decided: 1, failed: 0, next: undefined });
    const point = await p.checkpoint(id);
    expect(point.status).toBe("resolved");
    expect(point.resolution).toMatchObject({
      source: "web",
      assurance: "device",
      option: "paddle",
    });
    expect(point.pending_answer ?? null).toBeNull();
    expect(await p.carryOut(() => T0 + 12_000)).toEqual({ decided: 0, failed: 0, next: undefined });
    const answered = (await p.journal.list()).events.filter(
      (event) => event.type === "checkpoint.web_answered",
    );
    expect(answered).toHaveLength(1);
    expect(answered[0]?.payload).toMatchObject({ order: ORDER, device: DEVICE });
  });

  it("never holds a second answer beside the first, from another tab", async () => {
    const p = await product();
    const id = await p.open();
    p.time(T0);
    await p.hold({ checkpoint: id, ...CHOICE });
    const other = await p.hold(
      { checkpoint: id, decision: "option_chosen", option: "stripe" },
      UNDO_ORDER,
    );
    expect(other).toEqual({ ok: false, code: ANSWER_ORDER_CODES.notOpen });
    expect((await p.checkpoint(id)).pending_answer?.option).toBe("paddle");
  });

  it("lets another answer win: the held one falls and is never carried out", async () => {
    const p = await product();
    const id = await p.open();
    p.time(T0);
    await p.hold({ checkpoint: id, ...CHOICE });
    // Another surface decides the same point during the window: the first decided answer wins.
    await p.journal.appendAll([
      {
        type: "checkpoint.web_answered",
        actor: { kind: "system" },
        product: await p.productId(),
        provenance: "trusted",
        payload: {
          checkpoint: id,
          decision: "option_chosen",
          option: "stripe",
          source: "web",
          order: UNDO_ORDER,
          device: DEVICE,
        },
      },
    ]);
    const point = await p.checkpoint(id);
    expect(point.status).toBe("resolved");
    expect(point.resolution?.option).toBe("stripe");
    expect(point.pending_answer ?? null).toBeNull();
    expect(await p.carryOut(() => T0 + 20_000)).toEqual({ decided: 0, failed: 0, next: undefined });
    expect(await p.undo(id)).toEqual({ ok: false, code: ANSWER_ORDER_CODES.notHeld });
  });

  it("answers again a point whose held answer the machine never carried out", async () => {
    const p = await product();
    const id = await p.open();
    p.time(T0);
    await p.hold({ checkpoint: id, ...CHOICE });
    const again = await p.hold(
      { checkpoint: id, decision: "approved" },
      UNDO_ORDER,
      () => T0 + 60_000,
    );
    expect(again).toMatchObject({ ok: true, held: true });
  });

  it("ignores a held answer or an undo that the machine did not write", async () => {
    const p = await product();
    const id = await p.open();
    const productId = await p.productId();
    await p.journal.appendAll([
      {
        type: "checkpoint.web_held",
        actor: { kind: "agent", agent: "main" },
        product: productId,
        provenance: "trusted",
        payload: {
          checkpoint: id,
          decision: "approved",
          source: "web",
          order: ORDER,
          device: DEVICE,
        },
      },
    ]);
    expect((await p.checkpoint(id)).pending_answer ?? null).toBeNull();
    p.time(T0);
    await p.hold({ checkpoint: id, ...CHOICE });
    await p.journal.appendAll([
      {
        type: "checkpoint.web_hold_cancelled",
        actor: { kind: "agent", agent: "main" },
        product: productId,
        provenance: "trusted",
        payload: { checkpoint: id, held: ORDER, order: UNDO_ORDER, device: DEVICE },
      },
    ]);
    expect((await p.checkpoint(id)).pending_answer).not.toBeNull();
  });
});

describe("what the agent that opened a point learns of an answer from the web", () => {
  const told = async (p: Awaited<ReturnType<typeof product>>) => {
    const result = await nextAgentCommand.run(p.agent, {});
    if (!result.ok) throw new Error(`next failed: ${result.error.code}`);
    return (result.value as { web_answers?: unknown[] }).web_answers;
  };

  it("finds the answer and its reason in its next reading, until it writes something", async () => {
    const p = await product();
    const id = await p.open();
    expect(await told(p)).toBeUndefined();
    await p.answer({
      checkpoint: id,
      decision: "changes_requested",
      note: "Offer a monthly plan.",
    });
    expect(await told(p)).toEqual([
      {
        agent: "main",
        checkpoint: id,
        title: "Which payment provider?",
        decision: "changes_requested",
        note: "Offer a monthly plan.",
      },
    ]);
    // Read again, still told: nothing was written, the agent may not have seen it yet.
    expect(await told(p)).toHaveLength(1);
    // The agent acts (here it opens the point that supersedes the refused one): nothing more to tell.
    await p.open({ supersedes: id });
    expect(await told(p)).toBeUndefined();
  });

  it("tells the option chosen to the agent that opened the point", async () => {
    const p = await product();
    const id = await p.open();
    await p.answer({ checkpoint: id, decision: "option_chosen", option: "stripe" });
    expect(await told(p)).toMatchObject([{ agent: "main", option: "stripe" }]);
  });

  it("tells nothing of an answer given in the chat", async () => {
    const p = await product();
    const id = await p.open();
    await p.journal.appendAll([
      {
        type: "checkpoint.answered",
        actor: { kind: "agent", agent: "main" },
        product: await p.productId(),
        provenance: "trusted",
        payload: {
          checkpoint: id,
          decision: "option_chosen",
          option: "stripe",
          source: "chat",
          quote: "stripe",
        },
      },
    ]);
    expect(await told(p)).toBeUndefined();
  });
});

describe("answering from the phone", () => {
  const PHONE = "phone:abcdefghijklmnop";
  const T0 = START + 10_000_000;

  it("records the answer with the source mobile, drawn from the kind of the device", async () => {
    const p = await product();
    const id = await p.open({
      type: "release",
      risk: "high",
      options: undefined,
      recommendation: undefined,
    });
    p.time(T0);
    const written = await p.hold({ checkpoint: id, decision: "approved" }, ORDER, undefined, PHONE);
    expect(written).toMatchObject({ ok: true, held: false });
    const point = await p.checkpoint(id);
    expect(point.status).toBe("resolved");
    expect(point.resolution).toMatchObject({ source: "mobile", assurance: "device" });
    const event = (await p.journal.list()).events.find(
      (entry) => entry.type === "checkpoint.web_answered",
    );
    expect(event?.actor.kind).toBe("system");
    expect(event?.payload).toMatchObject({ source: "mobile", order: ORDER, device: PHONE });
  });

  it("holds a reversible answer for the window, and the phone takes it back: nothing is decided", async () => {
    const p = await product();
    const id = await p.open();
    p.time(T0);
    const held = await p.hold(
      { checkpoint: id, decision: "option_chosen", option: "paddle" },
      ORDER,
      undefined,
      PHONE,
    );
    expect(held).toMatchObject({ ok: true, held: true });
    expect(await p.checkpoint(id)).toMatchObject({
      status: "open",
      pending_answer: { device: PHONE },
    });
    expect(await p.undo(id, undefined, PHONE)).toMatchObject({ ok: true });
    expect(await p.checkpoint(id)).toMatchObject({ status: "open", resolution: null });
    // Past the window nothing was decided.
    expect(await p.carryOut(() => T0 + 100_000)).toMatchObject({ decided: 0 });
    expect((await p.journal.list()).events.map((entry) => entry.type)).not.toContain(
      "checkpoint.web_answered",
    );
  });

  it("decides a held answer of the phone when the window is over, with the same order and device", async () => {
    const p = await product();
    const id = await p.open();
    p.time(T0);
    await p.hold({ checkpoint: id, decision: "approved" }, ORDER, undefined, PHONE);
    const done = await p.carryOut(() => T0 + 11_000);
    expect(done.decided).toBe(1);
    expect((await p.checkpoint(id)).resolution).toMatchObject({
      source: "mobile",
      assurance: "device",
    });
    const events = (await p.journal.list()).events;
    const held = events.find((entry) => entry.type === "checkpoint.web_held");
    const answered = events.find((entry) => entry.type === "checkpoint.web_answered");
    expect(held?.payload).toMatchObject({ source: "mobile", device: PHONE, order: ORDER });
    expect(answered?.payload).toMatchObject({ source: "mobile", device: PHONE, order: ORDER });
  });

  it("refuses an event that names the web for a phone, or a phone for a browser", async () => {
    const p = await product();
    const id = await p.open();
    const forged = async (source: string, device: string) =>
      p.journal.appendAll([
        {
          type: "checkpoint.web_answered",
          actor: { kind: "system" },
          product: await p.productId(),
          provenance: "trusted",
          payload: { checkpoint: id, decision: "approved", source, order: ORDER, device },
        },
      ]);
    await expect(forged("web", PHONE)).rejects.toThrow();
    await expect(forged("mobile", DEVICE)).rejects.toThrow();
    expect((await p.checkpoint(id)).status).toBe("open");
  });

  it("tells the agent that opened the point an answer given from the phone", async () => {
    const p = await product();
    const id = await p.open();
    p.time(T0);
    await p.hold(
      { checkpoint: id, decision: "changes_requested", note: "Offer a monthly plan." },
      ORDER,
      undefined,
      PHONE,
    );
    await p.carryOut(() => T0 + 11_000);
    const result = await nextAgentCommand.run(p.agent, {});
    if (!result.ok) throw new Error(`next failed: ${result.error.code}`);
    expect((result.value as { web_answers?: unknown[] }).web_answers).toMatchObject([
      { agent: "main", checkpoint: id, decision: "changes_requested" },
    ]);
  });
});
