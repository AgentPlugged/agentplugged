import { createProductKey, loadMachineKey, readProductKey } from "@agentplugged/core";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE, NodeKeyStore } from "./index.js";
import { explainKeychainError, KEYCHAIN_ENTRY_OPTIONS } from "./node-key-store.js";
import { removeTestKeys } from "./test-keychain.js";

// Never the machine's real entry (`agentplugged` / `machine`): a service of its own per run,
// deleted afterwards.
const service = `agentplugged-test-${process.pid}-${Date.now()}`;
const created: NodeKeyStore[] = [];

/** A cleanup that failed is said (an entry may stay in the test service), never swallowed. */
function cleanupFailed(error: unknown): false {
  console.warn(
    `keychain test cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  return false;
}

afterEach(async () => {
  for (const store of created.splice(0)) await store.deleteMachineSecret().catch(cleanupFailed);
});

// Whatever a test left, even when it failed: every entry of its services.
afterAll(async () => {
  await removeTestKeys([service, `${service}-products`]);
});

describe("NodeKeyStore", () => {
  it("keeps Linux keys in the Secret Service, never in the kernel keyring lost at restart", () => {
    expect(KEYCHAIN_ENTRY_OPTIONS).toEqual({ linux: { store: "secret-service" } });
  });

  it("says what is missing when no Secret Service answers on Linux, and only there", () => {
    const failure = new Error("Platform secure storage failure: DBus error: no such name");
    const explained = explainKeychainError(failure, "linux");
    expect(explained).toBeInstanceOf(Error);
    expect((explained as Error).message).toMatch(
      /^the Secret Service of this Linux session could not be used/,
    );
    expect((explained as Error).message).toContain("GNOME Keyring, KWallet or KeePassXC");
    expect((explained as Error).message).toContain(failure.message);
    expect((explained as Error).cause).toBe(failure);
    expect(explainKeychainError(failure, "win32")).toBe(failure);
    const other = new Error("Windows error code 8");
    expect(explainKeychainError(other, "linux")).toBe(other);
  });

  it("names the real entry agentplugged / machine by default", () => {
    const store = new NodeKeyStore();
    expect([store.service, store.account]).toEqual([KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT]);
    expect([KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT]).toEqual(["agentplugged", "machine"]);
  });

  it("keeps the machine key in the system keychain", async (context) => {
    // Outside Windows, the native module itself must load on every supported system: never
    // skipped. Windows reaches the keychain through PowerShell, the module being only a fallback
    // that Smart App Control may refuse to load.
    if (process.platform !== "win32") {
      const keyring = await import("@napi-rs/keyring");
      expect(typeof keyring.AsyncEntry).toBe("function");
    }
    const store = new NodeKeyStore({ service, account: "machine" });
    created.push(store);
    try {
      expect(await store.readMachineSecret()).toBeUndefined();
    } catch (error) {
      // Only a missing keychain service (a Linux server without Secret Service) is skipped.
      const message = error instanceof Error ? error.message : String(error);
      if (
        !/platform secure storage|no storage access|secret service|dbus|keyutils/i.test(message)
      ) {
        throw error;
      }
      context.skip(`no system keychain service on this machine: ${message}`);
    }
    const key = await loadMachineKey(store);
    expect(key.created).toBe(true);
    // Read back by a new entry, as another process would.
    const again = await loadMachineKey(new NodeKeyStore({ service, account: "machine" }));
    expect(again.created).toBe(false);
    expect(again.device).toBe(key.device);
    expect(await store.deleteMachineSecret()).toBe(true);
    expect(await store.readMachineSecret()).toBeUndefined();
  });

  it("keeps each product key under product:<product_id>, and deleteAll removes them", async (context) => {
    const productService = `${service}-products`;
    const store = new NodeKeyStore({ service: productService });
    try {
      expect(await store.readProductSecret("01JZ0000000000000000000000")).toBeUndefined();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        !/platform secure storage|no storage access|secret service|dbus|keyutils/i.test(message)
      ) {
        throw error;
      }
      context.skip(`no system keychain service on this machine: ${message}`);
    }
    try {
      const created = await createProductKey(store, "01JZ0000000000000000000000");
      expect(created.created).toBe(true);
      const read = await readProductKey(
        new NodeKeyStore({ service: productService }),
        "01JZ0000000000000000000000",
      );
      expect(read?.keyId).toBe(created.key.keyId);
      expect(await store.readProductSecret("01JZ1111111111111111111111")).toBeUndefined();
      expect(await store.deleteAll()).toBe(true);
      expect(await store.readProductSecret("01JZ0000000000000000000000")).toBeUndefined();
    } finally {
      await store.deleteAll().catch(cleanupFailed);
    }
  });
});
