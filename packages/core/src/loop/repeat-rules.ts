import type { ResultStatus } from "@agentplugged/protocol";
import { truncate } from "../checkpoints/checkpoint-rules.js";
import type { StoryState } from "../projection/agent-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { isMergeCheckpoint } from "../projection/merge-reducers.js";
import { isHypothesis, sameApproach } from "./loop-rules.js";

/**
 * Two identical failures change the method, pure. When a story fails twice for the same cause (its
 * tests red for the same reason, the review back on the same point, the same write refused, the
 * step left where it was), a third identical try is never the answer: the engine says so in
 * `state.next`, and Noah has the cause investigated (an agent or a stronger model) or puts the
 * block to the creator in one question. A hypothesis put forward on the story, or a point of the
 * story opened since, is that change of method: the signal stops.
 */

/** What failed twice in the same way. */
export type RepeatCause = "tests" | "review" | "refused" | "stalled" | "merge" | "action";

/** The second identical failure of a story, with what repeated and when. */
export interface RepeatedCause {
  readonly cause: RepeatCause;
  readonly times: number;
  /** What repeated, in a line: the failure, the review's point, the rule and file, the agent. */
  readonly what: string;
  /** When it repeated (the second time). */
  readonly at: string;
}

/** The same write refused again and again on a story, as the projection keeps it. */
export interface RefusalRepeat {
  readonly rule: string;
  readonly path: string;
  count: number;
  at: string;
}

/** The same agent handing the story back without moving it, as the projection keeps it. */
export interface StallRecord {
  readonly agent: string;
  readonly mark: string;
  readonly count: number;
  readonly at: string;
}

/** The line a repeat is shown with. */
const WHAT_MAX = 160;

/**
 * Where a story stands, as a mark: two results whose marks are equal left it where it was. Its
 * status, its review (passes and sorted findings), its criteria, its approaches, its CI and pull
 * request, its scope and its conflicts.
 */
export function progressMark(story: StoryState): string {
  const passes = story.review?.passes ?? [];
  const sorted = passes
    .flatMap((pass) =>
      (["qa", "security"] as const).flatMap((kind) => pass.reviews[kind]?.findings ?? []),
    )
    .filter((finding) => finding.triage !== null).length;
  return JSON.stringify([
    story.status,
    passes.length,
    sorted,
    // Every criterion's record (a red, then a green), and the last progress note: work under way.
    JSON.stringify(story.criteria ?? {}),
    story.progress?.at ?? null,
    story.attempts?.length ?? 0,
    story.ci?.commit ?? null,
    story.pull_request === undefined ? null : JSON.stringify(story.pull_request),
    story.scope_widened?.length ?? 0,
    story.conflicts?.length ?? 0,
    story.merged === undefined ? 0 : 1,
  ]);
}

/**
 * The stall record after an agent's result on the story: a complete result ends it; a partial or
 * blocked one by the same agent that left the story where it was counts once more; anything else
 * starts it again.
 */
export function nextStall(
  before: StallRecord | undefined,
  agent: string,
  status: ResultStatus,
  mark: string,
  at: string,
): StallRecord | undefined {
  if (status === "complete") return undefined;
  if (before !== undefined && before.agent === agent && before.mark === mark) {
    return { agent, mark, count: before.count + 1, at };
  }
  return { agent, mark, count: 1, at };
}

/** The refusal record after one more refused write: the same rule and file count once more. */
export function nextRefusal(
  before: RefusalRepeat | undefined,
  rule: string,
  path: string,
  at: string,
): RefusalRepeat {
  if (before !== undefined && before.rule === rule && before.path === path) {
    return { rule, path, count: before.count + 1, at };
  }
  return { rule, path, count: 1, at };
}

