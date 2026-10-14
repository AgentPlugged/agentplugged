import {
  MAX_TEST_FINDINGS,
  MAX_TEST_READS,
  TEST_CRITERIA,
  TEST_ROWS,
  type TestCriterion,
  type TestFinding,
  type TestGrade,
  type TestGrid,
  type TestSeverity,
  type TestVerdict,
} from "@agentplugged/protocol";

/**
 * The graded review of the tests, pure. A reviewer reads the tests and fills a fixed
 * grid: for each criterion, `ok`, `issues` or `not_applicable`, and for each test that falls under a
 * row, where it is and why. The engine refuses a grid that is not whole (`validateGrid`) and marks
 * it (`markGrid`): the weight of a row is fixed by the row (`TEST_ROWS`), the marks are computed,
 * and nobody picks a mark. Two reviews that find the same things mark the same.
 */

/** What a finding takes off a mark, by its row's weight. */
export const SEVERITY_WEIGHT: Readonly<Record<TestSeverity, number>> = {
  critical: 20,
  high: 10,
  medium: 4,
  low: 1,
};

/** The best mark a grid with a finding of this weight can have: the worst finding caps the whole. */
export const SEVERITY_CAP: Readonly<Record<TestSeverity, number>> = {
  critical: 59,
  high: 74,
  medium: 89,
  low: 99,
};

const SEVERITY_ORDER: readonly TestSeverity[] = ["critical", "high", "medium", "low"];

const ROW_OF = new Map<string, (typeof TEST_ROWS)[number]>(TEST_ROWS.map((row) => [row.id, row]));

/** The weight of a finding's row. */
export function severityOf(finding: Pick<TestFinding, "row">): TestSeverity {
  return ROW_OF.get(finding.row)?.severity ?? "low";
}

/** The most problems one refusal lists. */
export const MAX_GRID_PROBLEMS = 15;
/** A reason shorter than this says nothing. */
const MIN_REASON = 10;

const slashed = (path: string) => path.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");

/** The file a finding's `test` points to: its first word, without a `:line`. */
function fileOf(test: string): string {
  const first = test.trim().split(/\s+/)[0] ?? "";
  return slashed(first.replace(/:\d+(?::\d+)?$/, ""));
}

/**
 * What stops the grid from being whole, one short line each, or nothing: every criterion of the
 * grid answered once, a criterion that does not apply says why, a criterion with issues names at
 * least one test and one that is fine names none, every finding falls under a row of its own
 * criterion, points to a test file the review read, and gives a reason; no test twice under a row.
 */
export function validateGrid(grid: TestGrid): string[] {
  const problems: string[] = [];
  const reads = new Set(grid.reads.map(slashed));
  if (reads.size === 0) problems.push("reads: list the test files you read (at least one)");
  if (reads.size > MAX_TEST_READS) problems.push(`reads: ${MAX_TEST_READS} files at most`);
  if (grid.findings.length > MAX_TEST_FINDINGS) {
    problems.push(`findings: ${MAX_TEST_FINDINGS} at most`);
  }
  const seen = new Map<TestCriterion, (typeof grid.criteria)[number]>();
  for (const entry of grid.criteria) {
    if (seen.has(entry.criterion)) problems.push(`criteria: ${entry.criterion} answered twice`);
    else seen.set(entry.criterion, entry);
  }
  for (const criterion of TEST_CRITERIA) {
    const entry = seen.get(criterion);
    if (entry === undefined) {
      problems.push(`criteria: ${criterion} is missing (ok, issues or not_applicable)`);
      continue;
    }
    const own = grid.findings.filter((finding) => finding.criterion === criterion);
    if (entry.verdict === "not_applicable" && (entry.note ?? "").trim() === "") {
      problems.push(`${criterion}: not_applicable needs its reason in note`);
    }
    if (entry.verdict === "issues" && own.length === 0) {
      problems.push(`${criterion}: issues without a finding (name the test and the reason)`);
    }
    if (entry.verdict !== "issues" && own.length > 0) {
      problems.push(`${criterion}: ${own.length} finding(s) but the verdict is ${entry.verdict}`);
    }
  }
  if (seen.size > 0 && [...seen.values()].every((entry) => entry.verdict === "not_applicable")) {
    problems.push("criteria: every criterion is not_applicable, there is nothing to grade");
  }
  const keys = new Set<string>();
  grid.findings.forEach((finding, index) => {
    const label = `findings.${index} (${finding.row})`;
    const row = ROW_OF.get(finding.row);
    if (row !== undefined && row.criterion !== finding.criterion) {
      problems.push(`${label}: the row belongs to ${row.criterion}, not ${finding.criterion}`);
    }
    if (finding.reason.trim().length < MIN_REASON) {
      problems.push(`${label}: give the reason in a few words`);
    }
    const file = fileOf(finding.test);
    if (!reads.has(file)) problems.push(`${label}: ${file} is not among the files you read`);
    const key = `${finding.row}\u0000${finding.test.trim()}`;
    if (keys.has(key)) problems.push(`${label}: reported twice`);
    keys.add(key);
  });
  return problems.length <= MAX_GRID_PROBLEMS
    ? problems
    : [...problems.slice(0, MAX_GRID_PROBLEMS), `+${problems.length - MAX_GRID_PROBLEMS} more`];
}

