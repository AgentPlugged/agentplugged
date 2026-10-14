import { TEST_CRITERIA, TEST_ROWS, type TestGrid } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { gradeOf, markGrid, SEVERITY_CAP, SEVERITY_WEIGHT, validateGrid } from "./test-grid.js";

/**
 * The graded review of the tests, pure: a fixed grid the engine refuses
 * when it is not whole and marks itself. The reviewer says which row a test falls under, never how
 * much it weighs.
 */

const READS = ["src/cart.test.ts", "src/pay.test.ts"];

const allOk = (): TestGrid["criteria"] =>
  TEST_CRITERIA.map((criterion) => ({ criterion, verdict: "ok" as const }));

const grid = (overrides: Partial<TestGrid> = {}): TestGrid => ({
  reads: READS,
  criteria: allOk(),
  findings: [],
  ...overrides,
});

/** The criteria with `issues` where findings are given. */
function withIssues(...criteria: string[]): TestGrid["criteria"] {
  return TEST_CRITERIA.map((criterion) => ({
    criterion,
    verdict: criteria.includes(criterion) ? ("issues" as const) : ("ok" as const),
  }));
}

const finding = (row: string, test = "src/cart.test.ts:12 adds an item") => {
  const entry = TEST_ROWS.find((candidate) => candidate.id === row);
  if (entry === undefined) throw new Error(`no row ${row}`);
  return {
    criterion: entry.criterion,
    row: entry.id,
    test,
    reason: "the test passes whatever the cart does",
  } as TestGrid["findings"][number];
};

describe("a grid that is not whole is refused, with what is missing", () => {
  it("accepts a grid with nothing to report", () => {
    expect(validateGrid(grid())).toEqual([]);
  });

  it("asks for the files read, every criterion once, and a reason for what does not apply", () => {
    const refused = validateGrid({
      reads: [],
      criteria: [
        { criterion: "active", verdict: "ok" },
        { criterion: "active", verdict: "ok" },
        { criterion: "speed", verdict: "not_applicable" },
      ],
      findings: [],
    });
    expect(refused).toContain("reads: list the test files you read (at least one)");
    expect(refused).toContain("criteria: active answered twice");
    expect(refused).toContain("criteria: assertions is missing (ok, issues or not_applicable)");
    expect(refused).toContain("speed: not_applicable needs its reason in note");
  });

  it("wants the test and the reason behind every bad mark", () => {
    expect(validateGrid(grid({ criteria: withIssues("assertions") }))).toEqual([
      "assertions: issues without a finding (name the test and the reason)",
    ]);
    expect(validateGrid(grid({ findings: [finding("tautology")] }))).toEqual([
      "assertions: 1 finding(s) but the verdict is ok",
    ]);
    const vague = { ...finding("tautology"), reason: "bad" };
    expect(validateGrid(grid({ criteria: withIssues("assertions"), findings: [vague] }))).toEqual([
      "findings.0 (tautology): give the reason in a few words",
    ]);
  });

  it("refuses a finding under another criterion's row, on a file not read, or twice", () => {
    const wrongCriterion = { ...finding("tautology"), criterion: "speed" as const };
    const unread = finding("tautology", "src/other.test.ts:3 never opened");
    const refused = validateGrid(
      grid({
        criteria: withIssues("assertions", "speed"),
        findings: [
          wrongCriterion,
          unread,
          finding("hard_wait"),
          finding("tautology"),
          finding("tautology"),
        ],
      }),
    );
    expect(refused).toContain("findings.0 (tautology): the row belongs to assertions, not speed");
    expect(refused).toContain(
      "findings.1 (tautology): src/other.test.ts is not among the files you read",
    );
    expect(refused.some((line) => line.includes("(tautology): reported twice"))).toBe(true);
  });

  it("does not grade a grid where nothing applies", () => {
    const none = TEST_CRITERIA.map((criterion) => ({
      criterion,
      verdict: "not_applicable" as const,
      note: "no test in this change",
    }));
    expect(validateGrid(grid({ criteria: none }))).toContain(
      "criteria: every criterion is not_applicable, there is nothing to grade",
    );
  });

  it("lists a bounded number of problems", () => {
    const refused = validateGrid({ reads: [], criteria: [], findings: [] });
    expect(refused.length).toBeLessThanOrEqual(16);
    expect(refused.at(-1)).toMatch(/^\+\d+ more$|criteria: /);
  });
});

