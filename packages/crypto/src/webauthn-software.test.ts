import type { UnsignedEventEnvelope } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { fromBase64url, verifyEvent, webauthnChallenge } from "./index.js";
import { SoftwareAuthenticator } from "./webauthn-software.js";
import { parsePresenceAttestation } from "./webauthn-verify.js";

const unsigned: UnsignedEventEnvelope = {
  v: 1,
  id: "01K6KXJ5G0WEBAVTHNES256003",
  type: "checkpoint.resolved",
  at: "2026-10-03T08:00:00.000Z",
  actor: { kind: "human", device: "human:abcdefghijklmnop" },
  product: "01JZ0000000000000000000000",
  provenance: "trusted",
  prev: null,
  payload: { checkpoint: "G-7M2K9QX4TB", decision: "approved", source: "terminal" },
  alg: "webauthn-es256",
  assurance: "presence",
};

describe("SoftwareAuthenticator", () => {
  it("creates an ES256 credential and signs with UV: verifyEvent gives presence", async () => {
    const authenticator = new SoftwareAuthenticator();
    const credential = await authenticator.create();
    expect(credential.alg).toBe("webauthn-es256");
    const sig = await authenticator.assert(credential.credential_id, webauthnChallenge(unsigned));
    const publicKey = fromBase64url(credential.cose_public_key) as Uint8Array;
    const result = await verifyEvent(
      { ...unsigned, sig },
      { webauthnCredential: { id: credential.credential_id, publicKey } },
    );
    expect(result).toEqual({ ok: true, assurance: "presence", newCounter: 1 });
    expect(authenticator.calls.map((call) => call.kind)).toEqual(["create", "assert"]);
  });

  it("without UV, the assertion is rejected", async () => {
    const authenticator = new SoftwareAuthenticator({ userVerified: false });
    const credential = await authenticator.create();
    const sig = await authenticator.assert(credential.credential_id, webauthnChallenge(unsigned));
    const publicKey = fromBase64url(credential.cose_public_key) as Uint8Array;
    const result = await verifyEvent(
      { ...unsigned, sig },
      { webauthnCredential: { id: credential.credential_id, publicKey } },
    );
    expect(result.ok).toBe(false);
  });

  it("fails like a cancelled prompt, and reports itself unavailable", async () => {
    const authenticator = new SoftwareAuthenticator({ fail: true });
    await expect(authenticator.create()).rejects.toThrow();
    expect(await new SoftwareAuthenticator({ available: false }).availability()).toEqual({
      available: false,
      reason: "not_configured",
    });
  });

  it("refuses an unreadable attestation object", async () => {
    expect(await parsePresenceAttestation(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });
});
