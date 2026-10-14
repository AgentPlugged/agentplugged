import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeProjection,
  type EventDraft,
  ensureProductId,
  MemoryKeyStore,
} from "@agentplugged/core";
import {
  canonicalBytes,
  eventHash,
  fromBase64url,
  toBase64url,
  verifyEvent,
} from "@agentplugged/crypto";
import {
  DeviceRegisteredPayloadSchema,
  ErrorCode,
  EVENT_TYPES,
  type EventEnvelope,
} from "@agentplugged/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireJournalLock,
  eventPath,
  GitStateStore,
  type GitStateStoreOptions,
  isObjectUnavailable,
  JOURNAL_HEADS_CACHE,
  JOURNAL_LOCK_NAME,
  LOCK_HEARTBEAT_MS,
  LOCK_TIMEOUT_MS,
  NodeWorkspaceFiles,
  STALE_LOCK_MS,
} from "./index.js";

// Real Git repositories, real processes: slower than vitest's 5 s default under a full test run.
vi.setConfig({ testTimeout: 120_000 });

const REF = "refs/heads/agentplugged/journal";
const PRODUCT = "01JZ0000000000000000000000";
const SEED_A = toBase64url(new Uint8Array(32).fill(1));
const SEED_B = toBase64url(new Uint8Array(32).fill(2));
const WORKER = resolve(dirname(fileURLToPath(import.meta.url)), "../test/append-worker.mjs");

const draft = (n: number): EventDraft => ({
  type: "test.appended",
  actor: { kind: "system" },
  product: PRODUCT,
  provenance: "trusted",
  payload: { n },
});

/** Runs git in a test repository; never in this one. */
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

let base: string;
let repo: string;
const stores: GitStateStore[] = [];

/** Machine-wide key lock of the tests: in the temporary folder, never in the home folder. */
const machineLock = () => join(base, "machine-key.lock");

function store(cwd = repo, seed = SEED_A, extra: Partial<GitStateStoreOptions> = {}) {
  const created = new GitStateStore({
    allowTestTypes: true,
    cwd,
    keys: new MemoryKeyStore(seed),
    machineLockPath: machineLock(),
    ...extra,
  });
  stores.push(created);
  return created;
}

/** A repository with its own identity, a first commit on `main`, and `.agentplugged/`. */
async function makeRepo(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  git(path, "init", "-q", "-b", "main");
  git(path, "config", "user.name", "Ada");
  git(path, "config", "user.email", "ada@example.com");
  git(path, "config", "core.autocrlf", "false");
  await writeFile(join(path, "README.md"), "product\n");
  await mkdir(join(path, ".agentplugged"));
  await writeFile(join(path, ".agentplugged/.gitignore"), ".cache/\n");
  git(path, "add", ".");
  git(path, "commit", "-q", "-m", "first");
  return path;
}

/** Everything a journal write must leave alone. */
async function checkout(path: string) {
  const gitDir = resolve(path, git(path, "rev-parse", "--git-dir"));
  return {
    head: git(path, "rev-parse", "HEAD"),
    branch: git(path, "symbolic-ref", "HEAD"),
    status: git(path, "status", "--porcelain", "--untracked-files=all"),
    index: (await readFile(join(gitDir, "index"))).toString("base64"),
    worktrees: git(path, "worktree", "list", "--porcelain"),
  };
}

function hash(event: EventEnvelope): string {
  const result = eventHash(event);
  if (!result.ok) throw new Error("no hash");
  return result.hash;
}

