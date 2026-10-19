import {
  LinkRequestSchema,
  PAIR_CODE_ALPHABET,
  PAIR_MESSAGE_TYPES,
  type PairHello,
  relayAttachPayload,
} from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { generateEd25519, verifyEd25519 } from "./ed25519.js";
import { fromBase64url, fromUtf8, toBase64url, utf8 } from "./encoding.js";
import { randomBytes } from "./hash.js";
import { decodePairWire, encodePairWire, openPairBox, sealPairBox } from "./pairing.js";
import {
  codeRendezvous,
  codeRendezvousId,
  formatPairCode,
  normalizeCodeInput,
  type PairCode,
  parsePairCode,
  randomPairCode,
} from "./pairing-code.js";
import { CodeInitiator, CodeResponder } from "./pairing-code-exchange.js";
import { CodeJoiner } from "./pairing-code-joiner.js";
import { createJoinerKeys } from "./pairing-joiner.js";
import { deviceIdOf, generateX25519 } from "./primitives.js";

const CODE: PairCode = { id: "R3T9HJ2P", secret: "K7M4QX" };

describe("the short code", () => {
  it("is 8 symbols of address then 6 of password, drawn apart", () => {
    const draws: number[] = [];
    const code = randomPairCode((bytes) => {
      draws.push(bytes);
      return randomBytes(bytes);
    });
    expect(draws).toEqual([8, 6]);
    expect(code.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(code.secret).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
  });

  it("uses every symbol of the alphabet about equally often (no modulo bias)", () => {
    const counts = new Map<string, number>();
    const total = 32 * 2_000;
    let drawn = 0;
    while (drawn < total) {
      for (const char of randomPairCode().id + randomPairCode().secret) {
        counts.set(char, (counts.get(char) ?? 0) + 1);
        drawn += 1;
      }
    }
    expect(counts.size).toBe(32);
    const expected = drawn / 32;
    const chi = [...counts.values()].reduce((sum, n) => sum + (n - expected) ** 2 / expected, 0);
    // 31 degrees of freedom: 61.1 is the 0.1 % point, so a fair draw fails this once in a thousand.
    expect(chi).toBeLessThan(70);
    expect([...counts.keys()].every((char) => PAIR_CODE_ALPHABET.includes(char))).toBe(true);
  });

  it("reads what a person types: case, separators, look-alike letters", () => {
    expect(parsePairCode("r3t9-hj2p-k7m-4qx")).toEqual({ id: "R3T9HJ2P", secret: "K7M4QX" });
    expect(parsePairCode("  R3T9 HJ2P  K7M 4QX ")).toEqual({ id: "R3T9HJ2P", secret: "K7M4QX" });
    expect(normalizeCodeInput("OIL")).toBe("011");
    expect(formatPairCode({ id: "R3T9HJ2P", secret: "K7M4QX" })).toBe("R3T9-HJ2P-K7M-4QX");
  });

  it("refuses a wrong length or a symbol outside the alphabet, without guessing", () => {
    for (const bad of [
      "",
      "R3T9HJ2PK7M4Q",
      "R3T9HJ2PK7M4QXX",
      "R3T9HJ2PK7M4QU",
      "R3T9-HJ2P-K7M-4Q!",
    ]) {
      expect(parsePairCode(bad)).toBeUndefined();
    }
  });

  it("gives the relay an address that depends on the address of the code only", () => {
    expect(codeRendezvousId("R3T9HJ2P")).toBe(codeRendezvousId("R3T9HJ2P"));
    expect(codeRendezvousId("R3T9HJ2P")).not.toBe(codeRendezvousId("R3T9HJ2Q"));
    expect(codeRendezvous("R3T9HJ2P")).toHaveLength(16);
    expect(codeRendezvousId("R3T9HJ2P")).toMatch(/^[A-Za-z0-9_-]{21}[AQgw]$/);
  });
});

/** One full exchange; returns what each side holds. */
async function exchange(machineCode: PairCode, bridgeCode: PairCode) {
  const machine = new CodeInitiator(machineCode);
  const bridge = new CodeResponder(bridgeCode);
  const first = machine.start();
  const reply = await bridge.answer(first);
  const proof = reply === undefined ? undefined : await machine.reply(reply.share);
  const bridgeProof = proof === undefined ? undefined : await bridge.confirm(proof.mac);
  const verified = bridgeProof === undefined ? false : await machine.verifyBridge(bridgeProof.mac);
  return { machine, bridge, reply, proof, bridgeProof, verified };
}

describe("the password exchange", () => {
  it("ends with the same 64-byte session key when the code is the same", async () => {
    const run = await exchange(CODE, CODE);
    expect(run.verified).toBe(true);
    const machineKey = run.machine.sessionKey as Uint8Array;
    const bridgeKey = run.bridge.sessionKey as Uint8Array;
    expect(machineKey).toHaveLength(64);
    expect(toBase64url(machineKey)).toBe(toBase64url(bridgeKey));
  });

  it("gives a wrong password nothing: no proof from the bridge, no key on either side", async () => {
    const run = await exchange({ ...CODE, secret: "K7M4QY" }, CODE);
    expect(run.reply).toBeDefined();
    expect(run.proof).toBeDefined();
    expect(run.bridgeProof).toBeUndefined();
    expect(run.verified).toBe(false);
    expect(run.bridge.sessionKey).toBeUndefined();
    expect(run.machine.sessionKey).toBeUndefined();
  });

  it("gives a different session key for a different session of the same code", async () => {
    const one = await exchange(CODE, CODE);
    const two = await exchange(CODE, CODE);
    expect(toBase64url(one.machine.sessionKey as Uint8Array)).not.toBe(
      toBase64url(two.machine.sessionKey as Uint8Array),
    );
  });

  it("a relay that knows nothing and stands in the middle ends with other keys and no confirmation", async () => {
    // The relay runs a session of its own with each side, guessing a password.
    const machine = new CodeInitiator(CODE);
    const bridge = new CodeResponder(CODE);
    const guess: PairCode = { id: CODE.id, secret: "AAAAAA" };
    const towardsMachine = new CodeResponder(guess);
    const towardsBridge = new CodeInitiator(guess);

    const first = machine.start();
    const forgedReply = await towardsMachine.answer(first);
    const machineProof = await machine.reply((forgedReply as { share: string }).share);
    // It cannot forge the bridge's proof for the machine: it does not hold the machine's key.
    expect(await towardsMachine.confirm((machineProof as { mac: string }).mac)).toBeUndefined();

    const forgedFirst = towardsBridge.start();
    const bridgeReply = await bridge.answer(forgedFirst);
    const forgedProof = await towardsBridge.reply((bridgeReply as { share: string }).share);
    expect(await bridge.confirm((forgedProof as { mac: string }).mac)).toBeUndefined();
    expect(machine.sessionKey).toBeUndefined();
    expect(bridge.sessionKey).toBeUndefined();
  });

  it("a recorded exchange replayed against a bridge confirms nothing: a guess costs a live exchange", async () => {
    const machine = new CodeInitiator(CODE);
    const bridge = new CodeResponder(CODE);
    const first = machine.start();
    const reply = await bridge.answer(first);
    const proof = await machine.reply((reply as { share: string }).share);
    expect((await bridge.confirm((proof as { mac: string }).mac)) !== undefined).toBe(true);
    // Whoever recorded all of it, and knows the password too, replays it to a fresh bridge.
    const fresh = new CodeResponder(CODE);
    const again = await fresh.answer(first);
    expect(again?.share).not.toBe((reply as { share: string }).share);
    expect(await fresh.confirm((proof as { mac: string }).mac)).toBeUndefined();
    expect(fresh.sessionKey).toBeUndefined();
  });

  it("refuses a message that is malformed or hostile, never throws", async () => {
    const bridge = new CodeResponder(CODE);
    const share = toBase64url(randomBytes(32));
    const nonce = toBase64url(randomBytes(16));
    expect(await bridge.answer({ nonce: "AA", share })).toBeUndefined();
    expect(await bridge.answer({ nonce, share: "not-base64!" })).toBeUndefined();
    // The identity element is not a usable share.
    expect(await bridge.answer({ nonce, share: toBase64url(new Uint8Array(32)) })).toBeUndefined();
    expect(await bridge.confirm(toBase64url(randomBytes(32)))).toBeUndefined();
    const machine = new CodeInitiator(CODE);
    expect(await machine.reply(toBase64url(randomBytes(32)))).toBeUndefined();
    machine.start();
    expect(await machine.reply(toBase64url(new Uint8Array(32)))).toBeUndefined();
    expect(await machine.verifyBridge(toBase64url(randomBytes(32)))).toBe(false);
  });

  it("does not hand over a session key before the proof of the other side", async () => {
    const machine = new CodeInitiator(CODE);
    const bridge = new CodeResponder(CODE);
    const reply = await bridge.answer(machine.start());
    await machine.reply((reply as { share: string }).share);
    expect(machine.sessionKey).toBeUndefined();
    expect(bridge.sessionKey).toBeUndefined();
  });
});

describe("the machine that joins with a code", () => {
  const bridgeHello = async (): Promise<{
    hello: PairHello;
    sig: Awaited<ReturnType<typeof generateEd25519>>;
    root: Awaited<ReturnType<typeof generateEd25519>>;
  }> => {
    const sig = await generateEd25519();
    const root = await generateEd25519();
    const enc = await generateX25519();
    return {
      sig,
      root,
      hello: {
        t: PAIR_MESSAGE_TYPES.hello,
        root: { device: deviceIdOf("human", root.publicKey), key: toBase64url(root.publicKey) },
        bridge: {
          device: deviceIdOf("machine", sig.publicKey),
          sig: { alg: "ed25519", key: toBase64url(sig.publicKey) },
          enc: { alg: "x25519", key: toBase64url(enc.publicKey) },
        },
        account: "01K6KXJ5G0ABCDEFGHJKMNPQRS",
        now: 1_800_000_000,
      },
    };
  };

  async function start() {
    const keys = await createJoinerKeys("machine");
    const joiner = new CodeJoiner({
      code: CODE,
      keys,
      declared: { type: "Serveur · missions récurrentes", os: "Linux" },
      product: "01K6KXJ5G0ABCDEFGHJKMNPQRS",
      relayDevice: "01K6KXJ5G0ABCDEFGHJKMNPQRT",
      relayName: "relay.test",
    });
    const bridge = new CodeResponder(CODE);
    const first = decodePairWire(joiner.begin());
    if (first?.k !== "pake_init") throw new Error("first message");
    const reply = await bridge.answer(first);
    const toMachine = async (wire: Parameters<typeof encodePairWire>[0]) =>
      joiner.receive(encodePairWire(wire));
    return { keys, joiner, bridge, reply, toMachine };
  }

  it("answers the bridge, verifies it, then sends its request in a box of the session key", async () => {
    const { keys, joiner, bridge, reply, toMachine } = await start();
    const { hello } = await bridgeHello();
    const sent = await toMachine({ k: "pake_reply", share: (reply as { share: string }).share });
    expect(sent.type).toBe("send");
    const confirm = decodePairWire((sent as { data: string }).data);
    if (confirm?.k !== "pake_confirm") throw new Error("confirm");
    const proof = await bridge.confirm(confirm.mac);
    expect(
      (await toMachine({ k: "pake_confirm_b", mac: (proof as { mac: string }).mac })).type,
    ).toBe("confirmed");
    const box = await sealPairBox({
      s: bridge.sessionKey as Uint8Array,
      x: bridge.rendezvous,
      direction: "down",
      type: PAIR_MESSAGE_TYPES.hello,
      plaintext: utf8(JSON.stringify(hello)),
    });
    const event = await toMachine({ k: "hello", nonce: box.nonce, ciphertext: box.ciphertext });
    expect(event.type).toBe("hello");
    const wire = decodePairWire((event as { data: string }).data);
    if (wire?.k !== "request") throw new Error("request");
    const opened = await openPairBox({
      s: bridge.sessionKey as Uint8Array,
      x: bridge.rendezvous,
      direction: "up",
      type: PAIR_MESSAGE_TYPES.request,
      box: { nonce: wire.nonce, ciphertext: wire.ciphertext },
    });
    const request = LinkRequestSchema.parse(JSON.parse(fromUtf8(opened as Uint8Array) as string));
    expect(request.account).toBe(hello.account);
    expect(request.browser.device).toBe(keys.device);
    expect(request.machine?.product).toBe("01K6KXJ5G0ABCDEFGHJKMNPQRS");
    // The attachment is dated with the bridge's clock and signed by the machine's own key.
    expect(request.machine?.attach_expires_at).toBe(hello.now + 300);
    const declaration = {
      device_id: "01K6KXJ5G0ABCDEFGHJKMNPQRT",
      kind: "bridge" as const,
      sig_key: toBase64url(keys.sigPublicKey),
      enc_key: toBase64url(keys.encryption.publicKey),
      relay: "relay.test",
      account: hello.account,
      expires_at: hello.now + 300,
    };
    expect(
      await verifyEd25519(
        relayAttachPayload(declaration),
        fromBase64url(request.machine?.attach_sig as string) as Uint8Array,
        keys.sigPublicKey,
      ),
    ).toBe(true);
    expect(joiner.pins).toBeUndefined();
  });

  it("refuses a hello it cannot open, or that lies about an identifier, or that comes too early", async () => {
    const { joiner, bridge, reply, toMachine } = await start();
    const { hello } = await bridgeHello();
    const forged = await sealPairBox({
      s: randomBytes(64),
      x: bridge.rendezvous,
      direction: "down",
      type: PAIR_MESSAGE_TYPES.hello,
      plaintext: utf8(JSON.stringify(hello)),
    });
    // Too early: the bridge has not proved it knew the code yet.
    expect(
      (await toMachine({ k: "hello", nonce: forged.nonce, ciphertext: forged.ciphertext })).type,
    ).toBe("ignored");
    const sent = await toMachine({ k: "pake_reply", share: (reply as { share: string }).share });
    const confirm = decodePairWire((sent as { data: string }).data);
    if (confirm?.k !== "pake_confirm") throw new Error("confirm");
    const proof = await bridge.confirm(confirm.mac);
    await toMachine({ k: "pake_confirm_b", mac: (proof as { mac: string }).mac });
    expect(
      (await toMachine({ k: "hello", nonce: forged.nonce, ciphertext: forged.ciphertext })).type,
    ).toBe("rejected");

    const second = await start();
    const liar = (await bridgeHello()).hello;
    liar.root.device = "human:AAAAAAAAAAAAAAAA";
    const sent2 = await second.toMachine({
      k: "pake_reply",
      share: (second.reply as { share: string }).share,
    });
    const confirm2 = decodePairWire((sent2 as { data: string }).data);
    if (confirm2?.k !== "pake_confirm") throw new Error("confirm");
    const proof2 = await second.bridge.confirm(confirm2.mac);
    await second.toMachine({ k: "pake_confirm_b", mac: (proof2 as { mac: string }).mac });
    const box = await sealPairBox({
      s: second.bridge.sessionKey as Uint8Array,
      x: second.bridge.rendezvous,
      direction: "down",
      type: PAIR_MESSAGE_TYPES.hello,
      plaintext: utf8(JSON.stringify(liar)),
    });
    expect(
      (await second.toMachine({ k: "hello", nonce: box.nonce, ciphertext: box.ciphertext })).type,
    ).toBe("rejected");
    expect(joiner.pins).toBeUndefined();
  });

  it("rejects a confirmation that is not the bridge's", async () => {
    const { toMachine, reply } = await start();
    await toMachine({ k: "pake_reply", share: (reply as { share: string }).share });
    const event = await toMachine({ k: "pake_confirm_b", mac: toBase64url(randomBytes(32)) });
    expect(event.type).toBe("rejected");
  });

  it("is for a machine only", async () => {
    const keys = await createJoinerKeys("browser");
    expect(
      () =>
        new CodeJoiner({
          code: CODE,
          keys,
          declared: { type: "x", os: "y" },
          product: "01K6KXJ5G0ABCDEFGHJKMNPQRS",
          relayDevice: "01K6KXJ5G0ABCDEFGHJKMNPQRT",
          relayName: "relay.test",
        }),
    ).toThrow();
  });
});
