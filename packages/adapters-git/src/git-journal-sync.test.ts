import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AgentPluggedError,
  type EventDraft,
  type JournalSync,
  MemoryKeyStore,
  syncJournal,
} from "@agentplugged/core";
import { eventHash, toBase64url } from "@agentplugged/crypto";
import { ErrorCode, type EventEnvelope } from "@agentplugged/protocol";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eventPath, GitStateStore, JOURNAL_AUTHOR, journalRemoteKey } from "./index.js";

// Real repositories and a real (temporary, bare) remote: slower than vitest's 5 s default.
vi.setConfig({ testTimeout: 120_000 });

const REF = "refs/heads/agentplugged/journal";
/** The `seen` and remote-tracking references of the remote, keyed by its URL. */
const seenRef = () => `refs/agentplugged/seen/${journalRemoteKey(remote)}`;
const trackingRef = () => `refs/agentplugged/remotes/${journalRemoteKey(remote)}/journal`;
const PRODUCT = "01JZ0000000000000000000000";
const OTHER_PRODUCT = "01JZ1111111111111111111111";
const SEED_A = toBase64url(new Uint8Array(32).fill(1));
const SEED_B = toBase64url(new Uint8Array(32).fill(2));
const SEED_C = toBase64url(new Uint8Array(32).fill(3));

const draft = (n: number, product = PRODUCT): EventDraft => ({
  type: "test.appended",
  actor: { kind: "system" },
  product,
  provenance: "trusted",
  payload: { n },
});

/** Runs git in a test repository; never in this one, never on the network. */
function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const saved: Record<string, string | undefined> = {};
let base: string;
let remote: string;
const stores: GitStateStore[] = [];

