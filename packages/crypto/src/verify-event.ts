import {
  type Assurance,
  type CodedErrorPayload,
  ErrorCode,
  parseEventEnvelope,
  SIGNATURE_REASON,
  type SignatureReasonKey,
  type WebAuthnSignature,
} from "@agentplugged/protocol";
import { signedBytes, webauthnChallenge } from "./canonical.js";
import { verifyEd25519 } from "./ed25519.js";
import { fromBase64url } from "./encoding.js";
import type { WebAuthnCredential } from "./webauthn.js";

export type VerifyKeys = {
  /** The writer's `locale` key (32 bytes), for `alg: ed25519`. */
  ed25519PublicKey?: Uint8Array;
  /** The writer's `presence` credential, for `alg: webauthn-*`. */
  webauthnCredential?: WebAuthnCredential;
};

/**
 * `{ ok: true }` with the `assurance` the signature gives a human (never the declared one; none
 * for an agent or the system) and, for WebAuthn, the `newCounter` to store with the credential;
 * or `{ ok: false, error }`: `SIGNATURE_INVALID`, or `EVENT_INVALID` / `UPGRADE_REQUIRED` when
 * the envelope itself is rejected.
 */
export type VerifyEventResult =
  | { ok: true; assurance?: Assurance; newCounter?: number }
  | { ok: false; error: CodedErrorPayload };

function signatureInvalid(field: string, reasonKey: SignatureReasonKey): VerifyEventResult {
  return {
    ok: false,
    error: {
      code: ErrorCode.SIGNATURE_INVALID,
      message_key: "error.signature_invalid",
      details: { field, reason_key: reasonKey },
    },
  };
}

/**
 * Verifies one event: its envelope, its signature, then its declared `assurance`.
 * `ed25519` gives `locale` to a human; `webauthn-*` with the UV flag gives `presence`, is
 * rejected without it, and is reserved to humans. Never throws. The `prev` chain (that `prev`
 * names the writer's previous event) is checked by the journal, not here.
 */
export async function verifyEvent(env: unknown, keys: VerifyKeys = {}): Promise<VerifyEventResult> {
  const parsed = parseEventEnvelope(env);
  if (!parsed.success) return { ok: false, error: parsed.error };
  const event = parsed.data;
  const human = event.actor.kind === "human";

  let assurance: Assurance;
  let newCounter: number | undefined;
  if (event.alg === "ed25519") {
    if (keys.ed25519PublicKey === undefined) {
      return signatureInvalid("sig", SIGNATURE_REASON.keyMissing);
    }
    const sig = fromBase64url(event.sig as string);
    const valid =
      sig !== undefined && (await verifyEd25519(signedBytes(event), sig, keys.ed25519PublicKey));
    if (!valid) return signatureInvalid("sig", SIGNATURE_REASON.signatureMismatch);
    assurance = "locale";
  } else {
    if (!human) return signatureInvalid("alg", SIGNATURE_REASON.webauthnNonHuman);
    if (keys.webauthnCredential === undefined) {
      return signatureInvalid("sig", SIGNATURE_REASON.keyMissing);
    }
    const { verifyWebAuthn } = await import("./webauthn-verify.js");
    const result = await verifyWebAuthn(
      event.alg,
      event.sig as WebAuthnSignature,
      webauthnChallenge(event),
      keys.webauthnCredential,
    );
    if (!result.ok) return signatureInvalid("sig", result.reason);
    assurance = "presence";
    newCounter = result.newCounter;
  }

  if (event.assurance !== undefined && event.assurance !== assurance) {
    return signatureInvalid("assurance", SIGNATURE_REASON.assuranceMismatch);
  }
  if (!human) return { ok: true };
  return newCounter === undefined ? { ok: true, assurance } : { ok: true, assurance, newCounter };
}
