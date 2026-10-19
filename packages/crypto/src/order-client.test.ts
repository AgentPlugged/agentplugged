import {
  deviceRevokedRecord,
  ORDER_RECEIPT_MESSAGE_TYPE,
  ORDER_RECEIPT_TAG,
  RevokeDeviceParamsSchema,
  TRUST_SIGNATURE_TAGS,
} from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  createOrder,
  deviceIdOf,
  encryptPeerMessage,
  generateEd25519,
  generateX25519,
  OrderLedger,
  type OrderSigner,
  pairOfferParams,
  pinnedBridge,
  randomBytes,
  revokeDeviceParams,
  sealOrder,
  signBytesEd25519,
  signOrderReceipt,
  toBase64url,
  verifyOrderSignature,
  verifyTrustRecord,
} from "./index.js";

const PRODUCT = "01J9ZQ4V8E3M5N7P9R1S3T5V7Y";
const NOW = Date.parse("2026-10-15T08:00:00.000Z");

async function world() {
  const device = await generateEd25519();
  const deviceEnc = await generateX25519();
  const bridge = await generateEd25519();
  const bridgeEnc = await generateX25519();
  const signer: OrderSigner = {
    device: deviceIdOf("phone", device.publicKey),
    sign: (bytes) => signBytesEd25519(bytes, device.secretKey),
  };
  const pinned = {
    device: deviceIdOf("machine", bridge.publicKey),
    sigKey: bridge.publicKey,
    encKey: bridgeEnc.publicKey,
  };
  let counter = 0;
  const order = await createOrder(
    { type: "test.echo", bridge: pinned.device, product: PRODUCT, params: { text: "hi" } },
    signer,
    { next: async () => ++counter },
    { now: NOW, lifetimeMs: 600_000 },
    () => "01J9ZQ4V8E3M5N7P9R1S3T5V7X",
  );
  async function receiptFrom(
    key: typeof bridge,
    outcome: "applied" | "rejected",
    over: Partial<{ device: string; order: string; bridge: string }> = {},
  ) {
    const receipt = await signOrderReceipt(
      {
        t: ORDER_RECEIPT_TAG,
        order: over.order ?? order.id,
        device: over.device ?? signer.device,
        bridge: over.bridge ?? pinned.device,
        product: PRODUCT,
        outcome,
        ...(outcome === "rejected" ? { code: "STALE_BASIS" } : {}),
        at: new Date(NOW + 1000).toISOString(),
        alg: "ed25519",
      },
      key.secretKey,
    );
    return await encryptPeerMessage({
      to: "device-route",
      from: "bridge-route",
      id: "01J9ZQ4V8E3M5N7P9R1S3T5V7Z",
      sender: deviceIdOf("machine", key.publicKey),
      senderSecretKey: key.secretKey,
      recipientEncKey: deviceEnc.publicKey,
      seq: 1,
      type: ORDER_RECEIPT_MESSAGE_TYPE,
      body: receipt,
    });
  }
  const ledger = new OrderLedger({ device: signer.device, bridge: pinned, confirmationMs: 5_000 });
  ledger.given(order, NOW);
  return { signer, pinned, order, ledger, deviceEnc, bridge, receiptFrom };
}

