import { TRUST_SIGNATURE_TAGS } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { generateEd25519, signTrustRecord, trustRecordBytes, verifyTrustRecord } from "./index.js";

const AUTH = TRUST_SIGNATURE_TAGS.devicePaired;
const record = { t: AUTH, device: "phone:AAAAAAAAAAAAAAAA", provisional: true };

describe("a key signs the types it knows, each with its label", () => {
  it("signs and verifies a record that carries its label", async () => {
    const pair = await generateEd25519();
    const sig = await signTrustRecord(record, AUTH, pair.secretKey);
    expect(await verifyTrustRecord(record, AUTH, sig, pair.publicKey)).toBe(true);
    expect(
      await verifyTrustRecord({ ...record, provisional: false }, AUTH, sig, pair.publicKey),
    ).toBe(false);
    expect(await verifyTrustRecord(record, AUTH, sig, (await generateEd25519()).publicKey)).toBe(
      false,
    );
  });

  it("never lets an authorization pass for an order, a message or a challenge", async () => {
    const pair = await generateEd25519();
    const sig = await signTrustRecord(record, AUTH, pair.secretKey);
    // Same bytes presented as another type: refused, whatever the signature.
    expect(
      await verifyTrustRecord(record, TRUST_SIGNATURE_TAGS.pairOffer, sig, pair.publicKey),
    ).toBe(false);
    expect(await verifyTrustRecord(record, TRUST_SIGNATURE_TAGS.message, sig, pair.publicKey)).toBe(
      false,
    );
    // A relay's challenge, an unknown label, a missing label: not signed, not verified.
    await expect(
      signTrustRecord({ ...record, t: "relay.auth/v1" }, "relay.auth/v1" as never, pair.secretKey),
    ).rejects.toThrow(TypeError);
    await expect(signTrustRecord({ device: "x" }, AUTH, pair.secretKey)).rejects.toThrow(TypeError);
    await expect(
      signTrustRecord(record, TRUST_SIGNATURE_TAGS.pairOffer, pair.secretKey),
    ).rejects.toThrow(TypeError);
    expect(() => trustRecordBytes({ ...record, t: "x/v1" }, AUTH)).toThrow(TypeError);
    expect(
      await verifyTrustRecord(
        { ...record, t: "relay.auth/v1" },
        "relay.auth/v1" as never,
        sig,
        pair.publicKey,
      ),
    ).toBe(false);
  });

  it("refuses a malformed signature or key without throwing", async () => {
    const pair = await generateEd25519();
    expect(await verifyTrustRecord(record, AUTH, "AAAA", pair.publicKey)).toBe(false);
    expect(await verifyTrustRecord(record, AUTH, "not base64url!", pair.publicKey)).toBe(false);
    const sig = await signTrustRecord(record, AUTH, pair.secretKey);
    expect(await verifyTrustRecord(record, AUTH, sig, pair.publicKey.slice(1))).toBe(false);
  });
});
