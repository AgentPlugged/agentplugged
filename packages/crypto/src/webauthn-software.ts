// A software WebAuthn authenticator (ES256, Node only): what tests use in place of Windows Hello,
// so that no test ever shows a system prompt. Exported as `@agentplugged/crypto/webauthn-software`;
// never used by the product itself.
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import type { WebAuthnSignature } from "@agentplugged/protocol";
import { fromBase64url, toBase64url, utf8 } from "./encoding.js";
import { randomBytes, sha256 } from "./hash.js";
import { WEBAUTHN_ORIGIN, WEBAUTHN_RP_ID } from "./webauthn.js";
import { type AttestedCredential, parsePresenceAttestation } from "./webauthn-verify.js";

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function uint32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

/** What the software authenticator does: a faulty or absent one is simulated by these. */
export interface SoftwareAuthenticatorOptions {
  /** A user-verifying authenticator is available (true by default). */
  available?: boolean;
  /** Assertions carry the UV flag (true by default). */
  userVerified?: boolean;
  /** Creating or asserting fails, as when the creator cancels the prompt (false by default). */
  fail?: boolean;
}

interface Credential {
  readonly id: string;
  readonly privateKey: KeyObject;
  counter: number;
}

/**
 * An ES256 platform authenticator in memory: `create` makes a credential (through a real
 * attestation object, read back by `parsePresenceAttestation`), `assert` signs a challenge for
 * `agentplugged.local`, with the UV flag unless told otherwise. `calls` counts what would have
 * been prompts.
 */
export class SoftwareAuthenticator {
  available: boolean;
  userVerified: boolean;
  fail: boolean;
  readonly calls: Array<{ kind: "create" | "assert"; challenge?: string }> = [];
  readonly #credentials = new Map<string, Credential>();

  constructor(options: SoftwareAuthenticatorOptions = {}) {
    this.available = options.available ?? true;
    this.userVerified = options.userVerified ?? true;
    this.fail = options.fail ?? false;
  }

  async availability(): Promise<{ available: true } | { available: false; reason: string }> {
    return this.available ? { available: true } : { available: false, reason: "not_configured" };
  }

  async create(): Promise<AttestedCredential> {
    this.calls.push({ kind: "create" });
    if (this.fail || !this.available) throw new Error("the software authenticator refused");
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const x = fromBase64url(jwk.x ?? "");
    const y = fromBase64url(jwk.y ?? "");
    if (x === undefined || y === undefined) throw new Error("no P-256 point");
    const { isoCBOR } = await import("@simplewebauthn/server/helpers");
    const cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, x],
        [-3, y],
      ]),
    );
    const credentialId = randomBytes(16);
    const authData = concat(
      sha256(utf8(WEBAUTHN_RP_ID)),
      Uint8Array.of(FLAG_UP | FLAG_UV | FLAG_AT),
      uint32(0),
      new Uint8Array(16),
      Uint8Array.of(0, credentialId.length),
      credentialId,
      cose,
    );
    const attestation = isoCBOR.encode(
      new Map<string, string | Uint8Array | Map<string, string>>([
        ["fmt", "none"],
        ["attStmt", new Map<string, string>()],
        ["authData", authData],
      ]),
    );
    const credential = await parsePresenceAttestation(attestation);
    if (credential === undefined) throw new Error("unreadable attestation");
    this.#credentials.set(credential.credential_id, {
      id: credential.credential_id,
      privateKey,
      counter: 0,
    });
    return credential;
  }

  async assert(credentialId: string, challenge: Uint8Array): Promise<WebAuthnSignature> {
    this.calls.push({ kind: "assert", challenge: toBase64url(challenge) });
    const credential = this.#credentials.get(credentialId);
    if (this.fail || !this.available || credential === undefined) {
      throw new Error("the software authenticator refused");
    }
    credential.counter += 1;
    const flags = FLAG_UP | (this.userVerified ? FLAG_UV : 0);
    const authenticatorData = concat(
      sha256(utf8(WEBAUTHN_RP_ID)),
      Uint8Array.of(flags),
      uint32(credential.counter),
    );
    const clientDataJSON = utf8(
      JSON.stringify({
        type: "webauthn.get",
        challenge: toBase64url(challenge),
        origin: WEBAUTHN_ORIGIN,
        crossOrigin: false,
      }),
    );
    const signature = sign("sha256", concat(authenticatorData, sha256(clientDataJSON)), {
      key: credential.privateKey,
      dsaEncoding: "der",
    });
    return {
      authenticatorData: toBase64url(authenticatorData),
      clientDataJSON: toBase64url(clientDataJSON),
      signature: toBase64url(new Uint8Array(signature)),
    };
  }
}
