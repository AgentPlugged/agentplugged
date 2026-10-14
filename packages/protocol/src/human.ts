import { z } from "zod";
import { CHECKPOINT_EVENT_TYPES } from "./checkpoint.js";
import { DEVICE_TRUST_EVENT_TYPES } from "./device-trust.js";
import { Ed25519SignatureSchema, isCanonicalBase64url } from "./event-envelope.js";

/**
 * The creator's key. Its `locale` part is an Ed25519 key in the system
 * keychain, published once per journal by `human.key_registered`, signed by itself. Its optional
 * `presence` part is a platform WebAuthn credential (ES256, or RS256 on Windows) with user
 * verification, tied to the `locale` key by `human.presence_linked`, signed by both. The assurance
 * of a human event is drawn by the verifier from its signature, never believed on declaration.
 *
 * Trust: the first valid `human.key_registered` in projection order is the product's root
 * creator key; any later creator key is pending until `human.key_endorsed`, signed by a key
 * already trusted, endorses it. A pending key's answers, links and endorsements are ignored.
 */

/** Event types of the creator's key, each at version 1. */
export const HUMAN_EVENT_TYPES = {
  keyRegistered: "human.key_registered",
  presenceLinked: "human.presence_linked",
  keyEndorsed: "human.key_endorsed",
} as const;

/**
 * Types only a creator writes, signed by a creator's key, from a creator's command of the CLI:
 * the journal refuses them through any other write, and the projection ignores them from
 * anything but a registered creator's key.
 */
export const HUMAN_ONLY_EVENT_TYPES: ReadonlySet<string> = new Set([
  HUMAN_EVENT_TYPES.keyRegistered,
  HUMAN_EVENT_TYPES.presenceLinked,
  HUMAN_EVENT_TYPES.keyEndorsed,
  CHECKPOINT_EVENT_TYPES.resolved,
  /** The creator accepts a story without a readable CI. */
  "story.ci_waived",
  /** The creator dismisses an event that raised `SECURITY_ROOT_CHANGED`. */
  DEVICE_TRUST_EVENT_TYPES.dismissed,
]);

/** `human:` then 16 base64url characters (the start of the SHA-256 of the `locale` public key). */
export const HUMAN_DEVICE_PATTERN = /^human:[A-Za-z0-9_-]{16}$/;

/** The WebAuthn algorithms of a `presence` credential. */
export const PRESENCE_ALGS = ["webauthn-es256", "webauthn-rs256"] as const;
export type PresenceAlg = (typeof PRESENCE_ALGS)[number];

/** 32 bytes in base64url: 43 characters, the last one carrying 4 bits only. */
const ED25519_PUBLIC_KEY = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

const base64url = (max: number) =>
  z.string().min(1).max(max).refine(isCanonicalBase64url, { message: "expected base64url" });

/** `payload` of `human.key_registered`: the `locale` Ed25519 public key (32 bytes, base64url). */
export const HumanKeyRegisteredPayloadSchema = z.strictObject({
  public_key: z.string().regex(ED25519_PUBLIC_KEY).refine(isCanonicalBase64url),
});
export type HumanKeyRegisteredPayload = z.infer<typeof HumanKeyRegisteredPayloadSchema>;

/** A `presence` credential: its id, its COSE public key (both base64url) and its algorithm. */
export const PresenceCredentialSchema = z.strictObject({
  credential_id: base64url(1024),
  cose_public_key: base64url(2048),
  alg: z.enum(PRESENCE_ALGS),
});
export type PresenceCredential = z.infer<typeof PresenceCredentialSchema>;

/**
 * `payload` of `human.presence_linked`: the credential, and `locale_signature`, the Ed25519
 * signature by the `locale` key of the canonical JSON (RFC 8785) of
 * `{ credential_id, cose_public_key, alg }`. The event itself is signed by the credential.
 */
export const HumanPresenceLinkedPayloadSchema = z.strictObject({
  ...PresenceCredentialSchema.shape,
  locale_signature: Ed25519SignatureSchema,
});
export type HumanPresenceLinkedPayload = z.infer<typeof HumanPresenceLinkedPayloadSchema>;

/** `payload` of `human.key_endorsed`: the creator's key a trusted creator endorses. */
export const HumanKeyEndorsedPayloadSchema = z.strictObject({
  device: z.string().regex(HUMAN_DEVICE_PATTERN),
  public_key: HumanKeyRegisteredPayloadSchema.shape.public_key,
});
export type HumanKeyEndorsedPayload = z.infer<typeof HumanKeyEndorsedPayloadSchema>;
