import { eventHash, fromBase64url, verifyEvent } from "@agentplugged/crypto";
import {
  DeviceRegisteredPayloadSchema,
  ErrorCode,
  EVENT_TYPES,
  type EventEnvelope,
  MACHINE_DEVICE_PATTERN,
  ULID_PATTERN,
} from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { AgentPluggedError } from "../errors.js";
import { METHOD_CONFIG_PATH } from "../init/layout.js";
import { MemoryFiles } from "../testing/memory-files.js";
import { loadMachineKey, MemoryKeyStore, machineDevice } from "./key-store.js";
import { MemoryStateStore } from "./memory-state-store.js";
import { deviceHeads, prepareAppend } from "./prepare-event.js";
import { ensureProductId, writeProductId } from "./product-id.js";
import type { EventDraft } from "./state-store.js";
import { createUlidFactory, nextUlid } from "./ulid.js";

const PRODUCT = "01JZ0000000000000000000000";
const SEED = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const draft = (n: number): EventDraft => ({
  type: "test.appended",
  actor: { kind: "agent", agent: "sam" },
  product: PRODUCT,
  provenance: "trusted",
  payload: { n },
});

function hash(event: EventEnvelope): string {
  const result = eventHash(event);
  if (!result.ok) throw new Error("no hash");
  return result.hash;
}

describe("ULID", () => {
  it("encodes the clock and 80 random bits", () => {
    const make = createUlidFactory({
      now: () => 1_700_000_000_000,
      random: (n) => new Uint8Array(n),
    });
    expect(make()).toBe("01HF7YAT000000000000000000");
    expect(make()).toMatch(ULID_PATTERN);
  });

  it("grows strictly within one millisecond, and after a given id", () => {
    const make = createUlidFactory({ now: () => 1_700_000_000_000 });
    const ids = Array.from({ length: 50 }, () => make());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
    const later = "7ZZZZZZZZZZZZZZZZZZZZZZZZY";
    expect(make(later)).toBe("7ZZZZZZZZZZZZZZZZZZZZZZZZZ");
  });

  it("carries when incrementing, and stops at the largest ULID", () => {
    expect(nextUlid("0000000000000000000000000Z")).toBe("00000000000000000000000010");
    expect(nextUlid("6ZZZZZZZZZZZZZZZZZZZZZZZZZ")).toBe("70000000000000000000000000");
    expect(nextUlid("7ZZZZZZZZZZZZZZZZZZZZZZZZY")).toBe("7ZZZZZZZZZZZZZZZZZZZZZZZZZ");
    expect(() => nextUlid("7ZZZZZZZZZZZZZZZZZZZZZZZZZ")).toThrow(RangeError);
    const make = createUlidFactory({ now: () => 2 ** 48 - 1 });
    expect(() => make("7ZZZZZZZZZZZZZZZZZZZZZZZZZ")).toThrow(RangeError);
  });

  it("refuses a clock out of range", () => {
    expect(() => createUlidFactory({ now: () => -1 })()).toThrow(RangeError);
  });
});

describe("machine key", () => {
  it("is created once, stored as its seed, and gives a stable device", async () => {
    const keys = new MemoryKeyStore();
    const first = await loadMachineKey(keys);
    expect(first.created).toBe(true);
    expect(keys.writes).toBe(1);
    expect(fromBase64url(keys.secret ?? "")?.length).toBe(32);
    const again = await loadMachineKey(keys);
    expect(again.created).toBe(false);
    expect(again.device).toBe(first.device);
    expect(again.publicKey).toEqual(first.publicKey);
    expect(keys.writes).toBe(1);
    expect(first.device).toMatch(MACHINE_DEVICE_PATTERN);
    expect(machineDevice(first.publicKey)).toBe(first.device);
  });

  it("creates the key inside the machine-wide lock, reading the keychain again there", async () => {
    const keys = new MemoryKeyStore();
    const created = await loadMachineKey(keys);
    const empty = new MemoryKeyStore();
    let locked = 0;
    // Another process stores its key while this one waits for the lock: it is adopted.
    const adopted = await loadMachineKey(empty, {
      lock: async (task) => {
        locked += 1;
        empty.secret = keys.secret;
        return task();
      },
    });
    expect(locked).toBe(1);
    expect(adopted.created).toBe(false);
    expect(adopted.device).toBe(created.device);
    expect(empty.writes).toBe(0);
  });

  it("refuses a keychain value that is not a seed", async () => {
    await expect(loadMachineKey(new MemoryKeyStore("nope!"))).rejects.toBeInstanceOf(
      AgentPluggedError,
    );
  });
});