describe("the engine marks the grid, the reviewer does not", () => {
  it("gives 100, an A and `sound` to a grid with nothing to report", () => {
    const mark = markGrid(grid());
    expect(mark).toMatchObject({ score: 100, grade: "A", verdict: "sound", lines: [] });
    expect(mark.criteria.every((entry) => entry.score === 100)).toBe(true);
  });

  it("takes the weight of the row off the criterion and off the whole", () => {
    const mark = markGrid(
      grid({
        criteria: withIssues("determinism", "readability"),
        findings: [finding("hard_wait"), finding("magic_value", "src/pay.test.ts:4 rounds")],
      }),
    );
    const byCriterion = Object.fromEntries(
      mark.criteria.map((entry) => [entry.criterion, entry.score]),
    );
    expect(byCriterion.determinism).toBe(100 - SEVERITY_WEIGHT.high);
    expect(byCriterion.readability).toBe(100 - SEVERITY_WEIGHT.low);
    // 89 by the ledger, but a high finding keeps the whole under 75.
    expect(mark.score).toBe(SEVERITY_CAP.high);
    expect(mark.counts).toEqual({ critical: 0, high: 1, medium: 0, low: 1 });
    expect(mark.verdict).toBe("to_fix");
  });

  it("keeps a grid with a test that cannot fail under 60, whatever else is good", () => {
    const mark = markGrid(
      grid({ criteria: withIssues("assertions"), findings: [finding("tautology")] }),
    );
    expect(mark.score).toBeLessThanOrEqual(SEVERITY_CAP.critical);
    expect(mark.grade).toBe("F");
    expect(mark.verdict).toBe("blocked");
    expect(mark.criteria.find((entry) => entry.criterion === "assertions")?.score).toBe(80);
  });

  it("caps by the worst finding and derives the verdict from the findings", () => {
    const medium = markGrid(
      grid({ criteria: withIssues("readability"), findings: [finding("multi_concern")] }),
    );
    expect(medium).toMatchObject({ score: 89, grade: "B", verdict: "to_improve" });
    const low = markGrid(
      grid({ criteria: withIssues("readability"), findings: [finding("ungrouped")] }),
    );
    expect(low).toMatchObject({ score: 99, verdict: "to_improve" });
    const high = markGrid(
      grid({ criteria: withIssues("isolation"), findings: [finding("shared_state")] }),
    );
    expect(high).toMatchObject({ score: 74, verdict: "to_fix" });
  });

  it("sends a grid with many small findings to `to_fix` when it falls under 70", () => {
    const many = Array.from({ length: 8 }, (_, index) =>
      finding("multi_concern", `src/cart.test.ts:${index + 1} case ${index}`),
    );
    const mark = markGrid(grid({ criteria: withIssues("readability"), findings: many }));
    expect(mark.score).toBe(68);
    expect(mark.verdict).toBe("to_fix");
  });

  it("leaves a criterion that does not apply out of its marks", () => {
    const criteria = TEST_CRITERIA.map((criterion) =>
      criterion === "speed"
        ? { criterion, verdict: "not_applicable" as const, note: "no test runs here" }
        : { criterion, verdict: "ok" as const },
    );
    const mark = markGrid(grid({ criteria }));
    expect(mark.criteria.find((entry) => entry.criterion === "speed")?.score).toBeNull();
    expect(mark.score).toBe(100);
  });

  it("counts a test reported twice once and lists the worst first, bounded", () => {
    const findings = [
      finding("ungrouped", "src/cart.test.ts:1 a"),
      finding("ungrouped", "src/cart.test.ts:1 a"),
      finding("skipped", "src/cart.test.ts:2 b"),
      ...Array.from({ length: 12 }, (_, index) =>
        finding("magic_value", `src/pay.test.ts:${index + 1} c${index}`),
      ),
    ];
    const mark = markGrid(grid({ criteria: withIssues("active", "readability"), findings }));
    expect(mark.counts).toEqual({ critical: 1, high: 0, medium: 0, low: 13 });
    expect(mark.lines).toHaveLength(9);
    expect(mark.lines[0]).toMatch(/^critical skipped src\/cart\.test\.ts:2 b: /);
    expect(mark.lines.at(-1)).toBe("+6 more");
    expect(mark.lines.every((line) => line.length <= 160)).toBe(true);
  });

  it("writes the five grades and no modifier", () => {
    expect([100, 90, 89, 80, 79, 70, 69, 60, 59, 0].map(gradeOf)).toEqual([
      "A",
      "A",
      "B",
      "B",
      "C",
      "C",
      "D",
      "D",
      "F",
      "F",
    ]);
  });

  it("gives the same marks for the same findings, in any order", () => {
    const one = [
      finding("hard_wait"),
      finding("tautology"),
      finding("magic_value", "src/pay.test.ts:9 x"),
    ];
    const criteria = withIssues("determinism", "assertions", "readability");
    expect(markGrid(grid({ criteria, findings: one }))).toEqual(
      markGrid(grid({ criteria, findings: [...one].reverse() })),
    );
  });
});

