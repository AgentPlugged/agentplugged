import { ErrorCode } from "@agentplugged/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPluggedError } from "../errors.js";
import {
  type BackupRemote,
  isAccessRefusal,
  JOURNAL_REMOTE_NAME,
  JournalBackup,
  type JournalBackupPort,
} from "./journal-backup.js";
import { syncJournal } from "./journal-sync.js";

// The decisions of the backup, not Git: `syncJournal` is the one of `journal sync`, tested on its own.
vi.mock("./journal-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./journal-sync.js")>()),
  syncJournal: vi.fn(),
}));

const synced = vi.mocked(syncJournal);

const RESULT = {
  remote: "origin",
  integration: "none",
  received: 0,
  sent: 0,
  created: false,
  pushes: 0,
  empty: false,
} as const;

class FakePort {
  remote: BackupRemote = { kind: "remote", remote: "origin", exposure: "private" };
  failure: unknown;
  memory: string | undefined;
  asked: boolean[] = [];

  async backupRemote(options: { checkExposure: boolean }): Promise<BackupRemote> {
    this.asked.push(options.checkExposure);
    if (this.failure !== undefined) throw this.failure;
    return this.remote;
  }
  async remoteExposure() {
    return "private" as const;
  }
  async recallBackup() {
    return this.memory;
  }
  async rememberBackup(text: string) {
    this.memory = text;
  }
}

const asPort = (port: FakePort) => port as unknown as JournalBackupPort;

function unreachable(reason: string): AgentPluggedError {
  return new AgentPluggedError(
    ErrorCode.JOURNAL_REMOTE_UNREACHABLE,
    "error.journal_remote_unreachable",
    { remote: "origin", reason },
  );
}

const never = () => new Promise<never>(() => {});
declare function setTimeout(handler: () => void, ms: number): unknown;
const later = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let port: FakePort;
const opened: JournalBackup[] = [];

function backup(options: Partial<ConstructorParameters<typeof JournalBackup>[0]> = {}) {
  const created = new JournalBackup({
    port: asPort(port),
    debounceMs: 20,
    pullEveryMs: 0,
    pullWaitMs: 60,
    retryMs: [10_000],
    ...options,
  });
  opened.push(created);
  return created;
}

beforeEach(() => {
  port = new FakePort();
  synced.mockReset();
  synced.mockResolvedValue({ ...RESULT });
});

afterEach(async () => {
  for (const one of opened.splice(0)) await one.close(10);
});

describe("JournalBackup: sending after the writes", () => {
  it("sends once for the writes of a few seconds, never forced, and says nothing when it works", async () => {
    const saving = backup();
    saving.noteWrite();
    saving.noteWrite();
    saving.noteWrite();
    await later(120);
    expect(synced).toHaveBeenCalledTimes(1);
    expect(synced).toHaveBeenCalledWith(expect.anything(), {
      remote: "origin",
      push: true,
      timeoutMs: 30_000,
    });
    expect(await saving.report()).toBeUndefined();
  });

  it("sends again what was written while a send ran", async () => {
    let release: () => void = () => {};
    synced.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ...RESULT });
        }),
    );
    const saving = backup();
    saving.noteWrite();
    await later(60);
    saving.noteWrite();
    await later(60);
    expect(synced).toHaveBeenCalledTimes(1);
    release();
    await later(60);
    expect(synced).toHaveBeenCalledTimes(2);
  });

  it("catches up when the engine starts (a new machine receives the journal)", async () => {
    const saving = backup();
    await saving.start();
    expect(synced).toHaveBeenCalledTimes(1);
    expect(synced.mock.calls[0]?.[1]).toMatchObject({ push: true });
  });
});

describe("JournalBackup: fetching before a read", () => {
  it("fetches when the last fetch is old, and not again right away", async () => {
    const saving = backup({ pullEveryMs: 60_000 });
    await saving.beforeRead();
    await saving.beforeRead();
    expect(synced).toHaveBeenCalledTimes(1);
  });

  it("never waits longer than its limit for a slow remote, nor again while that fetch runs", async () => {
    synced.mockImplementation(never);
    const saving = backup({ pullWaitMs: 40 });
    await saving.beforeRead();
    await saving.beforeRead();
    expect(synced).toHaveBeenCalledTimes(1);
  });

  it("does not wait while the remote fails: it backs off", async () => {
    synced.mockRejectedValue(unreachable("Could not resolve host: example.com"));
    const saving = backup();
    await saving.beforeRead();
    expect(synced).toHaveBeenCalledTimes(1);
    await saving.beforeRead();
    expect(synced).toHaveBeenCalledTimes(1);
  });
});