/** The mark of one criterion, or null when it does not apply. */
export interface CriterionMark {
  readonly criterion: TestCriterion;
  readonly score: number | null;
  readonly findings: number;
}

/** What the engine makes of a whole grid. */
export interface GridMark {
  readonly score: number;
  readonly grade: TestGrade;
  readonly verdict: TestVerdict;
  readonly criteria: readonly CriterionMark[];
  readonly counts: Readonly<Record<TestSeverity, number>>;
  /** The worst findings, one line each, bounded (`severity row test: reason`). */
  readonly lines: readonly string[];
}

/** The letter of a mark: five, no modifier. */
export function gradeOf(score: number): TestGrade {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

/** The most findings the answer lists, and the longest line. */
export const MAX_GRID_LINES = 8;
export const GRID_LINE_MAX = 160;

function lineOf(finding: TestFinding): string {
  const text = `${severityOf(finding)} ${finding.row} ${finding.test}: ${finding.reason}`;
  return text.length <= GRID_LINE_MAX ? text : `${text.slice(0, GRID_LINE_MAX - 1)}…`;
}

/**
 * The marks of a whole grid, from its findings alone: a criterion is 100 minus the weight of its
 * findings (not below 0); the grid is 100 minus the weight of all of them, and no better than the
 * cap of its worst finding (a test that cannot fail keeps the whole under 60). The verdict follows:
 * `blocked` with a critical finding, `to_fix` with a high one or under 70, `to_improve` with any
 * other, `sound` with none. Findings reported twice count once.
 */
export function markGrid(grid: TestGrid): GridMark {
  const unique = new Map<string, TestFinding>();
  for (const finding of grid.findings) {
    unique.set(`${finding.row}\u0000${finding.test.trim()}`, finding);
  }
  const findings = [...unique.values()];
  const counts: Record<TestSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[severityOf(finding)] += 1;
  const verdictOf = new Map(grid.criteria.map((entry) => [entry.criterion, entry.verdict]));
  const criteria = TEST_CRITERIA.map((criterion): CriterionMark => {
    const own = findings.filter((finding) => finding.criterion === criterion);
    if (verdictOf.get(criterion) === "not_applicable") {
      return { criterion, score: null, findings: 0 };
    }
    const taken = own.reduce((sum, finding) => sum + SEVERITY_WEIGHT[severityOf(finding)], 0);
    return { criterion, score: Math.max(0, 100 - taken), findings: own.length };
  });
  const taken = findings.reduce((sum, finding) => sum + SEVERITY_WEIGHT[severityOf(finding)], 0);
  const worst = SEVERITY_ORDER.find((severity) => counts[severity] > 0);
  const score = Math.max(0, Math.min(100 - taken, worst === undefined ? 100 : SEVERITY_CAP[worst]));
  const verdict: TestVerdict =
    counts.critical > 0
      ? "blocked"
      : counts.high > 0 || score < 70
        ? "to_fix"
        : findings.length > 0
          ? "to_improve"
          : "sound";
  const ranked = [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(severityOf(a)) - SEVERITY_ORDER.indexOf(severityOf(b)) ||
      (a.test < b.test ? -1 : a.test > b.test ? 1 : 0),
  );
  const lines = ranked.slice(0, MAX_GRID_LINES).map(lineOf);
  if (ranked.length > MAX_GRID_LINES) lines.push(`+${ranked.length - MAX_GRID_LINES} more`);
  return { score, grade: gradeOf(score), verdict, criteria, counts, lines };
}
