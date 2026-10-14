import { type PairWire, PairWireSchema } from "@agentplugged/protocol";
import { fromBase64url, fromUtf8, toBase64url, utf8 } from "./encoding.js";
import {
  AEAD_NONCE_BYTES,
  aeadDecrypt,
  aeadEncrypt,
  concatBytes,
  deriveKey,
  deviceIdOf,
  newNonce,
  wipe,
  type X25519KeyPair,
  x25519PublicKey,
} from "./primitives.js";

/**
 * The pairing link and its boxes.
 *
 * The link is `https://<host>/pair#AP2:<base64url>`: everything after `#` stays in the browser
 * and is never sent to a server, which is what keeps the secret `s` away from the relay and from the
 * web app's host. It holds public data and `s` only: the format version, the kind, a flag for the
 * kind of root, the rendezvous identifier `x` (random, never derived from `s`), the secret `s`
 * (128 bits, one use), the bridge's public signing key and the pinned root's public key. No private
 * key, no product key.
 *
 * Bytes (99): version (1), kind (1: `link` for a browser, 2: `phone` for a QR), root kind (1:
 * `human`, 2: `machine`), `x` (16), `s` (16), bridge signing key (32), root key (32). Written
 * `AP2:` then base64url without padding: 132 characters after the prefix.
 */

export const PAIR_LINK_PREFIX = "AP2:";
export const PAIR_LINK_VERSION = 1;
export const PAIR_LINK_BYTES = 99;
export const PAIR_ID_BYTES = 16;
export const PAIR_SECRET_BYTES = 16;

const KIND_CODES = { link: 1, phone: 2 } as const;
const ROOT_CODES = { human: 1, machine: 2 } as const;

export type PairLinkKind = keyof typeof KIND_CODES;
export type PairRootKind = keyof typeof ROOT_CODES;

export interface PairLink {
  readonly kind: PairLinkKind;
  /** The rendezvous identifier: 16 random bytes. */
  readonly x: Uint8Array;
  /** The one-use secret: 128 bits. */
  readonly s: Uint8Array;
  /** The bridge's Ed25519 public key (32 bytes). */
  readonly bridgeSigKey: Uint8Array;
  readonly root: { readonly kind: PairRootKind; readonly key: Uint8Array };
}

/** `AP2:` then the link's bytes in base64url. */
export function encodePairLink(link: PairLink): string {
  if (link.x.length !== PAIR_ID_BYTES) throw new TypeError("x has 16 bytes");
  if (link.s.length !== PAIR_SECRET_BYTES) throw new TypeError("s has 16 bytes");
  if (link.bridgeSigKey.length !== 32 || link.root.key.length !== 32) {
    throw new TypeError("a key has 32 bytes");
  }
  const bytes = concatBytes(
    Uint8Array.of(PAIR_LINK_VERSION, KIND_CODES[link.kind], ROOT_CODES[link.root.kind]),
    link.x,
    link.s,
    link.bridgeSigKey,
    link.root.key,
  );
  return `${PAIR_LINK_PREFIX}${toBase64url(bytes)}`;
}

/** The link of a text: the `AP2:` text, with or without a leading `#`, or a whole URL with the fragment. */
export function parsePairLink(text: string): PairLink | undefined {
  const hash = text.indexOf("#");
  const body = hash >= 0 ? text.slice(hash + 1) : text;
  if (!body.startsWith(PAIR_LINK_PREFIX)) return undefined;
  const bytes = fromBase64url(body.slice(PAIR_LINK_PREFIX.length));
  if (bytes === undefined || bytes.length !== PAIR_LINK_BYTES) return undefined;
  if (bytes[0] !== PAIR_LINK_VERSION) return undefined;
  const kind = (Object.keys(KIND_CODES) as PairLinkKind[]).find(
    (name) => KIND_CODES[name] === bytes[1],
  );
  const rootKind = (Object.keys(ROOT_CODES) as PairRootKind[]).find(
    (name) => ROOT_CODES[name] === bytes[2],
  );
  if (kind === undefined || rootKind === undefined) return undefined;
  return {
    kind,
    x: bytes.slice(3, 19),
    s: bytes.slice(19, 35),
    bridgeSigKey: bytes.slice(35, 67),
    root: { kind: rootKind, key: bytes.slice(67, 99) },
  };
}

