import { toBase64url } from "./encoding.js";
import { deviceIdOf } from "./primitives.js";

/**
 * The identity keys of a web browser: a signing key (Ed25519) and an encryption key (X25519) that the
 * Web Crypto API of the browser holds and that no script can read out (`extractable: false`). A
 * script can still ask the browser to sign or to agree on a secret with them while the page is open,
 * but it can never copy them: stealing the keys is not possible, using them while the page runs is
 * (the content policy of the page is what protects against that).
 *
 * No secret key ever passes through JavaScript here. The signatures are standard Ed25519 and the
 * agreement is standard X25519, so everything they produce is read by the libsodium side of the
 * other devices byte for byte (the same vectors).
 *
 * A browser that cannot make such keys is refused, never given extractable ones.
 */

/** Why a browser cannot hold its keys. */
export type BrowserKeysFailure =
  /** The page is not in a secure context (not HTTPS): the browser withholds the API. */
  | "insecure_context"
  /** The browser lacks Ed25519 or X25519 in Web Crypto, or hands out keys that can be read out. */
  | "unsupported";

export class BrowserKeysError extends Error {
  constructor(readonly reason: BrowserKeysFailure) {
    super(`This browser cannot hold device keys (${reason}).`);
    this.name = "BrowserKeysError";
  }
}

/** The Web Crypto interface of the host (a browser, or Node.js in a test). */
export type BrowserSubtle = typeof globalThis.crypto.subtle;
/** A key held by the Web Crypto interface: it has no bytes JavaScript can read when not extractable. */
export type BrowserKey = Awaited<ReturnType<BrowserSubtle["importKey"]>>;

/** What of the host's Web Crypto the keys need (the globals of a browser, or a double in a test). */
export interface BrowserCryptoHost {
  readonly subtle?: BrowserSubtle;
  /** `false` in a browser page that is not a secure context. */
  readonly isSecureContext?: boolean;
}

function globalHost(): BrowserCryptoHost {
  const scope = globalThis as { crypto?: { subtle?: BrowserSubtle }; isSecureContext?: boolean };
  return {
    ...(scope.crypto?.subtle === undefined ? {} : { subtle: scope.crypto.subtle }),
    ...(scope.isSecureContext === undefined ? {} : { isSecureContext: scope.isSecureContext }),
  };
}

interface KeyPair {
  readonly privateKey: BrowserKey;
  readonly publicKey: BrowserKey;
}

/** A key pair whose private key is not exportable. */
async function generatePair(
  subtle: BrowserSubtle,
  name: "Ed25519" | "X25519",
  usages: Array<"sign" | "verify" | "deriveBits">,
): Promise<KeyPair> {
  return (await subtle.generateKey({ name }, false, usages)) as unknown as KeyPair;
}

/** The encryption half of a device: the public key, and the private key only the browser can use. */
export interface BrowserEncryptionKey {
  /** 32 bytes. */
  readonly publicKey: Uint8Array;
  readonly privateKey: BrowserKey;
}

/** The keys of a browser. The private keys are opaque handles: they have no bytes to read. */
export interface BrowserDeviceKeys {
  readonly kind: "browser";
  readonly device: string;
  /** 32 bytes. */
  readonly sigPublicKey: Uint8Array;
  readonly signingKey: BrowserKey;
  readonly encryption: BrowserEncryptionKey;
}

/** A shared secret with another device, from a private key that may be unreadable. */
export interface X25519Agreement {
  /** The device's own public key, 32 bytes. */
  readonly publicKey: Uint8Array;
  /** The X25519 secret shared with `otherPublicKey`; undefined when that key cannot be used. */
  agree(otherPublicKey: Uint8Array): Promise<Uint8Array | undefined>;
}

function subtleOf(host: BrowserCryptoHost): BrowserSubtle {
  if (host.isSecureContext === false) throw new BrowserKeysError("insecure_context");
  if (host.subtle === undefined) throw new BrowserKeysError("unsupported");
  return host.subtle;
}

async function cannotBeRead(subtle: BrowserSubtle, key: BrowserKey): Promise<boolean> {
  if (key.extractable) return false;
  for (const format of ["raw", "pkcs8"] as const) {
    try {
      await subtle.exportKey(format, key);
      return false;
    } catch {
      // Expected: the key refuses to be exported.
    }
  }
  return true;
}

