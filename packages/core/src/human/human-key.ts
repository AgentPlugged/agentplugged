import { sha256, toBase64url } from "@agentplugged/crypto";
import {
  ErrorCode,
  type PresenceCredential,
  PresenceCredentialSchema,
} from "@agentplugged/protocol";
import { AgentPluggedError } from "../errors.js";
import {
  createKey,
  isStored,
  type KeyKind,
  type KeyStore,
  keyFromSecret,
  type MachineLock,
  settledRead,
} from "../journal/key-store.js";

/**
 * The creator's `locale` key: an Ed25519 key in the system keychain (account `human`),
 * created once per machine, and the device identifier drawn from it.
 */
export interface HumanKey {
  readonly publicKey: Uint8Array;
  /** 64 bytes (libsodium format). Never written anywhere but the keychain (as its seed). */
  readonly secretKey: Uint8Array;
  /** `human:` then the first 16 base64url characters of the SHA-256 of the public key. */
  readonly device: string;
  /** True when the key was created by this call. */
  readonly created: boolean;
}

/** `actor.device` of the creator: `human:` then 16 base64url characters of SHA-256(public key). */
export function humanDevice(publicKey: Uint8Array): string {
  return `human:${toBase64url(sha256(publicKey)).slice(0, 16)}`;
}

const humanKind = (keys: KeyStore): KeyKind => ({
  label: "the creator's key",
  device: humanDevice,
  read: () => keys.readHumanSecret(),
  write: (secret) => keys.writeHumanSecret(secret),
});

/**
 * The creator's `locale` key from the keychain; on the first use on this machine, a new Ed25519
 * pair is generated and its seed stored, under `lock` (the machine-wide lock of key creation),
 * the keychain being read again inside it: two processes never create two keys. With
 * `create: false`, undefined when there is none yet, its absence confirmed by re-reads.
 */
export async function loadHumanKey(
  keys: KeyStore,
  options: { lock?: MachineLock; create?: boolean } = {},
): Promise<HumanKey | undefined> {
  const kind = humanKind(keys);
  const stored = await kind.read();
  if (stored !== undefined) return keyFromSecret(kind, stored, false);
  if (options.create === false) {
    // Said missing only once re-reads confirm it: the callers refuse the command then.
    const confirmed = await settledRead(keys, kind.read, isStored);
    return confirmed === undefined ? undefined : keyFromSecret(kind, confirmed, false);
  }
  const lock: MachineLock = options.lock ?? ((task) => task());
  return lock(() => createKey(keys, kind));
}

/**
 * The `presence` credential created on this machine (public part), or undefined. With
 * `confirmAbsence` (before one is created), said absent only once re-reads confirm it.
 */
export async function readStoredPresence(
  keys: KeyStore,
  options: { confirmAbsence?: boolean } = {},
): Promise<PresenceCredential | undefined> {
  const read = () => keys.readPresenceCredential();
  const stored =
    options.confirmAbsence === true ? await settledRead(keys, read, isStored) : await read();
  if (stored === undefined) return undefined;
  try {
    const parsed = PresenceCredentialSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Keeps the `presence` credential's public part in the keychain, next to the `locale` key. */
export async function storePresence(keys: KeyStore, credential: PresenceCredential): Promise<void> {
  const { credential_id, cose_public_key, alg } = credential;
  const value = JSON.stringify({ credential_id, cose_public_key, alg });
  await keys.writePresenceCredential(value);
  const kept = await settledRead(
    keys,
    () => keys.readPresenceCredential(),
    (read) => read === value,
  );
  if (kept !== value) {
    throw new AgentPluggedError(ErrorCode.UNEXPECTED, "error.keychain_unavailable", {
      reason: "the system keychain did not keep the presence credential",
    });
  }
}
