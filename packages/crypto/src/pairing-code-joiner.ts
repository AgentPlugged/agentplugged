import {
  PAIR_ERROR_CODES,
  PAIR_MESSAGE_TYPES,
  type PairHello,
  PairHelloSchema,
  relayAttachPayload,
} from "@agentplugged/protocol";
import { signBytesEd25519 } from "./ed25519.js";
import { fromBase64url, fromUtf8, toBase64url } from "./encoding.js";
import { decodePairWire, encodePairWire, openPairBox } from "./pairing.js";
import type { PairCode } from "./pairing-code.js";
import { CodeInitiator } from "./pairing-code-exchange.js";
import {
  type JoinerEvent,
  type JoinerKeys,
  type JoinerPins,
  PairingJoiner,
} from "./pairing-joiner.js";
import { deviceIdMatchesKey } from "./primitives.js";

/**
 * The part a machine plays when it joins with a short code: the password exchange with the bridge
 * that issued the code, then the bridge's hello, then the same request and welcome as any device
 * that joins (`PairingJoiner`), anchored on the keys the hello named instead of a link's. It does
 * no network and no storage: the host program feeds it the messages of the rendezvous.
 *
 * The bridge's keys and the root are believed only because they came in a box that the session key
 * opens, which only a bridge that knew the code could build; a relay that does not know the code
 * can neither read nor forge them.
 */

/** The seconds a machine's attachment stays valid after the bridge's clock said now. */
const ATTACH_VALIDITY_S = 300;

export interface CodeJoinerOptions {
  readonly code: PairCode;
  /** The machine's own keys (its signing key is the machine key; the encryption key is the bridge's). */
  readonly keys: JoinerKeys;
  /** What the machine says it is (shown to the creator as declared, never believed). */
  readonly declared: { readonly type: string; readonly os: string };
  /** The product of the folder the command ran in. */
  readonly product: string;
  /** The identifier this machine takes on the relay. */
  readonly relayDevice: string;
  /** The relay's name, which the attachment is signed for. */
  readonly relayName: string;
  readonly random?: (bytes: number) => Uint8Array;
}

export type CodeJoinerEvent =
  /** The next message to send to the bridge. */
  | { readonly type: "send"; readonly data: string }
  /** The bridge proved it knew the code. Nothing to send yet. */
  | { readonly type: "confirmed" }
  /** The bridge's hello verified: its request goes out, and the account it belongs to is known. */
  | { readonly type: "hello"; readonly hello: PairHello; readonly data: string }
  | JoinerEvent;

type Stage = "new" | "started" | "replied" | "confirmed" | "requested" | "failed";

export class CodeJoiner {
  readonly #options: CodeJoinerOptions;
  readonly #exchange: CodeInitiator;
  #stage: Stage = "new";
  #joiner: PairingJoiner | undefined;

  constructor(options: CodeJoinerOptions) {
    if (options.keys.kind !== "machine") throw new TypeError("This code is for a machine.");
    this.#options = options;
    this.#exchange = new CodeInitiator(options.code, options.random);
  }

  /** The pins, once the bridge's welcome verified. */
  get pins(): JoinerPins | undefined {
    return this.#joiner?.pins;
  }

  /** The first message to send to the bridge. */
  begin(): string {
    this.#stage = "started";
    const first = this.#exchange.start();
    return encodePairWire({ k: "pake_init", nonce: first.nonce, share: first.share });
  }

