import { canonicalBytes, fromUtf8 } from "@agentplugged/crypto";
import {
  ErrorCode,
  EVENT_TYPES,
  type EventEnvelope,
  JOURNAL_DIR,
  journalEventPath,
  parseEventEnvelope,
} from "@agentplugged/protocol";
import { AgentPluggedError, unexpected } from "../errors.js";
import { sameBytes } from "../values.js";

/** Every file of the tree at one commit: path (`journal/…`) → content id (blob). */
export type JournalFiles = ReadonlyMap<string, string>;

/** What fetching a remote's journal gave. */
export type RemoteFetch =
  /** The remote's journal tip, fetched into a temporary reference (the tracked one is untouched). */
  | { readonly kind: "fetched"; readonly tip: string }
  /** The remote has no journal branch. */
  | { readonly kind: "absent" };

/** The journal's writes, under its lock. Each one is a compare-and-swap of the journal branch. */
export interface JournalWriter {
  /** The journal branch's commit, or null when it does not exist. */
  head(): Promise<string | null>;
  /** Moves the journal branch from `from` to `to`; false when it was not at `from`. */
  fastForward(to: string, from: string | null): Promise<boolean>;
  /**
   * Writes a merge commit with the parents `local` then `remote`, whose tree is `local`'s plus
   * the `add` files, by the fixed technical author with `message`, and moves the journal branch
   * from `local` to it. Returns the commit, or null when the branch was not at `local`.
   */
  merge(input: {
    readonly local: string;
    readonly remote: string;
    readonly add: ReadonlyArray<{ readonly path: string; readonly blob: string }>;
    readonly message: string;
  }): Promise<string | null>;
}

export type PushOutcome = "pushed" | "rejected";

/**
 * Port to the Git operations of `journal sync`. The decisions (ancestry, union, checks) are
 * `syncJournal`'s; an implementation only reads, fetches, writes and pushes, never with force.
 * Expected failures are thrown as `AgentPluggedError` (`NOT_A_GIT_REPO`, `JOURNAL_BUSY`,
 * `JOURNAL_REMOTE_UNREACHABLE`…).
 */
export interface JournalSync {
  /**
   * The remote to use: `requested` when it is configured; otherwise the remote the current branch
   * tracks, else `origin`. Null when none of them is configured.
   */
  resolveRemote(requested: string | undefined): Promise<string | null>;
  /**
   * Fetches the remote's journal branch into a temporary reference, without force, within
   * `options.timeoutMs` (the adapter's own limit by default).
   */
  fetchRemote(remote: string, options?: RemoteCallOptions): Promise<RemoteFetch>;
  /** The last tip of the remote's journal seen by a sync, or null. */
  seen(remote: string): Promise<string | null>;
  /**
   * Records `commit` as the last tip seen of the remote's journal, and as its remote-tracking
   * reference: local references, moved by compare-and-swap and never backwards.
   */
  markSeen(remote: string, commit: string): Promise<void>;
  /** Forgets the last tip seen of the remote's journal (`--recreate-remote`). */
  forgetSeen(remote: string): Promise<void>;
  /** True when `ancestor` is `descendant` or one of its ancestors. */
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  /** Every file of the tree at `commit`, inside `journal/` or not. */
  files(commit: string): Promise<JournalFiles>;
  /** The content of a file. */
  readBlob(blob: string): Promise<Uint8Array>;
  /** The product id of the journal at `commit` (its `product.created` event), or null. */
  productIdAt(commit: string): Promise<string | null>;
  /** The journal branch's commit, or null. */
  head(): Promise<string | null>;
  /** Runs `task` under the journal lock (the one every write takes). */
  withJournalLock<T>(task: (writer: JournalWriter) => Promise<T>): Promise<T>;
  /** Pushes `commit` to the remote's journal branch, never with force. */
  push(remote: string, commit: string, options?: RemoteCallOptions): Promise<PushOutcome>;
}

/** What a fetch or a push may take (the automatic backup bounds the network). */
export interface RemoteCallOptions {
  /** Time limit in milliseconds before `JOURNAL_REMOTE_UNREACHABLE`. */
  readonly timeoutMs?: number;
}

/** How the remote's events reached the local journal. */
export type JournalIntegration = "none" | "fast_forward" | "merge";

export interface JournalSyncResult {
  readonly remote: string;
  /** `merge` when any attempt merged, else `fast_forward` when any fast-forwarded. */
  readonly integration: JournalIntegration;
  /** Event files added to the local journal. */
  readonly received: number;
  /** Event files the remote did not have, pushed. */
  readonly sent: number;
  /** True when the remote had no journal: the push created its branch. */
  readonly created: boolean;
  /** Pushes tried (0 when nothing had to be sent). */
  readonly pushes: number;
  /** True when neither side holds a journal: nothing to sync. */
  readonly empty: boolean;
}

