import { ErrorCode } from "@agentplugged/protocol";
import { AgentPluggedError } from "../errors.js";
import { type JournalSync, syncJournal } from "./journal-sync.js";
import type { Clock } from "./ulid.js";

/**
 * The automatic backup of the journal. The journal lives in a Git branch; this module
 * is the engine's own gesture that keeps it safe and shared, so that nobody has to think about it:
 * the branch is sent to the remote after the writes (grouped over a few seconds) and fetched before
 * the state is read, never forced, with the same fusion of several writers' chains as `journal
 * sync` (`syncJournal`). Offline, the engine goes on locally and catches up by itself. The journal
 * never goes to a public repository. Only an impossible backup is ever said to the creator, once,
 * by Noah, with the gesture that fixes it.
 */

// Core has no platform types: the two timer functions it needs are declared here.
declare function setTimeout(handler: () => void, ms: number): { unref?: () => void };
declare function clearTimeout(handle: unknown): void;

/** The remote of a separate private repository made for the journal (`forge_repo_create` `journal`). */
export const JOURNAL_REMOTE_NAME = "agentplugged-journal";

/** Who can read a remote's repository: `public` (anyone), `private`, or `unknown` (not checkable now). */
export type RemoteExposure = "public" | "private" | "unknown";

/** The remote that keeps the journal. */
export type BackupRemote =
  | { readonly kind: "none" }
  | { readonly kind: "remote"; readonly remote: string; readonly exposure: RemoteExposure };

/** `JournalSync`, and the choice of the remote that keeps the journal. */
export interface JournalBackupPort extends JournalSync {
  /**
   * The remote that keeps the journal: the separate one of a public repository
   * (`JOURNAL_REMOTE_NAME`) when it exists, else the remote the repository already uses; with who
   * can read the repository there (`unknown` when `checkExposure` is false: a fetch gives nothing
   * away, only a send needs to know).
   */
  backupRemote(options: {
    readonly checkExposure: boolean;
    /** The limit of the visibility check, in milliseconds. */
    readonly timeoutMs?: number;
  }): Promise<BackupRemote>;
  /** Who can read the repository a remote names (`forge_repo_create` of a public product). */
  remoteExposure(remote: string): Promise<RemoteExposure>;
  /**
   * The backup's own memory, kept next to the journal in the repository's Git folder (never
   * versioned, never sent, shared by the working copies): what `rememberBackup` stored, or undefined.
   */
  recallBackup(): Promise<string | undefined>;
  /** Keeps the backup's memory (replaces what `recallBackup` gives). */
  rememberBackup(text: string): Promise<void>;
}

/**
 * Why the journal is not saved and the engine cannot fix it alone. `unreachable`: the remote did
 * not take it for more than a day (an `offline` backup that lasts is no longer a moment without
 * connection).
 */
export const BACKUP_BLOCKS = [
  "no_remote",
  "public_remote",
  "access_denied",
  "diverged",
  "unreachable",
] as const;
export type BackupBlock = (typeof BACKUP_BLOCKS)[number];

/**
 * What `get_state` and `next` say when the journal is not saved: `offline` (no connection: the
 * engine retries, nothing to tell) or `blocked` (impossible without the creator: Noah says it once).
 */
export interface JournalBackupView {
  readonly status: "offline" | "blocked";
  /** Why it is blocked (`BackupBlock`), or what the network said while offline. */
  readonly reason: string;
  /** Since when the journal is not saved here (an ISO date). */
  readonly since: string;
  /** The last time it was saved from this machine, when it ever was (an ISO date). */
  readonly last_saved?: string;
  /** The remote concerned (its name, never its address). */
  readonly remote?: string;
  /** What to do with it, for the agent; absent once Noah said it. */
  readonly action: string;
}

interface Memory {
  status?: "offline" | "blocked";
  reason?: string;
  since?: string;
  remote?: string;
  last_saved?: string;
  /** The block Noah was already told of, in this episode. */
  warned_reason?: string;
}

