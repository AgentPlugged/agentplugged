import { describe, expect, it } from "vitest";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { reasonHolds, settledPoints, settledReason } from "./settled-rules.js";

/** A checkpoint of the projection, reduced to what the rules read. */
function point(id: string, fields: Record<string, unknown> = {}): CheckpointState {
  return {
    id,
    type: "story",
    status: "open",
    story: "1-1",
    source: null,
    request: null,
    blocks: [],
    creator_action: null,
    opened_event: `E-${id}`,
    opened_at: "2026-10-05T10:00:00.000Z",
    ...fields,
  } as unknown as CheckpointState;
}

const state = (checkpoints: CheckpointState[], story: Record<string, unknown> = {}) => ({
  stories: { "1-1": { started: {}, ...story } },
  checkpoints: Object.fromEntries(checkpoints.map((checkpoint) => [checkpoint.id, checkpoint])),
});

describe("the points whose object is settled", () => {
  it("settles every point the engine opened about a story once it is merged", () => {
    const merged = { merged: { at: "2026-10-05T12:00:00.000Z" } };
    const points = [
      point("A", { source: "merge" }),
      point("B", { source: "merge_conflict", type: "decision" }),
      point("C", { type: "creator_action" }),
      point("D", { type: "permission", source: "untrusted_action" }),
      // A document that merely names the story is not about its merge.
      point("E", { type: "document" }),
      // Another story's point stays.
      point("F", { story: "2-1" }),
      // Already answered: nothing to close.
      point("G", { source: "review_loop", type: "decision", status: "resolved" }),
    ];
    expect(
      settledPoints(state(points, merged)).map((entry) => [entry.checkpoint, entry.reason]),
    ).toEqual([
      ["A", "story_merged"],
      ["B", "story_merged"],
      ["C", "story_merged"],
      ["D", "story_merged"],
    ]);
    // Not merged: nothing is settled.
    expect(settledPoints(state(points))).toEqual([]);
  });

  it("settles a blocked or looping review point once the review was done again after it", () => {
    const pass = (completedAt: string, outcome: string) => ({
      review: { passes: [{ complete: true, completed_at: completedAt, outcome }] },
    });
    const blocked = point("A", { source: "blocked_result" });
    const loop = point("B", { source: "review_loop", type: "decision" });
    const redone = state([blocked, loop], pass("2026-10-05T11:00:00.000Z", "approved"));
    expect(settledPoints(redone).map((entry) => [entry.checkpoint, entry.reason])).toEqual([
      ["A", "review_redone"],
      ["B", "review_redone"],
    ]);
    // A pass closed before the point opened settles nothing; a loop needs an approval.
    expect(settledPoints(state([blocked], pass("2026-10-05T09:00:00.000Z", "approved")))).toEqual(
      [],
    );
    expect(
      settledPoints(
        state([blocked, loop], pass("2026-10-05T11:00:00.000Z", "changes_requested")),
      ).map((entry) => entry.checkpoint),
    ).toEqual(["A"]);
  });

  it("settles an older request a newer one replaces, and says which", () => {
    const request = (digest: string) => ({
      source: "untrusted_action",
      type: "permission",
      request: { action: "install_dependency", detail: "npm install", digest, sessions: ["s"] },
    });
    const older = point("A", request("d1"));
    const newer = point("B", request("d1"));
    const other = point("C", request("d2"));
    expect(settledPoints(state([older, newer, other]))).toEqual([
      { checkpoint: "A", reason: "replaced", ref: "B" },
    ]);
    const action = (reason: string, kind = "ci_waive") => ({
      type: "creator_action",
      creator_action: { kind, story: "1-1", commit: "a".repeat(40), reason },
    });
    expect(
      settledPoints(state([point("X", action("first")), point("Y", action("second"))])),
    ).toEqual([{ checkpoint: "X", reason: "replaced", ref: "Y" }]);
    // Another action is another request.
    expect(
      settledPoints(state([point("X", action("a")), point("Y", action("a", "deferred_drop"))])),
    ).toEqual([]);
  });

  it("holds a reason only when the journal shows it", () => {
    const open = point("A", { source: "merge" });
    const merged = state([open], { merged: {} });
    expect(reasonHolds(merged, open, "story_merged")).toBe(true);
    expect(reasonHolds(state([open]), open, "story_merged")).toBe(false);
    expect(reasonHolds(merged, open, "review_redone")).toBe(false);
    expect(reasonHolds(merged, open, "replaced")).toBe(false);
    expect(reasonHolds(merged, open, "replaced", "Z")).toBe(false);
    expect(settledReason(state([open]), open)).toBeUndefined();
  });
});

describe("the permission points nobody can answer any more", () => {
  const permission = (id: string, fields: Record<string, unknown> = {}) =>
    point(id, {
      type: "permission",
      source: "untrusted_action",
      request: { action: "install_dependency", detail: "npm ci", digest: id, sessions: ["s"] },
      ...fields,
    });
  const DAY = 24 * 60 * 60 * 1000;
  const opened = Date.parse("2026-10-05T10:00:00.000Z");

  it("settles the point of a story whose working copy is gone, when the engine read the disk", () => {
    const points = [permission("A"), permission("B", { story: "2-1" })];
    const two = {
      stories: { "1-1": { started: {} }, "2-1": { started: {} } },
      checkpoints: Object.fromEntries(points.map((entry) => [entry.id, entry])),
    };
    // Gone for 1-1 only: the other working copy is still there.
    expect(
      settledPoints(two, { now: opened, gone: (story) => story === "1-1" }).map((entry) => [
        entry.checkpoint,
        entry.reason,
      ]),
    ).toEqual([["A", "worktree_gone"]]);
    // Without a reading of the disk, nothing is closed on a doubt.
    expect(settledPoints(two, { now: opened })).toEqual([]);
    // A merged story is closed for its merge, as before.
    expect(
      settledPoints(state([permission("A")], { merged: {} }), { now: opened, gone: () => true }),
    ).toEqual([{ checkpoint: "A", reason: "story_merged" }]);
    // A point that is not a permission is not about a working copy.
    expect(settledPoints(state([point("D", { type: "decision" })]), { gone: () => true })).toEqual(
      [],
    );
  });

  it("settles the point of a permission that blocks nothing once it waited a day", () => {
    const orphan = permission("A", { story: null });
    const nothing = { stories: {}, checkpoints: { A: orphan } };
    expect(settledPoints(nothing, { now: opened + DAY - 1 })).toEqual([]);
    expect(settledPoints(nothing, { now: opened + DAY })).toEqual([
      { checkpoint: "A", reason: "lapsed" },
    ]);
    // Without a clock, never.
    expect(settledPoints(nothing)).toEqual([]);
    // A story that is running keeps its permission: it is waited for.
    expect(settledPoints(state([permission("B")]), { now: opened + 10 * DAY })).toEqual([]);
    expect(reasonHolds(nothing, orphan, "lapsed", undefined, { now: opened + DAY })).toBe(true);
    expect(reasonHolds(nothing, orphan, "lapsed")).toBe(false);
  });
});

describe("the review's corrections", () => {
  const DAY = 24 * 60 * 60 * 1000;
  it("keeps a permission that blocks an action, however long it waits", () => {
    const blocking = point("A", {
      type: "permission",
      story: null,
      blocks: [{ action: "story.review", story: "1-1" }],
    });
    expect(
      settledPoints(
        { stories: {}, checkpoints: { A: blocking } },
        { now: Date.parse(blocking.opened_at) + 9 * DAY },
      ),
    ).toEqual([]);
  });
});
