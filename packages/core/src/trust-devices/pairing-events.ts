import { eventHash, signTrustRecord, verifyTrustRecord } from "@agentplugged/crypto";
import {
  DEVICE_TRUST_EVENT_TYPES,
  type DeviceConfirmedPayload,
  type DevicePairedPayload,
  type DeviceRevokedPayload,
  type DeviceRootCertifiedPayload,
  devicePairedRecord,
  deviceRevokedRecord,
  type EventEnvelope,
  type PairedDeviceKind,
  type RootPin,
  rootCertifiedRecord,
  TRUST_SIGNATURE_TAGS,
} from "@agentplugged/protocol";
import type { StateStore } from "../journal/state-store.js";
import { computeProjectionDetailed } from "../projection/compute-projection.js";
import type { DeviceTrustView } from "../projection/device-trust.js";

/**
 * The events of trust a pairing writes: `device.paired` for a new device, then
 * `device.confirmed` once its handover is complete, or `device.revoked` when it cannot be. They are
 * written by the bridge as a SYSTEM actor, signed by the machine's key through the journal, and
 * only through these functions of `core`: never by hand, never by the MCP server (no tool exposes
 * them, and a write by an agent is refused by the journal itself).
 *
 * The authorization (who wants this device trusted) is signed apart, by the root on the machine
 * where the creator ran the command (their `locale` key, or the bridge's own key when none exists):
 * a bridge cannot make one for a device nobody asked for.
 */

export interface RootSigner {
  /** The root's identifier (`human:…` or `machine:…`). */
  readonly device: string;
  /** Its Ed25519 secret key (libsodium format). */
  readonly secretKey: Uint8Array;
}

export interface PairedDeviceDescription {
  readonly device: string;
  readonly kind: PairedDeviceKind;
  /** Public keys, base64url. */
  readonly sigKey: string;
  readonly encKey: string;
  /** The bridge of the perimeter. */
  readonly bridge: string;
  readonly provisional: boolean;
  /** ISO 8601, UTC. */
  readonly issuedAt: string;
}

/** The payload of a `device.paired`, its authorization signed by `signer`. */
export async function buildPairedPayload(
  description: PairedDeviceDescription,
  signer: RootSigner,
): Promise<DevicePairedPayload> {
  const unsigned = {
    device: description.device,
    kind: description.kind,
    sig: { alg: "ed25519" as const, key: description.sigKey },
    enc: { alg: "x25519" as const, key: description.encKey },
    bridge: description.bridge,
    provisional: description.provisional,
    issued_at: description.issuedAt,
  };
  const sig = await signTrustRecord(
    devicePairedRecord(unsigned),
    TRUST_SIGNATURE_TAGS.devicePaired,
    signer.secretKey,
  );
  return { ...unsigned, authorization: { signer: signer.device, alg: "ed25519", sig } };
}

/**
 * The payload of a `device.paired` on the authority of a device that gave the order `pair.offer`:
 * the device signed the offer (`x`, `expires_at`) before the new device existed, and the bridge
 * adds the new device's keys. Nothing here is signed by the bridge: the projection checks the
 * signature against the signer's key.
 */
export function buildOfferAuthorizedPayload(
  description: PairedDeviceDescription,
  authorization: {
    readonly signer: string;
    readonly sig: string;
    readonly x: string;
    readonly expiresAt: string;
  },
): DevicePairedPayload {
  return {
    device: description.device,
    kind: description.kind,
    sig: { alg: "ed25519", key: description.sigKey },
    enc: { alg: "x25519", key: description.encKey },
    bridge: description.bridge,
    provisional: description.provisional,
    issued_at: description.issuedAt,
    authorization: {
      signer: authorization.signer,
      alg: "ed25519",
      sig: authorization.sig,
      order: { x: authorization.x, expires_at: authorization.expiresAt },
    },
  };
}

/**
 * The payload of a `device.revoked` by the bridge for a device it still holds `provisional`
 *: the handover could not be completed in time.
 */
export async function buildProvisionalRevocation(input: {
  readonly device: string;
  readonly bridge: string;
  readonly bridgeSecretKey: Uint8Array;
  readonly issuedAt: string;
}): Promise<DeviceRevokedPayload> {
  const unsigned = {
    device: input.device,
    chain_head: null,
    issued_at: input.issuedAt,
    author: input.bridge,
  };
  const sig = await signTrustRecord(
    deviceRevokedRecord(unsigned),
    TRUST_SIGNATURE_TAGS.deviceRevoked,
    input.bridgeSecretKey,
  );
  return { ...unsigned, authorization: { alg: "ed25519", sig } };
}

