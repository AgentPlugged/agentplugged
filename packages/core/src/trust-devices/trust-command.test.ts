import { generateEd25519, signEd25519, toBase64url } from "@agentplugged/crypto";
import {
  DEVICE_TRUST_EVENT_TYPES,
  ErrorCode,
  HUMAN_EVENT_TYPES,
  type RootPin,
} from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type CommandContext,
  computeProjectionDetailed,
  createCommandRegistry,
  humanDevice,
  initCommand,
  loadHumanKey,
  MemoryKeyStore,
  MemoryRootPinStore,
  MemoryStateStore,
  resolveProfile,
  type ToolProbe,
  type TrustResult,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};
const SEED = toBase64url(new Uint8Array(32).fill(9));
const ADA = toBase64url(new Uint8Array(32).fill(21));
const START = Date.UTC(2026, 9, 8, 12, 0, 0);

async function product() {
  let now = START;
  const tick = () => {
    now += 1000;
    return now;
  };
  const journal = new MemoryStateStore({ keys: new MemoryKeyStore(SEED), now: tick });
  const keys = new MemoryKeyStore(SEED, ADA);
  const pins = new MemoryRootPinStore();
  const base: CommandContext = {
    files: new MemoryFiles(),
    tools: NO_TOOL,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
    journal,
    now: tick,
    interactive: true,
    human: { keys },
    rootPins: pins,
  };
  const init = await initCommand.run(base, { profile: resolveProfile("new-product") });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const adaKey = await loadHumanKey(keys, { create: false });
  if (adaKey === undefined) throw new Error("no key");
  const pin: RootPin = { device: adaKey.device, public_key: toBase64url(adaKey.publicKey) };
  const registry = createCommandRegistry();
  const productId = (await journal.productId()) as string;

  /** A creator key registered with the identifier zero: older than every event of the journal. */
  const forge = async (n = 0) => {
    const pair = await generateEd25519({ seed: new Uint8Array(32).fill(66 + n) });
    const unsigned = {
      v: 1,
      id: `${"0".repeat(24)}${String(n).padStart(2, "0")}`,
      type: HUMAN_EVENT_TYPES.keyRegistered,
      at: "2026-10-08T11:00:00.000Z",
      actor: { kind: "human" as const, device: humanDevice(pair.publicKey) },
      product: productId,
      provenance: "trusted" as const,
      prev: null,
      payload: { public_key: toBase64url(pair.publicKey) },
      alg: "ed25519" as const,
      assurance: "locale" as const,
    };
    const event = await signEd25519(unsigned, pair.secretKey);
    const listing = await journal.list();
    journal.rewrite([...listing.events, event]);
    return { event, device: humanDevice(pair.publicKey) };
  };
  const projection = async (withPin = true) => {
    const listing = await journal.list();
    return computeProjectionDetailed(listing.events, {
      problems: listing.problems,
      ...(withPin ? { pinnedRoot: pin } : {}),
    });
  };
  const dismiss = (context: CommandContext = base, input: Record<string, unknown> = {}) =>
    registry.run("trust", context, { action: "dismiss", ...input });
  return { base, journal, keys, pins, pin, registry, forge, projection, dismiss, adaKey };
}

