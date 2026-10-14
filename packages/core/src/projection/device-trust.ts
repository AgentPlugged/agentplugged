import { deviceIdMatchesKey, fromBase64url, verifyTrustRecord } from "@agentplugged/crypto";
import {
  BRIDGE_ID_PATTERN,
  DEVICE_TRUST_EVENT_TYPES,
  type DeviceConfirmedPayload,
  type DevicePairedPayload,
  type DeviceRevokedPayload,
  type DeviceRootCertifiedPayload,
  devicePairedRecord,
  deviceRevokedRecord,
  type EventEnvelope,
  HUMAN_EVENT_TYPES,
  type IgnoredReason,
  pairOfferRecord,
  type RootPin,
  rootCertifiedRecord,
  TRUST_SIGNATURE_TAGS,
  type TrustDismissedPayload,
} from "@agentplugged/protocol";
import { HUMAN_REDUCERS, trustedHuman } from "./human-reducers.js";
import { emptyDraft, type ProjectionDraft } from "./reducers.js";

/**
 * The registry of trusted devices: computed
 * from the valid events of the journal, in projection order, and from the root this machine
 * pinned outside the repository. A device is trusted only when the chain of authorizations of its
 * `device.paired` leads to that root; the order of the journal, an ULID, a date never decide.
 *
 * - A `device.paired` is valid when its authorization is signed by an admitted signer (the root,
 *   a trusted creator's key, or a trusted device not revoked), its identifier is the one its
 *   signing key gives, its key is no other device's, its bridge is a trusted machine of the
 *   perimeter and writes it (or a trusted creator at the terminal does).
 * - A `device.revoked` is valid when its author, admitted, signed it; the root is never revoked.
 *   From a revoked machine the projection keeps the ancestors of the heads (`chain_head`) the
 *   revocations name, and nothing else: its other events are refused, whatever their date.
 * - With a pinned creator root, another creator key that the journal's order would have crowned is
 *   a fault: `SECURITY_ROOT_CHANGED`, every order is blocked until the creator dismisses it at
 *   the terminal (`trust.dismissed`).
 *
 * Pure: no clock, no I/O. A refusal leaves the writer's chain valid, like a reducer's refusal.
 */

/** One event as the trust computation needs it. */
export interface TrustEntry {
  readonly event: EventEnvelope;
  /** `eventHash` of the event as written. */
  readonly hash: string;
  /** In its type's current format. */
  readonly current?: EventEnvelope;
  /** Its parent in its writer's chain, when the journal holds it. */
  readonly parent?: TrustEntry;
}

export interface TrustedDevice {
  readonly device: string;
  readonly kind: "machine" | "human" | "phone" | "browser";
  /** The signing key, base64url. */
  readonly sig_key: string;
  /** The encryption key, base64url; null for the root creator's key. */
  readonly enc_key: string | null;
  /** The bridge of the perimeter; null for the creator's key. */
  readonly bridge: string | null;
  /** True until `device.confirmed`: the bridge alone may revoke it. */
  readonly provisional: boolean;
  /** The device whose authorization admitted it; null for the root. */
  readonly authorized_by: string | null;
  /** The `device.paired` event (its id); null for the root. */
  readonly event: string | null;
  readonly root: boolean;
}

export interface RevokedDevice {
  readonly device: string;
  /** The heads (`chain_head`) the revocations name, sorted. */
  readonly heads: readonly string[];
  /** The revocation events (ids), in projection order. */
  readonly events: readonly string[];
}

export interface RootFault {
  /** The event that raised the alert (id) and its hash. */
  readonly id: string;
  readonly hash: string;
  /** The creator key it registers. */
  readonly device: string;
  /** The date the event carries (declared by its writer). */
  readonly at: string;
}

/** The registry, as computed on this machine (machine-local: it depends on the pinned root). */
export interface DeviceTrustView {
  /** True when a root was pinned on this machine. */
  readonly pinned: boolean;
  /** The root: the pin, else the journal's root creator key, else null. */
  readonly root: { readonly device: string; readonly public_key: string } | null;
  /** True while `SECURITY_ROOT_CHANGED` stands: no order is given. */
  readonly blocked: boolean;
  /** The events that raised the alert and were not dismissed. */
  readonly faults: readonly RootFault[];
  /** Hashes of the events the creator dismissed. */
  readonly dismissed: readonly string[];
  /** The trusted devices (the root included), sorted by identifier. */
  readonly devices: readonly TrustedDevice[];
  readonly revoked: readonly RevokedDevice[];
  /** The first trusted phone that recognised the root, or null (informational). */
  readonly root_certified_by: string | null;
}

