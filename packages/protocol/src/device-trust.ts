import { z } from "zod";
import { Ed25519SignatureSchema, isCanonicalBase64url } from "./event-envelope.js";

/**
 * The devices of trust in the journal. A product's
 * registry of trusted devices is its journal: `device.paired` says "this key is trusted",
 * `device.revoked` takes it back, `device.confirmed` ends the provisional state of a device whose
 * handover is complete, `device.root_certified` records that the first phone recognised the root,
 * and `trust.dismissed` clears a `SECURITY_ROOT_CHANGED` alert. The chain of authorizations must
 * lead to the root the bridge pinned locally, outside the repository: never to an event's ULID.
 *
 * Generic on purpose: schemas and rules only, no transport, no account, no offer.
 */

/** Event types of the devices of trust, each at version 1. */
export const DEVICE_TRUST_EVENT_TYPES = {
  paired: "device.paired",
  revoked: "device.revoked",
  rootCertified: "device.root_certified",
  confirmed: "device.confirmed",
  dismissed: "trust.dismissed",
} as const;

/**
 * The types the engine writes as a system actor (the bridge, or a creator's terminal for the
 * first ones): refused in any write by an agent. `trust.dismissed` is the creator's (signed by
 * the creator's key).
 */
export const DEVICE_TRUST_SYSTEM_EVENT_TYPES: ReadonlySet<string> = new Set([
  DEVICE_TRUST_EVENT_TYPES.paired,
  DEVICE_TRUST_EVENT_TYPES.revoked,
  DEVICE_TRUST_EVENT_TYPES.rootCertified,
  DEVICE_TRUST_EVENT_TYPES.confirmed,
]);

/** Every event type of this file. */
export const DEVICE_TRUST_ALL_EVENT_TYPES: ReadonlySet<string> = new Set(
  Object.values(DEVICE_TRUST_EVENT_TYPES),
);

/** Why a surface cannot give an order: the root of the journal is not the pinned one. */
export const ROOT_CHANGED_MESSAGE_KEY = "error.security_root_changed";

/** The kinds of device a `device.paired` registers (the creator's key has its own events). */
export const PAIRED_DEVICE_KINDS = ["machine", "phone", "browser"] as const;
export type PairedDeviceKind = (typeof PAIRED_DEVICE_KINDS)[number];

/** `machine:`, `human:`, `phone:` or `browser:` then 16 base64url characters. */
export const DEVICE_ID_PATTERN = /^(machine|human|phone|browser):[A-Za-z0-9_-]{16}$/;
/** The identifier of a device `device.paired` registers. */
export const PAIRED_DEVICE_ID_PATTERN = /^(machine|phone|browser):[A-Za-z0-9_-]{16}$/;
/** The identifier of a bridge. */
export const BRIDGE_ID_PATTERN = /^machine:[A-Za-z0-9_-]{16}$/;

/** The kind of identifier (`machine`, `human`, `phone`, `browser`), or undefined when malformed. */
export function deviceKindOf(
  device: string,
): "machine" | "human" | "phone" | "browser" | undefined {
  if (!DEVICE_ID_PATTERN.test(device)) return undefined;
  return device.slice(0, device.indexOf(":")) as "machine" | "human" | "phone" | "browser";
}

/** The algorithms of the linked devices (the `webauthn-*` ones serve the terminal's key only). */
export const DEVICE_SIG_ALG = "ed25519";
export const DEVICE_ENC_ALG = "x25519";