/**
 * The payload of a `device.revoked` that `author` signs with its own key, at the terminal of a
 * machine. A phone or a browser signs its own authorization (the `device.revoke` order carries it),
 * and the payload is then made by `revocationPayload`.
 */
export async function buildRevocation(input: {
  readonly device: string;
  readonly chainHead: string | null;
  readonly author: string;
  readonly authorSecretKey: Uint8Array;
  readonly issuedAt: string;
}): Promise<DeviceRevokedPayload> {
  const unsigned = {
    device: input.device,
    chain_head: input.chainHead,
    issued_at: input.issuedAt,
    author: input.author,
  };
  const sig = await signTrustRecord(
    deviceRevokedRecord(unsigned),
    TRUST_SIGNATURE_TAGS.deviceRevoked,
    input.authorSecretKey,
  );
  return { ...unsigned, authorization: { alg: "ed25519", sig } };
}

/** The payload of a `device.revoked` whose authorization was signed elsewhere (by the author's device). */
export function revocationPayload(input: {
  readonly device: string;
  readonly chainHead: string | null;
  readonly author: string;
  readonly issuedAt: string;
  readonly sig: string;
}): DeviceRevokedPayload {
  return {
    device: input.device,
    chain_head: input.chainHead,
    issued_at: input.issuedAt,
    author: input.author,
    authorization: { alg: "ed25519", sig: input.sig },
  };
}

/** What a write of a trust event did: the event, and whether this call wrote it. */
export interface TrustWrite {
  readonly written: boolean;
  readonly event: EventEnvelope;
}

class AlreadyWritten extends Error {}

function eventsOf(events: readonly EventEnvelope[], type: string, device: string): EventEnvelope[] {
  return events.filter(
    (event) =>
      event.type === type && (event.payload as { device?: unknown } | undefined)?.device === device,
  );
}

async function writeOnce(
  journal: StateStore,
  product: string,
  type: string,
  device: string,
  payload: DevicePairedPayload | DeviceRevokedPayload | DeviceConfirmedPayload,
): Promise<TrustWrite> {
  try {
    const [event] = await journal.appendAll(
      [{ type, actor: { kind: "system" }, product, provenance: "trusted", payload }],
      {
        // Under the journal's lock, on the listing at the head the event is written on: a second
        // run (a resume after a cut) never writes the same device twice.
        precondition: (listing) => {
          if (eventsOf(listing.events, type, device).length > 0) throw new AlreadyWritten();
        },
      },
    );
    if (event === undefined) throw new Error("no event was written");
    return { written: true, event };
  } catch (error) {
    if (!(error instanceof AlreadyWritten)) throw error;
    const listing = await journal.list();
    const existing = eventsOf(listing.events, type, device)[0];
    if (existing === undefined) throw error;
    return { written: false, event: existing };
  }
}

/** Writes `device.paired` in the journal of `product`, once per device. */
export function writePairedDevice(
  journal: StateStore,
  product: string,
  payload: DevicePairedPayload,
): Promise<TrustWrite> {
  return writeOnce(journal, product, DEVICE_TRUST_EVENT_TYPES.paired, payload.device, payload);
}

/** Writes `device.revoked` (by the bridge, for a device still provisional), once per device. */
export function writeProvisionalRevocation(
  journal: StateStore,
  product: string,
  payload: DeviceRevokedPayload,
): Promise<TrustWrite> {
  return writeOnce(journal, product, DEVICE_TRUST_EVENT_TYPES.revoked, payload.device, payload);
}

/**
 * Writes the `device.revoked` of a device the creator removed, once per device: the removal the
 * creator signed is the one that stays, and a second run (a resume after a cut) writes nothing.
 */
export function writeRevocation(
  journal: StateStore,
  product: string,
  payload: DeviceRevokedPayload,
): Promise<TrustWrite> {
  return writeOnce(journal, product, DEVICE_TRUST_EVENT_TYPES.revoked, payload.device, payload);
}

