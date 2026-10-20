import { toBase64url } from "@agentplugged/crypto";
import { ErrorCode, TEAM_EVENT_TYPES } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type CommandContext,
  createCommandRegistry,
  initCommand,
  MemoryKeyStore,
  MemoryStateStore,
  type NextResult,
  resolveProfile,
  type ToolProbe,
} from "../index.js";
import { fixtureAgent, MemoryFiles, shippedMethod } from "../testing/memory-files.js";

const METHOD = shippedMethod({
  ...fixtureAgent("noah"),
  ...fixtureAgent("maya"),
  ...fixtureAgent("iris"),
});

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const SEED = toBase64url(new Uint8Array(32).fill(7));

async function product() {
  const files = new MemoryFiles();
  const keys = new MemoryKeyStore(SEED);
  let at = Date.UTC(2026, 9, 20, 9, 0, 0);
  const journal = new MemoryStateStore({
    keys,
    now: () => {
      at += 1000;
      return at;
    },
  });
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: METHOD,
    actor: "human",
    engineVersion: "1.3.0",
    keys,
  };
  const init = await initCommand.run(human, { profile: resolveProfile("new-product", {}) });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const agent: CommandContext = { ...human, actor: "agent", journal };
  const registry = createCommandRegistry();
  const call = (name: string, input: Record<string, unknown> = {}) =>
    registry.run(name, agent, input);
  const step = async () => {
    const result = await call("next");
    if (!result.ok) throw new Error(`next failed: ${result.error.code}`);
    return result.value as NextResult;
  };
  const productId =
    /product_id: "?([0-9A-Z]{26})/.exec(files.files.get(".agentplugged/method.yaml") ?? "")?.[1] ??
    "";
  /** An event as the bridge writes it for the creator's gesture from a device. */
  const bridgeWrites = async (type: string, payload: Record<string, unknown>) => {
    await journal.appendAll([
      { type, actor: { kind: "system" }, product: productId, provenance: "trusted", payload },
    ]);
  };
  return { call, step, journal, bridgeWrites, productId };
}

const HANDOVER = { agent: "noah", to: "iris", mode: "conversation", brief: "Frame the product." };

describe("the team's pause, a fact of the journal", () => {
  it("makes `next` answer paused and stop, then goes back to the method's step on resume", async () => {
    const { step, bridgeWrites } = await product();
    const before = await step();
    expect(before.step).not.toBe("paused");
    await bridgeWrites(TEAM_EVENT_TYPES.paused, { reason: "creator" });
    expect(await step()).toMatchObject({
      step: "paused",
      stop: true,
      you: true,
      agent: null,
      command: null,
      story: null,
      paused: { reason: "creator" },
    });
    await bridgeWrites(TEAM_EVENT_TYPES.resumed, {});
    expect((await step()).step).toBe(before.step);
  });

  it("makes a handover refuse while the team is paused, and accept it again after", async () => {
    const { call, journal, bridgeWrites } = await product();
    await bridgeWrites(TEAM_EVENT_TYPES.paused, { reason: "creator" });
    const count = journal.events.length;
    const refused = await call("delegate", HANDOVER);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error).toMatchObject({
        code: ErrorCode.DELEGATION_INVALID,
        message_key: "error.delegation_invalid.team_paused",
        details: { to: "iris", reason: "team_paused" },
      });
    }
    // Nothing was written by the refusal.
    expect(journal.events.length).toBe(count);
    await bridgeWrites(TEAM_EVENT_TYPES.resumed, {});
    expect((await call("delegate", HANDOVER)).ok).toBe(true);
  });

  it("keeps the first pause when a second comes while one is open, and ignores a resumption with none", async () => {
    const { step, bridgeWrites } = await product();
    await bridgeWrites(TEAM_EVENT_TYPES.resumed, {});
    expect((await step()).step).not.toBe("paused");
    await bridgeWrites(TEAM_EVENT_TYPES.paused, { reason: "emergency_stop" });
    await bridgeWrites(TEAM_EVENT_TYPES.paused, { reason: "creator" });
    expect(await step()).toMatchObject({ step: "paused", paused: { reason: "emergency_stop" } });
    await bridgeWrites(TEAM_EVENT_TYPES.resumed, {});
    expect((await step()).step).not.toBe("paused");
  });

  it("ignores a pause written by an agent: only the machine, the creator and Noah hold the team", async () => {
    const { step, journal, productId } = await product();
    await journal.appendAll([
      {
        type: TEAM_EVENT_TYPES.paused,
        actor: { kind: "agent", agent: "maya" },
        product: productId,
        provenance: "trusted",
        payload: { reason: "creator" },
      },
    ]);
    expect((await step()).step).not.toBe("paused");
    // Noah's own event holds it too.
    await journal.appendAll([
      {
        type: TEAM_EVENT_TYPES.paused,
        actor: { kind: "agent", agent: "noah" },
        product: productId,
        provenance: "trusted",
        payload: { reason: "creator" },
      },
    ]);
    expect((await step()).step).toBe("paused");
  });
});

describe("a journal written by engine 1.2.0, then carried on by a newer one", () => {
  it("reads what 1.2.0 wrote the same way, then holds and notes on top of it", async () => {
    const { call, step, journal, bridgeWrites } = await product();
    // What 1.2.0 knew: a handover is a fact of the journal; no pause, no note of an exchange.
    expect((await call("delegate", HANDOVER)).ok).toBe(true);
    const before = journal.events.map((event) => event.type);
    expect(before).not.toContain(TEAM_EVENT_TYPES.paused);
    const state = async () => {
      const result = await call("get_state", {});
      if (!result.ok) throw new Error(`get_state failed: ${result.error.code}`);
      return result.value as unknown as Record<string, unknown>;
    };
    expect((await state()).exchanges).toBeUndefined();
    expect((await step()).step).not.toBe("paused");
    // The additive facts come after; the events before them are read as they were.
    await bridgeWrites(TEAM_EVENT_TYPES.paused, { reason: "creator" });
    const note = { agent: "noah", summary: "Asked: pause. Decided: held." };
    expect((await call("summarize", note)).ok).toBe(true);
    expect((await step()).step).toBe("paused");
    await bridgeWrites(TEAM_EVENT_TYPES.resumed, {});
    expect((await step()).step).not.toBe("paused");
    expect(journal.events.map((event) => event.type).slice(0, before.length)).toEqual(before);
    expect(((await state()).exchanges as string[]).length).toBe(1);
  });
});
