import { describe, expect, it } from "vitest";
import {
  BASE_ORDER_TYPES,
  EVENT_TYPE_REGISTRY,
  MAX_KEY_BOXES,
  ORDER_TYPE_ROTATE_PRODUCT_KEY,
  PAIR_MESSAGE_TYPES,
  PRODUCT_KEY_EVENT_TYPES,
  ProductKeyRotatedPayloadSchema,
  ProductKeysSchema,
  RotateProductKeyParamsSchema,
} from "./index.js";

const PROOF = "A".repeat(43);

describe("product key: renewal", () => {
  const box = "A".repeat(110);
  const valid = {
    key_id: "pk:AbCd-_0123456789",
    previous_key_id: "pk:ZyXw-_9876543210",
    proof: PROOF,
    chain_proof: PROOF,
    boxes: { "machine:AbCd-_0123456789": box },
  };

  it("registers product.key_rotated with its two key ids, its proofs and one box per machine", () => {
    expect(EVENT_TYPE_REGISTRY[PRODUCT_KEY_EVENT_TYPES.keyRotated]?.version).toBe(1);
    expect(ProductKeyRotatedPayloadSchema.safeParse(valid).success).toBe(true);
    expect(
      ProductKeyRotatedPayloadSchema.safeParse({ ...valid, order: "01K6KXJ5G0PR0DVCT00000000B" })
        .success,
    ).toBe(true);
    for (const broken of [
      { ...valid, chain_proof: undefined },
      { ...valid, previous_key_id: "pk:short" },
      { ...valid, boxes: { "browser:AbCd-_0123456789": box } },
      { ...valid, boxes: { "machine:AbCd-_0123456789": "short" } },
      { ...valid, key: PROOF },
      { ...valid, order: "not an order" },
    ]) {
      expect(ProductKeyRotatedPayloadSchema.safeParse(broken).success).toBe(false);
    }
    const many = Object.fromEntries(
      Array.from({ length: MAX_KEY_BOXES + 1 }, (_, index) => [
        `machine:${String(index).padStart(16, "A")}`,
        box,
      ]),
    );
    expect(ProductKeyRotatedPayloadSchema.safeParse({ ...valid, boxes: many }).success).toBe(false);
  });

  it("asks for the renewal by an order that carries nothing", () => {
    expect(RotateProductKeyParamsSchema.safeParse({}).success).toBe(true);
    expect(RotateProductKeyParamsSchema.safeParse({ key: PROOF }).success).toBe(false);
    const declaration = BASE_ORDER_TYPES.find(
      (type) => type.type === ORDER_TYPE_ROTATE_PRODUCT_KEY,
    );
    expect(declaration).toMatchObject({ risk: "high", target: "bridge" });
  });

  it("gives a view the keys of before the renewals beside the current one", () => {
    const keys = {
      t: PAIR_MESSAGE_TYPES.productKeys,
      product: "01K6KXJ5G0PR0DVCT00000000A",
      key_id: "pk:AbCd-_0123456789",
      key: PROOF,
    };
    expect(ProductKeysSchema.safeParse(keys).success).toBe(true);
    const older = [{ key_id: "pk:ZyXw-_9876543210", key: PROOF }];
    expect(ProductKeysSchema.safeParse({ ...keys, older }).success).toBe(true);
    expect(ProductKeysSchema.safeParse({ ...keys, older: [{ key_id: "x" }] }).success).toBe(false);
  });
});