describe("an order built by a device", () => {
  it("carries the device's counter and signature, and expires when it says", async () => {
    const { order, signer } = await world();
    expect(order).toMatchObject({
      t: "order.test.echo/v1",
      device: signer.device,
      seq: 1,
      target: null,
      basis: null,
      alg: "ed25519",
      issued_at: "2026-10-15T08:00:00.000Z",
      expires_at: "2026-10-15T08:10:00.000Z",
    });
    expect(order.sig).toHaveLength(86);
  });

  it("is sealed for the key the device pinned, never for one the relay advertises", async () => {
    const { signer, order, pinned } = await world();
    const transport = {
      bridge: pinned,
      bridgeRoute: "bridge-route",
      deviceRoute: "device-route",
      messageId: "01J9ZQ4V8E3M5N7P9R1S3T5V7Z",
      messageSeq: 1,
    };
    expect(await sealOrder(order, signer, transport)).toBeDefined();
    expect(
      await sealOrder(order, signer, { ...transport, advertisedEncKey: pinned.encKey }),
    ).toBeDefined();
    expect(
      await sealOrder(order, signer, { ...transport, advertisedEncKey: randomBytes(32) }),
    ).toBeUndefined();
  });

  it("signs a pair offer apart from the order, with its own label", async () => {
    const { signer, pinned } = await world();
    const x = randomBytes(16);
    const params = await pairOfferParams(
      {
        kind: "phone",
        bridge: pinned.device,
        x,
        s: randomBytes(16),
        expiresAt: new Date(NOW + 60_000),
      },
      signer,
    );
    expect(params).toMatchObject({ kind: "phone", x: toBase64url(x) });
    expect(params.offer_sig).toHaveLength(86);
  });

  it("is verified by the key of the device that signed, and by no other", async () => {
    const { order } = await world();
    const stranger = await generateEd25519();
    expect(await verifyOrderSignature(order, stranger.publicKey)).toBe(false);
  });
});