export interface DeviceTrustResult {
  readonly view: DeviceTrustView;
  /** Events refused by the registry: ignored, their chain kept. */
  readonly refused: ReadonlyMap<TrustEntry, IgnoredReason>;
}

export interface DeviceTrustInput {
  /** The valid entries, in projection order. */
  readonly order: readonly TrustEntry[];
  readonly byHash: ReadonlyMap<string, TrustEntry>;
  readonly pinnedRoot?: RootPin;
}

const TRUST_TYPES: ReadonlySet<string> = new Set([
  DEVICE_TRUST_EVENT_TYPES.paired,
  DEVICE_TRUST_EVENT_TYPES.revoked,
  DEVICE_TRUST_EVENT_TYPES.rootCertified,
  DEVICE_TRUST_EVENT_TYPES.confirmed,
  DEVICE_TRUST_EVENT_TYPES.dismissed,
]);

/** True when the registry has something to say: a pinned root, or an event of trust. */
export function hasTrustWork(
  order: readonly TrustEntry[],
  pinnedRoot: RootPin | undefined,
): boolean {
  return pinnedRoot !== undefined || order.some((entry) => TRUST_TYPES.has(entry.event.type));
}

interface Rooted {
  readonly device: string;
  readonly public_key: string;
  readonly bytes: Uint8Array;
}

/** The creator events the scratch projection replays to know which creator keys are trusted. */
const HUMAN_TYPES: ReadonlySet<string> = new Set([
  HUMAN_EVENT_TYPES.keyRegistered,
  HUMAN_EVENT_TYPES.keyEndorsed,
]);

function payloadOf<T>(entry: TrustEntry): T {
  return (entry.current ?? entry.event).payload as T;
}

const ms = (value: string) => Date.parse(value);

/** All the ancestors of `head` in its writer's chain, itself included. */
function ancestorsOf(head: TrustEntry | undefined, writer: string): Set<TrustEntry> {
  const found = new Set<TrustEntry>();
  let cursor = head;
  while (cursor !== undefined && !found.has(cursor) && cursor.event.actor.device === writer) {
    found.add(cursor);
    cursor = cursor.parent;
  }
  return found;
}

