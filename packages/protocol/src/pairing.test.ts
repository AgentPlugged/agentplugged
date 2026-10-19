import { describe, expect, it } from "vitest";
import {
  LinkRequestSchema,
  LinkWelcomeSchema,
  linkWelcomeRecord,
  PAIR_ERROR_CODES,
  PAIR_MESSAGE_TYPES,
  PairCodeOfferOrderSchema,
  PairHelloSchema,
  PairOfferOrderSchema,
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
      { ...request, browser: { ...request.browser, device: "robot:AAAAAAAAAAAAAAAA" } },
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

describe("the offer of a linked device", () => {
  const good = { t: "pair.offer/v1", kind: "phone", x: X, s: X };

  it("accepts a link or a phone, with a rendezvous and a secret of 16 bytes", () => {
    expect(PairOfferOrderSchema.safeParse(good).success).toBe(true);
    expect(PairOfferOrderSchema.safeParse({ ...good, kind: "link" }).success).toBe(true);
  });

  it("refuses another kind, a short or long secret, a field in excess and another label", () => {
    expect(PairOfferOrderSchema.safeParse({ ...good, kind: "robot" }).success).toBe(false);
    // A machine takes a short code, not a link's secret.
    expect(PairOfferOrderSchema.safeParse({ ...good, kind: "machine" }).success).toBe(false);
    expect(PairOfferOrderSchema.safeParse({ ...good, s: "AAAA" }).success).toBe(false);
    expect(PairOfferOrderSchema.safeParse({ ...good, x: `${X}A` }).success).toBe(false);
    expect(PairOfferOrderSchema.safeParse({ ...good, extra: 1 }).success).toBe(false);
    expect(PairOfferOrderSchema.safeParse({ ...good, t: "pair.offer/v2" }).success).toBe(false);
  });

  it("a phone answers like a browser: its identifier is accepted in the request", () => {
    const request = {
      t: PAIR_MESSAGE_TYPES.request,
      account: ULID,
      browser: {
        device: "phone:AAAAAAAAAAAAAAAA",
        sig: { alg: "ed25519", key: KEY },
        enc: { alg: "x25519", key: KEY },
      },
      declared: { type: "iPhone", os: "iOS" },
    };
    expect(LinkRequestSchema.safeParse(request).success).toBe(true);
    // A phone does not say what product it serves, and a field it does not know is refused.
    expect(LinkRequestSchema.safeParse({ ...request, machine: MACHINE_PART }).success).toBe(false);
  });
});

const MACHINE_PART = {
  product: "01K6KXJ5G0ABCDEFGHJKMNPQRS",
  relay_device: "01K6KXJ5G0ABCDEFGHJKMNPQRT",
  attach_expires_at: 1_800_000_300,
  attach_sig: SIG,
};

describe("the short code of another machine", () => {
  const order = { t: "pair.offer/v1", kind: "machine", x: "R3T9HJ2P", w: "K7M4QX" };

  it("is an address of 8 symbols and a password of 6, from the alphabet without I, L, O and U", () => {
    expect(PairCodeOfferOrderSchema.safeParse(order).success).toBe(true);
    expect(PairOfferOrderSchema.safeParse(order).success).toBe(true);
    for (const bad of [
      { ...order, x: "R3T9HJ2" },
      { ...order, x: "R3T9HJ2PX" },
      { ...order, x: "R3T9HJ2I" },
      { ...order, w: "K7M4QU" },
      { ...order, w: "k7m4qx" },
      { ...order, w: "K7M4Q" },
      { ...order, extra: 1 },
      { t: order.t, kind: "machine", x: order.x },
    ]) {
      expect(PairOfferOrderSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("a machine's request says what product it serves and carries its attachment, and nobody else's does", () => {
    const request = {
      t: PAIR_MESSAGE_TYPES.request,
      account: ULID,
      browser: {
        device: "machine:AAAAAAAAAAAAAAAA",
        sig: { alg: "ed25519", key: KEY },
        enc: { alg: "x25519", key: KEY },
      },
      declared: { type: "Serveur", os: "Linux" },
      machine: MACHINE_PART,
    };
    expect(LinkRequestSchema.safeParse(request).success).toBe(true);
    const { machine: _machine, ...without } = request;
    expect(LinkRequestSchema.safeParse(without).success).toBe(false);
    expect(
      LinkRequestSchema.safeParse({ ...request, machine: { ...MACHINE_PART, extra: 1 } }).success,
    ).toBe(false);
    expect(
      LinkRequestSchema.safeParse({ ...request, machine: { ...MACHINE_PART, product: "x" } })
        .success,
    ).toBe(false);
  });

  it("the bridge's hello names its keys, the root, the account and its clock", () => {
    const hello = {
      t: PAIR_MESSAGE_TYPES.hello,
      root: { device: "human:AAAAAAAAAAAAAAAA", key: KEY },
      bridge: {
        device: "machine:AAAAAAAAAAAAAAAA",
        sig: { alg: "ed25519", key: KEY },
        enc: { alg: "x25519", key: KEY },
      },
      account: ULID,
      now: 1_800_000_000,
    };
    expect(PairHelloSchema.safeParse(hello).success).toBe(true);
    expect(PairHelloSchema.safeParse({ ...hello, now: 1.5 }).success).toBe(false);
    expect(PairHelloSchema.safeParse({ ...hello, secret: "x" }).success).toBe(false);
    expect(
      PairHelloSchema.safeParse({
        ...hello,
        bridge: { ...hello.bridge, device: "phone:AAAAAAAAAAAAAAAA" },
      }).success,
    ).toBe(false);
  });

  it("the password exchange travels in strict messages of fixed sizes", () => {
    const share = KEY;
    const nonce = `${"A".repeat(21)}A`;
    expect(PairWireSchema.safeParse({ k: "pake_init", nonce, share }).success).toBe(true);
    expect(PairWireSchema.safeParse({ k: "pake_init", nonce: "AA", share }).success).toBe(false);
    expect(PairWireSchema.safeParse({ k: "pake_reply", share }).success).toBe(true);
    expect(PairWireSchema.safeParse({ k: "pake_reply", share: "AA" }).success).toBe(false);
    expect(PairWireSchema.safeParse({ k: "pake_confirm", mac: KEY }).success).toBe(true);
    expect(PairWireSchema.safeParse({ k: "pake_confirm_b", mac: KEY, extra: 1 }).success).toBe(
      false,
    );
    expect(PairWireSchema.safeParse({ k: "hello", nonce: "n", ciphertext: "c" }).success).toBe(
      true,
    );
    expect(
      PairWireSchema.safeParse({ k: "refused", code: PAIR_ERROR_CODES.PAIRING_PRODUCT_UNKNOWN })
        .success,
    ).toBe(true);
  });

  it("the attachment of another machine names its voucher, an identifier of the relay", () => {
    const frame = {
      type: "rv_attach",
      declaration: {
        device_id: ULID,
        kind: "bridge",
        sig_key: KEY,
        enc_key: KEY,
        relay: "relay.example",
        account: ULID,
        expires_at: 99,
      },
      signature: SIG,
    };
    expect(RelayClientFrameSchema.safeParse(frame).success).toBe(true);
    expect(RelayClientFrameSchema.safeParse({ ...frame, voucher: ULID }).success).toBe(true);
    expect(RelayClientFrameSchema.safeParse({ ...frame, voucher: "not-an-id" }).success).toBe(
      false,
    );
  });
});
