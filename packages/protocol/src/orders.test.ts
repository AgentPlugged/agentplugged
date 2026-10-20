import { describe, expect, it } from "vitest";
import { z } from "zod";
import { eventTypeSpec } from "./event-types.js";
import {
  baseOrderTypes,
  externalOrderCode,
  ORDER_CHECK_SEQUENCE,
  ORDER_ERROR_CODES,
  ORDER_EVENT_TYPES,
  ORDER_RECEIPT_TAG,
  OrderAppliedPayloadSchema,
  OrderReceiptSchema,
  OrderSchema,
  OrderTypeRegistry,
  orderRejectionMessageKey,
  orderTag,
  PairOfferParamsSchema,
  parseOrderTag,
  RevokeDeviceParamsSchema,
  SetPrimaryParamsSchema,
  SetPriorityParamsSchema,
  SetSecretParamsSchema,
  secretReference,
} from "./orders.js";

const SIG = `${"A".repeat(85)}Q`;
const ULID = "01J9ZQ4V8E3M5N7P9R1S3T5V7X";
const BRIDGE = "machine:AAAAAAAAAAAAAAAA";
const HASH = `sha256:${"A".repeat(43)}`;

const order = {
  t: "order.pair.offer/v1",
  id: ULID,
  device: "phone:BBBBBBBBBBBBBBBB",
  bridge: BRIDGE,
  product: "01J9ZQ4V8E3M5N7P9R1S3T5V7Y",
  target: null,
  basis: null,
  seq: 1,
  issued_at: "2026-10-15T08:00:00.000Z",
  expires_at: "2026-10-15T08:10:00.000Z",
  params: {},
  alg: "ed25519",
  sig: SIG,
};

describe("the order schema", () => {
  it("accepts a well-formed order", () => {
    expect(OrderSchema.safeParse(order).success).toBe(true);
  });

  it.each([
    ["a missing field", { ...order, basis: undefined }],
    ["an extra field", { ...order, extra: 1 }],
    ["an algorithm other than ed25519", { ...order, alg: "none" }],
    ["no algorithm", { ...order, alg: undefined }],
    ["a bad order identifier", { ...order, id: "nope" }],
    ["a bridge that is not a machine", { ...order, bridge: "phone:AAAAAAAAAAAAAAAA" }],
    ["a sequence of zero", { ...order, seq: 0 }],
    ["a fractional sequence", { ...order, seq: 1.5 }],
    ["an expiry before the issue date", { ...order, expires_at: "2026-10-15T07:00:00.000Z" }],
    ["an expiry equal to the issue date", { ...order, expires_at: order.issued_at }],
    ["a label that is no order label", { ...order, t: "pair.offer/v1" }],
    ["an authorization label", { ...order, t: "device.paired.auth/v1" }],
    ["a basis that is no digest", { ...order, basis: "sha256:short" }],
    ["a signature of the wrong shape", { ...order, sig: "abc" }],
    ["params that are not an object", { ...order, params: [] }],
  ])("refuses %s", (_name, value) => {
    expect(OrderSchema.safeParse(value).success).toBe(false);
  });
});

describe("order labels", () => {
  it("names the type and the version", () => {
    expect(orderTag("device_add")).toBe("order.device_add/v1");
    expect(parseOrderTag("order.pair.offer/v1")).toEqual({ type: "pair.offer", version: 1 });
    expect(parseOrderTag("order.test.echo/v12")).toEqual({ type: "test.echo", version: 12 });
  });

  it.each(["pair.offer/v1", "order./v1", "order.Pair/v1", "order.x/v0", "order.x", "", 3])(
    "refuses %j",
    (value) => {
      expect(parseOrderTag(value)).toBeUndefined();
    },
  );
});

