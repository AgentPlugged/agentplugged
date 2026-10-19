import { cpace } from "@cipherman/pake-js";
import { fromBase64url, toBase64url, utf8 } from "./encoding.js";
import { randomBytes } from "./hash.js";
import { codeRendezvous, type PairCode } from "./pairing-code.js";
import { concatBytes, constantTimeEqual, deriveKey, lengthPrefixed, wipe } from "./primitives.js";

/**
 * The password exchange of a short code (CPace on ristretto255). The machine that types the code
 * is the initiator and the bridge that issued it the responder. Both end with the same 64-byte
 * session key only if they used the same password; a relay in the middle, or anyone who guesses,
 * ends with a different key and learns nothing it can test offline: every guess costs one
 * exchange with the bridge, which counts them.
 *
 * What this file adds to the exchange: a confirmation of the key in both directions, the machine
 * first and the bridge only after it verified the machine's (so that the bridge's answer says
 * nothing about a wrong guess), a session tied to the rendezvous and to a nonce of the machine,
 * and refusals instead of exceptions for anything a hostile peer can send.
 */

const R = cpace.ristretto255;
const CHANNEL = utf8("agentplugged/pair-code/v1");
const CONFIRM_LABEL = utf8("agentplugged/pair/confirm/v1");
const NONCE_BYTES = 16;
const SHARE_BYTES = 32;

interface Shares {
  readonly initiator: Uint8Array;
  readonly responder: Uint8Array;
}

async function confirmations(
  isk: Uint8Array,
  rendezvous: Uint8Array,
  shares: Shares,
  nonce: Uint8Array,
): Promise<{ machine: Uint8Array; bridge: Uint8Array }> {
  const transcript = concatBytes(
    lengthPrefixed(CONFIRM_LABEL),
    lengthPrefixed(rendezvous),
    lengthPrefixed(shares.initiator),
    lengthPrefixed(shares.responder),
    lengthPrefixed(nonce),
  );
  const ikm = concatBytes(isk, transcript);
  try {
    return {
      machine: await deriveKey("apcnfmP1", ikm),
      bridge: await deriveKey("apcnfmB1", ikm),
    };
  } finally {
    await wipe(ikm);
  }
}

function decode(text: string, size: number): Uint8Array | undefined {
  const bytes = fromBase64url(text);
  return bytes?.length === size ? bytes : undefined;
}

/** The machine's side: it typed the code. */
export class CodeInitiator {
  readonly #password: Uint8Array;
  readonly #rendezvous: Uint8Array;
  readonly #nonce: Uint8Array;
  readonly #sid: Uint8Array;
  #own: { ephemeralSecret: Uint8Array; share: Uint8Array } | undefined;
  #isk: Uint8Array | undefined;
  #expected: Uint8Array | undefined;
  #verified = false;

  constructor(code: PairCode, random: (bytes: number) => Uint8Array = randomBytes) {
    this.#password = utf8(code.secret);
    this.#rendezvous = codeRendezvous(code.id);
    this.#nonce = Uint8Array.from(random(NONCE_BYTES));
    this.#sid = concatBytes(this.#rendezvous, this.#nonce);
  }

