import {
  PAIR_CODE_ALPHABET,
  PAIR_CODE_ID_SYMBOLS,
  PAIR_CODE_SECRET_SYMBOLS,
} from "@agentplugged/protocol";
import { toBase64url, utf8 } from "./encoding.js";
import { randomBytes, sha256 } from "./hash.js";
import { concatBytes } from "./primitives.js";

/**
 * The short code of a machine pairing: an address of 8 symbols to meet at, then a password of 6.
 * The two parts are drawn apart (two draws, nothing derived from the other), so that the address,
 * which the relay routes by, tells it nothing about the password. 30 bits of password are enough
 * only because the password exchange (`pairing-code-exchange.ts`) lets nobody test a guess
 * without talking to the bridge, which counts the tries.
 */

export interface PairCode {
  /** The address to meet at: 8 symbols. */
  readonly id: string;
  /** The password: 6 symbols. */
  readonly secret: string;
}

/** `count` symbols of the alphabet, uniformly: 256 is a multiple of 32, so `byte & 31` has no bias. */
function symbols(count: number, random: (bytes: number) => Uint8Array): string {
  const bytes = random(count);
  let out = "";
  for (let index = 0; index < count; index++) {
    out += PAIR_CODE_ALPHABET[(bytes[index] as number) & 31];
  }
  return out;
}

/** A new code: the address and the password come from two separate draws. */
export function randomPairCode(random: (bytes: number) => Uint8Array = randomBytes): PairCode {
  const id = symbols(PAIR_CODE_ID_SYMBOLS, random);
  const secret = symbols(PAIR_CODE_SECRET_SYMBOLS, random);
  return { id, secret };
}

/**
 * What a person typed, made canonical: case, spaces, hyphens and the look-alike letters of the
 * alphabet (`O` for `0`, `I` and `L` for `1`) are forgiven. `undefined` for anything else.
 */
export function normalizeCodeInput(input: string): string | undefined {
  const text = input
    .toUpperCase()
    .replace(/[\s\-_.]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  for (const char of text) if (!PAIR_CODE_ALPHABET.includes(char)) return undefined;
  return text;
}

/** The code a text holds, or `undefined` when its length or a symbol is wrong. */
export function parsePairCode(input: string): PairCode | undefined {
  const text = normalizeCodeInput(input);
  if (text === undefined || text.length !== PAIR_CODE_ID_SYMBOLS + PAIR_CODE_SECRET_SYMBOLS) {
    return undefined;
  }
  return { id: text.slice(0, PAIR_CODE_ID_SYMBOLS), secret: text.slice(PAIR_CODE_ID_SYMBOLS) };
}

/** `R3T9-HJ2P-K7M-4QX`: the address in two groups of 4, the password in two groups of 3. */
export function formatPairCode(code: PairCode): string {
  return `${code.id.slice(0, 4)}-${code.id.slice(4)}-${code.secret.slice(0, 3)}-${code.secret.slice(3)}`;
}

const RENDEZVOUS_LABEL = "agentplugged/pair-code/rendezvous/v1";

/**
 * The 16 bytes of the relay's rendezvous for a code's address. Drawn from the address alone: the
 * password has no part in it, so the relay cannot use it to test passwords offline.
 */
export function codeRendezvous(id: string): Uint8Array {
  return sha256(concatBytes(utf8(RENDEZVOUS_LABEL), utf8(id))).slice(0, 16);
}

/** The same, as the relay writes it. */
export function codeRendezvousId(id: string): string {
  return toBase64url(codeRendezvous(id));
}
