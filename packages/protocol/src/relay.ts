import { z } from "zod";
import { ErrorCode, type ErrorPayload } from "./error-payload.js";
import { isCanonicalBase64url, ULID_PATTERN } from "./event-envelope.js";

/**
 * The blind relay's wire contract: an envelope carries encrypted bytes and
 * routing metadata only, and the relay never reads what it carries. This file holds the envelope,
 * the frames of the connection and the relay's error codes, and nothing else: no account logic,
 * no offer limit (PRD §9).
 */

/** The envelope version this engine writes. */
export const RELAY_ENVELOPE_VERSION = 1;
/** The current version and the previous one (none before version 1): the relay accepts these only. */
export const RELAY_ACCEPTED_VERSIONS: readonly number[] = [1];
/** Versions withdrawn for a security reason: refused even when they are « the previous one ». */
export const RELAY_REFUSED_VERSIONS: readonly number[] = [];

/**
 * The largest ciphertext of one envelope, in bytes once decoded. A snapshot is cut into
 * pieces of this size at most: it is the single source of that number.
 */
export const RELAY_MAX_CIPHERTEXT_BYTES = 262_144;
/** A nonce in base64url: 24 bytes (XChaCha20-Poly1305) take 32 characters; the bound leaves room. */
export const RELAY_NONCE_MAX_CHARS = 64;

/** The kinds of device a relay routes to. */
export const RELAY_DEVICE_KINDS = ["phone", "browser", "bridge", "terminal"] as const;
export type RelayDeviceKind = (typeof RELAY_DEVICE_KINDS)[number];

/** Codes of the relay, in SCREAMING_SNAKE_CASE. `UPGRADE_REQUIRED` is the shared one of `ErrorCode`. */
export const RelayErrorCode = {
  /** The envelope breaks the schema: `details.field` names the first field at fault. */
  ENVELOPE_INVALID: "ENVELOPE_INVALID",
  /** The ciphertext is larger than the relay accepts: `details.max_bytes`. */
  ENVELOPE_TOO_LARGE: "ENVELOPE_TOO_LARGE",
  /** The device sent too much: `details.retry_after_ms`. */
  RATE_LIMITED: "RATE_LIMITED",
  /** `to` is no device of the sender's account (nothing says whether it exists elsewhere). */
  UNKNOWN_RECIPIENT: "UNKNOWN_RECIPIENT",
  /** The recipient's queue of waiting envelopes is full. */
  RELAY_QUEUE_FULL: "RELAY_QUEUE_FULL",
  /** The proof of identity failed: one code for every cause, so that nothing leaks. */
  RELAY_AUTH_FAILED: "RELAY_AUTH_FAILED",
  /** The device did not prove its identity in time. */
  RELAY_AUTH_TIMEOUT: "RELAY_AUTH_TIMEOUT",
  /** A frame other than `hello` before the proof of identity. */
  RELAY_NOT_AUTHENTICATED: "RELAY_NOT_AUTHENTICATED",
  /** The `Origin` of a browser is not an allowed one. */
  RELAY_ORIGIN_REFUSED: "RELAY_ORIGIN_REFUSED",
  /** The connection is not encrypted (TLS) and is not a development one on localhost. */
  RELAY_INSECURE_TRANSPORT: "RELAY_INSECURE_TRANSPORT",
  /** A frame is not JSON or not a frame of the protocol. */
  RELAY_FRAME_INVALID: "RELAY_FRAME_INVALID",
  /** A newer connection of the same device replaced this one. */
  RELAY_CONNECTION_REPLACED: "RELAY_CONNECTION_REPLACED",
  /** A published receiving key breaks the rules (number, dates, size): nothing was kept. */
  RELAY_PREKEY_INVALID: "RELAY_PREKEY_INVALID",
  /** The relay could not do what was asked (its storage failed): nothing was done, try again. */
  RELAY_UNAVAILABLE: "RELAY_UNAVAILABLE",
  /** The rendezvous does not exist (any more): nothing says whether it ever did. */
  RENDEZVOUS_UNKNOWN: "RENDEZVOUS_UNKNOWN",
  /** The rendezvous cannot be opened or joined (proof, limit, taken): one code for every cause. */
  RENDEZVOUS_REFUSED: "RENDEZVOUS_REFUSED",
  /** The bridge cannot be attached to the account (no joiner of that account, limit, expired). */
  RENDEZVOUS_ATTACH_REFUSED: "RENDEZVOUS_ATTACH_REFUSED",
} as const;
export type RelayErrorCode = (typeof RelayErrorCode)[keyof typeof RelayErrorCode];