describe("the checks, in the order the bridge applies them", () => {
  it("lists every code of the catalogue, the first defect being the one returned", () => {
    expect(ORDER_CHECK_SEQUENCE).toEqual([
      "INVALID_ORDER",
      "UPGRADE_REQUIRED",
      "UNKNOWN_DEVICE",
      "SIGNATURE_INVALID",
      "SECURITY_ROOT_CHANGED",
      "DEVICE_REVOKED",
      "WRONG_BRIDGE",
      "ORDER_EXPIRED",
      "ORDER_REPLAYED",
      "NOT_OWNER",
      "STALE_BASIS",
      "ALREADY_RESOLVED",
    ]);
    expect(new Set(ORDER_CHECK_SEQUENCE).size).toBe(Object.keys(ORDER_ERROR_CODES).length);
  });

  it("never tells the emitting device that a device is unknown", () => {
    expect(externalOrderCode(ORDER_ERROR_CODES.UNKNOWN_DEVICE)).toBe("SIGNATURE_INVALID");
    expect(externalOrderCode(ORDER_ERROR_CODES.SIGNATURE_INVALID)).toBe("SIGNATURE_INVALID");
    expect(externalOrderCode(ORDER_ERROR_CODES.STALE_BASIS)).toBe("STALE_BASIS");
    expect(orderRejectionMessageKey("UNKNOWN_DEVICE")).toBe("orders.rejected.signature_invalid");
  });

  it("has neither a lock code nor a re-authentication code", () => {
    const codes = Object.values(ORDER_ERROR_CODES) as string[];
    expect(codes).not.toContain("DEVICE_LOCKED");
    expect(codes).not.toContain("REAUTH_REQUIRED");
    expect(codes).toContain("ALREADY_RESOLVED");
  });
});

