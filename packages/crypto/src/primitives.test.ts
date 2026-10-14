import { describe, expect, it } from "vitest";
import {
  aeadDecrypt,
  aeadEncrypt,
  constantTimeEqual,
  deriveKey,
  deviceIdMatchesKey,
  deviceIdOf,
  fingerprint,
  generateEd25519,
  generateX25519,
  isPairedKind,
  newNonce,
  openSealed,
  sealToPublicKey,
  toBase64url,
  toHex,
  utf8,
  wipe,
  x25519,
} from "./index.js";

describe("identifiers of devices", () => {
  it("derives the identifier from the signing key and checks it against the whole key", async () => {
    const pair = await generateEd25519({ seed: Uint8Array.from({ length: 32 }, (_, i) => i) });
    const id = deviceIdOf("phone", pair.publicKey);
    expect(id).toMatch(/^phone:[A-Za-z0-9_-]{16}$/);
    expect(deviceIdMatchesKey(id, pair.publicKey)).toBe(true);
    // The kind is a label: the same key under two kinds is refused by the projection (a key
    // shared by two devices is invalid), not by this check.
    expect(deviceIdMatchesKey(id.replace("phone", "browser"), pair.publicKey)).toBe(true);
    expect(deviceIdMatchesKey(id.replace("phone", "tablet"), pair.publicKey)).toBe(false);
    const other = await generateEd25519();
    expect(deviceIdMatchesKey(id, other.publicKey)).toBe(false);
    expect(deviceIdMatchesKey("phone:short", pair.publicKey)).toBe(false);
    expect(deviceIdMatchesKey(id, pair.publicKey.slice(1))).toBe(false);
    expect(() => deviceIdOf("phone", new Uint8Array(31))).toThrow(TypeError);
    expect(isPairedKind("phone") && isPairedKind("machine") && isPairedKind("browser")).toBe(true);
    expect(isPairedKind("human")).toBe(false);
  });

  it("fingerprints public bytes", () => {
    expect(fingerprint(utf8("abc"))).toBe("ungWv48Bz-pBQUDe");
    expect(fingerprint(utf8("abc"), 8)).toBe("ungWv48B");
  });
});

describe("key derivation, comparison, wiping", () => {
  it("derives one subkey per context and per secret, and wipes buffers", async () => {
    const a = await deriveKey("apmsg001", utf8("secret one"));
    const b = await deriveKey("apmsg001", utf8("secret one"));
    expect(toHex(a)).toBe(toHex(b));
    expect(toHex(await deriveKey("apmsg002", utf8("secret one")))).not.toBe(toHex(a));
    expect(toHex(await deriveKey("apmsg001", utf8("secret two")))).not.toBe(toHex(a));
    await expect(deriveKey("short", utf8("x"))).rejects.toThrow(TypeError);
    await wipe(a, undefined);
    expect([...a].every((byte) => byte === 0)).toBe(true);
  });

  it("compares in constant time and refuses other lengths", async () => {
    expect(await constantTimeEqual(utf8("abc"), utf8("abc"))).toBe(true);
    expect(await constantTimeEqual(utf8("abc"), utf8("abd"))).toBe(false);
    expect(await constantTimeEqual(utf8("abc"), utf8("abcd"))).toBe(false);
  });
});

describe("X25519, sealed box, authenticated encryption", () => {
  it("agrees on one secret from both sides", async () => {
    const a = await generateX25519();
    const b = await generateX25519();
    const ab = await x25519(a.secretKey, b.publicKey);
    const ba = await x25519(b.secretKey, a.publicKey);
    expect(toBase64url(ab as Uint8Array)).toBe(toBase64url(ba as Uint8Array));
    await expect(x25519(a.secretKey, new Uint8Array(31))).rejects.toThrow(TypeError);
  });

  it("seals to a public key: only its holder opens", async () => {
    const recipient = await generateX25519();
    const stranger = await generateX25519();
    const sealed = await sealToPublicKey(utf8("secret canary"), recipient.publicKey);
    expect(new TextDecoder().decode(sealed)).not.toContain("secret canary");
    const opened = await openSealed(sealed, recipient.publicKey, recipient.secretKey);
    expect(new TextDecoder().decode(opened)).toBe("secret canary");
    expect(await openSealed(sealed, stranger.publicKey, stranger.secretKey)).toBeUndefined();
    expect(
      await openSealed(sealed.slice(0, 20), recipient.publicKey, recipient.secretKey),
    ).toBeUndefined();
  });

  it("encrypts with a data-bound tag", async () => {
    const key = (await generateX25519()).secretKey;
    const nonce = newNonce();
    const sealed = await aeadEncrypt(key, nonce, utf8("hello"), utf8("ad"));
    expect(await aeadDecrypt(key, nonce, sealed, utf8("ad"))).toEqual(utf8("hello"));
    expect(await aeadDecrypt(key, nonce, sealed, utf8("other"))).toBeUndefined();
    expect(await aeadDecrypt(key, newNonce(), sealed, utf8("ad"))).toBeUndefined();
    expect(await aeadDecrypt(key.slice(1), nonce, sealed, utf8("ad"))).toBeUndefined();
    expect(await aeadDecrypt(key, nonce, sealed.slice(0, 5), utf8("ad"))).toBeUndefined();
    await expect(aeadEncrypt(key, nonce.slice(1), utf8("x"), utf8(""))).rejects.toThrow(TypeError);
  });
});
