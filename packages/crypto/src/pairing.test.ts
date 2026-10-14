import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  deriveBridgeEncryptionKey,
  deviceIdOf,
  encodePairLink,
  generateEd25519,
  openPairBox,
  type PairLink,
  pairLinkRootDevice,
  pairLinkUrl,
  parsePairLink,
  randomBytes,
  sealPairBox,
  toBase64url,
  toHex,
  utf8,
  x25519PublicKey,
} from "./index.js";
import { sealPairBoxWith } from "./testing.js";

const here = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(here, "../test-vectors/pairing-v1.json");
const bytes = (start: number, length: number) =>
  Uint8Array.from({ length }, (_, index) => (start + index) & 0xff);

function fixedLink(): PairLink {
  return {
    kind: "link",
    x: bytes(0x01, 16),
    s: bytes(0x21, 16),
    bridgeSigKey: bytes(0x41, 32),
    root: { kind: "machine", key: bytes(0x61, 32) },
  };
}

describe("the link `AP2:` holds the public data and s, nothing else", () => {
  it("encodes 99 bytes in 132 characters after the prefix, on one line of a terminal", () => {
    const text = encodePairLink(fixedLink());
    expect(text.startsWith("AP2:")).toBe(true);
    expect(text.length).toBe(4 + 132);
    const url = pairLinkUrl("https://app.agentplugged.ai/", fixedLink());
    expect(url.startsWith("https://app.agentplugged.ai/pair#AP2:")).toBe(true);
    expect(url.length).toBeLessThanOrEqual(200);
  });

  it("is decoded back from the fragment, from the URL or from the bare text", () => {
    const link = fixedLink();
    for (const text of [
      encodePairLink(link),
      `#${encodePairLink(link)}`,
      pairLinkUrl("https://app.example", link),
    ]) {
      const parsed = parsePairLink(text);
      expect(parsed?.kind).toBe("link");
      expect(toHex(parsed?.x ?? new Uint8Array())).toBe(toHex(link.x));
      expect(toHex(parsed?.s ?? new Uint8Array())).toBe(toHex(link.s));
      expect(toHex(parsed?.bridgeSigKey ?? new Uint8Array())).toBe(toHex(link.bridgeSigKey));
      expect(parsed?.root.kind).toBe("machine");
      expect(toHex(parsed?.root.key ?? new Uint8Array())).toBe(toHex(link.root.key));
    }
  });

  it("refuses a link of another version, kind, length or alphabet", () => {
    const good = encodePairLink(fixedLink());
    expect(parsePairLink(good)).toBeDefined();
    expect(parsePairLink(good.slice(0, -2))).toBeUndefined();
    expect(parsePairLink(`${good}A`)).toBeUndefined();
    expect(parsePairLink(good.replace("AP2:", "AP1:"))).toBeUndefined();
    expect(parsePairLink("AP2:!!!")).toBeUndefined();
    const raw = (patch: (b: Uint8Array) => void) => {
      const b = new Uint8Array(99);
      b.set([1, 1, 1]);
      patch(b);
      return `AP2:${toBase64url(b)}`;
    };
    expect(parsePairLink(raw(() => {}))).toBeDefined();
    expect(parsePairLink(raw((b) => (b[0] = 2)))).toBeUndefined();
    expect(parsePairLink(raw((b) => (b[1] = 9)))).toBeUndefined();
    expect(parsePairLink(raw((b) => (b[2] = 0)))).toBeUndefined();
  });

  it("names the root with the identifier its key gives", async () => {
    const key = await generateEd25519();
    const link: PairLink = { ...fixedLink(), root: { kind: "human", key: key.publicKey } };
    expect(pairLinkRootDevice(link)).toBe(deviceIdOf("human", key.publicKey));
  });
});

describe("the boxes opened with s", () => {
  const x = bytes(0x01, 16);
  const s = bytes(0x21, 16);
  const plaintext = utf8('{"hello":"browser"}');

  it("opens for who knows s and x, and for nobody else", async () => {
    const box = await sealPairBox({ s, x, direction: "up", type: "link.request/v1", plaintext });
    const open = (patch: Partial<Parameters<typeof openPairBox>[0]> = {}) =>
      openPairBox({ s, x, direction: "up", type: "link.request/v1", box, ...patch });
    expect(await open()).toEqual(plaintext);
    expect(await open({ s: randomBytes(16) })).toBeUndefined();
    expect(await open({ x: randomBytes(16) })).toBeUndefined();
    expect(await open({ direction: "down" })).toBeUndefined();
    expect(await open({ type: "link.resume/v1" })).toBeUndefined();
    const flipped = Buffer.from(box.ciphertext, "base64url");
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(
      await open({ box: { ...box, ciphertext: flipped.toString("base64url") } }),
    ).toBeUndefined();
    expect(await open({ box: { nonce: "x", ciphertext: "y" } })).toBeUndefined();
  });

  it("draws a new nonce for every box", async () => {
    const a = await sealPairBox({ s, x, direction: "up", type: "t", plaintext });
    const b = await sealPairBox({ s, x, direction: "up", type: "t", plaintext });
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });
});

describe("the bridge's encryption key", () => {
  it("comes from the machine's seed, the same every time, and differs from it", async () => {
    const seed = bytes(0x10, 32);
    const first = await deriveBridgeEncryptionKey(seed);
    const second = await deriveBridgeEncryptionKey(seed);
    expect(toHex(first.publicKey)).toBe(toHex(second.publicKey));
    expect(toHex(first.secretKey)).not.toBe(toHex(seed));
    expect(toHex(await x25519PublicKey(first.secretKey))).toBe(toHex(first.publicKey));
    const other = await deriveBridgeEncryptionKey(bytes(0x11, 32));
    expect(toHex(other.publicKey)).not.toBe(toHex(first.publicKey));
    await expect(deriveBridgeEncryptionKey(bytes(0, 31))).rejects.toThrow(TypeError);
  });
});

describe("vectors of the link and of the box (test-vectors/pairing-v1.json)", () => {
  it("reproduces the stored link and box byte for byte", async () => {
    const link = fixedLink();
    const nonce = bytes(0x80, 24);
    const box = await sealPairBoxWith(
      {
        s: link.s,
        x: link.x,
        direction: "up",
        type: "link.request/v1",
        plaintext: utf8('{"t":"link.request/v1"}'),
      },
      nonce,
    );
    const enc = await deriveBridgeEncryptionKey(bytes(0x10, 32));
    const file = {
      note: "Fixed test inputs, never used elsewhere. UPDATE_PAIRING_VECTORS=1 rewrites this file.",
      link: { text: encodePairLink(link), url: pairLinkUrl("https://app.example", link) },
      box,
      bridge_enc_public_key: toHex(enc.publicKey),
    };
    if (process.env.UPDATE_PAIRING_VECTORS === "1" || !existsSync(VECTORS)) {
      writeFileSync(VECTORS, `${JSON.stringify(file, null, 2)}\n`);
    }
    expect(JSON.parse(readFileSync(VECTORS, "utf8"))).toEqual(file);
    const opened = await openPairBox({
      s: link.s,
      x: link.x,
      direction: "up",
      type: "link.request/v1",
      box: file.box,
    });
    expect(opened).toEqual(utf8('{"t":"link.request/v1"}'));
  });
});
