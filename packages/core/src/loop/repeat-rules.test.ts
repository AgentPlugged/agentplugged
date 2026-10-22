import { describe, expect, it } from "vitest";
import type { StoryState } from "../projection/agent-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { loopVerdict } from "./loop-rules.js";
import {
  nextRefusal,
  nextStall,
  progressMark,
  repeatedCause,
  type StallRecord,
} from "./repeat-rules.js";

const at = (minute: number) => `2026-10-22T10:${String(minute).padStart(2, "0")}:00.000Z`;

function story(over: Partial<StoryState> = {}): StoryState {
  return {
    status: "in_progress",
    status_by: null,
    progress: null,
    results: {},
    waiting_on: [],
    ...over,
  } as StoryState;
}

const attempt = (minute: number, result: "failed" | "green" | "started", note?: string) => ({
  approach: `approach at ${minute}`,
  result,
  ...(note === undefined ? {} : { note }),
  at: at(minute),
  event: `E${minute}`,
});

const finding = (title: string, path?: string) => ({
  id: title,
  severity: "should_fix",
  title,
  ...(path === undefined ? {} : { path }),
  triage: null,
});

function pass(minute: number, titles: readonly [string, string?][]) {
  return {
    number: minute,
    since: at(0),
    commit: `c${minute}`,
    reviews: { qa: { findings: titles.map(([title, path]) => finding(title, path)) } },
    security: { required: false },
    complete: true,
    outcome: "changes_requested",
    completed_at: at(minute),
    closed_by: null,
    published: {},
  };
}

const point = (minute: number, id = "1-1") =>
  ({ id: `C-${minute}`, story: id, opened_at: at(minute) }) as unknown as CheckpointState;

