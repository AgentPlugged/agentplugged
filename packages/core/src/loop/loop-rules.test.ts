import {
  CHECKPOINT_TYPES,
  LOOP_MAX_ATTEMPTS,
  LOOP_MAX_RECORDED,
  LOOP_STOP_REASONS,
} from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import type { NextStep } from "../next/next.js";
import { answer, checkpointState } from "../testing/checkpoint-state.js";
import {
  type AttemptRecord,
  attemptLimitCheckpoint,
  attemptsView,
  hypothesisProblem,
  keptAttempts,
  LOOP_STEPS,
  loopVerdict,
  parseHypothesis,
  ruledOutLines,
  sameApproach,
  sameStop,
  stopReasonOf,
  triedLines,
  tryProblem,
} from "./loop-rules.js";

/**
 * The rules of the bounded loop: the story that comes next, the stop at each kind
 * of point of the creator's, the attempts and the approaches that never come back. Pure.
 */

const record = (
  n: number,
  approach: string,
  result: AttemptRecord["result"],
  note?: string,
): AttemptRecord => ({
  approach,
  result,
  ...(note === undefined ? {} : { note }),
  at: `2026-10-13T10:0${n}:00.000Z`,
  event: `01JZ00000000000000000000${n.toString().padStart(2, "0")}`,
});

const failed = (n: number, approach: string) => record(n, approach, "failed", "test red");

describe("the same approach is never tried twice", () => {
  it("knows an approach again whatever its order, its case or its accents", () => {
    expect(sameApproach("cache the cart total in memory", "In memory, cache the cart total")).toBe(
      true,
    );
    expect(
      sameApproach("Réécrire le panier avec un cache", "reecrire le panier avec un CACHE"),
    ).toBe(true);
  });

  it("tells two different approaches apart, even on the same subject", () => {
    expect(
      sameApproach("cache the cart total in memory", "compute the total on each request"),
    ).toBe(false);
    expect(
      sameApproach("add a retry around the payment call", "add a timeout around the payment call"),
    ).toBe(false);
  });

  it("knows a plural, and an approach with one word added or taken away, again", () => {
    expect(sameApproach("add the tests for the cart", "add the test for the cart")).toBe(true);
    expect(sameApproach("cache the cart total", "cache the cart total with a ttl")).toBe(true);
    expect(sameApproach("cache the cart total in memory", "cache the cart total")).toBe(true);
    // Another way of doing it, on the same subject, is not the same approach.
    expect(sameApproach("cache the cart total", "split the cart in two services")).toBe(false);
  });

  it("compares the whole text when no word is left to compare", () => {
    expect(sameApproach("a b", "A B")).toBe(true);
    expect(sameApproach("a b", "c d")).toBe(false);
  });
});

