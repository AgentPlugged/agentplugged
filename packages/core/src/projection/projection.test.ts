import { eventHash, signEd25519, toBase64url } from "@agentplugged/crypto";
import {
  ErrorCode,
  EVENT_TYPE_REGISTRY,
  type EventEnvelope,
  eventInvalid,
  KNOWN_EVENT_TYPES,
  TEST_EVENT_TYPE,
  type UnsignedEventEnvelope,
} from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import type { CommandContext } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { journalCommand } from "../journal/journal-command.js";
import { loadMachineKey, type MachineKey, MemoryKeyStore } from "../journal/key-store.js";
import { MemoryStateStore } from "../journal/memory-state-store.js";
import { type DeviceHead, prepareAppend } from "../journal/prepare-event.js";
import type { EventDraft } from "../journal/state-store.js";
import { createUlidFactory } from "../journal/ulid.js";
import { MemoryFiles } from "../testing/memory-files.js";
import { type ComputeProjectionOptions, computeProjection } from "./compute-projection.js";
import { projectState, STATE_CACHE_PATH, stateFile } from "./project-state.js";
import { REDUCERS } from "./reducers.js";

const PRODUCT = "01JZ0000000000000000000000";
const OTHER_PRODUCT = "01JZ1111111111111111111111";
const SEED_A = toBase64url(new Uint8Array(32).fill(1));
const SEED_B = toBase64url(new Uint8Array(32).fill(2));
const START = Date.UTC(2026, 9, 3, 12, 0, 0);

const draft = (n: number, product = PRODUCT): EventDraft => ({
  type: TEST_EVENT_TYPE,
  actor: { kind: "system" },
  product,
  provenance: "trusted",
  payload: { n },
});

function hashOf(event: EventEnvelope): string {
  const result = eventHash(event);
  if (!result.ok) throw new Error("no hash");
  return result.hash;
}

const headOf = (event: EventEnvelope): DeviceHead => ({ id: event.id, hash: hashOf(event) });

/** A clock that moves 1 s per call: deterministic ids and dates. */
function clock(start = START) {
  let now = start;
  return () => {
    now += 1000;
    return now;
  };
}

/** One machine writing to a journal held in memory, without any keychain. */
async function machine(seed: string, start = START) {
  const now = clock(start);
  const store = new MemoryStateStore({ keys: new MemoryKeyStore(seed), now, allowTestTypes: true });
  const key = await loadMachineKey(new MemoryKeyStore(seed));
  return { store, key, now };
}

/** Events signed by `key`, chained after `head` (none: the device's first events). */
async function signed(
  key: MachineKey,
  head: DeviceHead | null,
  drafts: EventDraft[],
  options: { journalProduct?: string | null; start?: number } = {},
): Promise<EventEnvelope[]> {
  const now = clock(options.start ?? START + 500_000);
  const newId = createUlidFactory({ now });
  const events: EventEnvelope[] = [];
  let current = head;
  for (const item of drafts) {
    const prepared = await prepareAppend({
      draft: item,
      key,
      deviceHead: current,
      journalProduct: options.journalProduct === undefined ? PRODUCT : options.journalProduct,
      newId,
      now,
      allowTestTypes: true,
    });
    events.push(...prepared.events);
    current = prepared.head;
  }
  return events;
}

/** A deterministic shuffle (mulberry32). */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** Two machines, each with a few events, in one journal. */
async function twoMachines() {
  const a = await machine(SEED_A);
  for (let n = 1; n <= 4; n++) await a.store.append(draft(n));
  const b = await loadMachineKey(new MemoryKeyStore(SEED_B));
  const fromB = await signed(b, null, [draft(10), draft(11), draft(12)]);
  a.store.rewrite([...a.store.events, ...fromB]);
  return { a, b, events: a.store.events };
}

/** The projection with the test type applied (`test.appended`), as in every test here. */
const project = (events: readonly EventEnvelope[], options: ComputeProjectionOptions = {}) =>
  computeProjection(events, { allowTestTypes: true, ...options });

