import {
  LinkRequestSchema,
  rootCertifiedRecord,
  TRUST_SIGNATURE_TAGS,
} from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { generateEd25519 } from "./ed25519.js";
import { toBase64url } from "./encoding.js";
import { type PairLink, pairLinkRootDevice } from "./pairing.js";
import {
  createJoinerKeys,
  PairingJoiner,
  rootCertificationBytes,
  signRootCertification,
} from "./pairing-joiner.js";
import { verifyTrustRecord } from "./trust-signature.js";

async function linkWith(kind: "human" | "machine"): Promise<PairLink> {
  const bridge = await generateEd25519();
  const root = await generateEd25519();
  return {
    kind: "link",
    x: new Uint8Array(16).fill(1),
    s: new Uint8Array(16).fill(2),
    bridgeSigKey: bridge.publicKey,
    root: { kind, key: root.publicKey },
  };
}

describe("a device recognises the creator's key a link carries as its root", () => {
  it("signs the root and the date, and the signature holds for that device's key only", async () => {
    const link = await linkWith("human");
    const keys = await createJoinerKeys("phone");
    const issuedAt = "2026-10-15T09:00:00.000Z";

    const certification = await signRootCertification(link, keys.sigSecretKey, issuedAt);
    expect(certification?.issued_at).toBe(issuedAt);

    const record = rootCertifiedRecord({
      root: { device: pairLinkRootDevice(link), key: toBase64url(link.root.key) },
      issued_at: issuedAt,
    });
    const holds = (key: Uint8Array, at = record) =>
      verifyTrustRecord(at, TRUST_SIGNATURE_TAGS.rootCertified, certification?.sig ?? "", key);
    expect(await holds(keys.sigPublicKey)).toBe(true);
    expect(await holds((await generateEd25519()).publicKey)).toBe(false);
    // Another date, or another root, is another signature.
    expect(
      await holds(keys.sigPublicKey, { ...record, issued_at: "2026-10-15T09:00:01.000Z" }),
    ).toBe(false);
    expect(rootCertificationBytes(link, issuedAt)).toBeInstanceOf(Uint8Array);
  });

  it("has nothing to sign when the root is a machine's key", async () => {
    const link = await linkWith("machine");
    const keys = await createJoinerKeys("phone");
    expect(rootCertificationBytes(link, "2026-10-15T09:00:00.000Z")).toBeUndefined();
    expect(await signRootCertification(link, keys.sigSecretKey, "2026-10-15T09:00:00.000Z")).toBe(
      undefined,
    );
  });

  it("goes in the request the joiner sends, and a request without it is as valid", async () => {
    // A phone answers the code a phone scans.
    const link: PairLink = { ...(await linkWith("human")), kind: "phone" };
    const keys = await createJoinerKeys("phone");
    const rootCertification = await signRootCertification(
      link,
      keys.sigSecretKey,
      "2026-10-15T09:00:00.000Z",
    );
    const options = {
      link,
      keys,
      account: "01K6KXJ5G0PR0DVCT00000000A",
      declared: { type: "iPhone", os: "iOS" },
    };
    const with_ = new PairingJoiner({ ...options, rootCertification }).request();
    const without = new PairingJoiner(options).request();
    expect(with_.root_certification).toEqual(rootCertification);
    expect(without.root_certification).toBeUndefined();
    expect(LinkRequestSchema.safeParse(with_).success).toBe(true);
    expect(LinkRequestSchema.safeParse(without).success).toBe(true);
  });
});