describe("the receipt", () => {
  const receipt = {
    t: ORDER_RECEIPT_TAG,
    order: ULID,
    device: "phone:BBBBBBBBBBBBBBBB",
    bridge: BRIDGE,
    product: "01J9ZQ4V8E3M5N7P9R1S3T5V7Y",
    outcome: "applied",
    at: "2026-10-15T08:00:01.000Z",
    alg: "ed25519",
    sig: SIG,
  };

  it("is applied without a code, or rejected with one", () => {
    expect(OrderReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(
      OrderReceiptSchema.safeParse({ ...receipt, outcome: "rejected", code: "STALE_BASIS" })
        .success,
    ).toBe(true);
    expect(OrderReceiptSchema.safeParse({ ...receipt, outcome: "rejected" }).success).toBe(false);
    expect(OrderReceiptSchema.safeParse({ ...receipt, code: "STALE_BASIS" }).success).toBe(false);
  });

  it("carries a reference to what an applied order made, and a rejected one never does", () => {
    expect(
      OrderReceiptSchema.safeParse({ ...receipt, reference: "secret:forge.github" }).success,
    ).toBe(true);
    expect(
      OrderReceiptSchema.safeParse({
        ...receipt,
        outcome: "rejected",
        code: "STALE_BASIS",
        reference: "secret:forge.github",
      }).success,
    ).toBe(false);
    expect(OrderReceiptSchema.safeParse({ ...receipt, reference: "" }).success).toBe(false);
  });

  it("cannot carry the internal code that would tell a device is unknown", () => {
    expect(
      OrderReceiptSchema.safeParse({ ...receipt, outcome: "rejected", code: "UNKNOWN_DEVICE" })
        .success,
    ).toBe(false);
  });
});

describe("the record of an applied order", () => {
  it("is a registered event type at version 1 that keeps the signed order", () => {
    expect(eventTypeSpec(ORDER_EVENT_TYPES.applied)?.version).toBe(1);
    const payload = {
      order,
      device: order.device,
      source: "mobile",
      applied_at: "2026-10-15T08:00:02.000Z",
    };
    expect(OrderAppliedPayloadSchema.safeParse(payload).success).toBe(true);
    expect(OrderAppliedPayloadSchema.safeParse({ ...payload, source: "presence" }).success).toBe(
      false,
    );
    expect(OrderAppliedPayloadSchema.safeParse({ ...payload, extra: 1 }).success).toBe(false);
  });
});

describe("declaring an order type", () => {
  it("is declaring its parameters, its target and its risk, nothing else", () => {
    const registry = baseOrderTypes();
    expect(registry.tags()).toEqual([
      "order.bridge.set_primary/v1",
      "order.chain.instruct/v1",
      "order.chain.pause/v1",
      "order.chain.resume/v1",
      "order.chain.say/v1",
      "order.chain.start/v1",
      "order.chain.stop/v1",
      "order.device.revoke/v1",
      "order.forge.link/v1",
      "order.forge.unlink/v1",
      "order.machine.set_role/v1",
      "order.noah.say/v1",
      "order.noah.wake/v1",
      "order.pair.offer/v1",
      "order.portfolio.set_priority/v1",
      "order.product.answer_checkpoint/v1",
      "order.product.autonomy_hint/v1",
      "order.product.create/v1",
      "order.product.open_folder/v1",
      "order.product.rotate_key/v1",
      "order.product.set_autonomy/v1",
      "order.product.set_profile/v1",
      "order.product.set_rule/v1",
      "order.product.set_state/v1",
      "order.product.undo_checkpoint_answer/v1",
      "order.product.update_engine/v1",
      "order.secret.set/v1",
      "order.team.pause/v1",
      "order.team.resume/v1",
      "order.team.stop/v1",
    ]);
    const extended = registry.extended({
      type: "checkpoint.decide",
      version: 1,
      params: z.strictObject({ decision: z.string() }),
      risk: "high",
      target: "story",
      exclusive: true,
    });
    expect(extended.get("order.checkpoint.decide/v1")?.risk).toBe("high");
    // The registry the engine started from is not changed by a copy.
    expect(registry.get("order.checkpoint.decide/v1")).toBeUndefined();
  });

  it("refuses a type declared twice or named badly", () => {
    const registry = new OrderTypeRegistry();
    const declaration = {
      type: "a.b",
      version: 1,
      params: z.object({}),
      risk: "low" as const,
      target: "primary" as const,
    };
    registry.declare(declaration);
    expect(() => registry.declare(declaration)).toThrow(RangeError);
    expect(() => registry.declare({ ...declaration, type: "A.b" })).toThrow(RangeError);
  });
});

describe("the parameters of the engine's own orders", () => {
  it("pair.offer: a link carries the device's signature of the offer, a short code a password", () => {
    const link = {
      kind: "phone",
      x: "AAAAAAAAAAAAAAAAAAAAAA",
      s: "AAAAAAAAAAAAAAAAAAAAAA",
      expires_at: "2026-10-15T09:00:00.000Z",
      offer_sig: SIG,
    };
    expect(PairOfferParamsSchema.safeParse(link).success).toBe(true);
    expect(PairOfferParamsSchema.safeParse({ ...link, offer_sig: undefined }).success).toBe(false);
    const code = {
      kind: "machine",
      x: "ABCD1234",
      w: "XYZ789",
      expires_at: "2026-10-15T09:00:00.000Z",
      offer_sig: SIG,
    };
    expect(PairOfferParamsSchema.safeParse(code).success).toBe(true);
    expect(PairOfferParamsSchema.safeParse({ ...code, w: "xyz789" }).success).toBe(false);
    expect(PairOfferParamsSchema.safeParse({ ...code, offer_sig: undefined }).success).toBe(false);
  });

  it("secret.set: a name under forge or data and a sealed box, nothing else, kept sealed once applied", () => {
    const sealed = "A".repeat(120);
    expect(SetSecretParamsSchema.safeParse({ name: "forge.github", sealed }).success).toBe(true);
    expect(SetSecretParamsSchema.safeParse({ name: "data.crm-2", sealed }).success).toBe(true);
    for (const name of ["claude-code", "forge.", "ai.claude", "forge.../x", "FORGE.x", "forge.A"]) {
      expect(SetSecretParamsSchema.safeParse({ name, sealed }).success).toBe(false);
    }
    expect(
      SetSecretParamsSchema.safeParse({ name: "forge.x", sealed: "no spaces allowed" }).success,
    ).toBe(false);
    expect(
      SetSecretParamsSchema.safeParse({ name: "forge.x", sealed, value: "in the clear" }).success,
    ).toBe(false);
    expect(secretReference("forge.github")).toBe("secret:forge.github");
    expect(baseOrderTypes().get("order.secret.set/v1")?.sealedParams).toEqual(["sealed"]);
  });

  it("portfolio.set_priority: a rank from 1 to 9999 for at most 64 products, nothing else", () => {
    const product = "01J8ZQ6R5YF3K9TH2W7M4NXV8B";
    expect(SetPriorityParamsSchema.safeParse({ ranks: { [product]: 1 } }).success).toBe(true);
    expect(SetPriorityParamsSchema.safeParse({ ranks: {} }).success).toBe(true);
    for (const rank of [0, 10_000, 1.5, -1, "1"]) {
      expect(SetPriorityParamsSchema.safeParse({ ranks: { [product]: rank } }).success).toBe(false);
    }
    expect(SetPriorityParamsSchema.safeParse({ ranks: { "not-a-product": 1 } }).success).toBe(
      false,
    );
    expect(SetPriorityParamsSchema.safeParse({ ranks: {}, extra: 1 }).success).toBe(false);
    const ids = Array.from({ length: 65 }, (_, i) => `01J8ZQ6R5YF3K9TH2W7M4NX${String(100 + i)}`);
    const many = Object.fromEntries(ids.map((id) => [id.slice(0, 26).padEnd(26, "0"), 1]));
    expect(SetPriorityParamsSchema.safeParse({ ranks: many }).success).toBe(false);
    const declared = baseOrderTypes().get("order.portfolio.set_priority/v1");
    expect(declared?.risk).toBe("low");
    expect(declared?.target).toBe("bridge");
  });

  it("bridge.set_primary: the head of each writer, by bridge", () => {
    expect(SetPrimaryParamsSchema.safeParse({ heads: { [BRIDGE]: HASH } }).success).toBe(true);
    expect(
      SetPrimaryParamsSchema.safeParse({ heads: { "phone:AAAAAAAAAAAAAAAA": HASH } }).success,
    ).toBe(false);
    expect(SetPrimaryParamsSchema.safeParse({ heads: { [BRIDGE]: "x" } }).success).toBe(false);
  });
});

describe("the parameters of the order that removes a device", () => {
  const sig = SIG;
  const head = `sha256:${"A".repeat(43)}`;
  const base = {
    device: "browser:ABCDEFGHIJKLMNOP",
    issued_at: "2026-10-16T08:00:00.000Z",
    authorizations: { "*": { chain_head: null, sig } },
  };

  it("takes a signature for any product, and one per product with its chain head", () => {
    expect(RevokeDeviceParamsSchema.safeParse(base).success).toBe(true);
    const product = "01J9ZQ4V8E3M5N7P9R1S3T5V7X";
    expect(
      RevokeDeviceParamsSchema.safeParse({
        ...base,
        device: "machine:ABCDEFGHIJKLMNOP",
        authorizations: { ...base.authorizations, [product]: { chain_head: head, sig } },
      }).success,
    ).toBe(true);
  });

  it("refuses a removal without the signature for any product, or that gives it a head", () => {
    expect(RevokeDeviceParamsSchema.safeParse({ ...base, authorizations: {} }).success).toBe(false);
    expect(
      RevokeDeviceParamsSchema.safeParse({
        ...base,
        authorizations: { "*": { chain_head: head, sig } },
      }).success,
    ).toBe(false);
  });

  it("refuses the root key of a creator, a key that is no product, and anything more", () => {
    expect(
      RevokeDeviceParamsSchema.safeParse({ ...base, device: "human:ABCDEFGHIJKLMNOP" }).success,
    ).toBe(false);
    expect(
      RevokeDeviceParamsSchema.safeParse({
        ...base,
        authorizations: { ...base.authorizations, nope: { chain_head: null, sig } },
      }).success,
    ).toBe(false);
    expect(RevokeDeviceParamsSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
});
