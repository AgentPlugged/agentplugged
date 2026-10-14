import { AgentPluggedError, createProductKey, loadMachineKey } from "@agentplugged/core";
import { ErrorCode } from "@agentplugged/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KEYCHAIN_SETTLE_DELAYS_MS, NodeKeyStore } from "./node-key-store.js";

/**
 * A fake `@napi-rs/keyring`, never the system keychain: after a write, the next `emptyAfterWrite`
 * reads of the entry answer empty (as the Windows Credential Manager under concurrent access);
 * `writeError` makes every write reject with that message.
 */
const fake = vi.hoisted(() => ({
  entries: new Map<string, string>(),
  empty: new Map<string, number>(),
  emptyAfterWrite: 0,
  writeError: undefined as string | undefined,
  reads: 0,
  /** Reads answered before every read fails. */
  readError: undefined as number | undefined,
}));

vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    readonly #name: string;
    constructor(service: string, account: string) {
      this.#name = `${service}/${account}`;
    }
    async getPassword(): Promise<string | undefined> {
      fake.reads += 1;
      if (fake.readError !== undefined && fake.reads > fake.readError) {
        throw new Error("Platform failure: Windows error code 1312");
      }
      const left = fake.empty.get(this.#name) ?? 0;
      if (left > 0) {
        fake.empty.set(this.#name, left - 1);
        return undefined;
      }
      return fake.entries.get(this.#name);
    }
    async setPassword(value: string): Promise<void> {
      if (fake.writeError !== undefined) throw new Error(fake.writeError);
      fake.entries.set(this.#name, value);
      fake.empty.set(this.#name, fake.emptyAfterWrite);
    }
    async deleteCredential(): Promise<boolean> {
      return fake.entries.delete(this.#name);
    }
  },
  findCredentialsAsync: async () => [],
}));

const PRODUCT = "01JZ0000000000000000000000";

/** The store as on Windows: the re-reads of `KEYCHAIN_SETTLE_DELAYS_MS`. */
const busy = () =>
  new NodeKeyStore({ service: "agentplugged-fake", settleDelays: KEYCHAIN_SETTLE_DELAYS_MS });

beforeEach(() => {
  fake.entries.clear();
  fake.empty.clear();
  fake.emptyAfterWrite = 0;
  fake.writeError = undefined;
  fake.reads = 0;
  fake.readError = undefined;
});

describe("NodeKeyStore under a busy or full keychain", () => {
  it("re-reads at most five times, in less than a second in all", async () => {
    const store = busy();
    expect(new NodeKeyStore().settleDelays).toEqual(
      process.platform === "win32" ? KEYCHAIN_SETTLE_DELAYS_MS : [],
    );
    expect(KEYCHAIN_SETTLE_DELAYS_MS).toHaveLength(5);
    expect(KEYCHAIN_SETTLE_DELAYS_MS.reduce((sum, delay) => sum + delay, 0)).toBeLessThan(1000);
    const started = Date.now();
    for (let attempt = 0; attempt < 5; attempt += 1) expect(await store.settle(attempt)).toBe(true);
    expect(await store.settle(5)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("creates the machine key once, read back while the keychain answers empty", async () => {
    fake.emptyAfterWrite = 3;
    const key = await loadMachineKey(busy());
    expect(key.created).toBe(true);
    expect([...fake.entries.keys()]).toEqual(["agentplugged-fake/machine"]);
    // A new store, as another process: the same key, without creating another.
    const again = await loadMachineKey(busy());
    expect([again.created, again.device]).toEqual([false, key.device]);
  });

  it("never says a product key stored when the keychain keeps answering empty", async () => {
    fake.emptyAfterWrite = 6;
    const error = await createProductKey(busy(), PRODUCT).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentPluggedError);
    expect((error as AgentPluggedError).details.reason).toBe(
      "the system keychain did not keep the product key",
    );
  });

  it("gives KEYCHAIN_FULL for Windows error code 8 (or 14), with the system's message", async () => {
    for (const message of [
      "Platform failure: Windows error code 8",
      "Platform secure storage failure: Windows error code 14",
    ]) {
      fake.writeError = message;
      const error = await loadMachineKey(busy()).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AgentPluggedError);
      expect((error as AgentPluggedError).toPayload()).toEqual({
        code: ErrorCode.KEYCHAIN_FULL,
        message_key: "error.keychain_full",
        details: { reason: message },
      });
    }
    fake.writeError = "Platform failure: Windows error code 8";
    const product = await createProductKey(busy(), PRODUCT).catch((caught: unknown) => caught);
    expect((product as AgentPluggedError).code).toBe(ErrorCode.KEYCHAIN_FULL);
  });

  it("throws any other write failure as is, never as a full keychain", async () => {
    for (const message of [
      "Platform failure: Windows error code 5",
      "Platform failure: Windows error code 80",
      "Platform failure: Windows error code 1450",
    ]) {
      fake.writeError = message;
      const error = await busy()
        .writeMachineSecret("x")
        .catch((caught: unknown) => caught);
      expect(error).not.toBeInstanceOf(AgentPluggedError);
      expect((error as Error).message).toBe(message);
    }
  });

  it("throws a read failing between the re-reads, never taken for a missing key", async () => {
    fake.emptyAfterWrite = 3;
    // The first read and the five re-reads confirm the absence, then the write, then one re-read.
    fake.readError = 7;
    await expect(loadMachineKey(busy())).rejects.toThrow("Windows error code 1312");
    expect(fake.entries.size).toBe(1);
  });
});
