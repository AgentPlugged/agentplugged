import { deviceKindOf, type PairedDeviceKind } from "@agentplugged/protocol";
import { fromBase64url, toBase64url } from "./encoding.js";
import { randomBytes, sha256 } from "./hash.js";
import { sodium } from "./sodium.js";

/**
 * The primitives the epic of the devices needs: key agreement (X25519), the
 * sealed box, authenticated encryption (XChaCha20-Poly1305), key derivation, fingerprints,
 * constant-time comparison and device identifiers. libsodium only, and only here. No function
 * puts a key, a subkey or a secret in an error or a result text: errors say what has the wrong
 * size or shape, never the value.
 */

/** Bytes of an X25519 key (public or secret). */
export const X25519_KEY_BYTES = 32;
/** Bytes of an XChaCha20-Poly1305 key and nonce. */
export const AEAD_KEY_BYTES = 32;
export const AEAD_NONCE_BYTES = 24;
const AEAD_TAG_BYTES = 16;

function sized(bytes: Uint8Array, size: number, what: string): void {
  if (bytes.length !== size) throw new TypeError(`${what} has ${size} bytes`);
}

/** Concatenates byte arrays. */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** The text then 2 bytes (big-endian) of its length in front: no two inputs collide. */
export function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 0xffff) throw new TypeError("a field is longer than 65535 bytes");
  return concatBytes(Uint8Array.of(bytes.length >> 8, bytes.length & 0xff), bytes);
}

// --- identifiers and fingerprints ---------------------------------------------------------------

/**
 * The identifier of a device: its kind, `:`, then the first 16 base64url characters
 * of the SHA-256 of its signing key (the raw 32 bytes for Ed25519). The identifier is a label:
 * every check uses the whole key.
 */
export function deviceIdOf(
  kind: "machine" | "human" | "phone" | "browser",
  signingKey: Uint8Array,
): string {
  sized(signingKey, 32, "a signing key");
  return `${kind}:${toBase64url(sha256(signingKey)).slice(0, 16)}`;
}

/** True when `device` is the identifier its kind and `signingKey` give. */
export function deviceIdMatchesKey(device: string, signingKey: Uint8Array): boolean {
  const kind = deviceKindOf(device);
  return kind !== undefined && signingKey.length === 32 && deviceIdOf(kind, signingKey) === device;
}

/** The kinds a `device.paired` registers. */
export function isPairedKind(kind: string): kind is PairedDeviceKind {
  return kind === "machine" || kind === "phone" || kind === "browser";
}

/**
 * The fingerprint of public bytes: the SHA-256, base64url, cut at `characters` (16 by default).
 * Only for public data (a key to show, an identifier): never for a secret.
 */
export function fingerprint(bytes: Uint8Array, characters = 16): string {
  return toBase64url(sha256(bytes)).slice(0, characters);
}

/** Constant-time equality of two byte arrays of the same length; false when the lengths differ. */
export async function constantTimeEqual(a: Uint8Array, b: Uint8Array): Promise<boolean> {
  if (a.length !== b.length) return false;
  const lib = await sodium();
  return lib.memcmp(a, b);
}

/** Wipes buffers (`sodium.memzero`), best effort: JavaScript may hold other copies. */
export async function wipe(...buffers: ReadonlyArray<Uint8Array | undefined>): Promise<void> {
  const lib = await sodium();
  for (const buffer of buffers) if (buffer !== undefined) lib.memzero(buffer);
}

// --- key derivation -----------------------------------------------------------------------------

/**
 * `KDF(context, ikm)` of the note (A.1): libsodium `crypto_kdf_derive_from_key` for a 32-byte
 * subkey, number 1, the 8-character `context`, the master key being the SHA-256 of `ikm`. Wipe the
 * result after use.
 */
export async function deriveKey(context: string, ikm: Uint8Array): Promise<Uint8Array> {
  if (context.length !== 8) throw new TypeError("a derivation context has 8 characters");
  const lib = await sodium();
  const master = sha256(ikm);
  try {
    return lib.crypto_kdf_derive_from_key(32, 1, context, master);
  } finally {
    lib.memzero(master);
  }
}

/**
 * `crypto_kdf_derive_from_key` as libsodium has it: `length` bytes (16 to 64), numbered `id`, from
 * a 32-byte master key. The shared vectors fix it; the product uses `deriveKey`.
 */
export async function deriveSubkey(
  masterKey: Uint8Array,
  id: number,
  context: string,
  length: number,
): Promise<Uint8Array> {
  sized(masterKey, 32, "a master key");
  if (context.length !== 8) throw new TypeError("a derivation context has 8 characters");
  const lib = await sodium();
  return lib.crypto_kdf_derive_from_key(length, id, context, masterKey);
}

// --- X25519 and the sealed box -------------------------------------------------------------------

export interface X25519KeyPair {
  /** 32 bytes. */
  readonly publicKey: Uint8Array;
  /** 32 bytes. Never leaves the device. */
  readonly secretKey: Uint8Array;
}

