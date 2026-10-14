import { toBase64url } from "@agentplugged/crypto";
import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  AgentSession,
  type CheckpointState,
  type CommandContext,
  computeProjection,
  createCommandRegistry,
  initCommand,
  MemoryKeyStore,
  MemoryStateStore,
  NOAH_COMMANDS,
  type RecordedEvent,
  resolveProfile,
  syncCommand,
  type ToolProbe,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";

/**
 * A point the creator did not keep is decided by the agent responsible for it, as the
 * agent, with its reason; the creator's own points stay theirs; the creator can reopen a decision.
 */

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const SEED = toBase64url(new Uint8Array(32).fill(21));
const START = Date.UTC(2026, 9, 5, 22, 0, 0);
const CONFIG = ".agentplugged/method.yaml";

const OPTIONS = [
  { id: "stripe", label: "Stripe", consequence: "Fast to ship." },
  { id: "paddle", label: "Paddle", consequence: "Handles VAT for us." },
];

const DECISION = {
  agent: "main",
  type: "decision",
  risk: "medium",
  title: "Which payment provider?",
  summary: "Stripe or Paddle.",
  options: OPTIONS,
  recommendation: "paddle",
};

/** The creator's choice of points, written where the engine reads it (no main branch here). */
async function setPoints(files: MemoryFiles, points: readonly string[], mode?: string) {
  const text = (await files.readText(CONFIG)) as string;
  const modeLine = mode === undefined ? "" : `  mode: ${mode}\n`;
  await files.writeText(
    CONFIG,
    `${text}${text.endsWith("\n") ? "" : "\n"}validation:\n${modeLine}  points: [${points.join(", ")}]\n`,
  );
}