/** Each writer's chain, from its tip back to `device.registered`, signatures verified. */
async function checkChains(events: readonly EventEnvelope[]): Promise<Map<string, number>> {
  const byHash = new Map(events.map((event) => [hash(event), event]));
  const prevs = new Set(events.map((event) => event.prev));
  const lengths = new Map<string, number>();
  for (const tip of events.filter((event) => !prevs.has(hash(event)))) {
    const chain: EventEnvelope[] = [];
    for (let event: EventEnvelope | undefined = tip; event; ) {
      chain.unshift(event);
      event = event.prev === null ? undefined : byHash.get(event.prev);
      if (chain.length > events.length) throw new Error("cycle");
    }
    const first = chain[0];
    expect(first?.type).toBe(EVENT_TYPES.deviceRegistered);
    expect(first?.prev).toBeNull();
    const key = fromBase64url(DeviceRegisteredPayloadSchema.parse(first?.payload).public_key);
    for (const event of chain) {
      expect(event.actor.device).toBe(tip.actor.device);
      expect(await verifyEvent(event, { ed25519PublicKey: key })).toEqual({ ok: true });
    }
    expect(lengths.has(tip.actor.device)).toBe(false);
    lengths.set(tip.actor.device, chain.length);
  }
  return lengths;
}

beforeEach(async () => {
  // Its real path: the paths Git gives back are spelled in full (no Windows short name).
  base = await realpath(await mkdtemp(join(tmpdir(), "agentplugged-journal-")));
  repo = await makeRepo(join(base, "repo"));
});

