import { generateEd25519, signOrder } from "@agentplugged/crypto";
import {
  type DocumentRef,
  ORDER_EVENT_TYPES,
  type OrderAppliedPayload,
  type UnsignedOrder,
} from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { loadMachineKey, MemoryKeyStore } from "../journal/key-store.js";
import { MemoryStateStore } from "../journal/memory-state-store.js";
import { computeBasis } from "./basis.js";
import {
  appliedOrders,
  findOrderApplied,
  lastAppliedSequences,
  writeOrderApplied,
  writeOrderRejected,
} from "./order-events.js";

const PRODUCT = "01K6KXJ5G0PR0DVCT00000000A";
const sha = (char: string): string => char.repeat(40);

const docs: DocumentRef[] = [
  { path: "specs/a.md", branch: "main", blob_sha: sha("a") },
  { path: "specs/b.md", branch: "main", blob_sha: sha("b") },
];

describe("the fingerprint of what the creator saw", () => {
  it("is the same whatever the order of the documents, and counts a reference once", () => {
    const [first, second] = docs as [DocumentRef, DocumentRef];
    expect(computeBasis([first, second])).toBe(computeBasis([second, first]));
    expect(computeBasis([first, second, first])).toBe(computeBasis([first, second]));
    expect(computeBasis(docs)).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/);
  });

  it.each([
    ["a document that changed", [{ ...docs[0], blob_sha: sha("c") }, docs[1]]],
    ["another branch", [{ ...docs[0], branch: "feature" }, docs[1]]],
    ["another path", [{ ...docs[0], path: "specs/z.md" }, docs[1]]],
    ["a document less", [docs[0]]],
    ["a document more", [...docs, { path: "c.md", branch: "main", blob_sha: sha("d") }]],
  ])("changes with %s", (_name, changed) => {
    expect(computeBasis(changed as DocumentRef[])).not.toBe(computeBasis(docs));
  });

  it("refuses a reference that is not a blob", () => {
    expect(() => computeBasis([{ path: "a", branch: "main", blob_sha: "xyz" }])).toThrow();
  });
});

async function world() {
  const keys = new MemoryKeyStore();
  const machine = await loadMachineKey(keys);
  const store = new MemoryStateStore({ keys });
  await store.append({
    type: "git.workflow_set",
    actor: { kind: "system" },
    product: PRODUCT,
    provenance: "trusted",
    payload: { workflow: {}, previous: null, source: "init", forge: false },
  });
  const device = await generateEd25519();
  async function applied(seq: number, id: string, deviceId = "phone:BBBBBBBBBBBBBBBB") {
    const unsigned: UnsignedOrder = {
      t: "order.test.echo/v1",
      id,
      device: deviceId,
      bridge: machine.device,
      product: PRODUCT,
      target: null,
      basis: null,
      seq,
      issued_at: "2026-10-15T08:00:00.000Z",
      expires_at: "2026-10-15T08:10:00.000Z",
      params: {},
      alg: "ed25519",
    };
    const order = await signOrder(unsigned, device.secretKey);
    return {
      order,
      device: deviceId,
      source: "mobile",
      applied_at: "2026-10-15T08:00:02.000Z",
    } satisfies OrderAppliedPayload;
  }
  return { store, applied };
}

