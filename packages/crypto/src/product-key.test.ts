import type { EventEnvelope, UnsignedEventEnvelope } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { fromBase64url, sha256, toBase64url, utf8 } from "./index.js";
import {
  decryptFile,
  decryptPayload,
  encryptedFileKeyId,
  encryptFile,
  encryptPayload,
  exportedKeyInfo,
  exportProductKey,
  generateProductKey,
  importProductKey,
  productKeyId,
  productKeyProof,
  verifyProductKeyProof,
  wipeBytes,
} from "./product-key.js";
import { exportProductKeyWith } from "./testing.js";

const KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const OTHER = Uint8Array.from({ length: 32 }, (_, index) => 200 - index);
const PRODUCT = "01K6KXJ5G0PR0DVCT00000000A";
const FILE = { productId: PRODUCT, path: ".agentplugged/memory/lessons.md" };

function envelope(fields: Partial<UnsignedEventEnvelope> = {}): UnsignedEventEnvelope {
  return {
    v: 1,
    id: "01K6KXJ5G0ED25519ENC0PAY02",
    type: "cost.reported",
    at: "2026-10-03T08:00:00.000Z",
    actor: { kind: "agent", device: "machine:AAAAAAAAAAAAAAAA", agent: "iris" },
    product: PRODUCT,
    story: "2-13",
    provenance: "untrusted",
    prev: null,
    alg: "ed25519",
    ...fields,
  } as UnsignedEventEnvelope;
}

/** The envelope as written: `payload_enc` in place of `payload`, and a signature. */
async function encrypted(
  payload: Record<string, unknown>,
  key = KEY,
  fields: Partial<UnsignedEventEnvelope> = {},
): Promise<EventEnvelope> {
  const env = envelope(fields);
  return { ...env, payload_enc: await encryptPayload(env, payload, key), sig: "x" };
}

describe("product key", () => {
  it("is 32 random bytes, named by a subkey, never by a hash of the key itself", async () => {
    const key = generateProductKey();
    expect(key).toHaveLength(32);
    expect(generateProductKey()).not.toEqual(key);
    const id = await productKeyId(KEY);
    expect(id).toMatch(/^pk:[A-Za-z0-9_-]{16}$/);
    expect(id).not.toBe(`pk:${toBase64url(sha256(KEY)).slice(0, 16)}`);
    expect(await productKeyId(OTHER)).not.toBe(id);
  });

  it("proves its announcement for one product, checked by a holder of the key only", async () => {
    const proof = await productKeyProof(KEY, PRODUCT);
    expect(await verifyProductKeyProof(KEY, PRODUCT, proof)).toBe(true);
    expect(await verifyProductKeyProof(OTHER, PRODUCT, proof)).toBe(false);
    expect(await verifyProductKeyProof(KEY, "01JZ0000000000000000000000", proof)).toBe(false);
    expect(await verifyProductKeyProof(KEY, PRODUCT, "AAAA")).toBe(false);
  });

  it("wipes buffers", async () => {
    const buffer = Uint8Array.of(1, 2, 3);
    await wipeBytes(buffer, undefined);
    expect([...buffer]).toEqual([0, 0, 0]);
  });
});

describe("encryptPayload / decryptPayload", () => {
  it("round-trips a payload, with a random nonce each time", async () => {
    const payload = { usd: 1.25, estimated: false };
    const event = await encrypted(payload);
    expect(event.payload_enc).toMatchObject({
      alg: "xchacha20poly1305",
      key_id: await productKeyId(KEY),
    });
    expect(fromBase64url(event.payload_enc?.nonce ?? "")).toHaveLength(24);
    expect(JSON.stringify(event)).not.toContain("1.25");
    expect(await decryptPayload(event, KEY)).toEqual({ ok: true, payload });
    const again = await encrypted(payload);
    expect(again.payload_enc?.nonce).not.toBe(event.payload_enc?.nonce);
  });

  it("is unreadable with another key, and says when the algorithm is unknown", async () => {
    const event = await encrypted({ usd: 2, estimated: true });
    expect(await decryptPayload(event, OTHER)).toEqual({ ok: false, reason: "other_key" });
    const unknown = {
      ...event,
      payload_enc: {
        ...(event.payload_enc as NonNullable<EventEnvelope["payload_enc"]>),
        alg: "aes256gcm",
      },
    };
    expect(await decryptPayload(unknown, KEY)).toEqual({ ok: false, reason: "unsupported_alg" });
  });

  it("fails on an altered ciphertext", async () => {
    const event = await encrypted({ usd: 2, estimated: true });
    const ct = fromBase64url(event.payload_enc?.ct ?? "") as Uint8Array;
    ct[0] = (ct[0] ?? 0) ^ 1;
    const altered = {
      ...event,
      payload_enc: {
        ...(event.payload_enc as NonNullable<EventEnvelope["payload_enc"]>),
        ct: toBase64url(ct),
      },
    };
    expect(await decryptPayload(altered, KEY)).toEqual({ ok: false, reason: "failed" });
  });

  it("binds the content to its envelope: type, writer, chain", async () => {
    const event = await encrypted({ usd: 2, estimated: true });
    for (const fields of [
      { type: "agent.status_reported" },
      { actor: { kind: "agent" as const, device: "machine:AAAAAAAAAAAAAAAA", agent: "stella" } },
      { story: "2-14" },
      { at: "2026-10-03T08:00:01.000Z" },
    ]) {
      expect(await decryptPayload({ ...event, ...fields }, KEY)).toEqual({
        ok: false,
        reason: "failed",
      });
    }
    expect((await decryptPayload({ ...event, sig: "y" }, KEY)).ok).toBe(true);
  });
});