afterEach(async () => {
  for (const opened of stores.splice(0)) opened.close();
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("GitStateStore: first event", () => {
  it("creates the key, registers the device, chains the event, and touches nothing else", async () => {
    const keys = new MemoryKeyStore();
    const journal = new GitStateStore({
      cwd: repo,
      keys,
      machineLockPath: machineLock(),
      allowTestTypes: true,
    });
    stores.push(journal);
    const before = await checkout(repo);
    expect(await journal.head()).toBeNull();

    const first = await journal.append(draft(1));
    const second = await journal.append(draft(2));

    expect(keys.writes).toBe(1);
    const { events, problems } = await journal.list();
    expect(problems).toEqual([]);
    expect(events.map((event) => event.type)).toEqual([
      EVENT_TYPES.deviceRegistered,
      EVENT_TYPES.productCreated,
      "test.appended",
      "test.appended",
    ]);
    const [registered, created] = events;
    expect(registered?.prev).toBeNull();
    expect(created).toMatchObject({ product: PRODUCT, payload: { product_id: PRODUCT } });
    expect(created?.prev).toBe(registered && hash(registered));
    expect(first.prev).toBe(created && hash(created));
    expect(second.prev).toBe(hash(first));
    expect(events.slice(2)).toEqual([first, second]);
    expect((await checkChains(events)).get(first.actor.device)).toBe(4);
    expect(await journal.productId()).toBe(PRODUCT);
    expect(existsSync(machineLock())).toBe(false);

    // One file per event, canonical JSON and a final \n, written by the technical author.
    const file = spawnSync("git", ["cat-file", "blob", `${REF}:${eventPath(first)}`], {
      cwd: repo,
      encoding: "utf8",
    }).stdout;
    expect(file).toBe(`${new TextDecoder().decode(canonicalBytes(first))}\n`);
    expect(eventPath(first)).toMatch(/^journal\/\d{4}\/\d{2}\/[0-9A-Z]{26}\.json$/);
    expect(git(repo, "log", "--format=%an <%ae>|%cn <%ce>", REF).split("\n")).toEqual([
      "agentplugged <journal@agentplugged.local>|agentplugged <journal@agentplugged.local>",
      "agentplugged <journal@agentplugged.local>|agentplugged <journal@agentplugged.local>",
    ]);
    expect(git(repo, "rev-list", "--max-parents=0", REF).split("\n")).toHaveLength(1);
    expect(await journal.head()).toBe(git(repo, "rev-parse", REF));

    // HEAD, the index, the working copy: untouched; the branch was never checked out.
    expect(await checkout(repo)).toEqual(before);
    expect(existsSync(join(repo, "journal"))).toBe(false);
    expect(existsSync(join(repo, JOURNAL_HEADS_CACHE))).toBe(true);
    const commonDir = resolve(repo, git(repo, "rev-parse", "--git-common-dir"));
    expect(existsSync(join(commonDir, JOURNAL_LOCK_NAME))).toBe(false);
    expect(existsSync(join(commonDir, "agentplugged-journal.tmp"))).toBe(false);
  });

  it("keeps the existing file of each event: later writes only add files", async () => {
    const journal = store();
    const first = await journal.append(draft(1));
    const blob = git(repo, "rev-parse", `${REF}:${eventPath(first)}`);
    for (let n = 2; n <= 5; n++) await journal.append(draft(n));
    expect(git(repo, "rev-parse", `${REF}:${eventPath(first)}`)).toBe(blob);
    const changes = git(repo, "log", "--format=", "--name-status", REF).split("\n").filter(Boolean);
    expect(changes.every((line) => line.startsWith("A\t"))).toBe(true);
  });

  it("writes nothing when the draft is invalid", async () => {
    const journal = store();
    await expect(journal.append({ ...draft(1), type: "Not A Type" })).rejects.toMatchObject({
      code: ErrorCode.EVENT_INVALID,
    });
    expect(await journal.head()).toBeNull();
  });

  it("works without .agentplugged/: no cache, nothing written in the working copy", async () => {
    await rm(join(repo, ".agentplugged"), { recursive: true });
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "no method");
    const before = await checkout(repo);
    await store().append(draft(1));
    await store().append(draft(2));
    expect(await checkout(repo)).toEqual(before);
    expect(existsSync(join(repo, ".agentplugged"))).toBe(false);
    expect((await store().list()).events).toHaveLength(4);
  });
});

describe("GitStateStore: two worktrees", () => {
  it("shares one journal between main and feat/x without any merge", async () => {
    const other = join(base, "feat-x");
    git(repo, "worktree", "add", "-q", "-b", "feat/x", other);
    const beforeMain = await checkout(repo);
    const beforeOther = await checkout(other);

    const fromMain = await store(repo).append(draft(1));
    const fromOther = await store(other).append(draft(2));

    for (const cwd of [repo, other]) {
      const { events } = await store(cwd).list();
      const appended = events.filter((event) => event.type === "test.appended");
      expect(appended).toEqual([fromMain, fromOther]);
    }
    expect(fromOther.prev).toBe(hash(fromMain));
    expect(git(other, "rev-parse", REF)).toBe(git(repo, "rev-parse", REF));
    expect(await checkout(repo)).toEqual(beforeMain);
    expect(await checkout(other)).toEqual(beforeOther);
  });
});

interface WorkerResult {
  label: string;
  device: string;
  ids: string[];
  durationMs: number;
  stats: { casRetries: number; lockWaitMs: number; gitStarts: number; cacheRebuilds: number };
}

function worker(cwd: string, seed: string, count: number, label: string): Promise<WorkerResult> {
  return new Promise((done, reject) => {
    const args = [WORKER, cwd, seed, String(count), label, machineLock()];
    const child = spawn(process.execPath, args, { windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      if (status !== 0) reject(new Error(`worker ${label} exited with ${status}: ${err}`));
      else done(JSON.parse(out.trim().split("\n").at(-1) ?? "") as WorkerResult);
    });
  });
}

describe("GitStateStore: concurrent writers", () => {
  it("keeps 2 processes × 50 events: no loss, no duplicate, chains intact, no CAS retry", async () => {
    const other = join(base, "feat-x");
    git(repo, "worktree", "add", "-q", "-b", "feat/x", other);
    const before = await checkout(repo);
    const results = await Promise.all([
      worker(repo, SEED_A, 50, "A"),
      worker(other, SEED_B, 50, "B"),
    ]);

    const { events, problems } = await store().list();
    expect(problems).toEqual([]);
    const appended = events.filter((event) => event.type === "test.appended");
    expect(appended).toHaveLength(100);
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
    for (const result of results) {
      const mine = appended.filter((event) => event.actor.device === result.device);
      expect(mine.map((event) => event.id)).toEqual(result.ids);
      expect(mine.map((event) => (event.payload as { n: number }).n)).toEqual(
        Array.from({ length: 50 }, (_, i) => i + 1),
      );
      expect(result.stats.casRetries).toBe(0);
    }
    const chains = await checkChains(events);
    // One writer also wrote product.created, before its first event.
    expect([...chains.values()].sort()).toEqual([51, 52]);
    expect(events.filter((event) => event.type === EVENT_TYPES.productCreated)).toHaveLength(1);
    expect(Number(git(repo, "rev-list", "--count", REF))).toBe(100);
    expect(await checkout(repo)).toEqual(before);
  });

  it("keeps one chain when two processes write with the same machine key", async () => {
    const results = await Promise.all([
      worker(repo, SEED_A, 25, "A1"),
      worker(repo, SEED_A, 25, "A2"),
    ]);
    const { events } = await store().list();
    expect(events.filter((event) => event.type === EVENT_TYPES.deviceRegistered)).toHaveLength(1);
    expect([...(await checkChains(events)).values()]).toEqual([52]);
    expect(results.every((result) => result.stats.casRetries === 0)).toBe(true);
  });
});

describe("GitStateStore: lock", () => {
  const lockPath = () =>
    join(resolve(repo, git(repo, "rev-parse", "--git-common-dir")), JOURNAL_LOCK_NAME);

  it("takes over a lock left by a dead process", async () => {
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
      encoding: "utf8",
    }).stdout;
    await writeFile(lockPath(), `${dead}\n${hostname()}\n${new Date().toISOString()}\n`);
    const journal = store();
    await journal.append(draft(1));
    expect(journal.stats.locksReclaimed).toBe(1);
    expect(existsSync(lockPath())).toBe(false);
  });

  it("takes over a lock older than 30 s, even from a live process", async () => {
    expect(STALE_LOCK_MS).toBe(30_000);
    await writeFile(lockPath(), `${process.pid}\n${hostname()}\n`);
    const old = new Date(Date.now() - 31_000);
    await utimes(lockPath(), old, old);
    const journal = store();
    await journal.append(draft(1));
    expect(journal.stats.locksReclaimed).toBe(1);
  });

  it("gives JOURNAL_BUSY when the wait runs out while another process holds the lock", async () => {
    expect(LOCK_TIMEOUT_MS).toBe(60_000);
    const journal = store();
    await journal.append(draft(1));
    const head = await journal.head();
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      windowsHide: true,
    });
    try {
      await writeFile(lockPath(), `${holder.pid}\n${hostname()}\n${new Date().toISOString()}\n`);
      const error = await store(repo, SEED_A, { lockTimeoutMs: 300 })
        .append(draft(2))
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: ErrorCode.JOURNAL_BUSY,
        message_key: "error.journal_busy",
        details: { lock: lockPath(), stale_s: 30 },
      });
      const waited = (error as { details: { waited_ms: number } }).details.waited_ms;
      expect(waited).toBeGreaterThanOrEqual(300);
      expect(await journal.head()).toBe(head);
      expect(existsSync(lockPath())).toBe(true);
    } finally {
      holder.kill();
      await rm(lockPath(), { force: true });
    }
  });

  it("refreshes a held lock, so a holder busier than staleMs is never taken over", async () => {
    expect(LOCK_HEARTBEAT_MS).toBe(5_000);
    // Windows wide enough for a loaded machine (a CI at low priority): a heartbeat every 100 ms,
    // stale after 2 s, and the holder busy for more than twice that.
    const options = { staleMs: 2_000, heartbeatMs: 100 };
    const held = await acquireJournalLock(lockPath(), options);
    await new Promise((done) => setTimeout(done, 4_500));
    const other = await acquireJournalLock(lockPath(), { ...options, timeoutMs: 500 }).catch(
      (caught: unknown) => caught,
    );
    expect(other).toMatchObject({ code: ErrorCode.JOURNAL_BUSY });
    await held.release();
    const next = await acquireJournalLock(lockPath(), { ...options, timeoutMs: 1_000 });
    expect(next.reclaimed).toBe(false);
    await next.release();
  });

  it("never deletes a lock that is no longer its own", async () => {
    const held = await acquireJournalLock(lockPath(), { staleMs: 300, heartbeatMs: 50 });
    // Taken over meanwhile by someone else: the release leaves the new owner's lock alone.
    await writeFile(lockPath(), "someone else\n");
    await held.release();
    expect(await readFile(lockPath(), "utf8")).toBe("someone else\n");
    await rm(lockPath());
  });
});

