import { generateProductKey } from "@agentplugged/crypto";
import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { AgentPluggedError } from "../errors.js";
import { loadHumanKey, readStoredPresence, storePresence } from "../human/human-key.js";
import {
  keychainFull,
  loadMachineKey,
  MemoryKeyStore,
  readMachineKey,
  settledRead,
} from "./key-store.js";
import {
  createProductKey,
  productKeyOf,
  readHeldProductKey,
  readProductKey,
  storeProductKey,
} from "./product-key.js";

type Account = "machine" | "human" | "presence" | "product";

/**
 * A keychain like the Windows Credential Manager under concurrent access: after a write, the next
 * `emptyAfterWrite` reads of that entry answer empty; `hidden` reads of an entry already there
 * answer empty too; a full keychain refuses every write. Five re-reads at most, as the system
 * keychain's, without waiting.
 */
class FlakyKeyStore extends MemoryKeyStore {
  emptyAfterWrite = 0;
  readonly #empty = new Map<Account, number>();
  readonly settles: number[] = [];
  readonly reads: Record<Account, number> = { machine: 0, human: 0, presence: 0, product: 0 };
  full = false;
  /** Thrown by the reads once `failAfter` reads have been answered. */
  failAfter: number | undefined;

  hide(account: Account, reads: number): void {
    this.#empty.set(account, reads);
  }

  async settle(attempt: number): Promise<boolean> {
    if (attempt >= 5) return false;
    this.settles.push(attempt);
    return true;
  }

  #read<T>(account: Account, value: T | undefined): T | undefined {
    this.reads[account] += 1;
    const total = Object.values(this.reads).reduce((sum, count) => sum + count, 0);
    if (this.failAfter !== undefined && total > this.failAfter) {
      throw new Error("Platform failure: Windows error code 1312");
    }
    const left = this.#empty.get(account) ?? 0;
    if (left > 0) {
      this.#empty.set(account, left - 1);
      return undefined;
    }
    return value;
  }

  #write(account: Account): void {
    if (this.full) throw keychainFull("Platform failure: Windows error code 8");
    this.#empty.set(account, this.emptyAfterWrite);
  }

  override async readMachineSecret() {
    return this.#read("machine", await super.readMachineSecret());
  }
  override async writeMachineSecret(secret: string) {
    this.#write("machine");
    await super.writeMachineSecret(secret);
  }
  override async readHumanSecret() {
    return this.#read("human", await super.readHumanSecret());
  }
  override async writeHumanSecret(secret: string) {
    this.#write("human");
    await super.writeHumanSecret(secret);
  }
  override async readPresenceCredential() {
    return this.#read("presence", await super.readPresenceCredential());
  }
  override async writePresenceCredential(value: string) {
    this.#write("presence");
    await super.writePresenceCredential(value);
  }
  override async readProductSecret(productId: string) {
    return this.#read("product", await super.readProductSecret(productId));
  }
  override async writeProductSecret(productId: string, secret: string) {
    this.#write("product");
    await super.writeProductSecret(productId, secret);
  }
}

const PRODUCT = "01JZ0000000000000000000000";

function codeOf(error: unknown): string | undefined {
  return error instanceof AgentPluggedError ? error.code : undefined;
}

describe("settledRead", () => {
  it("re-reads while the value is not accepted, at most as many times as the store allows", async () => {
    const keys = new FlakyKeyStore();
    let reads = 0;
    expect(await settledRead(keys, async () => (++reads > 3 ? "x" : undefined), Boolean)).toBe("x");
    expect([reads, keys.settles]).toEqual([4, [0, 1, 2]]);
    reads = 0;
    expect(await settledRead(new FlakyKeyStore(), async () => void reads++, Boolean)).toBe(
      undefined,
    );
    expect(reads).toBe(6);
  });

  it("never re-reads a store without settle (memory), nor a value accepted at once", async () => {
    let reads = 0;
    const read = async () => void reads++;
    expect(await settledRead(new MemoryKeyStore(), read, Boolean)).toBeUndefined();
    expect(reads).toBe(1);
    const keys = new FlakyKeyStore();
    expect(await settledRead(keys, async () => "x", Boolean)).toBe("x");
    expect(keys.settles).toEqual([]);
  });

  it("throws a failing read at once, never taken for an empty entry", async () => {
    const keys = new FlakyKeyStore();
    let reads = 0;
    const read = async () => {
      reads += 1;
      if (reads === 2) throw new Error("keychain locked");
      return undefined;
    };
    await expect(settledRead(keys, read, Boolean)).rejects.toThrow("keychain locked");
    expect(reads).toBe(2);
  });
});

