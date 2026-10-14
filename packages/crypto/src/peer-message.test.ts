import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  aeadDecrypt,
  aeadEncrypt,
  concatBytes,
  deriveKey,
  deviceIdOf,
  encryptPeerMessage,
  fromBase64url,
  generateEd25519,
  generateX25519,
  lengthPrefixed,
  newNonce,
  openPeerMessage,
  type PeerEnvelope,
  type PeerSender,
  SequenceWindow,
  sha256,
  toBase64url,
  toHex,
  utf8,
  x25519,
  x25519PublicKey,
} from "./index.js";
import { encryptPeerMessageWith } from "./testing.js";

const here = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(here, "../test-vectors/peer-message-v1.json");

const bytes = (start: number, length: number) =>
  Uint8Array.from({ length }, (_, index) => (start + index) & 0xff);

async function party() {
  const sig = await generateEd25519();
  const enc = await generateX25519();
  const id = deviceIdOf("phone", sig.publicKey);
  return { sig, enc, id };
}

async function world() {
  const phone = await party();
  const bridge = await party();
  const registry = (sender: string): PeerSender | undefined =>
    sender === phone.id
      ? { signingKey: phone.sig.publicKey, routingId: "01J0ROUTINGPHONE0000000000" }
      : undefined;
  const send = (overrides: Partial<Parameters<typeof encryptPeerMessage>[0]> = {}) =>
    encryptPeerMessage({
      to: "01J0ROUTINGBRIDGE0000000000",
      from: "01J0ROUTINGPHONE0000000000",
      id: "01J0MESSAGE000000000000000",
      sender: phone.id,
      senderSecretKey: phone.sig.secretKey,
      recipientEncKey: bridge.enc.publicKey,
      seq: 1,
      type: "order",
      body: { approve: "G-0000000001", note: "ok" },
      ...overrides,
    });
  const open = (envelope: PeerEnvelope, secret = bridge.enc.secretKey) =>
    openPeerMessage(envelope, { recipientSecretKey: secret, registry });
  return { phone, bridge, send, open, registry };
}

describe("a message from one device to another", () => {
  it("opens for the recipient, and tells who sent it from inside", async () => {
    const { send, open, phone } = await world();
    const result = await open(await send());
    expect(result).toEqual({
      ok: true,
      sender: phone.id,
      seq: 1,
      type: "order",
      body: { approve: "G-0000000001", note: "ok" },
    });
  });

  it("is encrypted: neither the body nor the sender appears in the envelope", async () => {
    const { send, phone } = await world();
    const envelope = await send({ body: { secret_canary: "CANARY-6-24-body" } });
    const text = JSON.stringify(envelope);
    expect(text).not.toContain("CANARY-6-24-body");
    expect(text).not.toContain(phone.id);
    expect(Object.keys(envelope).sort()).toEqual(["ciphertext", "from", "id", "nonce", "to", "v"]);
    // 24-byte random nonce, a different ephemeral key and nonce each time.
    expect(fromBase64url(envelope.nonce)?.length).toBe(24);
    const again = await send({ body: { secret_canary: "CANARY-6-24-body" } });
    expect(again.ciphertext).not.toBe(envelope.ciphertext);
    expect(again.nonce).not.toBe(envelope.nonce);
  });

  it("refuses an altered byte anywhere in the ciphertext or the nonce", async () => {
    const { send, open } = await world();
    const envelope = await send();
    const packed = fromBase64url(envelope.ciphertext) as Uint8Array;
    // The ephemeral key, the body, the tag.
    for (const index of [0, 31, 32, packed.length >> 1, packed.length - 1]) {
      const altered = packed.slice();
      altered[index] = (altered[index] ?? 0) ^ 0x01;
      const result = await open({ ...envelope, ciphertext: toBase64url(altered) });
      expect(result.ok, `byte ${index}`).toBe(false);
    }
    const nonce = fromBase64url(envelope.nonce) as Uint8Array;
    nonce[0] = (nonce[0] ?? 0) ^ 1;
    expect((await open({ ...envelope, nonce: toBase64url(nonce) })).ok).toBe(false);
  });

  it("refuses a relay that readdresses or relabels it (to, from, id, version)", async () => {
    const { send, open } = await world();
    const envelope = await send();
    for (const patch of [
      { to: "01J0ROUTINGOTHER00000000000" },
      { from: "01J0ROUTINGOTHER00000000000" },
      { id: "01J0MESSAGE000000000000001" },
      { v: 2 },
    ]) {
      const result = await open({ ...envelope, ...patch });
      expect(result.ok, JSON.stringify(patch)).toBe(false);
    }
  });

  it("is for one recipient only", async () => {
    const { send, open } = await world();
    const stranger = await generateX25519();
    const result = await open(await send(), stranger.secretKey);
    expect(result).toEqual({ ok: false, reason: "decrypt_failed" });
  });

  it("refuses a malformed envelope", async () => {
    const { send, open } = await world();
    const envelope = await send();
    for (const bad of [
      { ...envelope, nonce: "AAAA" },
      { ...envelope, ciphertext: "AAAA" },
      { ...envelope, ciphertext: "not base64url!" },
      { ...envelope, nonce: 12 as unknown as string },
    ]) {
      expect((await open(bad)).ok).toBe(false);
    }
  });
});