export interface SyncJournalOptions {
  readonly remote?: string;
  /** Pushes tried before `JOURNAL_PUSH_REJECTED`: a positive integer (3 by default). */
  readonly maxAttempts?: number;
  /**
   * The remote's journal branch was deleted on purpose after a rewrite: push the local journal
   * as a new branch and forget the tip seen. Refused while the remote branch exists.
   */
  readonly recreateRemote?: boolean;
  /** False: fetch and integrate only, send nothing (the pull before a read). */
  readonly push?: boolean;
  /** Time limit of each fetch and push, in milliseconds. */
  readonly timeoutMs?: number;
}

/** Pushes tried before `JOURNAL_PUSH_REJECTED`. */
export const MAX_PUSH_ATTEMPTS = 3;

export function noRemote(requested: string | undefined): AgentPluggedError {
  return requested === undefined
    ? new AgentPluggedError(ErrorCode.NO_REMOTE, "error.no_remote", {})
    : new AgentPluggedError(ErrorCode.NO_REMOTE, "error.no_remote.named", { remote: requested });
}

function rewritten(remote: string, missing: number): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.JOURNAL_REWRITTEN, "error.journal_rewritten", {
    remote,
    missing,
  });
}

type ConflictReason = "content" | "invalid" | "duplicate" | "outside";

function conflict(remote: string, path: string, reason: ConflictReason): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.JOURNAL_CONFLICT, `error.journal_conflict.${reason}`, {
    remote,
    path,
  });
}

function remoteProductMismatch(
  remote: string,
  remoteProduct: string,
  localProduct: string,
): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.PRODUCT_ID_MISMATCH, "error.product_id_mismatch.remote", {
    remote,
    product_id: remoteProduct,
    journal_product_id: localProduct,
  });
}

/** Paths of `before` that `after` lacks. */
function missingPaths(before: JournalFiles, after: JournalFiles): string[] {
  return [...before.keys()].filter((path) => !after.has(path));
}

const idOf = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(/\.json$/, "");

/**
 * An incoming file read as an event at its own path, written in its canonical form (RFC 8785
 * JSON, then `\n`), or undefined.
 */
function readIncoming(path: string, bytes: Uint8Array): EventEnvelope | undefined {
  const text = fromUtf8(bytes);
  if (text === undefined || !text.endsWith("\n")) return undefined;
  let value: unknown;
  let canonical: Uint8Array;
  try {
    value = JSON.parse(text);
    canonical = canonicalBytes(value);
  } catch {
    return undefined;
  }
  if (!sameBytes(bytes.subarray(0, bytes.length - 1), canonical)) return undefined;
  const parsed = parseEventEnvelope(value);
  if (!parsed.success || journalEventPath(parsed.data) !== path) return undefined;
  return parsed.data;
}

/** `JOURNAL_REWRITTEN` unless `tip` keeps every event of the last tip seen, and descends from it. */
async function checkNotRewritten(
  sync: JournalSync,
  remote: string,
  seen: string | null,
  tip: string | null,
): Promise<void> {
  if (seen === null || seen === tip) return;
  const before = await sync.files(seen);
  if (tip === null) throw rewritten(remote, before.size);
  const missing = missingPaths(before, await sync.files(tip)).length;
  if (missing > 0 || !(await sync.isAncestor(seen, tip))) throw rewritten(remote, missing);
}

/**
 * Brings the remote's `tip` into the local journal, under its lock: a fast-forward when the local
 * journal is absent or an ancestor, nothing when it already holds `tip`, else a merge commit whose
 * tree is the union of both. Every incoming file is checked first; nothing is written on failure.
 */