/** An event of `key`'s device signed as is (any type, any `v`), after `head`. */
async function signedAs(
  key: MachineKey,
  head: DeviceHead,
  change: Record<string, unknown>,
): Promise<EventEnvelope> {
  const [current] = await signed(key, head, [draft(0)], { start: START + 990_000 });
  const { sig: _sig, ...unsigned } = current as EventEnvelope;
  return signEd25519({ ...unsigned, ...change } as UnsignedEventEnvelope, key.secretKey);
}

const lastOf = (events: readonly EventEnvelope[], device: string): DeviceHead =>
  headOf(events.filter((e) => e.actor.device === device).at(-1) as EventEnvelope);

const ignoredOf = (state: { ignored: Array<{ id: string; reason: string }> }) =>
  Object.fromEntries(state.ignored.map((entry) => [entry.id, entry.reason]));

describe("registry and reducers", () => {
  it("declares one reducer per known type", () => {
    expect(Object.keys(REDUCERS).sort()).toEqual([...KNOWN_EVENT_TYPES]);
    // `checkpoint.opened` is at version 2 (`phase_end`), every other type at 1.
    for (const type of KNOWN_EVENT_TYPES) {
      // `cost.reported` is at version 2, `creator_action.executed` at 6, `checkpoint.closed` at 2.
      expect(EVENT_TYPE_REGISTRY[type]?.version, type).toBe(
        type === "checkpoint.opened"
          ? 14
          : type === "creator_action.executed"
            ? 12
            : type === "story.merged"
              ? 3
              : type === "cost.reported" ||
                  type === "checkpoint.closed" ||
                  type === "checkpoint.answered" ||
                  type === "checkpoint.elicited" ||
                  type === "stack.answered" ||
                  type === "usage.measured" ||
                  type === "agent.status_reported" ||
                  type === "requirement.proved"
                ? 2
                : 1,
      );
    }
  });
});