describe("MemoryStateStore", () => {
  it("publishes the machine key first, then chains each event to the previous one", async () => {
    const keys = new MemoryKeyStore(SEED);
    let clock = Date.UTC(2026, 9, 3, 12);
    const store = new MemoryStateStore({ keys, now: () => clock++, allowTestTypes: true });
    const first = await store.append(draft(1));
    const second = await store.append(draft(2));

    const [registered, created, ...rest] = store.events;
    if (registered === undefined || created === undefined) throw new Error("no event");
    expect(rest).toEqual([first, second]);
    expect(registered.type).toBe(EVENT_TYPES.deviceRegistered);
    expect(registered.prev).toBeNull();
    expect(registered.actor).toEqual({ kind: "system", device: first.actor.device });
    expect(created).toMatchObject({
      type: EVENT_TYPES.productCreated,
      product: PRODUCT,
      payload: { product_id: PRODUCT },
      prev: hash(registered),
    });
    expect(first.prev).toBe(hash(created));
    expect(second.prev).toBe(hash(first));
    expect(first).toMatchObject({ v: 1, alg: "ed25519", product: PRODUCT, payload: { n: 1 } });
    expect(first.actor).toEqual({ kind: "agent", agent: "sam", device: first.actor.device });
    expect(first.at).toBe("2026-10-03T12:00:00.002Z");

    const payload = DeviceRegisteredPayloadSchema.parse(registered.payload);
    const publicKey = fromBase64url(payload.public_key);
    for (const event of store.events) {
      expect(await verifyEvent(event, { ed25519PublicKey: publicKey })).toEqual({ ok: true });
    }
    const listed = await store.list();
    expect(listed.events.map((event) => event.id)).toEqual(store.events.map((event) => event.id));
    expect(await store.head()).toBe("memory:4");
    expect(await store.productId()).toBe(PRODUCT);
  });

  it("refuses the engine's own event types in a draft", async () => {
    const store = new MemoryStateStore({ keys: new MemoryKeyStore(SEED), allowTestTypes: true });
    for (const type of [EVENT_TYPES.deviceRegistered, EVENT_TYPES.productCreated]) {
      await expect(store.append({ ...draft(1), type })).rejects.toMatchObject({
        code: ErrorCode.EVENT_INVALID,
        details: { field: "type", reason_key: "reason.reserved_type" },
      });
    }
    expect(store.events).toEqual([]);
  });

  it("refuses a draft for another product than the journal's", async () => {
    const store = new MemoryStateStore({ keys: new MemoryKeyStore(SEED), allowTestTypes: true });
    await store.append(draft(1));
    const other = "01JZ5555555555555555555555";
    await expect(store.append({ ...draft(2), product: other })).rejects.toMatchObject({
      code: ErrorCode.PRODUCT_ID_MISMATCH,
      message_key: "error.product_id_mismatch",
      details: { product_id: other, journal_product_id: PRODUCT },
    });
    expect(store.events).toHaveLength(3);
  });

  it("refuses a draft that names another device", async () => {
    const store = new MemoryStateStore({ keys: new MemoryKeyStore(SEED), allowTestTypes: true });
    const other = { ...draft(1), actor: { kind: "system" as const, device: "machine:other" } };
    await expect(store.append(other)).rejects.toMatchObject({
      code: ErrorCode.EVENT_INVALID,
      details: { field: "actor.device" },
    });
    expect(store.events).toEqual([]);
  });

  it("refuses an invalid draft before writing anything", async () => {
    const store = new MemoryStateStore({ keys: new MemoryKeyStore(SEED), allowTestTypes: true });
    await expect(store.append({ ...draft(1), type: "Bad" })).rejects.toMatchObject({
      code: ErrorCode.EVENT_INVALID,
      details: { field: "type" },
    });
    expect(store.events).toEqual([]);
    expect(await store.head()).toBeNull();
  });

  it("keeps one chain per writer", async () => {
    const shared = new MemoryStateStore({ keys: new MemoryKeyStore(SEED), allowTestTypes: true });
    await shared.append(draft(1));
    const key = await loadMachineKey(
      new MemoryKeyStore("AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"),
    );
    const other = await prepareAppend({
      draft: draft(2),
      key,
      deviceHead: null,
      journalProduct: PRODUCT,
      newId: createUlidFactory(),
      now: Date.now,
      allowTestTypes: true,
    });
    shared.rewrite([...shared.events, ...other.events]);
    const third = await shared.append(draft(3));
    const heads = deviceHeads(shared.events);
    expect(heads.size).toBe(2);
    expect(heads.get(key.device)).toEqual(other.head);
    expect(heads.get(third.actor.device)).toEqual({ id: third.id, hash: hash(third) });
  });
});