/** Close codes of the connection (4000 to 4999 are free for applications). */
export const RELAY_CLOSE_CODES = {
  authFailed: 4401,
  authTimeout: 4408,
  replaced: 4409,
  frameInvalid: 4400,
  originRefused: 4403,
  revoked: 4410,
  serverError: 4500,
} as const;

/** The `message_key` of a relay error. */
export function relayMessageKey(code: RelayErrorCode | typeof ErrorCode.UPGRADE_REQUIRED): string {
  return `error.relay.${code.toLowerCase()}`;
}

/** A relay error as `{ code, message_key, details }`. `details` never holds a received value. */
export function relayError(
  code: RelayErrorCode | typeof ErrorCode.UPGRADE_REQUIRED,
  details: Record<string, unknown> = {},
): ErrorPayload {
  return { code, message_key: relayMessageKey(code), details };
}

/** A device or envelope identifier: a ULID. */
export const RelayIdSchema = z.string().regex(ULID_PATTERN);

const base64urlText = (maxChars: number) =>
  z.string().min(1).max(maxChars).refine(isCanonicalBase64url);

/** Characters of the base64url form of `bytes` bytes. */
export function base64urlLength(bytes: number): number {
  return Math.ceil((bytes * 4) / 3);
}

/** Bytes behind a canonical base64url text of `chars` characters. */
export function base64urlBytes(chars: number): number {
  return Math.floor((chars * 3) / 4);
}

/** The envelope of the relay: `{ v, to, from, id, nonce, ciphertext }`, strict. */
export const RelayEnvelopeSchema = z.strictObject({
  v: z.number().int().positive(),
  to: RelayIdSchema,
  from: RelayIdSchema,
  id: RelayIdSchema,
  nonce: base64urlText(RELAY_NONCE_MAX_CHARS),
  ciphertext: base64urlText(base64urlLength(RELAY_MAX_CIPHERTEXT_BYTES)),
});
export type RelayEnvelope = z.infer<typeof RelayEnvelopeSchema>;

export type RelayEnvelopeParseResult =
  | { success: true; data: RelayEnvelope }
  | { success: false; error: ErrorPayload };

/**
 * Validates an envelope against a ciphertext limit of `maxCiphertextBytes` (at most
 * `RELAY_MAX_CIPHERTEXT_BYTES`). A version that is not the current or the previous one, or that was
 * withdrawn, gives `UPGRADE_REQUIRED`; a larger ciphertext gives `ENVELOPE_TOO_LARGE` (the limit is
 * `maxCiphertextBytes` bytes accepted, one more refused); any other problem gives
 * `ENVELOPE_INVALID` on the first field at fault, never with the received value.
 */
