import { ORDER_RECEIPT_TAG, type UnsignedOrder } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  generateEd25519,
  orderSigningBytes,
  signOrder,
  signOrderReceipt,
  signTrustRecord,
  verifyOrderReceipt,
  verifyOrderSignature,
  verifyTrustRecord,
} from "./index.js";

const unsigned: UnsignedOrder = {
  t: "order.test.echo/v1",
  id: "01J9ZQ4V8E3M5N7P9R1S3T5V7X",
  device: "phone:BBBBBBBBBBBBBBBB",
  bridge: "machine:AAAAAAAAAAAAAAAA",
  product: "01J9ZQ4V8E3M5N7P9R1S3T5V7Y",
  target: null,
  basis: null,
  seq: 1,
  issued_at: "2026-10-15T08:00:00.000Z",
  expires_at: "2026-10-15T08:10:00.000Z",
  params: { a: 1, b: [2, 3] },
  alg: "ed25519",
};

describe("signing an order", () => {
  it("signs the canonical form of the order without its signature, whatever the key order", async () => {
    const pair = await generateEd25519();
    const order = await signOrder(unsigned, pair.secretKey);
    expect(await verifyOrderSignature(order, pair.publicKey)).toBe(true);
    const reordered = Object.fromEntries(Object.entries(order).reverse()) as typeof order;
    expect(await verifyOrderSignature(reordered, pair.publicKey)).toBe(true);
  });

  it.each([
    ["the bridge", { bridge: "machine:CCCCCCCCCCCCCCCC" }],
    ["the product", { product: "01J9ZQ4V8E3M5N7P9R1S3T5V7Z" }],
    ["the sequence", { seq: 2 }],
    ["the expiry", { expires_at: "2026-10-16T08:10:00.000Z" }],
    ["the parameters", { params: { a: 2, b: [2, 3] } }],
    ["the basis", { basis: `sha256:${"A".repeat(43)}` }],
    ["the type", { t: "order.test.other/v1" }],
  ])("a change to %s breaks the signature", async (_name, change) => {
    const pair = await generateEd25519();
    const order = await signOrder(unsigned, pair.secretKey);
    expect(await verifyOrderSignature({ ...order, ...change }, pair.publicKey)).toBe(false);
  });

  it("is not the signature of another key", async () => {
    const pair = await generateEd25519();
    const other = await generateEd25519();
    const order = await signOrder(unsigned, pair.secretKey);
    expect(await verifyOrderSignature(order, other.publicKey)).toBe(false);
  });

  it("is never taken for an authorization, and an authorization never for an order", async () => {
    const pair = await generateEd25519();
    const order = await signOrder(unsigned, pair.secretKey);
    const { sig: _sig, ...bare } = order;
    expect(await verifyTrustRecord(bare, "device.paired.auth/v1", order.sig, pair.publicKey)).toBe(
      false,
    );
    const authorization = { t: "device.paired.auth/v1", device: "phone:BBBBBBBBBBBBBBBB" };
    const sig = await signTrustRecord(authorization, "device.paired.auth/v1", pair.secretKey);
    const asOrder = { ...unsigned, ...authorization, sig };
    expect(await verifyOrderSignature(asOrder as never, pair.publicKey)).toBe(false);
  });

  it("refuses to sign what is not an order label, or an algorithm other than ed25519", async () => {
    const pair = await generateEd25519();
    expect(() => orderSigningBytes({ ...unsigned, t: "pair.offer/v1" })).toThrow(TypeError);
    expect(() => orderSigningBytes({ ...unsigned, alg: "none" as never })).toThrow(TypeError);
    await expect(signOrder({ ...unsigned, t: "msg.inner/v1" }, pair.secretKey)).rejects.toThrow();
  });

  it("verifies to false, never throws, on a garbled signature", async () => {
    const pair = await generateEd25519();
    const order = await signOrder(unsigned, pair.secretKey);
    expect(await verifyOrderSignature({ ...order, sig: "!!" }, pair.publicKey)).toBe(false);
    expect(await verifyOrderSignature({ ...order, alg: "none" as never }, pair.publicKey)).toBe(
      false,
    );
  });
});

describe("signing a receipt", () => {
  const receipt = {
    t: ORDER_RECEIPT_TAG as typeof ORDER_RECEIPT_TAG,
    order: unsigned.id,
    device: unsigned.device,
    bridge: unsigned.bridge,
    product: unsigned.product,
    outcome: "applied" as const,
    at: "2026-10-15T08:00:01.000Z",
    alg: "ed25519" as const,
  };

  it("is the bridge's, and breaks when anything is changed", async () => {
    const pair = await generateEd25519();
    const signed = await signOrderReceipt(receipt, pair.secretKey);
    expect(await verifyOrderReceipt(signed, pair.publicKey)).toBe(true);
    expect(
      await verifyOrderReceipt({ ...signed, outcome: "rejected", code: "X" }, pair.publicKey),
    ).toBe(false);
    expect(
      await verifyOrderReceipt({ ...signed, order: "01J9ZQ4V8E3M5N7P9R1S3T5V7Z" }, pair.publicKey),
    ).toBe(false);
  });
});
