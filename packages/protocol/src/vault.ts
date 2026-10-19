import { z } from "zod";
import { BRIDGE_ID_PATTERN, DEVICE_ID_PATTERN } from "./device-trust.js";
import { isCanonicalBase64url, ULID_PATTERN } from "./event-envelope.js";
import { MachineReportSchema } from "./machines.js";
import { FeedChangeSchema, FeedSnapshotSchema } from "./published-state.js";
import { readTolerant } from "./tolerant-reader.js";

/**
 * The vault: the last state of a product, kept at the relay so that the creator's views show the project
 * while the creator's machine is off. The machine seals it; the relay keeps opaque bytes it cannot
 * read and cannot alter without a view rejecting them.
 *
 * - The content (compressed, then encrypted ONCE with a random content key) is the same state the
 *   machine publishes live: a snapshot, then the changes that follow. Only the small content key
 *   is sealed for each trusted device, so the size of a vault does not depend on the number of
 *   devices.
 * - The relay holds one full vault per product and the changes after it, never two full ones.
 * - The machine signs the header of each blob (`vault.blob/v1`): a view checks the signature
 *   against the machine it trusts before it decrypts anything.
 */

/** The version of the vault format. */
export const VAULT_VERSION = 1;

/** The label of what the machine signs for a vault blob (also in `TRUST_SIGNATURE_TAGS`). */
export const VAULT_BLOB_TAG = "vault.blob/v1";

/** The most bytes one `vault_put` or `vault_blob` frame carries (decoded). */
export const VAULT_CHUNK_BYTES = 196_608;
/** The most chunks of one blob. */
export const VAULT_CHUNKS_MAX = 256;

/** What the relay keeps apart: a full vault, or the changes after it. */
export const VAULT_KINDS = ["full", "delta"] as const;
export type VaultKind = (typeof VAULT_KINDS)[number];

const b64 = (bytes: number) =>
  z
    .string()
    .length(Math.ceil((bytes * 4) / 3))
    .refine(isCanonicalBase64url);

/** The content key sealed for one device: an ephemeral X25519 key, a nonce and the sealed key. */
export const VaultKeyBoxSchema = z.strictObject({
  device: z.string().regex(DEVICE_ID_PATTERN),
  /** The sender's ephemeral X25519 public key (32 bytes). */
  eph: b64(32),
  /** XChaCha20-Poly1305 nonce (24 bytes). */
  nonce: b64(24),
  /** The content key (32 bytes) and the authentication tag (16 bytes). */
  box: b64(48),
});
export type VaultKeyBox = z.infer<typeof VaultKeyBoxSchema>;

/** A device can open a vault when its box is in the full vault: at most this many are sealed. */
export const VAULT_BOXES_MAX = 64;

/**
 * One blob as it is kept at the relay, from `JSON.stringify`. `rev` rises with every blob of a
 * product (the machine draws it from its clock, never below the previous one) and is the cursor the
 * relay compares; `base_rev` names the blob a change follows. The key boxes are only in a full vault.
 */
export const VaultBlobSchema = z.strictObject({
  v: z.literal(VAULT_VERSION),
  product: z.string().regex(ULID_PATTERN),
  kind: z.enum(VAULT_KINDS),
  rev: z.number().int().positive(),
  base_rev: z.number().int().positive().nullable(),
  /** When the machine sealed the blob, ISO 8601. */
  at: z.iso.datetime(),
  /** The machine that sealed it, by its journal identifier. */
  bridge: z.string().regex(BRIDGE_ID_PATTERN),
  boxes: z.array(VaultKeyBoxSchema).max(VAULT_BOXES_MAX),
  /** XChaCha20-Poly1305 nonce of the content (24 bytes). */
  nonce: b64(24),
  /** The compressed, encrypted content. */
  body: z.string().min(1).refine(isCanonicalBase64url),
  /** Signature of the header and of the digest of `body`. */
  sig: z.string().length(86).refine(isCanonicalBase64url),
});
export type VaultBlob = z.infer<typeof VaultBlobSchema>;

/**
 * What a blob holds once opened: the state the machine published (a snapshot in a full vault, a
 * change in a delta), and what the machine said of itself, which gives the products their names.
 */
export const VaultContentSchema = z.strictObject({
  content: z.discriminatedUnion("kind", [FeedSnapshotSchema, FeedChangeSchema]),
  report: MachineReportSchema.optional(),
});
export type VaultContent = z.infer<typeof VaultContentSchema>;

/**
 * What a device reads once a blob is opened: unknown optional fields dropped, known ones as strict
 * as above. The signed header of the blob stays strict.
 */
export const VaultContentReader = readTolerant(VaultContentSchema);

/** The most a vault expands to when a view decompresses it, in bytes. */
export const VAULT_MAX_PLAIN_BYTES = 64 * 1024 * 1024;