describe("the attempts of a story", () => {
  it("counts the approaches that failed, and not the one in progress nor the one that went green", () => {
    const view = attemptsView(
      [failed(1, "first way"), record(2, "second way", "started")],
      [],
      "1-3",
    );
    expect(view).toMatchObject({ failed: 1, exhausted: false, in_progress: "second way" });
    expect(
      attemptsView([record(1, "way", "started"), record(2, "way", "green")], [], "1-3"),
    ).toMatchObject({
      failed: 0,
      in_progress: null,
    });
  });

  it("reaches the limit at the third failed approach and refuses a fourth", () => {
    const records = ["alpha way", "beta route", "gamma path"].flatMap((approach, i) => [
      record(i * 2 + 1, approach, "started"),
      failed(i * 2 + 2, approach),
    ]);
    const view = attemptsView(records, [], "1-3");
    expect(view).toMatchObject({ failed: LOOP_MAX_ATTEMPTS, exhausted: true });
    expect(tryProblem(view, "delta idea")).toBe("attempts_exhausted");
  });

  it("refuses an approach that failed, and one started before the last is reported", () => {
    const view = attemptsView([failed(1, "cache the total in memory")], [], "1-3");
    expect(tryProblem(view, "Cache the total, in memory")).toBe("approach_failed");
    expect(tryProblem(view, "recompute the total at checkout")).toBeUndefined();
    const open = attemptsView([record(1, "some way", "started")], [], "1-3");
    expect(tryProblem(open, "another way altogether")).toBe("attempt_open");
  });

  it("gives a new round only when the creator approves the point, and never forgets a failure", () => {
    const records = ["alpha way", "beta route", "gamma path"].map((approach, i) =>
      failed(i + 1, approach),
    );
    const asked = checkpointState("G-LIMIT00001", {
      story: "1-3",
      source: "attempt_limit",
      type: "permission",
    });
    // Open: still stopped.
    expect(attemptsView(records, [asked], "1-3")).toMatchObject({
      exhausted: true,
      open_point: "G-LIMIT00001",
    });
    // Refused: still stopped.
    const refused = checkpointState("G-LIMIT00001", {
      story: "1-3",
      source: "attempt_limit",
      status: "resolved",
      resolution: answer("rejected", "2026-10-13T11:00:00.000Z", {
        event: "01JZ0000000000000000009000",
      }),
    });
    expect(attemptsView(records, [refused], "1-3").exhausted).toBe(true);
    // Approved: a new round of three, the approaches that failed staying failed.
    const approved = checkpointState("G-LIMIT00001", {
      story: "1-3",
      source: "attempt_limit",
      status: "resolved",
      resolution: answer("approved", "2026-10-13T11:00:00.000Z", {
        event: "01JZ0000000000000000009000",
      }),
    });
    const round = attemptsView(records, [approved], "1-3");
    expect(round).toMatchObject({ failed: 0, exhausted: false, open_point: null });
    expect(tryProblem(round, "alpha way")).toBe("approach_failed");
    // The point of another story does not count.
    expect(attemptsView(records, [{ ...approved, story: "9-9" }], "1-3").exhausted).toBe(true);
  });

  it("gives a new round for an approval with reservations too, and never for a refusal", () => {
    const records = ["alpha way", "beta route", "gamma path"].map((a, i) => failed(i + 1, a));
    const answered = (decision: Parameters<typeof answer>[0]) =>
      checkpointState("G-LIMIT00001", {
        story: "1-3",
        source: "attempt_limit",
        status: "resolved",
        resolution: answer(decision, "2026-10-13T11:00:00.000Z", {
          event: "01JZ0000000000000000009000",
        }),
      });
    for (const decision of ["approved", "approved_with_reservations"] as const) {
      expect(attemptsView(records, [answered(decision)], "1-3").exhausted, decision).toBe(false);
    }
    for (const decision of ["rejected", "changes_requested"] as const) {
      expect(attemptsView(records, [answered(decision)], "1-3").exhausted, decision).toBe(true);
    }
  });

  it("forgets what is of no use before the approaches that failed, and never the latest record", () => {
    const records: AttemptRecord[] = Array.from({ length: 45 }, (_, i) =>
      record(i % 10, `way number ${i}`, i % 3 === 0 ? "failed" : i % 3 === 1 ? "started" : "green"),
    );
    const kept = keptAttempts(records);
    expect(kept).toHaveLength(40);
    expect(kept.at(-1)?.approach).toBe("way number 44");
    // Every approach that failed is still there: 15 of them, none lost for 5 started or green.
    expect(kept.filter((entry) => entry.result === "failed")).toHaveLength(15);
    // And with nothing but failures, the oldest go.
    const only = Array.from({ length: 45 }, (_, i) => failed(i % 10, `way number ${i}`));
    expect(keptAttempts(only)[0]?.approach).toBe("way number 5");
  });

  it("keeps the latest records and names the last three failures, the latest first", () => {
    const many = Array.from({ length: 50 }, (_, i) => failed(i % 10, `way number ${i}`));
    expect(keptAttempts(many)).toHaveLength(40);
    expect(keptAttempts(many).at(-1)?.approach).toBe("way number 49");
    const view = attemptsView(many.slice(0, 5), [], "1-3");
    expect(triedLines(view)).toEqual(["way number 4", "way number 3", "way number 2"]);
  });

  it("opens a point for the creator that blocks the review and the completion of the story", () => {
    const payload = attemptLimitCheckpoint("1-3", [
      failed(1, "alpha way"),
      failed(2, "beta route"),
      failed(3, "gamma path"),
    ]);
    expect(payload).toMatchObject({
      type: "permission",
      source: "attempt_limit",
      blocks: [
        { action: "story.review", story: "1-3" },
        { action: "story.complete", story: "1-3" },
      ],
    });
    expect(payload.summary).toContain("alpha way");
    expect(payload.summary.length).toBeLessThanOrEqual(2000);
  });
});