describe("product_id", () => {
  const ID = "01JZ1111111111111111111111";

  it("is written right after engine_version, keeping comments and line endings", () => {
    const text =
      "# mine\r\nformat_version: 2\r\nengine_version: 0.1.0 # pinned\r\ntools:\r\n  - codex\r\n";
    expect(writeProductId(text, ID)).toBe(
      `# mine\r\nformat_version: 2\r\nengine_version: 0.1.0 # pinned\r\nproduct_id: ${ID}\r\ntools:\r\n  - codex\r\n`,
    );
  });

  it("must be a ULID", () => {
    const written = writeProductId("format_version: 2\nengine_version: 0.1.0\n", "nope");
    expect(written).toBeInstanceOf(AgentPluggedError);
    expect((written as AgentPluggedError).details).toMatchObject({
      field: "product_id",
      reason_key: "reason.ulid",
    });
  });

  it("is added to an old method.yaml, and said so", async () => {
    const files = new MemoryFiles({
      [METHOD_CONFIG_PATH]: "# mine\nformat_version: 2\nengine_version: 0.1.0\n",
    });
    expect(await ensureProductId(files, () => ID)).toEqual({ productId: ID, added: true });
    expect(files.files.get(METHOD_CONFIG_PATH)).toBe(
      `# mine\nformat_version: 2\nengine_version: 0.1.0\nproduct_id: ${ID}\n`,
    );
    expect(await ensureProductId(files, () => "01JZ2222222222222222222222")).toEqual({
      productId: ID,
      added: false,
    });
    expect(files.writes).toEqual([METHOD_CONFIG_PATH]);
  });

  it("adopts the journal's id, and refuses a different one", async () => {
    const journal = new MemoryStateStore({ keys: new MemoryKeyStore(SEED), allowTestTypes: true });
    await journal.append(draft(1));
    const fresh = new MemoryFiles({
      [METHOD_CONFIG_PATH]: "format_version: 2\nengine_version: 0.1.0\n",
    });
    expect(await ensureProductId(fresh, () => ID, journal)).toEqual({
      productId: PRODUCT,
      added: true,
    });
    const other = new MemoryFiles({
      [METHOD_CONFIG_PATH]: `format_version: 2\nengine_version: 0.1.0\nproduct_id: ${ID}\n`,
    });
    const mismatch = await ensureProductId(other, () => ID, journal);
    expect(mismatch).toBeInstanceOf(AgentPluggedError);
    expect((mismatch as AgentPluggedError).toPayload()).toEqual({
      code: ErrorCode.PRODUCT_ID_MISMATCH,
      message_key: "error.product_id_mismatch",
      details: { product_id: ID, journal_product_id: PRODUCT },
    });
    expect(other.writes).toEqual([]);
  });

  it("needs method.yaml", async () => {
    const result = await ensureProductId(new MemoryFiles(), () => ID);
    expect(result).toBeInstanceOf(AgentPluggedError);
  });
});
