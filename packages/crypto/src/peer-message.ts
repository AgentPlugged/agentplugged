import { DEVICE_ID_PATTERN, TRUST_SIGNATURE_TAGS } from "@agentplugged/protocol";
import { canonicalBytes } from "./canonical.js";
import { fromBase64url, fromUtf8, toBase64url, utf8 } from "./encoding.js";
import { sha256 } from "./hash.js";
import {
  AEAD_NONCE_BYTES,
  aeadDecrypt,
  aeadEncrypt,
  concatBytes,
  deriveKey,
  deviceIdMatchesKey,
  generateX25519,
  lengthPrefixed,
  newNonce,
  wipe,
  x25519,
  x25519PublicKey,
} from "./primitives.js";
import { signTrustRecord, verifyTrustRecord } from "./trust-signature.js";

/**
 * A message from one device to another, through the relay
 * One recipient per message, no group key: revoking a device is ceasing to encrypt for
 * it. The relay's envelope is `{ v, to, from, id, nonce, ciphertext }`:
 *
 * - `ciphertext` = the sender's ephemeral X25519 key (32 bytes), then XChaCha20-Poly1305 of the
 *   content. The key is `KDF("apmsg001", X25519(ephemeral, recipient `enc`) ‖ to ‖ from ‖ id)`
 *   (each field preceded by its length on 2 bytes). The ephemeral key is wiped after sending.
 * - the associated data (authenticated, not encrypted) are the label, `v`, `to`, `from`, `id`, the
 *   fingerprint of the recipient's `enc` key and the ephemeral key: a relay that readdresses,
 *   relabels or alters one byte makes the opening fail.
 * - the content is the canonical JSON of `{ t, sender, seq, type, body, alg, sig }`: the sender
 *   is named INSIDE and signs `t, sender, seq, type, body, to, id`. The recipient checks that
 *   signature against the trust registry (the journal), never against the relay's list and never
 *   because of the `from` field, which is a routing label the relay writes.
 *
 * `enc` is a long-term key (the rotating receiving keys are postponed): a
 * relay that recorded everything reads the past if it ever obtains a device's `enc` secret. The
 * ephemeral key of the sender still protects against the loss of the SENDER's keys.
 */

export const PEER_MESSAGE_VERSION = 1;
const AD_LABEL = "agentplugged/msg/v1";
const KDF_CONTEXT = "apmsg001";
const MAX_TYPE_CHARS = 64;
/** `to`, `from` and `id` are length-prefixed on 2 bytes. */
const MAX_FIELD_BYTES = 0xffff;

/** The relay's envelope of a message. */
export interface PeerEnvelope {
  readonly v: number;
  readonly to: string;
  readonly from: string;
  readonly id: string;
  /** 24 bytes, base64url. */
  readonly nonce: string;
  /** The ephemeral key then the sealed content, base64url. */
  readonly ciphertext: string;
}

export interface PeerMessageInput {
  readonly to: string;
  readonly from: string;
  readonly id: string;
  /** The identifier of the sending device: named and signed inside the message. */
  readonly sender: string;
  /** The sender's Ed25519 secret key (libsodium format, 64 bytes). */
  readonly senderSecretKey: Uint8Array;
  /** The recipient's long-term X25519 public key. */
  readonly recipientEncKey: Uint8Array;
  /** The number of the message in the pair (`nextSequence`), recorded durably before sending. */
  readonly seq: number;
  readonly type: string;
  /** Any JSON value. */
  readonly body: unknown;
}

/** Test hooks: `./testing.js` only. */
export interface PeerMessageHooks {
  readonly ephemeralSecretKey?: Uint8Array;
  readonly nonce?: Uint8Array;
}

function associatedData(
  envelope: Pick<PeerEnvelope, "v" | "to" | "from" | "id">,
  recipientEncKey: Uint8Array,
  ephemeralPublicKey: Uint8Array,
): Uint8Array {
  return concatBytes(
    utf8(AD_LABEL),
    Uint8Array.of(envelope.v),
    lengthPrefixed(utf8(envelope.to)),
    lengthPrefixed(utf8(envelope.from)),
    lengthPrefixed(utf8(envelope.id)),
    sha256(recipientEncKey),
    ephemeralPublicKey,
  );
}

