import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  AgentPluggedError,
  type AnnouncedKey,
  type AppendOptions,
  type AppendPrecondition,
  adoptRotatedKey,
  announcedKey,
  type BackupRemote,
  type Clock,
  checkHumanEvents,
  createUlidFactory,
  type DeviceHead,
  deviceHeads,
  type EventDraft,
  forgetProductKey,
  JOURNAL_REMOTE_NAME,
  type JournalBackupPort,
  type JournalFiles,
  type JournalHistory,
  type JournalListing,
  type JournalProblem,
  type JournalSync,
  type JournalWriter,
  journalProduct,
  type KeyStore,
  loadMachineKey,
  type MachineKey,
  type MachineLock,
  nextDeviceHead,
  type ProductKey,
  type PushOutcome,
  prepareAppend,
  prepareEngineEvents,
  type RemoteCallOptions,
  type RemoteExposure,
  type RemoteFetch,
  type RemoteJournalStatus,
  type StateStore,
  sensitiveProductKey,
  type UlidFactory,
} from "@agentplugged/core";
import { canonicalBytes, eventHash, randomBytes, sha256Hex, toHex } from "@agentplugged/crypto";
import {
  ErrorCode,
  EVENT_REASON,
  EVENT_TYPES,
  type EventEnvelope,
  eventInvalid,
  JOURNAL_DIR,
  JOURNAL_PROJECTED_REF,
  JOURNAL_REF,
  journalEventPath,
  journalRemoteRef,
  journalSeenRef,
  parseEventEnvelope,
} from "@agentplugged/protocol";
import { renameWithRetry } from "./atomic-rename.js";
import { GitBatch, type GitRun, runGit, treeFiles } from "./git-process.js";
import { probeExposure } from "./git-remote-exposure.js";
import { acquireJournalLock, type HeldLock, JOURNAL_LOCK_NAME } from "./journal-lock.js";

/** Fixed technical author of every journal commit, whatever the creator's Git identity. */
export const JOURNAL_AUTHOR = "agentplugged <journal@agentplugged.local>";
/** Cache of each writer's last event, under the working copy (ignored by `.agentplugged/.gitignore`). */
export const JOURNAL_HEADS_CACHE = ".agentplugged/.cache/journal-heads.json";
/** Machine-wide lock serialising the creation of the machine key (one per user account). */
export const MACHINE_KEY_LOCK = join(homedir(), ".agentplugged", "machine-key.lock");
/** Beyond this many new commits since the cache, the cache is rebuilt from the whole journal. */
const MAX_WALK = 256;
/** A transaction refused by the compare-and-swap (someone wrote without the lock) is retried. */
const MAX_ATTEMPTS = 3;
const TEMP_NAME = "agentplugged-journal.tmp";
/** How long a fetch or a push may take before `JOURNAL_REMOTE_UNREACHABLE`. */
export const REMOTE_TIMEOUT_MS = 120_000;
/** How long `init` waits for `git ls-remote` before it takes the remote for unreachable. */
export const REMOTE_CHECK_TIMEOUT_MS = 15_000;
/** Git's messages in English, whatever the creator's language: sync recognises some of them. */
const C_LOCALE = { LC_ALL: "C", LANGUAGE: "C" } as const;

/** The backup's memory, in the repository's Git folder (shared by its working copies, never versioned). */
const BACKUP_MEMORY = "agentplugged-journal-backup.json";

/** How long a remote found private is taken for private without asking again. */
const PRIVATE_KNOWN_MS = 2 * 60_000;

const EVENT_PATH = /^journal\/\d{4}\/\d{2}\/[0-9A-HJKMNP-TV-Z]{26}\.json$/;

export interface GitStateStoreOptions {
  /** A folder inside the working copy (or the repository). */
  readonly cwd: string;
  /** Where the machine key lives (`NodeKeyStore` in production). */
  readonly keys: KeyStore;
  /** The clock; called once per event prepared (tests use it as a hook inside the lock). */
  readonly now?: Clock;
  readonly newId?: UlidFactory;
  /** Lock wait before `JOURNAL_BUSY` (10 s by default). */
  readonly lockTimeoutMs?: number;
  /** Age after which a lock not refreshed is an orphan (30 s by default). */
  readonly staleLockMs?: number;
  /** Refresh period of the held lock (5 s by default). */
  readonly heartbeatMs?: number;
  /** Time limit of a fetch or a push (120 s by default). */
  readonly remoteTimeoutMs?: number;
  /** Time limit of the remote journal check of `init` (15 s by default). */
  readonly remoteCheckTimeoutMs?: number;
  /** Lock file serialising machine key creation (`~/.agentplugged/machine-key.lock`). */
  readonly machineLockPath?: string;
  /**
   * Absolute path of the heads cache. By default `.agentplugged/.cache/journal-heads.json` of the
   * working copy, written only when `.agentplugged/` exists.
   */
  readonly cachePath?: string;
  /** Accepts the event types reserved to tests (`test.*`): tests and measurements only. */
  readonly allowTestTypes?: boolean;
  /**
   * Runs before the trees of each write are built, inside the lock; a throw there is a failure of
   * the build (tests simulate an object Git reports unavailable). Never set in
   * production.
   */
  readonly beforeBuild?: () => void | Promise<void>;
  /**
   * Called once each write of this store has moved the journal (the automatic backup
   * sends the branch a few seconds later). Never called for what `journal sync` integrates. A throw
   * is ignored.
   */
  readonly onWrite?: () => void;
  /**
   * Who can read the repository of a remote; the anonymous `git ls-remote` of
   * `probeExposure` by default. Tests give their own.
   */
  readonly exposureProbe?: (
    url: string,
    cwd: string,
    timeoutMs?: number,
  ) => Promise<RemoteExposure>;
}

/** What the store did, for measurements. */
export interface GitStateStoreStats {
  appends: number;
  /** Transactions refused by `update-ref` (the reference moved under the lock). */
  casRetries: number;
  /** Total milliseconds spent waiting for the lock. */
  lockWaitMs: number;
  /** Orphan locks taken over. */
  locksReclaimed: number;
  /** Heads cache rebuilt from the whole journal. */
  cacheRebuilds: number;
  /** `git` processes started (one-shot and long-running). */
  gitStarts: number;
  /** Long-running processes restarted after one ended or answered out of protocol. */
  restarts: number;
  /** Writes done again once after Git reported an object unavailable. */
  objectRetries: number;
}

interface Repo {
  readonly commonDir: string;
  readonly topLevel: string | undefined;
  /** Bytes of an object id (20 for SHA-1, 32 for SHA-256). */
  readonly oidBytes: number;
}

interface TreeEntry {
  readonly mode: string;
  readonly type: "blob" | "tree" | "commit";
  readonly oid: string;
}

interface CachedEvent extends DeviceHead {
  readonly path: string;
}

/**
 * The journal as known at `commit`: each writer's head, and the `product.created` event
 * (`null`: checked absent at `commit`; `undefined`: unknown).
 */
interface HeadsCache {
  readonly commit: string;
  readonly devices: Record<string, CachedEvent>;
  readonly product?: { readonly id: string; readonly path: string } | null;
}

interface Batches {
  readonly cat: GitBatch;
  readonly blobs: GitBatch;
  readonly trees: GitBatch;
  readonly commits: GitBatch;
  readonly refs: GitBatch;
}