describe("the machine key under a busy keychain", () => {
  it("is read back after its write, again while the keychain answers empty", async () => {
    const keys = new FlakyKeyStore();
    keys.emptyAfterWrite = 3;
    const key = await loadMachineKey(keys);
    expect(key.created).toBe(true);
    expect(keys.writes).toBe(1);
    // Five re-reads confirm the absence, three more the write.
    expect(keys.settles).toEqual([0, 1, 2, 3, 4, 0, 1, 2]);
    const again = await loadMachineKey(keys);
    expect([again.created, again.device]).toEqual([false, key.device]);
  });

  it("is never said created when the keychain still answers empty after the last re-read", async () => {
    const keys = new FlakyKeyStore();
    keys.emptyAfterWrite = 6;
    const error = await loadMachineKey(keys).catch((caught: unknown) => caught);
    expect(codeOf(error)).toBe(ErrorCode.UNEXPECTED);
    expect((error as AgentPluggedError).details.reason).toBe(
      "the system keychain did not keep the machine key",
    );
    expect(keys.writes).toBe(1);
  });

  it("is never replaced when the keychain answers empty for a key it holds", async () => {
    const keys = new FlakyKeyStore();
    const first = await loadMachineKey(keys);
    // The first read, then the four re-reads under the lock, answer empty: the fifth finds it.
    keys.hide("machine", 5);
    const again = await loadMachineKey(keys);
    expect([again.created, again.device, keys.writes]).toEqual([false, first.device, 1]);
  });

  it("never adopts another value read back under the lock (a stale read)", async () => {
    const keys = new FlakyKeyStore();
    const other = new MemoryKeyStore();
    await loadMachineKey(other);
    const write = keys.writeMachineSecret.bind(keys);
    keys.writeMachineSecret = async (secret: string) => {
      await write(secret);
      keys.secret = other.secret;
    };
    const error = await loadMachineKey(keys).catch((caught: unknown) => caught);
    expect((error as AgentPluggedError).details.reason).toBe(
      "the system keychain did not keep the machine key",
    );
  });

  it("is read without ever being created, its absence confirmed by re-reads", async () => {
    const keys = new FlakyKeyStore();
    expect(await readMachineKey(keys)).toBeUndefined();
    expect([keys.writes, keys.settles]).toEqual([0, [0, 1, 2, 3, 4]]);
    const key = await loadMachineKey(keys);
    keys.hide("machine", 3);
    expect((await readMachineKey(keys))?.device).toBe(key.device);
  });

  it("throws a failing settle, never taken for an empty entry", async () => {
    const keys = new FlakyKeyStore();
    keys.settle = async () => {
      throw new Error("settle failed");
    };
    await expect(loadMachineKey(keys)).rejects.toThrow("settle failed");
    expect(keys.writes).toBe(0);
  });

  it("reports a failing re-read as such, never as a missing key", async () => {
    const keys = new FlakyKeyStore();
    keys.emptyAfterWrite = 2;
    keys.failAfter = 8;
    await expect(loadMachineKey(keys)).rejects.toThrow("Windows error code 1312");
  });

  it("says KEYCHAIN_FULL when the keychain refuses the write, being full", async () => {
    const keys = new FlakyKeyStore();
    keys.full = true;
    const error = await loadMachineKey(keys).catch((caught: unknown) => caught);
    expect(codeOf(error)).toBe(ErrorCode.KEYCHAIN_FULL);
    expect((error as AgentPluggedError).message_key).toBe("error.keychain_full");
    expect((error as AgentPluggedError).details).toEqual({
      reason: "Platform failure: Windows error code 8",
    });
    expect(keys.secret).toBeUndefined();
  });
});

