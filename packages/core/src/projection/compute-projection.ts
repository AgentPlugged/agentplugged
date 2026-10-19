import {
  canonicalBytes,
  decryptPayload,
  eventHash,
  fromBase64url,
  signedBytes,
  verifyEd25519,
  verifyEvent,
  verifyProductKeyProof,
  verifyProductKeyRotationProof,
} from "@agentplugged/crypto";
import {
  AGENT_EVENT_TYPES,
  type CodedErrorPayload,
  currentEvent,
  type DeviceRegisteredPayload,
  ErrorCode,
  EVENT_TYPES,
  type EventEnvelope,
  eventTypeUpgrade,
  HUMAN_EVENT_TYPES,
  HUMAN_ONLY_EVENT_TYPES,
  type HumanKeyRegisteredPayload,
  type HumanPresenceLinkedPayload,
  type IgnoredEvent,
  type IgnoredReason,
  isSensitiveEventType,
  isTestEventType,
  MACHINE_DEVICE_PATTERN,
  METHOD_EVENT_TYPES,
  METHOD_FORMAT_VERSION,
  type MethodMigratedPayload,
  PAYLOAD_ENCRYPTION_ALG,
  PRODUCT_KEY_EVENT_TYPES,
  PROJECTION_FORMAT,
  type ProductCreatedPayload,
  type ProductKeyCreatedPayload,
  type ProductKeyRotatedPayload,
  type ProjectionState,
  type ProjectionWarning,
  type RootPin,
  USAGE_EVENT_TYPES,
} from "@agentplugged/protocol";
import { aliasEvent, RENAMED_AGENTS_FORMAT } from "../agents/agent-aliases.js";
import { AgentPluggedError } from "../errors.js";
import { humanDevice } from "../human/human-key.js";
import { compareSemver } from "../init/engine-check.js";
import { machineDevice } from "../journal/key-store.js";
import type { ProductKey } from "../journal/product-key.js";
import type { JournalProblem } from "../journal/state-store.js";
import {
  LATEST_ENGINE,
  UPGRADE_DEFAULT_COMMAND,
  upgradeTarget,
} from "../migrate/upgrade-target.js";
import { noteCostSignal } from "./agent-reducers.js";
import { settleHeldResolutions } from "./checkpoint-reducers.js";
import { settleHeldExecutions } from "./creator-action-reducers.js";
import { computeDeviceTrust, type DeviceTrustView, hasTrustWork } from "./device-trust.js";
import { emptyDraft, REDUCERS } from "./reducers.js";
import { noteUsageSignal } from "./usage-reducers.js";

export interface ComputeProjectionOptions {
  /** Journal entries that could not be read as events: ignored as `invalid`. */
  readonly problems?: readonly JournalProblem[];
  /** The journal position the events were read at (`journal_head`). */
  readonly head?: string | null;
  /** The product pinned by `method.yaml` (`product_id`), when it has one. */
  readonly product?: string;
  /** Applies the types reserved to tests (`test.*`) instead of ignoring them. */
  readonly allowTestTypes?: boolean;
  /**
   * The product key this machine holds: encrypted payloads under it are decrypted,
   * then applied. Without it (or under another key), they are counted and chained, never applied
   * (`sensitive_unreadable` warning).
   */
  readonly productKey?: ProductKey;
  /**
   * The running engine: an engine the journal's migrations name is offered for
   * installation only when newer than it (`latest` otherwise). Unknown: any is offered.
   */
  readonly engineVersion?: string;
  /**
   * The root of trust this machine pinned outside the repository (written by
   * `agentplugged pair`): the chain of authorizations of every trusted device must lead to it,
   * and another creator key that the journal's order would have crowned raises
   * `SECURITY_ROOT_CHANGED`. Absent: the first creator key registered is the root.
   */
  readonly pinnedRoot?: RootPin;
}

/** One event of the journal as the projection sees it. */
interface Entry {
  /** As written (what the signature and `prev` cover). */
  readonly event: EventEnvelope;
  /** `eventHash` of the event as written. */
  readonly hash: string;
  /** In its type's current format, once converted and checked; undefined when invalid. */
  current?: EventEnvelope;
  /** Its own fault, when it has one. */
  reason?: IgnoredReason;
  /** Its parent in its writer's chain (the event `prev` names), when the journal holds it. */
  parent?: Entry;
  /** A `device.registered` whose key does not give its `actor.device`. */
  foreignKey?: boolean;
  /** A type or a version this engine does not know: thrown once its signature verifies. */
  upgrade?: CodedErrorPayload;
  /** An encrypted payload this machine cannot read (no product key, or another one). */
  unreadable?: boolean;
  /**
   * Refused on its sensitive content, its chain kept: `decrypt_failed`,
   * `unsupported_alg`, `unexpected_encryption` or `key_proof_invalid`.
   */
  refusal?: IgnoredReason;
}

