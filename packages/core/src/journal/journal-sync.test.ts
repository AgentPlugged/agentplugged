import { canonicalBytes, fromUtf8, toBase64url, utf8 } from "@agentplugged/crypto";
import { ErrorCode, type EventEnvelope, journalEventPath } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import type { CommandContext } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { MemoryFiles } from "../testing/memory-files.js";
import { journalCommand } from "./journal-command.js";
import {
  type JournalFiles,
  type JournalSync,
  type JournalWriter,
  type PushOutcome,
  type RemoteFetch,
  syncJournal,
} from "./journal-sync.js";
import { MemoryKeyStore } from "./key-store.js";
import { MemoryStateStore } from "./memory-state-store.js";
import type { EventDraft } from "./state-store.js";

const PRODUCT = "01JZ0000000000000000000000";
const OTHER_PRODUCT = "01JZ1111111111111111111111";
const SEED_A = toBase64url(new Uint8Array(32).fill(1));
const SEED_B = toBase64url(new Uint8Array(32).fill(2));

const draft = (n: number, product = PRODUCT): EventDraft => ({
  type: "test.appended",
  actor: { kind: "system" },
  product,
  provenance: "trusted",
  payload: { n },
});

const fileOf = (event: EventEnvelope) => `${fromUtf8(canonicalBytes(event))}\n`;

interface Commit {
  readonly parents: readonly string[];
  readonly files: ReadonlyMap<string, string>;
}

/** Commits and contents shared by every clone and the remote, as Git's objects would be. */
class World {
  readonly commits = new Map<string, Commit>();
  readonly blobs = new Map<string, Uint8Array>();
  /** The remote's journal branch. */
  remoteHead: string | null = null;
  /** Every update of the remote's branch: `[before, after]`. */
  readonly remoteUpdates: Array<[string | null, string]> = [];
  #n = 0;

  commit(parents: readonly string[], files: ReadonlyMap<string, string>): string {
    this.#n += 1;
    const id = `c${this.#n}`;
    this.commits.set(id, { parents, files: new Map(files) });
    return id;
  }

  blob(text: string): string {
    const id = `b:${text}`;
    this.blobs.set(id, utf8(text));
    return id;
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    const todo = [descendant];
    const done = new Set<string>();
    while (todo.length > 0) {
      const id = todo.pop() as string;
      if (id === ancestor) return true;
      if (done.has(id)) continue;
      done.add(id);
      todo.push(...(this.commits.get(id)?.parents ?? []));
    }
    return false;
  }

  /** Forces the remote's branch (what a `push --force` elsewhere would do). */
  force(commit: string | null): void {
    this.remoteHead = commit;
  }
}

/** One machine's repository: its journal branch and its references, over the shared `World`. */
class Clone implements JournalSync {
  local: string | null = null;
  readonly seenRefs = new Map<string, string>();
  remotes: string[] = ["origin"];
  tracked: string | undefined;
  /** Called before each push (a race: someone else pushes first). */
  beforePush: (() => void) | undefined;
  /** Writes of the local journal or of the references kept by sync. */
  writes = 0;
  pushes: PushOutcome[] = [];
  readonly store: MemoryStateStore;

  constructor(
    readonly world: World,
    seed: string,
  ) {
    this.store = new MemoryStateStore({ keys: new MemoryKeyStore(seed), allowTestTypes: true });
  }

  /** Appends events through the machine's own store, then commits their files on the branch. */
  async add(count: number, product = PRODUCT): Promise<void> {
    const before = this.store.events.length;
    for (let n = 0; n < count; n++) await this.store.append(draft(n, product));
    this.commitEvents(this.store.events.slice(before));
  }

  commitEvents(events: readonly EventEnvelope[], extra: Record<string, string> = {}): string {
    const files = new Map(this.local === null ? [] : this.world.commits.get(this.local)?.files);
    for (const event of events) files.set(journalEventPath(event), this.world.blob(fileOf(event)));
    for (const [path, text] of Object.entries(extra)) files.set(path, this.world.blob(text));
    this.local = this.world.commit(this.local === null ? [] : [this.local], files);
    return this.local;
  }

  /** Paths of the local journal. */
  paths(): string[] {
    if (this.local === null) return [];
    return [...(this.world.commits.get(this.local)?.files.keys() ?? [])].sort();
  }

