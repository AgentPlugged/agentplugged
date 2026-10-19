import { utf8 } from "./encoding.js";
import { randomBytes } from "./hash.js";
import {
  AEAD_KEY_BYTES,
  AEAD_NONCE_BYTES,
  aeadDecrypt,
  aeadEncrypt,
  concatBytes,
} from "./primitives.js";

/**
 * How a device seals what it keeps for itself on its own storage (the last state it received and
 * the orders waiting to be sent). The `context` names the slot the bytes belong to and is bound to
 * the ciphertext as associated data, so a sealed value moved to another slot does not open. It is
 * plain text on purpose: the associated data of the mobile engine must be valid UTF-8.
 */
export interface CacheCipher {
  seal(plain: Uint8Array, context: string): Promise<Uint8Array>;
  /** The plaintext, or undefined when the bytes, the key or the context do not match. */
  open(sealed: Uint8Array, context: string): Promise<Uint8Array | undefined>;
}

/**
 * A cipher over a 32-byte key the host keeps in its secure store (the phone). XChaCha20-Poly1305,
 * a fresh random nonce in front of each ciphertext.
 */
export function createAeadCacheCipher(key: Uint8Array): CacheCipher {
  if (key.length !== AEAD_KEY_BYTES) throw new Error("The cache key must be 32 bytes.");
  return {
    async seal(plain, context) {
      const nonce = randomBytes(AEAD_NONCE_BYTES);
      return concatBytes(nonce, await aeadEncrypt(key, nonce, plain, utf8(context)));
    },
    async open(sealed, context) {
      if (sealed.length <= AEAD_NONCE_BYTES) return undefined;
      return await aeadDecrypt(
        key,
        sealed.slice(0, AEAD_NONCE_BYTES),
        sealed.slice(AEAD_NONCE_BYTES),
        utf8(context),
      );
    },
  };
}

/** The Web Crypto interface the browser cipher needs (the globals of a page, or Node.js in a test). */
type Subtle = typeof globalThis.crypto.subtle;
/** An AES key held by the browser: it has no bytes a script can read. */
export type BrowserCacheKey = Awaited<ReturnType<Subtle["generateKey"]>> & object;

const BROWSER_IV_BYTES = 12;

function subtleOfHost(host?: { subtle?: Subtle }): Subtle {
  const subtle = host?.subtle ?? (globalThis as { crypto?: { subtle?: Subtle } }).crypto?.subtle;
  if (subtle === undefined) throw new Error("This browser has no Web Crypto.");
  return subtle;
}

/**
 * A new key for a browser's cache, made by the browser itself and not exportable: nothing can copy
 * it out of the browser, whatever storage holds the sealed data. Rejects when the browser lacks
 * AES-GCM or hands out a key that can be read.
 */
export async function createBrowserCacheKey(host?: { subtle?: Subtle }): Promise<BrowserCacheKey> {
  const subtle = subtleOfHost(host);
  const key = (await subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ])) as BrowserCacheKey;
  if (!(await browserCacheKeyIsUnreadable(key, host))) {
    throw new Error("This browser hands out readable keys.");
  }
  return key;
}

/** Whether a key read back from the browser's storage still cannot be exported. */
export async function browserCacheKeyIsUnreadable(
  key: BrowserCacheKey,
  host?: { subtle?: Subtle },
): Promise<boolean> {
  const subtle = subtleOfHost(host);
  const handle = key as unknown as { extractable?: boolean };
  if (handle.extractable !== false) return false;
  try {
    await subtle.exportKey("raw", key as never);
    return false;
  } catch {
    return true;
  }
}

/** A cipher over a browser's non-exportable key: AES-256-GCM, a fresh random IV in front. */
export function createBrowserCacheCipher(
  key: BrowserCacheKey,
  host?: { subtle?: Subtle },
): CacheCipher {
  return {
    async seal(plain, context) {
      const subtle = subtleOfHost(host);
      const iv = randomBytes(BROWSER_IV_BYTES);
      const sealed = new Uint8Array(
        await subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: utf8(context) },
          key as never,
          plain,
        ),
      );
      return concatBytes(iv, sealed);
    },
    async open(sealed, context) {
      const subtle = subtleOfHost(host);
      if (sealed.length <= BROWSER_IV_BYTES) return undefined;
      try {
        return new Uint8Array(
          await subtle.decrypt(
            {
              name: "AES-GCM",
              iv: sealed.slice(0, BROWSER_IV_BYTES),
              additionalData: utf8(context),
            },
            key as never,
            sealed.slice(BROWSER_IV_BYTES),
          ),
        );
      } catch {
        return undefined;
      }
    },
  };
}
