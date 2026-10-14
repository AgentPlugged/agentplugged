import { criteriaInLine, criterionId } from "@agentplugged/protocol";
import { type CandidateLine, isTestPath } from "../trace/test-references.js";

/**
 * What the journal holds of a story's acceptance criteria, and the rules that turn it into a state
 *. A criterion is proved by a test written from its text, seen failing before the code
 * (red) and passing after it (green). The engine saw the run (it started the command the creator
 * accepted) or the agent reported it, and the state says which. Nothing here reads a file or a
 * process: the rules are pure, the commands feed them.
 */

/** A run of a criterion's test, as the projection keeps it. */
export interface CriterionRun {
  readonly origin: "engine" | "reported";
  /** The test that ran: its name when reported; the command's name when the engine ran it. */
  readonly test: string;
  readonly commit: string | null;
  readonly clean: boolean | null;
  readonly at: string;
  readonly event: string;
}

/** `state.stories.<id>.criteria.<n>`: what the engine saw of one criterion. */
export interface CriterionRecord {
  /** Declared untestable through the interface, with the reason; a later run lifts it. */
  untestable?: { readonly reason: string; readonly at: string; readonly event: string };
  /** The failing run that opened the cycle (the latest failure, cleared by a pass after it). */
  red?: CriterionRun;
  /** The first passing run after that failure. */
  green?: CriterionRun;
  /** A passing run when no failure was ever seen before it. */
  passed?: CriterionRun;
  /** How many runs were seen. */
  runs: number;
}

/**
 * Where a criterion stands: `no_test` (nothing cites it), `not_run` (a test cites it, the engine saw
 * no run), `never_red` (it passes and was never seen failing: it proves nothing), `red` (its test
 * fails now), `green` (seen failing, then passing), `covered` (passing, with no red asked: the
 * quick lane of a change that was covered already), `untestable` (declared, with its reason),
 * `no_change` (its green ran on the very commit of its red, both clean: the code did not change
 * between them, so the green is no proof).
 */
export type CriterionStatus =
  | "no_test"
  | "not_run"
  | "never_red"
  | "red"
  | "green"
  | "no_change"
  | "covered"
  | "untestable";

/** True when the green ran on the same clean commit as the red: nothing was written between them. */
function sameCode(record: CriterionRecord): boolean {
  const { red, green } = record;
  return (
    red?.commit != null &&
    red.commit === green?.commit &&
    red.clean === true &&
    green?.clean === true
  );
}

/**
 * The state of a criterion from what the journal holds and whether a test cites it (`null`: the
 * tests could not be read, the runs are believed). A run whose test no longer cites the criterion
 * (renamed, removed) says nothing: `no_test`.
 */
export function criterionStatus(
  record: CriterionRecord | undefined,
  cited: boolean | null,
  quickLane: boolean,
): CriterionStatus {
  if (record?.untestable !== undefined) return "untestable";
  const ran = record?.green ?? record?.red ?? record?.passed;
  if (ran !== undefined && cited === false) return "no_test";
  if (record?.green !== undefined) return sameCode(record) ? "no_change" : "green";
  if (record?.red !== undefined) return "red";
  if (record?.passed !== undefined) return quickLane ? "covered" : "never_red";
  return cited === true ? "not_run" : "no_test";
}

/** True when the state lets the story go to review. */
export function criterionHolds(status: CriterionStatus): boolean {
  return status === "green" || status === "covered" || status === "untestable";
}

/**
 * What the runs behind a state were: the engine's own, or an agent's word. One reported run of the
 * cycle (the red or the green) makes the whole state reported: the engine did not see it all.
 */
export function criterionOrigin(record: CriterionRecord | undefined): "engine" | "reported" | null {
  const runs = [record?.red, record?.green, record?.passed].filter((run) => run !== undefined);
  if (runs.length === 0) return null;
  return runs.some((run) => run.origin === "reported") ? "reported" : "engine";
}

/** The most criteria one line shows; the rest is counted. */
export const MAX_TRACE_CRITERIA = 30;