async function product() {
  const files = new MemoryFiles();
  let clock = START;
  const keys = new MemoryKeyStore(SEED);
  const journal = new MemoryStateStore({
    keys,
    now: () => {
      clock += 1000;
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
  const call = (name: string, input: Record<string, unknown>) => registry.run(name, agent, input);
  const open = async (fields: Record<string, unknown> = {}) => {
    const result = await call("open_checkpoint", { ...DECISION, ...fields });
    if (!result.ok) {
      throw new Error(`open_checkpoint failed: ${result.error.code}`);
    }
    return (result.value as RecordedEvent).checkpoint as string;
  };
  const projection = async () => computeProjection((await journal.list()).events);
  const checkpoint = async (id: string) =>
    ((await projection()).state.checkpoints as Record<string, CheckpointState>)[
      id
    ] as CheckpointState;
  const decide = (id: string, fields: Record<string, unknown> = {}) =>
    call("decide_checkpoint", {
      agent: "main",
      checkpoint: id,
      decision: "option_chosen",
      option: "paddle",
      reason: "Paddle handles the VAT, which the brief asks for.",
      ...fields,
    });
  return { files, journal, call, open, projection, checkpoint, decide };
}

const errorCode = (result: { ok: boolean; error?: { code: string } }) =>
  result.ok ? undefined : result.error?.code;
const errorDetails = (result: { ok: boolean; error?: { toPayload(): { details: unknown } } }) =>
  (result.ok ? undefined : result.error?.toPayload().details) as Record<string, unknown>;

describe("decide_checkpoint", () => {
  it("records the decision of the agent responsible, as the agent, with its reason", async () => {
    const { files, open, decide, checkpoint, projection } = await product();
    await setPoints(files, ["release"]);
    const id = await open({ blocks: [{ action: "story.review", story: "1-1" }], story: "1-1" });
    expect((await checkpoint(id)).status).toBe("open");
    const decided = await decide(id);
    expect(decided.ok).toBe(true);
    expect(await checkpoint(id)).toMatchObject({
      status: "resolved",
      blocks_lifted: true,
      resolution: {
        decision: "option_chosen",
        option: "paddle",
        source: "agent",
        assurance: "agent",
        relayed_by: "main",
        note: "Paddle handles the VAT, which the brief asks for.",
        quote: null,
      },
    });
    // The history tells it apart from an answer of the creator.
    const validations = (await projection()).state.validations as Array<Record<string, unknown>>;
    expect(validations.at(-1)).toMatchObject({
      checkpoint: id,
      source: "agent",
      assurance: "agent",
      relayed_by: "main",
    });
  });

  it("keeps the refusal of an agent as a refusal: the blocks stay, the reason is its note", async () => {
    const { files, open, decide, checkpoint } = await product();
    await setPoints(files, []);
    const id = await open({ blocks: [{ action: "story.review", story: "1-1" }], story: "1-1" });
    expect(
      (
        await decide(id, {
          decision: "changes_requested",
          option: undefined,
          reason: "The brief does not say which provider.",
        })
      ).ok,
    ).toBe(true);
    expect(await checkpoint(id)).toMatchObject({
      status: "resolved",
      blocks_lifted: false,
      resolution: {
        decision: "changes_requested",
        source: "agent",
        note: "The brief does not say which provider.",
      },
    });
  });

  it("refuses everything while the creator has not chosen their points", async () => {
    const { open, decide, checkpoint } = await product();
    const id = await open();
    const refused = await decide(id);
    expect(errorCode(refused)).toBe(ErrorCode.INVALID_ARGUMENTS);
    expect(errorDetails(refused)).toMatchObject({ why: "not_configured", checkpoint: id });
    expect((await checkpoint(id)).status).toBe("open");
  });

  it("refuses a kind of point the creator keeps for themselves", async () => {
    const { files, open, decide, checkpoint } = await product();
    await setPoints(files, ["release"]);
    const release = await open({
      type: "release",
      options: undefined,
      recommendation: undefined,
      title: "Release 1.0",
    });
    const refused = await decide(release, { decision: "approved", option: undefined });
    expect(errorDetails(refused)).toMatchObject({ why: "kept" });
    expect((await checkpoint(release)).status).toBe("open");
    // Not keeping the releases hands them to the agents.
    const text = (await files.readText(CONFIG)) as string;
    await files.writeText(CONFIG, text.replace("points: [release]", "points: [framing]"));
    expect((await decide(release, { decision: "approved", option: undefined })).ok).toBe(true);
  });

  it("never decides what asks for the creator's own gesture or for their help", async () => {
    const { files, open, decide } = await product();
    await setPoints(files, []);
    const permission = await open({
      type: "permission",
      options: undefined,
      recommendation: undefined,
      title: "Use the production key",
    });
    const refused = await decide(permission, { decision: "approved", option: undefined });
    expect(errorDetails(refused)).toMatchObject({ why: "escalation" });
  });

  it("keeps a high risk for the creator at the strict level, and decides the rest", async () => {
    const { files, open, decide } = await product();
    await setPoints(files, [], "strict");
    const high = await open({ risk: "high" });
    expect(errorDetails(await decide(high))).toMatchObject({ why: "strict_high_risk" });
    const medium = await open({ risk: "medium" });
    expect((await decide(medium)).ok).toBe(true);
  });

  it("refuses a decision that does not fit the point, and one for a closed point", async () => {
    const { files, open, decide } = await product();
    await setPoints(files, []);
    const id = await open();
    expect(errorCode(await decide(id, { option: "unknown" }))).toBe(ErrorCode.INVALID_ARGUMENTS);
    expect(errorCode(await decide(id, { decision: "waived" as never }))).toBe(
      ErrorCode.INVALID_ARGUMENTS,
    );
    expect(
      errorCode(await decide(id, { decision: "approved", option: undefined })),
    ).toBeUndefined();
    // Already decided: nothing more to decide.
    expect(errorCode(await decide(id))).toBe(ErrorCode.CHECKPOINT_NOT_OPEN);
    expect(errorCode(await decide("G-0000000000"))).toBe(ErrorCode.CHECKPOINT_NOT_FOUND);
  });

  it("hands a point back to the creator when the agent cannot decide it", async () => {
    const { files, open, decide, checkpoint, call } = await product();
    await setPoints(files, []);
    const id = await open();
    const handed = await decide(id, {
      decision: "escalate",
      option: undefined,
      reason: "The forge refuses and nobody here can fix it.",
    });
    expect(handed.ok).toBe(true);
    expect(await checkpoint(id)).toMatchObject({
      status: "open",
      resolution: null,
      escalated: { by: "main", reason: "The forge refuses and nobody here can fix it." },
    });
    // Now it is theirs: no agent decides it any more.
    expect(errorDetails(await decide(id))).toMatchObject({ why: "escalated" });
    // The creator answers it as any point.
    const answered = await call("answer_checkpoint", {
      agent: "main",
      checkpoint: id,
      decision: "option_chosen",
      option: "stripe",
      quote: "Stripe, please.",
    });
    expect(answered.ok).toBe(true);
    expect(await checkpoint(id)).toMatchObject({
      status: "resolved",
      resolution: { option: "stripe", source: "chat" },
    });
  });

  it("lets the creator reopen what an agent decided: it waits for their own answer", async () => {
    const { files, open, decide, checkpoint, call } = await product();
    await setPoints(files, []);
    const id = await open({ blocks: [{ action: "story.review", story: "1-1" }], story: "1-1" });
    await decide(id);
    expect((await checkpoint(id)).blocks_lifted).toBe(true);
    const reopened = await call("answer_checkpoint", {
      agent: "main",
      checkpoint: id,
      decision: "reopen",
      quote: "Non, rouvre celui-là, je veux choisir moi-même.",
    });
    expect(reopened.ok).toBe(true);
    expect(await checkpoint(id)).toMatchObject({
      status: "open",
      resolution: null,
      blocks_lifted: false,
      reopened_at: expect.any(String),
    });
    // Reopened, it is the creator's whatever they chose to keep.
    expect(errorDetails(await decide(id))).toMatchObject({ why: "reopened" });
  });

  it("never lets an agent write a decision the engine would refuse: the journal ignores it", async () => {
    const { files, open, journal, projection, checkpoint } = await product();
    await setPoints(files, []);
    const permission = await open({
      type: "permission",
      options: undefined,
      recommendation: undefined,
      title: "Use the production key",
    });
    const product_ = (await journal.productId()) as string;
    await journal.appendAll([
      {
        type: "checkpoint.decided",
        actor: { kind: "agent", agent: "main" },
        product: product_,
        provenance: "trusted",
        payload: { checkpoint: permission, decision: "approved", reason: "I decide for them." },
      },
    ]);
    expect((await checkpoint(permission)).status).toBe("open");
    expect((await projection()).ignored.map((entry) => entry.reason)).toContain("invalid");
  });

  it("refuses Noah's name, and never trusts a decision of an agent as the creator's proof", async () => {
    const { files, open, decide } = await product();
    await setPoints(files, []);
    const id = await open();
    expect(errorCode(await decide(id, { agent: "noah" }))).toBe(ErrorCode.ROLE_FORBIDDEN);
  });

  it("is a tool of the agents responsible, never of Noah", () => {
    expect(NOAH_COMMANDS.has("decide_checkpoint")).toBe(false);
  });
});

describe("a server older than the installed engine", () => {
  it("says so in next and get_state, with the gesture, and says nothing when the versions match", async () => {
    const { call } = await product();
    const same = await call("next", {});
    expect(same.ok && (same.value as Record<string, unknown>).engine_update).toBeUndefined();
    const registry = createCommandRegistry();
    const stale = { installedEngineVersion: async () => "2.0.0" };
    const { files, journal } = await product();
    const context: CommandContext = {
      files,
      tools: NO_TOOL,
      method: shippedMethod(),
      actor: "agent",
      engineVersion: "1.0.0",
      journal,
      ...stale,
    };
    const next = await registry.run("next", context, {});
    expect(next.ok).toBe(true);
    expect((next as { value: { engine_update: unknown } }).value.engine_update).toMatchObject({
      running: "1.0.0",
      installed: "2.0.0",
      action: expect.stringContaining("Reconnect"),
    });
    const state = await registry.run("get_state", context, {});
    expect((state as { value: { engine_update: unknown } }).value.engine_update).toMatchObject({
      installed: "2.0.0",
    });
  });
});

describe("next and get_state with the creator's points", () => {
  it("says which points the creator keeps, and gives a delegated point to an agent", async () => {
    const { files, open, call } = await product();
    const before = await call("next", {});
    expect(
      before.ok && (before.value as { validation: { points: unknown } }).validation.points,
    ).toMatchObject({ configured: false });
    await setPoints(files, ["framing", "release"]);
    const id = await open();
    const after = await call("next", {});
    expect(after.ok).toBe(true);
    const value = (after as { value: Record<string, unknown> }).value;
    expect(value).toMatchObject({
      step: "point_decision",
      agent: "iris",
      checkpoint: id,
      validation: {
        points: {
          configured: true,
          fixed: ["framing", "release"],
          delegated: ["architecture", "breakdown", "merge", "publication"],
        },
      },
    });
    const state = await call("get_state", { full: true });
    expect(
      state.ok &&
        (state.value as { validation: { points: { configured: boolean } } }).validation.points,
    ).toMatchObject({ configured: true });
  });
});
