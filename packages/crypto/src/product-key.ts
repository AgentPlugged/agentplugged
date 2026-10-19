import {
  ENCRYPTED_FILE_PREFIX,
  type EncryptedPayload,
  type EventEnvelope,
  KEY_ID_PATTERN,
  MAX_EXPORTED_KEYS,
  PAYLOAD_ENCRYPTION_ALG,
  PRODUCT_KEY_EXPORT_PREFIX,
  PRODUCT_KEYS_EXPORT_PREFIX,
  type UnsignedEventEnvelope,
} from "@agentplugged/protocol";
import { canonicalBytes } from "./canonical.js";
import { fromBase64url, fromUtf8, toBase64url, utf8 } from "./encoding.js";
import { randomBytes } from "./hash.js";
import { openSealed, sealToPublicKey } from "./primitives.js";
import { sodium, sodiumSumo } from "./sodium.js";

/**
 * The product key: 32 random bytes, kept in the system keychain, never written
 * elsewhere. It is never used directly: libsodium `crypto_kdf` derives one subkey per purpose
 * (`apkeyid1` its public identifier, `approof1` the proof of its announcement, `apevent1` the
 * events, `apfile01` the files). XChaCha20-Poly1305 (IETF) with a random 24-byte nonce encrypts,
 * each associated data starting with a label of its purpose; Argon2id (`crypto_pwhash`, sumo
 * build) protects its export by a passphrase. No function here ever puts the key, a subkey or a
 * passphrase in an error or a result text, and every derived buffer is wiped after use (best
 * effort: JavaScript may keep copies).
 *
 * The test vectors fix the nonces and the salt through `./testing.js` only.
 */

/** Bytes of a product key. */
export const PRODUCT_KEY_BYTES = 32;
/** Bytes of an XChaCha20-Poly1305 nonce. */
export const NONCE_BYTES = 24;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
/** Version byte of the export format (`apk1:`). */
const EXPORT_VERSION = 1;

/** The `crypto_kdf` context of each subkey (8 bytes each). */
const CONTEXT = {
  keyId: "apkeyid1",
  proof: "approof1",
  event: "apevent1",
  file: "apfile01",
} as const;

/** The `crypto_kdf` context of the common memory's key. */
const COMMON_MEMORY_CONTEXT = "apcommn1";

/** Labels that start each associated data, or the proof's message. */
export const EVENT_AD_LABEL = "agentplugged/event/v1\0";
export const FILE_AD_LABEL = "agentplugged/file/v1\0";
export const KEY_PROOF_LABEL = "agentplugged/key-proof/v1\0";
export const KEY_EXPORT_AD_LABEL = "agentplugged/key-export/v1\0";

/** Test hooks (`./testing.js`): fixed nonces and salt for the vectors. */
export interface VectorHooks {
  readonly nonce?: Uint8Array;
  readonly salt?: Uint8Array;
}

function checkKey(key: Uint8Array): void {
  if (key.length !== PRODUCT_KEY_BYTES) {
    throw new TypeError(`a product key has ${PRODUCT_KEY_BYTES} bytes`);
  }
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Wipes buffers (`sodium.memzero`), best effort: JavaScript may hold other copies. */
export async function wipeBytes(...buffers: ReadonlyArray<Uint8Array | undefined>): Promise<void> {
  const lib = await sodium();
  for (const buffer of buffers) if (buffer !== undefined) lib.memzero(buffer);
}

/** The subkey of `context`, derived from the product key. Wipe it after use. */
async function subkey(key: Uint8Array, context: string): Promise<Uint8Array> {
  checkKey(key);
  const lib = await sodium();
  return lib.crypto_kdf_derive_from_key(PRODUCT_KEY_BYTES, 1, context, key);
}

async function seal(
  message: Uint8Array,
  associated: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
): Promise<Uint8Array> {
  const lib = await sodium();
  return lib.crypto_aead_xchacha20poly1305_ietf_encrypt(message, associated, null, nonce, key);
}

/** The message, or undefined when the ciphertext, the data or the key do not match. */
async function open(
  ciphertext: Uint8Array,
  associated: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
): Promise<Uint8Array | undefined> {
  if (nonce.length !== NONCE_BYTES || ciphertext.length < TAG_BYTES) return undefined;
  const lib = await sodium();
  try {
    return lib.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ciphertext, associated, nonce, key);
  } catch {
    return undefined;
  }
}