async function publicBytes(subtle: BrowserSubtle, key: BrowserKey): Promise<Uint8Array> {
  const bytes = new Uint8Array(await subtle.exportKey("raw", key));
  if (bytes.length !== 32) throw new BrowserKeysError("unsupported");
  return bytes;
}

/**
 * Whether `keys` (new, or read back from the browser's storage) are what a device may hold: both
 * private keys cannot be exported.
 */
export async function browserKeysAreUnreadable(
  keys: Pick<BrowserDeviceKeys, "signingKey" | "encryption">,
  host: BrowserCryptoHost = globalHost(),
): Promise<boolean> {
  const subtle = host.subtle;
  if (subtle === undefined) return false;
  return (
    (await cannotBeRead(subtle, keys.signingKey)) &&
    (await cannotBeRead(subtle, keys.encryption.privateKey))
  );
}

/**
 * New keys for a browser, made by the browser itself and not exportable. Rejects with a
 * `BrowserKeysError`: `insecure_context` (not HTTPS), or `unsupported` (an algorithm is missing, or
 * the browser gave keys that can be read out).
 */
export async function createBrowserDeviceKeys(
  host: BrowserCryptoHost = globalHost(),
): Promise<BrowserDeviceKeys> {
  const subtle = subtleOf(host);
  let signing: KeyPair;
  let encryption: KeyPair;
  try {
    signing = await generatePair(subtle, "Ed25519", ["sign", "verify"]);
    encryption = await generatePair(subtle, "X25519", ["deriveBits"]);
  } catch {
    throw new BrowserKeysError("unsupported");
  }
  const keys: BrowserDeviceKeys = await (async () => {
    try {
      const sigPublicKey = await publicBytes(subtle, signing.publicKey);
      return {
        kind: "browser" as const,
        device: deviceIdOf("browser", sigPublicKey),
        sigPublicKey,
        signingKey: signing.privateKey,
        encryption: {
          publicKey: await publicBytes(subtle, encryption.publicKey),
          privateKey: encryption.privateKey,
        },
      };
    } catch (error) {
      if (error instanceof BrowserKeysError) throw error;
      throw new BrowserKeysError("unsupported");
    }
  })();
  // A browser that hands out readable keys is refused rather than trusted.
  if (!(await browserKeysAreUnreadable(keys, host))) throw new BrowserKeysError("unsupported");
  return keys;
}

/** The agreement of a browser's encryption key: the browser does the X25519, the key stays in it. */
export function browserAgreement(
  encryption: BrowserEncryptionKey,
  host: BrowserCryptoHost = globalHost(),
): X25519Agreement {
  return {
    publicKey: encryption.publicKey,
    async agree(otherPublicKey) {
      const subtle = subtleOf(host);
      if (otherPublicKey.length !== 32) return undefined;
      try {
        const other = await subtle.importKey("raw", otherPublicKey, { name: "X25519" }, false, []);
        const bits = await subtle.deriveBits(
          { name: "X25519", public: other },
          encryption.privateKey,
          256,
        );
        const shared = new Uint8Array(bits);
        // An all-zero result is a point of low order whatever the engine says about it.
        return shared.some((byte) => byte !== 0) ? shared : undefined;
      } catch {
        // A key of low order: the browser refuses to derive, as libsodium does.
        return undefined;
      }
    },
  };
}

/** A signature of the browser's key (Ed25519, 64 bytes). */
export async function signWithBrowserKey(
  keys: Pick<BrowserDeviceKeys, "signingKey">,
  bytes: Uint8Array,
  host: BrowserCryptoHost = globalHost(),
): Promise<Uint8Array> {
  const subtle = subtleOf(host);
  return new Uint8Array(await subtle.sign({ name: "Ed25519" }, keys.signingKey, bytes));
}

/** The public half of a browser's identity as text, for a message that declares it. */
export function browserPublicKeys(keys: BrowserDeviceKeys): { sig: string; enc: string } {
  return { sig: toBase64url(keys.sigPublicKey), enc: toBase64url(keys.encryption.publicKey) };
}
