import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { KEYCHAIN_ENTRY_OPTIONS } from "./node-key-store.js";

/**
 * Test support, never used by the product: keeps the system keychain clean of the keys the tests
 * and the smoke create. The Windows Credential Manager holds about 1,000 entries;
 * every test run used to leave some, under a service name of its own, until it was full.
 *
 * Two safeguards, both limited to services named like a test's (`TEST_SERVICE_PREFIXES`):
 *  - `removeTestKeys`: a test deletes the keys of its services when it ends, even on failure;
 *  - `sweepStaleTestKeys`: a run starts by deleting the keys of the test services old enough
 *    (read from the timestamp in their name) to be those of a run that was interrupted.
 *
 * A service whose name does not start with a test prefix is never listed for deletion nor deleted:
 * `agentplugged` (the creator's keys), `ap-measure`, `agentplugged-trial-…`, `ap-e2e-…`.
 */

/** The names a test's keychain service starts with: `<prefix><label>-<pid>-<timestamp>`. */
export const TEST_SERVICE_PREFIXES: readonly string[] = [
  "agentplugged-test-",
  "agentplugged-smoke-",
  "zz-stress-",
];

/** A test service this old (or older) is the leftover of an interrupted run: one hour. */
export const STALE_AFTER_MS = 60 * 60 * 1000;

/** The accounts a service may hold besides the product keys (those are found by listing). */
const FIXED_ACCOUNTS: readonly string[] = ["machine", "human", "human-presence"];

/** What the tests need from the system keychain; replaced by a simulated one in the tests of this file. */
export interface KeychainAccess {
  /** The names of all the services that hold at least one entry (best effort per platform). */
  listServices(): Promise<string[]>;
  /** The accounts of the entries of one service. */
  listAccounts(service: string): Promise<string[]>;
  /** Deletes one entry; true when there was one. */
  deleteEntry(service: string, account: string): Promise<boolean>;
}

/** True when `service` is named like a test's. */
export function isTestService(service: string): boolean {
  return TEST_SERVICE_PREFIXES.some(
    (prefix) => service.startsWith(prefix) && service.length > prefix.length,
  );
}

/**
 * The creation time written in a test service's name: a 13-digit number (milliseconds) after a
 * dash, possibly followed by suffixes (`-w<n>` for a worker, `-other`…). Undefined when the name
 * has none.
 */
export function serviceTimestamp(service: string): number | undefined {
  const match = /-(\d{13})(?:-[A-Za-z0-9]+)*$/.exec(service);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** True when `service` is a test service whose name dates it at `maxAgeMs` or more before `now`. */
export function isStaleTestService(
  service: string,
  now: number,
  maxAgeMs = STALE_AFTER_MS,
): boolean {
  if (!isTestService(service)) return false;
  const created = serviceTimestamp(service);
  return created !== undefined && now - created >= maxAgeMs;
}

/**
 * Deletes every entry of the test services `services`. Never throws (a cleanup must not hide the
 * failure of the test it follows): returns the number of entries deleted. Refuses, silently, any
 * service that is not named like a test's.
 */
export async function removeTestKeys(
  services: string | readonly string[],
  keychain: KeychainAccess = systemKeychain(),
): Promise<number> {
  let deleted = 0;
  for (const service of typeof services === "string" ? [services] : services) {
    if (!isTestService(service)) continue;
    const accounts = new Set(FIXED_ACCOUNTS);
    for (const account of await keychain.listAccounts(service).catch(() => [] as string[])) {
      accounts.add(account);
    }
    for (const account of accounts) {
      if (await keychain.deleteEntry(service, account).catch(() => false)) deleted += 1;
    }
  }
  return deleted;
}

/**
 * Deletes the entries of the test services created `maxAgeMs` or more before `now`. Returns the
 * services it emptied. A keychain that cannot be listed leaves everything in place.
 */
export async function sweepStaleTestKeys(
  options: { now?: number; maxAgeMs?: number; keychain?: KeychainAccess } = {},
): Promise<string[]> {
  const keychain = options.keychain ?? systemKeychain();
  const now = options.now ?? Date.now();
  const found = await keychain.listServices().catch(() => [] as string[]);
  const stale = [...new Set(found)].filter((service) =>
    isStaleTestService(service, now, options.maxAgeMs),
  );
  for (const service of stale) await removeTestKeys(service, keychain);
  return stale;
}

// The system keychain ------------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

/** Runs a command and returns its output; an empty one when it fails or is missing. */
async function output(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: "latin1",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60_000,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return "";
  }
}

/**
 * The services in the output of `cmdkey /list` (Windows): one `LegacyGeneric:target=<account>.<service>`
 * line per entry, whatever the language of the label before it.
 */
export function servicesFromCmdkey(text: string): string[] {
  const services: string[] = [];
  for (const match of text.matchAll(/LegacyGeneric:target=(\S+)[ \t]*$/gm)) {
    const target = match[1] ?? "";
    const dot = target.indexOf(".");
    // An account is letters, digits, dashes and colons, a service letters, digits and dashes: a
    // URL or a path is another application's.
    if (/^[\w:-]+\.[\w-]+$/.test(target)) services.push(target.slice(dot + 1));
  }
  return services;
}

/** The services in the output of `security dump-keychain` (macOS): `"svce"<blob>="<service>"`. */
export function servicesFromSecurityDump(text: string): string[] {
  return [...text.matchAll(/"svce"<blob>="([^"\n]*)"/g)].map((match) => match[1] ?? "");
}

/**
 * The services in the output of `secret-tool search --all` (Linux, Secret Service): one
 * `attribute.service = <service>` line per entry.
 */
export function servicesFromSecretTool(text: string): string[] {
  return [...text.matchAll(/^attribute\.service = (.*)$/gm)].map((match) =>
    (match[1] ?? "").trim(),
  );
}

type Keyring = typeof import("@napi-rs/keyring");

/** The real system keychain, through `@napi-rs/keyring`; the platform's own tool lists the services. */
export function systemKeychain(platform: NodeJS.Platform = process.platform): KeychainAccess {
  let keyring: Promise<Keyring> | undefined;
  const load = () => {
    keyring ??= import("@napi-rs/keyring");
    return keyring;
  };
  return {
    async listServices() {
      if (platform === "win32") return servicesFromCmdkey(await output("cmdkey", ["/list"]));
      if (platform === "darwin")
        return servicesFromSecurityDump(await output("security", ["dump-keychain"]));
      return servicesFromSecretTool(
        await output("secret-tool", [
          "search",
          "--all",
          "xdg:schema",
          "org.freedesktop.Secret.Generic",
        ]),
      );
    },
    async listAccounts(service) {
      const { findCredentialsAsync } = await load();
      return (await findCredentialsAsync(service)).map((entry) => entry.account);
    },
    async deleteEntry(service, account) {
      const { AsyncEntry } = await load();
      return new AsyncEntry(service, account, KEYCHAIN_ENTRY_OPTIONS).deleteCredential();
    },
  };
}
