/**
 * The seal of a shared page. A link has its own key, made by the browser that creates it and
 * carried only in the fragment of the link; the page is sealed with AES-256-GCM (Web Crypto, so the
 * page that reads a link loads no cryptography library and needs no WebAssembly). The associated
 * data names the use, so a page sealed for another purpose does not open.
 *
 * This file stands alone on purpose (no import of the rest of the package): the public page that
 * opens a link loads only it.
 */

const KEY_BYTES = 32;
const IV_BYTES = 12;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

type Subtle = typeof globalThis.crypto.subtle;

function subtle(): Subtle {
  const found = (globalThis as { crypto?: { subtle?: Subtle } }).crypto?.subtle;
  if (found === undefined) throw new Error("This browser has no Web Crypto.");
  return found;
}

/** Base64url without padding (RFC 4648 section 5). */
export function shareEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let c = 0; c < chars; c++) out += ALPHABET.charAt((n >> (18 - 6 * c)) & 0x3f);
  }
  return out;
}

/** The bytes of a base64url text, or `undefined` when it is not canonical base64url. */
export function shareDecode(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return undefined;
  const out = new Uint8Array(Math.floor((text.length * 6) / 8));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of text) {
    value = (value << 6) | ALPHABET.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >> bits) & 0xff;
      value &= (1 << bits) - 1;
    }
  }
  // Leftover bits must be zero: one text, one value.
  return value === 0 ? out : undefined;
}

const textBytes = (text: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;

export interface SealedShare {
  /** The key of this link: 32 random bytes. It goes into the fragment of the link and nowhere else. */
  readonly key: Uint8Array;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
}

/** Seals a page with a new key made for this link. */
export async function sealShare(plain: Uint8Array, context: string): Promise<SealedShare> {
  const key = globalThis.crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const imported = await subtle().importKey(
    "raw",
    key as Uint8Array<ArrayBuffer>,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const sealed = await subtle().encrypt(
    {
      name: "AES-GCM",
      iv: nonce as Uint8Array<ArrayBuffer>,
      additionalData: textBytes(context),
    },
    imported,
    plain as Uint8Array<ArrayBuffer>,
  );
  return { key, nonce, ciphertext: new Uint8Array(sealed) };
}

/** The page, or `undefined` when the key, the nonce, the context or the bytes do not match. */
export async function openShare(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  context: string,
): Promise<Uint8Array | undefined> {
  if (key.length !== KEY_BYTES || nonce.length !== IV_BYTES) return undefined;
  try {
    const imported = await subtle().importKey(
      "raw",
      key as Uint8Array<ArrayBuffer>,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    const plain = await subtle().decrypt(
      {
        name: "AES-GCM",
        iv: nonce as Uint8Array<ArrayBuffer>,
        additionalData: textBytes(context),
      },
      imported,
      ciphertext as Uint8Array<ArrayBuffer>,
    );
    return new Uint8Array(plain);
  } catch {
    return undefined;
  }
}
