import { ErrorCode, MAX_CRITERIA, type ProjectionState } from "@agentplugged/protocol";
import type { CommandContext } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { storiesIn } from "../projection/agent-reducers.js";
import { type QaTrace, qaTraceOf } from "../qa/qa-rules.js";
import { storyText } from "../stories/story-text.js";
import {
  type CriterionStatus,
  citedCriteria,
  criterionOrigin,
  criterionStatus,
  missingLines,
  traceLine,
} from "./criterion-rules.js";

/**
 * The trace of a story's acceptance criteria, computed and never declared: the criteria
 * come from the story's approved text, the tests that cite them from the project's test files (the
 * convention `AC-<story>-<n>` in a test's name or a comment), what was seen of them from the
 * journal. The gate before the review and the review's judge read this and nothing else.
 */

type State = ProjectionState["state"];

/** One criterion of a story and where it stands. */
export interface CriterionTrace {
  readonly n: number;
  readonly status: CriterionStatus;
  readonly origin: "engine" | "reported" | null;
  /** `path:line` of the tests that cite it (at most 3), empty when none is seen. */
  readonly tests: readonly string[];
  /** Why the developer declared it untestable, when it is. */
  readonly reason?: string;
  /** What the acceptance QA in a browser saw of it, when it was played. */
  readonly qa?: QaTrace;
}

/** A story's criteria, one line, and what stops its review. */
export interface StoryTrace {
  readonly story: string;
  readonly criteria: readonly CriterionTrace[];
  /** `1:green 2:red 3:no_test`: bounded. */
  readonly line: string;
  /** One short line per criterion that does not hold; empty when the story may go to review. */
  readonly missing: readonly string[];
  /** `n: reason` for each criterion declared untestable: the review looks at them. */
  readonly untestable: readonly string[];
  /** The quick lane of a small change: a passing test is enough, no red is asked. */
  readonly quick: boolean;
}

/** The most reasons the review is given; the rest is counted. */
export const MAX_UNTESTABLE_LINES = 8;

function boundedReasons(lines: string[]): string[] {
  return lines.length <= MAX_UNTESTABLE_LINES
    ? lines
    : [...lines.slice(0, MAX_UNTESTABLE_LINES), `+${lines.length - MAX_UNTESTABLE_LINES} more`];
}

/** The criteria the project's tests cite for the story, or null when the tests cannot be read. */
async function citedByTests(
  context: CommandContext,
  story: string,
  workspace: string | undefined,
): Promise<Map<number, string[]> | null> {
  const source = context.testReferences;
  if (source === undefined) return null;
  try {
    const read = await source.read(workspace);
    return read.found ? citedCriteria(story, read.lines, read.files) : null;
  } catch {
    return null;
  }
}

/**
 * The trace of story `id`, or undefined when there is nothing to follow: the story is not started,
 * its approved text cannot be read, or it lists no criterion.
 */
export async function criteriaTrace(
  context: CommandContext,
  state: State,
  id: string,
): Promise<StoryTrace | undefined> {
  const story = storiesIn(state)[id];
  if (story?.started === undefined) return undefined;
  const text = await storyText(context, state, id, (context.now ?? Date.now)());
  if (text === undefined || text.listed.length === 0) return undefined;
  const worktree = story.started.worktree;
  const cited = await citedByTests(context, id, worktree === "." ? undefined : worktree);
  const quick = story.fast_track?.status === "active";
  const criteria = text.listed.slice(0, MAX_CRITERIA).map((_, index): CriterionTrace => {
    const n = index + 1;
    const record = story.criteria?.[String(n)];
    const status = criterionStatus(record, cited === null ? null : cited.has(n), quick);
    const reason = record?.untestable?.reason;
    const qa = qaTraceOf(story.qa, n);
    return {
      n,
      status,
      origin: criterionOrigin(record),
      tests: cited?.get(n) ?? [],
      ...(status === "untestable" && reason !== undefined ? { reason } : {}),
      ...(qa === undefined ? {} : { qa }),
    };
  });
  return {
    story: id,
    criteria,
    line: traceLine(criteria),
    missing: missingLines(id, criteria),
    untestable: boundedReasons(
      criteria.flatMap((entry) => {
        const reason = story.criteria?.[String(entry.n)]?.untestable?.reason;
        return entry.status === "untestable" && reason !== undefined
          ? [`${entry.n}: ${reason.length <= 120 ? reason : `${reason.slice(0, 119)}…`}`]
          : [];
      }),
    ),
    quick,
  };
}

/**
 * The gate before the review: `CRITERIA_NOT_PROVEN` while a criterion of the story has no test seen
 * failing then passing and is not declared untestable (one line per criterion). Undefined when every
 * criterion holds, and when there is nothing to follow (see `criteriaTrace`).
 */
export async function criteriaProblem(
  context: CommandContext,
  state: State,
  id: string,
): Promise<AgentPluggedError | undefined> {
  const trace = await criteriaTrace(context, state, id);
  return trace === undefined ? undefined : unprovenCriteria(trace);
}

/** `CRITERIA_NOT_PROVEN` for a trace with a criterion that does not hold; undefined when all do. */
export function unprovenCriteria(trace: StoryTrace): AgentPluggedError | undefined {
  if (trace.missing.length === 0) return undefined;
  return new AgentPluggedError(ErrorCode.CRITERIA_NOT_PROVEN, "error.criteria_not_proven", {
    story: trace.story,
    missing: trace.missing.map((line) => `- ${line}`).join("\n"),
    trace: trace.line,
  });
}