describe("encryptFile / decryptFile", () => {
  it("writes a header, then the content encrypted, bound to the product and the path", async () => {
    const content = "# Leçons\nNe jamais pousser le vendredi.\n";
    const text = await encryptFile(content, FILE, KEY);
    expect(text.split("\n")[0]).toBe(`agentplugged-enc:1:${await productKeyId(KEY)}`);
    expect(text).not.toContain("vendredi");
    expect(encryptedFileKeyId(text)).toBe(await productKeyId(KEY));
    expect(await decryptFile(text, FILE, KEY)).toEqual({ ok: true, content });
    expect(await decryptFile(text.replaceAll("\n", "\r\n"), FILE, KEY)).toMatchObject({ ok: true });
    expect(
      await decryptFile(text, { ...FILE, path: ".agentplugged/salle/lessons.md" }, KEY),
    ).toEqual({ ok: false, reason: "failed" });
    expect(
      await decryptFile(text, { ...FILE, productId: "01JZ0000000000000000000000" }, KEY),
    ).toEqual({ ok: false, reason: "failed" });
    expect(await decryptFile(text, FILE, OTHER)).toEqual({ ok: false, reason: "other_key" });
    expect(await decryptFile("en clair", FILE, KEY)).toEqual({
      ok: false,
      reason: "not_encrypted",
    });
  });

  it("binds the path in NFC", async () => {
    const decomposed = { ...FILE, path: ".agentplugged/memory/léger.md" };
    const composed = { ...FILE, path: ".agentplugged/memory/léger.md" };
    const text = await encryptFile("x", decomposed, KEY);
    expect(await decryptFile(text, composed, KEY)).toEqual({ ok: true, content: "x" });
  });
});

describe("exportProductKey / importProductKey", () => {
  it("round-trips under the passphrase, and names the key_id and the product", async () => {
    const text = await exportProductKey(KEY, PRODUCT, "une phrase assez longue", {
      limits: "min",
    });
    expect(text.startsWith("apk1:")).toBe(true);
    expect(text).not.toContain(toBase64url(KEY));
    expect(exportedKeyInfo(text)).toEqual({ keyId: await productKeyId(KEY), productId: PRODUCT });
    const imported = await importProductKey(`  ${text}\n`, "une phrase assez longue", {
      limits: "min",
    });
    expect(imported).toEqual({
      ok: true,
      key: KEY,
      keyId: await productKeyId(KEY),
      productId: PRODUCT,
    });
  });

  it("refuses a wrong passphrase, an altered export and a text that is no export", async () => {
    const options = { limits: "min" as const };
    const text = await exportProductKey(KEY, PRODUCT, "une phrase assez longue", options);
    expect(await importProductKey(text, "une autre phrase longue", options)).toEqual({
      ok: false,
      reason: "passphrase",
    });
    const bytes = fromBase64url(text.slice(5)) as Uint8Array;
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    expect(
      await importProductKey(`apk1:${toBase64url(bytes)}`, "une phrase assez longue", options),
    ).toEqual({ ok: false, reason: "passphrase" });
    // The product id is bound: changing it in the header breaks the decryption.
    const swapped = text.replace(
      toBase64url(utf8(PRODUCT)).slice(0, 8),
      toBase64url(utf8("01JZ0000000000000000000000")).slice(0, 8),
    );
    if (swapped !== text) {
      expect((await importProductKey(swapped, "une phrase assez longue", options)).ok).toBe(false);
    }
    for (const notExport of ["apk1:AAAA", "pas une clé"]) {
      expect(await importProductKey(notExport, "une phrase assez longue", options)).toEqual({
        ok: false,
        reason: "format",
      });
      expect(exportedKeyInfo(notExport)).toBeUndefined();
    }
  });

  it("accepts only the limits expected: an export above them is refused (format)", async () => {
    const minimal = await exportProductKey(KEY, PRODUCT, "une phrase assez longue", {
      limits: "min",
    });
    const bytes = fromBase64url(minimal.slice(5)) as Uint8Array;
    // Operations raised to 2^31: never derived, refused before.
    bytes.set([0x80, 0, 0, 0], 1);
    expect(
      await importProductKey(`apk1:${toBase64url(bytes)}`, "une phrase assez longue", {
        limits: "min",
      }),
    ).toEqual({ ok: false, reason: "format" });
  });

  it("uses the moderate Argon2id limits by default", async () => {
    const text = await exportProductKeyWith(KEY, PRODUCT, "une phrase assez longue", {
      salt: new Uint8Array(16).fill(1),
      nonce: new Uint8Array(24).fill(2),
    });
    const bytes = fromBase64url(text.slice(5)) as Uint8Array;
    // Version 1, then OPSLIMIT_MODERATE (3) and MEMLIMIT_MODERATE (256 MiB), big-endian.
    expect([...bytes.subarray(0, 9)]).toEqual([1, 0, 0, 0, 3, 0x10, 0, 0, 0]);
    expect((await importProductKey(text, "une phrase assez longue")).ok).toBe(true);
  }, 60_000);
});