function nonceOf(given: Uint8Array | undefined): Uint8Array {
  if (given === undefined) return randomBytes(NONCE_BYTES);
  if (given.length !== NONCE_BYTES) throw new TypeError(`a nonce has ${NONCE_BYTES} bytes`);
  return given;
}

/**
 * The key of the common memory of a machine: derived by `crypto_kdf` (its own
 * context, never one of the product key's) from the seed of the machine key, the first 32 bytes of
 * its secret key. It holds no secret of its own to store, export or lose, and it never leaves the
 * machine. Used as a "product key" by `encryptFile` and `decryptFile` (its files bound to the
 * product id `common-memory`). Wipe it after use.
 */
export async function commonMemoryKey(machineSecretKey: Uint8Array): Promise<Uint8Array> {
  if (machineSecretKey.length < PRODUCT_KEY_BYTES) {
    throw new TypeError("a machine key has at least 32 bytes");
  }
  const lib = await sodium();
  const seed = machineSecretKey.slice(0, PRODUCT_KEY_BYTES);
  try {
    return lib.crypto_kdf_derive_from_key(PRODUCT_KEY_BYTES, 1, COMMON_MEMORY_CONTEXT, seed);
  } finally {
    lib.memzero(seed);
  }
}

/** A new product key: 32 bytes from the platform's secure random source. */
export function generateProductKey(): Uint8Array {
  return randomBytes(PRODUCT_KEY_BYTES);
}

/**
 * The public identifier of a product key: `pk:` then the first 16 base64url characters of its
 * `apkeyid1` subkey (never a hash of the key itself).
 */
export async function productKeyId(key: Uint8Array): Promise<string> {
  const derived = await subkey(key, CONTEXT.keyId);
  try {
    return `pk:${toBase64url(derived).slice(0, 16)}`;
  } finally {
    await wipeBytes(derived);
  }
}

/**
 * The proof of the announcement of a product key in the journal of `productId`: keyed BLAKE2b
 * (`crypto_generichash`, 32 bytes, keyed by the `approof1` subkey) of
 * `agentplugged/key-proof/v1\0` then the product id, in base64url. Only a holder of the key can
 * make it, and only a holder can check it.
 */
export async function productKeyProof(key: Uint8Array, productId: string): Promise<string> {
  const derived = await subkey(key, CONTEXT.proof);
  try {
    const lib = await sodium();
    return toBase64url(lib.crypto_generichash(32, utf8(`${KEY_PROOF_LABEL}${productId}`), derived));
  } finally {
    await wipeBytes(derived);
  }
}

/** True when `proof` is the proof of `key` for `productId` (constant-time comparison). */
export async function verifyProductKeyProof(
  key: Uint8Array,
  productId: string,
  proof: string,
): Promise<boolean> {
  const expected = fromBase64url(await productKeyProof(key, productId)) as Uint8Array;
  const given = fromBase64url(proof);
  if (given === undefined || given.length !== expected.length) return false;
  const lib = await sodium();
  return lib.memcmp(expected, given);
}

/** Label of the proof that a renewal was made by a holder of the key it follows. */
export const KEY_ROTATION_LABEL = "agentplugged/key-rotation/v1\0";

/**
 * The proof that whoever announces `newKeyId` as the key that follows `previousKey` holds
 * `previousKey`: keyed BLAKE2b (32 bytes, keyed by the `approof1` subkey of the previous key) of
 * `agentplugged/key-rotation/v1\0`, the product id, a zero byte and the new `key_id`. Unlike the
 * proof of an announcement, it cannot be copied from the journal: it is made for one renewal.
 */
export async function productKeyRotationProof(
  previousKey: Uint8Array,
  productId: string,
  newKeyId: string,
): Promise<string> {
  const derived = await subkey(previousKey, CONTEXT.proof);
  try {
    const lib = await sodium();
    return toBase64url(
      lib.crypto_generichash(32, utf8(`${KEY_ROTATION_LABEL}${productId}\0${newKeyId}`), derived),
    );
  } finally {
    await wipeBytes(derived);
  }
}