/** A new X25519 key pair (the `enc` key of a device, or an ephemeral key). */
export async function generateX25519(): Promise<X25519KeyPair> {
  const lib = await sodium();
  const pair = lib.crypto_box_keypair();
  return { publicKey: pair.publicKey, secretKey: pair.privateKey };
}

/** The public key of an X25519 secret key. */
export async function x25519PublicKey(secretKey: Uint8Array): Promise<Uint8Array> {
  sized(secretKey, X25519_KEY_BYTES, "an X25519 key");
  const lib = await sodium();
  return lib.crypto_scalarmult_base(secretKey);
}

/**
 * The shared secret of X25519 (RFC 7748): undefined when the other's key is of low order (the
 * result would be all zeros). Wipe it after use.
 */
export async function x25519(
  secretKey: Uint8Array,
  otherPublicKey: Uint8Array,
): Promise<Uint8Array | undefined> {
  sized(secretKey, X25519_KEY_BYTES, "an X25519 key");
  sized(otherPublicKey, X25519_KEY_BYTES, "an X25519 key");
  const lib = await sodium();
  try {
    return lib.crypto_scalarmult(secretKey, otherPublicKey);
  } catch {
    return undefined;
  }
}

/** `sealToPublicKey` with a given ephemeral secret key: `./testing.js` only (vectors). */
export async function sealToPublicKeyWith(
  message: Uint8Array,
  recipientPublicKey: Uint8Array,
  ephemeralSecretKey: Uint8Array,
): Promise<Uint8Array> {
  sized(recipientPublicKey, X25519_KEY_BYTES, "an X25519 key");
  sized(ephemeralSecretKey, X25519_KEY_BYTES, "an X25519 key");
  const lib = await sodium();
  const ephemeralPublic = lib.crypto_scalarmult_base(ephemeralSecretKey);
  const nonce = lib.crypto_generichash(24, concatBytes(ephemeralPublic, recipientPublicKey), null);
  const box = lib.crypto_box_easy(message, nonce, recipientPublicKey, ephemeralSecretKey);
  return concatBytes(ephemeralPublic, box);
}

/**
 * The sealed box (libsodium `crypto_box_seal`): `message` readable only by the holder of the
 * secret key of `recipientPublicKey`, the sender anonymous. Not an authenticated message between
 * two devices (`encryptPeerMessage` is).
 */
export async function sealToPublicKey(
  message: Uint8Array,
  recipientPublicKey: Uint8Array,
): Promise<Uint8Array> {
  sized(recipientPublicKey, X25519_KEY_BYTES, "an X25519 key");
  const lib = await sodium();
  return lib.crypto_box_seal(message, recipientPublicKey);
}

/** The message of a sealed box, or undefined when it does not open with this key pair. */
export async function openSealed(
  sealed: Uint8Array,
  recipientPublicKey: Uint8Array,
  recipientSecretKey: Uint8Array,
): Promise<Uint8Array | undefined> {
  sized(recipientPublicKey, X25519_KEY_BYTES, "an X25519 key");
  sized(recipientSecretKey, X25519_KEY_BYTES, "an X25519 key");
  const lib = await sodium();
  try {
    return lib.crypto_box_seal_open(sealed, recipientPublicKey, recipientSecretKey);
  } catch {
    return undefined;
  }
}

// --- authenticated encryption --------------------------------------------------------------------

/** XChaCha20-Poly1305 (IETF): the ciphertext ends with the 16-byte tag. */
export async function aeadEncrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  associatedData: Uint8Array,
): Promise<Uint8Array> {
  sized(key, AEAD_KEY_BYTES, "an encryption key");
  sized(nonce, AEAD_NONCE_BYTES, "a nonce");
  const lib = await sodium();
  return lib.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    associatedData,
    null,
    nonce,
    key,
  );
}

/** The plaintext, or undefined when the key, nonce, data or ciphertext do not match. */
export async function aeadDecrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  associatedData: Uint8Array,
): Promise<Uint8Array | undefined> {
  if (key.length !== AEAD_KEY_BYTES || nonce.length !== AEAD_NONCE_BYTES) return undefined;
  if (ciphertext.length < AEAD_TAG_BYTES) return undefined;
  const lib = await sodium();
  try {
    return lib.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      associatedData,
      nonce,
      key,
    );
  } catch {
    return undefined;
  }
}

/** A fresh random nonce of XChaCha20-Poly1305. */
export function newNonce(): Uint8Array {
  return randomBytes(AEAD_NONCE_BYTES);
}

/** Bytes of a base64url text of a given size; undefined if it is not canonical or not that size. */
export function base64urlOfSize(text: unknown, size: number): Uint8Array | undefined {
  if (typeof text !== "string") return undefined;
  const bytes = fromBase64url(text);
  return bytes !== undefined && bytes.length === size ? bytes : undefined;
}
