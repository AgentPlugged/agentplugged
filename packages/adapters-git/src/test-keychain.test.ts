import { describe, expect, it } from "vitest";
import {
  isStaleTestService,
  isTestService,
  type KeychainAccess,
  removeTestKeys,
  STALE_AFTER_MS,
  servicesFromCmdkey,
  servicesFromSecretTool,
  servicesFromSecurityDump,
  serviceTimestamp,
  sweepStaleTestKeys,
} from "./test-keychain.js";

const NOW = 1_791_500_000_000;
const OLD = NOW - 2 * STALE_AFTER_MS;
const FRESH = NOW - 60_000;

/** A simulated keychain: `service/account` entries in a map, never the system's. */
function simulated(entries: string[]): KeychainAccess & { left(): string[]; listed: string[] } {
  const store = new Set(entries);
  const listed: string[] = [];
  return {
    listed,
    left: () => [...store].sort(),
    async listServices() {
      return [...store].map((entry) => entry.slice(0, entry.lastIndexOf("/")));
    },
    async listAccounts(service) {
      listed.push(service);
      return [...store]
        .filter((entry) => entry.startsWith(`${service}/`))
        .map((entry) => entry.slice(service.length + 1));
    },
    async deleteEntry(service, account) {
      return store.delete(`${service}/${account}`);
    },
  };
}

describe("test services", () => {
  it("recognizes the prefixes of the tests and the smoke, and nothing nearby", () => {
    for (const name of [
      "agentplugged-test-cli-12-1791400000000",
      "agentplugged-smoke-40224-1791834311077",
      "zz-stress-9-1791400000000",
    ]) {
      expect(isTestService(name)).toBe(true);
    }
    for (const name of [
      "agentplugged",
      "ap-measure",
      "agentplugged-trial-24716-1791488754676",
      "ap-e2e-31164",
      "agentplugged-test",
      "agentplugged-test-",
      "my-agentplugged-test-1-1791400000000",
      "",
    ]) {
      expect(isTestService(name)).toBe(false);
    }
  });

  it("reads the creation time in the name, with or without a worker suffix", () => {
    expect(serviceTimestamp("agentplugged-test-cli-12-1791400000000")).toBe(1_791_400_000_000);
    expect(serviceTimestamp("agentplugged-test-cli-12-1791400000000-w3")).toBe(1_791_400_000_000);
    expect(serviceTimestamp("agentplugged-test-next-12-1791400000000-other")).toBe(
      1_791_400_000_000,
    );
    expect(serviceTimestamp("agentplugged-test-ci-cli")).toBeUndefined();
    expect(serviceTimestamp("agentplugged-test-12-345")).toBeUndefined();
  });

  it("calls stale only a test service dated an hour or more ago", () => {
    expect(isStaleTestService(`agentplugged-test-a-1-${OLD}`, NOW)).toBe(true);
    expect(isStaleTestService(`agentplugged-test-a-1-${NOW - STALE_AFTER_MS}`, NOW)).toBe(true);
    expect(isStaleTestService(`agentplugged-test-a-1-${FRESH}`, NOW)).toBe(false);
    expect(isStaleTestService("agentplugged-test-without-a-date", NOW)).toBe(false);
    expect(isStaleTestService(`agentplugged-trial-1-${OLD}`, NOW)).toBe(false);
    expect(isStaleTestService(`ap-e2e-${OLD}`, NOW)).toBe(false);
  });
});

describe("removeTestKeys", () => {
  it("deletes the fixed accounts and the product keys of a test service, and no other service", async () => {
    const service = `agentplugged-test-a-1-${FRESH}`;
    const keychain = simulated([
      `${service}/machine`,
      `${service}/human`,
      `${service}/human-presence`,
      `${service}/product:01ABC`,
      `${service}/product:01ABC:previous:k1`,
      `agentplugged-test-b-1-${FRESH}/machine`,
      "agentplugged/machine",
    ]);
    expect(await removeTestKeys(service, keychain)).toBe(5);
    expect(keychain.left()).toEqual([
      `agentplugged-test-b-1-${FRESH}/machine`,
      "agentplugged/machine",
    ]);
  });

  it("takes several services, and never throws when the keychain fails", async () => {
    const one = `agentplugged-smoke-1-${FRESH}`;
    const two = `agentplugged-test-z-1-${FRESH}`;
    const keychain = simulated([`${one}/machine`, `${two}/human`]);
    expect(await removeTestKeys([one, two], keychain)).toBe(2);
    const broken: KeychainAccess = {
      listServices: async () => {
        throw new Error("locked");
      },
      listAccounts: async () => {
        throw new Error("locked");
      },
      deleteEntry: async () => {
        throw new Error("locked");
      },
    };
    expect(await removeTestKeys(one, broken)).toBe(0);
  });

  it("refuses a service that is not named like a test's", async () => {
    const keychain = simulated([
      "agentplugged/machine",
      "agentplugged/human",
      "ap-measure/machine",
      `agentplugged-trial-1-${OLD}/machine`,
      `ap-e2e-${OLD}/human`,
    ]);
    const before = keychain.left();
    for (const service of [
      "agentplugged",
      "ap-measure",
      `agentplugged-trial-1-${OLD}`,
      `ap-e2e-${OLD}`,
      "",
    ]) {
      expect(await removeTestKeys(service, keychain)).toBe(0);
    }
    expect(keychain.left()).toEqual(before);
    expect(keychain.listed).toEqual([]);
  });
});