/** True when `proof` is the rotation proof of `previousKey` for this renewal (constant time). */
export async function verifyProductKeyRotationProof(
  previousKey: Uint8Array,
  productId: string,
  newKeyId: string,
  proof: string,
): Promise<boolean> {
  const expected = fromBase64url(
    await productKeyRotationProof(previousKey, productId, newKeyId),
  ) as Uint8Array;
  const given = fromBase64url(proof);
  if (given === undefined || given.length !== expected.length) return false;
  const lib = await sodium();
  return lib.memcmp(expected, given);
}

// --- events -----------------------------------------------------------------------------------

/**
 * What a `payload_enc` is bound to: `agentplugged/event/v1\0` then the RFC 8785 canonical JSON of
 * the envelope as written without `payload_enc` and `sig` (it has no `payload`): type, writer,
 * story, chain, date… Moving the ciphertext to another event, or changing one of these fields,
 * makes it fail to decrypt.
 */
export function payloadAssociatedData(env: UnsignedEventEnvelope | EventEnvelope): Uint8Array {
  const { payload: _payload, payload_enc: _encrypted, sig: _sig, ...bound } = env as EventEnvelope;
  return concat(utf8(EVENT_AD_LABEL), canonicalBytes(bound));
}

/** `encryptPayload` with test hooks: `./testing.js` only. */
export async function encryptPayloadWith(
  env: UnsignedEventEnvelope,
  payload: Readonly<Record<string, unknown>>,
  key: Uint8Array,
  hooks: VectorHooks,
): Promise<EncryptedPayload> {
  const nonce = nonceOf(hooks.nonce);
  const derived = await subkey(key, CONTEXT.event);
  try {
    const ct = await seal(canonicalBytes(payload), payloadAssociatedData(env), derived, nonce);
    return {
      alg: PAYLOAD_ENCRYPTION_ALG,
      key_id: await productKeyId(key),
      nonce: toBase64url(nonce),
      ct: toBase64url(ct),
    };
  } finally {
    await wipeBytes(derived);
  }
}

/**
 * The `payload_enc` of `payload` in the envelope `env` (completed: id, date, `prev`, `alg`): the
 * canonical JSON of the payload, encrypted with the `apevent1` subkey and a random nonce.
 */
export function encryptPayload(
  env: UnsignedEventEnvelope,
  payload: Readonly<Record<string, unknown>>,
  key: Uint8Array,
): Promise<EncryptedPayload> {
  return encryptPayloadWith(env, payload, key, {});
}

/**
 * What decrypting an event's `payload_enc` gave: its payload; `unsupported_alg` for an algorithm
 * this engine does not know; `other_key` when it names another product key (unreadable here, not
 * altered); `failed` when, under this key, it does not decrypt to a JSON object.
 */
export type DecryptPayloadResult =
  | { readonly ok: true; readonly payload: Record<string, unknown> }
  | { readonly ok: false; readonly reason: "unsupported_alg" | "other_key" | "failed" };

export async function decryptPayload(
  env: EventEnvelope,
  key: Uint8Array,
): Promise<DecryptPayloadResult> {
  const encrypted = env.payload_enc;
  if (encrypted === undefined) return { ok: false, reason: "failed" };
  if (encrypted.alg !== PAYLOAD_ENCRYPTION_ALG) return { ok: false, reason: "unsupported_alg" };
  if (encrypted.key_id !== (await productKeyId(key))) return { ok: false, reason: "other_key" };
  const nonce = fromBase64url(encrypted.nonce);
  const ct = fromBase64url(encrypted.ct);
  if (nonce === undefined || ct === undefined) return { ok: false, reason: "failed" };
  const derived = await subkey(key, CONTEXT.event);
  let message: Uint8Array | undefined;
  try {
    message = await open(ct, payloadAssociatedData(env), derived, nonce);
  } finally {
    await wipeBytes(derived);
  }
  const text = message === undefined ? undefined : fromUtf8(message);
  if (text === undefined) return { ok: false, reason: "failed" };
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, reason: "failed" };
    }
    return { ok: true, payload: value as Record<string, unknown> };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

// --- files ------------------------------------------------------------------------------------

/** Where an encrypted file belongs: its product, and its path in the workspace. */
export interface FileBinding {
  readonly productId: string;
  /** The workspace-relative path, `/` between names (normalized to NFC here). */
  readonly path: string;
}

