import { setTimeout as sleep } from "node:timers/promises";
import { type KeyStore, keychainFull } from "@agentplugged/core";

/**
 * Keychain entries: service `agentplugged`, accounts `machine`, `human`, `human-presence` and
 * `product:<product_id>` (the product keys), and `product:<product_id>:previous:<key_id>`
 * (a product key replaced by `key import`).
 */
export const KEYCHAIN_SERVICE = "agentplugged";
export const KEYCHAIN_ACCOUNT = "machine";
/** The creator's `locale` key. */
export const KEYCHAIN_HUMAN_ACCOUNT = "human";
/** The public part of the creator's `presence` credential: not a secret. */
export const KEYCHAIN_PRESENCE_ACCOUNT = "human-presence";
/** Prefix of the product keys' accounts: `product:<product_id>`. */
export const PRODUCT_ACCOUNT = "product:";

function productAccount(productId: string): string {
  return `${PRODUCT_ACCOUNT}${productId}`;
}

/**
 * The waits before the re-reads of an entry that reads empty, or not as just written: five, 620 ms
 * in all. The Windows Credential Manager sometimes answers empty right after a successful write
 * when several processes use it (measured: up to 142 empty reads in 2,400 operations, with 16
 * processes).
 */
export const KEYCHAIN_SETTLE_DELAYS_MS: readonly number[] = [20, 40, 80, 160, 320];

/**
 * The Windows Credential Manager refuses any new entry once full (about 1,000 entries):
 * `CredWriteW` fails with `ERROR_NOT_ENOUGH_MEMORY` (8) or `ERROR_OUTOFMEMORY` (14), which
 * `@napi-rs/keyring` reports as "… Windows error code 8".
 */
const KEYCHAIN_FULL = /\bWindows error code (?:8|14)\b/;

/** True when `error` says the system keychain is full (never on a read: only writes add). */
export function isKeychainFullError(error: unknown): boolean {
  return KEYCHAIN_FULL.test(error instanceof Error ? error.message : String(error));
}

type Keyring = typeof import("@napi-rs/keyring");

let keyring: Promise<Keyring> | undefined;

/** `@napi-rs/keyring`, loaded on first use only (a native module). */
function load(): Promise<Keyring> {
  keyring ??= import("@napi-rs/keyring").catch((error: unknown) => {
    keyring = undefined;
    throw error;
  });
  return keyring;
}

/**
 * On Linux, the keys go to the Secret Service only (GNOME Keyring, KWallet, KeePassXC...). Left to
 * itself, `@napi-rs/keyring` falls back on the kernel keyring when no Secret Service answers: that
 * one lives in memory and is emptied at the next restart, so a machine key or a product key would
 * be lost without a word. Without a Secret Service, the keychain is said unavailable instead.
 */
export const KEYCHAIN_ENTRY_OPTIONS = { linux: { store: "secret-service" } } as const;

/**
 * A keychain failure as the creator should read it: on Linux, when the Secret Service cannot be
 * reached, what is missing comes first and the system's own message after it. Any other failure
 * is returned as it is.
 */
export function explainKeychainError(
  error: unknown,
  platform: NodeJS.Platform = process.platform,
): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (platform !== "linux" || !/secret.?service|d-?bus|platform secure storage/i.test(message)) {
    return error;
  }
  return new Error(
    `the Secret Service of this Linux session could not be used: start one and unlock its default keyring (GNOME Keyring, KWallet or KeePassXC; on a machine without a desktop, gnome-keyring-daemon --unlock in a dbus-run-session), then run the command again. The system said: ${message}`,
    { cause: error },
  );
}

/** `operation`, its failure explained by `explainKeychainError`. */
async function explained<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw explainKeychainError(error);
  }
}

/**
 * `KeyStore` in the system keychain (Windows Credential Manager, macOS Keychain, the Secret
 * Service on Linux), through `@napi-rs/keyring`. Tests pass their own service name
 * and delete their entries afterwards: the machine's real entries are never touched.
 */
