import {
  applyFeedOps,
  type FeedCursor,
  FeedPatchError,
  type MachineReport,
  type PublishedState,
  sameCursor,
  TRUST_SIGNATURE_TAGS,
  VAULT_BLOB_TAG,
  VAULT_MAX_PLAIN_BYTES,
  VAULT_VERSION,
  type VaultBlob,
  VaultBlobSchema,
  type VaultContent,
  VaultContentReader,
  type VaultKeyBox,
} from "@agentplugged/protocol";
import type { X25519Agreement } from "./browser-keys.js";
import { fromBase64url, fromUtf8, toBase64url, utf8 } from "./encoding.js";
import { randomBytes, sha256 } from "./hash.js";
import {
  AEAD_KEY_BYTES,
  aeadDecrypt,
  aeadEncrypt,
  concatBytes,
  deriveKey,
  generateX25519,
  lengthPrefixed,
  newNonce,
  wipe,
  x25519,
} from "./primitives.js";
import { signTrustRecord, verifyTrustRecord } from "./trust-signature.js";

/**
 * Sealing and opening the vault of a product (see the protocol's `vault.ts`).
 *
 * The content is compressed, then encrypted ONCE with a random content key; that key is sealed for
 * each trusted device with a fresh ephemeral X25519 key. A blob is signed by the machine that
 * sealed it: a view checks the signature against the machine it trusts before it decrypts, so a
 * relay that swaps, edits or replays a blob is rejected, never believed.
 */

const CONTENT_AD_LABEL = "agentplugged/vault/v1";
const KEY_AD_LABEL = "agentplugged/vault-key/v1";
const KEY_KDF_CONTEXT = "apvault1";

// ---------------------------------------------------------------------------------------------
// Compression (the platform's own stream: the same code runs on the machine and in a browser).

async function runStream(
  bytes: Uint8Array,
  transform: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> },
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();
  const feeding = writer
    .write(bytes)
    .then(() => writer.close())
    .catch(() => undefined);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  } finally {
    await feeding;
  }
  return concatBytes(...chunks);
}

/** `bytes` compressed (gzip). */
export async function compressBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const packed = await runStream(
    bytes,
    new CompressionStream("gzip") as unknown as {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
    },
    Number.MAX_SAFE_INTEGER,
  );
  if (packed === undefined) throw new Error("the content could not be compressed");
  return packed;
}

/** `bytes` decompressed, or undefined when they are no valid gzip or grow past `maxBytes` (a bomb). */
export function decompressBytes(
  bytes: Uint8Array,
  maxBytes: number = VAULT_MAX_PLAIN_BYTES,
): Promise<Uint8Array | undefined> {
  return runStream(
    bytes,
    new DecompressionStream("gzip") as unknown as {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
    },
    maxBytes,
  );
}

// ---------------------------------------------------------------------------------------------
// Sealing

/** A device the content key is sealed for: its journal identifier and its X25519 key. */
export interface VaultRecipient {
  readonly device: string;
  readonly encKey: Uint8Array;
}

interface BlobHeader {
  readonly product: string;
  readonly kind: "full" | "delta";
  readonly rev: number;
  readonly baseRev: number | null;
  readonly at: string;
  readonly bridge: string;
}

function contentAd(header: BlobHeader): Uint8Array {
  return utf8(
    [
      CONTENT_AD_LABEL,
      header.product,
      header.kind,
      String(header.rev),
      String(header.baseRev),
      header.at,
      header.bridge,
    ].join("\n"),
  );
}

function keyAd(product: string, device: string, rev: number): Uint8Array {
  return utf8([KEY_AD_LABEL, product, device, String(rev)].join("\n"));
}

async function boxKey(
  shared: Uint8Array,
  product: string,
  device: string,
  ephemeralPublic: Uint8Array,
): Promise<Uint8Array> {
  return await deriveKey(
    KEY_KDF_CONTEXT,
    concatBytes(
      shared,
      lengthPrefixed(utf8(product)),
      lengthPrefixed(utf8(device)),
      ephemeralPublic,
    ),
  );
}

async function sealKey(
  contentKey: Uint8Array,
  recipient: VaultRecipient,
  product: string,
  rev: number,
): Promise<VaultKeyBox | undefined> {
  const ephemeral = await generateX25519();
  const shared = await x25519(ephemeral.secretKey, recipient.encKey);
  if (shared === undefined) {
    await wipe(ephemeral.secretKey);
    return undefined;
  }
  const key = await boxKey(shared, product, recipient.device, ephemeral.publicKey);
  const nonce = newNonce();
  try {
    const sealed = await aeadEncrypt(key, nonce, contentKey, keyAd(product, recipient.device, rev));
    return {
      device: recipient.device,
      eph: toBase64url(ephemeral.publicKey),
      nonce: toBase64url(nonce),
      box: toBase64url(sealed),
    };
  } finally {
    await wipe(key, shared, ephemeral.secretKey);
  }
}