describe("JournalBackup: when it cannot save", () => {
  it("offline: keeps going locally, says since when, tells nobody", async () => {
    synced.mockRejectedValue(unreachable("fatal: unable to access: Could not resolve host: x"));
    const saving = backup({ now: () => Date.parse("2026-10-07T10:00:00Z") });
    await saving.start();
    const view = await saving.report({ consume: true });
    expect(view).toMatchObject({
      status: "offline",
      since: "2026-10-07T10:00:00.000Z",
      remote: "origin",
    });
    expect(view?.action).toContain("do not tell the creator");
  });

  it("an offline that lasts more than a day is told like a blocked one, once", async () => {
    let now = Date.parse("2026-10-07T10:00:00Z");
    synced.mockRejectedValue(unreachable("Could not resolve host: x"));
    const saving = backup({ now: () => now });
    await saving.start();
    expect((await saving.report({ consume: true }))?.status).toBe("offline");
    // A file older than a day proves nothing alone: this engine has to have failed too, and it did.
    now += 25 * 3_600_000;
    const view = await saving.report({ consume: true });
    expect(view).toMatchObject({ status: "blocked", reason: "unreachable", remote: "origin" });
    expect(view?.action).toContain("ONCE");
    expect((await saving.report({ consume: true }))?.action).toContain("already told");
  });

  it("a stale memory of an offline, read by an engine that did not fail yet, is not an incident", async () => {
    port.memory = JSON.stringify({
      status: "offline",
      reason: "Could not resolve host: x",
      since: "2026-10-01T10:00:00.000Z",
    });
    const saving = backup({ now: () => Date.parse("2026-10-07T10:00:00Z") });
    expect((await saving.report({ consume: true }))?.status).toBe("offline");
  });

  it("said once even when another engine of the same repository said it first", async () => {
    port.remote = { kind: "none" };
    const first = backup();
    const second = backup();
    await first.start();
    await second.start();
    expect((await first.report({ consume: true }))?.action).toContain("ONCE");
    expect((await second.report({ consume: true }))?.action).toContain("already told");
  });

  it("a blocked backup is not tried again by a command that ends right after a write", async () => {
    port.remote = { kind: "none" };
    const saving = backup({ debounceMs: 60_000 });
    saving.noteWrite();
    await saving.start();
    const before = port.asked.length;
    await saving.close(100);
    expect(port.asked).toHaveLength(before);
  });

  it("catches up by itself when the connection returns, and forgets the problem", async () => {
    synced.mockRejectedValueOnce(unreachable("Could not resolve host: x"));
    const saving = backup();
    await saving.start();
    expect((await saving.report())?.status).toBe("offline");
    synced.mockResolvedValue({ ...RESULT, sent: 4 });
    await saving.kick();
    expect(await saving.report()).toBeUndefined();
    expect(JSON.parse(port.memory ?? "{}")).toEqual({ last_saved: expect.any(String) });
  });

  it("no remote: blocked, told once with the gesture that fixes it, never twice", async () => {
    port.remote = { kind: "none" };
    const saving = backup();
    await saving.start();
    const first = await saving.report({ consume: true });
    expect(first).toMatchObject({ status: "blocked", reason: "no_remote" });
    expect(first?.action).toContain("forge_repo_create");
    expect(first?.action).toContain("ONCE");
    const second = await saving.report({ consume: true });
    expect(second?.action).toContain("already told");
    expect(second?.since).toBe(first?.since);
    expect(synced).not.toHaveBeenCalled();
  });

  it("a told problem stays told after the engine restarts, until it is fixed", async () => {
    port.remote = { kind: "none" };
    await backup().start();
    await backup().report({ consume: true });
    const restarted = backup();
    await restarted.start();
    expect((await restarted.report({ consume: true }))?.action).toContain("already told");
    port.remote = { kind: "remote", remote: "origin", exposure: "private" };
    await restarted.kick();
    expect(await restarted.report()).toBeUndefined();
    // A new problem is told again.
    port.remote = { kind: "none" };
    await restarted.kick();
    expect((await restarted.report({ consume: true }))?.action).toContain("ONCE");
  });

  it("a public repository: fetches, never sends, offers the separate private repository", async () => {
    port.remote = { kind: "remote", remote: "origin", exposure: "public" };
    const saving = backup();
    await saving.start();
    expect(synced).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ push: false }),
    );
    const view = await saving.report({ consume: true });
    expect(view).toMatchObject({ status: "blocked", reason: "public_remote", remote: "origin" });
    expect(view?.action).toContain("-journal");
    expect(view?.action).toContain("public");
  });

  it("a visibility that cannot be checked is never sent blind", async () => {
    port.remote = { kind: "remote", remote: "origin", exposure: "unknown" };
    const saving = backup();
    await saving.start();
    expect(synced).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ push: false }),
    );
    expect((await saving.report())?.status).toBe("offline");
  });

  it("access refused: blocked, with how to restore the access", async () => {
    synced.mockRejectedValue(unreachable("remote: Permission to ada/x.git denied to grace"));
    const saving = backup();
    await saving.start();
    const view = await saving.report({ consume: true });
    expect(view).toMatchObject({ status: "blocked", reason: "access_denied" });
    expect(view?.action).toContain("auth login");
  });

  it("a rewritten or conflicting remote journal: blocked, nothing forced", async () => {
    synced.mockRejectedValue(
      new AgentPluggedError(ErrorCode.JOURNAL_REWRITTEN, "error.journal_rewritten", {
        remote: "origin",
        missing: 2,
      }),
    );
    const saving = backup();
    await saving.start();
    expect(await saving.report()).toMatchObject({ status: "blocked", reason: "diverged" });
  });

  it("a busy journal or a push refused for a moment is retried, not blocked", async () => {
    synced.mockRejectedValue(
      new AgentPluggedError(ErrorCode.JOURNAL_PUSH_REJECTED, "error.journal_push_rejected", {
        remote: "origin",
        attempts: 3,
      }),
    );
    const saving = backup();
    await saving.start();
    expect((await saving.report())?.status).toBe("offline");
  });

  it("not a Git repository: nothing to save, nothing remembered", async () => {
    port.failure = new AgentPluggedError(ErrorCode.NOT_A_GIT_REPO, "error.not_a_git_repo", {
      path: "/x",
    });
    const saving = backup();
    await saving.start();
    expect(await saving.report()).toBeUndefined();
    expect(port.memory).toBeUndefined();
  });

  it("a gesture that fixes it asks for a new try at once, whatever the pause", async () => {
    port.remote = { kind: "none" };
    const saving = backup();
    await saving.start();
    port.remote = { kind: "remote", remote: JOURNAL_REMOTE_NAME, exposure: "private" };
    await saving.kick();
    expect(synced).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ remote: JOURNAL_REMOTE_NAME, push: true }),
    );
    expect(await saving.report()).toBeUndefined();
  });
});

describe("JournalBackup: what ends a command", () => {
  it("flush sends now and waits no longer than its limit", async () => {
    synced.mockImplementation(never);
    const saving = backup();
    await saving.flush(50);
    expect(synced.mock.calls[0]?.[1]).toMatchObject({ push: true, timeoutMs: 500 });
  });

  it("pull only fetches, never sends", async () => {
    const saving = backup();
    await saving.pull(100);
    expect(synced).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ push: false }),
    );
    expect(port.asked).toEqual([false]);
  });
});

describe("isAccessRefusal", () => {
  it.each([
    "fatal: Authentication failed for 'https://github.com/ada/x.git/'",
    "git@github.com: Permission denied (publickey).",
    "remote: Repository not found.",
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    "The requested URL returned error: 403",
  ])("recognises %s", (message) => {
    expect(isAccessRefusal(message)).toBe(true);
  });

  it.each([
    "fatal: unable to access 'https://x/': Could not resolve host: x",
    "fatal: git fetch took more than 30 s",
    "Connection timed out",
  ])("does not take %s for a refusal", (message) => {
    expect(isAccessRefusal(message)).toBe(false);
  });
});