export interface JournalBackupOptions {
  readonly port: JournalBackupPort;
  readonly now?: Clock;
  /** Writes within this time are sent together (3 s by default). */
  readonly debounceMs?: number;
  /** A read fetches the remote at most this often (20 s by default). */
  readonly pullEveryMs?: number;
  /** How long a read waits for that fetch at most (2.5 s by default). */
  readonly pullWaitMs?: number;
  /** Time limit of one background fetch or push (30 s by default). */
  readonly attemptTimeoutMs?: number;
  /** Pauses between two attempts after a failure, the last one repeated (15 s … 5 min by default). */
  readonly retryMs?: readonly number[];
}

/** What a bounded wait allows beyond its limit, for the cycle to answer. */
const GRACE_MS = 500;

/** The last date saved is written again only when it is older than this. */
const LAST_SAVED_REFRESH_MS = 5 * 60_000;

/** An `offline` backup older than this is told to the creator like a blocked one. */
const LONG_OFFLINE_MS = 24 * 60 * 60_000;

const DEFAULTS = {
  debounceMs: 3_000,
  pullEveryMs: 20_000,
  pullWaitMs: 2_500,
  attemptTimeoutMs: 30_000,
  retryMs: [15_000, 30_000, 60_000, 120_000, 5 * 60_000],
} as const;

/** What a forge or a Git server says when it refuses access (versus a network that is down). */
const ACCESS_DENIED =
  /authenticat|permission|denied|forbidden|\b40[134]\b|credential|repository not found|could not read (?:username|password)|publickey|invalid username|access rights|unauthori[sz]ed/i;

/** True when a Git message says the access is refused, not that the network is down. */
export function isAccessRefusal(message: string): boolean {
  return ACCESS_DENIED.test(message);
}

/** Resolves with the promise, or with `undefined` after `ms`; the wait is bounded, so its timer keeps the process up. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

function reasonOf(error: unknown): string {
  if (error instanceof AgentPluggedError) {
    const reason = (error.details as Record<string, unknown> | undefined)?.reason;
    return typeof reason === "string" && reason !== "" ? reason : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** The instruction for the agent that talks to the creator (Noah), one per way the backup is stuck. */
function actionOf(reason: BackupBlock, remote: string | undefined): string {
  const once =
    "Tell the creator ONCE, in one sentence and in their language, never as a question to repeat and never as a task for another agent.";
  switch (reason) {
    case "no_remote":
      return `The product's journal is kept on this machine only: this repository has no remote, so its whole history is lost if the machine fails. ${once} Offer the one gesture that fixes it: call request_creator_action with {kind: "forge_repo_create", forge: "github" or "gitlab" (the one the creator uses), name: the product's name}; a « oui » creates a private repository and the engine then saves the journal there by itself.`;
    case "public_remote":
      return `The engine did not send the journal to the remote ${remote ?? "origin"}: its repository is public, and even encrypted the journal's metadata (dates, agents, stories) must not be. It is kept on this machine only. ${once} Offer the one gesture that fixes it: call request_creator_action with {kind: "forge_repo_create", forge: "github" or "gitlab" (the one the creator uses), name: the product's name followed by -journal}; the engine sees that origin is public, so a « oui » creates a separate private repository (never origin, never public) and the engine then saves the journal there by itself.`;
    case "access_denied":
      return `The engine cannot save the journal to the remote ${remote ?? "origin"}: the forge refuses access. ${once} Say what fixes it: sign in to the forge again (\`gh auth login\` or \`glab auth login\`) or restore the access to that repository. The engine retries by itself; nothing else is needed.`;
    case "unreachable":
      return `The journal has not been saved to the remote ${remote ?? "origin"} for more than a day: it does not answer or does not take it. It is kept on this machine. ${once} Say since when (\`since\`) and ask them to check the connection and their access to that repository; the engine retries by itself.`;
    case "diverged":
      return `The engine paused the journal's backup: the remote's copy of the journal ${remote === undefined ? "" : `(${remote}) `}was rewritten, or holds events that conflict with this one. Nothing is forced and nothing is lost here. ${once} Say that the backup is paused and that you will look at it together; the detail comes from \`journal sync\`.`;
  }
}

const OFFLINE_ACTION =
  "No connection to the journal's remote: the engine keeps working here and catches up by itself when it returns. Not an incident: do not tell the creator.";

