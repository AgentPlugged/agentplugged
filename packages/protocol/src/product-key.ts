import { z } from "zod";
import { AgentIdSchema } from "./method-config.js";

/**
 * The product key: a symmetric key of 32 random bytes, kept in the system keychain of
 * each machine that holds it (service `agentplugged`, account `product:<product_id>`), never in
 * the repository. It encrypts the content of the sensitive events (`payload_enc`) and the files of
 * `.agentplugged/salle/` and `.agentplugged/memory/`. Only its public identifier, `key_id`, is
 * written: by `product.key_created` in the journal, and in each encrypted value.
 */

/** Event types of the product key, each at version 1. */
export const PRODUCT_KEY_EVENT_TYPES = {
  /** The product key was created: its `key_id`, signed by the machine that created it. */
  keyCreated: "product.key_created",
  /**
   * The product key was renewed: a new key follows the one named by `previous_key_id`. The old key
   * stays valid for reading everything written before; only new content is written under the new
   * one. Each trusted machine gets the new key in a box sealed for its own encryption key.
   */
  keyRotated: "product.key_rotated",
} as const;

/** `pk:` then the first 16 base64url characters of the key's `apkeyid1` subkey (`crypto_kdf`). */
export const KEY_ID_PATTERN = /^pk:[A-Za-z0-9_-]{16}$/;

export const KeyIdSchema = z.string().regex(KEY_ID_PATTERN);

/** 32 bytes in base64url: 43 characters, the last one carrying 4 bits only. */
const PROOF_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

/**
 * `payload` of `product.key_created`: the `key_id`, and the `proof` that its writer held the key
 * (keyed BLAKE2b of `agentplugged/key-proof/v1\0` + the product id, by the key's `approof1`
 * subkey). Only a holder of the key checks the proof.
 */
export const ProductKeyCreatedPayloadSchema = z.strictObject({
  key_id: KeyIdSchema,
  proof: z.string().regex(PROOF_PATTERN),
});
export type ProductKeyCreatedPayload = z.infer<typeof ProductKeyCreatedPayloadSchema>;

/** A trusted machine's identifier, the name of its box in a renewal. */
const MACHINE_BOX_OWNER = /^machine:[A-Za-z0-9_-]{16}$/;

/** A sealed box (libsodium `crypto_box_seal`) in base64url: at most 256 characters. */
const KEY_BOX = z.string().regex(/^[A-Za-z0-9_-]{60,256}$/);

/** The most machines a renewal seals the new key for. */
export const MAX_KEY_BOXES = 64;

/**
 * `payload` of `product.key_rotated`: the new `key_id`, the key it follows, the `proof` that the
 * writer held the new key (the same proof as the first announcement), and `boxes`: the new key
 * sealed, one box per trusted machine, for that machine's encryption key. No key is ever in clear.
 */
export const ProductKeyRotatedPayloadSchema = z.strictObject({
  key_id: KeyIdSchema,
  previous_key_id: KeyIdSchema,
  proof: z.string().regex(PROOF_PATTERN),
  /**
   * The proof that the writer held the key this one follows (made with that key, for this renewal
   * only): a machine that holds the previous key ignores a renewal that does not carry it.
   */
  chain_proof: z.string().regex(PROOF_PATTERN),
  /**
   * The signed order that asked for the renewal, when it came from a creator's device: the
   * `order.applied` of the same journal keeps that order. A renewal run again for the same order
   * is recognised by it and not made twice.
   */
  order: z
    .string()
    .regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
    .optional(),
  boxes: z
    .record(z.string().regex(MACHINE_BOX_OWNER), KEY_BOX)
    .refine((boxes) => Object.keys(boxes).length <= MAX_KEY_BOXES, {
      message: `at most ${MAX_KEY_BOXES} boxes`,
    }),
});
export type ProductKeyRotatedPayload = z.infer<typeof ProductKeyRotatedPayloadSchema>;