/** The key of the ring that `keyId` names: the one held as current, or one kept from before a renewal. */
async function ringKey(ring: ProductKey, keyId: string): Promise<ProductKey | undefined> {
  return ring.keyId === keyId ? ring : ring.older?.(keyId);
}

/**
 * The sensitive content of the valid events, checked before they are applied:
 * - an encrypted payload on a type that is not sensitive: `unexpected_encryption`; with an
 *   algorithm this engine does not know: `unsupported_alg` (whatever the key);
 * - else decrypted with the product key, then converted and checked like a clear one (`current`
 *   holds it). Without the key, or under another key: `unreadable`. Under this key, a payload that
 *   does not decrypt, or that its type refuses: `decrypt_failed`;
 * - a `product.key_created` of this machine's key whose proof does not verify: `key_proof_invalid`.
 */
async function checkSensitive(
  entries: readonly Entry[],
  valid: ReadonlyMap<Entry, boolean>,
  productKey: ProductKey | undefined,
): Promise<void> {
  for (const entry of entries) {
    if (valid.get(entry) !== true) continue;
    const { event } = entry;
    if (
      (event.type === PRODUCT_KEY_EVENT_TYPES.keyCreated ||
        event.type === PRODUCT_KEY_EVENT_TYPES.keyRotated) &&
      productKey !== undefined
    ) {
      const payload = entry.current?.payload as
        | ProductKeyCreatedPayload
        | ProductKeyRotatedPayload
        | undefined;
      // A key this machine holds or kept: the announcement of it must carry its proof.
      const named = payload === undefined ? undefined : await ringKey(productKey, payload.key_id);
      if (
        payload !== undefined &&
        named !== undefined &&
        !(await verifyProductKeyProof(named.key, event.product, payload.proof))
      ) {
        entry.refusal = "key_proof_invalid";
      }
      // A renewal must carry the proof of a holder of the key it follows: a machine that holds
      // that key ignores one that does not (a writer that never had the key cannot fake it).
      if (payload !== undefined && "previous_key_id" in payload) {
        const previous = await ringKey(productKey, payload.previous_key_id);
        if (
          previous !== undefined &&
          !(await verifyProductKeyRotationProof(
            previous.key,
            event.product,
            payload.key_id,
            payload.chain_proof,
          ))
        ) {
          entry.refusal = "key_proof_invalid";
        }
      }
      continue;
    }
    if (event.payload_enc === undefined) continue;
    if (!isSensitiveEventType(event.type)) {
      entry.refusal = "unexpected_encryption";
      continue;
    }
    if (event.payload_enc.alg !== PAYLOAD_ENCRYPTION_ALG) {
      entry.refusal = "unsupported_alg";
      continue;
    }
    if (productKey === undefined) {
      entry.unreadable = true;
      continue;
    }
    // The key it names: the current one, or one kept from before a renewal.
    const named = await ringKey(productKey, event.payload_enc.key_id);
    if (named === undefined) {
      entry.unreadable = true;
      continue;
    }
    const decrypted = await decryptPayload(event, named.key);
    if (!decrypted.ok) {
      if (decrypted.reason === "other_key") entry.unreadable = true;
      else
        entry.refusal =
          decrypted.reason === "unsupported_alg" ? "unsupported_alg" : "decrypt_failed";
      continue;
    }
    const { payload_enc: _encrypted, ...clear } = event;
    const converted = currentEvent({ ...clear, payload: decrypted.payload });
    if (converted.ok) entry.current = converted.event;
    else entry.refusal = "decrypt_failed";
  }
}

