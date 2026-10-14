import { randomBytes } from "@agentplugged/crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_MAX = 2 ** 48 - 1;

/** A clock in milliseconds since the epoch (`Date.now`); injected in tests. */
export type Clock = () => number;

/** Source of random bytes; injected in tests. */
export type RandomSource = (length: number) => Uint8Array;

/**
 * Makes a new ULID for the time `at` (the factory's clock when absent), strictly greater than
 * `after` when given and than every ULID this factory made before: ids of one writer sort in the
 * order they were made, even within one millisecond.
 */
export type UlidFactory = (after?: string, at?: number) => string;

function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > TIME_MAX) {
    throw new RangeError(`ULID time out of range: ${ms}`);
  }
  let out = "";
  let rest = ms;
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD.charAt(rest % 32) + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

/** 80 random bits as 16 Crockford base32 characters. */
function encodeRandom(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD.charAt((value >> bits) & 31);
    }
    value &= (1 << bits) - 1;
  }
  return out;
}

/**
 * The ULID right after `id` (+1 on its 128-bit value). Throws past the largest ULID
 * (`7ZZZZZZZZZZZZZZZZZZZZZZZZZ`): its time is 48 bits, so the first character is at most 7.
 */
export function nextUlid(id: string): string {
  const chars = id.split("");
  for (let i = chars.length - 1; i >= 0; i--) {
    const digit = CROCKFORD.indexOf(chars[i] ?? "");
    if (digit < 31) {
      chars[i] = CROCKFORD.charAt(digit + 1);
      if (i === 0 && digit + 1 > 7) break;
      return chars.join("");
    }
    chars[i] = "0";
  }
  throw new RangeError("ULID overflow");
}

export function createUlidFactory(
  options: { now?: Clock; random?: RandomSource } = {},
): UlidFactory {
  const now = options.now ?? Date.now;
  const random = options.random ?? randomBytes;
  let last = "";
  return (after, at) => {
    let id = encodeTime(at ?? now()) + encodeRandom(random(10));
    const floor = after !== undefined && after > last ? after : last;
    if (floor !== "" && id <= floor) id = nextUlid(floor);
    last = id;
    return id;
  };
}

/** ULIDs of this process, from the system clock and the secure random source. */
export const newUlid: UlidFactory = createUlidFactory();