export function parseRelayEnvelope(
  input: unknown,
  maxCiphertextBytes: number = RELAY_MAX_CIPHERTEXT_BYTES,
): RelayEnvelopeParseResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail(relayError(RelayErrorCode.ENVELOPE_INVALID, { field: "" }));
  }
  const record = input as Record<string, unknown>;
  const version = record.v;
  if (
    typeof version === "number" &&
    Number.isInteger(version) &&
    version > 0 &&
    (RELAY_REFUSED_VERSIONS.includes(version) || !RELAY_ACCEPTED_VERSIONS.includes(version))
  ) {
    return fail(
      relayError(ErrorCode.UPGRADE_REQUIRED, {
        field: "v",
        supported: [...RELAY_ACCEPTED_VERSIONS],
      }),
    );
  }
  const ciphertext = record.ciphertext;
  if (
    typeof ciphertext === "string" &&
    isCanonicalBase64url(ciphertext) &&
    ciphertext.length > 0 &&
    base64urlBytes(ciphertext.length) > maxCiphertextBytes
  ) {
    return fail(relayError(RelayErrorCode.ENVELOPE_TOO_LARGE, { max_bytes: maxCiphertextBytes }));
  }
  const result = RelayEnvelopeSchema.safeParse(input);
  if (result.success) return { success: true, data: result.data };
  const issue = result.error.issues[0];
  const field =
    issue === undefined
      ? ""
      : issue.code === "unrecognized_keys"
        ? "keys"
        : issue.path.map((part) => String(part)).join(".");
  return fail(relayError(RelayErrorCode.ENVELOPE_INVALID, { field }));
}

function fail(error: ErrorPayload): { success: false; error: ErrorPayload } {
  return { success: false, error };
}

/** How long a challenge is valid, in milliseconds (pairing note, §9: 30 seconds). */
export const RELAY_CHALLENGE_TTL_MS = 30_000;
/** Tolerance between a device's date and the relay's, in milliseconds (5 minutes). */
export const RELAY_CLOCK_TOLERANCE_MS = 300_000;
/** The longest validity of a published receiving key: 30 days. */
export const RELAY_PREKEY_MAX_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;

/** The type tag of what a device signs to prove its identity to the relay. */
export const RELAY_AUTH_DOMAIN = "relay.auth/v1";
/**
 * What a device signs: the tag `relay.auth/v1`, the relay's challenge, its own identifier, the
 * name of the relay it means to talk to and its date (seconds since the epoch), each on a line.
 * A device never signs bytes the relay chose without this fixed prefix; the name of the relay
 * stops a hostile relay from replaying a proof made for another one.
 */
export function relayAuthPayload(
  challenge: string,
  deviceId: string,
  relayName: string,
  signedAt: number,
): Uint8Array {
  return utf8(`${RELAY_AUTH_DOMAIN}\n${challenge}\n${deviceId}\n${relayName}\n${signedAt}`);
}

