import { encryptPayload, eventHash, signEd25519, toBase64url } from "@agentplugged/crypto";
import {
  BUDGET_EVENT_TYPES,
  CHAT_EVENT_TYPES,
  CHECKPOINT_EVENT_TYPES,
  type CodedErrorPayload,
  checkpointIdOf,
  DEVICE_TRUST_SYSTEM_EVENT_TYPES,
  ErrorCode,
  EVENT_ENVELOPE_VERSION,
  EVENT_REASON,
  EVENT_TYPE_PATTERN,
  EVENT_TYPES,
  type EventEnvelope,
  type EventTypeSpec,
  EXTENSION_EVENT_VERSION,
  eventInvalid,
  eventTypeSpec,
  eventTypeUpgrade,
  HUMAN_ONLY_EVENT_TYPES,
  isExtensionEventType,
  isSensitiveEventType,
  isTestEventType,
  MACHINE_EVENT_TYPES,
  MEMORY_EVENT_TYPES,
  MERGE_ORDER_EVENT_TYPES,
  METHOD_EVENT_TYPES,
  ORDER_EVENT_TYPES,
  PRODUCT_KEY_EVENT_TYPES,
  parseEventEnvelope,
  READINESS_EVENT_TYPES,
  RESERVED_EVENT_TYPES,
  SPRINT_EVENT_TYPES,
  type UnsignedEventEnvelope,
} from "@agentplugged/protocol";
import { AgentPluggedError } from "../errors.js";

import type { MachineKey } from "./key-store.js";
import {
  type AnnouncedKey,
  type ProductKey,
  productKeyMissing,
  writingKey,
} from "./product-key.js";
import type { EventDraft } from "./state-store.js";
import type { Clock, UlidFactory } from "./ulid.js";

/** The last event of one writer (`actor.device`) in the journal: what its next `prev` names. */
export interface DeviceHead {
  readonly id: string;
  /** `eventHash` of the event: `sha256:` then base64url. */
  readonly hash: string;
}

function thrown(error: CodedErrorPayload): AgentPluggedError {
  return new AgentPluggedError(error.code, error.message_key, error.details);
}

/** Hash of an event (`prev` of its successor); throws `EVENT_INVALID` when it has no JSON form. */
export function hashOf(event: EventEnvelope): string {
  const result = eventHash(event);
  if (!result.ok) throw thrown(result.error);
  return result.hash;
}

async function signed(unsigned: UnsignedEventEnvelope, key: MachineKey): Promise<EventEnvelope> {
  const event = await signEd25519(unsigned, key.secretKey);
  const parsed = parseEventEnvelope(event);
  if (!parsed.success) throw thrown(parsed.error);
  return parsed.data;
}

export interface PreparedAppend {
  /** Events to write, in order: `device.registered` first on the machine's first write. */
  readonly events: readonly EventEnvelope[];
  /** The events of the drafts, in the drafts' order (the last ones of `events`). */
  readonly written: readonly EventEnvelope[];
  /** The device's head after them. */
  readonly head: DeviceHead;
}

type Body = Omit<UnsignedEventEnvelope, "v" | "id" | "at" | "prev" | "alg">;

/** `PRODUCT_ID_MISMATCH`: `productId` is not the one the journal holds. */
export function productIdMismatch(productId: string, journalProductId: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.PRODUCT_ID_MISMATCH, "error.product_id_mismatch", {
    product_id: productId,
    journal_product_id: journalProductId,
  });
}

