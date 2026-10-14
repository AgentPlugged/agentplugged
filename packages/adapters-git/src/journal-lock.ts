import { link, mkdir, open, readFile, rename, stat, unlink, utimes } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { AgentPluggedError } from "@agentplugged/core";
import { randomBytes, toBase64url } from "@agentplugged/crypto";
import { ErrorCode } from "@agentplugged/protocol";

/** Name of the journal lock, in the common Git folder (`git rev-parse --git-common-dir`). */
export const JOURNAL_LOCK_NAME = "agentplugged-journal.lock";
/**
 * How long a writer waits for the lock before `JOURNAL_BUSY`: a busy machine (agents, a CI on the
 * same computer) can keep another writer longer than 10 s; waiting beats failing an agent's step.
 */
export const LOCK_TIMEOUT_MS = 60_000;
/** A lock not refreshed for this long is an orphan, whoever holds it. */
export const STALE_LOCK_MS = 30_000;
/** How often a holder refreshes its lock, so that it never looks stale while alive. */
export const LOCK_HEARTBEAT_MS = 5_000;

export interface LockOptions {
  readonly timeoutMs?: number;
  readonly staleMs?: number;
  /** Refresh period of a held lock; at most a third of `staleMs`. */
  readonly heartbeatMs?: number;
}

export interface HeldLock {
  /** Milliseconds spent waiting for the lock. */
  readonly waitedMs: number;
  /** True when an orphan lock was taken over. */
  readonly reclaimed: boolean;
  /** Stops the heartbeat and deletes the lock, only if it is still this holder's. */
  release(): Promise<void>;
}

const nonce = () => toBase64url(randomBytes(12));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The lock's content when it is an orphan (dead process on this machine, or not refreshed). */
async function orphanContent(path: string, staleMs: number): Promise<string | undefined> {
  try {
    const [content, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    if (Date.now() - info.mtimeMs > staleMs) return content;
    const [pidText, host] = content.split("\n");
    const pid = Number(pidText);
    if (host === hostname() && Number.isInteger(pid) && pid > 0 && !isAlive(pid)) return content;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Takes over an orphan lock: it is renamed away (atomic, a single winner), then checked to be
 * the orphan that was judged. A live lock taken by mistake is put back with `link`, which never
 * replaces a file: when someone created a new lock meanwhile (`EEXIST`), that one is kept, and the
 * caller tries again (the displaced holder notices on release, since the content is not its own).
 */
async function reclaim(path: string, judged: string): Promise<boolean> {
  const aside = `${path}.stale-${process.pid}-${nonce()}`;
  try {
    await rename(path, aside);
  } catch {
    return false;
  }
  const content = await readFile(aside, "utf8").catch(() => undefined);
  if (content === judged) {
    await unlink(aside).catch(() => {});
    return true;
  }
  try {
    await link(aside, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await unlink(aside).catch(() => {});
  return false;
}

async function isOurs(path: string, token: string): Promise<boolean> {
  return (await readFile(path, "utf8").catch(() => undefined)) === token;
}

/**
 * Takes an exclusive lock (`O_EXCL` creation) at `path`. An orphan lock (process dead, or not
 * refreshed for `staleMs`) is taken over. While held, the lock's date is refreshed every
 * `heartbeatMs`. Waits at most `timeoutMs`, then fails with `JOURNAL_BUSY`
 * (`details: { lock, waited_ms, waited_s, stale_s }`).
 */
export async function acquireJournalLock(
  path: string,
  options: LockOptions = {},
): Promise<HeldLock> {
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? STALE_LOCK_MS;
  const heartbeatMs = Math.min(options.heartbeatMs ?? LOCK_HEARTBEAT_MS, staleMs / 3);
  const token = `${process.pid}\n${hostname()}\n${new Date().toISOString()}\n${nonce()}\n`;
  const started = Date.now();
  let reclaimed = false;
  await mkdir(dirname(path), { recursive: true });
  for (;;) {
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(token);
      } finally {
        await handle.close();
      }
      const heartbeat = setInterval(() => {
        void (async () => {
          if (!(await isOurs(path, token))) return;
          const now = new Date();
          await utimes(path, now, now).catch(() => {});
        })();
      }, heartbeatMs);
      heartbeat.unref();
      return {
        waitedMs: Date.now() - started,
        reclaimed,
        release: async () => {
          clearInterval(heartbeat);
          if (await isOurs(path, token)) await unlink(path).catch(() => {});
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EBUSY") throw error;
    }
    const orphan = await orphanContent(path, staleMs);
    if (orphan !== undefined && (await reclaim(path, orphan))) {
      reclaimed = true;
      continue;
    }
    const waited = Date.now() - started;
    if (waited >= timeoutMs) {
      throw new AgentPluggedError(ErrorCode.JOURNAL_BUSY, "error.journal_busy", {
        lock: path,
        waited_ms: waited,
        waited_s: Math.round(waited / 100) / 10,
        stale_s: Math.round(staleMs / 100) / 10,
      });
    }
    await sleep(1 + Math.floor(Math.random() * 4));
  }
}