export class NodeKeyStore implements KeyStore {
  readonly service: string;
  /** The machine key's account. */
  readonly account: string;
  readonly humanAccount: string;
  readonly presenceAccount: string;
  /**
   * The waits before the re-reads (`settle`). Only the Windows Credential Manager was seen
   * answering empty under concurrent access: elsewhere, none (no wait added to a first `init`).
   */
  readonly settleDelays: readonly number[];
  constructor(
    options: {
      service?: string;
      account?: string;
      humanAccount?: string;
      presenceAccount?: string;
      /** The waits of `settle`: `KEYCHAIN_SETTLE_DELAYS_MS` on Windows, none elsewhere. */
      settleDelays?: readonly number[];
    } = {},
  ) {
    this.service = options.service ?? KEYCHAIN_SERVICE;
    this.account = options.account ?? KEYCHAIN_ACCOUNT;
    this.humanAccount = options.humanAccount ?? KEYCHAIN_HUMAN_ACCOUNT;
    this.presenceAccount = options.presenceAccount ?? KEYCHAIN_PRESENCE_ACCOUNT;
    this.settleDelays =
      options.settleDelays ?? (process.platform === "win32" ? KEYCHAIN_SETTLE_DELAYS_MS : []);
  }

  /** Waits `settleDelays[attempt]`; false once they are all spent. */
  async settle(attempt: number): Promise<boolean> {
    const delay = this.settleDelays[attempt];
    if (delay === undefined) return false;
    await sleep(delay);
    return true;
  }

  /** The entry of `account`; on Linux, in the Secret Service only (`KEYCHAIN_ENTRY_OPTIONS`). */
  async #entry(account: string) {
    const { AsyncEntry } = await load();
    return new AsyncEntry(this.service, account, KEYCHAIN_ENTRY_OPTIONS);
  }

  #read(account: string): Promise<string | undefined> {
    return explained(async () => {
      const secret = await (await this.#entry(account)).getPassword();
      return secret ?? undefined;
    });
  }

  /** A full keychain gives `KEYCHAIN_FULL`; any other failure is thrown, explained. */
  async #write(account: string, value: string): Promise<void> {
    const entry = await explained(() => this.#entry(account));
    try {
      await entry.setPassword(value);
    } catch (error) {
      if (isKeychainFullError(error)) {
        throw keychainFull(error instanceof Error ? error.message : String(error));
      }
      throw explainKeychainError(error);
    }
  }

  readMachineSecret(): Promise<string | undefined> {
    return this.#read(this.account);
  }

  writeMachineSecret(secret: string): Promise<void> {
    return this.#write(this.account, secret);
  }

  readHumanSecret(): Promise<string | undefined> {
    return this.#read(this.humanAccount);
  }

  writeHumanSecret(secret: string): Promise<void> {
    return this.#write(this.humanAccount, secret);
  }

  readPresenceCredential(): Promise<string | undefined> {
    return this.#read(this.presenceAccount);
  }

  writePresenceCredential(value: string): Promise<void> {
    return this.#write(this.presenceAccount, value);
  }

  readProductSecret(productId: string): Promise<string | undefined> {
    return this.#read(productAccount(productId));
  }

  writeProductSecret(productId: string, secret: string): Promise<void> {
    return this.#write(productAccount(productId), secret);
  }

  writeProductBackup(productId: string, keyId: string, secret: string): Promise<void> {
    return this.#write(`${productAccount(productId)}:previous:${keyId}`, secret);
  }

  /** Deletes the machine key's entry; true when there was one. */
  deleteMachineSecret(): Promise<boolean> {
    return explained(async () => (await this.#entry(this.account)).deleteCredential());
  }

  /**
   * Deletes the entries of this service, product keys included (tests: a service of their own).
   * True when there was at least one. Refused on the real service: the creator's keys are never
   * deleted.
   */
  async deleteAll(): Promise<boolean> {
    if (this.service === KEYCHAIN_SERVICE) {
      throw new Error(`deleteAll refuses the real keychain service ${KEYCHAIN_SERVICE}`);
    }
    let deleted = false;
    const products = await load()
      .then(({ findCredentialsAsync }) => findCredentialsAsync(this.service))
      .then((found) =>
        found.map((entry) => entry.account).filter((name) => name.startsWith(PRODUCT_ACCOUNT)),
      )
      .catch(() => [] as string[]);
    for (const account of [this.account, this.humanAccount, this.presenceAccount, ...products]) {
      deleted = (await (await this.#entry(account)).deleteCredential()) || deleted;
    }
    return deleted;
  }
}