describe("computeProjection", () => {
  it("applies every valid event, with the product and the devices", async () => {
    const { a, b, events } = await twoMachines();
    const state = await project(events, { head: "memory:x" });
    expect(state).toMatchObject({
      format: 1,
      journal_head: "memory:x",
      product: PRODUCT,
      applied: 10,
      ignored: [],
      warnings: [],
    });
    expect(state.devices.map((entry) => entry.device)).toEqual(
      [a.key.device, b.device].sort((x, y) => (x < y ? -1 : 1)),
    );
    expect(state.devices.find((entry) => entry.device === b.device)?.public_key).toBe(
      toBase64url(b.publicKey),
    );
    expect(state.state.test).toEqual({
      appended: 7,
      payloads: [1, 2, 3, 4, 10, 11, 12].map((n) => ({ n })),
    });
    // The date of the last event applied, never the clock.
    const last = [...events].sort((x, y) => (x.id < y.id ? -1 : 1)).at(-1);
    expect(state.computed_at).toBe(last?.at);
  });

  it("gives the same bytes for 50 orders of the same events", async () => {
    const { a, b, events } = await twoMachines();
    // A fork, a forged event and its descendant: the hard cases are ordered too.
    const head = headOf(events.filter((e) => e.actor.device === b.device).at(-1) as EventEnvelope);
    const forkA = await signed(b, head, [draft(20)], { start: START + 900_000 });
    const forkB = await signed(b, head, [draft(21)], { start: START + 900_000 });
    const headA = headOf(
      events.filter((e) => e.actor.device === a.key.device).at(-1) as EventEnvelope,
    );
    const [genuine] = await signed(a.key, headA, [draft(30)], { start: START + 950_000 });
    const tampered = { ...(genuine as EventEnvelope), payload: { n: 31 } };
    const [child] = await signed(a.key, headOf(tampered), [draft(32)], { start: START + 960_000 });
    const all = [...events, ...forkA, ...forkB, tampered, child as EventEnvelope];
    const reference = stateFile(await project(all, { head: "h" }));
    for (let seed = 1; seed <= 50; seed++) {
      const state = await project(shuffled(all, seed), { head: "h" });
      expect(stateFile(state)).toBe(reference);
    }
  });

  it("ignores a forged event (bad_signature) and its descendants (broken_chain)", async () => {
    const { a, events } = await twoMachines();
    const head = headOf(
      events.filter((e) => e.actor.device === a.key.device).at(-1) as EventEnvelope,
    );
    const [genuine] = await signed(a.key, head, [draft(5)]);
    const forged = { ...(genuine as EventEnvelope), payload: { n: 666 } };
    const [child] = await signed(a.key, headOf(forged), [draft(6)]);
    const state = await project([...events, forged, child as EventEnvelope]);
    expect(ignoredOf(state)).toEqual({
      [forged.id]: "bad_signature",
      [(child as EventEnvelope).id]: "broken_chain",
    });
    expect(state.applied).toBe(10);
  });

  it("ignores an event of a device without device.registered (unknown_signer)", async () => {
    const { events } = await twoMachines();
    const stranger = await loadMachineKey(
      new MemoryKeyStore(toBase64url(new Uint8Array(32).fill(7))),
    );
    const [registration, own] = await signed(stranger, null, [draft(1)]);
    expect(registration?.type).toBe("device.registered");
    const state = await project([...events, own as EventEnvelope]);
    expect(state.ignored).toEqual([{ id: (own as EventEnvelope).id, reason: "unknown_signer" }]);
  });

  it("keeps both branches of a fork, with a chain_fork warning", async () => {
    const { b, events } = await twoMachines();
    const head = headOf(events.filter((e) => e.actor.device === b.device).at(-1) as EventEnvelope);
    const [first] = await signed(b, head, [draft(20)], { start: START + 900_000 });
    const [second] = await signed(b, head, [draft(21)], { start: START + 910_000 });
    const state = await project([...events, first, second] as EventEnvelope[]);
    expect(state.ignored).toEqual([]);
    expect(state.applied).toBe(12);
    expect(state.warnings).toEqual([
      {
        code: "chain_fork",
        device: b.device,
        prev: head.hash,
        ids: [first?.id, second?.id],
      },
    ]);
  });

  it("ignores an event of another product (wrong_product), and its descendants", async () => {
    const { a, events } = await twoMachines();
    const head = headOf(
      events.filter((e) => e.actor.device === a.key.device).at(-1) as EventEnvelope,
    );
    const [other, next] = await signed(
      a.key,
      head,
      [draft(1, OTHER_PRODUCT), draft(2, OTHER_PRODUCT)],
      {
        journalProduct: OTHER_PRODUCT,
      },
    );
    const state = await project([...events, other, next] as EventEnvelope[]);
    expect(ignoredOf(state)).toEqual({
      [(other as EventEnvelope).id]: "wrong_product",
      [(next as EventEnvelope).id]: "wrong_product",
    });
  });

  it("breaks a chain whose prev is absent or another device's", async () => {
    const { a, b, events } = await twoMachines();
    const fromB = events.filter((e) => e.actor.device === b.device);
    const missing = { id: "01JZ9999999999999999999999", hash: `sha256:${"A".repeat(43)}` };
    const [orphan] = await signed(a.key, missing, [draft(40)]);
    const [crossing] = await signed(a.key, headOf(fromB.at(-1) as EventEnvelope), [draft(41)]);
    const state = await project([...events, orphan, crossing] as EventEnvelope[]);
    expect(ignoredOf(state)).toEqual({
      [(orphan as EventEnvelope).id]: "broken_chain",
      [(crossing as EventEnvelope).id]: "broken_chain",
    });
  });

  it("ignores a second key for a device (key_conflict), even with a smaller ULID", async () => {
    const { a, events } = await twoMachines();
    const registration = events[0] as EventEnvelope;
    const other = await loadMachineKey(new MemoryKeyStore(SEED_B));
    const { sig: _sig, ...unsigned } = registration;
    /** Signed by the other key, which it publishes, under `device`. */
    const publish = (id: string, device: string) =>
      signEd25519(
        {
          ...unsigned,
          id,
          actor: { kind: "system", device },
          payload: { public_key: toBase64url(other.publicKey) },
        } as UnsignedEventEnvelope,
        other.secretKey,
      ) as Promise<EventEnvelope>;
    expect(registration.id > "01JZ8888888888888888888888").toBe(true);
    const conflicting = await publish("01JZ8888888888888888888888", a.key.device);
    // A device without a registration of its own: the key does not give its id.
    const stray = await publish("01JZ8888888888888888888889", "machine:AAAAAAAAAAAAAAAA");
    const state = await project([...events, conflicting, stray]);
    expect(ignoredOf(state)).toEqual({
      "01JZ8888888888888888888888": "key_conflict",
      "01JZ8888888888888888888889": "invalid",
    });
    expect(state.devices.find((d) => d.device === a.key.device)?.public_key).toBe(
      toBase64url(a.key.publicKey),
    );
    expect(state.applied).toBe(10);
  });

  it("converts an older format when reading (test type, v: 0), and applies it", async () => {
    const { a, events } = await twoMachines();
    const head = headOf(
      events.filter((e) => e.actor.device === a.key.device).at(-1) as EventEnvelope,
    );
    const [current] = await signed(a.key, head, [draft(0)]);
    const { sig: _sig, ...unsigned } = current as EventEnvelope;
    const old = (await signEd25519(
      { ...unsigned, v: 0, payload: { number: 99 } } as UnsignedEventEnvelope,
      a.key.secretKey,
    )) as EventEnvelope;
    const before = JSON.stringify(old);
    const state = await project([...events, old]);
    expect(state.ignored).toEqual([]);
    const { payloads } = state.state.test as { payloads: unknown[] };
    expect(payloads).toContainEqual({ n: 99 });
    expect(payloads).not.toContainEqual({ number: 99 });
    expect(JSON.stringify(old)).toBe(before);
  });

  it("stops with UPGRADE_REQUIRED on an unknown type signed by a registered device", async () => {
    const { a, events } = await twoMachines();
    const teleported = await signedAs(a.key, lastOf(events, a.key.device), {
      type: "story.teleported",
    });
    await expect(project([...events, teleported])).rejects.toMatchObject({
      code: ErrorCode.UPGRADE_REQUIRED,
      message_key: "error.event_type_upgrade_required.install",
      details: { type: "story.teleported", version: 1 },
    });
  });

  it("ignores an unknown type it cannot verify, instead of stopping everyone", async () => {
    const { a, events } = await twoMachines();
    const teleported = await signedAs(a.key, lastOf(events, a.key.device), {
      type: "story.teleported",
    });
    const forged = { ...teleported, payload: { n: 1 } };
    const stranger = await loadMachineKey(
      new MemoryKeyStore(toBase64url(new Uint8Array(32).fill(7))),
    );
    const unknown = await signedAs(stranger, lastOf(events, a.key.device), {
      type: "story.teleported",
      actor: { kind: "system", device: stranger.device },
    });
    const state = await project([...events, forged, unknown]);
    expect(ignoredOf(state)).toEqual({
      [forged.id]: "bad_signature",
      [unknown.id]: "unknown_signer",
    });
  });

  it("stops on a newer envelope only when its writer's signature verifies", async () => {
    const { a, events } = await twoMachines();
    const newer = await signedAs(a.key, lastOf(events, a.key.device), { v: 2 });
    const problem = (raw: unknown, id = newer.id) => ({
      path: `journal/2026/10/${id}.json`,
      raw,
      error: {
        code: ErrorCode.UPGRADE_REQUIRED,
        message_key: "error.event_upgrade_required",
        details: { field: "v", version: 2, supported: 1, type: TEST_EVENT_TYPE },
      },
    });
    await expect(project(events, { problems: [problem(newer)] })).rejects.toMatchObject({
      code: ErrorCode.UPGRADE_REQUIRED,
      message_key: "error.event_type_upgrade_required.install",
      details: { type: TEST_EVENT_TYPE, version: 2, supported: 1 },
    });
    const state = await project(events, {
      problems: [
        problem({ ...newer, payload: { n: 5 } }, "01JZ7777777777777777777771"),
        problem(
          { ...newer, actor: { kind: "system", device: "machine:AAAAAAAAAAAAAAAA" } },
          "01JZ7777777777777777777772",
        ),
        problem({ v: 2 }, "01JZ7777777777777777777773"),
        problem(undefined, "01JZ7777777777777777777774"),
      ],
    });
    expect(ignoredOf(state)).toEqual({
      "01JZ7777777777777777777771": "bad_signature",
      "01JZ7777777777777777777772": "unknown_signer",
      "01JZ7777777777777777777773": "invalid",
      "01JZ7777777777777777777774": "invalid",
    });
  });

  it("reports an unreadable entry as invalid, with the id of its file", async () => {
    const { events } = await twoMachines();
    const problem = {
      path: "journal/2026/10/01JZ6666666666666666666666.json",
      error: eventInvalid("payload", "reason.invalid_value"),
    };
    const state = await project(events, { problems: [problem] });
    expect(state.ignored).toEqual([{ id: "01JZ6666666666666666666666", reason: "invalid" }]);
  });

  it("refuses an engine event whose payload is encrypted", async () => {
    const { events } = await twoMachines();
    const stranger = await loadMachineKey(
      new MemoryKeyStore(toBase64url(new Uint8Array(32).fill(9))),
    );
    const [registration] = await signed(stranger, null, [draft(1)]);
    const { sig: _sig, payload: _payload, ...rest } = registration as EventEnvelope;
    const encrypted = (await signEd25519(
      { ...rest, payload_enc: { alg: "x", nonce: "AA", ct: "AA" } } as UnsignedEventEnvelope,
      stranger.secretKey,
    )) as EventEnvelope;
    const state = await project([...events, encrypted]);
    expect(state.ignored).toEqual([{ id: encrypted.id, reason: "invalid" }]);
  });

  it("pins the product of method.yaml: another product.created is a product_conflict", async () => {
    const { a, events } = await twoMachines();
    // A device of its own, registered, whose product.created names another product.
    const intruder = await loadMachineKey(
      new MemoryKeyStore(toBase64url(new Uint8Array(32).fill(5))),
    );
    const theirs = await signed(intruder, null, [draft(1, OTHER_PRODUCT)], {
      journalProduct: null,
      start: START - 500_000,
    });
    expect(theirs.map((e) => e.type)).toEqual([
      "device.registered",
      "product.created",
      TEST_EVENT_TYPE,
    ]);
    const [registration, created, own] = theirs as [EventEnvelope, EventEnvelope, EventEnvelope];
    // Without a pin, the smallest ULID would win: the product of method.yaml decides.
    const state = await project([...events, ...theirs], { product: PRODUCT });
    expect(state.product).toBe(PRODUCT);
    expect(ignoredOf(state)).toEqual({
      [registration.id]: "wrong_product",
      [created.id]: "product_conflict",
      [own.id]: "wrong_product",
    });
    expect(state.applied).toBe(10);
    // Pinned to the other product, the journal's own events are the ones ignored.
    const other = await project(events, { product: OTHER_PRODUCT });
    expect(other.applied).toBe(0);
    expect(ignoredOf(other)[(events[1] as EventEnvelope).id]).toBe("product_conflict");
    expect(a.key.device).not.toBe(intruder.device);
  });

  it("never mixes products when no product.created is known", async () => {
    const { a, events } = await twoMachines();
    const withoutCreated = events.filter((e) => e.type !== "product.created");
    // A's chain lost its product.created: only B's events, and its own, hold.
    const b = await loadMachineKey(new MemoryKeyStore(toBase64url(new Uint8Array(32).fill(6))));
    const [registration, other] = await signed(b, null, [draft(1, OTHER_PRODUCT)], {
      journalProduct: OTHER_PRODUCT,
      start: START + 999_000,
    });
    const state = await project([...withoutCreated, registration, other] as EventEnvelope[]);
    expect(state.product).toBeNull();
    expect(ignoredOf(state)[(other as EventEnvelope).id]).toBe("wrong_product");
    expect(ignoredOf(state)[(registration as EventEnvelope).id]).toBe("wrong_product");
    expect(a.key.device).toBeDefined();
  });

  it("ignores the test types (test_type) unless tests allow them", async () => {
    const { events } = await twoMachines();
    const state = await computeProjection(events);
    expect(state.applied).toBe(3);
    expect(state.state).toEqual({});
    expect(new Set(state.ignored.map((entry) => entry.reason))).toEqual(new Set(["test_type"]));
    expect(state.ignored).toHaveLength(7);
  });

  it("projects an empty journal", async () => {
    expect(await project([])).toEqual({
      format: 1,
      journal_head: null,
      computed_at: null,
      product: null,
      devices: [],
      applied: 0,
      ignored: [],
      warnings: [],
      state: {},
    });
  });
});

