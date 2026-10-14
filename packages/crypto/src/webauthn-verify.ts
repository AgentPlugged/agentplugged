// WebAuthn assertion verification with `@simplewebauthn/server` (Node). Exported as
// `@agentplugged/crypto/webauthn-verify`; `verifyEvent` loads it only for `webauthn-*` events.
import type { SignatureAlg, SignatureReasonKey, WebAuthnSignature } from "@agentplugged/protocol";
import { SIGNATURE_REASON } from "@agentplugged/protocol";
import { fromBase64url, toBase64url, utf8 } from "./encoding.js";
import { sha256 } from "./hash.js";
import { WEBAUTHN_ORIGIN, WEBAUTHN_RP_ID, type WebAuthnCredential } from "./webauthn.js";

/** COSE algorithm of each WebAuthn `alg`. */
const COSE_ALG: Readonly<Record<Exclude<SignatureAlg, "ed25519">, number>> = {
  "webauthn-es256": -7,
  "webauthn-rs256": -257,
};

/** Authenticator data flags (WebAuthn §6.1). */
const FLAG_UV = 0x04;
/** rpIdHash (32) + flags (1) + signCount (4). */
const AUTHENTICATOR_DATA_MIN = 37;

export type WebAuthnVerification =
  | { ok: true; newCounter: number }
  | { ok: false; reason: SignatureReasonKey };

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

const fail = (reason: SignatureReasonKey): WebAuthnVerification => ({ ok: false, reason });

/**
 * Checks a WebAuthn assertion over `challenge`: credential algorithm, client data (type,
 * origin, challenge), relying party, UV flag, signature counter, then the signature with
 * `@simplewebauthn/server`. Returns the new counter, to store with the credential.
 */
export async function verifyWebAuthn(
  alg: Exclude<SignatureAlg, "ed25519">,
  sig: WebAuthnSignature,
  challenge: Uint8Array,
  credential: WebAuthnCredential,
): Promise<WebAuthnVerification> {
  const { decodeCredentialPublicKey, cose } = await import("@simplewebauthn/server/helpers");
  try {
    const key = decodeCredentialPublicKey(new Uint8Array(credential.publicKey));
    if (key.get(cose.COSEKEYS.alg) !== COSE_ALG[alg]) return fail(SIGNATURE_REASON.algMismatch);
  } catch {
    return fail(SIGNATURE_REASON.algMismatch);
  }

  const clientDataBytes = fromBase64url(sig.clientDataJSON);
  const authenticatorData = fromBase64url(sig.authenticatorData);
  if (clientDataBytes === undefined || authenticatorData === undefined) {
    return fail(SIGNATURE_REASON.clientDataMismatch);
  }
  let clientData: { type?: unknown; origin?: unknown; challenge?: unknown };
  try {
    clientData = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(clientDataBytes));
  } catch {
    return fail(SIGNATURE_REASON.clientDataMismatch);
  }
  if (
    typeof clientData !== "object" ||
    clientData === null ||
    clientData.type !== "webauthn.get" ||
    clientData.origin !== WEBAUTHN_ORIGIN
  ) {
    return fail(SIGNATURE_REASON.clientDataMismatch);
  }
  const expectedChallenge = toBase64url(challenge);
  if (clientData.challenge !== expectedChallenge) return fail(SIGNATURE_REASON.challengeMismatch);
  if (
    authenticatorData.length < AUTHENTICATOR_DATA_MIN ||
    !equal(authenticatorData.subarray(0, 32), sha256(utf8(WEBAUTHN_RP_ID)))
  ) {
    return fail(SIGNATURE_REASON.clientDataMismatch);
  }
  if (((authenticatorData[32] ?? 0) & FLAG_UV) === 0) return fail(SIGNATURE_REASON.uvMissing);
  const counter = new DataView(
    authenticatorData.buffer,
    authenticatorData.byteOffset,
    authenticatorData.byteLength,
  ).getUint32(33);
  const stored = credential.counter ?? 0;
  if ((stored > 0 || counter > 0) && counter <= stored) {
    return fail(SIGNATURE_REASON.counterRegression);
  }

  const { verifyAuthenticationResponse } = await import("@simplewebauthn/server");
  try {
    const result = await verifyAuthenticationResponse({
      response: {
        id: credential.id,
        rawId: credential.id,
        type: "public-key",
        response: {
          authenticatorData: sig.authenticatorData,
          clientDataJSON: sig.clientDataJSON,
          signature: sig.signature,
        },
        clientExtensionResults: {},
      },
      expectedChallenge,
      expectedOrigin: WEBAUTHN_ORIGIN,
      expectedRPID: WEBAUTHN_RP_ID,
      credential: {
        id: credential.id,
        publicKey: new Uint8Array(credential.publicKey),
        counter: stored,
      },
      requireUserVerification: true,
    });
    return result.verified && result.authenticationInfo.userVerified
      ? { ok: true, newCounter: result.authenticationInfo.newCounter }
      : fail(SIGNATURE_REASON.signatureMismatch);
  } catch {
    return fail(SIGNATURE_REASON.signatureMismatch);
  }
}

/** A credential read from a registration: id and COSE public key (base64url), algorithm. */
export interface AttestedCredential {
  readonly credential_id: string;
  readonly cose_public_key: string;
  readonly alg: Exclude<SignatureAlg, "ed25519">;
}

/**
 * The credential a platform authenticator created, read from its attestation object (CBOR): the
 * attested credential data of its authenticator data. The attestation statement is not checked
 * (attestation `none`): the credential proves itself when it signs `human.presence_linked`.
 * Undefined when the object is unreadable, made for another relying party, without user
 * verification, or of an algorithm other than ES256 and RS256.
 */
export async function parsePresenceAttestation(
  attestationObject: Uint8Array,
): Promise<AttestedCredential | undefined> {
  const { decodeAttestationObject, parseAuthenticatorData, decodeCredentialPublicKey, cose } =
    await import("@simplewebauthn/server/helpers");
  try {
    const authData = decodeAttestationObject(new Uint8Array(attestationObject)).get("authData");
    const parsed = parseAuthenticatorData(authData);
    if (!equal(parsed.rpIdHash, sha256(utf8(WEBAUTHN_RP_ID))) || !parsed.flags.uv) return undefined;
    const { credentialID, credentialPublicKey } = parsed;
    if (credentialID === undefined || credentialPublicKey === undefined) return undefined;
    const algId = decodeCredentialPublicKey(credentialPublicKey).get(cose.COSEKEYS.alg);
    const alg = (Object.keys(COSE_ALG) as Array<keyof typeof COSE_ALG>).find(
      (name) => COSE_ALG[name] === algId,
    );
    if (alg === undefined) return undefined;
    return {
      credential_id: toBase64url(credentialID),
      cose_public_key: toBase64url(credentialPublicKey),
      alg,
    };
  } catch {
    return undefined;
  }
}
