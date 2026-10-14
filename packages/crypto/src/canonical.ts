import {
  type CodedErrorPayload,
  EVENT_REASON,
  type EventEnvelope,
  eventInvalid,
  jsonValueIssue,
  type UnsignedEventEnvelope,
} from "@agentplugged/protocol";
import canonicalize from "canonicalize";
import { toBase64url, utf8 } from "./encoding.js";
import { sha256 } from "./hash.js";

/**
 * Canonical JSON (RFC 8785, JCS) of a JSON value, as UTF-8 bytes. Throws when the value has no
 * JSON form; `eventHash` and `verifyEvent` check it first and return `EVENT_INVALID` instead.
 */
export function canonicalBytes(value: unknown): Uint8Array {
  const text = canonicalize(value);
  if (text === undefined) throw new TypeError("canonicalBytes: the value has no JSON form");
  return utf8(text);
}

/** What a signature covers: the canonical JSON of the envelope without `sig` (`alg` included). */
export function signedBytes(env: UnsignedEventEnvelope | EventEnvelope): Uint8Array {
  const { sig: _sig, ...unsigned } = env as EventEnvelope;
  return canonicalBytes(unsigned);
}

export type EventHashResult = { ok: true; hash: string } | { ok: false; error: CodedErrorPayload };

/**
 * Hash of a complete event, `sig` included, as its successor's `prev` names it:
 * `sha256:` then the SHA-256 of its canonical JSON in base64url. A value with no JSON form
 * gives `EVENT_INVALID`. Checking the `prev` chain itself belongs to the journal.
 */
export function eventHash(env: EventEnvelope): EventHashResult {
  const field = jsonValueIssue(env);
  if (field !== undefined) return { ok: false, error: eventInvalid(field, EVENT_REASON.jsonValue) };
  try {
    return { ok: true, hash: `sha256:${toBase64url(sha256(canonicalBytes(env)))}` };
  } catch {
    return { ok: false, error: eventInvalid("", EVENT_REASON.jsonValue) };
  }
}

/** The WebAuthn challenge of an event: the SHA-256 of its signed bytes. */
export function webauthnChallenge(env: UnsignedEventEnvelope | EventEnvelope): Uint8Array {
  return sha256(signedBytes(env));
}