describe("projectState", () => {
  const METHOD = `format_version: 2\nengine_version: 0.1.0\nproduct_id: ${PRODUCT}\n`;
  const installed = () => new MemoryFiles({ ".agentplugged/method.yaml": METHOD });
  const options = { productId: PRODUCT, allowTestTypes: true };

  it("computes from the journal every time, and writes state.json only when its bytes change", async () => {
    const { a } = await twoMachines();
    const files = installed();
    const first = await projectState(a.store, files, options);
    expect(first).toMatchObject({ file: "written", warnings: [] });
    const text = files.files.get(STATE_CACHE_PATH);
    expect(text).toBe(stateFile(first.state));
    expect(JSON.parse(text ?? "").journal_head).toBe(await a.store.head());
    expect(await a.store.projected()).toBe(await a.store.head());

    const again = await projectState(a.store, files, options);
    expect(again).toMatchObject({ file: "unchanged", warnings: [] });
    expect(again.state).toEqual(first.state);
    expect(files.writes.filter((path) => path === STATE_CACHE_PATH)).toHaveLength(1);

    await a.store.append(draft(5));
    const moved = await projectState(a.store, files, options);
    expect(moved.file).toBe("written");
    expect(moved.state.applied).toBe(first.state.applied + 1);
  });

  it("computes the same state again when the cache is deleted or unreadable", async () => {
    const { a } = await twoMachines();
    const files = installed();
    await projectState(a.store, files, options);
    const reference = files.files.get(STATE_CACHE_PATH);
    files.files.delete(STATE_CACHE_PATH);
    expect((await projectState(a.store, files, options)).file).toBe("written");
    expect(files.files.get(STATE_CACHE_PATH)).toBe(reference);
    files.seed(STATE_CACHE_PATH, "{ not json");
    expect((await projectState(a.store, files, options)).file).toBe("written");
    expect(files.files.get(STATE_CACHE_PATH)).toBe(reference);
  });

  it("never reads state.json as a source, even one written for the right head", async () => {
    const { a } = await twoMachines();
    const files = installed();
    const forged = {
      ...(await computeProjection([])),
      journal_head: await a.store.head(),
      applied: 99,
    };
    files.seed(STATE_CACHE_PATH, stateFile(forged));
    const result = await projectState(a.store, files, options);
    expect(result.file).toBe("written");
    expect(result.state.applied).toBe(10);
  });

  it("warns history_rewritten in the result only, never in state.json", async () => {
    const { a, events } = await twoMachines();
    const files = installed();
    await projectState(a.store, files, options);
    a.store.rewrite(events.slice(0, 5));
    const result = await projectState(a.store, files, options);
    expect(result.warnings).toEqual([{ code: "history_rewritten", missing: 5, unknown: false }]);
    expect(result.state.warnings).toEqual([]);
    expect(result.state.applied).toBe(5);
    // The same bytes as a machine that never saw the old history.
    const fresh = new MemoryStateStore({ keys: new MemoryKeyStore(SEED_A) });
    fresh.rewrite(events.slice(0, 5));
    const elsewhere = installed();
    await projectState(fresh, elsewhere, options);
    expect(elsewhere.files.get(STATE_CACHE_PATH)?.replace(/"journal_head":"[^"]*"/, "")).toBe(
      files.files.get(STATE_CACHE_PATH)?.replace(/"journal_head":"[^"]*"/, ""),
    );
    expect(await a.store.projected()).toBe(await a.store.head());
  });

  it("warns without a count when the projected position is unknown, and clears it for an empty journal", async () => {
    const { a } = await twoMachines();
    const files = installed();
    await a.store.markProjected("memory:7.99", null);
    const unknown = await projectState(a.store, files, options);
    expect(unknown.warnings).toEqual([{ code: "history_rewritten", missing: 0, unknown: true }]);
    expect(await a.store.projected()).toBe(await a.store.head());

    a.store.rewrite([]);
    const empty = await projectState(a.store, files, options);
    expect(empty.state.applied).toBe(0);
    expect(empty.warnings).toEqual([{ code: "history_rewritten", missing: 10, unknown: false }]);
    expect(await a.store.projected()).toBeNull();
  });

  it("writes nothing on UPGRADE_REQUIRED", async () => {
    const { a, events } = await twoMachines();
    const files = installed();
    const teleported = await signedAs(a.key, lastOf(events, a.key.device), {
      type: "story.teleported",
    });
    a.store.rewrite([...events, teleported]);
    await expect(projectState(a.store, files, options)).rejects.toBeInstanceOf(AgentPluggedError);
    expect(files.writes).toEqual([]);
    expect(await a.store.projected()).toBeNull();
  });

  it("does not create .agentplugged/ where the method is not installed", async () => {
    const { a } = await twoMachines();
    const files = new MemoryFiles();
    const result = await projectState(a.store, files, options);
    expect(result.file).toBe("not_installed");
    expect(files.writes).toEqual([]);
  });
});