export async function computeDeviceTrust(input: DeviceTrustInput): Promise<DeviceTrustResult> {
  const { order, byHash } = input;
  const pin = input.pinnedRoot;

  // 1. The creator keys: replay the creator's events with the real reducers on a scratch draft.
  const humans = (without: ReadonlySet<TrustEntry>) => {
    const draft = emptyDraft(pin);
    for (const entry of order) {
      if (!HUMAN_TYPES.has(entry.event.type) || without.has(entry)) continue;
      HUMAN_REDUCERS[entry.event.type]?.(draft, entry.current ?? entry.event);
    }
    return draft;
  };
  const scratch = humans(new Set());

  // 2. The alert: with a pinned creator root, a creator key the journal's order would crown.
  const position = new Map(order.map((entry, index) => [entry, index]));
  const registrations = order.filter(
    (entry) => entry.event.type === HUMAN_EVENT_TYPES.keyRegistered,
  );
  const faultsAll: { entry: TrustEntry; fault: RootFault }[] = [];
  if (pin?.device.startsWith("human:")) {
    const own = registrations.find((entry) => entry.event.actor.device === pin.device);
    const ownAt = own === undefined ? order.length : (position.get(own) ?? order.length);
    for (const entry of registrations) {
      if (entry.event.actor.device === pin.device) continue;
      if ((position.get(entry) ?? 0) < ownAt) {
        faultsAll.push({
          entry,
          fault: {
            id: entry.event.id,
            hash: entry.hash,
            device: entry.event.actor.device,
            at: entry.event.at,
          },
        });
      }
    }
  }
  // The creator dismisses only what raised the alert, and only a trusted creator key does.
  const dismissible = new Set(faultsAll.map(({ fault }) => fault.hash));
  const dismissed = new Set<string>();
  for (const entry of order) {
    if (entry.event.type !== DEVICE_TRUST_EVENT_TYPES.dismissed) continue;
    if (entry.event.actor.kind !== "human" || !trustedHuman(scratch, entry.event.actor.device)) {
      continue;
    }
    for (const hash of payloadOf<TrustDismissedPayload>(entry).events) {
      if (dismissible.has(hash)) dismissed.add(hash);
    }
  }
  const refused = new Map<TrustEntry, IgnoredReason>();
  const dismissedEntries = new Set<TrustEntry>();
  for (const { entry, fault } of faultsAll) {
    if (dismissed.has(fault.hash)) {
      refused.set(entry, "dismissed");
      dismissedEntries.add(entry);
    }
  }
  const faults = faultsAll
    .filter(({ fault }) => !dismissed.has(fault.hash))
    .map(({ fault }) => fault);
  const creators = dismissedEntries.size === 0 ? scratch : humans(dismissedEntries);

  // 3. The root.
  const humanList = Object.values(
    (creators.state.humans as Record<
      string,
      { device: string; public_key: string; trust: string }
    >) ?? {},
  );
  const journalRoot = humanList.find((human) => human.trust === "root");
  const rootSource =
    pin !== undefined
      ? { device: pin.device, public_key: pin.public_key }
      : journalRoot === undefined
        ? undefined
        : { device: journalRoot.device, public_key: journalRoot.public_key };
  let root: Rooted | undefined;
  if (rootSource !== undefined) {
    const bytes = fromBase64url(rootSource.public_key);
    if (bytes !== undefined && deviceIdMatchesKey(rootSource.device, bytes)) {
      root = { ...rootSource, bytes };
    }
  }

  // 4. The devices, to a fixed point: a revoked machine's later events are refused, and what they
  //    authorized falls with them.
  // Monotone: what is excluded stays excluded, so the loop ends (at most one round per event).
  let excluded = new Set<TrustEntry>();
  let state = await evaluate(order, root, creators, excluded);
  for (let round = 0; round <= order.length; round++) {
    const next = new Set<TrustEntry>(excluded);
    for (const revoked of state.revoked.values()) {
      if (!revoked.device.startsWith("machine:")) continue;
      const allowed = new Set<TrustEntry>();
      // The revocations of this very machine (it retired itself) are what revoked it.
      for (const entry of order) if (revoked.events.includes(entry.event.id)) allowed.add(entry);
      for (const head of revoked.heads) {
        for (const entry of ancestorsOf(byHash.get(head), revoked.device)) allowed.add(entry);
      }
      for (const entry of order) {
        if (entry.event.actor.device === revoked.device && !allowed.has(entry)) next.add(entry);
      }
    }
    if (next.size === excluded.size) break;
    excluded = next;
    state = await evaluate(order, root, creators, excluded);
  }
  for (const entry of excluded) if (!refused.has(entry)) refused.set(entry, "device_revoked");
  for (const [entry, reason] of state.refused) if (!refused.has(entry)) refused.set(entry, reason);

  const devices: TrustedDevice[] = [...state.devices.values()];
  if (root !== undefined) {
    devices.push({
      device: root.device,
      kind: root.device.startsWith("human:") ? "human" : "machine",
      sig_key: root.public_key,
      enc_key: null,
      bridge: null,
      provisional: false,
      authorized_by: null,
      event: null,
      root: true,
    });
  }
  devices.sort((a, b) => (a.device < b.device ? -1 : a.device > b.device ? 1 : 0));
  return {
    view: {
      pinned: pin !== undefined,
      root: root === undefined ? null : { device: root.device, public_key: root.public_key },
      blocked: faults.length > 0,
      faults,
      dismissed: [...dismissed].sort(),
      devices,
      revoked: [...state.revoked.values()]
        .map((revoked) => ({
          device: revoked.device,
          heads: [...revoked.heads].sort(),
          events: revoked.events,
        }))
        .sort((a, b) => (a.device < b.device ? -1 : a.device > b.device ? 1 : 0)),
      root_certified_by: state.certifiedBy,
    },
    refused,
  };
}

interface Evaluated {
  readonly devices: Map<string, TrustedDevice>;
  readonly revoked: Map<string, { device: string; heads: Set<string>; events: string[] }>;
  readonly refused: Map<TrustEntry, IgnoredReason>;
  readonly certifiedBy: string | null;
}

