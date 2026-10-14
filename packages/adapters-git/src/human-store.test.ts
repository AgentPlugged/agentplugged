import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeProjection,
  createUlidFactory,
  deviceHeads,
  type HumanKey,
  loadHumanKey,
  localeSigner,
  MemoryKeyStore,
  prepareHumanEvents,
} from "@agentplugged/core";
import { toBase64url } from "@agentplugged/crypto";
import { ErrorCode, EVENT_TYPES, HUMAN_EVENT_TYPES } from "@agentplugged/protocol";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GitStateStore,
  KEYCHAIN_SERVICE,
  NodeKeyStore,
  NodePresenceAuthenticator,
} from "./index.js";
import { removeTestKeys } from "./test-keychain.js";

vi.setConfig({ testTimeout: 120_000 });

const PRODUCT = "01JZ0000000000000000000000";
const SEED = toBase64url(new Uint8Array(32).fill(3));
const HUMAN = toBase64url(new Uint8Array(32).fill(4));

let base: string;
let repo: string;
const stores: GitStateStore[] = [];
let ceiling: string | undefined;

/** Runs git in the test repository only; never in this one, never on the network. */
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

beforeAll(async () => {
  ceiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = await realpath(tmpdir());
});

afterAll(() => {
  if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
  else process.env.GIT_CEILING_DIRECTORIES = ceiling;
});

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "agentplugged-human-store-"));
  repo = join(base, "repo");
  await mkdir(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Ada");
  git(repo, "config", "user.email", "ada@example.com");
  await writeFile(join(repo, "README.md"), "product\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "first");
});

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function store(keys = new MemoryKeyStore(SEED, HUMAN)) {
  const created = new GitStateStore({
    cwd: repo,
    keys,
    machineLockPath: join(base, "machine-key.lock"),
  });
  stores.push(created);
  return created;
}

async function humanKey(keys: MemoryKeyStore): Promise<HumanKey> {
  const key = await loadHumanKey(keys);
  if (key === undefined) throw new Error("no key");
  return key;
}

describe("GitStateStore.appendHuman", () => {
  it("writes the creator's events; in an empty journal, the machine's events come first", async () => {
    const keys = new MemoryKeyStore(SEED, HUMAN);
    const journal = store(keys);
    const key = await humanKey(keys);
    const events = await prepareHumanEvents({
      key,
      drafts: [],
      deviceHead: null,
      product: PRODUCT,
      newId: createUlidFactory(),
      now: Date.now,
    });
    const written = await journal.appendHuman(events);
    expect(written.map((event) => event.type)).toEqual([HUMAN_EVENT_TYPES.keyRegistered]);
    const listing = await journal.list();
    expect(listing.events.map((event) => event.type).sort()).toEqual(
      [
        EVENT_TYPES.deviceRegistered,
        EVENT_TYPES.productCreated,
        HUMAN_EVENT_TYPES.keyRegistered,
      ].sort(),
    );
    const projection = await computeProjection(listing.events);
    expect(projection.ignored).toEqual([]);
    expect(Object.keys(projection.state.humans as object)).toEqual([key.device]);
    // The worktree is never touched.
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("refuses events prepared on a head that moved, and writes nothing", async () => {
    const keys = new MemoryKeyStore(SEED, HUMAN);
    const journal = store(keys);
    const key = await humanKey(keys);
    const first = await prepareHumanEvents({
      key,
      drafts: [],
      deviceHead: null,
      product: PRODUCT,
      newId: createUlidFactory(),
      now: Date.now,
    });
    await journal.appendHuman(first);
    // Prepared again from no head: the creator's chain has moved since.
    const stale = await prepareHumanEvents({
      key,
      drafts: [],
      deviceHead: null,
      product: PRODUCT,
      newId: createUlidFactory(),
      now: Date.now,
    });
    const head = await journal.head();
    await expect(journal.appendHuman(stale)).rejects.toMatchObject({ code: ErrorCode.UNEXPECTED });
    expect(await journal.head()).toBe(head);

    // Chained on the real head, it is written.
    const listing = await journal.list();
    const next = await prepareHumanEvents({
      key,
      drafts: [
        {
          type: "checkpoint.resolved",
          payload: { checkpoint: "G-7M2K9QX4TB", decision: "approved", source: "terminal" },
          signer: localeSigner(key),
        },
      ],
      deviceHead: deviceHeads(listing.events).get(key.device) ?? null,
      product: PRODUCT,
      newId: createUlidFactory(),
      now: Date.now,
    });
    expect((await journal.appendHuman(next)).map((event) => event.type)).toEqual([
      "checkpoint.resolved",
    ]);
  });

  it("runs the precondition under the lock: a refusal writes nothing", async () => {
    const keys = new MemoryKeyStore(SEED, HUMAN);
    const journal = store(keys);
    const key = await humanKey(keys);
    const events = await prepareHumanEvents({
      key,
      drafts: [],
      deviceHead: null,
      product: PRODUCT,
      newId: createUlidFactory(),
      now: Date.now,
    });
    await expect(
      journal.appendHuman(events, {
        precondition: () => {
          throw new Error("refused");
        },
      }),
    ).rejects.toThrow("refused");
    expect(await journal.head()).toBeNull();
  });
});

describe("NodeKeyStore: the creator's entries", () => {
  // Never the machine's real entries: a service of its own, deleted afterwards.
  const service = `agentplugged-test-human-${process.pid}-${Date.now()}`;

  // Whatever the test left, even when it failed before its own deletion.
  afterAll(async () => {
    await removeTestKeys(service);
  });

  it("keeps the creator's key and credential apart from the machine key", async (context) => {
    const keys = new NodeKeyStore({ service });
    try {
      expect(await keys.readHumanSecret()).toBeUndefined();
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
      const key = await loadHumanKey(keys);
      expect(key?.created).toBe(true);
      expect(await keys.readMachineSecret()).toBeUndefined();
      await keys.writePresenceCredential('{"credential_id":"AA"}');
      const again = await loadHumanKey(new NodeKeyStore({ service }));
      expect(again?.device).toBe(key?.device);
      expect(await new NodeKeyStore({ service }).readPresenceCredential()).toBe(
        '{"credential_id":"AA"}',
      );
    } finally {
      expect(await keys.deleteAll()).toBe(true);
    }
    expect(await keys.readHumanSecret()).toBeUndefined();
  });

  it("never deletes the real entries", async () => {
    await expect(new NodeKeyStore().deleteAll()).rejects.toThrow(KEYCHAIN_SERVICE);
  });
});

describe("NodePresenceAuthenticator", () => {
  it("is unavailable on another system than Windows, without loading anything", async () => {
    // Only the platform check runs: no FFI, no system call, never a prompt.
    for (const platform of ["linux", "darwin"]) {
      expect(await new NodePresenceAuthenticator({ platform }).availability()).toEqual({
        available: false,
        reason: "platform",
      });
    }
  });
});
