import { toBase64url } from "@agentplugged/crypto";
import { ErrorCode, EXTENSION_TYPE_PATTERN } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { MemoryKeyStore } from "../journal/key-store.js";
import { MemoryStateStore } from "../journal/memory-state-store.js";
import { createProductKey } from "../journal/product-key.js";
import { computeProjection, computeProjectionDetailed } from "../projection/compute-projection.js";
import { appendExtensionEvent, readExtensionEvents } from "./extension-events.js";

const PRODUCT = "01JZ0000000000000000000000";
const SEED = toBase64url(new Uint8Array(32).fill(7));
const START = Date.UTC(2026, 9, 19, 12, 0, 0);

function clock() {
  let now = START;
  return () => {
    now += 1000;
    return now;
  };
}

async function workspace() {
  const keys = new MemoryKeyStore(SEED);
  await createProductKey(keys, PRODUCT);
  const store = new MemoryStateStore({ keys, now: clock() });
  return { keys, store };
}

const write = (store: MemoryStateStore, type: string, payload: Record<string, unknown>) =>
  appendExtensionEvent(store, { product: PRODUCT, type, actor: { kind: "system" }, payload });

describe("extension events", () => {
  it("accepts only the form x.<module>.<type>", () => {
    expect(EXTENSION_TYPE_PATTERN.test("x.module_a.thing")).toBe(true);
    expect(EXTENSION_TYPE_PATTERN.test("x.module_a")).toBe(false);
    expect(EXTENSION_TYPE_PATTERN.test("y.module_a.thing")).toBe(false);
    expect(EXTENSION_TYPE_PATTERN.test("x.Module.thing")).toBe(false);
  });

  it("writes, keeps and reads back events of a module, in order", async () => {
    const { keys, store } = await workspace();
    await write(store, "x.module_a.opened", { n: 1 });
    await write(store, "x.module_a.said", { n: 2 });
    await write(store, "x.module_b.opened", { n: 3 });
    const all = await readExtensionEvents(store, { keys });
    expect(all.events.map((event) => event.payload.n)).toEqual([1, 2, 3]);
    expect(all.unreadable).toBe(0);
    const onlyA = await readExtensionEvents(store, { keys, module: "module_a" });
    expect(onlyA.events.map((event) => event.type)).toEqual([
      "x.module_a.opened",
      "x.module_a.said",
    ]);
  });

  it("writes the content encrypted, never in clear in the journal", async () => {
    const { store } = await workspace();
    await write(store, "x.module_a.opened", { secret_word: "tangerine" });
    const written = store.events.filter((event) => event.type.startsWith("x."));
    expect(written).toHaveLength(1);
    expect(written[0]?.payload).toBeUndefined();
    expect(written[0]?.payload_enc).toBeDefined();
    expect(JSON.stringify(store.events)).not.toContain("tangerine");
  });

  it("signs them: a tampered extension event is ignored, not trusted", async () => {
    const { keys, store } = await workspace();
    await write(store, "x.module_a.opened", { n: 1 });
    const tampered = store.events.map((event) =>
      event.type === "x.module_a.opened" ? { ...event, at: "2030-01-01T00:00:00.000Z" } : event,
    );
    store.rewrite(tampered);
    const read = await readExtensionEvents(store, { keys });
    expect(read.events).toHaveLength(0);
  });

  it("refuses a type outside the extension point, and never in the creator's name", async () => {
    const { store } = await workspace();
    await expect(write(store, "agent.status_reported", {})).rejects.toMatchObject({
      code: ErrorCode.INVALID_ARGUMENTS,
    });
    await expect(write(store, "x.module_a", {})).rejects.toMatchObject({
      code: ErrorCode.INVALID_ARGUMENTS,
    });
  });

  it("does not block an engine that does not know the module", async () => {
    const { store } = await workspace();
    await write(store, "x.module_unknown.happened", { n: 1 });
    const listing = await store.list();
    // The core projection ignores the event without error and counts it as applied.
    const projection = await computeProjection(listing.events, { product: PRODUCT });
    expect(projection.ignored).toEqual([]);
    expect(projection.applied).toBeGreaterThan(0);
  });

  it("counts an event it cannot decrypt as unreadable, and keeps the chain", async () => {
    const { store } = await workspace();
    await write(store, "x.module_a.opened", { n: 1 });
    await write(store, "x.module_a.said", { n: 2 });
    const listing = await store.list();
    const detailed = await computeProjectionDetailed(listing.events, { product: PRODUCT });
    expect(detailed.extensionEvents).toHaveLength(0);
    expect(detailed.unreadable).toBe(2);
    expect(detailed.projection.ignored).toEqual([]);
  });
});