describe("the creator's key and presence credential under a busy keychain", () => {
  it("reads the creator's key back, and never replaces one the keychain hides", async () => {
    const keys = new FlakyKeyStore();
    keys.emptyAfterWrite = 4;
    const key = await loadHumanKey(keys);
    expect([key?.created, keys.humanWrites]).toEqual([true, 1]);
    keys.hide("human", 5);
    const again = await loadHumanKey(keys);
    expect([again?.created, again?.device, keys.humanWrites]).toEqual([false, key?.device, 1]);
    // Said missing (`create: false`) only once the re-reads confirm it.
    keys.hide("human", 4);
    expect((await loadHumanKey(keys, { create: false }))?.device).toBe(key?.device);
    expect(await loadHumanKey(new FlakyKeyStore(), { create: false })).toBeUndefined();
    const lost = new FlakyKeyStore();
    lost.emptyAfterWrite = 6;
    await expect(loadHumanKey(lost)).rejects.toThrow("error.unexpected");
    const full = new FlakyKeyStore();
    full.full = true;
    expect(codeOf(await loadHumanKey(full).catch((caught: unknown) => caught))).toBe(
      ErrorCode.KEYCHAIN_FULL,
    );
  });

  it("reads the presence credential back, and fails when the keychain keeps nothing", async () => {
    const credential: Parameters<typeof storePresence>[1] = {
      credential_id: "Y3JlZGVudGlhbA",
      cose_public_key: "pQECAyYgASFYIA",
      alg: "webauthn-es256",
    };
    const keys = new FlakyKeyStore();
    keys.emptyAfterWrite = 2;
    await storePresence(keys, credential);
    expect(keys.settles).toEqual([0, 1]);
    // Before creating another one, its absence is confirmed: one hidden is found.
    keys.hide("presence", 3);
    expect(await readStoredPresence(keys)).toBeUndefined();
    keys.hide("presence", 3);
    expect(await readStoredPresence(keys, { confirmAbsence: true })).toEqual(credential);
    const lost = new FlakyKeyStore();
    lost.emptyAfterWrite = 6;
    const error = await storePresence(lost, credential).catch((caught: unknown) => caught);
    expect((error as AgentPluggedError).message_key).toBe("error.keychain_unavailable");
  });
});

describe("the product key under a busy keychain", () => {
  it("is read back after its write, again while the keychain answers empty", async () => {
    const keys = new FlakyKeyStore();
    keys.emptyAfterWrite = 5;
    const { key, created } = await createProductKey(keys, PRODUCT);
    expect([created, keys.productWrites]).toEqual([true, 1]);
    expect((await readProductKey(keys, PRODUCT))?.keyId).toBe(key.keyId);
  });

  it("is never replaced when the keychain answers empty for a key it holds", async () => {
    const keys = new FlakyKeyStore();
    const first = await createProductKey(keys, PRODUCT);
    keys.hide("product", 4);
    const again = await createProductKey(keys, PRODUCT);
    expect([again.created, again.key.keyId, keys.productWrites]).toEqual([
      false,
      first.key.keyId,
      1,
    ]);
  });

  it("is said held or missing (key import, sensitive content) only once re-reads confirm it", async () => {
    const keys = new FlakyKeyStore();
    const { key } = await createProductKey(keys, PRODUCT);
    keys.hide("product", 5);
    expect((await readHeldProductKey(keys, PRODUCT))?.keyId).toBe(key.keyId);
    keys.hide("product", 1);
    expect(await readProductKey(keys, PRODUCT)).toBeUndefined();
    expect(await readHeldProductKey(new FlakyKeyStore(), PRODUCT)).toBeUndefined();
  });

  it("is never said stored when the keychain still answers empty, or another key", async () => {
    const keys = new FlakyKeyStore();
    keys.emptyAfterWrite = 6;
    const lost = await createProductKey(keys, PRODUCT).catch((caught: unknown) => caught);
    expect((lost as AgentPluggedError).message_key).toBe("error.keychain_unavailable");
    expect((lost as AgentPluggedError).details.reason).toBe(
      "the system keychain did not keep the product key",
    );
    // `key import`: the keychain keeps answering the previous key after the write.
    const stale = new FlakyKeyStore();
    await createProductKey(stale, PRODUCT);
    const previous = stale.products.get(PRODUCT) as string;
    stale.settles.splice(0);
    const write = stale.writeProductSecret.bind(stale);
    stale.writeProductSecret = async (productId: string, secret: string) => {
      await write(productId, secret);
      stale.products.set(productId, previous);
    };
    const imported = await productKeyOf(generateProductKey());
    const error = await storeProductKey(stale, PRODUCT, imported).catch(
      (caught: unknown) => caught,
    );
    expect((error as AgentPluggedError).message_key).toBe("error.keychain_unavailable");
    expect(stale.settles).toEqual([0, 1, 2, 3, 4]);
  });

  it("says KEYCHAIN_FULL when the keychain refuses the write, being full", async () => {
    const keys = new FlakyKeyStore();
    keys.full = true;
    const error = await createProductKey(keys, PRODUCT).catch((caught: unknown) => caught);
    expect(codeOf(error)).toBe(ErrorCode.KEYCHAIN_FULL);
    expect(keys.products.size).toBe(0);
  });
});