/** The algorithm of `payload_enc` and of the sensitive files: XChaCha20-Poly1305 (IETF). */
export const PAYLOAD_ENCRYPTION_ALG = "xchacha20poly1305";

/**
 * Domains (`<domain>.*`) of event types that are sensitive whatever their name, before they
 * exist: the Salle, security notes and memory. `cost.reported` is marked in the registry.
 */
export const SENSITIVE_EVENT_DOMAINS: readonly string[] = ["salle", "security", "memory"];

/** The folders of `.agentplugged/` whose files are always written encrypted. */
export const SENSITIVE_AREAS = ["salle", "memory"] as const;
export type SensitiveArea = (typeof SENSITIVE_AREAS)[number];

/** The largest content `write_sensitive` accepts, and `read_sensitive` returns: 256 KiB. */
export const MAX_SENSITIVE_CONTENT_BYTES = 256 * 1024;

/** First line of an encrypted file: this prefix, then the `key_id`. */
export const ENCRYPTED_FILE_PREFIX = "agentplugged-enc:1:";

/** Prefix of an exported product key (`key export`). */
export const PRODUCT_KEY_EXPORT_PREFIX = "apk1:";

/** Prefix of an export that holds several keys: the current one first, then the older ones. */
export const PRODUCT_KEYS_EXPORT_PREFIX = "apk2:";

/** The most keys one export holds: the current key and the older ones kept after renewals. */
export const MAX_EXPORTED_KEYS = 32;

/** The shortest passphrase `key export` accepts, in characters. */
export const MIN_PASSPHRASE_LENGTH = 12;

/** Why a path given to a sensitive file tool is refused. */
const PATH_MESSAGE =
  "expected a relative path inside the area (`/` between names; no `..`, `.`, empty name, drive, reserved character or Windows device name; no name ending with a dot or a space)";

/** A file name part: no control character, no character Windows refuses, not `.` or `..`. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused here.
const SEGMENT = /^(?!\.{1,2}$)[^\u0000-\u001f\u007f<>:"|?*\\/]+$/;

/** Windows device names, refused whatever their extension (`nul.md` names the device too). */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;

/**
 * True when `path` names a file inside a sensitive area: relative, `/` between names, none of
 * them empty, `.` or `..`, ending with a dot or a space, or a Windows device name (`CON`, `NUL`,
 * `COM1`… with any extension), and no drive, backslash or character a file system refuses.
 * Checked on the NFC form, the one the tools use on disk and in the associated data.
 */
export function isSensitivePath(path: string): boolean {
  const normalized = path.normalize("NFC");
  if (normalized.length === 0 || normalized.length > 512) return false;
  return normalized
    .split("/")
    .every(
      (segment) =>
        SEGMENT.test(segment) &&
        segment.trim() === segment &&
        !segment.endsWith(".") &&
        !WINDOWS_RESERVED.test(segment),
    );
}

const SensitivePathSchema = z.string().refine(isSensitivePath, { message: PATH_MESSAGE });

/** The length of `text` in UTF-8 bytes (a lone surrogate counts 3, as its replacement). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

const agent = AgentIdSchema.max(64);

/** Input of `read_sensitive`: a file of the Salle or of the memory, read in clear. */
export const ReadSensitiveInputSchema = z.strictObject({
  agent,
  area: z.enum(SENSITIVE_AREAS),
  path: SensitivePathSchema,
});

/** Input of `write_sensitive`: a file of the Salle or of the memory, written encrypted. */
export const WriteSensitiveInputSchema = z.strictObject({
  agent,
  area: z.enum(SENSITIVE_AREAS),
  path: SensitivePathSchema,
  content: z.string().refine((text) => utf8Length(text) <= MAX_SENSITIVE_CONTENT_BYTES, {
    message: `at most ${MAX_SENSITIVE_CONTENT_BYTES} bytes (UTF-8)`,
  }),
});