async function integrate(
  sync: JournalSync,
  remote: string,
  tip: string,
): Promise<{ integration: JournalIntegration; received: number }> {
  return sync.withJournalLock(async (writer) => {
    const local = await writer.head();
    if (local === tip || (local !== null && (await sync.isAncestor(tip, local)))) {
      return { integration: "none", received: 0 };
    }
    const remoteFiles = await sync.files(tip);
    const localFiles: JournalFiles = local === null ? new Map() : await sync.files(local);
    const fastForward = local === null || (await sync.isAncestor(local, tip));
    if (fastForward) {
      // Moving to `tip` must never drop a local event.
      const dropped = missingPaths(localFiles, remoteFiles).length;
      if (dropped > 0) throw rewritten(remote, dropped);
    }

    const localIds = new Map([...localFiles.keys()].map((path) => [idOf(path), path]));
    const incoming: Array<{ path: string; blob: string }> = [];
    for (const [path, blob] of remoteFiles) {
      if (!path.startsWith(`${JOURNAL_DIR}/`)) throw conflict(remote, path, "outside");
      const known = localFiles.get(path);
      if (known === undefined) {
        const other = localIds.get(idOf(path));
        if (other !== undefined) throw conflict(remote, path, "duplicate");
        incoming.push({ path, blob });
      } else if (known !== blob) throw conflict(remote, path, "content");
    }
    incoming.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const events: EventEnvelope[] = [];
    for (const { path, blob } of incoming) {
      const event = readIncoming(path, await sync.readBlob(blob));
      if (event === undefined) throw conflict(remote, path, "invalid");
      events.push(event);
    }
    // Every incoming event belongs to the local product (or, in a local journal without one, to
    // the product the incoming `product.created` names).
    const created = events
      .filter((event) => event.type === EVENT_TYPES.productCreated)
      .sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    const product = (local === null ? null : await sync.productIdAt(local)) ?? created?.product;
    if (product !== undefined) {
      const other = events.find((event) => event.product !== product);
      if (other !== undefined) throw remoteProductMismatch(remote, other.product, product);
    }

    if (fastForward) {
      if (!(await writer.fastForward(tip, local))) {
        throw unexpected("the journal branch moved while the journal lock was held");
      }
      return { integration: "fast_forward", received: incoming.length };
    }
    // Even without a new file, the merge makes the local journal descend from `tip`: its push is
    // then a fast-forward.
    const merged = await writer.merge({
      local: local as string,
      remote: tip,
      add: incoming,
      message: `journal: merge ${remote}`,
    });
    if (merged === null) {
      throw unexpected("the journal branch moved while the journal lock was held");
    }
    return { integration: "merge", received: incoming.length };
  });
}

/**
 * `journal sync`: fetches the remote's journal without force, refuses a rewrite of what was seen
 * there (`JOURNAL_REWRITTEN`), integrates it (fast-forward or union merge, after checking every
 * incoming file: `JOURNAL_CONFLICT`, `PRODUCT_ID_MISMATCH`), then pushes without force whenever
 * the local journal is not the remote's tip. A push refused because the remote moved starts again
 * from the fetch, at most `maxAttempts` times (`JOURNAL_PUSH_REJECTED`). No remote: `NO_REMOTE`.
 */
export async function syncJournal(
  sync: JournalSync,
  options: SyncJournalOptions = {},
): Promise<JournalSyncResult> {
  const remote = await sync.resolveRemote(options.remote);
  if (remote === null) throw noRemote(options.remote);
  const given = options.maxAttempts;
  const maxAttempts =
    given !== undefined && Number.isInteger(given) && given > 0 ? given : MAX_PUSH_ATTEMPTS;
  let integration: JournalIntegration = "none";
  let received = 0;
  for (let pushes = 0; ; ) {
    const limit = options.timeoutMs === undefined ? undefined : { timeoutMs: options.timeoutMs };
    const fetched = await sync.fetchRemote(remote, limit);
    const tip = fetched.kind === "fetched" ? fetched.tip : null;
    if (options.recreateRemote === true && pushes === 0) {
      if (tip !== null) {
        throw new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
          reason: "--recreate-remote: the remote branch agentplugged/journal still exists",
        });
      }
      await sync.forgetSeen(remote);
    }
    const seen = await sync.seen(remote);
    await checkNotRewritten(sync, remote, seen, tip);

    if (tip !== null && (await sync.head()) !== tip) {
      const step = await integrate(sync, remote, tip);
      received += step.received;
      if (step.integration === "merge") integration = "merge";
      else if (step.integration === "fast_forward" && integration === "none") {
        integration = "fast_forward";
      }
    }
    if (tip !== null && seen !== tip) await sync.markSeen(remote, tip);

    const local = await sync.head();
    if (options.push === false) {
      const empty = local === null && tip === null;
      return { remote, integration, received, sent: 0, created: false, pushes: 0, empty };
    }
    if (local === null || local === tip) {
      const empty = local === null && tip === null;
      return { remote, integration, received, sent: 0, created: false, pushes, empty };
    }
    const sent =
      tip === null
        ? (await sync.files(local)).size
        : missingPaths(await sync.files(local), await sync.files(tip)).length;
    pushes += 1;
    if ((await sync.push(remote, local, limit)) === "pushed") {
      await sync.markSeen(remote, local);
      return { remote, integration, received, sent, created: tip === null, pushes, empty: false };
    }
    if (pushes >= maxAttempts) {
      throw new AgentPluggedError(ErrorCode.JOURNAL_PUSH_REJECTED, "error.journal_push_rejected", {
        remote,
        attempts: pushes,
      });
    }
  }
}
