import { SECRET_VALUE_MAX_CHARS } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { fromBase64url, utf8 } from "./encoding.js";
import { generateX25519 } from "./primitives.js";
import { openSecret, SecretNotSealed, sealSecret } from "./secret-box.js";

const VALUE = "ghp_canary_0123456789abcdefghijklmnopqrstuvwxyz";

describe("a secret sealed for one machine", () => {
  it("opens with that machine's keys and with no other", async () => {
    const machine = await generateX25519();
    const stranger = await generateX25519();
    const sealed = await sealSecret({ name: "forge.github", value: VALUE }, machine.publicKey);
    expect(await openSecret(sealed, "forge.github", machine)).toBe(VALUE);
    expect(await openSecret(sealed, "forge.github", stranger)).toBeUndefined();
  });

  it("holds the value nowhere in the clear, and differs at every sealing", async () => {
    const machine = await generateX25519();
    const first = await sealSecret({ name: "forge.github", value: VALUE }, machine.publicKey);
    const second = await sealSecret({ name: "forge.github", value: VALUE }, machine.publicKey);
    expect(first).not.toBe(second);
    const bytes = fromBase64url(first) ?? new Uint8Array();
    expect(Buffer.from(bytes).includes(Buffer.from(utf8(VALUE)))).toBe(false);
    expect(first).not.toContain(VALUE);
  });

  it("does not pass for another name", async () => {
    const machine = await generateX25519();
    const sealed = await sealSecret({ name: "forge.github", value: VALUE }, machine.publicKey);
    expect(await openSecret(sealed, "forge.gitlab", machine)).toBeUndefined();
  });

  it("is not sealed for a key the relay advertises in place of the machine's", async () => {
    const machine = await generateX25519();
    const relay = await generateX25519();
    await expect(
      sealSecret({ name: "forge.github", value: VALUE }, machine.publicKey, relay.publicKey),
    ).rejects.toMatchObject({ reason: "key" });
    // The same key advertised is fine.
    await expect(
      sealSecret({ name: "forge.github", value: VALUE }, machine.publicKey, machine.publicKey),
    ).resolves.toBeTypeOf("string");
  });

  it("refuses a name outside forge.* and data.*, an empty value and one that is too long", async () => {
    const machine = await generateX25519();
    for (const name of ["claude-code", "forge.", "Forge.x", "forge.../x", "ai.tool"]) {
      await expect(sealSecret({ name, value: VALUE }, machine.publicKey)).rejects.toBeInstanceOf(
        SecretNotSealed,
      );
    }
    await expect(
      sealSecret({ name: "forge.x", value: "" }, machine.publicKey),
    ).rejects.toMatchObject({ reason: "value" });
    await expect(
      sealSecret(
        { name: "forge.x", value: "a".repeat(SECRET_VALUE_MAX_CHARS + 1) },
        machine.publicKey,
      ),
    ).rejects.toMatchObject({ reason: "value" });
    await expect(
      sealSecret({ name: "forge.x", value: "a".repeat(SECRET_VALUE_MAX_CHARS) }, machine.publicKey),
    ).resolves.toBeTypeOf("string");
  });

  it("seals a multi-line JSON file of several kilobytes, and refuses more than 64 KiB of UTF-8", async () => {
    const machine = await generateX25519();
    const json = JSON.stringify(
      { private_key: "-----BEGIN-----\n".concat("é".repeat(1500)) },
      null,
      2,
    );
    const sealed = await sealSecret({ name: "data.gcp", value: json }, machine.publicKey);
    expect(await openSecret(sealed, "data.gcp", machine)).toBe(json);
    // 40,000 two-byte characters are under the character limit and over the byte limit.
    await expect(
      sealSecret({ name: "data.gcp", value: "é".repeat(40_000) }, machine.publicKey),
    ).rejects.toMatchObject({ reason: "value" });
  });

  it("is refused when altered, truncated or not base64url", async () => {
    const machine = await generateX25519();
    const sealed = await sealSecret({ name: "forge.github", value: VALUE }, machine.publicKey);
    const bytes = fromBase64url(sealed) ?? new Uint8Array();
    const altered = Uint8Array.from(bytes);
    altered[altered.length - 1] = (altered[altered.length - 1] ?? 0) ^ 1;
    const { toBase64url } = await import("./encoding.js");
    expect(await openSecret(toBase64url(altered), "forge.github", machine)).toBeUndefined();
    expect(await openSecret(sealed.slice(0, 40), "forge.github", machine)).toBeUndefined();
    expect(await openSecret("not base64url!", "forge.github", machine)).toBeUndefined();
  });
});