function notARepo(cwd: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.NOT_A_GIT_REPO, "error.not_a_git_repo", { path: cwd });
}

/** What one write builds before the reference moves (see `#makeCommit`). */
interface MadeCommit {
  readonly prepared: { events: readonly EventEnvelope[]; written: readonly EventEnvelope[] };
  readonly built: Map<string, Map<string, TreeEntry>>;
  readonly commit: string;
}

/**
 * True for the failure Git gives when an object it was just asked to use is not in the repository
 * (`git mktree --batch: … entry '…' object … is unavailable`): what a lack of memory leaves when
 * a long-running process was killed in the middle of a write. The next try, from fresh
 * processes, goes through.
 */
export function isObjectUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const text =
    error instanceof AgentPluggedError
      ? `${error.message} ${JSON.stringify(error.details)}`
      : error.message;
  return /\bis unavailable\b/i.test(text) && /\bgit\b/i.test(text);
}

function unexpected(reason: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", { reason });
}

/** `JOURNAL_REMOTE_UNREACHABLE`, with Git's own reason on one line. */
function unreachable(remote: string, run: Pick<GitRun, "stderr">): AgentPluggedError {
  const lines = run.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const reason =
    lines.find((line) => /^(fatal|error):/.test(line)) ?? lines.at(-1) ?? "no answer from Git";
  return new AgentPluggedError(
    ErrorCode.JOURNAL_REMOTE_UNREACHABLE,
    "error.journal_remote_unreachable",
    { remote, reason },
  );
}

/** Key of a remote's `remotes` and `seen` references: a hex hash of its URL. */
export function journalRemoteKey(url: string): string {
  return sha256Hex(url).slice(0, 32);
}

/** `journal/<YYYY>/<MM>/<ulid>.json`, from the event's UTC date. */
export function eventPath(event: EventEnvelope): string {
  return journalEventPath(event);
}

/** The file of an event: its canonical JSON (RFC 8785) and a final `\n`. */
export function eventFile(event: EventEnvelope): Buffer {
  return Buffer.concat([Buffer.from(canonicalBytes(event)), Buffer.from("\n")]);
}

const byId = (a: EventEnvelope, b: EventEnvelope) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The journal on the orphan branch `agentplugged/journal`, written with Git plumbing only: the
 * branch is never checked out, and neither the working copy, the creator's index nor `HEAD` is
 * touched. A whole transaction (head read, tree, commit, `update-ref <ref> <new> <old>`) runs
 * under the lock `agentplugged-journal.lock` of the common Git folder, shared by every worktree.
 * Long-running `git` processes keep the cost per event low; `close()` ends them. `head()` is the
 * journal's commit id. It is also the `JournalSync` of `journal sync`: fetch and push without
 * force, the `seen` references, and fast-forwards or merge commits under the same lock.
 */
export class GitStateStore implements StateStore, JournalSync, JournalBackupPort {
  readonly stats: GitStateStoreStats = {
    appends: 0,
    casRetries: 0,
    lockWaitMs: 0,
    locksReclaimed: 0,
    cacheRebuilds: 0,
    gitStarts: 0,
    restarts: 0,
    objectRetries: 0,
  };
  readonly #cwd: string;
  readonly #options: GitStateStoreOptions;
  readonly #now: Clock;
  readonly #newId: UlidFactory;
  #repo: Promise<Repo> | undefined;
  #batches: Batches | undefined;
  #key: MachineKey | undefined;
  #cache: HeadsCache | undefined;
  /** Trees read or built by the current transaction, then only those of the last commit. */
  #trees = new Map<string, Map<string, TreeEntry>>();
  /** Serialises this instance's requests to its long-running processes. */
  #queue: Promise<unknown> = Promise.resolve();
  /** Each remote's key (a hash of its URL), once read. */
  readonly #remoteKeys = new Map<string, string>();
  /** Remotes found private, and when: asked again after `PRIVATE_KNOWN_MS` (a send is never far from a check). */
  readonly #privateRemotes = new Map<string, number>();
  /** Writes of the backup's memory so far: names its temporary files apart. */
  #memoryWrites = 0;

  constructor(options: GitStateStoreOptions) {
    this.#options = options;
    this.#cwd = resolve(options.cwd);
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? createUlidFactory({ now: this.#now });
  }

  async append(draft: EventDraft): Promise<EventEnvelope> {
    const [event] = await this.appendAll([draft]);
    if (event === undefined) throw unexpected("no event was prepared");
    return event;
  }

  appendAll(
    drafts: readonly EventDraft[],
    options: AppendOptions = {},
  ): Promise<readonly EventEnvelope[]> {
    if (drafts.length === 0) return Promise.reject(unexpected("no event to append"));
    return this.#serial(() => this.#append(drafts, options.precondition));
  }

  appendHuman(
    events: readonly EventEnvelope[],
    options: AppendOptions = {},
  ): Promise<readonly EventEnvelope[]> {
    if (events.length === 0) return Promise.reject(unexpected("no event to append"));
    return this.#serial(() => this.#appendHuman(events, options.precondition));
  }

  list(): Promise<JournalListing> {
    return this.#serial(async () => {
      const repo = await this.#repository();
      const head = await this.#readHead();
      if (head === null) return { head, events: [], problems: [] };
      const listing = await this.#listAt(repo, head);
      return { head, events: listing.events, problems: listing.problems };
    });
  }

