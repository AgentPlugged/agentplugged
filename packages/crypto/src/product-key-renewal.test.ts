import { describe, expect, it } from "vitest";
import { fromBase64url, toBase64url } from "./encoding.js";
import { generateX25519 } from "./primitives.js";
import {
  exportedKeysInfo,
  exportProductKeys,
  generateProductKey,
  importProductKeys,
  openProductKeyBox,
  productKeyId,
  productKeyRotationProof,
  sealProductKeyFor,
  verifyProductKeyRotationProof,
} from "./product-key.js";

const PRODUCT = "01K6KXJ5G0PR0DVCT00000000A";
const PASSPHRASE = "une phrase de passe solide";

describe("the new key sealed for a machine", () => {
  it("only the machine it was sealed for opens it, and only for its product", async () => {
    const key = generateProductKey();
    const machine = await generateX25519();
    const other = await generateX25519();
    const box = await sealProductKeyFor(key, PRODUCT, machine.publicKey);
    expect(await openProductKeyBox(box, PRODUCT, machine)).toEqual(key);
    expect(await openProductKeyBox(box, PRODUCT, other)).toBeUndefined();
    expect(await openProductKeyBox(box, "01K6KXJ5G0PR0DVCT00000000B", machine)).toBeUndefined();
    // Nothing in the box is the key in clear.
    expect(box).not.toContain(toBase64url(key));
  });

  it("refuses a box that was altered or is not text of that format", async () => {
    const key = generateProductKey();
    const machine = await generateX25519();
    const bytes = fromBase64url(
      await sealProductKeyFor(key, PRODUCT, machine.publicKey),
    ) as Uint8Array;
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    expect(await openProductKeyBox(toBase64url(bytes), PRODUCT, machine)).toBeUndefined();
    expect(await openProductKeyBox("***", PRODUCT, machine)).toBeUndefined();
  });
});

describe("the proof that a renewal follows a held key", () => {
  it("is made for one renewal and checked by a holder of the previous key only", async () => {
    const previous = generateProductKey();
    const proof = await productKeyRotationProof(previous, PRODUCT, "pk:AAAAAAAAAAAAAAAA");
    expect(
      await verifyProductKeyRotationProof(previous, PRODUCT, "pk:AAAAAAAAAAAAAAAA", proof),
    ).toBe(true);
    expect(
      await verifyProductKeyRotationProof(previous, PRODUCT, "pk:BBBBBBBBBBBBBBBB", proof),
    ).toBe(false);
    expect(
      await verifyProductKeyRotationProof(
        generateProductKey(),
        PRODUCT,
        "pk:AAAAAAAAAAAAAAAA",
        proof,
      ),
    ).toBe(false);
    expect(await verifyProductKeyRotationProof(previous, PRODUCT, "pk:AAAAAAAAAAAAAAAA", "x")).toBe(
      false,
    );
  });
});

describe("the export of several keys", () => {
  it("holds all the keys, the current one first, and gives them back", async () => {
    const keys = [generateProductKey(), generateProductKey(), generateProductKey()];
    const text = await exportProductKeys(keys, PRODUCT, PASSPHRASE, { limits: "min" });
    expect(text.startsWith("apk2:")).toBe(true);
    const ids = await Promise.all(keys.map(productKeyId));
    expect(exportedKeysInfo(text)).toEqual({ keyIds: ids, productId: PRODUCT });
    const imported = await importProductKeys(text, PASSPHRASE, { limits: "min" });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.keys.map((entry) => entry.keyId)).toEqual(ids);
    expect(imported.keys.map((entry) => entry.key)).toEqual(keys);
    expect(imported.productId).toBe(PRODUCT);
  });

  it("stays the old format for one key, and the new reader reads it", async () => {
    const key = generateProductKey();
    const text = await exportProductKeys([key], PRODUCT, PASSPHRASE, { limits: "min" });
    expect(text.startsWith("apk1:")).toBe(true);
    const imported = await importProductKeys(text, PASSPHRASE, { limits: "min" });
    expect(imported).toMatchObject({ ok: true, productId: PRODUCT });
    expect(exportedKeysInfo(text)?.keyIds).toEqual([await productKeyId(key)]);
  });

  it("refuses a wrong passphrase, an altered export and other limits", async () => {
    const keys = [generateProductKey(), generateProductKey()];
    const text = await exportProductKeys(keys, PRODUCT, PASSPHRASE, { limits: "min" });
    expect(await importProductKeys(text, "une autre phrase de passe", { limits: "min" })).toEqual({
      ok: false,
      reason: "passphrase",
    });
    const bytes = fromBase64url(text.slice(5)) as Uint8Array;
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    expect(
      await importProductKeys(`apk2:${toBase64url(bytes)}`, PASSPHRASE, { limits: "min" }),
    ).toEqual({ ok: false, reason: "passphrase" });
    expect(await importProductKeys(text, PASSPHRASE)).toEqual({ ok: false, reason: "format" });
    expect(await importProductKeys("apk2:abc", PASSPHRASE, { limits: "min" })).toEqual({
      ok: false,
      reason: "format",
    });
    expect(exportedKeysInfo("apk2:abc")).toBeUndefined();
  });
});