describe("GitStateStore: heads cache", () => {
  const cache = () => join(repo, JOURNAL_HEADS_CACHE);

  it("rebuilds a deleted cache and chains correctly", async () => {
    const first = store();
    await first.append(draft(1));
    const last = await first.append(draft(2));
    await rm(cache());
    const next = store();
    const event = await next.append(draft(3));
    expect(event.prev).toBe(hash(last));
    expect(next.stats.cacheRebuilds).toBe(1);
    expect(existsSync(cache())).toBe(true);
  });

  it.each([
    ["garbage", () => "not json"],
    [
      "a wrong hash",
      (text: string) =>
        text.replace(/"hash": "sha256:[^"]+"/, `"hash": "sha256:${"A".repeat(43)}"`),
    ],
    [
      "an unknown commit",
      (text: string) => text.replace(/"commit": "[0-9a-f]+"/, `"commit": "${"1".repeat(40)}"`),
    ],
    [
      "a missing path",
      (text: string) =>
        text.replace(
          /"path": "[^"]+"/,
          '"path": "journal/2020/01/01JZ8888888888888888888888.json"',
        ),
    ],
  ])("rebuilds a cache holding %s", async (_name, corrupt) => {
    const first = store();
    await first.append(draft(1));
    const last = await first.append(draft(2));
    await writeFile(cache(), corrupt(await readFile(cache(), "utf8")));
    const next = store();
    const event = await next.append(draft(3));
    expect(event.prev).toBe(hash(last));
    expect(next.stats.cacheRebuilds).toBe(1);
  });

  it("brings an old cache up to date from the commits written since", async () => {
    const first = store();
    await first.append(draft(1));
    const old = await readFile(cache(), "utf8");
    await first.append(draft(2));
    const last = await first.append(draft(3));
    await writeFile(cache(), old);
    const next = store();
    expect((await next.append(draft(4))).prev).toBe(hash(last));
    expect(next.stats.cacheRebuilds).toBe(0);
  });

  it("follows the commits of another writer without rebuilding", async () => {
    const a = store(repo, SEED_A);
    const b = store(repo, SEED_B);
    await a.append(draft(1));
    await b.append(draft(1));
    const rebuilds = a.stats.cacheRebuilds + b.stats.cacheRebuilds;
    for (let n = 2; n <= 5; n++) {
      await a.append(draft(n));
      await b.append(draft(n));
    }
    expect(a.stats.cacheRebuilds + b.stats.cacheRebuilds).toBe(rebuilds);
    expect([...(await checkChains((await a.list()).events)).values()].sort()).toEqual([6, 7]);
  });
});

