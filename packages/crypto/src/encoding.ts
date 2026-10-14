import { isCanonicalBase64url } from "@agentplugged/protocol";

// Portable (Node, browsers, React Native): no Buffer, no node:crypto.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Base64url without padding (RFC 4648 §5). */
export function toBase64url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let c = 0; c < chars; c++) out += ALPHABET.charAt((n >> (18 - 6 * c)) & 0x3f);
  }
  return out;
}

/** Bytes of a base64url text; undefined when the text is not canonical base64url. */
export function fromBase64url(text: string): Uint8Array | undefined {
  if (!isCanonicalBase64url(text)) return undefined;
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
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** The text of UTF-8 bytes; undefined when they are not valid UTF-8. */
export function fromUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