async function messageKey(
  shared: Uint8Array,
  envelope: Pick<PeerEnvelope, "to" | "from" | "id">,
): Promise<Uint8Array> {
  return deriveKey(
    KDF_CONTEXT,
    concatBytes(
      shared,
      lengthPrefixed(utf8(envelope.to)),
      lengthPrefixed(utf8(envelope.from)),
      lengthPrefixed(utf8(envelope.id)),
    ),
  );
}

/** `encryptPeerMessage` with test hooks (a fixed ephemeral key and nonce): `./testing.js` only. */
export async function encryptPeerMessageWith(
  input: PeerMessageInput,
  hooks: PeerMessageHooks,
): Promise<PeerEnvelope> {
  if (!DEVICE_ID_PATTERN.test(input.sender)) throw new TypeError("the sender is not a device id");
  for (const field of [input.to, input.from, input.id]) {
    if (typeof field !== "string" || utf8(field).length > MAX_FIELD_BYTES) {
      throw new TypeError(`to, from and id are texts of at most ${MAX_FIELD_BYTES} bytes`);
    }
  }
  if (input.body === undefined) throw new TypeError("a message body is a JSON value");
  if (input.type.length < 1 || input.type.length > MAX_TYPE_CHARS) {
    throw new TypeError(`a message type has 1 to ${MAX_TYPE_CHARS} characters`);
  }
  if (!Number.isSafeInteger(input.seq) || input.seq < 1) {
    throw new TypeError("a message number is a positive integer");
  }
  if (input.recipientEncKey.length !== 32) throw new TypeError("an X25519 key has 32 bytes");
  if (input.senderSecretKey.length !== 64)
    throw new TypeError("an Ed25519 secret key has 64 bytes");
  const envelope = { v: PEER_MESSAGE_VERSION, to: input.to, from: input.from, id: input.id };
  const unsigned = {
    t: TRUST_SIGNATURE_TAGS.message,
    sender: input.sender,
    seq: input.seq,
    type: input.type,
    body: input.body,
  };
  const sig = await signTrustRecord(
    { ...unsigned, to: input.to, id: input.id },
    TRUST_SIGNATURE_TAGS.message,
    input.senderSecretKey,
  );
  const content = canonicalBytes({ ...unsigned, alg: "ed25519", sig });

  let ephemeralSecret: Uint8Array;
  let ephemeralPublic: Uint8Array;
  if (hooks.ephemeralSecretKey === undefined) {
    const pair = await generateX25519();
    ephemeralSecret = pair.secretKey;
    ephemeralPublic = pair.publicKey;
  } else {
    ephemeralSecret = hooks.ephemeralSecretKey;
    ephemeralPublic = await x25519PublicKey(ephemeralSecret);
  }
  const shared = await x25519(ephemeralSecret, input.recipientEncKey);
  if (shared === undefined) {
    if (hooks.ephemeralSecretKey === undefined) await wipe(ephemeralSecret);
    throw new TypeError("the recipient's key cannot be used");
  }
  const nonce = hooks.nonce ?? newNonce();
  if (nonce.length !== AEAD_NONCE_BYTES) throw new TypeError("a nonce has 24 bytes");
  const key = await messageKey(shared, envelope);
  try {
    const sealed = await aeadEncrypt(
      key,
      nonce,
      content,
      associatedData(envelope, input.recipientEncKey, ephemeralPublic),
    );
    return {
      ...envelope,
      nonce: toBase64url(nonce),
      ciphertext: toBase64url(concatBytes(ephemeralPublic, sealed)),
    };
  } finally {
    await wipe(key, shared, hooks.ephemeralSecretKey === undefined ? ephemeralSecret : undefined);
  }
}

/** The envelope that carries `input` encrypted for its recipient, signed inside by its sender. */
export function encryptPeerMessage(input: PeerMessageInput): Promise<PeerEnvelope> {
  return encryptPeerMessageWith(input, {});
}

/** What the trust registry knows of a sender. */
export interface PeerSender {
  /** The sender's Ed25519 public key, as the journal registers it. */
  readonly signingKey: Uint8Array;
  /**
   * The routing label the relay gives this device (`from`): the message is refused when its `from`
   * is another one, so that a trusted device cannot pass for another at the relay.
   */
  readonly routingId: string;
}

export interface PeerOpenOptions {
  readonly recipientSecretKey: Uint8Array;
  /** The registry of trusted devices: the sender named inside, or undefined when not trusted. */
  readonly registry: (sender: string) => PeerSender | undefined | Promise<PeerSender | undefined>;
}