describe("GitStateStore: compare-and-swap", () => {
  it("retries once when the reference moves under the lock, chained on the new head", async () => {
    const setup = store();
    await setup.append(draft(1));
    const head = git(repo, "rev-parse", REF);
    // A commit written without the lock: same tree, no event.
    const foreign = git(repo, "commit-tree", `${head}^{tree}`, "-p", head, "-m", "foreign");
    let armed = true;
    const journal = store(repo, SEED_A, {
      now: () => {
        // Called while preparing the event, inside the lock: the reference moves now.
        if (armed) {
          armed = false;
          git(repo, "update-ref", REF, foreign, head);
        }
        return Date.now();
      },
    });
    const moved = await journal.append(draft(2));
    expect(journal.stats.casRetries).toBe(1);
    expect(git(repo, "rev-parse", `${REF}^`)).toBe(foreign);
    const later = await journal.append(draft(3));
    expect(later.prev).toBe(hash(moved));
    expect(journal.stats.casRetries).toBe(1);
    const { events } = await journal.list();
    expect(events.filter((event) => event.type === "test.appended")).toHaveLength(3);
  });
});

describe("GitStateStore: product id", () => {
  const CONFIG = ".agentplugged/method.yaml";
  const OLD = "# mine\nformat_version: 2\nengine_version: 0.1.0\n";
  const append = (journal: GitStateStore, product: string) =>
    journal.append({ ...draft(1), product });

  it("is created once in the journal, and adopted by another worktree", async () => {
    const other = join(base, "feat-x");
    git(repo, "worktree", "add", "-q", "-b", "feat/x", other);
    const filesA = new NodeWorkspaceFiles(repo);
    const filesB = new NodeWorkspaceFiles(other);
    await filesA.writeText(CONFIG, OLD);
    await filesB.writeText(CONFIG, OLD);
    const journalA = store(repo);
    const journalB = store(other, SEED_B);

    const fromA = await ensureProductId(filesA, () => "01JZAAAAAAAAAAAAAAAAAAAAAA", journalA);
    expect(fromA).toEqual({ productId: "01JZAAAAAAAAAAAAAAAAAAAAAA", added: true });
    await append(journalA, "01JZAAAAAAAAAAAAAAAAAAAAAA");

    const fromB = await ensureProductId(filesB, () => "01JZBBBBBBBBBBBBBBBBBBBBBB", journalB);
    expect(fromB).toEqual({ productId: "01JZAAAAAAAAAAAAAAAAAAAAAA", added: true });
    expect(await filesB.readText(CONFIG)).toBe(`${OLD}product_id: 01JZAAAAAAAAAAAAAAAAAAAAAA\n`);
    await append(journalB, "01JZAAAAAAAAAAAAAAAAAAAAAA");
    const { events } = await journalB.list();
    expect(events.filter((event) => event.type === EVENT_TYPES.productCreated)).toHaveLength(1);
  });

  it("refuses another product id than the journal's, and writes nothing", async () => {
    const other = join(base, "feat-x");
    git(repo, "worktree", "add", "-q", "-b", "feat/x", other);
    const journalA = store(repo);
    await append(journalA, "01JZAAAAAAAAAAAAAAAAAAAAAA");
    const head = await journalA.head();
    // The other worktree made its own id before the journal held one.
    const filesB = new NodeWorkspaceFiles(other);
    await filesB.writeText(CONFIG, `${OLD}product_id: 01JZBBBBBBBBBBBBBBBBBBBBBB\n`);
    const journalB = store(other, SEED_B);
    const mismatch = {
      code: ErrorCode.PRODUCT_ID_MISMATCH,
      message_key: "error.product_id_mismatch",
      details: {
        product_id: "01JZBBBBBBBBBBBBBBBBBBBBBB",
        journal_product_id: "01JZAAAAAAAAAAAAAAAAAAAAAA",
      },
    };
    const checked = await ensureProductId(filesB, () => "01JZCCCCCCCCCCCCCCCCCCCCCC", journalB);
    expect(checked).toMatchObject(mismatch);
    await expect(append(journalB, "01JZBBBBBBBBBBBBBBBBBBBBBB")).rejects.toMatchObject(mismatch);
    expect(await journalB.head()).toBe(head);
  });

  it("refuses the engine's own event types", async () => {
    const journal = store();
    for (const type of [EVENT_TYPES.deviceRegistered, EVENT_TYPES.productCreated]) {
      await expect(journal.append({ ...draft(1), type })).rejects.toMatchObject({
        code: ErrorCode.EVENT_INVALID,
        details: { field: "type", reason_key: "reason.reserved_type" },
      });
    }
    expect(await journal.head()).toBeNull();
  });
});