/** A projection, and what this machine could not read of it (never written to `state.json`). */
export interface DetailedProjection {
  readonly projection: ProjectionState;
  /** Encrypted events applied without their content (no product key here, or another one). */
  readonly unreadable: number;
  /**
   * The registry of trusted devices, when a root is pinned or the journal holds an
   * event of trust. Machine-local like `unreadable`: it depends on the root this machine pinned,
   * and is never written to `state.json`.
   */
  readonly deviceTrust?: DeviceTrustView;
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The projection order between events available at the same time: ULID, then hash. */
const compareEntries = (a: Entry, b: Entry) =>
  compareText(a.event.id, b.event.id) || compareText(a.hash, b.hash);

/** The id of an unreadable journal entry: its file name (`journal/<YYYY>/<MM>/<id>.json`). */
function problemId(problem: JournalProblem): string {
  return (problem.path.split("/").at(-1) ?? problem.path).replace(/\.json$/, "");
}

/** A minimal binary heap: the available events, smallest first. */
class Heap<T> {
  readonly #items: T[] = [];
  constructor(readonly compare: (a: T, b: T) => number) {}

  get size(): number {
    return this.#items.length;
  }

  push(item: T): void {
    const items = this.#items;
    items.push(item);
    let at = items.length - 1;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (this.compare(items[parent] as T, items[at] as T) <= 0) break;
      [items[parent], items[at]] = [items[at] as T, items[parent] as T];
      at = parent;
    }
  }

  pop(): T | undefined {
    const items = this.#items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last !== undefined) {
      items[0] = last;
      let at = 0;
      for (;;) {
        const left = at * 2 + 1;
        const right = left + 1;
        let smallest = at;
        if (left < items.length && this.compare(items[left] as T, items[smallest] as T) < 0) {
          smallest = left;
        }
        if (right < items.length && this.compare(items[right] as T, items[smallest] as T) < 0) {
          smallest = right;
        }
        if (smallest === at) break;
        [items[smallest], items[at]] = [items[at] as T, items[smallest] as T];
        at = smallest;
      }
    }
    return top;
  }
}

/**
 * Which entries are valid: no fault of their own, and a chain intact up to its first event
 * (`prev: null`), every link being an event of the same device that is valid itself. A chain
 * that loops is broken.
 */
function chainValidity(entries: readonly Entry[], faulty: (entry: Entry) => boolean) {
  const valid = new Map<Entry, boolean>();
  for (const start of entries) {
    const path: Entry[] = [];
    const onPath = new Set<Entry>();
    let entry: Entry | undefined = start;
    let result = false;
    while (entry !== undefined) {
      const known = valid.get(entry);
      if (known !== undefined) {
        result = known;
        break;
      }
      if (onPath.has(entry) || faulty(entry)) {
        result = false;
        break;
      }
      path.push(entry);
      onPath.add(entry);
      if (entry.event.prev === null) {
        result = true;
        break;
      }
      const parent: Entry | undefined = entry.parent;
      if (parent === undefined || parent.event.actor.device !== entry.event.actor.device) {
        result = false;
        break;
      }
      entry = parent;
    }
    // A link is valid exactly when the rest of its chain is; a faulty one never is.
    for (const link of path) valid.set(link, result);
    if (!valid.has(start)) valid.set(start, false);
  }
  return valid;
}

/** A problem entry's writer and signature, when its JSON value has them. */
function rawSigned(raw: unknown): { device: string; sig: Uint8Array | undefined } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const { actor, alg, sig } = raw as { actor?: unknown; alg?: unknown; sig?: unknown };
  const device = (actor as { device?: unknown } | null | undefined)?.device;
  if (typeof device !== "string") return undefined;
  const bytes = alg === "ed25519" && typeof sig === "string" ? fromBase64url(sig) : undefined;
  return { device, sig: bytes };
}

/** A `presence` credential linked to a creator's key, and the last signature counter seen. */
interface Credential {
  readonly id: string;
  readonly publicKey: Uint8Array;
  counter: number;
}

/**
 * Checks a `human.presence_linked`: its device is a registered creator, its payload is signed
 * by that creator's `locale` key, and the event by the credential it links, with the same
 * algorithm and UV. Records the credential when both hold; else the reason it is ignored.
 */
async function checkPresenceLink(
  entry: Entry,
  keys: ReadonlyMap<string, { bytes: Uint8Array }>,
  humans: ReadonlySet<string>,
  credentials: Map<string, Credential[]>,
): Promise<IgnoredReason | undefined> {
  const { event } = entry;
  const device = event.actor.device;
  const key = keys.get(device);
  if (key === undefined || !humans.has(device)) return "unknown_signer";
  const payload = entry.current?.payload as HumanPresenceLinkedPayload;
  const { credential_id, cose_public_key, alg, locale_signature } = payload;
  const signature = fromBase64url(locale_signature);
  const linkedBytes = canonicalBytes({ credential_id, cose_public_key, alg });
  if (signature === undefined || !(await verifyEd25519(linkedBytes, signature, key.bytes))) {
    return "bad_signature";
  }
  const publicKey = fromBase64url(cose_public_key);
  if (publicKey === undefined || event.alg !== alg) return "bad_signature";
  const verified = await verifyEvent(event, {
    webauthnCredential: { id: credential_id, publicKey, counter: 0 },
  });
  if (!verified.ok) {
    return verified.error.code === ErrorCode.EVENT_INVALID ? "invalid" : "bad_signature";
  }
  const list = credentials.get(device) ?? [];
  if (!list.some((credential) => credential.id === credential_id)) {
    list.push({ id: credential_id, publicKey, counter: verified.newCounter ?? 0 });
  }
  credentials.set(device, list);
  return undefined;
}