describe("append", () => {
  it("refuses an unknown type or a newer version (UPGRADE_REQUIRED)", async () => {
    const { store } = await machine(SEED_A);
    await expect(store.append({ ...draft(1), type: "story.teleported" })).rejects.toMatchObject({
      code: ErrorCode.UPGRADE_REQUIRED,
      details: { type: "story.teleported", version: 1, supported: null },
    });
    await expect(
      store.append({ ...draft(1), v: 2 } as unknown as EventDraft),
    ).rejects.toMatchObject({ code: ErrorCode.UPGRADE_REQUIRED });
    expect(store.events).toEqual([]);
  });

  it("writes only the current version: an older, negative or fractional v is EVENT_INVALID", async () => {
    const { store } = await machine(SEED_A);
    for (const v of [0, -1, 1.5]) {
      await expect(store.append({ ...draft(1), v } as unknown as EventDraft)).rejects.toMatchObject(
        { code: ErrorCode.EVENT_INVALID, details: { field: "v" } },
      );
    }
    expect(store.events).toEqual([]);
  });

  it("refuses the test types unless the store allows them", async () => {
    const store = new MemoryStateStore({ keys: new MemoryKeyStore(SEED_A) });
    await expect(store.append(draft(1))).rejects.toMatchObject({
      code: ErrorCode.EVENT_INVALID,
      details: { field: "type", reason_key: "reason.test_type" },
    });
    expect(store.events).toEqual([]);
  });
});

