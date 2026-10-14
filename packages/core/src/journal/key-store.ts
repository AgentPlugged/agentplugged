import { fromBase64url, generateEd25519, sha256, toBase64url } from "@agentplugged/crypto";
import { ErrorCode } from "@agentplugged/protocol";
import { AgentPluggedError } from "../errors.js";

/**
 * Port to the system keychain, where the secret keys live (never in the repository): the
 * machine's (account `machine`) and the creator's `locale` key (account `human`), each the
 * 32-byte Ed25519 seed in base64url; and the public description of the creator's `presence`
 * credential, when one was created on this machine (its id, COSE key and algorithm, in JSON).
 */
export interface KeyStore {
  /** The stored secret, or undefined when this machine has none yet. */
  readMachineSecret(): Promise<string | undefined>;
  /** Stores the secret, replacing any previous one. */
  writeMachineSecret(secret: string): Promise<void>;
  /** The creator's `locale` seed, or undefined when this machine has none yet. */
  readHumanSecret(): Promise<string | undefined>;
  /** Stores the creator's `locale` seed, replacing any previous one. */
  writeHumanSecret(secret: string): Promise<void>;
  /** The creator's `presence` credential (public part, JSON), or undefined. */
  readPresenceCredential(): Promise<string | undefined>;
  /** Stores the creator's `presence` credential (public part, JSON). */
  writePresenceCredential(value: string): Promise<void>;
  /**
   * The product key of `productId` (account `product:<product_id>`): its 32 bytes in
   * base64url, or undefined when this machine does not hold it.
   */
  readProductSecret(productId: string): Promise<string | undefined>;
  /** Stores the product key of `productId`, replacing any previous one. */
  writeProductSecret(productId: string, secret: string): Promise<void>;
  /**
   * Keeps a product key being replaced (`key import`), under the account
   * `product:<product_id>:previous:<key_id>`: never deleted by the engine.
   */
  writeProductBackup(productId: string, keyId: string, secret: string): Promise<void>;
  /**
   * Waits before re-read number `attempt` (from 0) of an entry that reads empty, or not as just
   * written (after a write, and before a key is created), and resolves true; false when there is
   * no re-read left. A system keychain may answer empty for a moment under concurrent access
   * (Windows Credential Manager). Absent: the store is always consistent (memory), never re-read.
   */
  settle?(attempt: number): Promise<boolean>;
}

/**
 * `read`, then read again after each wait of `keys.settle` while the value is not `accepted`:
 * the last value read. A failing read is thrown at once, never retried nor taken for "empty".
 */
export async function settledRead(
  keys: KeyStore,
  read: () => Promise<string | undefined>,
  accepted: (value: string | undefined) => boolean,
): Promise<string | undefined> {
  let value = await read();
  for (let attempt = 0; !accepted(value) && keys.settle !== undefined; attempt += 1) {
    if (!(await keys.settle(attempt))) break;
    value = await read();
  }
  return value;
}

/** An entry is there: the absence of a key is confirmed by every re-read before one is created. */
export const isStored = (value: string | undefined): boolean => value !== undefined;

/**
 * `KEYCHAIN_FULL`: the system keychain refuses any new entry (Windows Credential Manager full).
 * `reason` is the system's message, never a secret.
 */
export function keychainFull(reason: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.KEYCHAIN_FULL, "error.keychain_full", { reason });
}

/** `KeyStore` in memory: tests, and processes that must not touch the system keychain. */
export class MemoryKeyStore implements KeyStore {
  secret: string | undefined;
  human: string | undefined;
  presence: string | undefined;
  writes = 0;
  humanWrites = 0;

  constructor(secret?: string, human?: string) {
    this.secret = secret;
    this.human = human;
  }

  async readMachineSecret(): Promise<string | undefined> {
    return this.secret;
  }

  async writeMachineSecret(secret: string): Promise<void> {
    this.writes += 1;
    this.secret = secret;
  }

  async readHumanSecret(): Promise<string | undefined> {
    return this.human;
  }

  async writeHumanSecret(secret: string): Promise<void> {
    this.humanWrites += 1;
    this.human = secret;
  }

  async readPresenceCredential(): Promise<string | undefined> {
    return this.presence;
  }

  async writePresenceCredential(value: string): Promise<void> {
    this.presence = value;
  }

  /** Product keys by product id (base64url). */
  readonly products = new Map<string, string>();
  productWrites = 0;