describe("the loop stops at each point that is the creator's", () => {
  const point = (overrides: Parameters<typeof checkpointState>[1]) =>
    stopReasonOf(checkpointState("G-POINT00001", overrides));

  it("reads what the point asks of the creator", () => {
    expect(point({ type: "document" })).toBe("validation");
    expect(point({ type: "phase_end", phase: "design" })).toBe("validation");
    expect(point({ type: "memory" })).toBe("validation");
    expect(point({ type: "decision" })).toBe("decision");
    expect(point({ type: "story", story: "1-3", source: "merge" })).toBe("merge");
    expect(point({ type: "decision", title: "Budget exceeded: 1-3" })).toBe("spend");
    expect(point({ type: "release" })).toBe("irreversible");
    expect(point({ type: "publication" })).toBe("irreversible");
    expect(point({ type: "decision", irreversible: true })).toBe("irreversible");
    expect(point({ type: "permission" })).toBe("command");
    expect(point({ type: "story", source: "untrusted_action" })).toBe("command");
    expect(point({ type: "decision", title: "Gap on ENF-3" })).toBe("gap");
    expect(point({ type: "permission", story: "1-3", source: "attempt_limit" })).toBe("attempts");
  });

  it("reads an action of the creator's: a command to accept, an action that cannot be undone", () => {
    const action = (kind: string) =>
      point({
        type: "creator_action",
        creator_action: { kind } as unknown as NonNullable<
          Parameters<typeof checkpointState>[1]
        >["creator_action"],
      });
    expect(action("proof_commands")).toBe("command");
    expect(action("environment_fix")).toBe("command");
    expect(action("forge_push_main")).toBe("irreversible");
    expect(action("deferred_drop")).toBe("irreversible");
    expect(action("release")).toBe("irreversible");
    expect(action("profile")).toBe("decision");
  });

  it("knows a spend by the budget that named the point, and what holds a deploy back as irreversible", () => {
    const budget = checkpointState("G-BUDGET0001", { type: "decision", title: "Over the ceiling" });
    expect(stopReasonOf(budget)).toBe("decision");
    expect(stopReasonOf(budget, new Set(["G-BUDGET0001"]))).toBe("spend");
    expect(
      point({
        type: "decision",
        blocks: [{ action: "release.deploy" }, { action: "story.review" }],
      }),
    ).toBe("irreversible");
    expect(point({ type: "decision", blocks: [{ action: "publication.publish" }] })).toBe(
      "irreversible",
    );
    expect(point({ type: "decision", blocks: [{ action: "permission.use" }] })).toBe("command");
  });

  it("gives every type of point a reason the loop knows", () => {
    for (const type of CHECKPOINT_TYPES) {
      expect(LOOP_STOP_REASONS, type).toContain(
        stopReasonOf(checkpointState("G-POINT00001", { type })),
      );
    }
  });
});

