import { describe, expect, it } from "vitest";
import { CHECKPOINT_SOURCES } from "./checkpoint.js";
import { ErrorCode } from "./error-payload.js";
import { EVENT_TYPE_REGISTRY } from "./event-types.js";
import {
  FindingIdInputSchema,
  findingIdOf,
  REVIEW_EVENT_TYPES,
  reviewIdOf,
  StoryReviewedPayloadSchema,
  StoryReviewTriagedPayloadSchema,
  SubmitReviewInputSchema,
  TriageReviewInputSchema,
} from "./review.js";

const COMMIT = "a".repeat(40);
const reviewed = {
  kind: "qa",
  commit: COMMIT,
  summary: "Two criteria checked.",
  findings: [
    { severity: "blocking", title: "No test for the empty cart", path: "src/cart.ts", line: 4 },
  ],
  verdict: "fail",
  security: { reasons: ["paths"] },
};

describe("The independent review", () => {
  it("registers its three event types at version 1", () => {
    for (const type of Object.values(REVIEW_EVENT_TYPES)) {
      expect(EVENT_TYPE_REGISTRY[type]?.version, type).toBe(1);
    }
  });

  it("accepts a review and refuses a line without a path, a path out of the repository, a control character", () => {
    expect(StoryReviewedPayloadSchema.safeParse(reviewed).success).toBe(true);
    const finding = (extra: Record<string, unknown>) => ({
      ...reviewed,
      findings: [{ severity: "minor", title: "x", ...extra }],
    });
    expect(StoryReviewedPayloadSchema.safeParse(finding({ line: 3 })).success).toBe(false);
    expect(StoryReviewedPayloadSchema.safeParse(finding({ path: "../etc/passwd" })).success).toBe(
      false,
    );
    expect(StoryReviewedPayloadSchema.safeParse(finding({ path: "/etc/passwd" })).success).toBe(
      false,
    );
    expect(StoryReviewedPayloadSchema.safeParse(finding({ title: "a\u0007b" })).success).toBe(
      false,
    );
    expect(
      StoryReviewedPayloadSchema.safeParse({
        ...reviewed,
        security: { reasons: ["paths", "paths"] },
      }).success,
    ).toBe(false);
  });

  it("never takes a verdict from the agent, and a security ask only from the QA review", () => {
    const input = {
      agent: "quentin",
      story: "1-1",
      kind: "qa",
      commit: COMMIT,
      summary: "ok",
      findings: [],
    };
    expect(SubmitReviewInputSchema.safeParse(input).success).toBe(true);
    expect(SubmitReviewInputSchema.safeParse({ ...input, verdict: "pass" }).success).toBe(false);
    expect(
      SubmitReviewInputSchema.safeParse({ ...input, kind: "security", security: true }).success,
    ).toBe(false);
  });

  it("sorts each finding once, a reason for a rejection, an item for a deferral", () => {
    const finding = findingIdOf("01JZZZZZZZZZZZZZZZZZZZZZZZ", 2);
    expect(finding).toBe(`${reviewIdOf("01JZZZZZZZZZZZZZZZZZZZZZZZ")}-2`);
    expect(FindingIdInputSchema.parse(` ${finding.toLowerCase()} `)).toBe(finding);
    const item = { finding, decision: "fix", root_cause: "Missing input checks" };
    expect(StoryReviewTriagedPayloadSchema.safeParse({ items: [item] }).success).toBe(true);
    expect(StoryReviewTriagedPayloadSchema.safeParse({ items: [item, item] }).success).toBe(false);
    expect(
      StoryReviewTriagedPayloadSchema.safeParse({ items: [{ ...item, decision: "reject" }] })
        .success,
    ).toBe(false);
    expect(
      StoryReviewTriagedPayloadSchema.safeParse({ items: [{ ...item, decision: "defer" }] })
        .success,
    ).toBe(false);
    expect(
      TriageReviewInputSchema.safeParse({
        agent: "sam",
        story: "1-1",
        items: [{ ...item, decision: "defer", deferred: "d-0123456789" }],
      }).success,
    ).toBe(true);
    expect(
      StoryReviewTriagedPayloadSchema.safeParse({
        items: [{ ...item, deferred: "D-0123456789" }],
      }).success,
    ).toBe(false);
  });

  it("adds its code at the end of the shared list and its checkpoint sources", () => {
    expect(Object.values(ErrorCode).at(-12)).toBe("REVIEW_NOT_POSSIBLE");
    expect(CHECKPOINT_SOURCES.slice(-5)).toEqual([
      "merge",
      "review_loop",
      "fast_track",
      "merge_conflict",
      "attempt_limit",
    ]);
  });
});