describe("trust dismiss: the way out of SECURITY_ROOT_CHANGED", () => {
  it("has nothing to dismiss without a pinned root, or when the journal agrees with it", async () => {
    const p = await product();
    const none = await p.dismiss();
    expect(none.ok && none.value).toEqual({ action: "dismiss", status: "none", pinned: false });
    p.pins.pins.set((await p.journal.productId()) as string, p.pin);
    const agrees = await p.dismiss();
    expect(agrees.ok && agrees.value).toEqual({ action: "dismiss", status: "none", pinned: true });
  });

  it("names the event that raised the alert, asks nothing itself, and blocks until dismissed", async () => {
    const p = await product();
    p.pins.pins.set((await p.journal.productId()) as string, p.pin);
    const forged = await p.forge();
    const before = await p.projection();
    expect(before.deviceTrust?.blocked).toBe(true);
    const listed = await p.dismiss();
    expect(listed.ok && listed.value).toMatchObject({
      status: "list",
      faults: [{ id: forged.event.id, device: forged.device }],
    });
    // Nothing was written by listing.
    expect((await p.projection()).deviceTrust?.blocked).toBe(true);
  });

  it("publishes trust.dismissed, signed by the creator's key, once she answered", async () => {
    const p = await product();
    p.pins.pins.set((await p.journal.productId()) as string, p.pin);
    const forged = await p.forge();
    const done = await p.dismiss(p.base, { confirm: true });
    expect(done.ok && done.value).toEqual({
      action: "dismiss",
      status: "dismissed",
      events: [forged.event.id],
      cleared: true,
    });
    const listing = await p.journal.list();
    const dismissal = listing.events.find((event) => event.type === "trust.dismissed");
    expect(dismissal).toMatchObject({
      actor: { kind: "human", device: p.adaKey.device },
      alg: "ed25519",
      assurance: "locale",
    });
    const after = await p.projection();
    expect(after.deviceTrust?.blocked).toBe(false);
    expect(after.projection.ignored).toContainEqual({ id: forged.event.id, reason: "dismissed" });
    // Again: nothing left to dismiss.
    const again = await p.dismiss(p.base, { confirm: true });
    expect(again.ok && again.value).toMatchObject({ status: "none", pinned: true });
  });

  it("dismisses more than 16 faults, in as many events as it takes, and only what was shown", async () => {
    const p = await product();
    p.pins.pins.set((await p.journal.productId()) as string, p.pin);
    const forged = [];
    for (let n = 0; n < 17; n++) forged.push(await p.forge(n));
    const listed = await p.dismiss();
    expect(listed.ok && listed.value).toMatchObject({ status: "list" });
    const shown = listed.ok
      ? (listed.value as TrustResult).status === "list"
        ? (listed.value as Extract<TrustResult, { status: "list" }>).faults
        : []
      : [];
    expect(shown).toHaveLength(17);
    // A fault that appears after the creator was shown the list is not dismissed unseen.
    const later = await p.forge(30);
    const done = await p.dismiss(p.base, { confirm: true, events: shown.map((f) => f.hash) });
    expect(done.ok && done.value).toMatchObject({ status: "dismissed", cleared: false });
    const listing = await p.journal.list();
    const dismissals = listing.events.filter((event) => event.type === "trust.dismissed");
    expect(dismissals).toHaveLength(2);
    const after = await p.projection();
    expect(after.deviceTrust?.faults.map((fault) => fault.id)).toEqual([later.event.id]);
    expect(forged).toHaveLength(17);
  });

  it("is the creator's, at a terminal: refused to an agent, and without a terminal", async () => {
    const p = await product();
    p.pins.pins.set((await p.journal.productId()) as string, p.pin);
    await p.forge();
    const agent = await p.registry.run(
      "trust",
      { ...p.base, actor: "agent" },
      { action: "dismiss" },
    );
    expect(agent.ok ? undefined : agent.error.code).toBe(ErrorCode.UNKNOWN_COMMAND);
    const noTerminal = await p.dismiss({ ...p.base, interactive: false }, { confirm: true });
    expect(noTerminal.ok ? undefined : noTerminal.error.code).toBe(
      ErrorCode.REVIEW_NOT_INTERACTIVE,
    );
    const bad = await p.registry.run("trust", p.base, { action: "forgive" });
    expect(bad.ok ? undefined : bad.error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
    expect((await p.projection()).deviceTrust?.blocked).toBe(true);
  });

  it("is not available to an agent through the engine's writes either", async () => {
    const p = await product();
    const productId = (await p.journal.productId()) as string;
    for (const type of Object.values(DEVICE_TRUST_EVENT_TYPES)) {
      await expect(
        p.journal.append({
          type,
          actor: { kind: "agent", agent: "sam" },
          product: productId,
          provenance: "trusted",
          payload: {},
        }),
      ).rejects.toMatchObject({ code: ErrorCode.EVENT_INVALID });
    }
  });
});

describe("the registry of trust is not a tool of the MCP server", () => {
  it("no command of the agents can write a device or trust event, and none is named after them", () => {
    const registry = createCommandRegistry();
    const agentNames = registry.agentCommands().map((command) => command.name);
    expect(agentNames.some((name) => /device|pair|dismiss/.test(name))).toBe(false);
    expect(agentNames.includes("trust")).toBe(false);
    expect(registry.names()).toContain("trust");
  });
});