export type PeerOpenFailure =
  | "malformed"
  | "decrypt_failed"
  | "invalid_content"
  | "unknown_sender"
  | "sender_mismatch"
  | "bad_signature";

export type PeerOpenResult =
  | {
      readonly ok: true;
      readonly sender: string;
      readonly seq: number;
      readonly type: string;
      readonly body: unknown;
    }
  | { readonly ok: false; readonly reason: PeerOpenFailure };

const fail = (reason: PeerOpenFailure): PeerOpenResult => ({ ok: false, reason });

/**
 * Opens an envelope: authenticated decryption (so `to`, `from`, `id` and the key are as the sender
 * wrote them), then the sender named inside is looked up in the trust registry and its signature is
 * verified. The window of sequence numbers moves AFTER this succeeds (`SequenceWindow.accept`).
 * The result never carries a key; a failure carries a reason only.
 */
export async function openPeerMessage(
  envelope: PeerEnvelope,
  options: PeerOpenOptions,
): Promise<PeerOpenResult> {
  // Never throws on what the relay hands over: a message that cannot be read is `malformed`.
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    envelope.v !== PEER_MESSAGE_VERSION ||
    typeof envelope.to !== "string" ||
    typeof envelope.from !== "string" ||
    typeof envelope.id !== "string" ||
    utf8(envelope.to).length > MAX_FIELD_BYTES ||
    utf8(envelope.from).length > MAX_FIELD_BYTES ||
    utf8(envelope.id).length > MAX_FIELD_BYTES
  ) {
    return fail("malformed");
  }
  const nonce = fromBase64url(String(envelope.nonce));
  const packed = fromBase64url(String(envelope.ciphertext));
  if (nonce === undefined || nonce.length !== AEAD_NONCE_BYTES) return fail("malformed");
  if (packed === undefined || packed.length < 32 + 16) return fail("malformed");
  if (options.recipientSecretKey.length !== 32) return fail("malformed");
  const ephemeralPublic = packed.slice(0, 32);
  const sealed = packed.slice(32);
  const recipientPublic = await x25519PublicKey(options.recipientSecretKey);
  const shared = await x25519(options.recipientSecretKey, ephemeralPublic);
  if (shared === undefined) return fail("decrypt_failed");
  const key = await messageKey(shared, envelope);
  let content: Uint8Array | undefined;
  try {
    content = await aeadDecrypt(
      key,
      nonce,
      sealed,
      associatedData(envelope, recipientPublic, ephemeralPublic),
    );
  } finally {
    await wipe(key, shared);
  }
  if (content === undefined) return fail("decrypt_failed");

  const inner = parseContent(content);
  if (inner === undefined) return fail("invalid_content");
  const known = await options.registry(inner.sender);
  if (known === undefined) return fail("unknown_sender");
  // A registry that returns a key which is not the sender's own is not believed.
  if (!deviceIdMatchesKey(inner.sender, known.signingKey)) return fail("unknown_sender");
  if (known.routingId !== envelope.from) return fail("sender_mismatch");
  const verified = await verifyTrustRecord(
    {
      t: TRUST_SIGNATURE_TAGS.message,
      sender: inner.sender,
      seq: inner.seq,
      type: inner.type,
      body: inner.body,
      to: envelope.to,
      id: envelope.id,
    },
    TRUST_SIGNATURE_TAGS.message,
    inner.sig,
    known.signingKey,
  );
  if (!verified) return fail("bad_signature");
  return { ok: true, sender: inner.sender, seq: inner.seq, type: inner.type, body: inner.body };
}

interface InnerContent {
  readonly sender: string;
  readonly seq: number;
  readonly type: string;
  readonly body: unknown;
  readonly sig: string;
}

function parseContent(bytes: Uint8Array): InnerContent | undefined {
  const text = fromUtf8(bytes);
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (keys !== "alg,body,sender,seq,sig,t,type") return undefined;
  const { t, sender, seq, type, body, alg, sig } = record;
  if (t !== TRUST_SIGNATURE_TAGS.message || alg !== "ed25519") return undefined;
  if (typeof sender !== "string" || !DEVICE_ID_PATTERN.test(sender)) return undefined;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) return undefined;
  if (typeof type !== "string" || type.length < 1 || type.length > MAX_TYPE_CHARS) return undefined;
  if (typeof sig !== "string") return undefined;
  return { sender, seq, type, body, sig };
}
