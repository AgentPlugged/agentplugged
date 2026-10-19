import { describe, expect, it } from "vitest";
import {
  applyFeedOps,
  cursorId,
  diffPublished,
  FEED_SCHEMA_VERSION,
  FeedBeatSchema,
  FeedChangeSchema,
  FeedPatchError,
  FeedSnapshotSchema,
  feedNeedsUpgrade,
  jsonEqual,
  type PublishedState,
  PublishedStateSchema,
  PublishedStoryDocSchema,
  PublishedStoryDocsSchema,
  sameCursor,
  snapshotVerdict,
} from "./published-state.js";

const PRODUCT = "01J9ZQ4V8E3M5N7P9R1S3T5V7X";
const BRIDGE = "machine:AAAAAAAAAAAAAAAA";
const PHONE = "phone:BBBBBBBBBBBBBBBB";

function baseState(): PublishedState {
  return {
    projection: {
      format: 1,
      journal_head: null,
      computed_at: null,
      product: PRODUCT,
      devices: [],
      applied: 0,
      ignored: [],
      warnings: [],
      state: {},
    },
    trust: { blocked: false, devices: {}, revoked: [] },
    machines: { primary: null, automatic: false },
    import: { state: "none" },
  };
}

/** A small deterministic generator, so that a failing run can be replayed. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS = ["stories", "criteria", "budget", "agents", "memory", "sprints"];
const IDS = ["a1", "b2", "c3", "d4", "e5"];

/** One more event: changes some part of the state the way a reducer would. */
function mutate(state: PublishedState, rand: () => number): PublishedState {
  const next = JSON.parse(JSON.stringify(state)) as PublishedState;
  const bag = next.projection.state as Record<string, Record<string, unknown> | number[]>;
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;
  const roll = rand();
  const key = pick(KEYS);
  if (roll < 0.35) {
    const section = (bag[key] ?? {}) as Record<string, unknown>;
    section[pick(IDS)] = { status: pick(["open", "done", "blocked"]), n: Math.floor(rand() * 9) };
    bag[key] = section;
  } else if (roll < 0.5) {
    const section = (bag[key] ?? {}) as Record<string, Record<string, unknown>>;
    const id = pick(IDS);
    section[id] = { ...(section[id] ?? {}), deep: { level: Math.floor(rand() * 5), tags: ["x"] } };
    bag[key] = section as Record<string, Record<string, unknown>>;
  } else if (roll < 0.62) {
    const section = (bag[key] ?? {}) as Record<string, unknown>;
    delete section[pick(IDS)];
    bag[key] = section;
  } else if (roll < 0.7) {
    delete bag[key];
  } else if (roll < 0.8) {
    next.projection.applied += 1;
    next.projection.computed_at = `2026-10-15T08:00:${String(Math.floor(rand() * 60)).padStart(2, "0")}.000Z`;
  } else if (roll < 0.88) {
    const id = `${pick(["phone", "browser"])}:${"ABCDEFGHIJKLMNOP".slice(0, 16)}`;
    next.trust.devices[id] = {
      kind: id.startsWith("phone") ? "phone" : "browser",
      sig_key: `sig${Math.floor(rand() * 99)}`,
      enc_key: rand() < 0.5 ? null : "enc",
      provisional: rand() < 0.5,
    };
  } else if (roll < 0.94) {
    next.trust.revoked = rand() < 0.5 ? [PHONE] : [];
    next.trust.blocked = rand() < 0.2;
  } else {
    next.machines.primary = rand() < 0.5 ? BRIDGE : null;
    next.import.state = pick(["none", "running", "done", "failed"] as const);
  }
  return next;
}

describe("published state", () => {
  it("accepts a state and refuses one that carries more than the schema names", () => {
    expect(PublishedStateSchema.safeParse(baseState()).success).toBe(true);
    expect(PublishedStateSchema.safeParse({ ...baseState(), extra: 1 }).success).toBe(false);
    const bad = baseState();
    (bad.trust.devices as Record<string, unknown>)["not a device"] = {};
    expect(PublishedStateSchema.safeParse(bad).success).toBe(false);
  });

  it("carries the trusted and revoked devices, the machines and the import", () => {
    const state = baseState();
    state.trust.devices[PHONE] = {
      kind: "phone",
      sig_key: "k",
      enc_key: "e",
      provisional: false,
    };
    state.trust.revoked = ["browser:CCCCCCCCCCCCCCCC"];
    state.machines.primary = BRIDGE;
    state.import.state = "running";
    expect(PublishedStateSchema.safeParse(state).success).toBe(true);
  });
});