  async resolveRemote(requested: string | undefined): Promise<string | null> {
    if (requested !== undefined) return this.remotes.includes(requested) ? requested : null;
    if (this.tracked !== undefined && this.remotes.includes(this.tracked)) return this.tracked;
    return this.remotes.includes("origin") ? "origin" : null;
  }

  async fetchRemote(): Promise<RemoteFetch> {
    const tip = this.world.remoteHead;
    return tip === null ? { kind: "absent" } : { kind: "fetched", tip };
  }

  async seen(remote: string): Promise<string | null> {
    return this.seenRefs.get(remote) ?? null;
  }

  async markSeen(remote: string, commit: string): Promise<void> {
    const old = this.seenRefs.get(remote);
    // Never backwards.
    if (old !== undefined && !this.world.isAncestor(old, commit)) return;
    this.writes += 1;
    this.seenRefs.set(remote, commit);
  }

  async forgetSeen(remote: string): Promise<void> {
    this.writes += 1;
    this.seenRefs.delete(remote);
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    return this.world.isAncestor(ancestor, descendant);
  }

  async files(commit: string): Promise<JournalFiles> {
    const found = this.world.commits.get(commit);
    if (found === undefined) throw new Error(`no commit ${commit}`);
    return found.files;
  }

  async readBlob(blob: string): Promise<Uint8Array> {
    const found = this.world.blobs.get(blob);
    if (found === undefined) throw new Error(`no blob ${blob}`);
    return found;
  }

  async productIdAt(commit: string): Promise<string | null> {
    for (const [, blob] of await this.files(commit)) {
      try {
        const event = JSON.parse(fromUtf8(await this.readBlob(blob)) ?? "") as EventEnvelope;
        if (event.type === "product.created") return event.product;
      } catch {}
    }
    return null;
  }

  async head(): Promise<string | null> {
    return this.local;
  }

  async withJournalLock<T>(task: (writer: JournalWriter) => Promise<T>): Promise<T> {
    const writer: JournalWriter = {
      head: async () => this.local,
      fastForward: async (to, from) => {
        if (this.local !== from) return false;
        this.writes += 1;
        this.local = to;
        return true;
      },
      merge: async ({ local, remote, add, message }) => {
        expect(message).toBe("journal: merge origin");
        if (this.local !== local) return null;
        const files = new Map(await this.files(local));
        for (const file of add) files.set(file.path, file.blob);
        this.writes += 1;
        this.local = this.world.commit([local, remote], files);
        return this.local;
      },
    };
    return task(writer);
  }

