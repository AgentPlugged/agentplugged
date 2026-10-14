import { describe, expect, it } from "vitest";
import { commonMemoryKey, decryptFile, encryptFile, productKeyId } from "./product-key.js";

const SECRET = Uint8Array.from({ length: 64 }, (_, index) => index + 1);
const OTHER = Uint8Array.from({ length: 64 }, (_, index) => 200 - index);
const BINDING = { productId: "common-memory", path: ".agentplugged/memory/C-7M2K9QX4TB.json" };

describe("commonMemoryKey", () => {
  it("is 32 bytes, deterministic, and never the seed nor the product key's subkeys", async () => {
    const a = await commonMemoryKey(SECRET);
    expect(a).toHaveLength(32);
    expect(await commonMemoryKey(SECRET)).toEqual(a);
    expect(a).not.toEqual(SECRET.slice(0, 32));
    expect(await commonMemoryKey(OTHER)).not.toEqual(a);
    // Another machine key, another key id.
    expect(await productKeyId(await commonMemoryKey(OTHER))).not.toBe(await productKeyId(a));
  });

  it("encrypts files that only the same machine key opens, and only at their path", async () => {
    const key = await commonMemoryKey(SECRET);
    const sealed = await encryptFile('{"id":"C-1"}', BINDING, key);
    expect(sealed).not.toContain("C-1");
    expect(await decryptFile(sealed, BINDING, key)).toMatchObject({ ok: true });
    const other = await decryptFile(sealed, BINDING, await commonMemoryKey(OTHER));
    expect(other.ok).toBe(false);
    const moved = await decryptFile(sealed, { ...BINDING, path: "elsewhere.json" }, key);
    expect(moved.ok).toBe(false);
  });

  it("refuses a machine key shorter than a seed", async () => {
    await expect(commonMemoryKey(new Uint8Array(8))).rejects.toThrow(TypeError);
  });
});
