import type { EventEnvelope, UnsignedEventEnvelope } from "@agentplugged/protocol";
import { signedBytes } from "./canonical.js";
import { toBase64url } from "./encoding.js";
import { sodium } from "./sodium.js";

export type Ed25519KeyPair = {
  /** 32 bytes. */
  publicKey: Uint8Array;
  /** 64 bytes (libsodium format: seed then public key). Never leaves the device. */
  secretKey: Uint8Array;
};

/**
 * A new Ed25519 key pair; from `seed` (32 bytes) when given: the same seed always gives the same
 * pair (test vectors, or a machine key stored as its seed).
 */
export async function generateEd25519(
  options: { seed?: Uint8Array } = {},
): Promise<Ed25519KeyPair> {
  const lib = await sodium();
  const pair =
    options.seed === undefined
      ? lib.crypto_sign_keypair()
      : lib.crypto_sign_seed_keypair(options.seed);
  return { publicKey: pair.publicKey, secretKey: pair.privateKey };
}

/** Signs an envelope with `alg: ed25519`: returns it with `sig` (detached, base64url). */
export async function signEd25519(
  env: UnsignedEventEnvelope | EventEnvelope,
  secretKey: Uint8Array,
): Promise<EventEnvelope> {
  if (env.alg !== "ed25519") throw new TypeError(`signEd25519: alg is ${env.alg}, not ed25519`);
  const lib = await sodium();
  const { sig: _previous, ...unsigned } = env as EventEnvelope;
  const sig = lib.crypto_sign_detached(signedBytes(unsigned), secretKey);
  return { ...unsigned, sig: toBase64url(sig) };
}

/** The detached Ed25519 signature (64 bytes) of `message` by `secretKey` (libsodium format). */
export async function signBytesEd25519(
  message: Uint8Array,
  secretKey: Uint8Array,
): Promise<Uint8Array> {
  const lib = await sodium();
  return lib.crypto_sign_detached(message, secretKey);
}

/** True when `sig` is the Ed25519 signature of `message` by `publicKey`. */
export async function verifyEd25519(
  message: Uint8Array,
  sig: Uint8Array,
  publicKey: Uint8Array,
): Promise<boolean> {
  const lib = await sodium();
  try {
    return lib.crypto_sign_verify_detached(sig, message, publicKey);
  } catch {
    return false;
  }
}