/** Git sees neither this repository, nor the creator's global or system configuration. */
beforeAll(async () => {
  const isolated = await mkdtemp(join(tmpdir(), "agentplugged-gitconfig-"));
  const global = join(isolated, "gitconfig");
  await writeFile(global, "");
  const env = {
    GIT_CONFIG_GLOBAL: global,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: await realpath(tmpdir()),
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** Identity of a test repository: Ada, never the creator's. */
function identify(path: string) {
  git(path, ["config", "user.name", "Ada"]);
  git(path, ["config", "user.email", "ada@example.com"]);
  git(path, ["config", "core.autocrlf", "false"]);
}

/** A repository with a first commit on `main`, and `.agentplugged/`. */
async function makeRepo(path: string, origin: string | null = remote): Promise<string> {
  await mkdir(path, { recursive: true });
  git(path, ["init", "-q", "-b", "main"]);
  identify(path);
  await writeFile(join(path, "README.md"), "product\n");
  await mkdir(join(path, ".agentplugged"));
  await writeFile(join(path, ".agentplugged/.gitignore"), ".cache/\n");
  git(path, ["add", "."]);
  git(path, ["commit", "-q", "-m", "first"]);
  if (origin !== null) git(path, ["remote", "add", "origin", origin]);
  return path;
}

/** A clone of the remote (after `makeRepo` pushed `main` there). */
async function cloneRemote(path: string): Promise<string> {
  git(base, ["clone", "-q", remote, path]);
  identify(path);
  return path;
}

function store(cwd: string, seed: string): GitStateStore {
  const created = new GitStateStore({
    allowTestTypes: true,
    cwd,
    keys: new MemoryKeyStore(seed),
    machineLockPath: join(base, `machine-key-${seed.slice(0, 4)}.lock`),
  });
  stores.push(created);
  return created;
}

async function append(journal: GitStateStore, count: number, product = PRODUCT) {
  const events: EventEnvelope[] = [];
  for (let n = 0; n < count; n++) events.push(await journal.append(draft(n, product)));
  return events;
}

/** Everything a sync must leave alone in a working copy. */
async function checkout(path: string) {
  const gitDir = resolve(path, git(path, ["rev-parse", "--git-dir"]));
  return {
    head: git(path, ["rev-parse", "HEAD"]),
    branch: git(path, ["symbolic-ref", "HEAD"]),
    status: git(path, ["status", "--porcelain", "--untracked-files=all"]),
    index: (await readFile(join(gitDir, "index"))).toString("base64"),
    // Filtered here, not with `--exclude` (Git 2.42 and later only).
    branches: git(path, ["for-each-ref", "refs/heads/"])
      .split("\n")
      .filter((line) => !/\trefs\/heads\/agentplugged\//.test(line))
      .join("\n"),
    tags: git(path, ["tag"]),
    fetchHead: existsSync(join(gitDir, "FETCH_HEAD")),
  };
}

const remoteHead = () => {
  const result = spawnSync("git", ["rev-parse", "-q", "--verify", REF], {
    cwd: remote,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
};

/** Every value the remote's journal branch took, oldest first. */
const remoteHistory = () =>
  git(remote, ["reflog", "show", "--format=%H", REF]).split("\n").filter(Boolean).reverse();

/** True when each update of the remote's journal was a fast-forward. */
function onlyFastForwards(): boolean {
  const values = remoteHistory();
  return values.every((value, i) => {
    const before = values[i - 1];
    if (before === undefined) return true;
    return (
      spawnSync("git", ["merge-base", "--is-ancestor", before, value], { cwd: remote }).status === 0
    );
  });
}

async function rejection(promise: Promise<unknown>): Promise<AgentPluggedError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AgentPluggedError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

/** A commit made directly in the remote: `tip`'s tree with files set or removed. */
function remoteCommit(
  tip: string,
  change: { set?: Record<string, string>; remove?: string[]; parents?: string[] },
): string {
  const env = { GIT_INDEX_FILE: join(base, "remote-index") };
  git(remote, ["read-tree", tip], env);
  for (const path of change.remove ?? []) git(remote, ["rm", "-q", "--cached", path], env);
  for (const [path, content] of Object.entries(change.set ?? {})) {
    const file = join(base, "content.tmp");
    writeFileSync(file, content);
    const blob = git(remote, ["hash-object", "-w", file]);
    git(remote, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], env);
  }
  const tree = git(remote, ["write-tree"], env);
  const parents = (change.parents ?? [tip]).flatMap((parent) => ["-p", parent]);
  return git(remote, ["commit-tree", tree, ...parents, "-m", "rewritten elsewhere"]);
}

function hash(event: EventEnvelope): string {
  const result = eventHash(event);
  if (!result.ok) throw new Error("no hash");
  return result.hash;
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "agentplugged-sync-"));
  remote = join(base, "remote.git");
  git(base, ["init", "-q", "--bare", "-b", "main", remote]);
  identify(remote);
  git(remote, ["config", "core.logAllRefUpdates", "always"]);
  git(remote, ["config", "receive.denyNonFastForwards", "true"]);
});

afterEach(async () => {
  for (const opened of stores.splice(0)) opened.close();
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Machine A (a repository pushed to the remote) and machine B (a clone of it). */
async function twoMachines() {
  const pathA = await makeRepo(join(base, "a"));
  git(pathA, ["push", "-q", "origin", "main"]);
  const pathB = await cloneRemote(join(base, "b"));
  return { pathA, pathB, a: store(pathA, SEED_A), b: store(pathB, SEED_B) };
}

describe("journal sync with a bare remote", () => {
  it("creates the remote branch, then fast-forwards the other machine, touching nothing else", async () => {
    const { pathA, pathB, a, b } = await twoMachines();
    await append(a, 3);
    const beforeA = await checkout(pathA);
    const beforeB = await checkout(pathB);

    expect(await syncJournal(a)).toEqual({
      remote: "origin",
      integration: "none",
      received: 0,
      sent: 5,
      created: true,
      pushes: 1,
      empty: false,
    });
    const head = git(pathA, ["rev-parse", REF]);
    expect(remoteHead()).toBe(head);
    expect(git(pathA, ["rev-parse", seenRef()])).toBe(head);

    expect(await syncJournal(b)).toEqual({
      remote: "origin",
      integration: "fast_forward",
      received: 5,
      sent: 0,
      created: false,
      pushes: 0,
      empty: false,
    });
    expect(git(pathB, ["rev-parse", REF])).toBe(head);
    expect(git(pathB, ["rev-parse", seenRef()])).toBe(head);
    expect(git(pathB, ["rev-parse", trackingRef()])).toBe(head);
    expect((await b.list()).events).toEqual((await a.list()).events);

    // HEAD, index, working copy, branches, tags, FETCH_HEAD: untouched.
    expect(await checkout(pathA)).toEqual(beforeA);
    expect(await checkout(pathB)).toEqual(beforeB);
    expect(existsSync(join(pathB, "journal"))).toBe(false);
    // The references kept by sync are never pushed.
    expect(git(remote, ["for-each-ref", "--format=%(refname)"]).split("\n").sort()).toEqual([
      "refs/heads/agentplugged/journal",
      "refs/heads/main",
    ]);
  });

  it("gathers 2 × 20 events; each push is a fast-forward; writing goes on after the merge", async () => {
    const { pathA, pathB, a, b } = await twoMachines();
    const fromA = await append(a, 20);
    const fromB = await append(b, 20);

    expect(await syncJournal(a)).toMatchObject({ sent: 22, created: true });
    expect(await syncJournal(b)).toMatchObject({
      integration: "merge",
      received: 22,
      sent: 22,
      pushes: 1,
    });
    expect(await syncJournal(a)).toMatchObject({
      integration: "fast_forward",
      received: 22,
      sent: 0,
    });

    const listA = await a.list();
    const listB = await b.list();
    expect(listA.problems).toEqual([]);
    expect(listB).toEqual(listA);
    const ids = new Set(listA.events.map((event) => event.id));
    for (const event of [...fromA, ...fromB]) expect(ids.has(event.id)).toBe(true);
    expect(listA.events.filter((event) => event.type === "test.appended")).toHaveLength(40);
    expect(git(pathA, ["rev-parse", REF])).toBe(git(pathB, ["rev-parse", REF]));
    expect(remoteHistory()).toHaveLength(2);
    expect(onlyFastForwards()).toBe(true);

    // The merge commit: two parents, the technical author, its fixed message.
    const merge = git(pathB, ["log", "-1", "--format=%P|%an <%ae>|%s", REF]).split("|");
    expect(merge[0]?.split(" ")).toHaveLength(2);
    expect(merge[1]).toBe(JOURNAL_AUTHOR);
    expect(merge[2]).toBe("journal: merge origin");

    // The heads cache is rebuilt past the merge: B's next event chains on its own last one.
    const next = await b.append(draft(99));
    const lastOfB = fromB.at(-1) as EventEnvelope;
    expect(next.prev).toBe(hash(lastOfB));
    const nextOfA = await a.append(draft(98));
    expect(nextOfA.prev).toBe(hash(fromA.at(-1) as EventEnvelope));
    expect(git(pathB, ["cat-file", "-e", `${REF}:${eventPath(next)}`])).toBe("");
  });

  it("fetches, integrates and pushes again when the remote moves before the push", async () => {
    const { a, b } = await twoMachines();
    await append(a, 1);
    await syncJournal(a);
    await syncJournal(b);
    await append(b, 2);
    let raced = 0;
    const racing: JournalSync = port(b, async () => {
      if (raced > 0) return;
      raced += 1;
      // A pushes first, between B's fetch and B's push.
      await append(a, 1);
      await syncJournal(a);
    });
    const result = await syncJournal(racing);
    // B's own device.registered and its 2 events; A's event merged in.
    expect(result).toMatchObject({ integration: "merge", received: 1, sent: 3, pushes: 2 });
    expect(remoteHead()).toBe(await b.head());
    expect(onlyFastForwards()).toBe(true);
  });

  it("gives JOURNAL_PUSH_REJECTED after 3 refused pushes", async () => {
    const { a, b } = await twoMachines();
    await append(a, 1);
    await syncJournal(a);
    await append(b, 1);
    let others = 0;
    const racing = port(b, async () => {
      others += 1;
      await append(a, 1);
      await syncJournal(a);
    });
    const error = await rejection(syncJournal(racing));
    expect(error.toPayload()).toEqual({
      code: ErrorCode.JOURNAL_PUSH_REJECTED,
      message_key: "error.journal_push_rejected",
      details: { remote: "origin", attempts: 3 },
    });
    expect(others).toBe(3);
    expect(remoteHead()).toBe(await a.head());
    expect(onlyFastForwards()).toBe(true);
  });

  it("refuses a remote forced back, integrates and pushes nothing, then takes it once restored", async () => {
    const { pathB, a, b } = await twoMachines();
    await append(a, 1);
    await syncJournal(a);
    const old = remoteHead() as string;
    await append(a, 2);
    await syncJournal(a);
    await syncJournal(b);
    await append(b, 1);
    git(remote, ["update-ref", REF, old]);
    const before = git(pathB, ["rev-parse", REF]);

    const error = await rejection(syncJournal(b));
    expect(error.toPayload()).toEqual({
      code: ErrorCode.JOURNAL_REWRITTEN,
      message_key: "error.journal_rewritten",
      details: { remote: "origin", missing: 2 },
    });
    expect(git(pathB, ["rev-parse", REF])).toBe(before);
    expect(remoteHead()).toBe(old);
    // The remote-tracking reference did not follow the refused tip.
    const restored = git(pathB, ["rev-parse", seenRef()]);
    expect(git(pathB, ["rev-parse", trackingRef()])).toBe(restored);

    // The remote restored: the next sync goes through.
    git(remote, ["update-ref", REF, restored]);
    expect(await syncJournal(b)).toMatchObject({ integration: "none", sent: 2, pushes: 1 });
    expect(remoteHead()).toBe(git(pathB, ["rev-parse", REF]));
  });

  it("refuses a remote commit that drops an event already seen", async () => {
    const { pathB, a, b } = await twoMachines();
    const [event] = await append(a, 1);
    await syncJournal(a);
    await syncJournal(b);
    const tip = remoteHead() as string;
    const dropped = remoteCommit(tip, { remove: [eventPath(event as EventEnvelope)] });
    git(remote, ["update-ref", REF, dropped]);
    const before = git(pathB, ["rev-parse", REF]);

    const error = await rejection(syncJournal(b));
    expect(error.code).toBe(ErrorCode.JOURNAL_REWRITTEN);
    expect(error.details).toEqual({ remote: "origin", missing: 1 });
    expect(git(pathB, ["rev-parse", REF])).toBe(before);
    expect(git(pathB, ["rev-parse", seenRef()])).toBe(tip);
  });

  it("refuses the same path with another content, and an invalid incoming file", async () => {
    const { pathB, a, b } = await twoMachines();
    const [event] = await append(a, 1);
    await syncJournal(a);
    await syncJournal(b);
    await append(b, 1);
    const tip = remoteHead() as string;
    const path = eventPath(event as EventEnvelope);
    git(remote, ["update-ref", REF, remoteCommit(tip, { set: { [path]: "{}\n" } })]);
    const before = git(pathB, ["rev-parse", REF]);

    const changed = await rejection(syncJournal(b));
    expect(changed.toPayload()).toEqual({
      code: ErrorCode.JOURNAL_CONFLICT,
      message_key: "error.journal_conflict.content",
      details: { remote: "origin", path },
    });
    expect(git(pathB, ["rev-parse", REF])).toBe(before);

    const bad = "journal/2026/01/01JZ2222222222222222222222.json";
    // A later remote commit: the original content back, and a file that is no event.
    const changedTip = remoteHead() as string;
    const invalidTip = remoteCommit(tip, { set: { [bad]: "not json\n" }, parents: [changedTip] });
    git(remote, ["update-ref", REF, invalidTip]);
    const invalid = await rejection(syncJournal(b));
    expect(invalid.toPayload()).toEqual({
      code: ErrorCode.JOURNAL_CONFLICT,
      message_key: "error.journal_conflict.invalid",
      details: { remote: "origin", path: bad },
    });
    expect(git(pathB, ["rev-parse", REF])).toBe(before);
    expect(onlyFastForwards()).toBe(true);
  });

  it("refuses a remote journal of another product, and merges nothing", async () => {
    const { pathB, a, b } = await twoMachines();
    await append(a, 1);
    await syncJournal(a);
    await append(b, 1, OTHER_PRODUCT);
    const before = git(pathB, ["rev-parse", REF]);
    const error = await rejection(syncJournal(b));
    expect(error.toPayload()).toEqual({
      code: ErrorCode.PRODUCT_ID_MISMATCH,
      message_key: "error.product_id_mismatch.remote",
      details: { remote: "origin", product_id: PRODUCT, journal_product_id: OTHER_PRODUCT },
    });
    expect(git(pathB, ["rev-parse", REF])).toBe(before);
    expect(remoteHead()).toBe(await a.head());
  });

  it("gives NO_REMOTE without a remote, or with an unknown one", async () => {
    const alone = await makeRepo(join(base, "alone"), null);
    const journal = store(alone, SEED_C);
    await append(journal, 1);
    expect((await rejection(syncJournal(journal))).toPayload()).toEqual({
      code: ErrorCode.NO_REMOTE,
      message_key: "error.no_remote",
      details: {},
    });
    git(alone, ["remote", "add", "origin", remote]);
    expect((await rejection(syncJournal(journal, { remote: "nope" }))).toPayload()).toEqual({
      code: ErrorCode.NO_REMOTE,
      message_key: "error.no_remote.named",
      details: { remote: "nope" },
    });
    expect(remoteHead()).toBeNull();
  });

  it("uses the remote the current branch tracks, then origin, or the one named", async () => {
    const path = await makeRepo(join(base, "tracked"));
    const upstream = join(base, "upstream.git");
    git(base, ["init", "-q", "--bare", upstream]);
    git(path, ["remote", "add", "upstream", upstream]);
    const journal = store(path, SEED_C);
    expect(await journal.resolveRemote(undefined)).toBe("origin");
    git(path, ["config", "branch.main.remote", "upstream"]);
    expect(await journal.resolveRemote(undefined)).toBe("upstream");
    expect(await journal.resolveRemote("origin")).toBe("origin");
    await append(journal, 1);
    expect(await syncJournal(journal)).toMatchObject({ remote: "upstream", created: true });
    expect(remoteHead()).toBeNull();
  });

  it("says up to date and writes nothing when both sides are identical", async () => {
    const { pathA, pathB, a, b } = await twoMachines();
    await append(a, 2);
    await syncJournal(a);
    await syncJournal(b);
    const refs = (path: string) => git(path, ["for-each-ref", "--format=%(refname) %(objectname)"]);
    const reflog = (path: string) => git(path, ["reflog", "show", "--format=%H", REF]);
    const before = [refs(pathA), refs(pathB), reflog(pathA), reflog(pathB), remoteHistory()];
    for (const journal of [a, b]) {
      expect(await syncJournal(journal)).toEqual({
        remote: "origin",
        integration: "none",
        received: 0,
        sent: 0,
        created: false,
        pushes: 0,
        empty: false,
      });
    }
    expect([refs(pathA), refs(pathB), reflog(pathA), reflog(pathB), remoteHistory()]).toEqual(
      before,
    );
  });

  it("says the journal is empty when neither side holds one", async () => {
    const { a } = await twoMachines();
    expect(await syncJournal(a)).toMatchObject({ empty: true, sent: 0, pushes: 0 });
    expect(remoteHead()).toBeNull();
  });

  it("recreates a remote branch deleted after a rewrite, only with --recreate-remote", async () => {
    const { pathA, a } = await twoMachines();
    await append(a, 1);
    await syncJournal(a);
    git(remote, ["update-ref", "-d", REF]);
    const gone = await rejection(syncJournal(a));
    expect(gone.toPayload()).toEqual({
      code: ErrorCode.JOURNAL_REWRITTEN,
      message_key: "error.journal_rewritten",
      details: { remote: "origin", missing: 3 },
    });
    expect(remoteHead()).toBeNull();

    expect(await syncJournal(a, { recreateRemote: true })).toMatchObject({
      created: true,
      sent: 3,
      pushes: 1,
    });
    const head = git(pathA, ["rev-parse", REF]);
    expect(remoteHead()).toBe(head);
    expect(git(pathA, ["rev-parse", seenRef()])).toBe(head);
    const again = await rejection(syncJournal(a, { recreateRemote: true }));
    expect(again.code).toBe(ErrorCode.INVALID_ARGUMENTS);
  });

  it("gives JOURNAL_REMOTE_UNREACHABLE for a remote that does not exist, or that takes too long", async () => {
    const { pathA, a } = await twoMachines();
    await append(a, 1);
    git(pathA, ["remote", "add", "lost", join(base, "no-such-remote.git")]);
    const lost = await rejection(syncJournal(a, { remote: "lost" }));
    expect(lost.code).toBe(ErrorCode.JOURNAL_REMOTE_UNREACHABLE);
    expect(lost.message_key).toBe("error.journal_remote_unreachable");
    expect(lost.details.remote).toBe("lost");
    expect(String(lost.details.reason)).toMatch(/^fatal: /);
    expect(String(lost.details.reason)).not.toContain("\n");

    const slow = new GitStateStore({
      allowTestTypes: true,
      cwd: pathA,
      keys: new MemoryKeyStore(SEED_A),
      machineLockPath: join(base, "machine-key-slow.lock"),
      remoteTimeoutMs: 1,
    });
    stores.push(slow);
    const timedOut = await rejection(syncJournal(slow));
    expect(timedOut.code).toBe(ErrorCode.JOURNAL_REMOTE_UNREACHABLE);
    expect(String(timedOut.details.reason)).toContain("took more than");
  });

  it("keys its references by the remote's URL: a name with / works, a renamed remote is no rewrite", async () => {
    const { pathA, a } = await twoMachines();
    await append(a, 1);
    git(pathA, ["remote", "add", "team/main", remote]);
    expect(await syncJournal(a, { remote: "team/main" })).toMatchObject({ created: true });
    // `origin` points at the same URL: same references, nothing to do.
    expect(await syncJournal(a)).toMatchObject({ integration: "none", pushes: 0 });
    git(pathA, ["remote", "rename", "team/main", "shared"]);
    expect(await syncJournal(a, { remote: "shared" })).toMatchObject({ pushes: 0 });
    expect(git(pathA, ["rev-parse", seenRef()])).toBe(git(pathA, ["rev-parse", REF]));
  });

  it("syncs two worktrees of one repository at the same time without losing an event", async () => {
    const { pathA, pathB, a, b } = await twoMachines();
    await append(b, 3);
    await syncJournal(b);
    const other = join(base, "a-feat");
    git(pathA, ["worktree", "add", "-q", "-b", "feat/x", other]);
    const main = store(pathA, SEED_A);
    const feat = store(other, SEED_A);
    await append(a, 2);
    await append(b, 2);
    await syncJournal(b);
    const once = async (journal: GitStateStore) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await syncJournal(journal);
        } catch (error) {
          if (attempt > 0 || !(error instanceof AgentPluggedError)) throw error;
          if (error.code !== ErrorCode.JOURNAL_BUSY) throw error;
        }
      }
    };
    await Promise.all([once(main), once(feat)]);
    await syncJournal(b);
    const ids = (await b.list()).events.map((event) => event.id);
    expect((await main.list()).events.map((event) => event.id)).toEqual(ids);
    // A: device.registered, product.created, 2 events; B: the same with 3 + 2 events.
    expect(ids).toHaveLength(4 + 7);
    expect(git(pathA, ["rev-parse", REF])).toBe(remoteHead());
    expect(git(pathB, ["rev-parse", REF])).toBe(remoteHead());
    expect(onlyFastForwards()).toBe(true);
  });

  it("gives NOT_A_GIT_REPO outside a repository", async () => {
    const folder = join(base, "plain");
    await mkdir(folder);
    const error = await rejection(syncJournal(store(folder, SEED_C)));
    expect(error.code).toBe(ErrorCode.NOT_A_GIT_REPO);
  });
});

/** `journal`'s port, with `beforePush` run before each push (another machine racing). */
function port(journal: GitStateStore, beforePush: () => Promise<void>): JournalSync {
  return {
    resolveRemote: (requested) => journal.resolveRemote(requested),
    fetchRemote: (name) => journal.fetchRemote(name),
    seen: (name) => journal.seen(name),
    markSeen: (name, commit) => journal.markSeen(name, commit),
    forgetSeen: (name) => journal.forgetSeen(name),
    isAncestor: (ancestor, descendant) => journal.isAncestor(ancestor, descendant),
    files: (commit) => journal.files(commit),
    readBlob: (blob) => journal.readBlob(blob),
    productIdAt: (commit) => journal.productIdAt(commit),
    head: () => journal.head(),
    withJournalLock: (task) => journal.withJournalLock(task),
    push: async (name, commit) => {
      await beforePush();
      return journal.push(name, commit);
    },
  };
}