/** Writes `device.confirmed`: the handover of the device is complete. */
export function writeConfirmedDevice(
  journal: StateStore,
  product: string,
  payload: DeviceConfirmedPayload,
): Promise<TrustWrite> {
  return writeOnce(journal, product, DEVICE_TRUST_EVENT_TYPES.confirmed, payload.device, payload);
}

/** The trust registry of a product as this machine computes it, from the root it pinned. */
export async function readDeviceTrust(
  journal: StateStore,
  product: string,
  pinnedRoot: RootPin | undefined,
): Promise<{
  view: DeviceTrustView | undefined;
  events: readonly EventEnvelope[];
  humans: Record<string, { public_key: string; trust: string }>;
}> {
  const listing = await journal.list();
  const projection = await computeProjectionDetailed(listing.events, {
    problems: listing.problems,
    head: listing.head,
    product,
    ...(pinnedRoot === undefined ? {} : { pinnedRoot }),
  });
  const humans = (projection.projection.state.humans ?? {}) as Record<
    string,
    { public_key: string; trust: string }
  >;
  return { view: projection.deviceTrust, events: listing.events, humans };
}

/**
 * The hash of the `device.paired` of `device` that the registry of `product` counts as valid, read
 * back from the journal: undefined while the registry does not trust the device. This is what
 * lets a bridge send a product key: only after the event is written AND read back as trusted.
 */
export async function pairedHeadIfTrusted(
  journal: StateStore,
  product: string,
  pinnedRoot: RootPin,
  device: string,
): Promise<string | undefined> {
  const { view, events } = await readDeviceTrust(journal, product, pinnedRoot);
  if (view === undefined || view.blocked) return undefined;
  const entry = view.devices.find((candidate) => candidate.device === device);
  if (entry === undefined || entry.event === null) return undefined;
  const event = events.find((candidate) => candidate.id === entry.event);
  if (event === undefined) return undefined;
  const hashed = eventHash(event);
  return hashed.ok ? hashed.hash : undefined;
}

/** The payload of a `device.root_certified`: the first device recognised the root with this signature. */
export function buildRootCertifiedPayload(input: {
  readonly root: { readonly device: string; readonly key: string };
  readonly issuedAt: string;
  readonly signer: string;
  readonly sig: string;
}): DeviceRootCertifiedPayload {
  return {
    root: { device: input.root.device, key: input.root.key },
    issued_at: input.issuedAt,
    authorization: { signer: input.signer, alg: "ed25519", sig: input.sig },
  };
}

/** True when `sigKey` signed the certification (checked before anything is written). */
export function rootCertificationHolds(
  payload: DeviceRootCertifiedPayload,
  sigKey: Uint8Array,
): Promise<boolean> {
  const { authorization, ...unsigned } = payload;
  return verifyTrustRecord(
    rootCertifiedRecord(unsigned),
    TRUST_SIGNATURE_TAGS.rootCertified,
    authorization.sig,
    sigKey,
  );
}

/**
 * Writes `device.root_certified`, once per root and signer: the certification ties the creator's
 * key to the account and changes the validity of nothing. A resume or a second run finds it written.
 */
export async function writeRootCertified(
  journal: StateStore,
  product: string,
  payload: DeviceRootCertifiedPayload,
): Promise<TrustWrite> {
  const same = (event: EventEnvelope): boolean => {
    if (event.type !== DEVICE_TRUST_EVENT_TYPES.rootCertified) return false;
    const found = event.payload as Partial<DeviceRootCertifiedPayload> | undefined;
    return (
      found?.root?.device === payload.root.device &&
      found.root.key === payload.root.key &&
      found.authorization?.signer === payload.authorization.signer
    );
  };
  try {
    const [event] = await journal.appendAll(
      [
        {
          type: DEVICE_TRUST_EVENT_TYPES.rootCertified,
          actor: { kind: "system" },
          product,
          provenance: "trusted",
          payload,
        },
      ],
      {
        precondition: (listing) => {
          if (listing.events.some(same)) throw new AlreadyWritten();
        },
      },
    );
    if (event === undefined) throw new Error("no event was written");
    return { written: true, event };
  } catch (error) {
    if (!(error instanceof AlreadyWritten)) throw error;
    const existing = (await journal.list()).events.find(same);
    if (existing === undefined) throw error;
    return { written: false, event: existing };
  }
}