/** `agentplugged/file/v1\0<product_id>\0<path in NFC>`: what a file's ciphertext is bound to. */
export function fileAssociatedData(binding: FileBinding): Uint8Array {
  return utf8(`${FILE_AD_LABEL}${binding.productId}\0${binding.path.normalize("NFC")}`);
}

/** `encryptFile` with test hooks: `./testing.js` only. */
export async function encryptFileWith(
  content: string,
  binding: FileBinding,
  key: Uint8Array,
  hooks: VectorHooks,
): Promise<string> {
  const nonce = nonceOf(hooks.nonce);
  const derived = await subkey(key, CONTEXT.file);
  try {
    const ct = await seal(utf8(content), fileAssociatedData(binding), derived, nonce);
    return `${ENCRYPTED_FILE_PREFIX}${await productKeyId(key)}\n${toBase64url(concat(nonce, ct))}\n`;
  } finally {
    await wipeBytes(derived);
  }
}

/**
 * An encrypted file: `agentplugged-enc:1:<key_id>` on its first line, then the nonce and the
 * ciphertext of the UTF-8 content in base64url, encrypted with the `apfile01` subkey and bound to
 * the file's product and path (`fileAssociatedData`): moved elsewhere, it fails to decrypt.
 */
export function encryptFile(
  content: string,
  binding: FileBinding,
  key: Uint8Array,
): Promise<string> {
  return encryptFileWith(content, binding, key, {});
}

/**
 * The `key_id` an encrypted file names on its first line, or undefined when it is not an
 * encrypted file.
 */
export function encryptedFileKeyId(text: string): string | undefined {
  const first = text.split("\n", 1)[0] ?? "";
  if (!first.startsWith(ENCRYPTED_FILE_PREFIX)) return undefined;
  const keyId = first.slice(ENCRYPTED_FILE_PREFIX.length).trimEnd();
  return KEY_ID_PATTERN.test(keyId) ? keyId : undefined;
}

/**
 * The content of an encrypted file: `not_encrypted` when it does not start with the header,
 * `other_key` when it names another key, `failed` when it does not decrypt (altered, or moved).
 */
export type DecryptFileResult =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly reason: "not_encrypted" | "other_key" | "failed" };

export async function decryptFile(
  text: string,
  binding: FileBinding,
  key: Uint8Array,
): Promise<DecryptFileResult> {
  const keyId = encryptedFileKeyId(text);
  if (keyId === undefined) return { ok: false, reason: "not_encrypted" };
  if (keyId !== (await productKeyId(key))) return { ok: false, reason: "other_key" };
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const body = fromBase64url((lines[1] ?? "").trim());
  if (body === undefined || lines.slice(2).some((line) => line.trim() !== "")) {
    return { ok: false, reason: "failed" };
  }
  const derived = await subkey(key, CONTEXT.file);
  let message: Uint8Array | undefined;
  try {
    message = await open(
      body.subarray(NONCE_BYTES),
      fileAssociatedData(binding),
      derived,
      body.subarray(0, NONCE_BYTES),
    );
  } finally {
    await wipeBytes(derived);
  }
  const content = message === undefined ? undefined : fromUtf8(message);
  return content === undefined ? { ok: false, reason: "failed" } : { ok: true, content };
}

// --- export -----------------------------------------------------------------------------------

/**
 * Argon2id limits: `moderate` (libsodium `OPSLIMIT_MODERATE`, `MEMLIMIT_MODERATE`: 256 MiB) for
 * every real export and import; `min` (`OPSLIMIT_MIN`, `MEMLIMIT_MIN`) for tests only. An import
 * accepts exactly the limits it is given (`moderate` by default), nothing else.
 */
export type PassphraseLimits = "moderate" | "min";

async function limitsOf(limits: PassphraseLimits | undefined) {
  const lib = await sodiumSumo();
  return limits === "min"
    ? { opslimit: lib.crypto_pwhash_OPSLIMIT_MIN, memlimit: lib.crypto_pwhash_MEMLIMIT_MIN }
    : {
        opslimit: lib.crypto_pwhash_OPSLIMIT_MODERATE,
        memlimit: lib.crypto_pwhash_MEMLIMIT_MODERATE,
      };
}

