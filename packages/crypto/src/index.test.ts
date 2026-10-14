import { describe, expect, it } from "vitest";
import { packageName, sha256Hex } from "./index.js";

describe("crypto", () => {
  it("exposes its package name", () => {
    expect(packageName).toBe("@agentplugged/crypto");
  });
});

describe("sha256Hex", () => {
  it("hashes text as UTF-8", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("é")).toBe(sha256Hex(new Uint8Array([0xc3, 0xa9])));
  });

  it("hashes bytes", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(sha256Hex("abc"));
  });
});