describe("two identical failures change the method", () => {
  it("says nothing after one failure, or two failures of different causes", () => {
    expect(repeatedCause(story(), "1-1", [])).toBeUndefined();
    const once = story({ attempts: [attempt(1, "failed", "login test times out")] });
    expect(repeatedCause(once, "1-1", [])).toBeUndefined();
    const different = story({
      attempts: [
        attempt(1, "failed", "login test times out"),
        attempt(2, "failed", "the price is rounded the wrong way"),
      ],
    });
    expect(repeatedCause(different, "1-1", [])).toBeUndefined();
  });

  it("tells the tests red twice for the same cause, until a green or a change of method", () => {
    const twice = story({
      attempts: [
        attempt(1, "failed", "login test times out"),
        attempt(2, "failed", "The login test times out again"),
      ],
    });
    expect(repeatedCause(twice, "1-1", [])).toEqual({
      cause: "tests",
      times: 2,
      what: "The login test times out again",
      at: at(2),
    });
    // A green after them ends it.
    const healed = story({ attempts: [...(twice.attempts ?? []), attempt(3, "green")] });
    expect(repeatedCause(healed, "1-1", [])).toBeUndefined();
    // A hypothesis on the cause, or a point of the story for the creator, is the change of method.
    const hypothesis = { ...attempt(3, "started", "7/10 the clock"), kind: "hypothesis" as const };
    const investigated = story({ attempts: [...(twice.attempts ?? []), hypothesis] });
    expect(repeatedCause(investigated, "1-1", [])).toBeUndefined();
    expect(repeatedCause(twice, "1-1", [point(3)])).toBeUndefined();
    // A point of another story, or an older one, changes nothing.
    expect(repeatedCause(twice, "1-1", [point(3, "2-1"), point(0)])?.cause).toBe("tests");
  });

  it("tells a review that comes back on the same point of the same file", () => {
    const back = story({
      review: {
        passes: [
          pass(1, [["Missing test for the empty cart", "src/cart.ts"]]),
          pass(2, [["Missing test for the empty cart", "src/cart.ts"]]),
        ],
      },
    } as unknown as Partial<StoryState>);
    expect(repeatedCause(back, "1-1", [])).toMatchObject({ cause: "review", at: at(2) });
    const elsewhere = story({
      review: {
        passes: [
          pass(1, [["Missing test for the empty cart", "src/cart.ts"]]),
          pass(2, [["Missing test for the empty cart", "src/order.ts"]]),
        ],
      },
    } as unknown as Partial<StoryState>);
    expect(repeatedCause(elsewhere, "1-1", [])).toBeUndefined();
  });

  it("tells the same write refused twice, and counts it again only for the same rule and file", () => {
    let repeat = nextRefusal(undefined, "scope", "package.json", at(1));
    expect(repeat.count).toBe(1);
    repeat = nextRefusal(repeat, "scope", "package.json", at(2));
    expect(repeat).toEqual({ rule: "scope", path: "package.json", count: 2, at: at(2) });
    const refused = story({
      write_guard: { refused: { secret: 0, scope: 2, decision: 0, test: 0 }, doubted: 0, repeat },
    });
    expect(repeatedCause(refused, "1-1", [])).toMatchObject({
      cause: "refused",
      times: 2,
      what: "scope: package.json",
    });
    expect(nextRefusal(repeat, "scope", "src/a.ts", at(3)).count).toBe(1);
  });

  it("tells an agent that hands the story back twice without moving it", () => {
    const still = story();
    const mark = progressMark(still);
    let stall: StallRecord | undefined = nextStall(undefined, "sam", "partial", mark, at(1));
    stall = nextStall(stall, "sam", "partial", mark, at(2));
    expect(stall).toMatchObject({ agent: "sam", count: 2 });
    expect(repeatedCause(story({ stall }), "1-1", [])).toMatchObject({
      cause: "stalled",
      what: "sam",
    });
    // The story moved, another agent, or a complete result: counted anew or gone.
    const moved = progressMark(story({ status: "in_review" }));
    expect(nextStall(stall, "sam", "partial", moved, at(3))?.count).toBe(1);
    expect(nextStall(stall, "quentin", "partial", mark, at(3))?.count).toBe(1);
    expect(nextStall(stall, "sam", "complete", mark, at(3))).toBeUndefined();
    // A progress note or a criterion proven is work done: the story moved.
    const noted = story({ progress: { agent: "sam", percent: 40, note: "x", at: at(5) } });
    expect(progressMark(noted)).not.toBe(mark);
    const proven = story({
      criteria: { "1": { seen: "green" } },
    } as unknown as Partial<StoryState>);
    expect(progressMark(proven)).not.toBe(mark);
  });

  it("stops the loop on the story instead of running the same step a third time", () => {
    const verdict = loopVerdict(
      {
        step: "build",
        you: false,
        agent: "sam",
        story: "1-1",
        checkpoint: null,
        waiting: [],
        change_method: { cause: "tests", times: 2, what: "login test times out" },
      },
      {},
      () => ({
        failed: 0,
        limit: 3,
        exhausted: false,
        open_point: null,
        in_progress: null,
        failures: [],
        hypotheses: { total: 0, ruled_out: [], testing: null, confirmed: null },
      }),
    );
    expect(verdict).toEqual({ verdict: "stop", reason: "attempts", subject: "1-1", waiting: 0 });
  });
});

describe("a merge refused twice for the same cause", () => {
  const refused = (count: number, minute: number, over: Partial<CheckpointState> = {}) =>
    ({
      id: "G-MERGE",
      type: "story",
      source: "merge",
      story: "1-1",
      status: "open",
      opened_at: at(0),
      web_failure_repeat: { key: "MERGE_FAILED:base_dirty", count, at: at(minute) },
      ...over,
    }) as unknown as CheckpointState;

  it("tells the second refusal for the same cause, not the first", () => {
    expect(repeatedCause(story(), "1-1", [refused(1, 5)])).toBeUndefined();
    expect(repeatedCause(story(), "1-1", [refused(2, 6)])).toEqual({
      cause: "merge",
      times: 2,
      what: "MERGE_FAILED:base_dirty",
      at: at(6),
    });
    expect(repeatedCause(story(), "1-1", [refused(5, 9)])?.times).toBe(5);
  });

  it("stops once the point is decided, or the method changed", () => {
    expect(repeatedCause(story(), "1-1", [refused(2, 6, { status: "resolved" })])).toBeUndefined();
    expect(repeatedCause(story(), "2-1", [refused(2, 6)])).toBeUndefined();
    const hypothesis = {
      ...attempt(7, "started", "7/10 dirty files"),
      kind: "hypothesis" as const,
    };
    expect(
      repeatedCause(story({ attempts: [hypothesis] }), "1-1", [refused(2, 6)]),
    ).toBeUndefined();
  });
});