describe("the record of a refused order", () => {
  const refusal = (id: string) => ({
    order: id,
    t: "order.test.echo/v1",
    device: "phone:BBBBBBBBBBBBBBBB",
    code: "STALE_BASIS",
    source: "mobile" as const,
    rejected_at: "2026-10-15T08:00:02.000Z",
  });

  it("is written once as the system, and a second write returns the first", async () => {
    const { store } = await world();
    const first = await writeOrderRejected(store, PRODUCT, refusal("01J9ZQ4V8E3M5N7P9R1S3T5V7X"));
    expect(first.written).toBe(true);
    expect(first.event.type).toBe(ORDER_EVENT_TYPES.rejected);
    expect(first.event.actor.kind).toBe("system");
    const again = await writeOrderRejected(store, PRODUCT, refusal("01J9ZQ4V8E3M5N7P9R1S3T5V7X"));
    expect(again.written).toBe(false);
    expect(again.event.id).toBe(first.event.id);
  });

  it("is not written for an order the journal records as applied", async () => {
    const { store, applied } = await world();
    const payload = await applied(1, "01J9ZQ4V8E3M5N7P9R1S3T5V7X");
    await writeOrderApplied(store, PRODUCT, payload);
    const kept = await writeOrderRejected(store, PRODUCT, refusal(payload.order.id));
    expect(kept.written).toBe(false);
    expect(
      (await store.list()).events.filter((e) => e.type === ORDER_EVENT_TYPES.rejected),
    ).toEqual([]);
  });

  it("is written by the engine only", async () => {
    const { store } = await world();
    await expect(
      store.append({
        type: ORDER_EVENT_TYPES.rejected,
        actor: { kind: "agent", agent: "dev" },
        product: PRODUCT,
        provenance: "trusted",
        payload: refusal("01J9ZQ4V8E3M5N7P9R1S3T5V7X"),
      }),
    ).rejects.toThrow();
  });
});

describe("the record of an applied order", () => {
  it("is written once as the system, keeps the signed order, and a second write returns the first", async () => {
    const { store, applied } = await world();
    const payload = await applied(1, "01J9ZQ4V8E3M5N7P9R1S3T5V7X");
    const first = await writeOrderApplied(store, PRODUCT, payload);
    expect(first.written).toBe(true);
    expect(first.event.type).toBe(ORDER_EVENT_TYPES.applied);
    expect(first.event.actor.kind).toBe("system");
    const again = await writeOrderApplied(store, PRODUCT, payload);
    expect(again.written).toBe(false);
    expect(again.event.id).toBe(first.event.id);
    expect(
      (await store.list()).events.filter((e) => e.type === ORDER_EVENT_TYPES.applied),
    ).toHaveLength(1);
    expect((await findOrderApplied(store, payload.order.id))?.id).toBe(first.event.id);
    expect(await findOrderApplied(store, "01J9ZQ4V8E3M5N7P9R1S3T5V7Z")).toBeUndefined();
  });

  it("gives back the signature of the device, so that a reader checks it without the bridge", async () => {
    const { store, applied } = await world();
    const payload = await applied(1, "01J9ZQ4V8E3M5N7P9R1S3T5V7X");
    await writeOrderApplied(store, PRODUCT, payload);
    const [kept] = appliedOrders((await store.list()).events);
    expect(kept?.order.sig).toBe(payload.order.sig);
  });

  it("reads the highest sequence per device, which is what catches a restored machine", async () => {
    const { store, applied } = await world();
    await writeOrderApplied(store, PRODUCT, await applied(3, "01J9ZQ4V8E3M5N7P9R1S3T5V7X"));
    await writeOrderApplied(store, PRODUCT, await applied(7, "01J9ZQ4V8E3M5N7P9R1S3T5V7Y"));
    await writeOrderApplied(
      store,
      PRODUCT,
      await applied(2, "01J9ZQ4V8E3M5N7P9R1S3T5V7Z", "browser:CCCCCCCCCCCCCCCC"),
    );
    const last = lastAppliedSequences((await store.list()).events);
    expect(last.get("phone:BBBBBBBBBBBBBBBB")).toBe(7);
    expect(last.get("browser:CCCCCCCCCCCCCCCC")).toBe(2);
  });

  it("is written by the engine only: an agent's draft of that type is refused", async () => {
    const { store, applied } = await world();
    const payload = await applied(1, "01J9ZQ4V8E3M5N7P9R1S3T5V7X");
    await expect(
      store.append({
        type: ORDER_EVENT_TYPES.applied,
        actor: { kind: "agent", agent: "dev" },
        product: PRODUCT,
        provenance: "trusted",
        payload,
      }),
    ).rejects.toThrow();
  });
});