describe("the universal rows added, marked by the engine like the others", () => {
  it("weighs a fragile selector low, a read before the page is ready and a raw event medium", () => {
    const weights = Object.fromEntries(
      ["fragile_selector", "navigate_then_read", "raw_event"].map((row) => [
        row,
        TEST_ROWS.find((candidate) => candidate.id === row),
      ]),
    );
    expect(weights.fragile_selector).toMatchObject({ criterion: "determinism", severity: "low" });
    expect(weights.navigate_then_read).toMatchObject({
      criterion: "determinism",
      severity: "medium",
    });
    expect(weights.raw_event).toMatchObject({ criterion: "risk", severity: "medium" });
  });

  it("computes their marks from the rows alone", () => {
    const criteria = withIssues("determinism", "risk");
    const marked = markGrid(
      grid({
        criteria,
        findings: [
          finding("fragile_selector", "src/cart.test.ts:20 clicks .btn-primary"),
          finding("navigate_then_read", "src/cart.test.ts:30 opens the list"),
          finding("raw_event", "src/cart.test.ts:40 submits the form"),
        ],
      }),
    );
    // 1 + 4 + 4 taken off the whole; the worst weight (medium) caps it at 89.
    expect(marked.score).toBe(89);
    expect(marked.counts).toEqual({ critical: 0, high: 0, medium: 2, low: 1 });
    expect(marked.verdict).toBe("to_improve");
    expect(marked.criteria.find((entry) => entry.criterion === "determinism")?.score).toBe(95);
    expect(marked.criteria.find((entry) => entry.criterion === "risk")?.score).toBe(96);
  });

  it("refuses a new row filed under the wrong criterion", () => {
    const refused = validateGrid(
      grid({
        criteria: withIssues("risk"),
        findings: [
          {
            criterion: "risk",
            row: "fragile_selector",
            test: "src/cart.test.ts:20",
            reason: "clicks a CSS class of the page",
          },
        ],
      }),
    );
    expect(refused.join(" ")).toContain("the row belongs to determinism, not risk");
  });
});

describe("the rows are fixed", () => {
  it("gives every row one criterion of the grid and every criterion at least one row", () => {
    for (const row of TEST_ROWS) expect(TEST_CRITERIA).toContain(row.criterion);
    for (const criterion of TEST_CRITERIA) {
      expect(TEST_ROWS.some((row) => row.criterion === criterion)).toBe(true);
    }
    expect(new Set(TEST_ROWS.map((row) => row.id)).size).toBe(TEST_ROWS.length);
  });
});