/** UTF-8 bytes of a text (this package has no `TextEncoder` in its types). */
function utf8(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

/** The tag of what a bridge signs to open a rendezvous. */
export const RELAY_RENDEZVOUS_DOMAIN = "rendezvous.open/v1";
/**
 * What a bridge signs to open the rendezvous `x`: the tag, the relay's challenge (so that the
 * proof cannot be replayed on another connection), `x`, the name of the relay and its date.
 */
export function relayRendezvousPayload(
  challenge: string,
  x: string,
  relayName: string,
  signedAt: number,
): Uint8Array {
  return utf8(`${RELAY_RENDEZVOUS_DOMAIN}
${challenge}
${x}
${relayName}
${signedAt}`);
}

/** The tag of the declaration that attaches a bridge to an account. */
export const RELAY_ATTACH_DOMAIN = "relay.attach/v1";
/** A declaration of attachment is valid for 10 minutes at most. */
export const RELAY_ATTACH_MAX_VALIDITY_S = 600;

/** A public key of 32 bytes in canonical base64url (43 characters). */
const KEY_32 = z.string().length(43).refine(isCanonicalBase64url);

/**
 * The declaration a bridge signs to be attached to an account (`relay.attach/v1`): who it is, its
 * keys, the relay it means, the account it is attached to and a short deadline. Signed AFTER the
 * proof that the requester read the pairing link, never before.
 */
export const RelayAttachDeclarationSchema = z.strictObject({
  device_id: RelayIdSchema,
  kind: z.literal("bridge"),
  sig_key: KEY_32,
  enc_key: KEY_32,
  relay: z.string().min(1).max(253),
  account: RelayIdSchema,
  /** Seconds since the epoch. */
  expires_at: z.number().int().positive(),
});
export type RelayAttachDeclaration = z.infer<typeof RelayAttachDeclarationSchema>;

/** The bytes a bridge signs for a declaration of attachment: the tag then each field on a line. */
export function relayAttachPayload(declaration: RelayAttachDeclaration): Uint8Array {
  return utf8(
    [
      RELAY_ATTACH_DOMAIN,
      declaration.device_id,
      declaration.kind,
      declaration.sig_key,
      declaration.enc_key,
      declaration.relay,
      declaration.account,
      declaration.expires_at,
    ].join("\n"),
  );
}

/** The identifier of a rendezvous: 16 random bytes in base64url (22 characters). */
export const RendezvousIdSchema = z.string().regex(/^[A-Za-z0-9_-]{21}[AQgw]$/);

/** The most bytes of one message of a rendezvous, as the relay carries it (decoded). */
export const RENDEZVOUS_MAX_DATA_BYTES = 131_072;

/** An Ed25519 signature in canonical base64url: 64 bytes, 86 characters. */
const SignatureSchema = z.string().length(86).refine(isCanonicalBase64url);

/**
 * A receiving key a device publishes: an X25519 public key with a number (the time of
 * publication in milliseconds, never above the relay's clock plus 5 minutes, always rising), its
 * validity (milliseconds, 30 days at most) and the signature of the device's own signing key. The
 * relay keeps and serves it; it checks the numbers and the dates, never the signature: the
 * recipient of the key checks it against the trust registry, so a relay cannot forge one.
 */
export const PrekeySchema = z.strictObject({
  number: z.number().int().positive(),
  valid_from: z.number().int().positive(),
  valid_until: z.number().int().positive(),
  /** X25519, 32 bytes in base64url (43 characters). */
  public_key: z.string().length(43).refine(isCanonicalBase64url),
  signature: SignatureSchema,
});
export type Prekey = z.infer<typeof PrekeySchema>;

/** The frames a device sends. */
export const RelayClientFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("hello"),
    v: z.number().int().positive(),
    device_id: RelayIdSchema,
    /**
     * The session credential of the account, opaque to this contract. The
     * bridge has none: it has no passkey and proves itself by the signed challenge alone, once a
     * phone attached it to the account.
     */
    credential: z.string().min(1).max(4096).optional(),
    /** Date of the proof, in seconds since the epoch (within 5 minutes of the relay's). */
    signed_at: z.number().int().positive(),
    /** Signature, with the device's key, of `relayAuthPayload(challenge, device_id, relay, signed_at)`. */
    signature: SignatureSchema,
  }),
  z.strictObject({ type: z.literal("send"), envelope: z.unknown() }),
  z.strictObject({ type: z.literal("ack"), from: RelayIdSchema, id: RelayIdSchema }),
  z.strictObject({ type: z.literal("prekey_publish"), prekey: PrekeySchema }),
  z.strictObject({ type: z.literal("prekey_get"), device_id: RelayIdSchema }),
  /**
   * The rendezvous: two devices meet at `x` before either has an account on this
   * relay. These frames come before any proof of identity; the relay sees `x`, sizes, times and the
   * network address, never what is carried.
   */
  z.strictObject({
    type: z.literal("rv_open"),
    v: z.number().int().positive(),
    x: RendezvousIdSchema,
    /** The bridge's Ed25519 public key: the relay limits openings per key. */
    bridge_key: KEY_32,
    signed_at: z.number().int().positive(),
    /** Signature of `relayRendezvousPayload(challenge, x, relay, signed_at)`. */
    signature: SignatureSchema,
  }),
  z.strictObject({
    type: z.literal("rv_join"),
    v: z.number().int().positive(),
    x: RendezvousIdSchema,
    /** The session credential of the requester's account (opaque here): lets the bridge be attached to it. */
    credential: z.string().min(1).max(4096).optional(),
  }),
  z.strictObject({
    type: z.literal("rv_message"),
    id: RelayIdSchema,
    /** The bridge names the joiner it answers (the relay gave it in `rv_peer`). */
    peer: z.string().min(1).max(32).optional(),
    /** Opaque bytes in base64url. */
    data: z
      .string()
      .min(1)
      .max(base64urlLength(RENDEZVOUS_MAX_DATA_BYTES))
      .refine(isCanonicalBase64url),
  }),
  z.strictObject({
    type: z.literal("rv_attach"),
    declaration: RelayAttachDeclarationSchema,
    signature: SignatureSchema,
  }),
]);
export type RelayClientFrame = z.infer<typeof RelayClientFrameSchema>;

