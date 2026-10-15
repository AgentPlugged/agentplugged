import { setTimeout as sleep } from "node:timers/promises";
import { type KeyStore, keychainFull } from "@agentplugged/core";
import { type CredentialBackend, PowerShellCredentials } from "./windows-credentials.js";

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

/** What Windows says when it refuses a file under Smart App Control or an application control policy. */
const BLOCKED_BY_POLICY =
  /application control|blocked this file|smart app control|signing level|code integrity|contr.le d.application|bloqu. ce fichier|error 4551|0x800711c7/i;

/** The message of `error` and of the errors under its `cause`, outermost first. */
function messageChain(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 20 && current !== undefined && current !== null; depth += 1) {
    messages.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return messages;
}

/**
 * The error for a keychain that cannot be reached at all: `native` is why `@napi-rs/keyring` did
 * not load and, on Windows, `powershell` why the PowerShell helper could not be used. Says what
 * blocks, in plain words: the generic "npm has a bug" of the module's loader never stands alone,
 * and a Windows policy blocking the module is named, with the file.
 */
export function unavailableKeychainError(native: unknown, powershell?: unknown): Error {
  const real = messageChain(native).filter(
    (message) => !/cannot find native binding|npm has a bug/i.test(message),
  );
  const blocked = real.find((message) => BLOCKED_BY_POLICY.test(message));
  const file =
    blocked === undefined ? undefined : /[A-Za-z]:\\[^\r\n"']*?\.node/.exec(blocked)?.[0];
  const viaPowerShell =
    powershell === undefined
      ? ""
      : ` The keys could not be reached through Windows PowerShell either (${messageChain(powershell)[0]}).`;
  if (blocked !== undefined) {
    const said = blocked.split(/\r?\n/).find((line) => line.trim() !== "") ?? blocked;
    return new Error(
      `Windows blocked the system keychain module${file === undefined ? "" : ` (${file})`}: Smart App Control or an application control policy refuses this unsigned file ("${said.trim()}").${viaPowerShell} Turn off Smart App Control (Windows Security, App & browser control) or allow this file in your application control policy, make sure Windows PowerShell can run in full language mode, then run the command again.`,
      { cause: native },
    );
  }
  const why = real.length > 0 ? real.join("; ") : "Node gave no further reason";
  return new Error(`the system keychain module could not be loaded: ${why}.${viaPowerShell}`, {
    cause: native,
  });
}

/** The keychain through `@napi-rs/keyring`. */
async function nativeBackend(): Promise<CredentialBackend> {
  const { AsyncEntry, findCredentialsAsync } = await load().catch((error: unknown) => {
    throw unavailableKeychainError(error);
  });
  const entry = (service: string, account: string) =>
    new AsyncEntry(service, account, KEYCHAIN_ENTRY_OPTIONS);
  return {
    read: async (service, account) => (await entry(service, account).getPassword()) ?? undefined,
    write: (service, account, secret) => entry(service, account).setPassword(secret),
    remove: (service, account) => entry(service, account).deleteCredential(),
    accounts: async (service) =>
      (await findCredentialsAsync(service)).map((found) => found.account),
  };
}

let system: Promise<CredentialBackend> | undefined;

/**
 * The system keychain of this machine: `@napi-rs/keyring`, and on Windows the PowerShell helper
 * when the native module cannot be loaded (Smart App Control may refuse it). The native module
 * comes first: it answers at once, where the helper compiles itself in each new process. Chosen
 * once per process, kept once it works.
 */
export function systemCredentials(): Promise<CredentialBackend> {
  system ??= (async () => {
    try {
      return await nativeBackend();
    } catch (error) {
      if (process.platform !== "win32") throw error;
      try {
        return await PowerShellCredentials.open();
      } catch (powershell) {
        throw unavailableKeychainError(nativeCause(error), powershell);
      }
    }
  })().catch((error: unknown) => {
    system = undefined;
    throw error;
  });
  return system;
}

/** The error `@napi-rs/keyring` failed with, under the explained one `nativeBackend` throws. */
function nativeCause(error: unknown): unknown {
  return error instanceof Error && error.cause !== undefined ? error.cause : error;
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
 * Service on Linux): through `@napi-rs/keyring`, or on Windows a PowerShell helper when the
 * native module cannot be loaded (`systemCredentials`). Tests pass their own service
 * name and delete their entries afterwards: the machine's real entries are never touched.
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
  readonly #engine: "system" | "native";
  constructor(
    options: {
      service?: string;
      account?: string;
      humanAccount?: string;
      presenceAccount?: string;
      /** The waits of `settle`: `KEYCHAIN_SETTLE_DELAYS_MS` on Windows, none elsewhere. */
      settleDelays?: readonly number[];
      /** How the keychain is reached: the system's choice (default), or `@napi-rs/keyring` only. */
      engine?: "system" | "native";
    } = {},
  ) {
    this.service = options.service ?? KEYCHAIN_SERVICE;
    this.account = options.account ?? KEYCHAIN_ACCOUNT;
    this.humanAccount = options.humanAccount ?? KEYCHAIN_HUMAN_ACCOUNT;
    this.presenceAccount = options.presenceAccount ?? KEYCHAIN_PRESENCE_ACCOUNT;
    this.#engine = options.engine ?? "system";
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

  #backend(): Promise<CredentialBackend> {
    return this.#engine === "native" ? nativeBackend() : systemCredentials();
  }

  #read(account: string): Promise<string | undefined> {
    return explained(async () => (await this.#backend()).read(this.service, account));
  }

  /** A full keychain gives `KEYCHAIN_FULL`; any other failure is thrown, explained. */
  async #write(account: string, value: string): Promise<void> {
    const backend = await explained(() => this.#backend());
    try {
      await backend.write(this.service, account, value);
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
    return explained(async () => (await this.#backend()).remove(this.service, this.account));
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
    const backend = await explained(() => this.#backend());
    const products = await backend
      .accounts(this.service)
      .then((found) => found.filter((name) => name.startsWith(PRODUCT_ACCOUNT)))
      .catch(() => [] as string[]);
    for (const account of [this.account, this.humanAccount, this.presenceAccount, ...products]) {
      deleted = (await backend.remove(this.service, account)) || deleted;
    }
    return deleted;
  }
}