describe("sweepStaleTestKeys", () => {
  it("deletes the stale test services and touches nothing else", async () => {
    const stale = `agentplugged-test-cli-9-${OLD}-w2`;
    const staleSmoke = `agentplugged-smoke-9-${OLD}`;
    const staleStress = `zz-stress-9-${OLD}`;
    const fresh = `agentplugged-test-cli-9-${FRESH}`;
    const keep = [
      `${fresh}/machine`,
      "agentplugged/machine",
      "agentplugged/human",
      "agentplugged/product:01ABC",
      "ap-measure/machine",
      `ap-measure/product:01ABC`,
      `agentplugged-trial-24716-${OLD}/machine`,
      `agentplugged-trial-24716-${OLD}/product:01DEF`,
      `ap-e2e-${OLD}/human`,
      "agentplugged-test-no-date/machine",
    ];
    const keychain = simulated([
      `${stale}/machine`,
      `${stale}/product:01XYZ`,
      `${staleSmoke}/human`,
      `${staleSmoke}/product:01XYZ`,
      `${staleStress}/machine`,
      ...keep,
    ]);
    const swept = await sweepStaleTestKeys({ now: NOW, keychain });
    expect(swept.sort()).toEqual([stale, staleSmoke, staleStress].sort());
    expect(keychain.left()).toEqual([...keep].sort());
  });

  it("honors the age it is given, and leaves everything when the keychain cannot be listed", async () => {
    const recent = `agentplugged-test-x-1-${NOW - 10 * 60_000}`;
    const keychain = simulated([`${recent}/machine`]);
    expect(await sweepStaleTestKeys({ now: NOW, keychain })).toEqual([]);
    expect(await sweepStaleTestKeys({ now: NOW, maxAgeMs: 5 * 60_000, keychain })).toEqual([
      recent,
    ]);
    expect(keychain.left()).toEqual([]);
    const unlistable: KeychainAccess = {
      ...simulated([`agentplugged-test-x-1-${OLD}/machine`]),
      listServices: async () => {
        throw new Error("no tool");
      },
    };
    expect(await sweepStaleTestKeys({ now: NOW, keychain: unlistable })).toEqual([]);
  });
});

describe("the listing of each platform", () => {
  it("reads the services in `cmdkey /list` (Windows, French or English)", () => {
    const text = [
      "Informations d'identification actuelles :",
      "",
      "    Cible : LegacyGeneric:target=machine.agentplugged-test-cli-1-1791400000000-w1",
      "    Type : Générique",
      "    Cible : LegacyGeneric:target=product:01M4.agentplugged-smoke-40224-1791834311077\r",
      "    Target: LegacyGeneric:target=human.agentplugged",
      "    Cible : MicrosoftAccount:target=SSO_POP_Device",
      "    Cible : LegacyGeneric:target=git:https://github.com",
      "",
    ].join("\n");
    expect(servicesFromCmdkey(text)).toEqual([
      "agentplugged-test-cli-1-1791400000000-w1",
      "agentplugged-smoke-40224-1791834311077",
      "agentplugged",
    ]);
  });

  it("reads the services in `security dump-keychain` (macOS)", () => {
    const text = [
      'keychain: "/Users/x/Library/Keychains/login.keychain-db"',
      "    attributes:",
      '        "acct"<blob>="machine"',
      '        "svce"<blob>="agentplugged-test-cli-1-1791400000000"',
      '        "svce"<blob>="agentplugged"',
      '        "svce"<blob>=<NULL>',
    ].join("\n");
    expect(servicesFromSecurityDump(text)).toEqual([
      "agentplugged-test-cli-1-1791400000000",
      "agentplugged",
    ]);
  });

  it("reads the services in `secret-tool search --all` (Linux)", () => {
    const text = [
      "[/org/freedesktop/secrets/collection/login/12]",
      "label = machine@agentplugged-test-cli-1-1791400000000",
      "attribute.service = agentplugged-test-cli-1-1791400000000",
      "attribute.username = machine",
      "[/org/freedesktop/secrets/collection/login/13]",
      "attribute.service = ap-measure",
    ].join("\n");
    expect(servicesFromSecretTool(text)).toEqual([
      "agentplugged-test-cli-1-1791400000000",
      "ap-measure",
    ]);
  });

  it("sweeps from a listing of each platform, and keeps the neighbours", async () => {
    const stale = `agentplugged-test-cli-1-${OLD}`;
    const listings = [
      servicesFromCmdkey(
        `    Cible : LegacyGeneric:target=machine.${stale}\n    Cible : LegacyGeneric:target=machine.agentplugged\n    Cible : LegacyGeneric:target=machine.ap-measure\n`,
      ),
      servicesFromSecurityDump(
        `"svce"<blob>="${stale}"\n"svce"<blob>="agentplugged"\n"svce"<blob>="ap-measure"\n`,
      ),
      servicesFromSecretTool(
        `attribute.service = ${stale}\nattribute.service = agentplugged\nattribute.service = ap-measure\n`,
      ),
    ];
    for (const services of listings) {
      const keychain = simulated([
        "agentplugged/machine",
        "ap-measure/machine",
        `${stale}/machine`,
      ]);
      const swept = await sweepStaleTestKeys({
        now: NOW,
        keychain: { ...keychain, listServices: async () => services },
      });
      expect(swept).toEqual([stale]);
      expect(keychain.left()).toEqual(["agentplugged/machine", "ap-measure/machine"]);
    }
  });
});