  head(): Promise<string | null> {
    return this.#serial(async () => {
      await this.#repository();
      return this.#readHead();
    });
  }

  productId(): Promise<string | null> {
    return this.#serial(async () => {
      const repo = await this.#repository();
      const head = await this.#readHead();
      if (head === null) return null;
      return (await this.#state(repo, head, undefined)).product;
    });
  }

  /** The commit the reference names, even one that no longer exists (`history` says unknown). */
  projected(): Promise<string | null> {
    return this.#serial(async () => {
      const repo = await this.#repository();
      const run = await this.#git(repo.commonDir, [
        "rev-parse",
        "-q",
        "--verify",
        JOURNAL_PROJECTED_REF,
      ]);
      return run.status === 0 ? run.stdout.toString("utf8").trim() : null;
    });
  }

  /**
   * `update-ref <ref> <position> <previous>` (`-d` for null): left as is when another process
   * moved the reference meanwhile (a lost compare-and-swap); any other failure is `UNEXPECTED`.
   */
  markProjected(position: string | null, previous: string | null): Promise<void> {
    return this.#serial(async () => {
      const repo = await this.#repository();
      const ref = JOURNAL_PROJECTED_REF;
      const message = ["-m", "agentplugged journal status"];
      const args =
        position === null
          ? ["update-ref", ...message, "-d", ref, ...(previous === null ? [] : [previous])]
          : ["update-ref", ...message, ref, position, previous ?? ""];
      const run = await this.#git(repo.commonDir, args);
      if (run.status === 0) return;
      const now = await this.#git(repo.commonDir, ["rev-parse", "-q", "--verify", ref]);
      const current = now.status === 0 ? now.stdout.toString("utf8").trim() : null;
      if (current !== previous) return;
      throw unexpected(`git update-ref ${ref} failed: ${run.stderr}`);
    });
  }

  /**
   * Event files (`journal/<YYYY>/<MM>/<id>.json`) held at `from` and no longer at `to`, and
   * whether `to` descends from `from`. `unknown` when `from` cannot be read any more.
   */
  history(from: string, to: string | null): Promise<JournalHistory> {
    return this.#serial(async () => {
      const repo = await this.#repository();
      const events = async (commit: string) =>
        (await this.#treeFiles(repo, commit))
          .map((file) => file.path)
          .filter((path) => EVENT_PATH.test(path));
      let before: string[];
      try {
        before = await events(from);
      } catch {
        return { descends: false, missing: 0, unknown: true };
      }
      let after: Set<string>;
      let descends = false;
      try {
        after = new Set(to === null ? [] : await events(to));
        descends = to !== null && (await this.isAncestor(from, to));
      } catch {
        return { descends: false, missing: 0, unknown: true };
      }
      return { descends, missing: before.filter((path) => !after.has(path)).length };
    });
  }

  // --- JournalSync ------------------------------------------------------------------------

  async resolveRemote(requested: string | undefined): Promise<string | null> {
    await this.#repository();
    const remotes = await this.#remoteNames();
    if (requested !== undefined) return remotes.includes(requested) ? requested : null;
    const branch = await this.#git(this.#cwd, ["symbolic-ref", "-q", "HEAD"]);
    const name = branch.stdout.toString("utf8").trim();
    if (branch.status === 0 && name.startsWith("refs/heads/")) {
      const key = `branch.${name.slice("refs/heads/".length)}.remote`;
      const tracked = await this.#git(this.#cwd, ["config", "--get", key]);
      const remote = tracked.stdout.toString("utf8").trim();
      if (tracked.status === 0 && remotes.includes(remote)) return remote;
    }
    return remotes.includes("origin") ? "origin" : null;
  }

  async fetchRemote(remote: string, options: RemoteCallOptions = {}): Promise<RemoteFetch> {
    const repo = await this.#repository();
    const key = await this.#remoteKey(remote);
    // A temporary reference of this run only: the remote-tracking one moves once the fetched tip
    // passed every check (`markSeen`). Created, never forced.
    const temporary = `refs/agentplugged/fetch/${key}/${process.pid}-${toHex(randomBytes(6))}`;
    const fetched = await this.#network(
      remote,
      [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        "--refmap=",
        remote,
        `${JOURNAL_REF}:${temporary}`,
      ],
      options.timeoutMs,
    );
    // The long-running processes may not see the pack the fetch just wrote: start fresh ones.
    await this.#serial(async () => this.#reset());
    if (fetched.status !== 0) {
      if (/couldn't find remote ref/i.test(fetched.stderr)) return { kind: "absent" };
      throw unreachable(remote, fetched);
    }
    const tip = await this.#refValue(repo, temporary);
    await this.#git(repo.commonDir, ["update-ref", "-d", temporary]);
    if (tip === null) throw unexpected(`${temporary} is missing after git fetch`);
    return { kind: "fetched", tip };
  }

  /**
   * Where the remote's journal stands against this one, by `git ls-remote` of the
   * journal branch within `timeoutMs` (`remoteCheckTimeoutMs`, 15 s by default): `behind` when the
   * local journal does not hold the remote's tip, `unreachable` when the remote does not answer.
   * Never fetches anything.
   */
  async remoteJournalStatus(options: { timeoutMs?: number } = {}): Promise<RemoteJournalStatus> {
    const remote = await this.resolveRemote(undefined);
    if (remote === null) return { kind: "no_remote" };
    const timeout =
      options.timeoutMs ?? this.#options.remoteCheckTimeoutMs ?? REMOTE_CHECK_TIMEOUT_MS;
    let run: Awaited<ReturnType<typeof runGit>>;
    try {
      run = await this.#network(remote, ["ls-remote", "--refs", remote, JOURNAL_REF], timeout);
    } catch {
      return { kind: "unreachable", remote };
    }
    if (run.status !== 0) return { kind: "unreachable", remote };
    const tip = run.stdout.toString("utf8").trim().split(/\s+/)[0] ?? "";
    if (tip === "") return { kind: "absent", remote };
    const local = await this.#readHead();
    if (local === null) return { kind: "behind", remote };
    if (local === tip) return { kind: "contained", remote };
    const repo = await this.#repository();
    const known = await this.#git(repo.commonDir, ["cat-file", "-e", `${tip}^{commit}`]);
    if (known.status !== 0) return { kind: "behind", remote };
    return (await this.isAncestor(tip, local))
      ? { kind: "contained", remote }
      : { kind: "behind", remote };
  }

  async seen(remote: string): Promise<string | null> {
    const repo = await this.#repository();
    return this.#refValue(repo, journalSeenRef(await this.#remoteKey(remote)));
  }

  async markSeen(remote: string, commit: string): Promise<void> {
    const repo = await this.#repository();
    const key = await this.#remoteKey(remote);
    await this.#advanceRef(repo, journalSeenRef(key), commit);
    await this.#advanceRef(repo, journalRemoteRef(key), commit);
  }

  async forgetSeen(remote: string): Promise<void> {
    const repo = await this.#repository();
    const key = await this.#remoteKey(remote);
    for (const ref of [journalSeenRef(key), journalRemoteRef(key)]) {
      const run = await this.#git(repo.commonDir, ["update-ref", "-d", ref]);
      if (run.status !== 0) throw unexpected(`git update-ref -d ${ref} failed: ${run.stderr}`);
    }
  }

  /** The commit a reference names, read afresh (another worktree may move it), or null. */
  async #refValue(repo: Repo, ref: string): Promise<string | null> {
    const run = await this.#git(repo.commonDir, ["rev-parse", "-q", "--verify", `${ref}^{commit}`]);
    return run.status === 0 ? run.stdout.toString("utf8").trim() : null;
  }

  /**
   * Moves one of sync's own references (never the journal branch) to `to` by compare-and-swap,
   * only forward: left as is when it already holds `to` or a commit `to` does not descend from.
   */
  async #advanceRef(repo: Repo, ref: string, to: string): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const old = await this.#refValue(repo, ref);
      if (old === to) return;
      if (old !== null && !(await this.isAncestor(old, to))) return;
      const run = await this.#git(repo.commonDir, [
        "update-ref",
        "-m",
        "agentplugged journal sync",
        ref,
        to,
        old ?? "",
      ]);
      if (run.status === 0) return;
    }
    throw unexpected(`${ref} kept moving while journal sync advanced it`);
  }

  /** Identifies a remote by its URL (a hex hash): the key of its `remotes` and `seen` refs. */
  async #remoteKey(remote: string): Promise<string> {
    const known = this.#remoteKeys.get(remote);
    if (known !== undefined) return known;
    const run = await this.#git(this.#cwd, ["remote", "get-url", remote]);
    if (run.status !== 0) throw unexpected(`git remote get-url ${remote} failed: ${run.stderr}`);
    const key = journalRemoteKey(run.stdout.toString("utf8").trim());
    this.#remoteKeys.set(remote, key);
    return key;
  }

  /**
   * A `git` that talks to the remote: English messages (recognised by sync), SSH that never
   * prompts (unless the creator chose an SSH command), and a time limit.
   */
  async #network(remote: string, args: readonly string[], timeout?: number) {
    const env: Record<string, string> = { ...C_LOCALE };
    if (process.env.GIT_SSH_COMMAND === undefined && process.env.GIT_SSH === undefined) {
      const configured = await this.#git(this.#cwd, ["config", "--get", "core.sshCommand"]);
      if (configured.status !== 0) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
    }
    const timeoutMs = timeout ?? this.#options.remoteTimeoutMs ?? REMOTE_TIMEOUT_MS;
    this.stats.gitStarts += 1;
    try {
      return await runGit(this.#cwd, args, undefined, env, timeoutMs);
    } catch (error) {
      throw unreachable(remote, { stderr: (error as Error).message });
    }
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    if (ancestor === descendant) return true;
    const repo = await this.#repository();
    const run = await this.#git(repo.commonDir, [
      "merge-base",
      "--is-ancestor",
      ancestor,
      descendant,
    ]);
    if (run.status === 0) return true;
    if (run.status === 1) return false;
    throw unexpected(`git merge-base failed: ${run.stderr}`);
  }

  async files(commit: string): Promise<JournalFiles> {
    const repo = await this.#repository();
    const files = await this.#treeFiles(repo, commit, true);
    return new Map(files.map((file) => [file.path, file.oid]));
  }

  readBlob(blob: string): Promise<Uint8Array> {
    return this.#serial(async () => {
      const object = await this.#contents(blob);
      if (object === undefined || object.type !== "blob") {
        throw unexpected(`blob ${blob} is missing`);
      }
      return object.data;
    });
  }

  productIdAt(commit: string): Promise<string | null> {
    return this.#serial(async () => {
      const repo = await this.#repository();
      return (await this.#state(repo, commit, undefined)).product;
    });
  }

  /** The journal lock, taken; its wait and any reclaim are counted. */
  async #acquire(repo: Repo): Promise<HeldLock> {
    const lock = await acquireJournalLock(
      join(repo.commonDir, JOURNAL_LOCK_NAME),
      this.#lockOptions(),
    );
    this.stats.lockWaitMs += lock.waitedMs;
    if (lock.reclaimed) this.stats.locksReclaimed += 1;
    return lock;
  }

  /** The names of the remotes (never one that looks like an option). */
  async #remoteNames(): Promise<string[]> {
    const listed = await this.#git(this.#cwd, ["remote"]);
    if (listed.status !== 0) throw unexpected(`git remote failed: ${listed.stderr}`);
    return listed.stdout
      .toString("utf8")
      .split(/\r?\n/)
      .filter((name) => name !== "" && !name.startsWith("-"));
  }

  async withJournalLock<T>(task: (writer: JournalWriter) => Promise<T>): Promise<T> {
    const repo = await this.#repository();
    const lock = await this.#acquire(repo);
    const writer: JournalWriter = {
      head: () => this.head(),
      fastForward: (to, from) => this.#serial(() => this.#updateRef(repo, to, from)),
      merge: (input) => this.#serial(() => this.#merge(repo, input)),
    };
    try {
      return await task(writer);
    } finally {
      await rm(join(repo.commonDir, TEMP_NAME), { force: true }).catch(() => {});
      await lock.release();
    }
  }

  async push(
    remote: string,
    commit: string,
    options: RemoteCallOptions = {},
  ): Promise<PushOutcome> {
    await this.#repository();
    // Exactly `commit`, never `--force` nor `+`: the remote takes a fast-forward, or refuses.
    const run = await this.#network(
      remote,
      [
        "push",
        "--porcelain",
        "--no-follow-tags",
        "--recurse-submodules=no",
        remote,
        `${commit}:${JOURNAL_REF}`,
      ],
      options.timeoutMs,
    );
    const line = run.stdout
      .toString("utf8")
      .split(/\r?\n/)
      .find((entry) => entry.split("\t")[1]?.endsWith(`:${JOURNAL_REF}`) === true);
    if (line !== undefined) {
      const [flag, , summary = ""] = line.split("\t");
      if (flag === " " || flag === "*" || flag === "=") return "pushed";
      if (flag === "!" && summary.startsWith("[rejected]")) return "rejected";
      // Another push won the remote's reference meanwhile: the same as a refused fast-forward.
      if (flag === "!" && /incorrect old value|cannot lock ref/.test(`${summary} ${run.stderr}`)) {
        return "rejected";
      }
      throw unexpected(`git push ${remote} was refused: ${summary} ${run.stderr}`.trim());
    }
    throw unreachable(remote, run);
  }

  // --- JournalBackupPort ------------------------------------------------------------------

  async recallBackup(): Promise<string | undefined> {
    const repo = await this.#repository();
    try {
      return await readFile(join(repo.commonDir, BACKUP_MEMORY), "utf8");
    } catch {
      return undefined;
    }
  }

  async rememberBackup(text: string): Promise<void> {
    const repo = await this.#repository();
    const target = join(repo.commonDir, BACKUP_MEMORY);
    this.#memoryWrites += 1;
    const temporary = `${target}.${process.pid}.${this.#memoryWrites}.tmp`;
    await writeFile(temporary, `${text}\n`, "utf8");
    await renameWithRetry(temporary, target);
  }

  async backupRemote(options: {
    readonly checkExposure: boolean;
    readonly timeoutMs?: number;
  }): Promise<BackupRemote> {
    await this.#repository();
    const remotes = await this.#remoteNames();
    // The separate private repository of a public product, else the remote the repository uses.
    const remote = remotes.includes(JOURNAL_REMOTE_NAME)
      ? JOURNAL_REMOTE_NAME
      : await this.resolveRemote(undefined);
    if (remote === null) return { kind: "none" };
    if (!options.checkExposure) return { kind: "remote", remote, exposure: "unknown" };
    const url = await this.#pushAddress(remote);
    if (url === undefined) return { kind: "remote", remote, exposure: "unknown" };
    return { kind: "remote", remote, exposure: await this.#exposure(url, options.timeoutMs) };
  }

  async remoteExposure(remote: string): Promise<RemoteExposure> {
    await this.#repository();
    const url = await this.#pushAddress(remote);
    return url === undefined ? "unknown" : this.#exposure(url);
  }

  /** The address(es) Git pushes to (`pushurl` and `insteadOf` applied), never shown. */
  async #pushAddress(remote: string): Promise<string | undefined> {
    const pushed = await this.#git(this.#cwd, ["remote", "get-url", "--push", remote]);
    const url = pushed.stdout.toString("utf8").trim();
    return pushed.status !== 0 || url === "" ? undefined : url;
  }

  /** Who can read the repository at `url`; a private one is not asked again for half an hour. */
  async #exposure(url: string, timeoutMs?: number): Promise<RemoteExposure> {
    const known = this.#privateRemotes.get(url);
    if (known !== undefined && Date.now() - known < PRIVATE_KNOWN_MS) return "private";
    const probe =
      this.#options.exposureProbe ??
      ((address, cwd, limit) =>
        probeExposure(address, { cwd, ...(limit === undefined ? {} : { timeoutMs: limit }) }));
    let exposure: RemoteExposure;
    try {
      exposure = await probe(url, this.#cwd, timeoutMs);
    } catch {
      exposure = "unknown";
    }
    if (exposure === "private") this.#privateRemotes.set(url, Date.now());
    else this.#privateRemotes.delete(url);
    return exposure;
  }

  #lockOptions() {
    return {
      timeoutMs: this.#options.lockTimeoutMs,
      staleMs: this.#options.staleLockMs,
      heartbeatMs: this.#options.heartbeatMs,
    };
  }

  /** A merge commit (parents `local`, `remote`): `local`'s tree plus `add`, then compare-and-swap. */
  async #merge(repo: Repo, input: Parameters<JournalWriter["merge"]>[0]): Promise<string | null> {
    const built = new Map<string, Map<string, TreeEntry>>();
    const tree = await this.#buildTree(
      repo,
      await this.#commitTree(input.local),
      input.add.map((file) => ({ parts: file.path.split("/"), blob: file.blob })),
      built,
    );
    const seconds = Math.floor(Date.now() / 1000);
    const lines = [
      `tree ${tree}`,
      `parent ${input.local}`,
      `parent ${input.remote}`,
      `author ${JOURNAL_AUTHOR} ${seconds} +0000`,
      `committer ${JOURNAL_AUTHOR} ${seconds} +0000`,
      "",
      input.message,
    ];
    const commit = await this.#hashFile(
      repo,
      "commits",
      Buffer.from(`${lines.join("\n")}\n`, "utf8"),
    );
    if (!(await this.#updateRef(repo, commit, input.local))) return null;
    this.#trees = built;
    return commit;
  }

  /** Ends the long-running `git` processes. The store starts them again if used afterwards. */
  close(): void {
    const batches = this.#batches;
    this.#batches = undefined;
    if (batches === undefined) return;
    for (const batch of Object.values(batches)) batch.close();
  }

  #all(): GitBatch[] {
    return this.#batches ? Object.values(this.#batches) : [];
  }

  /** Drops the long-running processes after a failure: the next request starts fresh ones. */
  #reset(): void {
    if (this.#batches === undefined) return;
    this.stats.restarts += 1;
    this.close();
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(async () => {
      for (const batch of this.#all()) batch.busy();
      try {
        return await task();
      } catch (error) {
        // An expected failure leaves the processes in step; anything else may not.
        if (!(error instanceof AgentPluggedError) || error.code === ErrorCode.UNEXPECTED) {
          this.#reset();
        }
        throw error;
      } finally {
        for (const batch of this.#all()) batch.idle();
      }
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  async #git(
    cwd: string,
    args: readonly string[],
    input?: string,
    env?: Readonly<Record<string, string>>,
  ) {
    this.stats.gitStarts += 1;
    try {
      return await runGit(cwd, args, input, env);
    } catch (error) {
      throw unexpected(`git could not be started: ${(error as Error).message}`);
    }
  }

  #repository(): Promise<Repo> {
    this.#repo ??= this.#locate().catch((error: unknown) => {
      this.#repo = undefined;
      throw error;
    });
    return this.#repo;
  }

  async #locate(): Promise<Repo> {
    if (!existsSync(this.#cwd)) throw notARepo(this.#cwd);
    const base = [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
      "--show-object-format",
    ];
    let run = await this.#git(this.#cwd, [...base, "--show-toplevel"]);
    if (run.status !== 0) {
      // A bare repository has a journal, and no working copy for the cache.
      run = await this.#git(this.#cwd, base);
      if (run.status !== 0) throw notARepo(this.#cwd);
    }
    const [commonDir, format, topLevel] = run.stdout.toString("utf8").trim().split(/\r?\n/);
    if (commonDir === undefined || format === undefined) throw notARepo(this.#cwd);
    return {
      commonDir: resolve(commonDir),
      topLevel: topLevel === undefined ? undefined : resolve(topLevel),
      oidBytes: format === "sha256" ? 32 : 20,
    };
  }

  /** The long-running processes; all started again when any of them has ended. */
  #start(repo: Repo): Batches {
    if (this.#batches && this.#all().every((batch) => !batch.ended)) return this.#batches;
    this.#reset();
    const start = (args: string[]) => {
      this.stats.gitStarts += 1;
      const batch = new GitBatch(repo.commonDir, args);
      batch.busy();
      return batch;
    };
    this.#batches = {
      cat: start(["cat-file", "--batch-command"]),
      blobs: start(["hash-object", "-w", "--no-filters", "--stdin-paths"]),
      trees: start(["mktree", "--batch"]),
      commits: start(["hash-object", "-w", "-t", "commit", "--stdin-paths"]),
      refs: start(["update-ref", "-m", "agentplugged journal", "--stdin"]),
    };
    return this.#batches;
  }

  /** Object id of the journal's head, or null when the branch does not exist. */
  #readHead(): Promise<string | null> {
    return this.#readRef(JOURNAL_REF);
  }

  /** The commit a reference names, or null when it does not exist. */
  async #readRef(ref: string): Promise<string | null> {
    const repo = await this.#repository();
    const { cat } = this.#start(repo);
    const line = await cat.ask(`info ${ref}\n`);
    if (line === `${ref} missing`) return null;
    const [oid, type] = line.split(" ");
    if (type !== "commit" || oid === undefined) throw unexpected(`${ref}: ${line}`);
    return oid;
  }

  /** Content of an object (`<oid>`, or `<commit>:<path>`), or undefined when missing. */
  async #contents(spec: string): Promise<{ type: string; data: Buffer } | undefined> {
    const { cat } = this.#start(await this.#repository());
    const header = await cat.ask(`contents ${spec}\n`);
    if (header === `${spec} missing` || header === `${spec} ambiguous`) return undefined;
    const parts = header.split(" ");
    const size = Number(parts[2]);
    if (parts.length !== 3 || !Number.isSafeInteger(size) || size < 0) {
      throw unexpected(`git cat-file answered out of protocol: ${header}`);
    }
    const data = await cat.readBytes(size + 1);
    return { type: parts[1] ?? "", data: data.subarray(0, size) };
  }

  async #readTree(repo: Repo, oid: string): Promise<Map<string, TreeEntry>> {
    const cached = this.#trees.get(oid);
    if (cached) return cached;
    const object = await this.#contents(oid);
    if (object === undefined || object.type !== "tree") throw unexpected(`tree ${oid} is missing`);
    const entries = new Map<string, TreeEntry>();
    const data = object.data;
    let at = 0;
    while (at < data.length) {
      const space = data.indexOf(32, at);
      const nul = space === -1 ? -1 : data.indexOf(0, space);
      const end = nul + 1 + repo.oidBytes;
      if (space === -1 || nul === -1 || end > data.length) {
        throw unexpected(`tree ${oid} is malformed`);
      }
      const mode = data.subarray(at, space).toString("latin1").padStart(6, "0");
      const name = data.subarray(space + 1, nul).toString("utf8");
      const id = data.subarray(nul + 1, end).toString("hex");
      const type = mode.startsWith("040") ? "tree" : mode === "160000" ? "commit" : "blob";
      entries.set(name, { mode, type, oid: id });
      at = end;
    }
    this.#trees.set(oid, entries);
    return entries;
  }

  /** A new tree: `base` plus the given files (path segments → blob id), built with `mktree`. */
  async #buildTree(
    repo: Repo,
    base: string | null,
    files: ReadonlyArray<{ parts: readonly string[]; blob: string }>,
    built: Map<string, Map<string, TreeEntry>>,
  ): Promise<string> {
    const entries = new Map(base === null ? [] : await this.#readTree(repo, base));
    const groups = new Map<string, Array<{ parts: readonly string[]; blob: string }>>();
    for (const file of files) {
      const [name, ...rest] = file.parts;
      if (name === undefined) continue;
      if (rest.length === 0) {
        entries.set(name, { mode: "100644", type: "blob", oid: file.blob });
      } else {
        const group = groups.get(name) ?? [];
        group.push({ parts: rest, blob: file.blob });
        groups.set(name, group);
      }
    }
    for (const [name, group] of groups) {
      const existing = entries.get(name);
      const sub = existing?.type === "tree" ? existing.oid : null;
      entries.set(name, {
        mode: "040000",
        type: "tree",
        oid: await this.#buildTree(repo, sub, group, built),
      });
    }
    const lines = [...entries].map(([name, e]) => `${e.mode} ${e.type} ${e.oid}\t${name}\n`);
    const { trees } = this.#start(repo);
    const oid = await trees.ask(`${lines.join("")}\n`);
    built.set(oid, entries);
    return oid;
  }

  async #hashFile(repo: Repo, batch: "blobs" | "commits", content: Buffer): Promise<string> {
    const temp = join(repo.commonDir, TEMP_NAME);
    await writeFile(temp, content);
    return this.#start(repo)[batch].ask(`${temp}\n`);
  }

  /** The machine key, loaded before the journal lock; its creation is machine-wide exclusive. */
  async #machineKey(): Promise<MachineKey> {
    this.#key ??= await loadMachineKey(this.#options.keys, { lock: this.keyCreationLock() });
    return this.#key;
  }

  /**
   * The machine-wide lock of key creation (`~/.agentplugged/machine-key.lock`, or
   * `machineLockPath`): the machine key's, and the creator's key's at `init`.
   */
  keyCreationLock(): MachineLock {
    const { machineLockPath, lockTimeoutMs, staleLockMs, heartbeatMs } = this.#options;
    return async (task) => {
      const held = await acquireJournalLock(machineLockPath ?? MACHINE_KEY_LOCK, {
        timeoutMs: lockTimeoutMs,
        staleMs: staleLockMs,
        heartbeatMs,
      });
      try {
        return await task();
      } finally {
        await held.release();
      }
    };
  }

  async #append(
    drafts: readonly EventDraft[],
    precondition: AppendPrecondition | undefined,
  ): Promise<readonly EventEnvelope[]> {
    const repo = await this.#repository();
    const key = await this.#machineKey();
    // The product key, for sensitive content only: read before the journal lock.
    let productKey = await sensitiveProductKey(this.#options.keys, drafts);
    try {
      try {
        return await this.#appendWith(repo, key, drafts, precondition, productKey);
      } catch (error) {
        // The journal announces a key this machine does not hold as current: if it is a renewal
        // sealed for this machine, it is taken in and the write is tried once more.
        const product = drafts.find((draft) => draft.payload !== undefined)?.product;
        if (
          productKey === undefined ||
          product === undefined ||
          !(error instanceof AgentPluggedError) ||
          error.code !== ErrorCode.PRODUCT_KEY_MISMATCH
        ) {
          throw error;
        }
        const adopted = await adoptRotatedKey(this.#options.keys, product, await this.list());
        await forgetProductKey(adopted);
        if (adopted === undefined || adopted.keyId === productKey.keyId) throw error;
        await forgetProductKey(productKey);
        productKey = await sensitiveProductKey(this.#options.keys, drafts);
        return await this.#appendWith(repo, key, drafts, precondition, productKey);
      }
    } finally {
      await forgetProductKey(productKey);
    }
  }

  async #appendWith(
    repo: Repo,
    key: MachineKey,
    drafts: readonly EventDraft[],
    precondition: AppendPrecondition | undefined,
    productKey: ProductKey | undefined,
  ): Promise<readonly EventEnvelope[]> {
    return this.#transaction(repo, precondition, async (head) => {
      const state = head === null ? null : await this.#state(repo, head, key.device);
      // A sensitive write checks the key the journal announces, at the very head written on.
      let announced: AnnouncedKey | null = null;
      if (productKey !== undefined && head !== null) {
        const listed = await this.#listAt(repo, head);
        announced = await announcedKey(listed.events, {
          productKey,
          problems: listed.problems,
          allowTestTypes: this.#options.allowTestTypes === true,
        });
      }
      const prepared = await prepareAppend({
        ...(productKey === undefined ? {} : { productKey }),
        announced,
        draft: drafts,
        key,
        deviceHead: state?.deviceHead ?? null,
        journalProduct: state?.product ?? null,
        newId: this.#newId,
        now: this.#now,
        allowTestTypes: this.#options.allowTestTypes === true,
      });
      return { events: prepared.events, written: prepared.written };
    });
  }

  async #appendHuman(
    human: readonly EventEnvelope[],
    precondition: AppendPrecondition | undefined,
  ): Promise<readonly EventEnvelope[]> {
    const repo = await this.#repository();
    const device = (human[0] as EventEnvelope).actor.device;
    // The machine key is needed only for a journal without `product.created`: loaded before the
    // lock when the journal looks so now.
    const before = await this.#readHead();
    const productBefore =
      before === null ? null : (await this.#state(repo, before, undefined)).product;
    if (productBefore === null) await this.#machineKey();
    return this.#transaction(repo, precondition, async (head) => {
      const state = head === null ? null : await this.#state(repo, head, device);
      const product = state?.product ?? null;
      checkHumanEvents(human, state?.deviceHead ?? null, product);
      if (product !== null) return { events: [...human], written: [...human] };
      const key = await this.#machineKey();
      const machine = head === null ? null : await this.#state(repo, head, key.device);
      const engine = await prepareEngineEvents({
        key,
        deviceHead: machine?.deviceHead ?? null,
        journalProduct: null,
        product: (human[0] as EventEnvelope).product,
        newId: this.#newId,
        now: this.#now,
      });
      return { events: [...engine.events, ...human], written: [...human] };
    });
  }

  /**
   * One write under the journal lock: `precondition` on the listing at the head, then `prepare`
   * (the events to write, and those to return), then the blobs, trees and commit, and
   * `update-ref` as a compare-and-swap; on a moved reference, again from the new head.
   */
  async #transaction(
    repo: Repo,
    precondition: AppendPrecondition | undefined,
    prepare: (
      head: string | null,
    ) => Promise<{ events: readonly EventEnvelope[]; written: readonly EventEnvelope[] }>,
  ): Promise<readonly EventEnvelope[]> {
    this.#start(repo);
    const lock = await this.#acquire(repo);
    let objectRetried = false;
    try {
      for (let attempt = 1; ; attempt++) {
        const head = await this.#readHead();
        // Checked on the journal as it is at the head written on, under the lock: again on a
        // retry, since the head moved.
        if (precondition !== undefined) {
          const listed = head === null ? undefined : await this.#listAt(repo, head);
          await precondition({
            head,
            events: listed?.events ?? [],
            problems: listed?.problems ?? [],
          });
        }
        let made: MadeCommit;
        try {
          made = await this.#makeCommit(repo, head, prepare);
        } catch (error) {
          // An object Git itself just wrote is "unavailable" (a process killed by a
          // lack of memory, a batch that lost its answer): nothing was written to the journal yet,
          // so the long-running processes and the trees kept are dropped and it is done again,
          // once. A second failure is the real one.
          if (objectRetried || !isObjectUnavailable(error)) throw error;
          objectRetried = true;
          this.stats.objectRetries += 1;
          this.#reset();
          this.#trees = new Map();
          attempt -= 1;
          continue;
        }
        const { prepared, built, commit } = made;
        if (await this.#updateRef(repo, commit, head)) {
          // Only the trees of this commit are kept: the next write starts from them.
          this.#trees = built;
          const created = prepared.events.find((e) => e.type === EVENT_TYPES.productCreated);
          const product =
            created === undefined
              ? (this.#cache?.product ?? undefined)
              : { id: created.product, path: eventPath(created) };
          // Each writer's head moves to its last event written (events are chained in order).
          const devices = { ...(this.#cache?.devices ?? {}) };
          for (const event of prepared.events) {
            const hash = eventHash(event);
            if (!hash.ok) continue;
            devices[event.actor.device] = { id: event.id, hash: hash.hash, path: eventPath(event) };
          }
          this.#cache = { commit, devices, product };
          await this.#saveCache(repo);
          this.stats.appends += 1;
          try {
            this.#options.onWrite?.();
          } catch {
            // A listener never fails a write.
          }
          return prepared.written;
        }
        this.#trees = new Map();
        this.stats.casRetries += 1;
        if (attempt >= MAX_ATTEMPTS) {
          throw unexpected(`${JOURNAL_REF} kept moving while the journal lock was held`);
        }
      }
    } finally {
      await rm(join(repo.commonDir, TEMP_NAME), { force: true }).catch(() => {});
      await lock.release();
    }
  }

  /**
   * The blobs of the events, the trees and the commit of one write, everything but moving the
   * reference: nothing of the journal changes until `#updateRef`.
   */
  async #makeCommit(
    repo: Repo,
    head: string | null,
    prepare: (
      head: string | null,
    ) => Promise<{ events: readonly EventEnvelope[]; written: readonly EventEnvelope[] }>,
  ): Promise<MadeCommit> {
    const prepared = await prepare(head);
    const files: Array<{ parts: string[]; blob: string; path: string }> = [];
    for (const event of prepared.events) {
      const path = eventPath(event);
      const blob = await this.#hashFile(repo, "blobs", eventFile(event));
      files.push({ parts: path.split("/"), blob, path });
    }
    const built = new Map<string, Map<string, TreeEntry>>();
    const baseTree = head === null ? null : await this.#commitTree(head);
    await this.#options.beforeBuild?.();
    const tree = await this.#buildTree(repo, baseTree, files, built);
    const last = prepared.events.at(-1);
    if (last === undefined) throw unexpected("no event was prepared");
    const commit = await this.#hashFile(
      repo,
      "commits",
      this.#commitObject(
        tree,
        head,
        last,
        files.map((file) => file.path),
      ),
    );
    return { prepared, built, commit };
  }

  async #commitTree(commit: string): Promise<string> {
    const object = await this.#contents(commit);
    const tree = object?.data.toString("utf8").match(/^tree ([0-9a-f]+)$/m)?.[1];
    if (tree === undefined) throw unexpected(`commit ${commit} is unreadable`);
    return tree;
  }

  #commitObject(tree: string, parent: string | null, last: EventEnvelope, paths: string[]): Buffer {
    const seconds = Math.floor(Date.now() / 1000);
    const lines = [
      `tree ${tree}`,
      ...(parent === null ? [] : [`parent ${parent}`]),
      `author ${JOURNAL_AUTHOR} ${seconds} +0000`,
      `committer ${JOURNAL_AUTHOR} ${seconds} +0000`,
      "",
      `journal: ${last.type} ${last.id}`,
      "",
      ...paths,
    ];
    return Buffer.from(`${lines.join("\n")}\n`, "utf8");
  }

  /**
   * `update-ref <ref> <new> <old>` in one transaction; false when the reference moved. When the
   * answer is lost or out of protocol, the processes are restarted and the head read again: the
   * write succeeded exactly when the head is the new commit (never appended twice).
   */
  async #updateRef(repo: Repo, commit: string, head: string | null): Promise<boolean> {
    const { refs } = this.#start(repo);
    const update =
      head === null ? `create ${JOURNAL_REF} ${commit}` : `update ${JOURNAL_REF} ${commit} ${head}`;
    try {
      refs.write(`start\n${update}\nprepare\ncommit\n`);
      for (const step of ["start", "prepare", "commit"]) {
        if ((await refs.readLine()) !== `${step}: ok`) throw new Error("out of protocol");
      }
      return true;
    } catch {
      // `update-ref --stdin` ends on a refused transaction, and its answers may be out of step.
      this.#reset();
      return (await this.#readHead()) === commit;
    }
  }

  // --- Heads cache ------------------------------------------------------------------------

  #cachePath(repo: Repo): string | undefined {
    if (this.#options.cachePath !== undefined) return this.#options.cachePath;
    if (repo.topLevel === undefined) return undefined;
    if (!existsSync(join(repo.topLevel, ".agentplugged"))) return undefined;
    return join(repo.topLevel, JOURNAL_HEADS_CACHE);
  }

  async #loadCache(repo: Repo): Promise<HeadsCache | undefined> {
    const path = this.#cachePath(repo);
    if (path === undefined) return undefined;
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (typeof value !== "object" || value === null) return undefined;
      const { version, commit, devices, product } = value as Record<string, unknown>;
      if (version !== 1 || typeof commit !== "string") return undefined;
      if (typeof devices !== "object" || devices === null || Array.isArray(devices)) {
        return undefined;
      }
      for (const entry of Object.values(devices)) {
        const { id, hash, path: file } = (entry ?? {}) as Record<string, unknown>;
        if (typeof id !== "string" || typeof hash !== "string" || typeof file !== "string") {
          return undefined;
        }
      }
      let known: HeadsCache["product"];
      if (product === null) known = null;
      else if (typeof product === "object") {
        const { id, path: file } = product as Record<string, unknown>;
        if (typeof id === "string" && typeof file === "string") known = { id, path: file };
      }
      return { commit, devices: devices as Record<string, CachedEvent>, product: known };
    } catch {
      return undefined;
    }
  }

  async #saveCache(repo: Repo): Promise<void> {
    const path = this.#cachePath(repo);
    if (path === undefined || this.#cache === undefined) return;
    const temp = `${path}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(temp, `${JSON.stringify({ version: 1, ...this.#cache }, null, 2)}\n`);
      await rename(temp, path);
    } catch {
      // The cache is an optimisation: without it, the next write rebuilds it.
      await rm(temp, { force: true }).catch(() => {});
    }
  }

  /**
   * What a write needs to know of the journal at `head`: the machine's last event (when `device`
   * is given) and the product id. Taken from the cache once checked against the journal: brought
   * up to date from the commits written since, and its entries read back from the tree. A missing
   * or inconsistent cache is rebuilt from the whole journal.
   */
  async #state(
    repo: Repo,
    head: string,
    device: string | undefined,
  ): Promise<{ deviceHead: DeviceHead | null; product: string | null }> {
    let cache = this.#cache ?? (await this.#loadCache(repo));
    if (cache !== undefined && cache.commit !== head) cache = await this.#advance(cache, head);
    if (cache !== undefined && (await this.#holds(cache, head, device))) {
      this.#cache = cache;
      const entry = device === undefined ? undefined : cache.devices[device];
      return {
        deviceHead: entry === undefined ? null : { id: entry.id, hash: entry.hash },
        product: cache.product?.id ?? null,
      };
    }
    this.stats.cacheRebuilds += 1;
    const listing = await this.#listAt(repo, head);
    const pathOf = new Map(listing.paths);
    const devices: Record<string, CachedEvent> = {};
    for (const [name, found] of deviceHeads(listing.events)) {
      devices[name] = { ...found, path: pathOf.get(found.id) ?? "" };
    }
    const created = journalProduct(listing.events);
    const product =
      created === null ? null : { id: created.product, path: pathOf.get(created.id) ?? "" };
    this.#cache = { commit: head, devices, product };
    await this.#saveCache(repo);
    const entry = device === undefined ? undefined : devices[device];
    return {
      deviceHead: entry === undefined ? null : { id: entry.id, hash: entry.hash },
      product: product?.id ?? null,
    };
  }

  /** True when the cache at `head` answers: product known and, for `device`, its entry checked. */
  async #holds(cache: HeadsCache, head: string, device: string | undefined): Promise<boolean> {
    if (cache.product === undefined) return false;
    if (cache.product !== null) {
      const event = await this.#eventAt(head, cache.product.path);
      if (event?.type !== EVENT_TYPES.productCreated || event.product !== cache.product.id) {
        return false;
      }
    }
    if (device === undefined) return true;
    const entry = cache.devices[device];
    if (entry === undefined) return false;
    const event = await this.#eventAt(head, entry.path);
    if (event === undefined || event.id !== entry.id || event.actor.device !== device) return false;
    const hash = eventHash(event);
    return hash.ok && hash.hash === entry.hash;
  }

  async #eventAt(commit: string, path: string): Promise<EventEnvelope | undefined> {
    if (!EVENT_PATH.test(path)) return undefined;
    const object = await this.#contents(`${commit}:${path}`);
    return object?.type === "blob" ? readEvent(object.data) : undefined;
  }

  /**
   * The cache brought from its commit up to `head`, through the commits written since (each
   * names its event files), with the same head rule as a rebuild (`nextDeviceHead`). Undefined
   * when its commit is not an ancestor, a commit is not one of the journal's, or there are too
   * many.
   */
  async #advance(cache: HeadsCache, head: string): Promise<HeadsCache | undefined> {
    const walked: Array<{ commit: string; paths: string[] }> = [];
    let current = head;
    while (current !== cache.commit) {
      if (walked.length >= MAX_WALK) return undefined;
      const object = await this.#contents(current);
      if (object === undefined || object.type !== "commit") return undefined;
      const text = object.data.toString("utf8");
      const split = text.indexOf("\n\n");
      if (split === -1) return undefined;
      const headers = text.slice(0, split).split("\n");
      const parents = headers.filter((line) => line.startsWith("parent "));
      const paths = text
        .slice(split + 2)
        .split("\n")
        .filter((line) => EVENT_PATH.test(line));
      if (parents.length !== 1 || paths.length === 0) return undefined;
      walked.push({ commit: current, paths });
      current = parents[0]?.slice("parent ".length) ?? "";
    }
    const devices = { ...cache.devices };
    let product = cache.product;
    for (const { commit, paths } of walked.reverse()) {
      for (const path of paths) {
        const event = await this.#eventAt(commit, path);
        if (event === undefined || eventPath(event) !== path) return undefined;
        const hash = eventHash(event);
        if (!hash.ok) return undefined;
        const next = nextDeviceHead(devices[event.actor.device], event, hash.hash);
        if (next.id === event.id) devices[event.actor.device] = { ...next, path };
        if (event.type === EVENT_TYPES.productCreated && !product) {
          product = { id: event.product, path };
        }
      }
    }
    return { commit: head, devices, product };
  }

  /** Every file of the journal tree at `commit`, or of the whole tree (one `git ls-tree`). */
  async #treeFiles(
    repo: Repo,
    commit: string,
    all = false,
  ): Promise<Array<{ path: string; oid: string }>> {
    const only = all ? [] : ["--", JOURNAL_DIR];
    const tree = await this.#git(repo.commonDir, ["ls-tree", "-r", "-z", commit, ...only]);
    if (tree.status !== 0) throw unexpected(`git ls-tree failed: ${tree.stderr}`);
    const files = treeFiles(tree.stdout);
    return files;
  }

  /** Every event file at `head`: two `git` runs (`ls-tree`, then `cat-file --batch`). */
  async #listAt(
    repo: Repo,
    head: string,
  ): Promise<{
    events: EventEnvelope[];
    problems: JournalProblem[];
    paths: Array<[string, string]>;
  }> {
    const files = await this.#treeFiles(repo, head);
    const events: EventEnvelope[] = [];
    const problems: JournalProblem[] = [];
    const paths: Array<[string, string]> = [];
    if (files.length > 0) {
      const batch = await this.#git(
        repo.commonDir,
        ["cat-file", "--batch"],
        `${files.map((file) => file.oid).join("\n")}\n`,
      );
      if (batch.status !== 0) throw unexpected(`git cat-file failed: ${batch.stderr}`);
      const out = batch.stdout;
      let at = 0;
      for (const file of files) {
        // `<oid> <type> <size>\n<content>\n`, or `<oid> missing\n` without content.
        const end = out.indexOf(10, at);
        if (end === -1) throw unexpected("git cat-file output ended early");
        const parts = out.subarray(at, end).toString("latin1").split(" ");
        const size = Number(parts[2]);
        if (parts.length !== 3 || !Number.isSafeInteger(size) || size < 0) {
          problems.push({ path: file.path, error: eventInvalid("", EVENT_REASON.invalidValue) });
          at = end + 1;
          continue;
        }
        const data = out.subarray(end + 1, end + 1 + size);
        at = end + 1 + size + 1;
        const result = parseEventFile(file.path, data);
        if ("error" in result) problems.push(result);
        else {
          events.push(result.event);
          paths.push([result.event.id, file.path]);
        }
      }
    }
    events.sort(byId);
    return { events, problems, paths };
  }
}

function readEvent(data: Buffer): EventEnvelope | undefined {
  try {
    const parsed = parseEventEnvelope(JSON.parse(data.toString("utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One journal file read as an event, or the problem that keeps it from being one: its path must
 * be the one its own `at` and `id` give (`journal/<YYYY>/<MM>/<id>.json`).
 */
function parseEventFile(path: string, data: Buffer): { event: EventEnvelope } | JournalProblem {
  let value: unknown;
  try {
    value = JSON.parse(data.toString("utf8"));
  } catch {
    return { path, error: eventInvalid("", EVENT_REASON.invalidValue) };
  }
  const parsed = parseEventEnvelope(value);
  // The JSON value goes with the problem: the projection checks a newer envelope's signature.
  if (!parsed.success) return { path, error: parsed.error, raw: value };
  if (eventPath(parsed.data) !== path) {
    return { path, error: eventInvalid("id", EVENT_REASON.invalidValue) };
  }
  return { event: parsed.data };
}
