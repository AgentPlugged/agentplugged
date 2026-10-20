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
  NOAH_COMMANDS,
  resolveProfile,
  TOOL_GROUPS,
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

const SEED = toBase64url(new Uint8Array(32).fill(8));

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

describe("Noah holds the team himself, once the creator agreed", () => {
  it("writes one pause as Noah, which stops `next` and refuses a handover", async () => {
    const { call, step, journal } = await product();
    const written = await call("pause_team", { agent: "noah" });
    expect(written.ok).toBe(true);
    const events = journal.events.filter((e) => e.type === TEAM_EVENT_TYPES.paused);
    expect(events).toHaveLength(1);
    expect(events[0]?.actor).toMatchObject({ kind: "agent", agent: "noah" });
    expect(events[0]?.payload).toEqual({ reason: "creator" });
    expect(await step()).toMatchObject({
      step: "paused",
      stop: true,
      paused: { reason: "creator" },
    });
    const refused = await call("delegate", HANDOVER);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message_key).toBe("error.delegation_invalid.team_paused");
  });

  it("is reachable as the `pause` action of the agent tool, no tool of more", () => {
    expect(TOOL_GROUPS.agent?.actions.pause).toEqual({ command: "pause_team" });
    expect(NOAH_COMMANDS.has("pause_team")).toBe(true);
  });

  it("refuses another agent, writing nothing", async () => {
    const { call, journal } = await product();
    const count = journal.events.length;
    const refused = await call("pause_team", { agent: "maya" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe(ErrorCode.ROLE_FORBIDDEN);
    expect(journal.events.length).toBe(count);
  });

  it("refuses a second pause with its cause, writing nothing, and takes up again after a resumption", async () => {
    const { call, journal, step, productId } = await product();
    expect((await call("pause_team", { agent: "noah" })).ok).toBe(true);
    const count = journal.events.length;
    const again = await call("pause_team", { agent: "noah" });
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.error.code).toBe(ErrorCode.TEAM_ALREADY_PAUSED);
      expect(again.error.message_key).toBe("error.team_already_paused");
    }
    expect(journal.events.length).toBe(count);
    await journal.appendAll([
      {
        type: TEAM_EVENT_TYPES.resumed,
        actor: { kind: "system" },
        product: productId,
        provenance: "trusted",
        payload: {},
      },
    ]);
    expect((await step()).step).not.toBe("paused");
    expect((await call("pause_team", { agent: "noah" })).ok).toBe(true);
  });

  it("refuses a pause when the creator's button already holds the team", async () => {
    const { call, journal, bridgeWrites } = await product();
    await bridgeWrites(TEAM_EVENT_TYPES.paused, { reason: "creator" });
    const count = journal.events.length;
    const again = await call("pause_team", { agent: "noah" });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe(ErrorCode.TEAM_ALREADY_PAUSED);
    expect(journal.events.length).toBe(count);
  });

  it("refuses an unknown field, writing nothing", async () => {
    const { call, journal } = await product();
    const count = journal.events.length;
    expect((await call("pause_team", { agent: "noah", reason: "creator" })).ok).toBe(false);
    expect(journal.events.length).toBe(count);
  });
});