/**
 * The backup of one product's journal on one machine. Every method returns normally: a backup that
 * fails is a state (`report`), never a failure of the call that triggered it.
 */
export class JournalBackup {
  readonly #port: JournalBackupPort;
  readonly #now: Clock;
  readonly #debounceMs: number;
  readonly #pullEveryMs: number;
  readonly #pullWaitMs: number;
  readonly #attemptTimeoutMs: number;
  readonly #retryMs: readonly number[];
  #memory: Memory | undefined;
  #inflight: Promise<void> | undefined;
  /** A later write asked for another send while one ran. */
  #again = false;
  /** A read already gave up on the cycle running: the next ones do not wait for it. */
  #abandoned = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #dirty = false;
  #writes = 0;
  #failures = 0;
  #lastPullAt: number | undefined;
  #nextAttemptAt = 0;
  #closed = false;
  /** `close` stopped waiting for the cycle running: its next step is not taken. */
  #aborted = false;

  constructor(options: JournalBackupOptions) {
    this.#port = options.port;
    this.#now = options.now ?? Date.now;
    this.#debounceMs = options.debounceMs ?? DEFAULTS.debounceMs;
    this.#pullEveryMs = options.pullEveryMs ?? DEFAULTS.pullEveryMs;
    this.#pullWaitMs = options.pullWaitMs ?? DEFAULTS.pullWaitMs;
    this.#attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULTS.attemptTimeoutMs;
    this.#retryMs = options.retryMs ?? DEFAULTS.retryMs;
  }

  /** The journal was written: it is sent after a few seconds, with the writes that follow. */
  noteWrite(): void {
    this.#dirty = true;
    this.#writes += 1;
    if (this.#closed || this.#timer !== undefined) return;
    const wait = Math.max(this.#debounceMs, this.#nextAttemptAt - this.#now());
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#request("sync");
    }, wait);
    this.#timer.unref?.();
  }

  /**
   * The engine is activated on this machine: catches up with the remote (a new machine receives
   * the journal there) and sends what the remote lacks. Resolves once done; callers that must not
   * wait leave it running.
   */
  start(): Promise<void> {
    return this.#request("sync");
  }

  /** Asks for a backup now, whatever the pause after a failure (a gesture just fixed the problem). */
  kick(): Promise<void> {
    this.#nextAttemptAt = 0;
    return this.#request("sync");
  }

