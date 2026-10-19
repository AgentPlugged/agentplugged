import { describe, expect, it } from "vitest";
import { openShare, sealShare, shareDecode, shareEncode } from "./share-box.js";

const CONTEXT = "agentplugged/share/v1";
const plain = new TextEncoder().encode('{"v":1,"hello":"monde"}');

describe("the seal of a shared page", () => {
  it("opens with its own key, nonce and context", async () => {
    const sealed = await sealShare(plain, CONTEXT);
    expect(sealed.key).toHaveLength(32);
    expect(sealed.nonce).toHaveLength(12);
    expect(sealed.ciphertext.length).toBe(plain.length + 16);
    expect(await openShare(sealed.key, sealed.nonce, sealed.ciphertext, CONTEXT)).toEqual(plain);
  });

  it("makes a new key every time, and never leaves the plain text in the bytes", async () => {
    const a = await sealShare(plain, CONTEXT);
    const b = await sealShare(plain, CONTEXT);
    expect(shareEncode(a.key)).not.toBe(shareEncode(b.key));
    expect(shareEncode(a.ciphertext)).not.toContain("hello");
    expect(Buffer.from(a.ciphertext).includes(Buffer.from("monde"))).toBe(false);
  });

  it("does not open with another key, another nonce, another context or a changed byte", async () => {
    const sealed = await sealShare(plain, CONTEXT);
    const other = await sealShare(plain, CONTEXT);
    expect(await openShare(other.key, sealed.nonce, sealed.ciphertext, CONTEXT)).toBeUndefined();
    expect(await openShare(sealed.key, other.nonce, sealed.ciphertext, CONTEXT)).toBeUndefined();
    expect(
      await openShare(sealed.key, sealed.nonce, sealed.ciphertext, "another/use"),
    ).toBeUndefined();
    const changed = sealed.ciphertext.slice();
    changed[0] = (changed[0] ?? 0) ^ 1;
    expect(await openShare(sealed.key, sealed.nonce, changed, CONTEXT)).toBeUndefined();
    expect(await openShare(sealed.key.slice(1), sealed.nonce, sealed.ciphertext, CONTEXT)).toBe(
      undefined,
    );
  });

  it("writes and reads base64url, canonical only", () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253]);
    expect(shareDecode(shareEncode(bytes))).toEqual(bytes);
    expect(shareEncode(new Uint8Array(32))).toHaveLength(43);
    expect(shareDecode("a")).toBeUndefined();
    expect(shareDecode("a+b/")).toBeUndefined();
    // A final character with stray bits is not the encoding of any byte string.
    expect(shareDecode("AB")).toBeUndefined();
  });
});