describe("GitStateStore: reading", () => {
  it("reports an unreadable entry without hiding the others", async () => {
    const journal = store();
    const first = await journal.append(draft(1));
    const head = git(repo, "rev-parse", REF);
    // A foreign file added with plumbing and a temporary index.
    const index = join(base, "foreign.index");
    const env = { ...process.env, GIT_INDEX_FILE: index };
    const run = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: repo, env, encoding: "utf8", input: "{oops" });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    run("read-tree", head);
    const blob = run("hash-object", "-w", "--stdin");
    run(
      "update-index",
      "--add",
      "--cacheinfo",
      `100644,${blob},journal/2026/01/01JZ9999999999999999999999.json`,
    );
    // A valid event at a path its own date and id do not give.
    const valid = git(repo, "rev-parse", `${REF}:${eventPath(first)}`);
    const misplaced = `journal/1999/01/${first.id}.json`;
    run("update-index", "--add", "--cacheinfo", `100644,${valid},${misplaced}`);
    const tree = run("write-tree");
    const commit = git(repo, "commit-tree", tree, "-p", head, "-m", "foreign");
    git(repo, "update-ref", REF, commit, head);

    const { events, problems } = await store().list();
    expect(events).toHaveLength(3);
    expect(problems).toEqual(
      [
        {
          path: "journal/2026/01/01JZ9999999999999999999999.json",
          error: expect.objectContaining({ code: ErrorCode.EVENT_INVALID }),
        },
        {
          path: misplaced,
          error: expect.objectContaining({
            code: ErrorCode.EVENT_INVALID,
            details: expect.objectContaining({ field: "id" }),
          }),
        },
      ].sort((a, b) => (a.path < b.path ? -1 : 1)),
    );
    // The writer gets past it: the foreign commit names no event, the cache is rebuilt.
    const next = await journal.append(draft(2));
    expect(next.prev).toBe(hash(first));
  });

  it("refuses a folder outside any Git repository with NOT_A_GIT_REPO", async () => {
    const outside = join(base, "plain");
    await mkdir(outside);
    const ceiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = base;
    try {
      const journal = store(outside);
      const notARepo = { code: ErrorCode.NOT_A_GIT_REPO, message_key: "error.not_a_git_repo" };
      await expect(journal.append(draft(1))).rejects.toMatchObject(notARepo);
      await expect(journal.list()).rejects.toMatchObject(notARepo);
      await expect(journal.head()).rejects.toMatchObject(notARepo);
      await expect(store(join(base, "missing")).head()).rejects.toMatchObject(notARepo);
    } finally {
      if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = ceiling;
    }
  });
});

