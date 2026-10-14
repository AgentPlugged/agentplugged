import { describe, expect, it } from "vitest";
import {
  MAX_MUTATION_SECONDS,
  MAX_MUTATIONS,
  ReviewTestsInputSchema,
  TEST_CRITERIA,
  TEST_ROWS,
  TestGridSchema,
  TestsReviewedPayloadSchema,
} from "./test-quality.js";

/** The fixed forms of the review of the tests. */

describe("the grid", () => {
  it("has fixed rows, each under one criterion of the grid, with a weight of its own", () => {
    expect(new Set(TEST_ROWS.map((row) => row.id)).size).toBe(TEST_ROWS.length);
    for (const row of TEST_ROWS) {
      expect(TEST_CRITERIA).toContain(row.criterion);
      expect(["critical", "high", "medium", "low"]).toContain(row.severity);
    }
  });

  it("refuses a row that does not exist, an unknown field and a mark the reviewer wrote", () => {
    const base = {
      reads: ["src/a.test.ts"],
      criteria: [{ criterion: "active", verdict: "ok" }],
      findings: [],
    };
    expect(TestGridSchema.safeParse(base).success).toBe(true);
    expect(
      TestGridSchema.safeParse({
        ...base,
        findings: [{ criterion: "active", row: "made_up", test: "a.test.ts:1", reason: "because" }],
      }).success,
    ).toBe(false);
    expect(TestGridSchema.safeParse({ ...base, score: 100 }).success).toBe(false);
    expect(
      TestGridSchema.safeParse({
        ...base,
        findings: [
          {
            criterion: "active",
            row: "skipped",
            test: "a.test.ts:1",
            reason: "x",
            severity: "low",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("keeps a path relative and a line free of control characters", () => {
    expect(
      TestGridSchema.safeParse({ reads: ["/etc/passwd"], criteria: [], findings: [] }).success,
    ).toBe(false);
    expect(
      TestGridSchema.safeParse({ reads: ["../x.test.ts"], criteria: [], findings: [] }).success,
    ).toBe(false);
    expect(
      TestGridSchema.safeParse({
        reads: ["a.test.ts"],
        criteria: [],
        findings: [
          { criterion: "active", row: "skipped", test: "a.test.ts:1", reason: "bad\u0007bell" },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("the request", () => {
  const ask = (extra: Record<string, unknown>) => {
    const { mutation, story, ...rest } = extra;
    return ReviewTestsInputSchema.safeParse({
      agent: "quentin",
      ...(story === undefined ? {} : { story }),
      ...(mutation === undefined ? {} : { check: { mutation } }),
      ...rest,
    });
  };

  it("bounds the number of breaks and the time of the check", () => {
    expect(ask({ story: "17-5", mutation: { max: MAX_MUTATIONS } }).success).toBe(true);
    expect(ask({ mutation: { max: MAX_MUTATIONS + 1 } }).success).toBe(false);
    expect(ask({ mutation: { max: 0 } }).success).toBe(false);
    expect(ask({ mutation: { seconds: MAX_MUTATION_SECONDS } }).success).toBe(true);
    expect(ask({ mutation: { seconds: MAX_MUTATION_SECONDS + 1 } }).success).toBe(false);
    expect(ask({ mutation: { seconds: 9 } }).success).toBe(false);
  });

  it("is strict and names a story as <epic>-<story>", () => {
    expect(ask({ story: "17.5" }).success).toBe(false);
    expect(ask({ unknown: 1 }).success).toBe(false);
  });
});

describe("the event", () => {
  it("records the marks and the counts of the check, not the code", () => {
    const payload = {
      story: "17-5",
      score: 59,
      grade: "F",
      verdict: "blocked",
      criteria: [{ criterion: "assertions", score: 80 }],
      findings: 1,
      mutation: { ran: 8, killed: 7, survived: 1 },
      gaps: 3,
    };
    expect(TestsReviewedPayloadSchema.safeParse(payload).success).toBe(true);
    expect(TestsReviewedPayloadSchema.safeParse({ ...payload, source: "if (a) {}" }).success).toBe(
      false,
    );
    expect(TestsReviewedPayloadSchema.safeParse({ gaps: 0 }).success).toBe(true);
  });
});