describe("who signs a message", () => {
  it("is the sender's key or its signer, one of the two", async () => {
    const sender = await generateEd25519();
    const recipient = await generateX25519();
    const base = {
      to: "a",
      from: "b",
      id: "c",
      sender: deviceIdOf("phone", sender.publicKey),
      recipientEncKey: recipient.publicKey,
      seq: 1,
      type: "order",
      body: {},
    };
    await expect(encryptPeerMessage(base)).rejects.toThrow(TypeError);
    await expect(
      encryptPeerMessage({
        ...base,
        senderSecretKey: sender.secretKey,
        senderSigner: (bytes) => signBytesEd25519(bytes, sender.secretKey),
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      encryptPeerMessage({
        ...base,
        senderSigner: (bytes) => signBytesEd25519(bytes, sender.secretKey),
      }),
    ).resolves.toMatchObject({ to: "a", from: "b", id: "c" });
  });
});

describe("what a device knows of the orders it gave", () => {
  it("takes the bridge's signed receipt, and the first one wins", async () => {
    const { ledger, deviceEnc, bridge, order, receiptFrom } = await world();
    const applied = await ledger.receive(await receiptFrom(bridge, "applied"), {
      secretKey: deviceEnc.secretKey,
    });
    expect(applied?.outcome).toBe("applied");
    // A later, contrary receipt (a relay that delivers one then another) changes nothing.
    const later = await ledger.receive(await receiptFrom(bridge, "rejected"), {
      secretKey: deviceEnc.secretKey,
    });
    expect(later).toBeUndefined();
    expect(ledger.status(order.id)?.state).toBe("applied");
  });

  it("ignores a receipt signed by another key than the bridge's it pinned", async () => {
    const { ledger, deviceEnc, order, receiptFrom } = await world();
    const impostor = await generateEd25519();
    const forged = await receiptFrom(impostor, "applied");
    expect(await ledger.receive(forged, { secretKey: deviceEnc.secretKey })).toBeUndefined();
    expect(ledger.status(order.id)?.state).toBe("waiting");
  });

  it("ignores a receipt meant for another device, or for another bridge, or naming another order", async () => {
    const { ledger, deviceEnc, bridge, order, receiptFrom } = await world();
    for (const over of [
      { device: "phone:ZZZZZZZZZZZZZZZZ" },
      { bridge: "machine:ZZZZZZZZZZZZZZZZ" },
      { order: "01J9ZQ4V8E3M5N7P9R1S3T5V7W" },
    ]) {
      expect(
        await ledger.receive(await receiptFrom(bridge, "applied", over), {
          secretKey: deviceEnc.secretKey,
        }),
      ).toBeUndefined();
    }
    expect(ledger.status(order.id)?.state).toBe("waiting");
  });

  it("calls an order not confirmed after the delay, never sent, and takes a receipt that comes late", async () => {
    const { ledger, deviceEnc, bridge, order, receiptFrom } = await world();
    expect(ledger.expire(NOW + 4_999)).toEqual([]);
    expect(ledger.expire(NOW + 5_000)).toEqual([order.id]);
    expect(ledger.status(order.id)?.state).toBe("unconfirmed");
    const late = await ledger.receive(await receiptFrom(bridge, "applied"), {
      secretKey: deviceEnc.secretKey,
    });
    expect(late?.outcome).toBe("applied");
    expect(ledger.status(order.id)?.state).toBe("applied");
  });

  it("reads a bridge's pinned keys from their text, and nothing when they are malformed", async () => {
    const { pinned } = await world();
    expect(
      pinnedBridge({
        device: pinned.device,
        sigKey: toBase64url(pinned.sigKey),
        encKey: toBase64url(pinned.encKey),
      }),
    ).toEqual(pinned);
    expect(pinnedBridge({ device: pinned.device, sigKey: "x", encKey: "y" })).toBeUndefined();
  });
});

describe("the parameters of an order that removes a device", () => {
  const TARGET = "machine:TARGETTARGETTARG";
  const OTHER_PRODUCT = "01J9ZQ4V8E3M5N7P9R1S3T5V7Z";
  const HEAD = `sha256:${"A".repeat(43)}`;

  it("holds the author's signature of the removal for any product, and one per product with the chain head seen there", async () => {
    const key = await generateEd25519();
    const signer: OrderSigner = {
      device: deviceIdOf("browser", key.publicKey),
      sign: (bytes) => signBytesEd25519(bytes, key.secretKey),
    };
    const issuedAt = new Date(NOW);
    const params = await revokeDeviceParams(
      { device: TARGET, heads: { [PRODUCT]: HEAD }, issuedAt },
      signer,
    );
    expect(RevokeDeviceParamsSchema.safeParse(params).success).toBe(true);
    expect(Object.keys(params.authorizations).sort()).toEqual(["*", PRODUCT].sort());
    for (const [product, authorization] of Object.entries(params.authorizations)) {
      const record = deviceRevokedRecord({
        device: TARGET,
        chain_head: product === "*" ? null : HEAD,
        issued_at: issuedAt.toISOString(),
        author: signer.device,
      });
      expect(
        await verifyTrustRecord(
          record,
          TRUST_SIGNATURE_TAGS.deviceRevoked,
          authorization.sig,
          key.publicKey,
        ),
      ).toBe(true);
    }
    // A signature for one head is no signature for another, nor for another author.
    const wrongHead = deviceRevokedRecord({
      device: TARGET,
      chain_head: null,
      issued_at: issuedAt.toISOString(),
      author: signer.device,
    });
    expect(
      await verifyTrustRecord(
        wrongHead,
        TRUST_SIGNATURE_TAGS.deviceRevoked,
        params.authorizations[PRODUCT]?.sig ?? "",
        key.publicKey,
      ),
    ).toBe(false);
    expect(params.authorizations[OTHER_PRODUCT]).toBeUndefined();
  });

  it("has no per-product head for a phone or a browser", async () => {
    const key = await generateEd25519();
    const signer: OrderSigner = {
      device: deviceIdOf("phone", key.publicKey),
      sign: (bytes) => signBytesEd25519(bytes, key.secretKey),
    };
    const params = await revokeDeviceParams(
      { device: "browser:TARGETTARGETTARG", issuedAt: new Date(NOW) },
      signer,
    );
    expect(Object.keys(params.authorizations)).toEqual(["*"]);
    expect(params.authorizations["*"]?.chain_head).toBeNull();
  });
});