  /** What a message of the bridge does. Anything unexpected is ignored; anything forged is rejected. */
  async receive(data: string): Promise<CodeJoinerEvent> {
    const wire = decodePairWire(data);
    if (wire === undefined) return { type: "ignored", reason: "malformed" };
    if (wire.k === "refused") return { type: "refused", code: wire.code };
    if (this.#stage === "requested" && wire.k === "envelope") {
      const event = await (this.#joiner as PairingJoiner).receive(data);
      if (event.type === "linked") await this.#exchange.wipe();
      return event;
    }
    switch (wire.k) {
      case "pake_reply": {
        if (this.#stage !== "started") return { type: "ignored", reason: "unexpected" };
        const proof = await this.#exchange.reply(wire.share);
        if (proof === undefined) return this.#fail("pake_reply");
        this.#stage = "replied";
        return { type: "send", data: encodePairWire({ k: "pake_confirm", mac: proof.mac }) };
      }
      case "pake_confirm_b": {
        if (this.#stage !== "replied") return { type: "ignored", reason: "unexpected" };
        if (!(await this.#exchange.verifyBridge(wire.mac))) return this.#fail("pake_confirm");
        this.#stage = "confirmed";
        return { type: "confirmed" };
      }
      case "hello": {
        if (this.#stage !== "confirmed") return { type: "ignored", reason: "unexpected" };
        return this.#hello(wire);
      }
      default:
        return { type: "ignored", reason: "unexpected" };
    }
  }

  #fail(reason: string): CodeJoinerEvent {
    this.#stage = "failed";
    return { type: "rejected", code: PAIR_ERROR_CODES.PAIRING_INVALID_PROOF, reason };
  }

  async #hello(wire: { nonce: string; ciphertext: string }): Promise<CodeJoinerEvent> {
    const key = this.#exchange.sessionKey;
    if (key === undefined) return this.#fail("no_session");
    const opened = await openPairBox({
      s: key,
      x: this.#exchange.rendezvous,
      direction: "down",
      type: PAIR_MESSAGE_TYPES.hello,
      box: { nonce: wire.nonce, ciphertext: wire.ciphertext },
    });
    const text = opened === undefined ? undefined : fromUtf8(opened);
    let parsed: ReturnType<typeof PairHelloSchema.safeParse> | undefined;
    try {
      parsed = text === undefined ? undefined : PairHelloSchema.safeParse(JSON.parse(text));
    } catch {
      parsed = undefined;
    }
    const rootKey = parsed?.success === true ? fromBase64url(parsed.data.root.key) : undefined;
    const bridgeKey =
      parsed?.success === true ? fromBase64url(parsed.data.bridge.sig.key) : undefined;
    if (parsed?.success !== true || rootKey === undefined || bridgeKey === undefined) {
      return this.#fail("hello");
    }
    const hello = parsed.data;
    // The identifiers the bridge states are those of the keys it states.
    if (
      !deviceIdMatchesKey(hello.root.device, rootKey) ||
      !deviceIdMatchesKey(hello.bridge.device, bridgeKey)
    ) {
      return this.#fail("hello_identity");
    }
    const options = this.#options;
    const declaration = {
      device_id: options.relayDevice,
      kind: "bridge" as const,
      sig_key: toBase64url(options.keys.sigPublicKey),
      enc_key: toBase64url(options.keys.encryption.publicKey),
      relay: options.relayName,
      account: hello.account,
      expires_at: hello.now + ATTACH_VALIDITY_S,
    };
    const attachSig = await signBytesEd25519(
      relayAttachPayload(declaration),
      options.keys.sigSecretKey,
    );
    this.#joiner = new PairingJoiner({
      link: {
        kind: "machine",
        x: this.#exchange.rendezvous,
        s: key,
        bridgeSigKey: bridgeKey,
        root: { kind: hello.root.device.startsWith("human:") ? "human" : "machine", key: rootKey },
      },
      keys: options.keys,
      account: hello.account,
      declared: options.declared,
      machine: {
        product: options.product,
        relay_device: options.relayDevice,
        attach_expires_at: declaration.expires_at,
        attach_sig: toBase64url(attachSig),
      },
    });
    const data = await this.#joiner.requestData();
    this.#stage = "requested";
    return { type: "hello", hello, data };
  }

  /** Forgets the session key (a machine that gives up). */
  async wipe(): Promise<void> {
    await this.#exchange.wipe();
  }
}