/** Refuses a draft this engine must not write; see `prepareAppend`. */
function checkDraft(
  draft: EventDraft,
  key: MachineKey,
  journalProduct: string,
  allowTestTypes: boolean,
): void {
  if (RESERVED_EVENT_TYPES.has(draft.type)) {
    throw thrown(eventInvalid("type", EVENT_REASON.reservedType));
  }
  // The same check as the projection's: a type or a version this engine does not know is never
  // written (`UPGRADE_REQUIRED`), and the payload must match its type's schema.
  if (!EVENT_TYPE_PATTERN.test(draft.type)) {
    throw thrown(eventInvalid("type", EVENT_REASON.eventType));
  }
  const version: unknown = draft.v;
  if (version !== undefined && (!Number.isInteger(version) || (version as number) < 0)) {
    throw thrown(eventInvalid("v", EVENT_REASON.invalidValue));
  }
  // A creator's event is written by a creator's command only, signed by the creator's key
  // (`appendHuman`): never through an agent's or the engine's write.
  if (draft.actor.kind === "human") {
    throw thrown(eventInvalid("actor.kind", EVENT_REASON.humanOnly));
  }
  if (HUMAN_ONLY_EVENT_TYPES.has(draft.type)) {
    throw thrown(eventInvalid("type", EVENT_REASON.humanOnly));
  }
  // The registry of trusted devices is written by the engine's own commands (the
  // bridge), as a system actor: never by an agent, whatever it puts in its draft.
  if (DEVICE_TRUST_SYSTEM_EVENT_TYPES.has(draft.type) && draft.actor.kind !== "system") {
    throw thrown(eventInvalid("actor.kind", EVENT_REASON.reservedType));
  }
  if (isTestEventType(draft.type) && !allowTestTypes) {
    throw thrown(eventInvalid("type", EVENT_REASON.testType));
  }
  if (isExtensionEventType(draft.type)) {
    // An extension event: always at the extension version, its content free (the module checks
    // it), written by an agent or the system, encrypted like every sensitive content.
    if (version !== undefined && version !== EXTENSION_EVENT_VERSION) {
      throw thrown(eventInvalid("v", EVENT_REASON.invalidValue));
    }
    if (draft.actor.device !== undefined && draft.actor.device !== key.device) {
      throw thrown(eventInvalid("actor.device", EVENT_REASON.invalidValue));
    }
    if (journalProduct !== draft.product) throw productIdMismatch(draft.product, journalProduct);
    return;
  }
  const upgrade = eventTypeUpgrade(
    draft.type,
    (version as number | undefined) ?? eventTypeSpec(draft.type)?.version ?? EVENT_ENVELOPE_VERSION,
  );
  if (upgrade !== undefined) throw thrown(upgrade);
  const spec = eventTypeSpec(draft.type) as EventTypeSpec;
  // Only the current version is written: an older format exists to be read, never written.
  if (version !== undefined && version !== spec.version) {
    throw thrown(eventInvalid("v", EVENT_REASON.invalidValue));
  }
  if (draft.payload !== undefined && !spec.payload.safeParse(draft.payload).success) {
    throw thrown(eventInvalid("payload", EVENT_REASON.invalidValue));
  }
  if (draft.actor.device !== undefined && draft.actor.device !== key.device) {
    throw thrown(eventInvalid("actor.device", EVENT_REASON.invalidValue));
  }
  if (journalProduct !== draft.product) throw productIdMismatch(draft.product, journalProduct);
  // The product key's announcement is the engine's own (`init`), signed by the machine.
  // So is a migration of the format (`migrate`).
  const engineOwn =
    draft.type === PRODUCT_KEY_EVENT_TYPES.keyCreated ||
    draft.type === PRODUCT_KEY_EVENT_TYPES.keyRotated ||
    draft.type === METHOD_EVENT_TYPES.migrated ||
    draft.type === MACHINE_EVENT_TYPES.primaryChanged ||
    draft.type === ORDER_EVENT_TYPES.applied ||
    draft.type === ORDER_EVENT_TYPES.rejected;
  if (engineOwn && draft.actor.kind !== "system") {
    throw thrown(eventInvalid("actor.kind", EVENT_REASON.reservedType));
  }
}

/**
 * A well-formed checkpoint id, standing for the one a linked draft names while its payload is
 * checked; never signed (`linkedPayload` replaces it, or the write fails).
 */
const CHECKPOINT_PLACEHOLDER = "G-0000000000";

/** The only field a draft may link to the checkpoint of its write. */
const LINKED_CHECKPOINT_FIELD = "checkpoint";

/**
 * The payload of a draft, its linked field set to the checkpoint `opened` opened: `opened` must
 * be the `checkpoint.opened` written just before it in this write, else the write fails.
 */
function linkedPayload(
  draft: EventDraft,
  opened: EventEnvelope | undefined,
): EventDraft["payload"] {
  const field = draft.checkpointField;
  if (field === undefined) return draft.payload;
  if (opened?.type !== CHECKPOINT_EVENT_TYPES.opened) {
    throw thrown(eventInvalid("checkpointField", EVENT_REASON.invalidValue));
  }
  return { ...draft.payload, [field]: checkpointIdOf(opened.id) };
}

/**
 * The draft as checked: a draft with `checkpointField` must follow a `checkpoint.opened` of the
 * same write (else `EVENT_INVALID`), and its payload is checked with a placeholder id there.
 */