describe("what comes next", () => {
  const next = (
    overrides: Omit<Partial<NextStep>, "decisions"> & { decisions?: Array<{ id: string }> },
  ) =>
    ({
      step: "build",
      you: false,
      agent: "sam",
      story: "1-3",
      checkpoint: null,
      waiting: [],
      ...overrides,
    }) as unknown as Parameters<typeof loopVerdict>[0];
  const noAttempts = () => attemptsView([], [], "1-3");
  const none = {};

  it("runs the step of the story that is ready, with the agent that owns it", () => {
    expect(loopVerdict(next({}), none, noAttempts)).toEqual({
      verdict: "run",
      step: "build",
      agent: "sam",
      story: "1-3",
      waiting: 0,
    });
  });

  it("goes on with work that does not need the points that wait, and counts them", () => {
    const waiting = [{ id: "G-POINT00001" }, { id: "G-POINT00002" }];
    expect(
      loopVerdict(next({ independent: true, decisions: waiting }), none, noAttempts),
    ).toMatchObject({
      verdict: "run",
      waiting: 2,
    });
  });

  it("stops at any point that waits for the creator, unless next calls the work independent of it", () => {
    const decision = checkpointState("G-POINT00001", { type: "decision" });
    const waiting = [{ id: "G-POINT00001" }];
    expect(
      loopVerdict(next({ decisions: waiting }), { "G-POINT00001": decision }, noAttempts),
    ).toEqual({ verdict: "stop", reason: "decision", subject: "G-POINT00001", waiting: 1 });
    expect(
      loopVerdict(
        next({ decisions: waiting, independent: true }),
        { "G-POINT00001": decision },
        noAttempts,
      ),
    ).toMatchObject({ verdict: "run", waiting: 1 });
  });

  it("never lets an agent decide a spend, an irreversible action or a command in the loop, whatever was delegated", () => {
    const delegated = (type: "release" | "publication" | "permission" | "decision", title = "x") =>
      checkpointState("G-DELEG00001", { type, title });
    const decided = (point: ReturnType<typeof delegated>) =>
      loopVerdict(
        next({ step: "point_decision", agent: "quentin", story: null, checkpoint: point.id }),
        { [point.id]: point },
        noAttempts,
      );
    expect(decided(delegated("release"))).toMatchObject({
      verdict: "stop",
      reason: "irreversible",
    });
    expect(decided(delegated("publication"))).toMatchObject({
      verdict: "stop",
      reason: "irreversible",
    });
    expect(decided(delegated("decision", "Budget exceeded: 1-3"))).toMatchObject({
      verdict: "stop",
      reason: "spend",
      subject: "G-DELEG00001",
    });
    expect(decided(delegated("permission"))).toMatchObject({ verdict: "stop", reason: "command" });
    // A budget's point is a spend whatever its title, delegated or not.
    const budget = delegated("decision", "Over the ceiling");
    expect(
      loopVerdict(
        next({ step: "point_decision", agent: "quentin", story: null, checkpoint: budget.id }),
        { [budget.id]: budget },
        noAttempts,
        new Set([budget.id]),
      ),
    ).toMatchObject({ verdict: "stop", reason: "spend", subject: budget.id });
    // A point of the ordinary kind (a document, a merge the creator left to the agents) goes on.
    expect(decided(delegated("decision"))).toMatchObject({
      verdict: "run",
      step: "point_decision",
    });
    const merge = checkpointState("G-MERGE00002", { type: "story", story: "1-3", source: "merge" });
    expect(
      loopVerdict(
        next({ step: "point_decision", agent: "quentin", story: "1-3", checkpoint: merge.id }),
        { [merge.id]: merge },
        noAttempts,
      ),
    ).toMatchObject({ verdict: "run", step: "point_decision" });
  });

  it("stops at the creator's step, with the reason of the point it names", () => {
    const merge = checkpointState("G-MERGE00001", { type: "story", story: "1-3", source: "merge" });
    const verdict = loopVerdict(
      next({
        step: "validation",
        you: true,
        agent: null,
        checkpoint: "G-MERGE00001",
        decisions: [{ id: "G-MERGE00001" }],
      }),
      { "G-MERGE00001": merge },
      noAttempts,
    );
    expect(verdict).toEqual({
      verdict: "stop",
      reason: "merge",
      subject: "G-MERGE00001",
      waiting: 1,
    });
  });

  it("stops when nothing independent is left, at the first point to present", () => {
    const spend = checkpointState("G-SPEND00001", {
      type: "decision",
      title: "Budget exceeded: 1-3",
    });
    const verdict = loopVerdict(
      next({
        step: "validation",
        you: true,
        stop: true,
        agent: null,
        story: null,
        checkpoint: null,
        decisions: [{ id: "G-SPEND00001" }],
      }),
      { "G-SPEND00001": spend },
      noAttempts,
    );
    expect(verdict).toMatchObject({ verdict: "stop", reason: "spend", subject: "G-SPEND00001" });
  });

  it("stops at a step that is the creator's with no point behind it", () => {
    expect(
      loopVerdict(
        next({ step: "key_endorsement", you: true, agent: null, story: null }),
        none,
        noAttempts,
      ),
    ).toEqual({ verdict: "stop", reason: "creator_step", subject: "key_endorsement", waiting: 0 });
  });

  it("is done when nothing is left and nothing waits, and stops when something waits", () => {
    expect(loopVerdict(next({ step: "none", agent: null, story: null }), none, noAttempts)).toEqual(
      {
        verdict: "done",
      },
    );
    const open = checkpointState("G-OPEN0000001", { type: "document" });
    expect(
      loopVerdict(
        next({
          step: "none",
          agent: null,
          story: null,
          waiting: [{ id: "G-OPEN0000001" }] as never,
        }),
        { "G-OPEN0000001": open },
        noAttempts,
      ),
    ).toMatchObject({ verdict: "stop", reason: "validation", subject: "G-OPEN0000001" });
  });

  it("stops at a blocked story and at work that is not the stories' (framing, design, delivery, launch)", () => {
    expect(loopVerdict(next({ step: "story_blocked" }), none, noAttempts)).toMatchObject({
      verdict: "stop",
      reason: "blocked",
      subject: "1-3",
    });
    for (const step of [
      "framing",
      "planning",
      "design",
      "breakdown",
      "delivery",
      "launch",
      "sync",
      "phase_end",
      "spec",
    ] as const) {
      expect(
        loopVerdict(next({ step, agent: "maya", story: null }), none, noAttempts),
        step,
      ).toMatchObject({
        verdict: "stop",
        reason: "outside",
        subject: step,
      });
    }
    // Only the work of the stories under way, and what follows it, runs without the creator.
    for (const step of LOOP_STEPS) {
      expect(loopVerdict(next({ step }), none, noAttempts).verdict, step).toBe("run");
    }
  });

  it("never runs the story whose approaches failed up to the limit, until the creator lifts it", () => {
    const records = ["alpha way", "beta route", "gamma path"].map((a, i) => failed(i + 1, a));
    const asked = checkpointState("G-LIMIT00001", {
      story: "1-3",
      source: "attempt_limit",
      type: "permission",
    });
    const attemptsOf = (story: string) => attemptsView(records, [asked], story);
    expect(loopVerdict(next({}), { "G-LIMIT00001": asked }, attemptsOf)).toEqual({
      verdict: "stop",
      reason: "attempts",
      subject: "G-LIMIT00001",
      waiting: 0,
    });
    // Another story goes on.
    expect(
      loopVerdict(next({ story: "1-4" }), { "G-LIMIT00001": asked }, () =>
        attemptsView([], [], "1-4"),
      ).verdict,
    ).toBe("run");
  });
});