/** `https://<host>/pair#AP2:…` */
export function pairLinkUrl(host: string, link: PairLink): string {
  return `${host.replace(/\/+$/, "")}/pair#${encodePairLink(link)}`;
}

/** The identifier of the pinned root a link carries. */
export function pairLinkRootDevice(link: PairLink): string {
  return deviceIdOf(link.root.kind, link.root.key);
}

// --- the boxes of the rendezvous -----------------------------------------------------------------

const BOX_LABEL = "agentplugged/pair/v1";

/** Which way a message goes: `up` from the browser to the bridge, `down` the other way. */
export type PairDirection = "up" | "down";

/** A message of the rendezvous as the relay sees it: a nonce and bytes it cannot read. */
export interface PairBox {
  /** 24 bytes, base64url. */
  readonly nonce: string;
  readonly ciphertext: string;
}

async function boxKey(direction: PairDirection, s: Uint8Array, x: Uint8Array): Promise<Uint8Array> {
  return deriveKey(direction === "up" ? "apboxup1" : "apboxdn1", concatBytes(s, x));
}

function boxData(x: Uint8Array, type: string): Uint8Array {
  return concatBytes(utf8(BOX_LABEL), x, utf8(type));
}

export interface PairBoxInput {
  readonly s: Uint8Array;
  readonly x: Uint8Array;
  readonly direction: PairDirection;
  /** The kind of message (`link.request/v1`…): authenticated with the content. */
  readonly type: string;
}

/** `sealPairBox` with a given nonce: `./testing.js` only (vectors). */
export async function sealPairBoxWith(
  input: PairBoxInput & { readonly plaintext: Uint8Array },
  nonce: Uint8Array,
): Promise<PairBox> {
  if (nonce.length !== AEAD_NONCE_BYTES) throw new TypeError("a nonce has 24 bytes");
  const key = await boxKey(input.direction, input.s, input.x);
  try {
    const sealed = await aeadEncrypt(key, nonce, input.plaintext, boxData(input.x, input.type));
    return { nonce: toBase64url(nonce), ciphertext: toBase64url(sealed) };
  } finally {
    await wipe(key);
  }
}

/** Seals `plaintext` with the key drawn from `s`: only who knows `s` can open it. */
export function sealPairBox(input: PairBoxInput & { readonly plaintext: Uint8Array }) {
  return sealPairBoxWith(input, newNonce());
}

/** The plaintext of a box, or undefined when `s`, `x`, the way, the type or any byte differs. */
export async function openPairBox(
  input: PairBoxInput & { readonly box: PairBox },
): Promise<Uint8Array | undefined> {
  const nonce = fromBase64url(String(input.box.nonce));
  const sealed = fromBase64url(String(input.box.ciphertext));
  if (nonce === undefined || sealed === undefined) return undefined;
  const key = await boxKey(input.direction, input.s, input.x);
  try {
    return await aeadDecrypt(key, nonce, sealed, boxData(input.x, input.type));
  } finally {
    await wipe(key);
  }
}

// --- the bridge's encryption key -------------------------------------------------------------------

/**
 * The bridge's long-term X25519 key: drawn from the machine key's
 * seed, so that the keychain holds one secret for the machine and the bridge needs no second slot.
 * The same seed always gives the same pair.
 */
export async function deriveBridgeEncryptionKey(machineSeed: Uint8Array): Promise<X25519KeyPair> {
  if (machineSeed.length !== 32) throw new TypeError("a seed has 32 bytes");
  const secretKey = await deriveKey("apbrenc1", machineSeed);
  return { publicKey: await x25519PublicKey(secretKey), secretKey };
}

// --- the messages of the rendezvous ----------------------------------------------------------------

/** A message of the rendezvous as the relay carries it: the JSON of a `PairWire`, in base64url. */
export function encodePairWire(wire: PairWire): string {
  return toBase64url(utf8(JSON.stringify(wire)));
}

/** The message a text holds, or undefined when it is not a well-formed `PairWire`. */
export function decodePairWire(data: string): PairWire | undefined {
  const bytes = fromBase64url(data);
  const text = bytes === undefined ? undefined : fromUtf8(bytes);
  if (text === undefined) return undefined;
  try {
    const parsed = PairWireSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