  /**
   * Before the state is read: fetches the remote's journal when the last fetch is old, waiting for
   * it at most `pullWaitMs`; never waits while the remote fails or a fetch is already late.
   */
  async beforeRead(): Promise<void> {
    if (this.#closed) return;
    if (this.#inflight !== undefined) {
      if (!this.#abandoned) await this.#waitFor(this.#inflight);
      return;
    }
    const now = this.#now();
    if (now < this.#nextAttemptAt) return;
    if (this.#lastPullAt !== undefined && now - this.#lastPullAt < this.#pullEveryMs) return;
    await this.#waitFor(this.#request("sync"));
  }

  /** Fetches the remote's journal now and waits at most `timeoutMs` (`init` of a cloned repository). */
  async pull(timeoutMs: number): Promise<void> {
    await this.#bounded("pull", timeoutMs);
  }

  /** Backs up now and waits at most `timeoutMs` (the commands of the CLI, which end right after). */
  async flush(timeoutMs: number): Promise<void> {
    await this.#bounded("sync", timeoutMs);
  }

  /**
   * One cycle awaited at most `ms` (plus a short grace): each of its Git calls gets a third of it,
   * so that the cycle itself ends within about the time it was given.
   */
  async #bounded(mode: "pull" | "sync", ms: number): Promise<void> {
    await within(this.#request(mode, Math.max(500, Math.floor(ms / 3))), ms + GRACE_MS);
  }

  /** Last chance before the engine stops: sends what is left, at most `timeoutMs`. */
  async close(timeoutMs = 5_000): Promise<void> {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    if (this.#retry !== undefined) clearTimeout(this.#retry);
    this.#timer = this.#retry = undefined;
    // Closed first: nothing starts again behind the last send (a git process started after the
    // journal's own were released would keep the process, and its folder, busy).
    const already = this.#closed;
    this.#closed = true;
    if (this.#inflight !== undefined) {
      if ((await within(this.#inflight, timeoutMs)) === undefined) this.#aborted = true;
    } else if (this.#dirty && !already && (await this.#recall()).status !== "blocked") {
      // A backup that is blocked is not tried again by every command that writes.
      await this.flush(timeoutMs);
    }
  }

  /**
   * What `get_state` and `next` say of the backup, or undefined while the journal is saved. A
   * blocked backup carries its `action` until Noah was told (`consume`: it is then marked told).
   */
  async report(
    options: { readonly consume?: boolean } = {},
  ): Promise<JournalBackupView | undefined> {
    const memory = await this.#recall();
    if (memory.status === undefined || memory.reason === undefined || memory.since === undefined) {
      return undefined;
    }
    const base = {
      status: memory.status,
      reason: memory.reason,
      since: memory.since,
      ...(memory.last_saved === undefined ? {} : { last_saved: memory.last_saved }),
      ...(memory.remote === undefined ? {} : { remote: memory.remote }),
    };
    const lasting =
      memory.status === "offline" &&
      this.#failures > 0 &&
      this.#now() - Date.parse(memory.since) >= LONG_OFFLINE_MS;
    if (memory.status === "offline" && !lasting) return { ...base, action: OFFLINE_ACTION };
    const reason = lasting ? "unreachable" : memory.reason;
    let told = memory.warned_reason === reason;
    if (options.consume === true && !told) {
      // Another engine of the same repository may have said it since this one read its memory.
      told = (await this.#persisted())?.warned_reason === reason;
      memory.warned_reason = reason;
      await this.#remember();
    }
    return {
      ...base,
      status: "blocked",
      reason,
      action: told
        ? "The creator was already told: say nothing more. The engine retries by itself."
        : actionOf(reason as BackupBlock, memory.remote),
    };
  }

  // --- the cycles ---------------------------------------------------------------------------

  async #waitFor(run: Promise<void>): Promise<void> {
    const done = await within(
      run.then(() => true),
      this.#pullWaitMs,
    );
    if (done === undefined) this.#abandoned = true;
  }

  /** One cycle at a time; a send asked for while one runs follows it. */
  #request(mode: "pull" | "sync", timeoutMs?: number): Promise<void> {
    if (this.#inflight !== undefined) {
      if (mode === "sync") this.#again = true;
      return this.#inflight;
    }
    this.#abandoned = false;
    const run = this.#attempt(mode, timeoutMs ?? this.#attemptTimeoutMs)
      .catch(() => {})
      .finally(() => {
        this.#inflight = undefined;
        this.#abandoned = false;
        if (this.#again && !this.#closed) {
          this.#again = false;
          void this.#request("sync");
        }
      });
    this.#inflight = run;
    return run;
  }

  async #attempt(mode: "pull" | "sync", timeoutMs: number): Promise<void> {
    const writes = this.#writes;
    let target: BackupRemote;
    try {
      target = await this.#port.backupRemote({ checkExposure: mode === "sync", timeoutMs });
    } catch (error) {
      // Not a Git repository: there is no journal to save, which is no state to remember.
      if (error instanceof AgentPluggedError && error.code === ErrorCode.NOT_A_GIT_REPO) {
        this.#lastPullAt = this.#now();
        return;
      }
      await this.#failed(error, undefined);
      return;
    }
    if (this.#aborted) return;
    if (target.kind === "none") {
      await this.#block("no_remote", undefined);
      return;
    }
    const { remote, exposure } = target;
    // A fetch gives nothing away: only a send needs to know who can read the repository.
    const send = mode === "sync" && exposure === "private";
    try {
      await syncJournal(this.#port, { remote, push: send, timeoutMs });
    } catch (error) {
      await this.#failed(error, remote);
      return;
    }
    this.#lastPullAt = this.#now();
    if (mode !== "sync") return;
    if (exposure === "public") {
      await this.#block("public_remote", remote);
      return;
    }
    if (exposure === "unknown") {
      // Not checkable now (the network): never sent blind; tried again later.
      await this.#offline("the repository's visibility could not be checked", remote);
      return;
    }
    if (this.#writes === writes) this.#dirty = false;
    await this.#saved();
  }

  async #failed(error: unknown, remote: string | undefined): Promise<void> {
    const code = error instanceof AgentPluggedError ? error.code : undefined;
    const reason = reasonOf(error);
    if (code === ErrorCode.NO_REMOTE) return this.#block("no_remote", undefined);
    if (
      code === ErrorCode.JOURNAL_REWRITTEN ||
      code === ErrorCode.JOURNAL_CONFLICT ||
      code === ErrorCode.PRODUCT_ID_MISMATCH
    ) {
      return this.#block("diverged", remote);
    }
    if (
      (code === ErrorCode.JOURNAL_REMOTE_UNREACHABLE || code === ErrorCode.UNEXPECTED) &&
      isAccessRefusal(reason)
    ) {
      return this.#block("access_denied", remote);
    }
    return this.#offline(reason, remote);
  }

  async #block(reason: BackupBlock, remote: string | undefined): Promise<void> {
    const memory = await this.#recall();
    const same = memory.status === "blocked" && memory.reason === reason;
    memory.status = "blocked";
    memory.reason = reason;
    memory.since ??= new Date(this.#now()).toISOString();
    if (remote === undefined) delete memory.remote;
    else memory.remote = remote;
    if (!same && memory.warned_reason !== reason) delete memory.warned_reason;
    await this.#remember();
    this.#retryLater();
  }

  async #offline(reason: string, remote: string | undefined): Promise<void> {
    const memory = await this.#recall();
    // A blocked backup stays what it is: the network says nothing more about it.
    if (memory.status !== "blocked") {
      memory.status = "offline";
      memory.reason = reason.split(/\r?\n/)[0]?.slice(0, 200) ?? "offline";
      memory.since ??= new Date(this.#now()).toISOString();
      if (remote !== undefined) memory.remote = remote;
      await this.#remember();
    }
    this.#retryLater();
  }

  async #saved(): Promise<void> {
    this.#failures = 0;
    this.#nextAttemptAt = 0;
    if (this.#retry !== undefined) clearTimeout(this.#retry);
    this.#retry = undefined;
    const memory = await this.#recall();
    const now = this.#now();
    // Written when it ends a problem, or when the last date kept is old: not at every send.
    const changed =
      memory.status !== undefined ||
      memory.last_saved === undefined ||
      now - Date.parse(memory.last_saved) > LAST_SAVED_REFRESH_MS;
    this.#memory = { last_saved: new Date(now).toISOString() };
    if (changed) await this.#remember();
  }

  /** Tries again after a pause that grows, by itself, as long as this engine runs. */
  #retryLater(): void {
    const pause = this.#retryMs[Math.min(this.#failures, this.#retryMs.length - 1)] ?? 60_000;
    this.#failures += 1;
    this.#nextAttemptAt = this.#now() + pause;
    if (this.#closed || this.#retry !== undefined) return;
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      void this.#request("sync");
    }, pause);
    this.#retry.unref?.();
  }

  // --- memory -------------------------------------------------------------------------------

  async #recall(): Promise<Memory> {
    if (this.#memory !== undefined) return this.#memory;
    let memory: Memory = {};
    try {
      const text = await this.#port.recallBackup();
      const parsed: unknown = text === undefined ? undefined : JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        memory = parsed as Memory;
      }
    } catch {
      memory = {};
    }
    this.#memory ??= memory;
    return this.#memory;
  }

  /** The memory as the file holds it now, or undefined. */
  async #persisted(): Promise<Memory | undefined> {
    try {
      const text = await this.#port.recallBackup();
      const parsed: unknown = text === undefined ? undefined : JSON.parse(text);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Memory)
        : undefined;
    } catch {
      return undefined;
    }
  }

  async #remember(): Promise<void> {
    if (this.#memory === undefined) return;
    try {
      await this.#port.rememberBackup(JSON.stringify(this.#memory));
    } catch {
      // A memory that cannot be written is not a reason to fail: the state is kept in memory.
    }
  }
}
