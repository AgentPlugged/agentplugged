import { describe, expect, it } from "vitest";
import {
  LinkRequestSchema,
  LinkWelcomeSchema,
  linkWelcomeRecord,
  PAIR_ERROR_CODES,
  PAIR_MESSAGE_TYPES,
  PairWireSchema,
  ProductKeysSchema,
} from "./pairing.js";
import {
  RelayAttachDeclarationSchema,
  RelayClientFrameSchema,
  RelayServerFrameSchema,
  relayAttachPayload,
  relayRendezvousPayload,
} from "./relay.js";

const KEY = `${"A".repeat(42)}A`;
const SIG = `${"A".repeat(85)}A`;
const X = `${"A".repeat(21)}A`;
const ULID = "01K6KXJ5G0ABCDEFGHJKMNPQRS";
const BROWSER = "browser:AAAAAAAAAAAAAAAA";
const HASH = `sha256:${"A".repeat(43)}`;

const request = {
  t: PAIR_MESSAGE_TYPES.request,
  account: ULID,
  browser: {
    device: BROWSER,
    sig: { alg: "ed25519", key: KEY },
    enc: { alg: "x25519", key: KEY },
  },
  declared: { type: "Chrome", os: "Windows" },
};

describe("the request of the browser", () => {
  it("accepts the packet of keys with the declared type and system, and the account", () => {
    expect(LinkRequestSchema.safeParse(request).success).toBe(true);
  });

  it("refuses a key in excess, a wrong identifier, another algorithm and a long declaration", () => {
    for (const bad of [
      { ...request, extra: 1 },
      { ...request, browser: { ...request.browser, device: "phone:AAAAAAAAAAAAAAAA" } },
      { ...request, browser: { ...request.browser, sig: { alg: "rsa", key: KEY } } },
      { ...request, declared: { type: "x".repeat(41), os: "Windows" } },
      { ...request, account: "not-a-ulid" },
      { ...request, t: "link.request/v2" },
    ]) {
      expect(LinkRequestSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("the messages of the handover", () => {
  const welcome = {
    t: PAIR_MESSAGE_TYPES.welcome,
    root: { device: "machine:AAAAAAAAAAAAAAAA", key: KEY },
    bridge: {
      device: "machine:AAAAAAAAAAAAAAAA",
      sig: { alg: "ed25519" as const, key: KEY },
      enc: { alg: "x25519" as const, key: KEY },
    },
    browser: BROWSER,
    request: KEY,
    registry: [
      { product: ULID, head: HASH, root: { device: "machine:AAAAAAAAAAAAAAAA", key: KEY } },
    ],
    sig: SIG,
  };

  it("the welcome names the root, the bridge's keys, the heads and the request it acknowledges", () => {
    expect(LinkWelcomeSchema.safeParse(welcome).success).toBe(true);
    expect(LinkWelcomeSchema.safeParse({ ...welcome, secret: "s" }).success).toBe(false);
    const { sig: _sig, ...unsigned } = welcome;
    expect(Object.keys(linkWelcomeRecord(unsigned)).sort()).toEqual(
      ["browser", "bridge", "registry", "request", "root", "t"].sort(),
    );
  });

  it("the keys of a product carry the identifier the browser checks", () => {
    const keys = { t: PAIR_MESSAGE_TYPES.productKeys, product: ULID, key_id: "k1", key: KEY };
    expect(ProductKeysSchema.safeParse(keys).success).toBe(true);
    expect(ProductKeysSchema.safeParse({ ...keys, key_id: "" }).success).toBe(false);
  });

  it("the wire messages are the three kinds, strict", () => {
    expect(PairWireSchema.safeParse({ k: "request", nonce: "n", ciphertext: "c" }).success).toBe(
      true,
    );
    expect(
      PairWireSchema.safeParse({ k: "refused", code: PAIR_ERROR_CODES.PAIRING_EXPIRED }).success,
    ).toBe(true);
    expect(PairWireSchema.safeParse({ k: "refused", code: "OTHER" }).success).toBe(false);
    expect(PairWireSchema.safeParse({ k: "unknown" }).success).toBe(false);
  });
});

describe("the frames of the rendezvous", () => {
  it("are strict and carry nothing but x, a key, a date, a signature and opaque bytes", () => {
    const open = { type: "rv_open", v: 1, x: X, bridge_key: KEY, signed_at: 1, signature: SIG };
    expect(RelayClientFrameSchema.safeParse(open).success).toBe(true);
    expect(RelayClientFrameSchema.safeParse({ ...open, s: "secret" }).success).toBe(false);
    expect(RelayClientFrameSchema.safeParse({ type: "rv_join", v: 1, x: X }).success).toBe(true);
    expect(
      RelayClientFrameSchema.safeParse({ type: "rv_message", id: ULID, data: "AAAA" }).success,
    ).toBe(true);
    expect(
      RelayClientFrameSchema.safeParse({ type: "rv_message", id: ULID, data: "not base64 !" })
        .success,
    ).toBe(false);
    expect(RelayServerFrameSchema.safeParse({ type: "rv_peer", peer: "p1" }).success).toBe(true);
    expect(
      RelayServerFrameSchema.safeParse({ type: "rv_sent", id: ULID, delivered: true }).success,
    ).toBe(true);
  });

  it("what a bridge signs carries its label, the relay's name and the challenge", () => {
    const text = (bytes: Uint8Array) => String.fromCharCode(...bytes);
    expect(text(relayRendezvousPayload("chal", X, "relay.example", 12))).toBe(
      `rendezvous.open/v1\nchal\n${X}\nrelay.example\n12`,
    );
    const declaration = RelayAttachDeclarationSchema.parse({
      device_id: ULID,
      kind: "bridge",
      sig_key: KEY,
      enc_key: KEY,
      relay: "relay.example",
      account: ULID,
      expires_at: 99,
    });
    expect(text(relayAttachPayload(declaration)).split("\n")[0]).toBe("relay.attach/v1");
    expect(RelayAttachDeclarationSchema.safeParse({ ...declaration, kind: "phone" }).success).toBe(
      false,
    );
  });
});