async function deriveWrappingKey(
  passphrase: string,
  salt: Uint8Array,
  opslimit: number,
  memlimit: number,
): Promise<Uint8Array> {
  const lib = await sodiumSumo();
  const secret = utf8(passphrase.normalize("NFC"));
  try {
    return lib.crypto_pwhash(
      PRODUCT_KEY_BYTES,
      secret,
      salt,
      opslimit,
      memlimit,
      lib.crypto_pwhash_ALG_ARGON2ID13,
    );
  } finally {
    lib.memzero(secret);
  }
}

function writeUint32(out: Uint8Array, offset: number, value: number): void {
  out[offset] = (value >>> 24) & 0xff;
  out[offset + 1] = (value >>> 16) & 0xff;
  out[offset + 2] = (value >>> 8) & 0xff;
  out[offset + 3] = value & 0xff;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) >>> 0) +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)
  );
}

const FIXED_HEADER = 1 + 8 + SALT_BYTES + NONCE_BYTES;

/** `exportProductKey` with test hooks: `./testing.js` only. */
export async function exportProductKeyWith(
  key: Uint8Array,
  productId: string,
  passphrase: string,
  options: { readonly limits?: PassphraseLimits } & VectorHooks,
): Promise<string> {
  checkKey(key);
  const { opslimit, memlimit } = await limitsOf(options.limits);
  const salt = options.salt ?? randomBytes(SALT_BYTES);
  if (salt.length !== SALT_BYTES) throw new TypeError(`a salt has ${SALT_BYTES} bytes`);
  const nonce = nonceOf(options.nonce);
  const keyId = utf8(await productKeyId(key));
  const product = utf8(productId);
  if (product.length > 255) throw new TypeError("a product id has at most 255 bytes");
  const header = new Uint8Array(FIXED_HEADER + 1 + keyId.length + 1 + product.length);
  header[0] = EXPORT_VERSION;
  writeUint32(header, 1, opslimit);
  writeUint32(header, 5, memlimit);
  header.set(salt, 9);
  header.set(nonce, 9 + SALT_BYTES);
  let at = FIXED_HEADER;
  header[at++] = keyId.length;
  header.set(keyId, at);
  at += keyId.length;
  header[at++] = product.length;
  header.set(product, at);
  const wrapping = await deriveWrappingKey(passphrase, salt, opslimit, memlimit);
  try {
    const ct = await seal(key, concat(utf8(KEY_EXPORT_AD_LABEL), header), wrapping, nonce);
    return `${PRODUCT_KEY_EXPORT_PREFIX}${toBase64url(concat(header, ct))}`;
  } finally {
    await wipeBytes(wrapping);
  }
}

/**
 * The product key of `productId`, exported under a passphrase: `apk1:` then, in base64url, the
 * version (1 byte), the Argon2id limits (operations, then memory in bytes, 4 bytes each,
 * big-endian), the salt (16 bytes), the nonce (24 bytes), the `key_id` and the product id (each
 * its length on 1 byte, then UTF-8) and the ciphertext of the key (48 bytes). Its associated data
 * is `agentplugged/key-export/v1\0` then everything before the ciphertext.
 */
export function exportProductKey(
  key: Uint8Array,
  productId: string,
  passphrase: string,
  options: { readonly limits?: PassphraseLimits } = {},
): Promise<string> {
  return exportProductKeyWith(key, productId, passphrase, options);
}

interface ParsedExport {
  readonly keyId: string;
  readonly productId: string;
  readonly opslimit: number;
  readonly memlimit: number;
  readonly salt: Uint8Array;
  readonly nonce: Uint8Array;
  readonly header: Uint8Array;
  readonly ct: Uint8Array;
}

function parseExport(text: string): ParsedExport | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith(PRODUCT_KEY_EXPORT_PREFIX)) return undefined;
  const bytes = fromBase64url(trimmed.slice(PRODUCT_KEY_EXPORT_PREFIX.length));
  if (bytes === undefined || bytes.length < FIXED_HEADER + 2 || bytes[0] !== EXPORT_VERSION) {
    return undefined;
  }
  let at = FIXED_HEADER;
  const idLength = bytes[at++] ?? 0;
  const keyId = fromUtf8(bytes.subarray(at, at + idLength));
  at += idLength;
  const productLength = bytes[at++] ?? 0;
  const productId = fromUtf8(bytes.subarray(at, at + productLength));
  at += productLength;
  if (bytes.length !== at + PRODUCT_KEY_BYTES + TAG_BYTES) return undefined;
  if (keyId === undefined || !KEY_ID_PATTERN.test(keyId) || !productId) return undefined;
  return {
    keyId,
    productId,
    opslimit: readUint32(bytes, 1),
    memlimit: readUint32(bytes, 5),
    salt: bytes.slice(9, 9 + SALT_BYTES),
    nonce: bytes.slice(9 + SALT_BYTES, FIXED_HEADER),
    header: bytes.slice(0, at),
    ct: bytes.slice(at),
  };
}