  async push(_remote: string, commit: string): Promise<PushOutcome> {
    this.beforePush?.();
    const remote = this.world.remoteHead;
    const outcome: PushOutcome =
      remote === null || this.world.isAncestor(remote, commit) ? "pushed" : "rejected";
    if (outcome === "pushed") {
      this.world.remoteUpdates.push([remote, commit]);
      this.world.remoteHead = commit;
    }
    this.pushes.push(outcome);
    return outcome;
  }
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

function machines() {
  const world = new World();
  return { world, a: new Clone(world, SEED_A), b: new Clone(world, SEED_B) };
}

describe("syncJournal", () => {
  it("creates the remote branch on the first push", async () => {
    const { world, a } = machines();
    await a.add(3);
    const result = await syncJournal(a);
    // device.registered, product.created and the 3 events.
    expect(result).toEqual({
      remote: "origin",
      integration: "none",
      received: 0,
      sent: 5,
      created: true,
      pushes: 1,
      empty: false,
    });
    expect(world.remoteHead).toBe(a.local);
    expect(a.seenRefs.get("origin")).toBe(a.local);
  });

  it("fast-forwards a machine that has nothing", async () => {
    const { world, a, b } = machines();
    await a.add(3);
    await syncJournal(a);
    const result = await syncJournal(b);
    expect(result).toMatchObject({ integration: "fast_forward", received: 5, sent: 0, pushes: 0 });
    expect(b.local).toBe(world.remoteHead);
    expect(b.seenRefs.get("origin")).toBe(world.remoteHead);
    expect(b.pushes).toEqual([]);
  });

  it("merges diverged journals by union, pushes a fast-forward, and the other side fast-forwards", async () => {
    const { world, a, b } = machines();
    await a.add(2);
    await syncJournal(a);
    await syncJournal(b);
    await a.add(3);
    await b.add(4);
    expect(await syncJournal(a)).toMatchObject({ integration: "none", sent: 3, created: false });

    const merged = await syncJournal(b);
    // B's own device.registered and product.created come with its first 4 events.
    expect(merged).toMatchObject({ integration: "merge", received: 3, sent: 6, pushes: 1 });
    const commit = world.commits.get(b.local as string);
    expect(commit?.parents).toHaveLength(2);

    expect(await syncJournal(a)).toMatchObject({
      integration: "fast_forward",
      received: 6,
      sent: 0,
    });
    expect(a.local).toBe(b.local);
    expect(a.paths()).toHaveLength(4 + 3 + 6);
    // Every update of the remote was a fast-forward.
    for (const [before, after] of world.remoteUpdates) {
      if (before !== null) expect(world.isAncestor(before, after)).toBe(true);
    }
  });

  it("gathers 2 × 20 events, every push a fast-forward", async () => {
    const { world, a, b } = machines();
    await a.add(20);
    await b.add(20);
    await syncJournal(a);
    await syncJournal(b);
    await syncJournal(a);
    expect(a.paths()).toEqual(b.paths());
    // 20 events per machine, plus each one's device.registered and product.created.
    expect(a.paths()).toHaveLength(44);
    expect([...a.pushes, ...b.pushes]).toEqual(["pushed", "pushed"]);
    for (const [before, after] of world.remoteUpdates) {
      if (before !== null) expect(world.isAncestor(before, after)).toBe(true);
    }
  });

  it("fetches and integrates again when the remote moves before the push", async () => {
    const { world, a, b } = machines();
    await a.add(1);
    await syncJournal(a);
    await syncJournal(b);
    await a.add(1);
    await b.add(1);
    let raced = false;
    b.beforePush = () => {
      if (raced) return;
      raced = true;
      // A pushes first (a fast-forward), between B's fetch and B's push.
      world.remoteUpdates.push([world.remoteHead, a.local as string]);
      world.remoteHead = a.local;
    };
    const result = await syncJournal(b);
    expect(b.pushes).toEqual(["rejected", "pushed"]);
    expect(result).toMatchObject({ integration: "merge", pushes: 2 });
    expect(world.remoteHead).toBe(b.local);
  });

  it("gives JOURNAL_PUSH_REJECTED after 3 refused pushes, keeping what it integrated", async () => {
    const { world, a, b } = machines();
    await a.add(1);
    await syncJournal(a);
    await b.add(1);
    let n = 0;
    b.beforePush = () => {
      // Someone else pushes before each of B's pushes.
      const tip = world.remoteHead as string;
      const files = world.commits.get(tip)?.files ?? new Map();
      n += 1;
      world.remoteHead = world.commit([tip], new Map(files));
    };
    const error = await rejection(syncJournal(b));
    expect(error.toPayload()).toEqual({
      code: ErrorCode.JOURNAL_PUSH_REJECTED,
      message_key: "error.journal_push_rejected",
      details: { remote: "origin", attempts: 3 },
    });
    expect(b.pushes).toEqual(["rejected", "rejected", "rejected"]);
    expect(n).toBe(3);
  });

  it("refuses a remote rewritten without an event already seen", async () => {
    const { world, a, b } = machines();
    await a.add(2);
    await syncJournal(a);
    await syncJournal(b);
    const seen = world.remoteHead as string;
    // The remote is forced back to a commit holding A's first events only.
    const files = new Map(world.commits.get(seen)?.files);
    const dropped = [...files.keys()].sort().at(-1) as string;
    files.delete(dropped);
    world.force(world.commit([], files));
    await b.add(1);
    const before = { local: b.local, writes: b.writes };

    const error = await rejection(syncJournal(b));
    expect(error.code).toBe(ErrorCode.JOURNAL_REWRITTEN);
    expect(error.details).toEqual({ remote: "origin", missing: 1 });
    expect({ local: b.local, writes: b.writes }).toEqual(before);
    expect(b.pushes).toEqual([]);
  });

  it("refuses a remote that dropped an event in a later commit, or lost its journal", async () => {
    const { world, a, b } = machines();
    await a.add(2);
    await syncJournal(a);
    await syncJournal(b);
    const seen = world.remoteHead as string;
    const files = new Map(world.commits.get(seen)?.files);
    files.delete([...files.keys()].sort().at(-1) as string);
    world.force(world.commit([seen], files));
    const error = await rejection(syncJournal(b));
    expect(error.toPayload()).toMatchObject({
      code: ErrorCode.JOURNAL_REWRITTEN,
      message_key: "error.journal_rewritten",
      details: { remote: "origin", missing: 1 },
    });
    world.force(null);
    const gone = await rejection(syncJournal(b));
    expect(gone.details).toEqual({ remote: "origin", missing: 4 });
    expect(b.pushes).toEqual([]);
  });

  it("refuses a remote that does not descend from the tip seen, even with the same files", async () => {
    const { world, a, b } = machines();
    await a.add(1);
    await syncJournal(a);
    await syncJournal(b);
    const seen = world.remoteHead as string;
    // Same files, another history.
    world.force(world.commit([], new Map(world.commits.get(seen)?.files)));
    const error = await rejection(syncJournal(b));
    expect(error.toPayload()).toEqual({
      code: ErrorCode.JOURNAL_REWRITTEN,
      message_key: "error.journal_rewritten",
      details: { remote: "origin", missing: 0 },
    });
    expect(b.local).toBe(seen);
    expect(b.seenRefs.get("origin")).toBe(seen);
  });

  it("refuses a fast-forward that would drop a local event, and leaves the journal alone", async () => {
    const { world, a } = machines();
    await a.add(2);
    // Never synced: no tip seen. The remote holds a child of the local journal without one file.
    const files = new Map(world.commits.get(a.local as string)?.files);
    files.delete([...files.keys()].sort().at(-1) as string);
    const local = a.local as string;
    world.force(world.commit([local], files));
    const error = await rejection(syncJournal(a));
    expect(error.toPayload()).toEqual({
      code: ErrorCode.JOURNAL_REWRITTEN,
      message_key: "error.journal_rewritten",
      details: { remote: "origin", missing: 1 },
    });
    expect(a.local).toBe(local);
    expect(a.writes).toBe(0);
  });

  it("recreates a remote branch deleted after a rewrite, only when asked", async () => {
    const { world, a } = machines();
    await a.add(1);
    await syncJournal(a);
    world.force(null);
    expect((await rejection(syncJournal(a))).code).toBe(ErrorCode.JOURNAL_REWRITTEN);
    const result = await syncJournal(a, { recreateRemote: true });
    expect(result).toMatchObject({ created: true, sent: 3, pushes: 1 });
    expect(world.remoteHead).toBe(a.local);
    expect(a.seenRefs.get("origin")).toBe(a.local);
    // The branch exists again: the flag is refused.
    const again = await rejection(syncJournal(a, { recreateRemote: true }));
    expect(again.code).toBe(ErrorCode.INVALID_ARGUMENTS);
  });

  it("pushes a merge that brings no new file, so the remote holds the local history", async () => {
    const { world, a, b } = machines();
    await a.add(1);
    await syncJournal(a);
    await syncJournal(b);
    await b.add(1);
    // Another history of the same files lands on the remote (a merge pushed by someone else).
    const tip = world.remoteHead as string;
    world.remoteHead = world.commit([tip], new Map(world.commits.get(tip)?.files));
    const result = await syncJournal(b);
    expect(result).toMatchObject({ integration: "merge", received: 0, sent: 3, pushes: 1 });
    expect(world.remoteHead).toBe(b.local);
    expect(await syncJournal(b)).toMatchObject({ integration: "none", pushes: 0 });
  });

  it("falls back to 3 attempts when maxAttempts is not a positive integer", async () => {
    for (const maxAttempts of [0, -1, 1.5, Number.NaN]) {
      const { world, a, b } = machines();
      await a.add(1);
      await syncJournal(a);
      await b.add(1);
      b.beforePush = () => {
        const tip = world.remoteHead as string;
        world.remoteHead = world.commit([tip], new Map(world.commits.get(tip)?.files));
      };
      const error = await rejection(syncJournal(b, { maxAttempts }));
      expect(error.details).toEqual({ remote: "origin", attempts: 3 });
    }
  });

  it("refuses the same path with two contents, and writes nothing", async () => {
    const { world, a, b } = machines();
    await a.add(1);
    await syncJournal(a);
    await syncJournal(b);
    await b.add(1);
    const known = [...(world.commits.get(world.remoteHead as string)?.files.keys() ?? [])][0];
    // A remote commit rewrites the content of a file both sides hold.
    const files = new Map(world.commits.get(world.remoteHead as string)?.files);
    files.set(known as string, world.blob("{}\n"));
    world.force(world.commit([world.remoteHead as string], files));
    const before = { local: b.local, writes: b.writes };
    const error = await rejection(syncJournal(b));
    expect(error.toPayload()).toEqual({
      code: ErrorCode.JOURNAL_CONFLICT,
      message_key: "error.journal_conflict.content",
      details: { remote: "origin", path: known },
    });
    expect({ local: b.local, writes: b.writes }).toEqual(before);
  });

  it("refuses an incoming file that is not an event at its own path", async () => {
    const { a, b } = machines();
    await a.add(1);
    await b.add(1);
    const event = a.store.events.at(-1) as EventEnvelope;
    const wrongPath = journalEventPath({ id: event.id, at: "2001-01-01T00:00:00.000Z" });
    for (const [path, text] of [
      ["journal/2026/01/01JZ0000000000000000000000.json", "not json\n"],
      [wrongPath, fileOf(event)],
      ["journal/2026/01/x.json", '{"v":1}\n'],
    ] as const) {
      const { world, a: other, b: local } = machines();
      await local.add(1);
      await other.add(1);
      other.commitEvents([], { [path]: text });
      world.remoteHead = other.local;
      const error = await rejection(syncJournal(local));
      expect(error.toPayload()).toEqual({
        code: ErrorCode.JOURNAL_CONFLICT,
        message_key: "error.journal_conflict.invalid",
        details: { remote: "origin", path },
      });
      expect(local.pushes).toEqual([]);
    }
  });

  it("refuses an event file that is not in canonical form", async () => {
    const { world, a: other, b: local } = machines();
    await local.add(1);
    await other.add(1);
    const event = other.store.events.at(-1) as EventEnvelope;
    // Same event, same path, but indented JSON.
    const path = journalEventPath(event);
    other.commitEvents([], { [path]: `${JSON.stringify(event, null, 2)}\n` });
    world.remoteHead = other.local;
    const error = await rejection(syncJournal(local));
    expect(error.toPayload()).toEqual({
      code: ErrorCode.JOURNAL_CONFLICT,
      message_key: "error.journal_conflict.invalid",
      details: { remote: "origin", path },
    });
    // Without its final newline, too.
    other.commitEvents([], { [path]: fileOf(event).trimEnd() });
    world.remoteHead = other.local;
    expect((await rejection(syncJournal(local))).code).toBe(ErrorCode.JOURNAL_CONFLICT);
  });

  it("refuses an id already held locally at another path", async () => {
    const { world, a, b } = machines();
    await a.add(1);
    await syncJournal(a);
    await syncJournal(b);
    await b.add(1);
    const event = a.store.events.at(-1) as EventEnvelope;
    const elsewhere = `journal/1999/01/${event.id}.json`;
    const tip = world.remoteHead as string;
    const files = new Map(world.commits.get(tip)?.files);
    files.set(elsewhere, world.blob(fileOf(event)));
    world.force(world.commit([tip], files));
    const error = await rejection(syncJournal(b));
    expect(error.toPayload()).toEqual({
      code: ErrorCode.JOURNAL_CONFLICT,
      message_key: "error.journal_conflict.duplicate",
      details: { remote: "origin", path: elsewhere },
    });
  });

  it("refuses a remote tree holding a file outside journal/, by fast-forward or by merge", async () => {
    for (const diverged of [false, true]) {
      const { world, a, b } = machines();
      await a.add(1);
      await syncJournal(a);
      if (diverged) {
        await syncJournal(b);
        await b.add(1);
      }
      const tip = world.remoteHead as string;
      const files = new Map(world.commits.get(tip)?.files);
      files.set("README.md", world.blob("hello\n"));
      world.force(world.commit([tip], files));
      const before = b.local;
      const error = await rejection(syncJournal(b));
      expect(error.toPayload()).toEqual({
        code: ErrorCode.JOURNAL_CONFLICT,
        message_key: "error.journal_conflict.outside",
        details: { remote: "origin", path: "README.md" },
      });
      expect(b.local).toBe(before);
    }
  });

  it("refuses an incoming event of another product, even without a product.created", async () => {
    const { world, a, b } = machines();
    await a.add(1);
    await syncJournal(a);
    await syncJournal(b);
    await b.add(1);
    // A new event of another product (signatures are the projection's business, not sync's).
    const event = a.store.events.at(-1) as EventEnvelope;
    // Same time part, highest random part: never the id of an event the machines generate.
    const id = `${event.id.slice(0, 10)}${"Z".repeat(16)}`;
    const forged = { ...event, id, product: OTHER_PRODUCT };
    const tip = world.remoteHead as string;
    const files = new Map(world.commits.get(tip)?.files);
    files.set(journalEventPath(forged), world.blob(fileOf(forged)));
    world.force(world.commit([tip], files));
    const error = await rejection(syncJournal(b));
    expect(error.toPayload()).toEqual({
      code: ErrorCode.PRODUCT_ID_MISMATCH,
      message_key: "error.product_id_mismatch.remote",
      details: { remote: "origin", product_id: OTHER_PRODUCT, journal_product_id: PRODUCT },
    });
  });

  it("refuses a remote journal of another product, and merges nothing", async () => {
    const { world, a, b } = machines();
    await a.add(1);
    await syncJournal(a);
    await b.add(1, OTHER_PRODUCT);
    const before = b.local;
    const error = await rejection(syncJournal(b));
    expect(error.toPayload()).toEqual({
      code: ErrorCode.PRODUCT_ID_MISMATCH,
      message_key: "error.product_id_mismatch.remote",
      details: { remote: "origin", product_id: PRODUCT, journal_product_id: OTHER_PRODUCT },
    });
    expect(b.local).toBe(before);
    expect(world.remoteHead).toBe(a.local);
  });

  it("gives NO_REMOTE without a remote, or with an unknown one", async () => {
    const { a } = machines();
    await a.add(1);
    a.remotes = [];
    expect((await rejection(syncJournal(a))).toPayload()).toEqual({
      code: ErrorCode.NO_REMOTE,
      message_key: "error.no_remote",
      details: {},
    });
    a.remotes = ["upstream"];
    expect((await rejection(syncJournal(a))).code).toBe(ErrorCode.NO_REMOTE);
    expect((await rejection(syncJournal(a, { remote: "nope" }))).toPayload()).toEqual({
      code: ErrorCode.NO_REMOTE,
      message_key: "error.no_remote.named",
      details: { remote: "nope" },
    });
    expect(a.writes).toBe(0);
  });

  it("uses the remote the current branch tracks, then origin", async () => {
    const { a } = machines();
    a.remotes = ["origin", "upstream"];
    a.tracked = "upstream";
    expect((await syncJournal(a)).remote).toBe("upstream");
    a.tracked = undefined;
    expect((await syncJournal(a)).remote).toBe("origin");
    expect((await syncJournal(a, { remote: "upstream" })).remote).toBe("upstream");
  });

  it("writes nothing when both sides are identical", async () => {
    const { a } = machines();
    await a.add(2);
    await syncJournal(a);
    const writes = a.writes;
    expect(await syncJournal(a)).toEqual({
      remote: "origin",
      integration: "none",
      received: 0,
      sent: 0,
      created: false,
      pushes: 0,
      empty: false,
    });
    expect(a.writes).toBe(writes);
  });

  it("does nothing without a journal on either side", async () => {
    const { a } = machines();
    expect(await syncJournal(a)).toMatchObject({
      integration: "none",
      sent: 0,
      pushes: 0,
      empty: true,
    });
    expect(a.writes).toBe(0);
  });
});

describe("journal command", () => {
  const context = (journalSync?: JournalSync): CommandContext => ({
    files: new MemoryFiles(),
    tools: {
      which: async () => undefined,
      version: async () => undefined,
      extensions: async () => [],
    },
    method: new MemoryFiles(),
    actor: "human" as const,
    engineVersion: "0.1.0",
    journalSync,
  });

  it("runs sync through the port, and refuses another action", async () => {
    const { a } = machines();
    await a.add(1);
    const result = await journalCommand.run(context(a), { action: "sync" });
    expect(result).toMatchObject({ ok: true, value: { sent: 3, created: true } });
    const named = await journalCommand.run(context(a), { action: "sync", remote: "nope" });
    expect(named.ok || named.error.code).toBe(ErrorCode.NO_REMOTE);
    const other = await journalCommand.run(context(a), { action: "push" });
    expect(other.ok || other.error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
    const none = await journalCommand.run(context(), { action: "sync" });
    expect(none.ok || none.error.code).toBe(ErrorCode.UNEXPECTED);
    const blank = await journalCommand.run(context(a), { action: "sync", remote: " " });
    expect(blank.ok || blank.error.toPayload()).toEqual({
      code: ErrorCode.INVALID_ARGUMENTS,
      message_key: "error.invalid_arguments",
      details: { reason: "--remote" },
    });
    const missing = await journalCommand.run(context(a), {});
    expect(missing.ok || missing.error.details).toEqual({ reason: "journal (sync, status)" });
  });
});