describe("GitStateStore: several drafts in one write", () => {
  it("writes them in one commit, chained in order", async () => {
    const journal = store();
    await journal.append(draft(0));
    const before = git(repo, "rev-list", "--count", REF);
    const written = await journal.appendAll([draft(1), draft(2)]);
    expect(written.map((event) => event.payload)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(written[1]?.prev).toBe(hash(written[0] as EventEnvelope));
    expect(Number(git(repo, "rev-list", "--count", REF))).toBe(Number(before) + 1);
  });

  it("writes none when a later draft is refused", async () => {
    const journal = store();
    await journal.append(draft(0));
    const head = await journal.head();
    await expect(
      journal.appendAll([draft(1), { ...draft(2), type: "checkpoint.opened", payload: {} }]),
    ).rejects.toMatchObject({ code: ErrorCode.EVENT_INVALID });
    expect(await journal.head()).toBe(head);
    expect((await journal.list()).events).toHaveLength(3);
  });

  it("writes a sprint and its checkpoint in one commit, the sprint naming it", async () => {
    const journal = store();
    await journal.append(draft(0));
    const before = git(repo, "rev-list", "--count", REF);
    const agent = { kind: "agent" as const, agent: "izzy" };
    const opened: EventDraft = {
      type: "checkpoint.opened",
      actor: agent,
      product: PRODUCT,
      provenance: "trusted",
      payload: {
        type: "document",
        risk: "medium",
        irreversible: false,
        recipient_role: "product",
        confirmation: ["gesture_undo_10s"],
        title: "Sprint: Sign up",
        summary: "Accounts first.",
        documents: [],
        blocks: [],
      },
    };
    const sprint: EventDraft = {
      type: "sprint.planned",
      actor: agent,
      product: PRODUCT,
      provenance: "trusted",
      payload: {
        goal: "Sign up",
        stories: [{ id: "1-1", owner: "sam", budget_usd: 2 }],
        capacity: { agents: ["sam"], humans: 0 },
        budget_usd: 2,
      },
      checkpointField: "checkpoint",
    };
    // Without its checkpoint right before it: nothing written, never a placeholder signed.
    const head = await journal.head();
    await expect(journal.appendAll([draft(1), sprint])).rejects.toMatchObject({
      code: ErrorCode.EVENT_INVALID,
      details: { field: "checkpointField" },
    });
    expect(await journal.head()).toBe(head);
    const [checkpoint, planned] = await journal.appendAll([opened, sprint]);
    expect(Number(git(repo, "rev-list", "--count", REF))).toBe(Number(before) + 1);
    expect(planned?.prev).toBe(hash(checkpoint as EventEnvelope));
    expect(planned?.payload?.checkpoint).toBe(`G-${checkpoint?.id.slice(-10)}`);
    expect(planned).not.toHaveProperty("checkpointField");
    const listed = await journal.list();
    const projection = await computeProjection(listed.events, { allowTestTypes: true });
    expect(projection.ignored).toEqual([]);
    expect(Object.keys(projection.state.sprints as object)).toEqual([
      `S-${planned?.id.slice(-10)}`,
    ]);
  });

  it("refuses an empty write", async () => {
    await expect(store().appendAll([])).rejects.toMatchObject({
      code: ErrorCode.UNEXPECTED,
      details: { reason: "no event to append" },
    });
  });

  it("checks the precondition under the lock, on the journal at the head written on", async () => {
    const journal = store();
    const other = store(repo, SEED_B);
    await journal.append(draft(0));
    // Another writer appends between this writer's start and its write: the check sees it.
    const seen: number[] = [];
    await other.append(draft(1));
    await journal.appendAll([draft(2)], {
      precondition: (listing) => {
        seen.push(listing.events.length);
      },
    });
    expect(seen).toEqual([5]);
    const head = await journal.head();
    await expect(
      journal.appendAll([draft(3)], {
        precondition: (listing) => {
          if (listing.events.some((event) => (event.payload as { n?: number }).n === 1)) {
            throw new Error("refused");
          }
        },
      }),
    ).rejects.toThrow("refused");
    expect(await journal.head()).toBe(head);
    // The lock was released: the next write goes through.
    await journal.append(draft(4));
  });
});

describe("GitStateStore: an object Git reports unavailable", () => {
  const unavailable = () =>
    new Error(
      "git mktree --batch: exited (128): fatal: entry '01M47YPY6ZZVFDJR1NAJF968RJ.json' object c591d057d4e2 is unavailable",
    );

  it("recognises the failure, and only that one", () => {
    expect(isObjectUnavailable(unavailable())).toBe(true);
    expect(
      isObjectUnavailable(new Error("git mktree --batch: exited (128): fatal: bad tree")),
    ).toBe(false);
    expect(isObjectUnavailable("is unavailable")).toBe(false);
  });

  it("writes again once, from fresh processes, and the event is there exactly once", async () => {
    let calls = 0;
    const journal = store(repo, SEED_A, {
      beforeBuild: () => {
        calls += 1;
        if (calls === 1) throw unavailable();
      },
    });
    await journal.append(draft(1));
    expect(calls).toBe(2);
    expect(journal.stats.objectRetries).toBe(1);
    const { events, problems } = await journal.list();
    expect(problems).toEqual([]);
    expect(events.filter((event) => event.type === "test.appended")).toHaveLength(1);
    // The journal goes on as usual.
    await journal.append(draft(2));
    expect(journal.stats.objectRetries).toBe(1);
  });

  it("fails when the second try fails too, writing nothing", async () => {
    const journal = store(repo, SEED_A, {
      beforeBuild: () => {
        throw unavailable();
      },
    });
    await expect(journal.append(draft(1))).rejects.toThrow("is unavailable");
    expect(journal.stats.objectRetries).toBe(1);
    expect(await journal.head()).toBeNull();
  });

  it("does not retry another failure", async () => {
    let calls = 0;
    const journal = store(repo, SEED_A, {
      beforeBuild: () => {
        calls += 1;
        throw new Error("something else");
      },
    });
    await expect(journal.append(draft(1))).rejects.toThrow("something else");
    expect(calls).toBe(1);
  });
});