describe("cursors", () => {
  const a = { n: 3, heads: { w1: "h1", w2: "h2" } };
  it("name the same place whatever the order of the writers", () => {
    expect(sameCursor(a, { n: 3, heads: { w2: "h2", w1: "h1" } })).toBe(true);
    expect(cursorId(a)).toBe("3;w1=h1;w2=h2");
    expect(sameCursor(a, { n: 3, heads: { w1: "h1", w2: "other" } })).toBe(false);
    expect(sameCursor(a, { n: 4, heads: a.heads })).toBe(false);
  });

  it("decide what a view does with a snapshot", () => {
    expect(snapshotVerdict(undefined, a)).toBe("apply");
    expect(snapshotVerdict(a, { n: 4, heads: { w1: "h9" } })).toBe("apply");
    expect(snapshotVerdict(a, a)).toBe("duplicate");
    expect(snapshotVerdict(a, { n: 2, heads: {} })).toBe("behind");
    expect(snapshotVerdict(a, { n: 3, heads: { w1: "x" } })).toBe("conflict");
  });
});

describe("messages", () => {
  const cursor = { n: 1, heads: { w: "h" } };
  it("snapshot, change and beat are strict objects", () => {
    expect(
      FeedSnapshotSchema.safeParse({
        kind: "snapshot",
        schema: FEED_SCHEMA_VERSION,
        product: PRODUCT,
        cursor,
        state: baseState(),
      }).success,
    ).toBe(true);
    expect(
      FeedChangeSchema.safeParse({
        kind: "change",
        schema: FEED_SCHEMA_VERSION,
        product: PRODUCT,
        from_cursor: cursor,
        to_cursor: { n: 2, heads: { w: "h2" } },
        ops: [{ op: "set", path: ["trust", "blocked"], value: true }],
      }).success,
    ).toBe(true);
    expect(
      FeedChangeSchema.safeParse({
        kind: "change",
        schema: 1,
        product: PRODUCT,
        from_cursor: cursor,
        to_cursor: cursor,
        ops: [{ op: "set", path: [], value: 1 }],
      }).success,
    ).toBe(false);
    expect(
      FeedBeatSchema.safeParse({
        bridge: BRIDGE,
        at: 1_760_000_000,
        bridge_version: "1.0.0",
        protocol_version: 1,
        schema: 1,
        last_seq: 4,
        publishes: [{ product: PRODUCT, cursor }],
      }).success,
    ).toBe(true);
  });

  it("serves the current and the previous schema, and asks older views to update", () => {
    expect(feedNeedsUpgrade(1, 1)).toBe(false);
    expect(feedNeedsUpgrade(1, 2)).toBe(false);
    expect(feedNeedsUpgrade(1, 3)).toBe(true);
  });
});

