import { sha1 as nobleSha1 } from "@noble/hashes/legacy.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { randomBytes as nobleRandomBytes } from "@noble/hashes/utils.js";
import { toHex, utf8 } from "./encoding.js";

/** SHA-256 of raw bytes. Portable (pure JavaScript). */
export function sha256(bytes: Uint8Array): Uint8Array {
  return nobleSha256(bytes);
}

/** SHA-256 of a UTF-8 text or of raw bytes, in lowercase hexadecimal. */
export function sha256Hex(data: string | Uint8Array): string {
  return toHex(sha256(typeof data === "string" ? utf8(data) : data));
}

/** `length` bytes from the platform's secure random source (Web Crypto, portable). */
export function randomBytes(length: number): Uint8Array {
  return nobleRandomBytes(length);
}

/**
 * The Git object id of a blob holding `bytes` (`git hash-object`): SHA-1 (40 hexadecimal
 * characters) for a SHA-1 repository, SHA-256 (64) for a SHA-256 one, of `blob <size>\0<bytes>`.
 */
export function gitBlobId(bytes: Uint8Array, algorithm: "sha1" | "sha256" = "sha1"): string {
  const head = utf8(`blob ${bytes.length}\0`);
  const object = new Uint8Array(head.length + bytes.length);
  object.set(head, 0);
  object.set(bytes, head.length);
  return toHex(algorithm === "sha1" ? nobleSha1(object) : nobleSha256(object));
}