/** 32 bytes in base64url: 43 characters, the last one carrying 4 bits only. */
const PUBLIC_KEY_32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
/** 16 random bytes in base64url: 22 characters, the last one carrying 2 bits only. */
const RANDOM_16 = /^[A-Za-z0-9_-]{21}[AQgw]$/;
/** `sha256:` then the 32-byte digest in base64url (an event's hash). */
export const TRUST_EVENT_HASH_PATTERN = /^sha256:[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

const publicKey32 = z.string().regex(PUBLIC_KEY_32).refine(isCanonicalBase64url);
const utcDatetime = z.iso.datetime();

/** A public key of a device with its algorithm: `{ alg, key }`. */
export const DeviceSigKeySchema = z.strictObject({
  alg: z.literal(DEVICE_SIG_ALG),
  key: publicKey32,
});
export const DeviceEncKeySchema = z.strictObject({
  alg: z.literal(DEVICE_ENC_ALG),
  key: publicKey32,
});
export type DeviceSigKey = z.infer<typeof DeviceSigKeySchema>;
export type DeviceEncKey = z.infer<typeof DeviceEncKeySchema>;

/**
 * Every signed structure of trust carries its label `t` (type and version), and a key signs the
 * types it knows only: an authorization is never taken for an order, nor a relay's challenge for
 * an authorization. The domain separation stops a signature made for one purpose from
 * serving another.
 */
export const TRUST_SIGNATURE_TAGS = {
  devicePaired: "device.paired.auth/v1",
  deviceRevoked: "device.revoked.auth/v1",
  pairOffer: "pair.offer/v1",
  rootCertified: "device.root_certified.auth/v1",
  message: "msg.inner/v1",
  linkWelcome: "link.welcome/v1",
  vaultBlob: "vault.blob/v1",
} as const;
export type TrustSignatureTag = (typeof TRUST_SIGNATURE_TAGS)[keyof typeof TRUST_SIGNATURE_TAGS];

/** True for a label this engine knows. */
export function isTrustSignatureTag(tag: unknown): tag is TrustSignatureTag {
  return Object.values(TRUST_SIGNATURE_TAGS).includes(tag as TrustSignatureTag);
}

/**
 * The order of a trusted device that offered a pairing (`pair.offer`): one rendezvous
 * `x`, valid until `expires_at`, for one device of `kind`. The bridge writes `device.paired` on
 * its authority, once.
 */
export const PairOfferSchema = z.strictObject({
  /** The rendezvous: 16 random bytes in base64url, or the 8-symbol address of a short code. */
  x: z.union([
    z.string().regex(RANDOM_16).refine(isCanonicalBase64url),
    z.string().regex(/^[0-9A-HJKMNP-TV-Z]{8}$/),
  ]),
  expires_at: utcDatetime,
});
export type PairOffer = z.infer<typeof PairOfferSchema>;

/**
 * The proof that the creator wanted this: the signature, by a device already trusted (or by the
 * root, from the command run on the root machine), of the record of the event (`order` absent) or
 * of the signed order `pair.offer` (`order` present).
 */
export const AuthorizationSchema = z.strictObject({
  signer: z.string().regex(DEVICE_ID_PATTERN),
  alg: z.literal(DEVICE_SIG_ALG),
  sig: Ed25519SignatureSchema,
  order: PairOfferSchema.optional(),
});
export type Authorization = z.infer<typeof AuthorizationSchema>;

/** `payload` of `device.paired` v1. */
export const DevicePairedPayloadSchema = z
  .strictObject({
    device: z.string().regex(PAIRED_DEVICE_ID_PATTERN),
    kind: z.enum(PAIRED_DEVICE_KINDS),
    sig: DeviceSigKeySchema,
    enc: DeviceEncKeySchema,
    /** The bridge of the perimeter: the authorization holds in the journals this bridge writes. */
    bridge: z.string().regex(BRIDGE_ID_PATTERN),
    /** True until the handover is complete (`device.confirmed`): the bridge alone may revoke it. */
    provisional: z.boolean(),
    issued_at: utcDatetime,
    authorization: AuthorizationSchema,
  })
  .refine((payload) => payload.device.startsWith(`${payload.kind}:`), {
    path: ["kind"],
    message: "the kind is the prefix of the device",
  });
export type DevicePairedPayload = z.infer<typeof DevicePairedPayloadSchema>;

/** `payload` of `device.revoked` v1. */
export const DeviceRevokedPayloadSchema = z
  .strictObject({
    device: z.string().regex(PAIRED_DEVICE_ID_PATTERN),
    /**
     * For a machine that writes to the journal: the hash of its last event the author knew. The
     * projection accepts of a revoked machine only the ancestors of this head (and of the heads of
     * the other revocations of it). Null for a device that writes nothing.
     */
    chain_head: z.string().regex(TRUST_EVENT_HASH_PATTERN).nullable(),
    issued_at: utcDatetime,
    author: z.string().regex(DEVICE_ID_PATTERN),
    authorization: z.strictObject({ alg: z.literal(DEVICE_SIG_ALG), sig: Ed25519SignatureSchema }),
  })
  .refine((payload) => payload.chain_head === null || payload.device.startsWith("machine:"), {
    path: ["chain_head"],
    message: "only a machine has a chain head",
  });
export type DeviceRevokedPayload = z.infer<typeof DeviceRevokedPayloadSchema>;

/** `payload` of `device.root_certified` v1: the first phone recognises the root. */
export const DeviceRootCertifiedPayloadSchema = z.strictObject({
  root: z.strictObject({ device: z.string().regex(DEVICE_ID_PATTERN), key: publicKey32 }),
  issued_at: utcDatetime,
  authorization: AuthorizationSchema,
});
export type DeviceRootCertifiedPayload = z.infer<typeof DeviceRootCertifiedPayloadSchema>;

/** `payload` of `device.confirmed` v1: the handover of the device is complete. */
export const DeviceConfirmedPayloadSchema = z.strictObject({
  device: z.string().regex(PAIRED_DEVICE_ID_PATTERN),
  issued_at: utcDatetime,
});
export type DeviceConfirmedPayload = z.infer<typeof DeviceConfirmedPayloadSchema>;

/** `payload` of `trust.dismissed` v1: the events (their hashes) the creator dismisses. */
export const TrustDismissedPayloadSchema = z.strictObject({
  events: z.array(z.string().regex(TRUST_EVENT_HASH_PATTERN)).min(1).max(16),
  issued_at: utcDatetime,
});
export type TrustDismissedPayload = z.infer<typeof TrustDismissedPayloadSchema>;

/** The pinned root of a product, kept locally outside the repository (written by `pair`). */
export const RootPinSchema = z.strictObject({
  device: z.string().regex(/^(machine|human):[A-Za-z0-9_-]{16}$/),
  public_key: publicKey32,
});
export type RootPin = z.infer<typeof RootPinSchema>;

// --- the records a signature covers ------------------------------------------------------------

/**
 * What the authorization of a `device.paired` signs: its payload without `authorization`, plus the
 * label. Independent of the product and of `prev`: the bridge writes it in each journal it serves,
 * but cannot make one without the signer.
 */
export function devicePairedRecord(
  payload: Omit<DevicePairedPayload, "authorization">,
): Record<string, unknown> {
  return {
    t: TRUST_SIGNATURE_TAGS.devicePaired,
    device: payload.device,
    kind: payload.kind,
    sig: payload.sig,
    enc: payload.enc,
    bridge: payload.bridge,
    provisional: payload.provisional,
    issued_at: payload.issued_at,
  };
}

/** What the signed order `pair.offer` covers. */
export function pairOfferRecord(input: {
  readonly kind: PairedDeviceKind;
  readonly bridge: string;
  readonly order: PairOffer;
}): Record<string, unknown> {
  return {
    t: TRUST_SIGNATURE_TAGS.pairOffer,
    kind: input.kind,
    bridge: input.bridge,
    x: input.order.x,
    expires_at: input.order.expires_at,
  };
}

/** What the authorization of a `device.revoked` signs. */
export function deviceRevokedRecord(
  payload: Omit<DeviceRevokedPayload, "authorization">,
): Record<string, unknown> {
  return {
    t: TRUST_SIGNATURE_TAGS.deviceRevoked,
    device: payload.device,
    chain_head: payload.chain_head,
    issued_at: payload.issued_at,
    author: payload.author,
  };
}

/** What the authorization of a `device.root_certified` signs. */
export function rootCertifiedRecord(
  payload: Omit<DeviceRootCertifiedPayload, "authorization">,
): Record<string, unknown> {
  return {
    t: TRUST_SIGNATURE_TAGS.rootCertified,
    root: payload.root,
    issued_at: payload.issued_at,
  };
}