/** What an export names before it is opened, or undefined when the text is not an export. */
export function exportedKeyInfo(
  text: string,
): { readonly keyId: string; readonly productId: string } | undefined {
  const parsed = parseExport(text);
  return parsed === undefined ? undefined : { keyId: parsed.keyId, productId: parsed.productId };
}

/**
 * The product key of an export. `format`: not an export of this version, limits other than the
 * ones expected (`moderate` unless told), a derivation that failed, or a key that does not match
 * the `key_id` it names; `passphrase`: the passphrase does not open it (or it was altered).
 */
export type ImportProductKeyResult =
  | {
      readonly ok: true;
      readonly key: Uint8Array;
      readonly keyId: string;
      readonly productId: string;
    }
  | { readonly ok: false; readonly reason: "format" | "passphrase" };

export async function importProductKey(
  text: string,
  passphrase: string,
  options: { readonly limits?: PassphraseLimits } = {},
): Promise<ImportProductKeyResult> {
  const parsed = parseExport(text);
  if (parsed === undefined) return { ok: false, reason: "format" };
  const expected = await limitsOf(options.limits);
  if (parsed.opslimit !== expected.opslimit || parsed.memlimit !== expected.memlimit) {
    return { ok: false, reason: "format" };
  }
  let wrapping: Uint8Array;
  try {
    wrapping = await deriveWrappingKey(passphrase, parsed.salt, parsed.opslimit, parsed.memlimit);
  } catch {
    return { ok: false, reason: "format" };
  }
  try {
    const associated = concat(utf8(KEY_EXPORT_AD_LABEL), parsed.header);
    const key = await open(parsed.ct, associated, wrapping, parsed.nonce);
    if (key === undefined) return { ok: false, reason: "passphrase" };
    if (key.length !== PRODUCT_KEY_BYTES || (await productKeyId(key)) !== parsed.keyId) {
      await wipeBytes(key);
      return { ok: false, reason: "format" };
    }
    return { ok: true, key, keyId: parsed.keyId, productId: parsed.productId };
  } finally {
    await wipeBytes(wrapping);
  }
}

// --- renewal: the new key for a trusted machine ------------------------------------------------

/** Version byte of the plain text of a key box. */
const KEY_BOX_VERSION = 1;

/**
 * The product key sealed for one machine (a sealed box, libsodium `crypto_box_seal`) for the
 * encryption key the product's journal registers for it, as base64url text. The product id is
 * inside the box, so that a box made for one product cannot be passed off as another's. Only that
 * machine opens it: the relay, the repository and every other device see bytes.
 */
export async function sealProductKeyFor(
  key: Uint8Array,
  productId: string,
  machineEncKey: Uint8Array,
): Promise<string> {
  checkKey(key);
  const product = utf8(productId);
  if (product.length > 255) throw new TypeError("a product id has at most 255 bytes");
  const plain = concat(Uint8Array.of(KEY_BOX_VERSION, product.length), product, key);
  try {
    return toBase64url(await sealToPublicKey(plain, machineEncKey));
  } finally {
    await wipeBytes(plain);
  }
}

/**
 * The product key of a box sealed for this machine, or undefined when the box does not open with
 * its key pair, is not well formed or was made for another product. The caller still checks the
 * key against the `key_id` and the proof the journal announces.
 */
export async function openProductKeyBox(
  sealed: string,
  productId: string,
  keys: { readonly publicKey: Uint8Array; readonly secretKey: Uint8Array },
): Promise<Uint8Array | undefined> {
  const box = fromBase64url(sealed);
  if (box === undefined) return undefined;
  const plain = await openSealed(box, keys.publicKey, keys.secretKey);
  if (plain === undefined) return undefined;
  try {
    if (plain[0] !== KEY_BOX_VERSION) return undefined;
    const length = plain[1] ?? 0;
    if (plain.length !== 2 + length + PRODUCT_KEY_BYTES) return undefined;
    if (fromUtf8(plain.subarray(2, 2 + length)) !== productId) return undefined;
    return plain.slice(2 + length);
  } finally {
    await wipeBytes(plain);
  }
}