/** The last two approaches that ended, when both failed for the same reason. */
function testsRepeat(story: StoryState): RepeatedCause | undefined {
  const ended = (story.attempts ?? []).filter(
    (record) => !isHypothesis(record) && record.result !== "started",
  );
  const [first, second] = ended.slice(-2);
  if (first === undefined || second === undefined) return undefined;
  if (first.result !== "failed" || second.result !== "failed") return undefined;
  const a = first.note ?? "";
  const b = second.note ?? "";
  if (a.trim() === "" || b.trim() === "" || !sameApproach(a, b)) return undefined;
  return { cause: "tests", times: 2, what: truncate(b, WHAT_MAX), at: second.at };
}

/**
 * The merge of the story refused twice for the same cause (the answer held for its merge point
 * could not be carried out, `base_dirty` for instance): asking again is refused again.
 */
function mergeRepeat(
  id: string,
  checkpoints: readonly CheckpointState[],
): RepeatedCause | undefined {
  const refused = checkpoints
    .filter(
      (checkpoint) =>
        checkpoint.story === id &&
        isMergeCheckpoint(checkpoint) &&
        checkpoint.status === "open" &&
        // A moved head has its own way out (a new review pass), never a repeat.
        !(checkpoint.web_failure_repeat?.key ?? "").endsWith(":head_moved") &&
        (checkpoint.web_failure_repeat?.count ?? 0) >= 2,
    )
    .sort(
      (a, b) =>
        Date.parse(b.web_failure_repeat?.at ?? "") - Date.parse(a.web_failure_repeat?.at ?? ""),
    )[0];
  const repeat = refused?.web_failure_repeat;
  if (refused === undefined || repeat === undefined) return undefined;
  return {
    cause: "merge",
    times: repeat.count,
    what: truncate(repeat.key, WHAT_MAX),
    at: repeat.at,
  };
}

/** The last two closed passes of the review, when the second comes back on a point of the first. */
function reviewRepeat(story: StoryState): RepeatedCause | undefined {
  const closed = (story.review?.passes ?? []).filter(
    (pass) => pass.complete && pass.completed_at !== null,
  );
  const [first, second] = closed.slice(-2);
  if (first === undefined || second === undefined) return undefined;
  const findings = (pass: typeof first) =>
    (["qa", "security"] as const).flatMap((kind) => pass.reviews[kind]?.findings ?? []);
  const earlier = findings(first);
  const again = findings(second).find((finding) =>
    earlier.some(
      (before) =>
        sameApproach(before.title, finding.title) &&
        (before.path === undefined || finding.path === undefined || before.path === finding.path),
    ),
  );
  if (again === undefined) return undefined;
  return {
    cause: "review",
    times: 2,
    what: truncate(again.title, WHAT_MAX),
    at: second.completed_at as string,
  };
}

/**
 * The second identical failure of the story, the latest when several causes repeat, or undefined.
 * A hypothesis put forward on the story, or a point of the story opened, at or after it, is the
 * change of method already made.
 */
export function repeatedCause(
  story: StoryState | undefined,
  id: string,
  checkpoints: readonly CheckpointState[],
): RepeatedCause | undefined {
  if (story === undefined || story.merged !== undefined) return undefined;
  const refusal = story.write_guard?.repeat;
  const found = [
    testsRepeat(story),
    reviewRepeat(story),
    refusal !== undefined && refusal.count >= 2
      ? {
          cause: "refused" as const,
          times: refusal.count,
          what: truncate(`${refusal.rule}: ${refusal.path}`, WHAT_MAX),
          at: refusal.at,
        }
      : undefined,
    mergeRepeat(id, checkpoints),
    story.stall !== undefined && story.stall.count >= 2
      ? {
          cause: "stalled" as const,
          times: story.stall.count,
          what: story.stall.agent,
          at: story.stall.at,
        }
      : undefined,
  ]
    .filter((entry): entry is RepeatedCause => entry !== undefined)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const latest = found[0];
  if (latest === undefined) return undefined;
  const since = Date.parse(latest.at);
  const changed =
    (story.attempts ?? []).some(
      (record) => isHypothesis(record) && Date.parse(record.at) >= since,
    ) ||
    checkpoints.some(
      (checkpoint) => checkpoint.story === id && Date.parse(checkpoint.opened_at) >= since,
    );
  return changed ? undefined : latest;
}