const PresenceEntrySchema = z.strictObject({
  device_id: RelayIdSchema,
  kind: z.enum(RELAY_DEVICE_KINDS),
  online: z.boolean(),
  /** ISO 8601, `null` when the device never connected. */
  last_seen_at: z.string().nullable(),
});
export type RelayPresenceEntry = z.infer<typeof PresenceEntrySchema>;

const ErrorFramePayloadSchema = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/),
  message_key: z.string().min(1),
  details: z.record(z.string(), z.unknown()),
});

/** The frames the relay sends. */
export const RelayServerFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("challenge"),
    v: z.number().int().positive(),
    challenge: z.string().min(1),
    /** The name of the relay: the device signs it, and refuses a relay that is not the one it means. */
    relay: z.string().min(1).max(253),
  }),
  z.strictObject({
    type: z.literal("ready"),
    v: z.number().int().positive(),
    device_id: RelayIdSchema,
    devices: z.array(PresenceEntrySchema),
  }),
  z.strictObject({ type: z.literal("envelope"), envelope: RelayEnvelopeSchema }),
  z.strictObject({ type: z.literal("accepted"), id: RelayIdSchema, duplicate: z.boolean() }),
  z.strictObject({
    type: z.literal("error"),
    id: RelayIdSchema.optional(),
    error: ErrorFramePayloadSchema,
  }),
  z.strictObject({ type: z.literal("presence"), device: PresenceEntrySchema }),
  z.strictObject({ type: z.literal("prekey_published"), number: z.number().int().positive() }),
  /** `prekey` is `null` when the device has none valid, or is no device of the asker's account. */
  z.strictObject({
    type: z.literal("prekey"),
    device_id: RelayIdSchema,
    prekey: PrekeySchema.nullable(),
  }),
  z.strictObject({ type: z.literal("rv_opened"), x: RendezvousIdSchema }),
  /** To a joiner: it is in the rendezvous as `peer`; `open` says whether the bridge is there. */
  z.strictObject({
    type: z.literal("rv_joined"),
    x: RendezvousIdSchema,
    peer: z.string().min(1).max(32),
    open: z.boolean(),
  }),
  /** To the bridge: somebody joined as `peer`. */
  z.strictObject({ type: z.literal("rv_peer"), peer: z.string().min(1).max(32) }),
  z.strictObject({
    type: z.literal("rv_message"),
    id: RelayIdSchema,
    peer: z.string().min(1).max(32).optional(),
    data: z
      .string()
      .min(1)
      .max(base64urlLength(RENDEZVOUS_MAX_DATA_BYTES))
      .refine(isCanonicalBase64url),
  }),
  /** The relay's receipt of a message: `delivered` says whether the other side was there. */
  z.strictObject({ type: z.literal("rv_sent"), id: RelayIdSchema, delivered: z.boolean() }),
  z.strictObject({ type: z.literal("rv_attached"), device_id: RelayIdSchema }),
]);
export type RelayServerFrame = z.infer<typeof RelayServerFrameSchema>;