/**
 * Checks a WebAuthn-signed event against its device's linked credentials: the first one that
 * verifies it (UV, challenge, counter) counts, its counter moves, and its id is returned (the
 * reducers check it is linked to a trusted key). `unknown_signer` when the device has none.
 */
async function verifyPresence(
  event: EventEnvelope,
  linkedCredentials: readonly Credential[] | undefined,
): Promise<{ credential: string } | { reason: IgnoredReason }> {
  if (linkedCredentials === undefined || linkedCredentials.length === 0) {
    return { reason: "unknown_signer" };
  }
  let reason: IgnoredReason = "bad_signature";
  for (const credential of linkedCredentials) {
    const verified = await verifyEvent(event, {
      webauthnCredential: {
        id: credential.id,
        publicKey: credential.publicKey,
        counter: credential.counter,
      },
    });
    if (verified.ok) {
      credential.counter = verified.newCounter ?? credential.counter;
      return { credential: credential.id };
    }
    if (verified.error.code === ErrorCode.EVENT_INVALID) reason = "invalid";
  }
  return { reason };
}

/**
 * The state of the product, from the events of its journal: a pure function (no clock, no I/O),
 * whose result does not depend on the order of `events`.
 *
 * - Keys: a `device.registered` (a machine) or a `human.key_registered` (a creator)
 *   is valid when signed by the key it publishes. A `human.presence_linked` is valid when signed
 *   both by the credential it links (WebAuthn with UV) and by its creator's `locale` key; a
 *   creator's event signed by WebAuthn is checked against the credentials linked to its device.
 * - A creator's event (`checkpoint.resolved`, `human.*`, `actor.kind: human`) not signed by a
 *   registered creator's key is ignored (`not_human`).
 * - A machine's key: a `device.registered` is valid when signed by the key it publishes. A device's key is
 *   the one its id derives from; another key published under it is ignored (`key_conflict`, or
 *   `invalid` when the device has no key of its own), whatever its ULID.
 * - A type or a version this engine does not know (an event, or an unreadable entry of a newer
 *   envelope) throws `UPGRADE_REQUIRED`, nothing being projected, only when its signature
 *   verifies with its device's key; otherwise it is ignored like any other (`unknown_signer`,
 *   `bad_signature`, `invalid`).
 * - A `method.migrated` of a machine (`machine:` device), of this product, on a
 *   valid chain, to a format newer than this engine knows throws `UPGRADE_REQUIRED`
 *   (`error.journal_format_upgrade_required`). That error and an unknown type's or envelope's
 *   (`<key>.install`) name the engine to install (`details.install`: the newest `to_engine` of
 *   those migrations newer than `engineVersion`, else `latest`) and a command
 *   (`details.command`, `journal status`), which the registry refines.
 * - A type reserved to tests (`test.*`) is ignored (`test_type`) unless `allowTestTypes`.
 * - Each other event is ignored when it is `invalid` (schema of the envelope or of its type's
 *   payload), has an `unknown_signer` or a `bad_signature`; then the product is `product` (the
 *   `product_id` of `method.yaml`) or else the first valid `product.created`. A `product.created`
 *   of another product is ignored (`product_conflict`), any other event of another product too
 *   (`wrong_product`); without any product known, the first valid event's product counts. Then,
 *   with its descendants, an event whose chain is broken (`broken_chain`: `prev` absent,
 *   ignored, or another device's).
 * - Two valid events of one device naming the same `prev` are both kept (`chain_fork` warning).
 * - Sensitive content (`checkSensitive`): an encrypted payload is decrypted with
 *   `productKey`, then applied like a clear one. Without that key (or under another one), the
 *   event is counted and its chain kept, but its content is not applied (`unreadable`, never a
 *   warning of `state.json`). Refused on its content, its chain kept: `decrypt_failed`,
 *   `unsupported_alg`, `unexpected_encryption`, `key_proof_invalid`, and `sensitive_in_clear` for
 *   a clear sensitive event applied after the product key was announced.
 * - The valid events are applied by the reducers in topological order of their chains, the
 *   smallest ULID (then hash) first among those available at the same time; older formats are
 *   converted first. `computed_at` is the latest `at` of the events applied.
 */