  /** The first message: the nonce and the machine's share. */
  start(): { nonce: string; share: string } {
    this.#own = R.init({ PRS: this.#password, sid: this.#sid, CI: CHANNEL });
    return { nonce: toBase64url(this.#nonce), share: toBase64url(this.#own.share) };
  }

  /** The bridge's share in, the machine's proof out; `undefined` for a share that cannot be used. */
  async reply(share: string): Promise<{ mac: string } | undefined> {
    const own = this.#own;
    const peer = decode(share, SHARE_BYTES);
    if (own === undefined || peer === undefined || this.#isk !== undefined) return undefined;
    let isk: Uint8Array;
    try {
      isk = R.deriveIskInitiatorResponder({
        ephemeralSecret: own.ephemeralSecret,
        ownShare: own.share,
        peerShare: peer,
        sid: this.#sid,
        role: "initiator",
      });
    } catch {
      return undefined;
    }
    this.#isk = isk;
    const macs = await confirmations(
      isk,
      this.#rendezvous,
      { initiator: own.share, responder: peer },
      this.#nonce,
    );
    this.#expected = macs.bridge;
    const proof = toBase64url(macs.machine);
    await wipe(macs.machine);
    return { mac: proof };
  }

  /** True only if the bridge proved it holds the same key: the password was right. */
  async verifyBridge(mac: string): Promise<boolean> {
    const given = decode(mac, 32);
    if (given === undefined || this.#expected === undefined || this.#isk === undefined) {
      return false;
    }
    this.#verified = await constantTimeEqual(given, this.#expected);
    return this.#verified;
  }

  /** The session key, once the bridge's proof verified; never before. */
  get sessionKey(): Uint8Array | undefined {
    return this.#verified ? this.#isk : undefined;
  }

  /** The rendezvous bytes the boxes of the session are tied to. */
  get rendezvous(): Uint8Array {
    return this.#rendezvous;
  }

  async wipe(): Promise<void> {
    await wipe(this.#isk, this.#expected, this.#own?.ephemeralSecret, this.#password);
    this.#isk = undefined;
    this.#verified = false;
  }
}

/** The bridge's side: it issued the code. One instance per attempt of one peer. */
export class CodeResponder {
  readonly #password: Uint8Array;
  readonly #rendezvous: Uint8Array;
  #isk: Uint8Array | undefined;
  #expected: Uint8Array | undefined;
  #bridgeProof: Uint8Array | undefined;
  #own: Uint8Array | undefined;
  #confirmed = false;

  constructor(code: PairCode) {
    this.#password = utf8(code.secret);
    this.#rendezvous = codeRendezvous(code.id);
  }

  /** The machine's first message in, the bridge's share out; `undefined` for a message that cannot be used. */
  async answer(message: { nonce: string; share: string }): Promise<{ share: string } | undefined> {
    if (this.#isk !== undefined) return undefined;
    const nonce = decode(message.nonce, NONCE_BYTES);
    const peer = decode(message.share, SHARE_BYTES);
    if (nonce === undefined || peer === undefined) return undefined;
    const sid = concatBytes(this.#rendezvous, nonce);
    try {
      const own = R.init({ PRS: this.#password, sid, CI: CHANNEL });
      this.#isk = R.deriveIskInitiatorResponder({
        ephemeralSecret: own.ephemeralSecret,
        ownShare: own.share,
        peerShare: peer,
        sid,
        role: "responder",
      });
      this.#own = own.ephemeralSecret;
      const macs = await confirmations(
        this.#isk,
        this.#rendezvous,
        { initiator: peer, responder: own.share },
        nonce,
      );
      this.#expected = macs.machine;
      this.#bridgeProof = macs.bridge;
      return { share: toBase64url(own.share) };
    } catch {
      this.#isk = undefined;
      return undefined;
    }
  }

  /**
   * Checks the machine's proof. Only a right one gets the bridge's own proof back: a wrong guess
   * learns nothing from the answer except that it was wrong.
   */
  async confirm(mac: string): Promise<{ mac: string } | undefined> {
    const given = decode(mac, 32);
    if (given === undefined || this.#expected === undefined || this.#bridgeProof === undefined) {
      return undefined;
    }
    if (!(await constantTimeEqual(given, this.#expected))) return undefined;
    this.#confirmed = true;
    return { mac: toBase64url(this.#bridgeProof) };
  }

  /** The session key, once the machine's proof verified; never before. */
  get sessionKey(): Uint8Array | undefined {
    return this.#confirmed ? this.#isk : undefined;
  }

  get rendezvous(): Uint8Array {
    return this.#rendezvous;
  }

  async wipe(): Promise<void> {
    await wipe(this.#isk, this.#expected, this.#bridgeProof, this.#own, this.#password);
    this.#isk = undefined;
    this.#confirmed = false;
  }
}