describe("changes", () => {
  it("name only what moved", () => {
    const before = baseState();
    const after = JSON.parse(JSON.stringify(before)) as PublishedState;
    (after.projection.state as Record<string, unknown>).stories = { a1: { status: "open" } };
    after.projection.applied = 1;
    expect(diffPublished(before, after)).toEqual([
      { op: "set", path: ["projection", "applied"], value: 1 },
      { op: "set", path: ["projection", "state", "stories"], value: { a1: { status: "open" } } },
    ]);
    expect(diffPublished(before, before)).toEqual([]);
  });

  it("apply on a copy and leave the original as it was", () => {
    const before = baseState();
    const after = mutate(before, random(5));
    const copy = JSON.parse(JSON.stringify(before));
    expect(applyFeedOps(before, diffPublished(before, after))).toEqual(after);
    expect(before).toEqual(copy);
  });

  it("refuse a step that names a key a change may not carry", () => {
    const state = baseState();
    for (const path of [["__proto__", "x"], ["projection", "constructor"], ["prototype"]]) {
      expect(() => applyFeedOps(state, [{ op: "set", path, value: 1 }])).toThrow(FeedPatchError);
    }
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("refuse a path that is not there, a removal of nothing, and a result that is no state", () => {
    const state = baseState();
    expect(() =>
      applyFeedOps(state, [{ op: "set", path: ["projection", "state", "a", "b"], value: 1 }]),
    ).toThrow(FeedPatchError);
    expect(() =>
      applyFeedOps(state, [{ op: "remove", path: ["projection", "state", "nothing"] }]),
    ).toThrow(FeedPatchError);
    expect(() => applyFeedOps(state, [{ op: "remove", path: ["machines"] }])).toThrow(
      FeedPatchError,
    );
  });

  it("cannot be computed for a key that no change may carry", () => {
    const before = baseState();
    const after = baseState();
    (after.projection.state as Record<string, unknown>) = JSON.parse('{"__proto__": {"x": 1}}');
    expect(() => diffPublished(before, after)).toThrow(FeedPatchError);
  });

  it("compare objects whatever the order of their keys", () => {
    expect(jsonEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
  });
});

describe("a view that applies every change from cursor k to n", () => {
  it("holds, field by field, the snapshot at cursor n (random runs of events)", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const rand = random(seed);
      const states: PublishedState[] = [baseState()];
      const length = 5 + Math.floor(rand() * 40);
      for (let i = 0; i < length; i += 1) {
        // Some events change nothing visible: the state is the same, the change is empty.
        const last = states[states.length - 1] as PublishedState;
        states.push(rand() < 0.1 ? last : mutate(last, rand));
      }
      // Changes go over the wire as JSON, as they do in the feed.
      const changes = states
        .slice(1)
        .map((next, i) =>
          JSON.parse(JSON.stringify(diffPublished(states[i] as PublishedState, next))),
        );
      const k = Math.floor(rand() * states.length);
      let view = states[k] as PublishedState;
      for (let i = k; i < states.length - 1; i += 1) view = applyFeedOps(view, changes[i]);
      expect(view).toEqual(states[states.length - 1]);
      expect(PublishedStateSchema.safeParse(view).success).toBe(true);
    }
  });
});

describe("the import of a history", () => {
  const running: PublishedState["import"] = {
    state: "running",
    progress: { events_done: 40, events_total: 131 },
    stories: 48,
    validations: 131,
  };
  const done: PublishedState["import"] = {
    state: "done",
    progress: { events_done: 131, events_total: 131 },
    stories: 48,
    validations: 131,
    ignored: 2,
  };

  it("carries the numbers of the product, the progress and the events refused", () => {
    for (const info of [{ state: "none" }, running, done]) {
      const state = { ...baseState(), import: info } as PublishedState;
      expect(PublishedStateSchema.safeParse(state).success).toBe(true);
    }
    const invented = { ...baseState(), import: { state: "done", certified: 3 } };
    expect(PublishedStateSchema.safeParse(invented).success).toBe(false);
    const negative = { ...baseState(), import: { state: "done", ignored: -1 } };
    expect(PublishedStateSchema.safeParse(negative).success).toBe(false);
  });

  it("goes from under way to done as a change a view can apply, and back", () => {
    const before = { ...baseState(), import: running } as PublishedState;
    const after = { ...baseState(), import: done } as PublishedState;
    const forward = JSON.parse(JSON.stringify(diffPublished(before, after)));
    expect(applyFeedOps(before, forward)).toEqual(after);
    const back = JSON.parse(JSON.stringify(diffPublished(after, before)));
    expect(applyFeedOps(after, back)).toEqual(before);
  });
});

describe("the story files a bridge publishes", () => {
  const doc = {
    title: "Sign in with a passkey",
    owner: "sam",
    epic: "epic-2",
    requirements: ["EF-1"],
    depends_on: ["2-5"],
    branch: "feat/2-6-passkey",
    budget_usd: 12.5,
    intent: "Let people sign in.",
    criteria: ["It works", "It fails safely"],
  };

  it("accepts a complete entry and one without the optional fields", () => {
    expect(PublishedStoryDocSchema.safeParse(doc).success).toBe(true);
    const { owner, epic, branch, budget_usd, ...bare } = doc;
    expect([owner, epic, branch, budget_usd]).toHaveLength(4);
    expect(PublishedStoryDocSchema.safeParse(bare).success).toBe(true);
  });

  it("refuses an unknown key, an empty title and too many criteria", () => {
    expect(PublishedStoryDocSchema.safeParse({ ...doc, extra: 1 }).success).toBe(false);
    expect(PublishedStoryDocSchema.safeParse({ ...doc, title: "" }).success).toBe(false);
    expect(
      PublishedStoryDocSchema.safeParse({ ...doc, criteria: Array.from({ length: 41 }, () => "x") })
        .success,
    ).toBe(false);
  });

  it("keys the entries by story identifier", () => {
    expect(PublishedStoryDocsSchema.safeParse({ "2-6": doc }).success).toBe(true);
    expect(PublishedStoryDocsSchema.safeParse({ "10-12": doc }).success).toBe(true);
    expect(PublishedStoryDocsSchema.safeParse({ nope: doc, "1d-1": doc }).success).toBe(false);
  });

  it("leaves the published state valid: the open state record carries the key", () => {
    const state = baseState();
    const withDocs = {
      ...state,
      projection: {
        ...state.projection,
        state: { ...state.projection.state, story_docs: { "2-6": doc } },
      },
    };
    expect(PublishedStateSchema.safeParse(withDocs).success).toBe(true);
  });
});