/**
 * The trace of a story's criteria in one bounded line: `1:green 2:green(reported) 3:never_red
 * 4:no_test 5:untestable`. A state reached by an agent's word, not the engine's, says so.
 */
export function traceLine(
  entries: ReadonlyArray<{
    readonly n: number;
    readonly status: CriterionStatus;
    readonly origin: "engine" | "reported" | null;
  }>,
): string {
  const shown = entries
    .slice(0, MAX_TRACE_CRITERIA)
    .map(
      (entry) =>
        `${entry.n}:${entry.status}${entry.origin === "reported" && entry.status !== "untestable" ? "(reported)" : ""}`,
    );
  const more = entries.length - shown.length;
  return more > 0 ? `${shown.join(" ")} +${more}` : shown.join(" ");
}

/**
 * What the journal holds of a story's criteria, in one bounded line (`1:green 3:red`): the criteria
 * the engine saw, by number. Undefined when it saw none. `state.get` shows it; the review's trace
 * (`criteriaTrace`) also counts the criteria nothing was seen of.
 */
export function recordedTrace(
  records: Readonly<Record<string, CriterionRecord>> | undefined,
  quickLane: boolean,
): string | undefined {
  if (records === undefined) return undefined;
  const entries = Object.entries(records)
    .map(([n, record]) => ({
      n: Number(n),
      status: criterionStatus(record, null, quickLane),
      origin: criterionOrigin(record),
    }))
    .sort((a, b) => a.n - b.n);
  return entries.length === 0 ? undefined : traceLine(entries);
}

/** What is missing for a criterion, in one short line (the gate's message). */
export function missingLine(n: number, status: CriterionStatus, id: string): string {
  switch (status) {
    case "no_test":
      return `${n}: no test cites it (name one ${id})`;
    case "not_run":
      return `${n}: its test was not run yet (story.criterion)`;
    case "never_red":
      return `${n}: its test never failed before the code (it proves nothing)`;
    case "red":
      return `${n}: its test fails now`;
    case "no_change":
      return `${n}: its green ran on the commit of its red (commit the test, then the code)`;
    default:
      return `${n}: ${status}`;
  }
}

/** The most lines the gate gives. */
export const MAX_MISSING_LINES = 12;

/**
 * What stops a story going to review: one line per criterion that does not hold, at most
 * `MAX_MISSING_LINES` (the rest counted). Empty when every criterion holds.
 */
export function missingLines(
  story: string,
  entries: ReadonlyArray<{ readonly n: number; readonly status: CriterionStatus }>,
): string[] {
  const lines = entries
    .filter((entry) => !criterionHolds(entry.status))
    .map((entry) => missingLine(entry.n, entry.status, criterionId(story, entry.n)));
  return lines.length <= MAX_MISSING_LINES
    ? lines
    : [...lines.slice(0, MAX_MISSING_LINES), `+${lines.length - MAX_MISSING_LINES} more`];
}

/**
 * The criteria of story `story` that the test files cite, from the candidate lines and the names of
 * the files: criterion number → where (`path:line`, `path` for a file's name), at most 3 each. Only
 * test files count; the case and the dash or underscore do not matter.
 */
export function citedCriteria(
  story: string,
  lines: readonly CandidateLine[],
  files: readonly string[] = [],
): Map<number, string[]> {
  const cited = new Map<number, string[]>();
  const add = (n: number, where: string) => {
    const places = cited.get(n) ?? [];
    if (places.length < 3 && !places.includes(where)) places.push(where);
    cited.set(n, places);
  };
  for (const path of new Set(files)) {
    if (!isTestPath(path)) continue;
    const name = path.replaceAll("\\", "/").split("/").pop() ?? "";
    for (const found of criteriaInLine(name)) if (found.story === story) add(found.criterion, path);
  }
  for (const candidate of lines) {
    if (!isTestPath(candidate.path)) continue;
    for (const found of criteriaInLine(candidate.text)) {
      if (found.story === story) add(found.criterion, `${candidate.path}:${candidate.line}`);
    }
  }
  return cited;
}