/** One pass over the trust events in projection order, `excluded` ones being left out. */
async function evaluate(
  order: readonly TrustEntry[],
  root: Rooted | undefined,
  creators: ProjectionDraft,
  excluded: ReadonlySet<TrustEntry>,
): Promise<Evaluated> {
  const devices = new Map<string, TrustedDevice>();
  const revoked = new Map<string, { device: string; heads: Set<string>; events: string[] }>();
  const refused = new Map<TrustEntry, IgnoredReason>();
  const usedOffers = new Set<string>();
  const keyOwner = new Map<string, string>();
  const encOwner = new Map<string, string>();
  let certifiedBy: string | null = null;

  if (root !== undefined) keyOwner.set(root.public_key, root.device);
  const humans = (creators.state.humans ?? {}) as Record<
    string,
    { public_key: string; trust: string }
  >;
  for (const [device, human] of Object.entries(humans)) {
    if (!keyOwner.has(human.public_key)) keyOwner.set(human.public_key, device);
  }

  /** The signing key of an admitted signer, or undefined (not admitted). */
  const signerKey = (signer: string): Uint8Array | undefined => {
    if (revoked.has(signer)) return undefined;
    if (root !== undefined && signer === root.device) return root.bytes;
    if (trustedHuman(creators, signer)) {
      return fromBase64url(humans[signer]?.public_key ?? "");
    }
    const device = devices.get(signer);
    return device === undefined ? undefined : fromBase64url(device.sig_key);
  };
  const isTrustedMachine = (id: string): boolean =>
    !revoked.has(id) &&
    ((root !== undefined && id === root.device && id.startsWith("machine:")) ||
      devices.get(id)?.kind === "machine");

  const refuse = (entry: TrustEntry, reason: IgnoredReason) => {
    refused.set(entry, reason);
  };

  for (const entry of order) {
    if (excluded.has(entry)) continue;
    const { event } = entry;
    switch (event.type) {
      case DEVICE_TRUST_EVENT_TYPES.paired: {
        const payload = payloadOf<DevicePairedPayload>(entry);
        const reason = await checkPaired(entry, payload);
        if (reason !== undefined) refuse(entry, reason);
        break;
      }
      case DEVICE_TRUST_EVENT_TYPES.revoked: {
        const payload = payloadOf<DeviceRevokedPayload>(entry);
        const reason = await checkRevoked(entry, payload);
        if (reason !== undefined) refuse(entry, reason);
        break;
      }
      case DEVICE_TRUST_EVENT_TYPES.confirmed: {
        const payload = payloadOf<DeviceConfirmedPayload>(entry);
        const target = devices.get(payload.device);
        if (
          target === undefined ||
          event.actor.kind !== "system" ||
          target.bridge !== event.actor.device
        ) {
          refuse(entry, "untrusted_authorization");
        } else if (target.provisional) {
          devices.set(target.device, { ...target, provisional: false });
        }
        break;
      }
      case DEVICE_TRUST_EVENT_TYPES.rootCertified: {
        const payload = payloadOf<DeviceRootCertifiedPayload>(entry);
        const reason = await checkCertified(payload);
        if (reason !== undefined) refuse(entry, reason);
        break;
      }
      default:
        break;
    }
  }

  async function checkPaired(
    entry: TrustEntry,
    payload: DevicePairedPayload,
  ): Promise<IgnoredReason | undefined> {
    const { event } = entry;
    // Who writes it: the bridge of the perimeter, or a trusted creator at the terminal.
    const bridgeWrites = event.actor.kind === "system" && event.actor.device === payload.bridge;
    const creatorWrites =
      event.actor.kind === "human" && trustedHuman(creators, event.actor.device);
    if (!bridgeWrites && !creatorWrites) return "untrusted_authorization";

    // The identifier is the one the key gives, and no key serves two devices.
    const sigBytes = fromBase64url(payload.sig.key);
    if (sigBytes === undefined || !deviceIdMatchesKey(payload.device, sigBytes)) return "invalid";
    const owner = keyOwner.get(payload.sig.key);
    if (owner !== undefined && owner !== payload.device) return "invalid";
    const encOwnerId = encOwner.get(payload.enc.key);
    if (encOwnerId !== undefined && encOwnerId !== payload.device) return "invalid";

    // A revoked key never returns.
    if (revoked.has(payload.device)) return "device_revoked";
    const known = devices.get(payload.device);
    if (known !== undefined) {
      return known.sig_key === payload.sig.key &&
        known.enc_key === payload.enc.key &&
        known.bridge === payload.bridge
        ? undefined
        : "invalid";
    }
    if (
      root !== undefined &&
      payload.device === root.device &&
      payload.sig.key !== root.public_key
    ) {
      return "invalid";
    }

    // The bridge of the perimeter: the root machine, a trusted machine, or the machine itself
    // when the root pairs it.
    const selfBridge = payload.kind === "machine" && payload.bridge === payload.device;
    if (!selfBridge && !isTrustedMachine(payload.bridge)) return "untrusted_authorization";
    // Only the root (or a trusted creator at the terminal) pairs a machine as its own bridge.
    if (
      selfBridge &&
      payload.authorization.signer !== root?.device &&
      !trustedHuman(creators, payload.authorization.signer)
    ) {
      return "untrusted_authorization";
    }
    if (!BRIDGE_ID_PATTERN.test(payload.bridge)) return "untrusted_authorization";

    // The authorization.
    const { authorization } = payload;
    const key = signerKey(authorization.signer);
    if (key === undefined) return "untrusted_authorization";
    let verified: boolean;
    if (authorization.order !== undefined) {
      const { order: offer } = authorization;
      if (usedOffers.has(offer.x)) return "untrusted_authorization";
      if (!(ms(event.at) <= ms(offer.expires_at))) return "untrusted_authorization";
      verified = await verifyTrustRecord(
        pairOfferRecord({ kind: payload.kind, bridge: payload.bridge, order: offer }),
        TRUST_SIGNATURE_TAGS.pairOffer,
        authorization.sig,
        key,
      );
    } else {
      const { authorization: _a, ...unsigned } = payload;
      verified = await verifyTrustRecord(
        devicePairedRecord(unsigned),
        TRUST_SIGNATURE_TAGS.devicePaired,
        authorization.sig,
        key,
      );
    }
    if (!verified) return "untrusted_authorization";
    if (authorization.order !== undefined) usedOffers.add(authorization.order.x);

    keyOwner.set(payload.sig.key, payload.device);
    encOwner.set(payload.enc.key, payload.device);
    // The root is in the registry already, as the root.
    if (root !== undefined && payload.device === root.device) return undefined;
    devices.set(payload.device, {
      device: payload.device,
      kind: payload.kind,
      sig_key: payload.sig.key,
      enc_key: payload.enc.key,
      bridge: payload.bridge,
      provisional: payload.provisional,
      authorized_by: authorization.signer,
      event: event.id,
      root: false,
    });
    return undefined;
  }

  async function checkRevoked(
    entry: TrustEntry,
    payload: DeviceRevokedPayload,
  ): Promise<IgnoredReason | undefined> {
    // The root is never revoked by an event.
    if (root !== undefined && payload.device === root.device) return "untrusted_authorization";
    const key = signerKey(payload.author);
    if (key === undefined) return "untrusted_authorization";
    const target = devices.get(payload.device);
    // A machine revokes only itself, or a device it still holds `provisional`.
    if (
      isTrustedMachine(payload.author) &&
      !(root !== undefined && payload.author === root.device)
    ) {
      const own = payload.author === payload.device;
      const provisional = target?.provisional === true && target.bridge === payload.author;
      if (!own && !provisional) return "untrusted_authorization";
    }
    const { authorization, ...unsigned } = payload;
    const verified = await verifyTrustRecord(
      deviceRevokedRecord(unsigned),
      TRUST_SIGNATURE_TAGS.deviceRevoked,
      authorization.sig,
      key,
    );
    if (!verified) return "untrusted_authorization";

    const existing = revoked.get(payload.device);
    const record = existing ?? { device: payload.device, heads: new Set<string>(), events: [] };
    if (payload.chain_head !== null) record.heads.add(payload.chain_head);
    record.events.push(entry.event.id);
    revoked.set(payload.device, record);
    devices.delete(payload.device);
    return undefined;
  }

  async function checkCertified(
    payload: DeviceRootCertifiedPayload,
  ): Promise<IgnoredReason | undefined> {
    if (
      root === undefined ||
      payload.root.device !== root.device ||
      payload.root.key !== root.public_key
    ) {
      return "untrusted_authorization";
    }
    const signer = devices.get(payload.authorization.signer);
    if (signer === undefined || signer.kind !== "phone" || revoked.has(signer.device)) {
      return "untrusted_authorization";
    }
    const { authorization, ...unsigned } = payload;
    const verified = await verifyTrustRecord(
      rootCertifiedRecord(unsigned),
      TRUST_SIGNATURE_TAGS.rootCertified,
      authorization.sig,
      fromBase64url(signer.sig_key) as Uint8Array,
    );
    if (!verified) return "untrusted_authorization";
    certifiedBy ??= signer.device;
    return undefined;
  }

  return { devices, revoked, refused, certifiedBy };
}