// --- export of several keys ----------------------------------------------------------------------

/** Version byte of the export of several keys (`apk2:`). */
const EXPORT_VERSION_MANY = 2;

/**
 * Several product keys of `productId` (the current one first, then the older ones kept after a
 * renewal) exported under a passphrase: `apk2:` then, in base64url, the version (2), the Argon2id
 * limits, the salt, the nonce, the number of keys (1 byte), each `key_id` (length on 1 byte, then
 * UTF-8), the product id (length on 1 byte, then UTF-8) and the ciphertext of the keys, 32 bytes
 * each, in the same order. Its associated data is `agentplugged/key-export/v1\0` then everything
 * before the ciphertext. One key alone is still exported as `apk1:`.
 */
export async function exportProductKeysWith(
  keys: readonly Uint8Array[],
  productId: string,
  passphrase: string,
  options: { readonly limits?: PassphraseLimits } & VectorHooks,
): Promise<string> {
  if (keys.length === 0 || keys.length > MAX_EXPORTED_KEYS) {
    throw new TypeError(`an export holds 1 to ${MAX_EXPORTED_KEYS} keys`);
  }
  for (const key of keys) checkKey(key);
  const { opslimit, memlimit } = await limitsOf(options.limits);
  const salt = options.salt ?? randomBytes(SALT_BYTES);
  if (salt.length !== SALT_BYTES) throw new TypeError(`a salt has ${SALT_BYTES} bytes`);
  const nonce = nonceOf(options.nonce);
  const ids: Uint8Array[] = [];
  for (const key of keys) ids.push(utf8(await productKeyId(key)));
  const product = utf8(productId);
  if (product.length > 255) throw new TypeError("a product id has at most 255 bytes");
  const idBytes = ids.reduce((size, id) => size + 1 + id.length, 0);
  const header = new Uint8Array(FIXED_HEADER + 1 + idBytes + 1 + product.length);
  header[0] = EXPORT_VERSION_MANY;
  writeUint32(header, 1, opslimit);
  writeUint32(header, 5, memlimit);
  header.set(salt, 9);
  header.set(nonce, 9 + SALT_BYTES);
  let at = FIXED_HEADER;
  header[at++] = keys.length;
  for (const id of ids) {
    header[at++] = id.length;
    header.set(id, at);
    at += id.length;
  }
  header[at++] = product.length;
  header.set(product, at);
  const plain = concat(...keys);
  const wrapping = await deriveWrappingKey(passphrase, salt, opslimit, memlimit);
  try {
    const ct = await seal(plain, concat(utf8(KEY_EXPORT_AD_LABEL), header), wrapping, nonce);
    return `${PRODUCT_KEYS_EXPORT_PREFIX}${toBase64url(concat(header, ct))}`;
  } finally {
    await wipeBytes(wrapping, plain);
  }
}

/**
 * `keys` of `productId` exported under a passphrase: `apk1:` for one key, `apk2:` for several
 * (the current one first).
 */
export function exportProductKeys(
  keys: readonly Uint8Array[],
  productId: string,
  passphrase: string,
  options: { readonly limits?: PassphraseLimits } = {},
): Promise<string> {
  const [only] = keys;
  if (keys.length === 1 && only !== undefined) {
    return exportProductKey(only, productId, passphrase, options);
  }
  return exportProductKeysWith(keys, productId, passphrase, options);
}

interface ParsedManyExport {
  readonly keyIds: readonly string[];
  readonly productId: string;
  readonly opslimit: number;
  readonly memlimit: number;
  readonly salt: Uint8Array;
  readonly nonce: Uint8Array;
  readonly header: Uint8Array;
  readonly ct: Uint8Array;
}

