import { describe, expect, it } from "vitest";
import type { MutationOutcome, MutationReport } from "./mutation-run.js";
import type { Mutation } from "./mutations.js";
import { GAP_LINE_MAX, gapLines, MAX_GAP_LINES, testGaps } from "./test-gaps.js";

/**
 * The holes in the tests, pure: tied to the criteria of the story and to
 * the requirements, one line each, and the breaks no test noticed.
 */

const mutation = (line: number, from = "18", to = "19"): Mutation => ({
  path: "src/gate.ts",
  line,
  kind: "number",
  from,
  to,
  start: line * 10,
  end: line * 10 + from.length,
});

const report = (outcomes: Array<[MutationOutcome, number[]?]>): MutationReport => ({
  status: "done",
  proposed: outcomes.length,
  results: outcomes.map(([outcome, named], index) => ({
    mutation: mutation(index + 1),
    outcome,
    named: named ?? [],
  })),
});

describe("the holes", () => {
  it("names a criterion with no test, one not run, one never seen red, one red", () => {
    const gaps = testGaps({
      story: "17-5",
      criteria: [
        { n: 1, status: "no_test" },
        { n: 2, status: "not_run" },
        { n: 3, status: "never_red" },
        { n: 4, status: "red" },
        { n: 5, status: "no_change" },
        { n: 6, status: "green" },
        { n: 7, status: "untestable" },
        { n: 8, status: "covered" },
      ],
    });
    expect(gaps.map((gap) => gap.line)).toEqual([
      "17-5 1: no test cites it (name one AC-17-5-1)",
      "17-5 2: its test was not run yet (story.criterion)",
      "17-5 3: its test never failed before the code (it proves nothing)",
      "17-5 4: its test fails now",
      "17-5 5: its green ran on the commit of its red (commit the test, then the code)",
    ]);
    expect(gaps.every((gap) => gap.kind === "criterion")).toBe(true);
  });

  it("names a requirement with no test, and leaves alone one whose tests could not be read", () => {
    const gaps = testGaps({
      requirements: [
        { id: "EF-1", tests: 2 },
        { id: "EF-2", tests: 0 },
        { id: "ENF-3", tests: null },
      ],
    });
    expect(gaps.map((gap) => gap.line)).toEqual(["EF-2: no test cites it"]);
    expect(gaps[0]?.title).toBe("[tests] EF-2: no test cites it");
    expect(gaps[0]?.kind).toBe("requirement");
  });

  it("puts the breaks no test noticed first, each with file, line and break", () => {
    const gaps = testGaps({
      story: "17-5",
      criteria: [{ n: 1, status: "no_test" }],
      mutation: report([["killed", [1]], ["survived"], ["survived"]]),
    });
    expect(gaps.map((gap) => gap.kind)).toEqual(["survivor", "survivor", "criterion"]);
    expect(gaps[0]?.line).toBe("survives: src/gate.ts:2 number `18` -> `19`");
    expect(gaps[0]?.detail).toContain("Add a test that fails on that change");
  });

  it("says a criterion's tests killed nothing only when no break was killed at all", () => {
    const none = testGaps({
      story: "17-5",
      criteria: [
        { n: 1, status: "green" },
        { n: 2, status: "covered" },
        { n: 3, status: "untestable" },
      ],
      requirements: [{ id: "EF-4", tests: 1 }],
      mutation: report([["survived"], ["survived"], ["survived"]]),
    });
    const lines = none.map((gap) => gap.line);
    expect(lines).toContain("17-5 1: its tests killed none of the 3 mutations");
    expect(lines).toContain("17-5 2: its tests killed none of the 3 mutations");
    expect(lines).toContain("EF-4: story 17-5's tests killed none of 3 mutations");
    expect(lines.join("\n")).not.toContain("17-5 3");
    // One break killed: the claim is not made for every criterion.
    const some = testGaps({
      story: "17-5",
      criteria: [{ n: 1, status: "green" }],
      mutation: report([["killed"], ["survived"]]),
    });
    expect(some.map((gap) => gap.line)).toEqual(["survives: src/gate.ts:2 number `18` -> `19`"]);
  });

  it("says no failing run named a criterion only when the output names some", () => {
    const gaps = testGaps({
      story: "17-5",
      criteria: [
        { n: 1, status: "green" },
        { n: 2, status: "green" },
      ],
      mutation: report([
        ["killed", [1]],
        ["killed", [1]],
      ]),
    });
    expect(gaps.map((gap) => gap.line)).toEqual(["17-5 2: no failing run named its tests"]);
  });

  it("says nothing of a criterion's tests when too few breaks ran for it to mean something", () => {
    const gaps = testGaps({
      story: "17-5",
      criteria: [{ n: 1, status: "green" }],
      requirements: [{ id: "EF-4", tests: 1 }],
      mutation: report([["survived"], ["survived"]]),
    });
    expect(gaps.map((gap) => gap.kind)).toEqual(["survivor", "survivor"]);
  });

  it("does not count breaks that could not run as breaks no test killed", () => {
    const gaps = testGaps({
      story: "17-5",
      criteria: [{ n: 1, status: "green" }],
      mutation: report([["error"], ["not_run"]]),
    });
    expect(gaps).toEqual([]);
  });
});

describe("what is shown is bounded", () => {
  const many = testGaps({
    story: "17-5",
    criteria: Array.from({ length: 20 }, (_, index) => ({
      n: index + 1,
      status: "no_test" as const,
    })),
  });

  it("lists twelve holes and counts the rest", () => {
    expect(many).toHaveLength(20);
    const lines = gapLines(many);
    expect(lines).toHaveLength(MAX_GAP_LINES + 1);
    expect(lines.at(-1)).toBe("+8 more");
  });

  it("keeps a line short and a title inside the register's limit", () => {
    const long = testGaps({ requirements: [{ id: `ENF-${"9".repeat(300)}`, tests: 0 }] });
    expect(long[0]?.line.length).toBeLessThanOrEqual(GAP_LINE_MAX);
    expect(long[0]?.title.length).toBeLessThanOrEqual(200);
    expect(long[0]?.detail.length).toBeLessThanOrEqual(2000);
  });
});