  async readProductSecret(productId: string): Promise<string | undefined> {
    return this.products.get(productId);
  }

  async writeProductSecret(productId: string, secret: string): Promise<void> {
    this.productWrites += 1;
    this.products.set(productId, secret);
  }

  /** Product keys replaced, by `<product_id>:<key_id>`. */
  readonly backups = new Map<string, string>();

  async writeProductBackup(productId: string, keyId: string, secret: string): Promise<void> {
    this.backups.set(`${productId}:${keyId}`, secret);
  }
}

/** The machine's Ed25519 key, and the device identifier derived from it. */
export interface MachineKey {
  readonly publicKey: Uint8Array;
  /** 64 bytes (libsodium format). Never written anywhere but the keychain (as its seed). */
  readonly secretKey: Uint8Array;
  /** `machine:` then the first 16 base64url characters of the SHA-256 of the public key. */
  readonly device: string;
  /** True when the key was created by this call. */
  readonly created: boolean;
}

/** `actor.device` of a machine: `machine:` then 16 base64url characters of SHA-256(public key). */
export function machineDevice(publicKey: Uint8Array): string {
  return `machine:${toBase64url(sha256(publicKey)).slice(0, 16)}`;
}

/** Runs `task` while holding a machine-wide exclusive lock (one per user account). */
export type MachineLock = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * The machine key from the keychain; on the first use on this machine, a new Ed25519 pair is
 * generated and its seed stored. Creation runs under `lock` (machine-wide), and the keychain is
 * read again inside it, so two processes, even in different repositories, never create two keys.
 */
export async function loadMachineKey(
  keys: KeyStore,
  options: { lock?: MachineLock } = {},
): Promise<MachineKey> {
  const kind = machineKind(keys);
  const stored = await kind.read();
  if (stored !== undefined) return keyFromSecret(kind, stored, false);
  const lock: MachineLock = options.lock ?? ((task) => task());
  return lock(() => createKey(keys, kind));
}

/** One kind of key of the keychain (the machine's, the creator's): what tells it from the others. */
export interface KeyKind {
  /** How messages call it: « the machine key », « the creator's key ». */
  readonly label: string;
  /** `actor.device` drawn from the public key. */
  readonly device: (publicKey: Uint8Array) => string;
  readonly read: () => Promise<string | undefined>;
  readonly write: (secret: string) => Promise<void>;
}

/** An Ed25519 key built from the seed the keychain holds (base64url, 32 bytes). */
export async function keyFromSecret(
  kind: KeyKind,
  secret: string,
  created: boolean,
): Promise<MachineKey> {
  const seed = fromBase64url(secret);
  if (seed === undefined || seed.length !== 32) {
    throw new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
      reason: `${kind.label} in the system keychain is not a 32-byte base64url seed`,
    });
  }
  const pair = await generateEd25519({ seed });
  return {
    publicKey: pair.publicKey,
    secretKey: pair.secretKey,
    device: kind.device(pair.publicKey),
    created,
  };
}

/**
 * Creates a key, under the lock: its absence is confirmed by re-reads first (an empty answer of a
 * busy keychain never replaces a key), and the key written is read back (re-read while empty)
 * before it is used. Another value under the lock is a stale read or a writer outside it: never
 * adopted.
 */
export async function createKey(keys: KeyStore, kind: KeyKind): Promise<MachineKey> {
  const existing = await settledRead(keys, kind.read, isStored);
  if (existing !== undefined) return keyFromSecret(kind, existing, false);
  const pair = await generateEd25519();
  const secret = toBase64url(pair.secretKey.slice(0, 32));
  await kind.write(secret);
  const kept = await settledRead(keys, kind.read, (value) => value === secret);
  if (kept !== secret) {
    throw new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
      reason: `the system keychain did not keep ${kind.label}`,
    });
  }
  return keyFromSecret(kind, kept, true);
}

const machineKind = (keys: KeyStore): KeyKind => ({
  label: "the machine key",
  device: machineDevice,
  read: () => keys.readMachineSecret(),
  write: (secret) => keys.writeMachineSecret(secret),
});

/**
 * The machine key when the keychain holds one, never created: undefined when it has none, its
 * absence confirmed by re-reads (`settle`).
 */
export async function readMachineKey(keys: KeyStore): Promise<MachineKey | undefined> {
  const kind = machineKind(keys);
  const stored = await settledRead(keys, kind.read, isStored);
  return stored === undefined ? undefined : keyFromSecret(kind, stored, false);
}