describe("the sender is authenticated by the registry, not by from", () => {
  it("rejects a sender the registry does not know (option spoof-from of the spy relay)", async () => {
    const { send, open } = await world();
    const stranger = await party();
    const result = await open(
      await send({ sender: stranger.id, senderSecretKey: stranger.sig.secretKey }),
    );
    expect(result).toEqual({ ok: false, reason: "unknown_sender" });
  });

  it("rejects a trusted device that writes another device's routing label as from", async () => {
    const { phone, bridge, send } = await world();
    const other = await party();
    // The registry knows both, each with its own routing label: the second one forges `from`.
    const registry = (sender: string): PeerSender | undefined =>
      sender === phone.id
        ? { signingKey: phone.sig.publicKey, routingId: "01J0ROUTINGPHONE0000000000" }
        : sender === other.id
          ? { signingKey: other.sig.publicKey, routingId: "01J0ROUTINGOTHER00000000000" }
          : undefined;
    const forged = await send({ sender: other.id, senderSecretKey: other.sig.secretKey });
    const result = await openPeerMessage(forged, {
      recipientSecretKey: bridge.enc.secretKey,
      registry,
    });
    expect(result).toEqual({ ok: false, reason: "sender_mismatch" });
  });

  it("rejects a name inside that is not signed by that sender's key", async () => {
    const { phone, send, open } = await world();
    const thief = await party();
    // Names the trusted phone inside, signs with its own key.
    const result = await open(
      await send({ sender: phone.id, senderSecretKey: thief.sig.secretKey }),
    );
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("does not believe a registry that gives a key that is not the sender's own", async () => {
    const { phone, bridge, send } = await world();
    const thief = await party();
    const result = await openPeerMessage(
      await send({ sender: phone.id, senderSecretKey: thief.sig.secretKey }),
      {
        recipientSecretKey: bridge.enc.secretKey,
        registry: () => ({
          signingKey: thief.sig.publicKey,
          routingId: "01J0ROUTINGPHONE0000000000",
        }),
      },
    );
    expect(result).toEqual({ ok: false, reason: "unknown_sender" });
  });

  it("binds the signature to the recipient and to the id: a recipient cannot forward it as the sender's", async () => {
    const { phone, bridge, send, registry } = await world();
    const third = await party();
    const original = await send({ to: "01J0ROUTINGBRIDGE0000000000", id: "m1" });
    // The recipient opens the content, and wraps the very same content for a third device.
    const packed = fromBase64url(original.ciphertext) as Uint8Array;
    const ad = (to: string, from: string, id: string, recipient: Uint8Array, eph: Uint8Array) =>
      concatBytes(
        utf8("agentplugged/msg/v1"),
        Uint8Array.of(1),
        lengthPrefixed(utf8(to)),
        lengthPrefixed(utf8(from)),
        lengthPrefixed(utf8(id)),
        sha256(recipient),
        eph,
      );
    const fields = (to: string, from: string, id: string) =>
      concatBytes(lengthPrefixed(utf8(to)), lengthPrefixed(utf8(from)), lengthPrefixed(utf8(id)));
    const shared = (await x25519(bridge.enc.secretKey, packed.slice(0, 32))) as Uint8Array;
    const key = await deriveKey(
      "apmsg001",
      concatBytes(shared, fields(original.to, original.from, original.id)),
    );
    const content = (await aeadDecrypt(
      key,
      fromBase64url(original.nonce) as Uint8Array,
      packed.slice(32),
      ad(original.to, original.from, original.id, bridge.enc.publicKey, packed.slice(0, 32)),
    )) as Uint8Array;
    const eph = await generateX25519();
    const to = "01J0ROUTINGTHIRD00000000000";
    const sharedThird = (await x25519(eph.secretKey, third.enc.publicKey)) as Uint8Array;
    const keyThird = await deriveKey(
      "apmsg001",
      concatBytes(sharedThird, fields(to, original.from, "m2")),
    );
    const nonce = newNonce();
    const sealed = await aeadEncrypt(
      keyThird,
      nonce,
      content,
      ad(to, original.from, "m2", third.enc.publicKey, eph.publicKey),
    );
    const forwarded: PeerEnvelope = {
      v: 1,
      to,
      from: original.from,
      id: "m2",
      nonce: toBase64url(nonce),
      ciphertext: toBase64url(concatBytes(eph.publicKey, sealed)),
    };
    const result = await openPeerMessage(forwarded, {
      recipientSecretKey: third.enc.secretKey,
      registry,
    });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
    // The same wrapping with the original `to` and `id` would verify: the wrapper is sound.
    const control = await openPeerMessage(original, {
      recipientSecretKey: bridge.enc.secretKey,
      registry,
    });
    expect(control.ok && control.sender === phone.id).toBe(true);
  });

  it("refuses to build a message with a bad sender, type, number or key", async () => {
    const { send } = await world();
    await expect(send({ sender: "phone:short" })).rejects.toThrow(TypeError);
    await expect(send({ type: "" })).rejects.toThrow(TypeError);
    await expect(send({ seq: 0 })).rejects.toThrow(TypeError);
    await expect(send({ recipientEncKey: new Uint8Array(31) })).rejects.toThrow(TypeError);
    await expect(send({ recipientEncKey: new Uint8Array(32) })).rejects.toThrow(TypeError);
  });
});

describe("an envelope the relay mangles is refused, never thrown", () => {
  it("returns malformed for fields that are too long or not texts, and for no envelope", async () => {
    const { send, open } = await world();
    const envelope = await send();
    const long = "x".repeat(70_000);
    for (const bad of [
      { ...envelope, to: long },
      { ...envelope, from: long },
      { ...envelope, id: long },
      { ...envelope, to: 5 as unknown as string },
      null as unknown as PeerEnvelope,
      {} as PeerEnvelope,
    ]) {
      expect(await open(bad)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("refuses to build a message with fields that are too long, or no body", async () => {
    const { send } = await world();
    await expect(send({ to: "x".repeat(70_000) })).rejects.toThrow(TypeError);
    await expect(send({ body: undefined })).rejects.toThrow(TypeError);
  });
});

describe("sequence per pair, in a sliding window", () => {
  it("rejects a replay, accepts a reorder inside the window, after verification only", async () => {
    const { send, open } = await world();
    const window = new SequenceWindow();
    const one = await send({ seq: 1, id: "m1" });
    const two = await send({ seq: 2, id: "m2" });
    const three = await send({ seq: 3, id: "m3" });
    const accept = async (envelope: PeerEnvelope) => {
      const result = await open(envelope);
      return result.ok ? window.accept(result.seq) : "rejected";
    };
    expect(await accept(one)).toBe("accepted");
    expect(await accept(three)).toBe("accepted");
    // The relay delivers the second late (reorder): accepted. Replays: refused.
    expect(await accept(two)).toBe("accepted");
    expect(await accept(one)).toBe("duplicate");
    expect(await accept(three)).toBe("duplicate");
    // A forged envelope with a huge number never moves the window.
    // Change the first character, which is never a padding bit, so the forgery is guaranteed.
    const first = three.ciphertext[0] === "A" ? "B" : "A";
    const forged = { ...three, ciphertext: first + three.ciphertext.slice(1) };
    expect(await accept(forged)).toBe("rejected");
    expect(window.state().highest).toBe(3);
  });
});

describe("no key, subkey or secret in an error or a text", () => {
  it("keeps keys out of the messages of errors and of results", async () => {
    const { phone, bridge, send, open } = await world();
    const secrets = [
      toHex(phone.sig.secretKey),
      toHex(bridge.enc.secretKey),
      toBase64url(phone.sig.secretKey),
      toBase64url(bridge.enc.secretKey),
    ];
    const outputs: string[] = [];
    const attempt = async (run: () => Promise<unknown>) => {
      try {
        outputs.push(JSON.stringify(await run()));
      } catch (error) {
        outputs.push(String(error instanceof Error ? `${error.name}: ${error.message}` : error));
      }
    };
    await attempt(() => send({ recipientEncKey: phone.sig.secretKey.slice(0, 31) }));
    await attempt(() => send({ senderSecretKey: bridge.enc.secretKey }));
    await attempt(() => send({ sender: toBase64url(phone.sig.secretKey) }));
    await attempt(() => open({ ...({} as PeerEnvelope), v: 1 }));
    await attempt(async () => open(await send(), phone.sig.secretKey.slice(0, 31)));
    await attempt(async () => open(await send(), phone.enc.secretKey));
    for (const text of outputs) for (const secret of secrets) expect(text).not.toContain(secret);
    expect(outputs.length).toBeGreaterThan(0);
  });
});

describe("vectors of the message (test-vectors/peer-message-v1.json)", () => {
  // Fixed test keys and nonces, never used elsewhere. `UPDATE_PEER_VECTORS=1` rewrites the file.
  const fixed = async () => {
    const sender = await generateEd25519({ seed: bytes(0x10, 32) });
    const recipientSecret = bytes(0x30, 32);
    return { sender, recipientSecret, recipientPublic: await x25519PublicKey(recipientSecret) };
  };
  const input = async () => {
    const { sender, recipientPublic } = await fixed();
    return {
      to: "01K6KXJ5G0ROUTE0BRIDGE0001",
      from: "01K6KXJ5G0ROUTE0PH0NE00001",
      id: "01K6KXJ5G0MESSAGE00000001A",
      sender: deviceIdOf("phone", sender.publicKey),
      senderSecretKey: sender.secretKey,
      recipientEncKey: recipientPublic,
      seq: 7,
      type: "order",
      body: { approve: "G-0000000001", note: "Validé, à la place." },
    };
  };
  const hooks = { ephemeralSecretKey: bytes(0x50, 32), nonce: bytes(0x70, 24) };

  it("rebuilds the envelope bit for bit, and opens it", async () => {
    const built = await input();
    const envelope = await encryptPeerMessageWith(built, hooks);
    const { sender, recipientSecret } = await fixed();
    const file = {
      format: "agentplugged.peer-message.v1.test-vectors",
      notes: [
        "Envelope { v, to, from, id, nonce, ciphertext }; ciphertext = ephemeral X25519 key (32 bytes) || XChaCha20-Poly1305 ciphertext, base64url.",
        "key = KDF('apmsg001', X25519(ephemeral, recipient enc) || len2(to) to || len2(from) from || len2(id) id), KDF(ctx, ikm) = crypto_kdf_derive_from_key(32, 1, ctx, SHA-256(ikm)); len2 = length on 2 bytes, big-endian.",
        "associated data = 'agentplugged/msg/v1' || v (1 byte) || len2(to) to || len2(from) from || len2(id) id || SHA-256(recipient enc public key) || ephemeral public key.",
        "content = RFC 8785 JSON of { t: 'msg.inner/v1', sender, seq, type, body, alg: 'ed25519', sig }; sig = Ed25519 over the canonical JSON of { t, sender, seq, type, body, to, id }.",
        "These keys and nonces are fixed test values: never use them elsewhere.",
      ],
      sender: {
        seed: toHex(bytes(0x10, 32)),
        public_key: toHex(sender.publicKey),
        device: built.sender,
      },
      recipient: { enc_secret: toHex(recipientSecret), enc_public: toHex(built.recipientEncKey) },
      ephemeral_secret: toHex(hooks.ephemeralSecretKey),
      nonce: toHex(hooks.nonce),
      message: { seq: built.seq, type: built.type, body: built.body },
      envelope,
    };
    if (process.env.UPDATE_PEER_VECTORS === "1" || !existsSync(VECTORS)) {
      writeFileSync(VECTORS, `${JSON.stringify(file, null, 2)}\n`);
    }
    const stored = JSON.parse(readFileSync(VECTORS, "utf8")) as typeof file;
    expect(stored.envelope).toEqual(envelope);
    expect(stored.sender.public_key).toBe(toHex(sender.publicKey));
    const result = await openPeerMessage(stored.envelope, {
      recipientSecretKey: recipientSecret,
      registry: (who) =>
        who === built.sender ? { signingKey: sender.publicKey, routingId: built.from } : undefined,
    });
    expect(result).toEqual({
      ok: true,
      sender: built.sender,
      seq: 7,
      type: "order",
      body: built.body,
    });
  });
});