/** What the machine signs: every field of the blob but the body (replaced by its digest) and `sig`. */
function signedRecord(blob: Omit<VaultBlob, "sig">): Record<string, unknown> {
  const { body, ...header } = blob;
  return {
    ...header,
    t: TRUST_SIGNATURE_TAGS.vaultBlob,
    body_digest: toBase64url(sha256(fromBase64url(body) ?? new Uint8Array())),
  };
}

export interface SealVaultInput {
  readonly product: string;
  readonly rev: number;
  /** ISO 8601. */
  readonly at: string;
  /** The machine that seals, by its journal identifier. */
  readonly bridge: string;
  /** The machine's Ed25519 secret key (libsodium format). */
  readonly sigSecretKey: Uint8Array;
  readonly content: VaultContent;
}

export interface SealedVault {
  /** The blob as the relay keeps it: UTF-8 JSON. */
  readonly bytes: Uint8Array;
  /** The content key of this full vault: the changes that follow are encrypted with it. */
  readonly contentKey: Uint8Array;
}

async function finish(
  header: BlobHeader,
  boxes: VaultKeyBox[],
  contentKey: Uint8Array,
  content: VaultContent,
  sigSecretKey: Uint8Array,
): Promise<Uint8Array> {
  const plain = utf8(JSON.stringify(content));
  const packed = await compressBytes(plain);
  const nonce = newNonce();
  const sealed = await aeadEncrypt(contentKey, nonce, packed, contentAd(header));
  const unsigned: Omit<VaultBlob, "sig"> = {
    v: VAULT_VERSION,
    product: header.product,
    kind: header.kind,
    rev: header.rev,
    base_rev: header.baseRev,
    at: header.at,
    bridge: header.bridge,
    boxes,
    nonce: toBase64url(nonce),
    body: toBase64url(sealed),
  };
  const sig = await signTrustRecord(
    signedRecord(unsigned),
    TRUST_SIGNATURE_TAGS.vaultBlob,
    sigSecretKey,
  );
  return utf8(JSON.stringify({ ...unsigned, sig }));
}

/**
 * A full vault: a new content key, sealed for each recipient (a recipient whose key cannot be used
 * is left out). The size of the blob grows by about 130 bytes per recipient, not by the content.
 */
export async function sealFullVault(
  input: SealVaultInput & { readonly recipients: readonly VaultRecipient[] },
): Promise<SealedVault> {
  if (input.content.content.kind !== "snapshot")
    throw new TypeError("a full vault holds a snapshot");
  const contentKey = randomBytes(AEAD_KEY_BYTES);
  const boxes: VaultKeyBox[] = [];
  for (const recipient of input.recipients) {
    const box = await sealKey(contentKey, recipient, input.product, input.rev);
    if (box !== undefined) boxes.push(box);
  }
  const header: BlobHeader = {
    product: input.product,
    kind: "full",
    rev: input.rev,
    baseRev: null,
    at: input.at,
    bridge: input.bridge,
  };
  const bytes = await finish(header, boxes, contentKey, input.content, input.sigSecretKey);
  return { bytes, contentKey };
}

/** The changes that follow a full vault, encrypted with its content key. */
export async function sealDeltaVault(
  input: SealVaultInput & { readonly baseRev: number; readonly contentKey: Uint8Array },
): Promise<Uint8Array> {
  if (input.content.content.kind !== "change") throw new TypeError("a delta holds a change");
  const header: BlobHeader = {
    product: input.product,
    kind: "delta",
    rev: input.rev,
    baseRev: input.baseRev,
    at: input.at,
    bridge: input.bridge,
  };
  return await finish(header, [], input.contentKey, input.content, input.sigSecretKey);
}

// ---------------------------------------------------------------------------------------------
// Opening

export type VaultOpenFailure =
  | "malformed"
  | "unknown_signer"
  | "bad_signature"
  | "no_key"
  | "decrypt_failed"
  | "invalid_content"
  | "chain_broken";

export interface OpenedVault {
  readonly product: string;
  /** The revision and date of the last blob: the state is as it was then. */
  readonly rev: number;
  readonly at: string;
  readonly bridge: string;
  readonly cursor: FeedCursor;
  readonly state: PublishedState;
  /** What the machine said of itself in the last blob that carried it. */
  readonly report?: MachineReport;
}

export type VaultOpenResult =
  | { readonly ok: true; readonly vault: OpenedVault }
  | { readonly ok: false; readonly reason: VaultOpenFailure };

export interface OpenVaultOptions {
  /** The identifier of the device that opens (the one a key box names). */
  readonly self: string;
  readonly agreement?: X25519Agreement;
  readonly secretKey?: Uint8Array;
  /** The Ed25519 public key of a machine this device trusts, or undefined for any other. */
  readonly signerKey: (bridge: string) => Uint8Array | undefined;
}

const fail = (reason: VaultOpenFailure): VaultOpenResult => ({ ok: false, reason });

