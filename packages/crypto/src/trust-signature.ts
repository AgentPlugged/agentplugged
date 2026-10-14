import { isTrustSignatureTag, type TrustSignatureTag } from "@agentplugged/protocol";
import { canonicalBytes } from "./canonical.js";
import { fromBase64url, toBase64url } from "./encoding.js";
import { sodium } from "./sodium.js";

/**
 * The signatures of the structures of trust: authorizations, orders, messages.
 * A signed structure carries its label `t` (type and version) inside the signed bytes, and a key
 * signs and verifies the types it knows only: a signature made for an authorization never serves
 * as an order, a relay challenge or an event, because the label differs and is signed with it.
 * Ed25519 only: the algorithm of the linked devices.
 */

function checkRecord(record: Readonly<Record<string, unknown>>, expected: TrustSignatureTag): void {
  if (!isTrustSignatureTag(expected)) throw new TypeError("unknown signature label");
  if (record.t !== expected) throw new TypeError("the record does not carry the expected label");
}

/** The bytes a signature of `record` covers: its canonical JSON (RFC 8785), `t` included. */
export function trustRecordBytes(
  record: Readonly<Record<string, unknown>>,
  expected: TrustSignatureTag,
): Uint8Array {
  checkRecord(record, expected);
  return canonicalBytes(record);
}

/** The Ed25519 signature (base64url) of a record, which must carry the `expected` label. */
export async function signTrustRecord(
  record: Readonly<Record<string, unknown>>,
  expected: TrustSignatureTag,
  secretKey: Uint8Array,
): Promise<string> {
  const bytes = trustRecordBytes(record, expected);
  const lib = await sodium();
  return toBase64url(lib.crypto_sign_detached(bytes, secretKey));
}

/**
 * True when `signature` (base64url) is the Ed25519 signature of `record` by `publicKey`, and the
 * record carries the `expected` label. A record with another label, or without one, is false.
 */
export async function verifyTrustRecord(
  record: Readonly<Record<string, unknown>>,
  expected: TrustSignatureTag,
  signature: string,
  publicKey: Uint8Array,
): Promise<boolean> {
  if (!isTrustSignatureTag(expected) || record.t !== expected) return false;
  const sig = fromBase64url(signature);
  if (sig === undefined || sig.length !== 64 || publicKey.length !== 32) return false;
  let bytes: Uint8Array;
  try {
    bytes = canonicalBytes(record);
  } catch {
    return false;
  }
  const lib = await sodium();
  try {
    return lib.crypto_sign_verify_detached(sig, bytes, publicKey);
  } catch {
    return false;
  }
}