export async function computeProjection(
  events: readonly EventEnvelope[],
  options: ComputeProjectionOptions = {},
): Promise<ProjectionState> {
  return (await computeProjectionDetailed(events, options)).projection;
}

/** `computeProjection`, with what this machine could not read (`unreadable`). */
export async function computeProjectionDetailed(
  events: readonly EventEnvelope[],
  options: ComputeProjectionOptions = {},
): Promise<DetailedProjection> {
  const allowTests = options.allowTestTypes === true;
  const problems = [...(options.problems ?? [])].sort((a, b) => compareText(a.path, b.path));
  const ignored: IgnoredEvent[] = [];
  const byHash = new Map<string, Entry>();
  for (const event of events) {
    const hashed = eventHash(event);
    if (!hashed.ok) {
      ignored.push({ id: event.id, reason: "invalid" });
      continue;
    }
    if (!byHash.has(hashed.hash)) byHash.set(hashed.hash, { event, hash: hashed.hash });
  }
  const entries = [...byHash.values()].sort(compareEntries);

  for (const entry of entries) {
    if (entry.event.prev !== null) entry.parent = byHash.get(entry.event.prev);
    if (isTestEventType(entry.event.type) && !allowTests) {
      entry.reason = "test_type";
      continue;
    }
    // A type or version not known here: it stops everything once its signature verifies.
    entry.upgrade = eventTypeUpgrade(entry.event.type, entry.event.v);
    if (entry.upgrade !== undefined) continue;
    const converted = currentEvent(entry.event);
    if (!converted.ok) {
      entry.reason = "invalid";
      continue;
    }
    entry.current = converted.event;
    const { type, payload, product, actor } = converted.event;
    if (type === EVENT_TYPES.deviceRegistered) {
      // The engine's own events are never encrypted: their payload is read by every machine.
      const published = (payload as DeviceRegisteredPayload | undefined)?.public_key;
      const key = published === undefined ? undefined : fromBase64url(published);
      if (key === undefined) entry.reason = "invalid";
      else if (machineDevice(key) !== actor.device) entry.foreignKey = true;
    }
    if (type === HUMAN_EVENT_TYPES.keyRegistered) {
      // The creator's key: its device is drawn from it, and only a human publishes one.
      const published = (payload as HumanKeyRegisteredPayload | undefined)?.public_key;
      const key = published === undefined ? undefined : fromBase64url(published);
      if (key === undefined || actor.kind !== "human" || converted.event.alg !== "ed25519") {
        entry.reason = "invalid";
      } else if (humanDevice(key) !== actor.device) entry.foreignKey = true;
    }
    if (type === EVENT_TYPES.productCreated) {
      const id = (payload as ProductCreatedPayload | undefined)?.product_id;
      if (id === undefined || id !== product) entry.reason = "invalid";
    }
  }

  // Keys of the writers: each `device.registered` (a machine) or `human.key_registered` (a
  // creator) signed by the key it publishes. A device's key is the one its id derives from
  // (`machine:` or `human:` + SHA-256 of the key); a registration of another key under it is a
  // conflict when the device has its own, and invalid otherwise.
  const keys = new Map<string, { key: string; bytes: Uint8Array }>();
  const registrations = entries.filter(
    (entry) =>
      entry.reason === undefined &&
      entry.current !== undefined &&
      (entry.event.type === EVENT_TYPES.deviceRegistered ||
        entry.event.type === HUMAN_EVENT_TYPES.keyRegistered),
  );
  for (const foreign of [false, true]) {
    for (const entry of registrations) {
      if ((entry.foreignKey === true) !== foreign) continue;
      const published = (entry.current?.payload as { public_key?: string } | undefined)?.public_key;
      if (published === undefined) continue;
      const bytes = fromBase64url(published) as Uint8Array;
      const verified = await verifyEvent(entry.event, { ed25519PublicKey: bytes });
      if (!verified.ok) {
        entry.reason = "bad_signature";
        continue;
      }
      const known = keys.get(entry.event.actor.device);
      if (foreign) entry.reason = known === undefined ? "invalid" : "key_conflict";
      else if (known === undefined) keys.set(entry.event.actor.device, { key: published, bytes });
      else if (known.key !== published) entry.reason = "key_conflict";
    }
  }
  // The creators' devices: those a valid `human.key_registered` registered.
  const humans = new Set(
    registrations
      .filter(
        (entry) =>
          entry.reason === undefined && entry.event.type === HUMAN_EVENT_TYPES.keyRegistered,
      )
      .map((entry) => entry.event.actor.device),
  );
  // The WebAuthn credential that verified each event signed so (the reducers check it is linked
  // to a trusted key).
  const signedBy = new Map<string, string>();
  // `presence` credentials: each `human.presence_linked` signed both by the credential it links
  // (WebAuthn with UV) and, in its payload, by its creator's `locale` key. In id order, so the
  // signature counter of each credential only grows.
  const credentials = new Map<string, Credential[]>();
  const linked = new Set<Entry>();
  for (const entry of entries) {
    if (entry.reason !== undefined || entry.event.type !== HUMAN_EVENT_TYPES.presenceLinked) {
      continue;
    }
    if (entry.current === undefined) continue;
    linked.add(entry);
    entry.reason = await checkPresenceLink(entry, keys, humans, credentials);
  }
  const registered = new Set(registrations);
  // The first type or version not known here whose signature verifies: thrown once all are checked.
  let pending: CodedErrorPayload | undefined;
  for (const entry of entries) {
    if (entry.reason !== undefined || registered.has(entry) || linked.has(entry)) continue;
    const device = entry.event.actor.device;
    if (entry.event.alg === "ed25519") {
      const key = keys.get(device);
      if (key === undefined) {
        entry.reason = "unknown_signer";
        continue;
      }
      const verified = await verifyEvent(entry.event, { ed25519PublicKey: key.bytes });
      if (!verified.ok) {
        entry.reason =
          verified.error.code === ErrorCode.EVENT_INVALID ? "invalid" : "bad_signature";
        continue;
      }
    } else {
      const presence = await verifyPresence(entry.event, credentials.get(device));
      if ("reason" in presence) {
        entry.reason = presence.reason;
        continue;
      }
      signedBy.set(entry.event.id, presence.credential);
    }
    if (entry.upgrade !== undefined) pending ??= entry.upgrade;
  }
  // A creator's event (`checkpoint.resolved`, `human.*`, or `actor.kind: human`) comes from a
  // creator's registered key only: a machine or an agent cannot answer in the creator's name.
  for (const entry of entries) {
    if (entry.reason !== undefined) continue;
    const { actor, type } = entry.event;
    const creators = actor.kind === "human" || HUMAN_ONLY_EVENT_TYPES.has(type);
    if (creators && (actor.kind !== "human" || !humans.has(actor.device))) {
      entry.reason = "not_human";
    }
  }
  // The first newer envelope whose signature verifies: thrown once the migrations are known.
  let pendingProblem: CodedErrorPayload | undefined;
  for (const problem of problems) {
    const id = problemId(problem);
    if (problem.error.code !== ErrorCode.UPGRADE_REQUIRED) {
      ignored.push({ id, reason: "invalid" });
      continue;
    }
    const writer = rawSigned(problem.raw);
    const key = writer === undefined ? undefined : keys.get(writer.device);
    if (writer === undefined || key === undefined || writer.sig === undefined) {
      ignored.push({ id, reason: writer === undefined ? "invalid" : "unknown_signer" });
      continue;
    }
    if (!(await verifyEd25519(signedBytes(problem.raw as EventEnvelope), writer.sig, key.bytes))) {
      ignored.push({ id, reason: "bad_signature" });
      continue;
    }
    const { type, version } = problem.error.details;
    const named =
      typeof type === "string" && typeof version === "number"
        ? eventTypeUpgrade(type, version)
        : undefined;
    pendingProblem ??= named ?? problem.error;
  }

  // The product: the one pinned by `method.yaml`, else the first `product.created` whose chain
  // holds before any product check.
  const signed = chainValidity(entries, (entry) => entry.reason !== undefined);
  const created = entries.find(
    (entry) => entry.event.type === EVENT_TYPES.productCreated && signed.get(entry) === true,
  );
  const product = options.product ?? created?.event.product ?? null;
  // Without any product known, the first valid event's product: events are never mixed.
  const reference = product ?? entries.find((entry) => signed.get(entry) === true)?.event.product;
  if (reference !== undefined) {
    for (const entry of entries) {
      if (entry.reason !== undefined || entry.event.product === reference) continue;
      entry.reason =
        entry.event.type === EVENT_TYPES.productCreated ? "product_conflict" : "wrong_product";
    }
  }

  const valid = chainValidity(entries, (entry) => entry.reason !== undefined);
  // The format's migrations: those of a machine (`machine:`), of this product, on a
  // valid chain. One to a format newer than this engine knows stops everything, naming the
  // engine that migrated to it; their engines also name what to install for an unknown event.
  const migrations = entries.flatMap((entry) => {
    const payload = entry.current?.payload as MethodMigratedPayload | undefined;
    const counted =
      valid.get(entry) === true &&
      entry.event.type === METHOD_EVENT_TYPES.migrated &&
      entry.event.actor.kind === "system" &&
      MACHINE_DEVICE_PATTERN.test(entry.event.actor.device) &&
      payload !== undefined;
    return counted ? [payload] : [];
  });
  const install = (list: readonly MethodMigratedPayload[]) =>
    options.engineVersion === undefined
      ? (list
          .map((payload) => payload.to_engine)
          .reduce<string | undefined>(
            (best, engine) =>
              best === undefined || compareSemver(engine, best) > 0 ? engine : best,
            undefined,
          ) ?? LATEST_ENGINE)
      : upgradeTarget(
          options.engineVersion,
          list.map((payload) => payload.to_engine),
        );
  const ahead = migrations.filter((payload) => payload.to_format > METHOD_FORMAT_VERSION);
  if (ahead.length > 0) {
    throw new AgentPluggedError(
      ErrorCode.UPGRADE_REQUIRED,
      "error.journal_format_upgrade_required",
      {
        format_version: Math.max(...ahead.map((payload) => payload.to_format)),
        supported: METHOD_FORMAT_VERSION,
        install: install(ahead),
        command: UPGRADE_DEFAULT_COMMAND,
      },
    );
  }
  // The agents renamed by format 2: a journal that went through that migration reads
  // the identifiers written before it through the aliases of `core`; a product born at format 2
  // (no such migration) never does.
  let aliasFormat = migrations.some(
    (payload) =>
      payload.from_format < RENAMED_AGENTS_FORMAT && payload.to_format >= RENAMED_AGENTS_FORMAT,
  )
    ? RENAMED_AGENTS_FORMAT - 1
    : METHOD_FORMAT_VERSION;
  // An unknown type or a newer envelope: its message names the engine to install and a command,
  // whoever calls (the registry may refine both).
  const unknown = pending ?? pendingProblem;
  if (unknown !== undefined) {
    const key = unknown.message_key.endsWith(".install")
      ? unknown.message_key
      : `${unknown.message_key}.install`;
    throw new AgentPluggedError(unknown.code, key, {
      ...unknown.details,
      install: install(migrations),
      command: UPGRADE_DEFAULT_COMMAND,
    });
  }
  for (const entry of entries) {
    if (valid.get(entry) === true) continue;
    ignored.push({ id: entry.event.id, reason: entry.reason ?? "broken_chain" });
  }

  // Forks: one device, one `prev`, several valid events.
  const warnings: ProjectionWarning[] = [];
  const siblings = new Map<string, Entry[]>();
  for (const entry of entries) {
    if (valid.get(entry) !== true) continue;
    const key = JSON.stringify([entry.event.actor.device, entry.event.prev]);
    const list = siblings.get(key) ?? [];
    list.push(entry);
    siblings.set(key, list);
  }
  for (const list of siblings.values()) {
    const first = list[0];
    if (list.length < 2 || first === undefined) continue;
    warnings.push({
      code: "chain_fork",
      device: first.event.actor.device,
      prev: first.event.prev,
      ids: list.map((entry) => entry.event.id),
    });
  }

  // Topological order of the chains; among the events available, the smallest first.
  const children = new Map<string, Entry[]>();
  const available = new Heap<Entry>(compareEntries);
  for (const entry of entries) {
    if (valid.get(entry) !== true) continue;
    if (entry.event.prev === null) available.push(entry);
    else {
      const list = children.get(entry.event.prev) ?? [];
      list.push(entry);
      children.set(entry.event.prev, list);
    }
  }
  const order: Entry[] = [];
  while (available.size > 0) {
    const entry = available.pop() as Entry;
    for (const child of children.get(entry.hash) ?? []) available.push(child);
    order.push(entry);
  }
  await checkSensitive(entries, valid, options.productKey);
  // The registry of trusted devices: only when a root is pinned or an event of trust
  // exists. A journal without either projects exactly as before.
  // Only what is whole: an event refused on its content, unreadable, or without a clear payload
  // (an encrypted one, on a type that is never encrypted) takes no part in it.
  const readable = order.filter(
    (entry) =>
      entry.refusal === undefined &&
      entry.unreadable !== true &&
      entry.current?.payload !== undefined,
  );
  const trust = hasTrustWork(readable, options.pinnedRoot)
    ? await computeDeviceTrust({
        order: readable,
        byHash,
        ...(options.pinnedRoot === undefined ? {} : { pinnedRoot: options.pinnedRoot }),
      })
    : undefined;
  const draft = emptyDraft(options.pinnedRoot);
  for (const [id, credential] of signedBy) draft.signedBy.set(id, credential);
  for (const entry of entries) {
    if (entry.parent !== undefined) draft.parents.set(entry.event.id, entry.parent.event.id);
  }
  let applied = 0;
  let unreadable = 0;
  let computedAt: string | null = null;
  const apply = (event: EventEnvelope) => {
    applied += 1;
    if (computedAt === null || Date.parse(event.at) > Date.parse(computedAt)) computedAt = event.at;
  };
  for (const entry of order) {
    // The registry of trusted devices refuses an event on its meaning: ignored, its
    // chain kept.
    const untrusted = trust?.refused.get(entry);
    if (untrusted !== undefined) {
      draft.ignored.push({ id: entry.event.id, reason: untrusted });
      continue;
    }
    // Sensitive content: refused ones are ignored, their chain kept; unreadable ones
    // are counted and chained, their content not applied.
    if (entry.refusal !== undefined) {
      draft.ignored.push({ id: entry.event.id, reason: entry.refusal });
      continue;
    }
    // Once the product key is announced, sensitive content arrives encrypted: a clear one after
    // that is ignored (the costs, before it, stay readable).
    if (
      entry.event.payload_enc === undefined &&
      isSensitiveEventType(entry.event.type) &&
      draft.state.product_key !== undefined
    ) {
      draft.ignored.push({ id: entry.event.id, reason: "sensitive_in_clear" });
      continue;
    }
    if (entry.unreadable === true) {
      unreadable += 1;
      // Its envelope still says who declared a cost on which story.
      if (entry.event.type === AGENT_EVENT_TYPES.costReported) {
        noteCostSignal(draft, aliasEvent(entry.event, aliasFormat));
      }
      // The measure of a session: its envelope tells the engine measured the story.
      if (entry.event.type === USAGE_EVENT_TYPES.measured) {
        noteUsageSignal(draft, aliasEvent(entry.event, aliasFormat));
      }
      apply(entry.event);
      continue;
    }
    const current = aliasEvent(entry.current as EventEnvelope, aliasFormat);
    const refused = draft.ignored.length;
    const released = draft.released.length;
    REDUCERS[current.type]?.(draft, current);
    // From the migration to format 2 on, the identifiers are the new ones.
    const reached = (draft.state.format as { version?: number } | undefined)?.version;
    if (reached !== undefined && reached > aliasFormat) aliasFormat = reached;
    // A reducer may refuse an event on its meaning (`checkpoint_id_collision`,
    // `already_resolved`…): ignored, not applied; its chain stays valid. A held one (an answer
    // waiting for its checkpoint) counts once it is applied, with its own date.
    const refusedNow = draft.ignored.slice(refused).some((item) => item.id === entry.event.id);
    if (!refusedNow && !draft.held.has(entry.event.id)) apply(entry.event);
    for (const event of draft.released.slice(released)) apply(event);
  }
  settleHeldResolutions(draft);
  settleHeldExecutions(draft);
  ignored.push(...draft.ignored);
  warnings.push(...draft.warnings);
  warnings.sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b)));

  ignored.sort((a, b) => compareText(a.id, b.id) || compareText(a.reason, b.reason));
  return {
    projection: {
      format: PROJECTION_FORMAT,
      journal_head: options.head ?? null,
      computed_at: computedAt,
      product,
      devices: [...draft.devices]
        .map(([device, public_key]) => ({ device, public_key }))
        .sort((a, b) => compareText(a.device, b.device)),
      applied,
      ignored,
      warnings,
      state: draft.state,
    },
    unreadable,
    ...(trust === undefined ? {} : { deviceTrust: trust.view }),
  };
}
