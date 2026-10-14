import type { PresenceCredential, WebAuthnSignature } from "@agentplugged/protocol";

/** Why the `presence` assurance is out of reach: the creator's validations stay `locale`. */
export type PresenceUnavailableReason =
  /** Not Windows: macOS and Linux get `locale` only for now. */
  | "platform"
  /** The FFI (`koffi`) or `webauthn.dll` could not be loaded. */
  | "unsupported"
  /** Windows Hello is not configured (no user-verifying platform authenticator). */
  | "not_configured"
  /** Turned off for this process (`AGENTPLUGGED_PRESENCE=none`: tests and CI). */
  | "disabled";

export type PresenceAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: PresenceUnavailableReason | string };

/** The user a credential is made for (shown by the system's prompt). */
export interface PresenceUser {
  readonly id: Uint8Array;
  readonly name: string;
  readonly displayName: string;
}

/**
 * Port to the platform WebAuthn authenticator (Windows Hello through `webauthn.dll`): relying
 * party `agentplugged.local`, user verification required. `availability` never prompts; `create`
 * and `assert` show the system's prompt, and throw when it fails or is cancelled. Tests use a
 * software authenticator: no test ever prompts.
 */
export interface PresenceAuthenticator {
  availability(): Promise<PresenceAvailability>;
  /** A new credential (ES256, else RS256), with user verification. */
  create(user: PresenceUser): Promise<PresenceCredential>;
  /** An assertion with user verification over `challenge`, by the credential `credentialId`. */
  assert(credentialId: string, challenge: Uint8Array): Promise<WebAuthnSignature>;
}

/** An authenticator that is never available (other systems, or `AGENTPLUGGED_PRESENCE=none`). */
export function unavailablePresence(
  reason: PresenceUnavailableReason | string,
): PresenceAuthenticator {
  const refuse = () => Promise.reject(new Error(`presence is unavailable (${reason})`));
  return {
    availability: async () => ({ available: false, reason }),
    create: refuse,
    assert: refuse,
  };
}