function linkedForCheck(draft: EventDraft, previous: EventDraft | undefined): EventDraft {
  const field = draft.checkpointField;
  if (field === undefined) return draft;
  // Only a sprint, a retrospective, a budget threshold, a
  // conflict of substance qualified, a blocking readiness report and an automatic application name the checkpoint of their write, in their `checkpoint` field.
  if (
    (draft.type !== SPRINT_EVENT_TYPES.planned &&
      draft.type !== MEMORY_EVENT_TYPES.retrospectiveProposed &&
      draft.type !== BUDGET_EVENT_TYPES.thresholdReached &&
      draft.type !== CHAT_EVENT_TYPES.autoApplied &&
      draft.type !== MERGE_ORDER_EVENT_TYPES.conflictQualified &&
      draft.type !== READINESS_EVENT_TYPES.reported) ||
    field !== LINKED_CHECKPOINT_FIELD ||
    previous?.type !== CHECKPOINT_EVENT_TYPES.opened
  ) {
    throw thrown(eventInvalid("checkpointField", EVENT_REASON.invalidValue));
  }
  return { ...draft, payload: { ...draft.payload, [field]: CHECKPOINT_PLACEHOLDER } };
}

/** True when the draft's payload is sensitive content, written encrypted. */
function sensitiveDraft(draft: EventDraft): boolean {
  return draft.payload !== undefined && isSensitiveEventType(draft.type);
}

/**
 * Completes, chains and signs one draft, or several written together (one write, in order).
 * `deviceHead` is the machine's last event in the journal, or null when it never wrote there: its
 * public key is then published first by `device.registered` (`payload: { public_key }`), signed
 * by itself. `journalProduct` is the journal's product id, or null when it has no
 * `product.created` yet: that event (the first draft's `product`) is then written next, before
 * the drafts. A type or a version this engine does not know gives `UPGRADE_REQUIRED`; a `v`
 * other than the type's current version, a type reserved to tests (`test.*`) without
 * `allowTestTypes`, or a payload its type refuses give `EVENT_INVALID`. Every draft is checked
 * before any is prepared, and all must name the same product. Each id is greater than the
 * device's previous one, so one writer's events sort in chain order.
 */
export async function prepareAppend(input: {
  readonly draft: EventDraft | readonly EventDraft[];
  readonly key: MachineKey;
  readonly deviceHead: DeviceHead | null;
  readonly journalProduct: string | null;
  readonly newId: UlidFactory;
  readonly now: Clock;
  /** Accepts the types reserved to tests (`test.*`): tests and measurements only. */
  readonly allowTestTypes?: boolean;
  /**
   * The product key: the payload of a sensitive type is written encrypted with it
   * (`payload_enc`). Without it, a sensitive draft gives `PRODUCT_KEY_MISSING`, nothing written.
   */
  readonly productKey?: ProductKey;
  /**
   * The product key the journal announces (`announcedKey`), when a sensitive draft is written: a
   * held key with another `key_id` gives `PRODUCT_KEY_MISMATCH`, nothing written.
   */
  readonly announced?: AnnouncedKey | null;
}): Promise<PreparedAppend> {
  const { key } = input;
  const drafts: readonly EventDraft[] = Array.isArray(input.draft)
    ? input.draft
    : [input.draft as EventDraft];
  const first = drafts[0];
  if (first === undefined) throw new Error("prepareAppend: no draft");
  drafts.forEach((draft, index) => {
    checkDraft(
      linkedForCheck(draft, drafts[index - 1]),
      key,
      input.journalProduct ?? first.product,
      input.allowTestTypes === true,
    );
  });
  // The key the journal announces, found among the keys the machine holds (the one a renewal made
  // current, or one it keeps and is about to take up).
  let productKey: ProductKey | undefined;
  if (drafts.some((draft) => sensitiveDraft(draft))) {
    if (input.productKey === undefined) {
      throw productKeyMissing(input.journalProduct ?? first.product);
    }
    productKey = await writingKey(input.announced ?? null, input.productKey);
  }
  const engine = await prepareEngineEvents({
    key,
    deviceHead: input.deviceHead,
    journalProduct: input.journalProduct,
    product: first.product,
    newId: input.newId,
    now: input.now,
  });
  const events: EventEnvelope[] = [...engine.events];
  let head = engine.head;
  const complete = async (body: Body, encrypt: boolean): Promise<DeviceHead> => {
    let unsigned = unsign(body, head, input);
    if (encrypt && productKey !== undefined && unsigned.payload !== undefined) {
      // Encrypted before it is signed: the signature covers `payload_enc`, and the ciphertext is
      // bound to the rest of the envelope (its associated data).
      const { payload, ...envelope } = unsigned;
      unsigned = {
        ...envelope,
        payload_enc: await encryptPayload(envelope, payload, productKey.key),
      } as UnsignedEventEnvelope;
    }
    const event = await signed(unsigned, key);
    events.push(event);
    return { id: event.id, hash: hashOf(event) };
  };
  for (const draft of drafts) {
    const { v: _v, actor, checkpointField: _field, ...rest } = draft;
    // The checkpoint the previous draft opened, named in this one's payload.
    const payload = linkedPayload(draft, events.at(-1));
    head = await complete(
      {
        ...rest,
        ...(payload === undefined ? {} : { payload }),
        actor: { ...actor, device: key.device },
      } as Body,
      sensitiveDraft(draft),
    );
  }
  if (head === null) throw new Error("prepareAppend: nothing was prepared");
  return { events, written: events.slice(engine.events.length), head };
}

