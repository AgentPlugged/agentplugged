// Portable part of WebAuthn: constants and types. The verification itself, which needs
// `@simplewebauthn/server` (Node), is in `webauthn-verify.ts`
// (`@agentplugged/crypto/webauthn-verify`), loaded only when an event uses `webauthn-*`.

/** Relying party of every `presence` credential. */
export const WEBAUTHN_RP_ID = "agentplugged.local";
export const WEBAUTHN_ORIGIN = `https://${WEBAUTHN_RP_ID}`;

/** A registered `presence` credential: its id (base64url) and COSE public key. */
export type WebAuthnCredential = {
  id: string;
  publicKey: Uint8Array;
  /** Last signature counter seen; 0 when unknown. */
  counter?: number;
};
