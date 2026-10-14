import { readFileSync } from "node:fs";
import type { EncryptedPayload, UnsignedEventEnvelope } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  buildProductKeyVectors,
  PRODUCT_KEY_VECTORS_FILE,
} from "../scripts/generate-product-key-vectors.mjs";
import { VECTORS_FILE } from "../scripts/generate-vectors.mjs";
import {
  decryptFile,
  decryptPayload,
  encryptFile,
  encryptPayload,
  fileAssociatedData,
  importProductKey,
  payloadAssociatedData,
  productKeyId,
  toHex,
  verifyProductKeyProof,
} from "./index.js";

type Vectors = {
  key: { hex: string; key_id: string; product_id: string; proof: string };
  payload: {
    envelope: UnsignedEventEnvelope;
    payload: Record<string, unknown>;
    associated_data_hex: string;
    payload_enc: EncryptedPayload;
  };
  file: {
    productId: string;
    path: string;
    content: string;
    associated_data_hex: string;
    text: string;
  };
  export: { passphrase: string; limits: "min"; text: string };
};

const text = readFileSync(PRODUCT_KEY_VECTORS_FILE, "utf8");
const vectors = JSON.parse(text) as Vectors;
const key = Uint8Array.from(vectors.key.hex.match(/../g) ?? [], (pair) =>
  Number.parseInt(pair, 16),
);

describe("shared test vectors (test-vectors/product-key-v1.json)", () => {
  it("names the key by its key_id, and verifies the announcement's proof", async () => {
    expect(await productKeyId(key)).toBe(vectors.key.key_id);
    expect(await verifyProductKeyProof(key, vectors.key.product_id, vectors.key.proof)).toBe(true);
    expect(await verifyProductKeyProof(key, "01JZ0000000000000000000000", vectors.key.proof)).toBe(
      false,
    );
  });

  it("decrypts the payload, bound to its envelope", async () => {
    const { envelope, payload, associated_data_hex, payload_enc } = vectors.payload;
    expect(toHex(payloadAssociatedData(envelope))).toBe(associated_data_hex);
    expect(await decryptPayload({ ...envelope, payload_enc, sig: "" }, key)).toEqual({
      ok: true,
      payload,
    });
    const again = await encryptPayload(envelope, payload, key);
    expect(again.ct).not.toBe(payload_enc.ct);
  });

  it("decrypts the file at its product and path", async () => {
    const { productId, path, content, associated_data_hex, text: sealed } = vectors.file;
    expect(toHex(fileAssociatedData({ productId, path }))).toBe(associated_data_hex);
    expect(await decryptFile(sealed, { productId, path }, key)).toEqual({ ok: true, content });
    expect(await encryptFile(content, { productId, path }, key)).not.toBe(sealed);
  });

  it("imports the export with its passphrase, at the limits it was made with only", async () => {
    const imported = await importProductKey(vectors.export.text, vectors.export.passphrase, {
      limits: "min",
    });
    expect(imported.ok && toHex(imported.key)).toBe(vectors.key.hex);
    expect(imported.ok && imported.productId).toBe(vectors.key.product_id);
    // A real import expects the moderate limits: a test export is refused.
    expect(await importProductKey(vectors.export.text, vectors.export.passphrase)).toEqual({
      ok: false,
      reason: "format",
    });
  });

  it("uses a nonce of its own in every vector", () => {
    const envelopeVectors = readFileSync(VECTORS_FILE, "utf8");
    const nonces = [
      vectors.payload.payload_enc.nonce,
      vectors.file.text.split("\n")[1]?.slice(0, 32),
      // One encrypted event there (shown twice: alone, then with a payload in the invalid case).
      ...new Set([...envelopeVectors.matchAll(/"nonce": "([^"]+)"/g)].map((match) => match[1])),
    ];
    expect(new Set(nonces).size).toBe(nonces.length);
  });

  it("is what the generator writes", async () => {
    expect(await buildProductKeyVectors()).toBe(text);
  });
});