/** The envelope of `body`, completed after `head`: ULID, clock, `prev`, `alg: ed25519`. */
function unsign(
  body: Body,
  head: DeviceHead | null,
  input: { readonly newId: UlidFactory; readonly now: Clock },
): UnsignedEventEnvelope {
  const time = input.now();
  return {
    ...body,
    // The draft type's current version (`checkpoint.opened` is at 2).
    v: eventTypeSpec(body.type)?.version ?? EVENT_ENVELOPE_VERSION,
    id: input.newId(head?.id, time),
    at: new Date(time).toISOString(),
    prev: head?.hash ?? null,
    alg: "ed25519",
  } as UnsignedEventEnvelope;
}

/**
 * The engine's own events a write needs first, signed by the machine key: `device.registered`
 * when the machine never wrote to this journal (`deviceHead` null), then `product.created` (for
 * `product`) when the journal has none (`journalProduct` null). `head` is the machine's head after
 * them (its `deviceHead` when none is needed).
 */
export async function prepareEngineEvents(input: {
  readonly key: MachineKey;
  readonly deviceHead: DeviceHead | null;
  readonly journalProduct: string | null;
  readonly product: string;
  readonly newId: UlidFactory;
  readonly now: Clock;
}): Promise<{ events: EventEnvelope[]; head: DeviceHead | null }> {
  const { key, product } = input;
  const events: EventEnvelope[] = [];
  let head = input.deviceHead;
  const complete = async (body: Body): Promise<DeviceHead> => {
    const event = await signed(unsign(body, head, input), key);
    events.push(event);
    return { id: event.id, hash: hashOf(event) };
  };
  if (head === null) {
    head = await complete({
      type: EVENT_TYPES.deviceRegistered,
      actor: { kind: "system", device: key.device },
      product,
      provenance: "trusted",
      payload: { public_key: toBase64url(key.publicKey) },
    });
  }
  if (input.journalProduct === null) {
    head = await complete({
      type: EVENT_TYPES.productCreated,
      actor: { kind: "system", device: key.device },
      product,
      provenance: "trusted",
      payload: { product_id: product },
    });
  }
  return { events, head };
}

/**
 * The last event of each writer. One rule, here and in the Git store's cache: **the greatest ULID
 * among the writer's chain tips** (events no other event names as `prev`); all its events when
 * a cycle leaves no tip. Events whose hash cannot be computed are skipped.
 */
export function deviceHeads(events: Iterable<EventEnvelope>): Map<string, DeviceHead> {
  const byDevice = new Map<string, DeviceHead[]>();
  const referenced = new Set<string>();
  for (const event of events) {
    const result = eventHash(event);
    if (!result.ok) continue;
    if (event.prev !== null) referenced.add(event.prev);
    const list = byDevice.get(event.actor.device) ?? [];
    list.push({ id: event.id, hash: result.hash });
    byDevice.set(event.actor.device, list);
  }
  const heads = new Map<string, DeviceHead>();
  for (const [device, list] of byDevice) {
    const tips = list.filter((entry) => !referenced.has(entry.hash));
    const candidates = tips.length > 0 ? tips : list;
    heads.set(
      device,
      candidates.reduce((a, b) => (b.id > a.id ? b : a)),
    );
  }
  return heads;
}

/**
 * The same rule applied one event at a time, in journal order, when only the current head is
 * known (the Git store's cache): `event` becomes a tip, and `current` stays one unless `event`
 * names it as `prev`; the greater ULID of the two wins. It gives what `deviceHeads` gives as long
 * as ids grow along each chain, which `prepareAppend` guarantees.
 */
export function nextDeviceHead(
  current: DeviceHead | undefined,
  event: EventEnvelope,
  hash: string,
): DeviceHead {
  const added = { id: event.id, hash };
  if (current === undefined || event.prev === current.hash) return added;
  return added.id > current.id ? added : current;
}

/** The journal's product id: its first `product.created` event (smallest ULID), or null. */
export function journalProduct(events: Iterable<EventEnvelope>): EventEnvelope | null {
  let found: EventEnvelope | null = null;
  for (const event of events) {
    if (event.type !== EVENT_TYPES.productCreated) continue;
    if (found === null || event.id < found.id) found = event;
  }
  return found;
}