describe("a stop is written once", () => {
  it("is the same stop for the same reason and the same subject", () => {
    const state = {
      stopped: { reason: "merge" as const, subject: "G-MERGE00001", at: "", event: "" },
    };
    expect(sameStop(state, "merge", "G-MERGE00001")).toBe(true);
    expect(sameStop(state, "merge", "G-MERGE00002")).toBe(false);
    expect(sameStop(state, "spend", "G-MERGE00001")).toBe(false);
    expect(sameStop({ stopped: null }, "merge", "G-MERGE00001")).toBe(false);
    expect(sameStop(undefined, "done", null)).toBe(false);
  });
});

describe("the hypotheses of a bug's cause", () => {
  const hypothesis = (
    n: number,
    approach: string,
    result: AttemptRecord["result"],
    note?: string,
  ): AttemptRecord => ({ ...record(n, approach, result, note), kind: "hypothesis", confidence: 6 });

  it("reads a confidence from 1 to 10 and the statement, and nothing else", () => {
    expect(parseHypothesis("7/10 the cache is stale")).toEqual({
      confidence: 7,
      statement: "the cache is stale",
    });
    expect(parseHypothesis(" 10 / 10 : the cache is stale")?.confidence).toBe(10);
    for (const bad of [
      undefined,
      "the cache is stale",
      "0/10 x y",
      "11/10 x y",
      "7/10",
      "7/10   ",
    ]) {
      expect(parseHypothesis(bad), String(bad)).toBeUndefined();
    }
  });

  it("keeps them apart from the approaches: they never count as a failed fix", () => {
    const view = attemptsView(
      [
        hypothesis(1, "the cache is stale", "failed", "passes with the cache off"),
        hypothesis(2, "the tax rounds twice", "failed", "one cent off is not the tax"),
        hypothesis(3, "the refund is lost", "failed", "refund is stored"),
        hypothesis(4, "the coupon applies twice", "started"),
      ],
      [],
      "1-3",
    );
    expect(view.failed).toBe(0);
    expect(view.failures).toEqual([]);
    expect(view.in_progress).toBeNull();
    expect(view.hypotheses.ruled_out).toHaveLength(3);
    expect(view.hypotheses.testing?.approach).toBe("the coupon applies twice");
    expect(ruledOutLines(view)).toEqual([
      "the refund is lost",
      "the tax rounds twice",
      "the cache is stale",
    ]);
  });

  it("refuses a hypothesis ruled out, one under test, and a fix before the cause is confirmed", () => {
    const ruledOut = attemptsView(
      [hypothesis(1, "the cache is stale", "failed", "x y")],
      [],
      "1-3",
    );
    expect(hypothesisProblem(ruledOut, "6/10 Stale, the cache is")).toBe("hypothesis_ruled_out");
    expect(hypothesisProblem(ruledOut, "6/10 the tax rounds twice")).toBeUndefined();
    expect(hypothesisProblem(ruledOut, "the tax rounds twice")).toBe("confidence_missing");
    expect(tryProblem(ruledOut, "round once")).toBe("cause_unconfirmed");
    const testing = attemptsView([hypothesis(1, "the cache is stale", "started")], [], "1-3");
    expect(hypothesisProblem(testing, "6/10 the tax rounds twice")).toBe("hypothesis_open");
    const confirmed = attemptsView(
      [hypothesis(1, "the cache is stale", "green", "proved")],
      [],
      "1-3",
    );
    expect(tryProblem(confirmed, "round once")).toBeUndefined();
    // A story with no hypothesis is as before.
    expect(tryProblem(attemptsView([], [], "1-3"), "round once")).toBeUndefined();
  });

  it("is the latest hypothesis that decides: a new one after a confirmed cause takes its place", () => {
    const view = attemptsView(
      [
        hypothesis(1, "the cache is stale", "green", "proved"),
        hypothesis(2, "the tax rounds twice", "started"),
      ],
      [],
      "1-3",
    );
    expect(view.hypotheses.confirmed).toBeNull();
    expect(tryProblem(view, "round once")).toBe("cause_unconfirmed");
  });

  it("drops the hypotheses last when the journal keeps too many records", () => {
    const records = [
      hypothesis(1, "the cache is stale", "failed", "x y"),
      ...Array.from({ length: LOOP_MAX_RECORDED + 5 }, (_, i) =>
        record(2, `green ${i} approach`, "green"),
      ),
    ];
    const kept = keptAttempts(records);
    expect(kept).toHaveLength(LOOP_MAX_RECORDED);
    expect(kept.some((r) => r.kind === "hypothesis")).toBe(true);
  });

  it("never lets a long search wipe out the fixes that failed: the count that asks the creator", () => {
    // 22 hypotheses (a start and an end each) after 2 failed fixes, past the 40 records kept.
    const flood = Array.from({ length: 22 }, (_, i) => [
      hypothesis(2, `cause number ${i} of the bug`, "started"),
      hypothesis(2, `cause number ${i} of the bug`, "failed", "ruled out"),
    ]).flat();
    const kept = keptAttempts([failed(1, "first fix"), failed(1, "second fix"), ...flood]);
    expect(kept.length).toBeLessThanOrEqual(LOOP_MAX_RECORDED);
    expect(kept.filter((r) => r.kind === undefined && r.result === "failed")).toHaveLength(2);
    // The ends of the causes ruled out stay, the starts they follow go first.
    expect(
      kept.filter((r) => r.kind === "hypothesis" && r.result === "started").length,
    ).toBeLessThan(22);
    expect(kept.at(-1)?.approach).toBe("cause number 21 of the bug");
  });

  it("puts no hypothesis forward while a fix is under way", () => {
    const view = attemptsView([record(1, "round once", "started")], [], "1-3");
    expect(hypothesisProblem(view, "6/10 the tax rounds twice")).toBe("attempt_open");
  });
});