function parseBlob(bytes: Uint8Array): VaultBlob | undefined {
  const text = fromUtf8(bytes);
  if (text === undefined) return undefined;
  try {
    const parsed = VaultBlobSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function openContentKey(
  first: VaultBlob,
  options: OpenVaultOptions,
): Promise<Uint8Array | undefined> {
  const box = first.boxes.find((candidate) => candidate.device === options.self);
  if (box === undefined) return undefined;
  const eph = fromBase64url(box.eph);
  const nonce = fromBase64url(box.nonce);
  const sealed = fromBase64url(box.box);
  if (eph === undefined || nonce === undefined || sealed === undefined) return undefined;
  let shared: Uint8Array | undefined;
  if (options.agreement !== undefined) shared = await options.agreement.agree(eph);
  else if (options.secretKey?.length === 32) shared = await x25519(options.secretKey, eph);
  if (shared === undefined) return undefined;
  const key = await boxKey(shared, first.product, options.self, eph);
  try {
    return await aeadDecrypt(key, nonce, sealed, keyAd(first.product, options.self, first.rev));
  } finally {
    await wipe(key, shared);
  }
}

/**
 * Opens the blobs the relay holds for a product, in revision order: a full vault, then the changes
 * after it. Every blob must be signed by one machine this device trusts and must follow the one
 * before it; the state is rebuilt by applying the changes to the snapshot. Never throws on what the
 * relay hands over: a failure carries a reason only.
 */
export async function openVault(
  blobs: readonly Uint8Array[],
  options: OpenVaultOptions,
): Promise<VaultOpenResult> {
  if (blobs.length === 0) return fail("malformed");
  const parsed: VaultBlob[] = [];
  for (const bytes of blobs) {
    const blob = parseBlob(bytes);
    if (blob === undefined) return fail("malformed");
    parsed.push(blob);
  }
  const first = parsed[0] as VaultBlob;
  if (first.kind !== "full" || first.base_rev !== null) return fail("malformed");
  const signer = options.signerKey(first.bridge);
  if (signer === undefined) return fail("unknown_signer");
  let previousRev = 0;
  for (const blob of parsed) {
    if (blob.bridge !== first.bridge || blob.product !== first.product) {
      return fail("chain_broken");
    }
    if (blob.rev <= previousRev) return fail("chain_broken");
    if (blob !== first && (blob.kind !== "delta" || blob.base_rev !== previousRev)) {
      return fail("chain_broken");
    }
    previousRev = blob.rev;
    const { sig, ...unsigned } = blob;
    const verified = await verifyTrustRecord(
      signedRecord(unsigned),
      TRUST_SIGNATURE_TAGS.vaultBlob,
      sig,
      signer,
    );
    if (!verified) return fail("bad_signature");
  }
  const contentKey = await openContentKey(first, options);
  if (contentKey === undefined)
    return fail(first.boxes.some((b) => b.device === options.self) ? "decrypt_failed" : "no_key");
  try {
    let state: PublishedState | undefined;
    let cursor: FeedCursor | undefined;
    let report: MachineReport | undefined;
    for (const blob of parsed) {
      const nonce = fromBase64url(blob.nonce);
      const body = fromBase64url(blob.body);
      if (nonce === undefined || body === undefined) return fail("malformed");
      const header: BlobHeader = {
        product: blob.product,
        kind: blob.kind,
        rev: blob.rev,
        baseRev: blob.base_rev,
        at: blob.at,
        bridge: blob.bridge,
      };
      const packed = await aeadDecrypt(contentKey, nonce, body, contentAd(header));
      if (packed === undefined) return fail("decrypt_failed");
      const plain = await decompressBytes(packed);
      const text = plain === undefined ? undefined : fromUtf8(plain);
      if (text === undefined) return fail("invalid_content");
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return fail("invalid_content");
      }
      const checked = VaultContentReader.safeParse(json);
      if (!checked.success) return fail("invalid_content");
      const { content } = checked.data;
      if (content.product !== blob.product) return fail("invalid_content");
      if (checked.data.report !== undefined) report = checked.data.report;
      if (content.kind === "snapshot") {
        if (blob.kind !== "full" || state !== undefined) return fail("invalid_content");
        state = content.state;
        cursor = content.cursor;
      } else {
        if (blob.kind !== "delta" || state === undefined || cursor === undefined) {
          return fail("invalid_content");
        }
        if (!sameCursor(content.from_cursor, cursor)) return fail("chain_broken");
        try {
          state = applyFeedOps(state, content.ops);
        } catch (error) {
          if (error instanceof FeedPatchError) return fail("invalid_content");
          throw error;
        }
        cursor = content.to_cursor;
      }
    }
    if (state === undefined || cursor === undefined) return fail("invalid_content");
    const last = parsed[parsed.length - 1] as VaultBlob;
    return {
      ok: true,
      vault: {
        product: first.product,
        rev: last.rev,
        at: last.at,
        bridge: first.bridge,
        cursor,
        state,
        ...(report === undefined ? {} : { report }),
      },
    };
  } finally {
    await wipe(contentKey);
  }
}