function parseManyExport(text: string): ParsedManyExport | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith(PRODUCT_KEYS_EXPORT_PREFIX)) return undefined;
  const bytes = fromBase64url(trimmed.slice(PRODUCT_KEYS_EXPORT_PREFIX.length));
  if (bytes === undefined || bytes.length < FIXED_HEADER + 3 || bytes[0] !== EXPORT_VERSION_MANY) {
    return undefined;
  }
  let at = FIXED_HEADER;
  const count = bytes[at++] ?? 0;
  if (count < 1 || count > MAX_EXPORTED_KEYS) return undefined;
  const keyIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const length = bytes[at++] ?? 0;
    const id = fromUtf8(bytes.subarray(at, at + length));
    at += length;
    if (id === undefined || !KEY_ID_PATTERN.test(id)) return undefined;
    keyIds.push(id);
  }
  const productLength = bytes[at++] ?? 0;
  const productId = fromUtf8(bytes.subarray(at, at + productLength));
  at += productLength;
  if (bytes.length !== at + count * PRODUCT_KEY_BYTES + TAG_BYTES) return undefined;
  if (!productId || new Set(keyIds).size !== keyIds.length) return undefined;
  return {
    keyIds,
    productId,
    opslimit: readUint32(bytes, 1),
    memlimit: readUint32(bytes, 5),
    salt: bytes.slice(9, 9 + SALT_BYTES),
    nonce: bytes.slice(9 + SALT_BYTES, FIXED_HEADER),
    header: bytes.slice(0, at),
    ct: bytes.slice(at),
  };
}

/**
 * What an export (`apk1:` or `apk2:`) names before it is opened: the `key_id`s it holds, the
 * current one first, and the product; undefined when the text is not an export.
 */
export function exportedKeysInfo(
  text: string,
): { readonly keyIds: readonly string[]; readonly productId: string } | undefined {
  const many = parseManyExport(text);
  if (many !== undefined) return { keyIds: many.keyIds, productId: many.productId };
  const one = parseExport(text);
  return one === undefined ? undefined : { keyIds: [one.keyId], productId: one.productId };
}

/** The keys of an export, the current one first, each checked against the `key_id` it names. */
export type ImportProductKeysResult =
  | {
      readonly ok: true;
      readonly keys: ReadonlyArray<{ readonly key: Uint8Array; readonly keyId: string }>;
      readonly productId: string;
    }
  | { readonly ok: false; readonly reason: "format" | "passphrase" };

/**
 * The keys of an export of either format. Same refusals as `importProductKey`: `format` for text
 * that is not an export, limits other than the expected ones, a derivation that failed or a key
 * that does not match the `key_id` it names; `passphrase` when the passphrase does not open it.
 */
export async function importProductKeys(
  text: string,
  passphrase: string,
  options: { readonly limits?: PassphraseLimits } = {},
): Promise<ImportProductKeysResult> {
  const many = parseManyExport(text);
  if (many === undefined) {
    const one = await importProductKey(text, passphrase, options);
    return one.ok
      ? { ok: true, keys: [{ key: one.key, keyId: one.keyId }], productId: one.productId }
      : one;
  }
  const expected = await limitsOf(options.limits);
  if (many.opslimit !== expected.opslimit || many.memlimit !== expected.memlimit) {
    return { ok: false, reason: "format" };
  }
  let wrapping: Uint8Array;
  try {
    wrapping = await deriveWrappingKey(passphrase, many.salt, many.opslimit, many.memlimit);
  } catch {
    return { ok: false, reason: "format" };
  }
  try {
    const plain = await open(
      many.ct,
      concat(utf8(KEY_EXPORT_AD_LABEL), many.header),
      wrapping,
      many.nonce,
    );
    if (plain === undefined) return { ok: false, reason: "passphrase" };
    const keys: Array<{ key: Uint8Array; keyId: string }> = [];
    try {
      for (let index = 0; index < many.keyIds.length; index += 1) {
        const key = plain.slice(index * PRODUCT_KEY_BYTES, (index + 1) * PRODUCT_KEY_BYTES);
        const keyId = many.keyIds[index] as string;
        if (key.length !== PRODUCT_KEY_BYTES || (await productKeyId(key)) !== keyId) {
          await wipeBytes(key, ...keys.map((kept) => kept.key));
          return { ok: false, reason: "format" };
        }
        keys.push({ key, keyId });
      }
    } finally {
      await wipeBytes(plain);
    }
    return { ok: true, keys, productId: many.productId };
  } finally {
    await wipeBytes(wrapping);
  }
}