describe("journal status", () => {
  const context = (
    journal?: MemoryStateStore,
    method = `format_version: 2\nengine_version: 0.1.0\nproduct_id: ${PRODUCT}\n`,
  ): CommandContext => ({
    files: new MemoryFiles({ ".agentplugged/method.yaml": method }),
    tools: { findCommand: async () => undefined, findExtensions: async () => [] } as never,
    method: {
      listFiles: async () => [],
      readText: async () => "",
      readBytes: async () => new Uint8Array(),
    },
    actor: "human",
    engineVersion: "0.1.0",
    journal,
    allowTestTypes: true,
  });

  it("runs the projection through the journal port, pinned by method.yaml", async () => {
    const { a } = await twoMachines();
    const result = await journalCommand.run(context(a.store), { action: "status" });
    expect(result).toMatchObject({
      ok: true,
      value: { file: "written", state: { applied: 10, product: PRODUCT } },
    });
    const other = `format_version: 2\nengine_version: 0.1.0\nproduct_id: ${OTHER_PRODUCT}\n`;
    const pinned = await journalCommand.run(context(a.store, other), { action: "status" });
    expect(pinned).toMatchObject({ ok: true, value: { state: { applied: 0 } } });
    const invalid = await journalCommand.run(context(a.store, "format_version: 9\n"), {
      action: "status",
    });
    expect(invalid.ok).toBe(false);
    const none = await journalCommand.run(context(), { action: "status" });
    expect(none.ok || none.error.code).toBe(ErrorCode.UNEXPECTED);
    const remote = await journalCommand.run(context(a.store), { action: "status", remote: "x" });
    expect(remote.ok || remote.error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
  });
});
