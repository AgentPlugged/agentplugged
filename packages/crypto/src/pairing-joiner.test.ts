import { describe, expect, it } from "vitest";
import {
  createJoinerKeys,
  createPairOffer,
  encodePairLink,
  generateEd25519,
  offerRecipientKey,
  PAIR_LINK_BYTES,
  PairingJoiner,
  parsePairLink,
  randomBytes,
  toBase64url,
} from "./index.js";

const ACCOUNT = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe("the offer of a linked device", () => {
  const bridge = randomBytes(32);
  const root = randomBytes(32);

  it("draws a fresh rendezvous and a fresh secret each time, and builds the link from what is pinned", () => {
    const input = {
      kind: "phone" as const,
      bridgeSigKey: bridge,
      root: { kind: "machine" as const, key: root },
      appUrl: "https://app.example/",
    };
    const a = createPairOffer(input);
    const b = createPairOffer(input);
    expect(toBase64url(a.link.x)).not.toBe(toBase64url(b.link.x));
    expect(toBase64url(a.link.s)).not.toBe(toBase64url(b.link.s));
    expect(a.url.startsWith("https://app.example/pair#AP2:")).toBe(true);
    expect(a.url.length).toBeLessThanOrEqual(256);
    expect(parsePairLink(a.url)?.kind).toBe("phone");
    expect(Buffer.from(encodePairLink(a.link).slice(4), "base64url")).toHaveLength(PAIR_LINK_BYTES);
    expect(a.order).toEqual({
      t: "pair.offer/v1",
      kind: "phone",
      x: toBase64url(a.link.x),
      s: toBase64url(a.link.s),
    });
  });

  it("the order holds nothing the link does not already hold, and no key of the device", () => {
    const offer = createPairOffer({
      kind: "link",
      bridgeSigKey: bridge,
      root: { kind: "human", key: root },
      appUrl: "https://app.example",
    });
    expect(Object.keys(offer.order).sort()).toEqual(["kind", "s", "t", "x"]);
  });

  it("encrypts only for the key pinned at the link: another key advertised by the relay stops the order", async () => {
    const pinned = randomBytes(32);
    expect(await offerRecipientKey(pinned, undefined)).toBe(pinned);
    expect(await offerRecipientKey(pinned, Uint8Array.from(pinned))).toBe(pinned);
    const substituted = Uint8Array.from(pinned);
    substituted[0] = (substituted[0] ?? 0) ^ 1;
    expect(await offerRecipientKey(pinned, substituted)).toBeUndefined();
  });
});

describe("the joining device", () => {
  async function phoneOffer() {
    return createPairOffer({
      kind: "phone",
      bridgeSigKey: (await generateEd25519()).publicKey,
      root: { kind: "machine", key: randomBytes(32) },
      appUrl: "https://app.example",
    });
  }
  const declared = { type: "x", os: "y" };

  it("a phone answers a phone code and a browser a link, never the other way round", async () => {
    const offer = await phoneOffer();
    const browserKeys = await createJoinerKeys("browser");
    expect(
      () => new PairingJoiner({ link: offer.link, keys: browserKeys, account: ACCOUNT, declared }),
    ).toThrow();
    const phoneKeys = await createJoinerKeys("phone");
    expect(phoneKeys.device.startsWith("phone:")).toBe(true);
    expect(
      () => new PairingJoiner({ link: offer.link, keys: phoneKeys, account: ACCOUNT, declared }),
    ).not.toThrow();
  });

  it("keeps noise out and counts itself linked only after a welcome that verified", async () => {
    const offer = await phoneOffer();
    const keys = await createJoinerKeys("phone");
    const joiner = new PairingJoiner({ link: offer.link, keys, account: ACCOUNT, declared });
    expect(await joiner.receive("not a message")).toEqual({
      type: "ignored",
      reason: "malformed",
    });
    expect(joiner.linked).toBe(false);
    expect(joiner.pins).toBeUndefined();
  });
});
