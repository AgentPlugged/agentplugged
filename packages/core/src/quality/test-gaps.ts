import { criterionId } from "@agentplugged/protocol";
import { type CriterionStatus, missingLine } from "../criteria/criterion-rules.js";
import { type MutationReport, mutationCounts } from "./mutation-run.js";
import { describeMutation } from "./mutations.js";

/**
 * The holes in the tests, tied to what they should protect, pure. Not a percentage of
 * lines: the criteria of the story and the requirements it cites that have no test, whose test was
 * never seen failing, or whose tests killed no mutation; and the breaks no test
 * noticed. One short line each, then a title for the register of work to decide, one gesture each.
 */

export type GapKind = "criterion" | "requirement" | "survivor";

export interface Gap {
  readonly kind: GapKind;
  /** One line for the answer. */
  readonly line: string;
  /** The title the work takes in the register of deferred work. */
  readonly title: string;
  /** What the creator reads when deciding. */
  readonly detail: string;
}

/** A criterion of the story and where it stands. */
export interface CriterionState {
  readonly n: number;
  readonly status: CriterionStatus;
}

/** A requirement in scope and the number of test files that cite it (null: tests not read). */
export interface RequirementState {
  readonly id: string;
  readonly tests: number | null;
}

export interface GapInput {
  readonly story?: string;
  readonly criteria?: readonly CriterionState[];
  readonly requirements?: readonly RequirementState[];
  readonly mutation?: MutationReport;
}

/** Criteria whose state is a hole in itself. */
const OPEN: ReadonlySet<CriterionStatus> = new Set([
  "no_test",
  "not_run",
  "never_red",
  "no_change",
  "red",
]);
/** Criteria that have a test the mutation check can say something of. */
const HAS_TEST: ReadonlySet<CriterionStatus> = new Set([
  "green",
  "covered",
  "never_red",
  "no_change",
]);

/** Fewest breaks run before "the tests killed none" is said, and killed before "none named it". */
export const MIN_BREAKS = 3;
const MIN_BREAKS_NAMED = 2;

/** The longest line, and the longest title of the register. */
export const GAP_LINE_MAX = 160;
const TITLE_MAX = 200;

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

function gap(kind: GapKind, line: string, detail: string): Gap {
  return {
    kind,
    line: clip(line, GAP_LINE_MAX),
    title: clip(`[tests] ${line}`, TITLE_MAX),
    detail: clip(detail, 2000),
  };
}

/**
 * Every hole, in a fixed order: the breaks no test noticed, the criteria, the requirements. A
 * criterion or a requirement appears once, under its first reason.
 */
export function testGaps(input: GapInput): Gap[] {
  const gaps: Gap[] = [];
  const story = input.story;
  const counts = input.mutation === undefined ? undefined : mutationCounts(input.mutation);
  const ran = counts?.ran ?? 0;
  // Said only when enough breaks ran for "none was noticed" to mean something.
  const killedNothing =
    counts !== undefined && ran - counts.errors >= MIN_BREAKS && counts.killed === 0;
  const named = new Set(
    (input.mutation?.results ?? []).flatMap((result) =>
      result.outcome === "killed" ? result.named : [],
    ),
  );
  for (const result of input.mutation?.results ?? []) {
    if (result.outcome !== "survived") continue;
    const described = describeMutation(result.mutation);
    gaps.push(
      gap(
        "survivor",
        `survives: ${described}`,
        `The engine changed ${result.mutation.path}:${result.mutation.line} (${result.mutation.kind}: \`${result.mutation.from.slice(0, 60)}\` -> \`${result.mutation.to.slice(0, 60)}\`) and every accepted test still passed. Add a test that fails on that change.`,
      ),
    );
  }
  if (story !== undefined) {
    for (const entry of input.criteria ?? []) {
      const id = criterionId(story, entry.n);
      if (OPEN.has(entry.status)) {
        gaps.push(
          gap(
            "criterion",
            `${story} ${missingLine(entry.n, entry.status, id)}`,
            `Criterion ${entry.n} of story ${story} (${id}): ${missingLine(entry.n, entry.status, id).split(": ").slice(1).join(": ")}. Write the test from the words of the criterion, see it fail, then pass.`,
          ),
        );
        continue;
      }
      if (!HAS_TEST.has(entry.status) || counts === undefined || counts.ran === 0) continue;
      if (killedNothing) {
        gaps.push(
          gap(
            "criterion",
            `${story} ${entry.n}: its tests killed none of the ${counts.ran} mutations`,
            `The tests of criterion ${entry.n} of story ${story} (${id}) saw no difference when the engine broke the changed code ${counts.ran} times (check that they ran at all, then that they assert the result, not the call).`,
          ),
        );
      } else if (counts.killed >= MIN_BREAKS_NAMED && named.size > 0 && !named.has(entry.n)) {
        gaps.push(
          gap(
            "criterion",
            `${story} ${entry.n}: no failing run named its tests`,
            `Among the failing runs of the mutation check, none names the tests of criterion ${entry.n} of story ${story} (${id}); they may not notice a change of the code. Check that they assert the result.`,
          ),
        );
      }
    }
  }
  for (const requirement of input.requirements ?? []) {
    if (requirement.tests === null) continue;
    if (requirement.tests === 0) {
      gaps.push(
        gap(
          "requirement",
          `${requirement.id}: no test cites it`,
          `No test file names ${requirement.id} in its name or a comment. Write the test that guards it and name it ${requirement.id}.`,
        ),
      );
    } else if (killedNothing && story !== undefined) {
      gaps.push(
        gap(
          "requirement",
          `${requirement.id}: story ${story}'s tests killed none of ${ran} mutations`,
          `${requirement.id} is cited by story ${story}, whose tests passed through ${ran} breaks of the code it changed. Its tests may not guard it.`,
        ),
      );
    }
  }
  return gaps;
}

/** The most holes the answer lists. */
export const MAX_GAP_LINES = 12;
/** The most the engine records as work to decide in one call. */
export const MAX_PROPOSED = 10;

/** The lines of the answer: the holes, bounded, the rest counted. */
export function gapLines(gaps: readonly Gap[]): string[] {
  const lines = gaps.slice(0, MAX_GAP_LINES).map((entry) => entry.line);
  if (gaps.length > MAX_GAP_LINES) lines.push(`+${gaps.length - MAX_GAP_LINES} more`);
  return lines;
}
