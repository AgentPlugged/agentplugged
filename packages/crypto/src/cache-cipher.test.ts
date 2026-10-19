import { describe, expect, it } from "vitest";
import {
  browserCacheKeyIsUnreadable,
  createAeadCacheCipher,
  createBrowserCacheCipher,
  createBrowserCacheKey,
} from "./cache-cipher.js";
import { utf8 } from "./encoding.js";
import { randomBytes } from "./hash.js";

const plain = utf8("canary-value-9f3a");

describe("the AEAD cache cipher (phone)", () => {
  it("opens what it sealed, only in the same slot, and never shows the plaintext", async () => {
    const cipher = createAeadCacheCipher(randomBytes(32));
    const sealed = await cipher.seal(plain, "projection:p1");
    expect(Buffer.from(sealed).includes(Buffer.from(plain))).toBe(false);
    expect(await cipher.open(sealed, "projection:p1")).toEqual(plain);
    expect(await cipher.open(sealed, "projection:p2")).toBeUndefined();
    const other = createAeadCacheCipher(randomBytes(32));
    expect(await other.open(sealed, "projection:p1")).toBeUndefined();
  });

  it("rejects a flipped byte and a truncated value", async () => {
    const cipher = createAeadCacheCipher(randomBytes(32));
    const sealed = await cipher.seal(plain, "q");
    const flipped = sealed.slice();
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
    expect(await cipher.open(flipped, "q")).toBeUndefined();
    expect(await cipher.open(sealed.slice(0, 10), "q")).toBeUndefined();
  });

  it("refuses a key of the wrong size", () => {
    expect(() => createAeadCacheCipher(randomBytes(16))).toThrow();
  });
});

describe("the browser cache cipher", () => {
  it("uses a key nothing can export, and opens only in the same slot", async () => {
    const key = await createBrowserCacheKey();
    expect(await browserCacheKeyIsUnreadable(key)).toBe(true);
    const cipher = createBrowserCacheCipher(key);
    const sealed = await cipher.seal(plain, "projection:p1");
    expect(Buffer.from(sealed).includes(Buffer.from(plain))).toBe(false);
    expect(await cipher.open(sealed, "projection:p1")).toEqual(plain);
    expect(await cipher.open(sealed, "queue")).toBeUndefined();
    const flipped = sealed.slice();
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
    expect(await cipher.open(flipped, "projection:p1")).toBeUndefined();
    expect(await cipher.open(sealed.slice(0, 5), "projection:p1")).toBeUndefined();
  });

  it("does not open with another key", async () => {
    const a = createBrowserCacheCipher(await createBrowserCacheKey());
    const b = createBrowserCacheCipher(await createBrowserCacheKey());
    expect(await b.open(await a.seal(plain, "x"), "x")).toBeUndefined();
  });
});
