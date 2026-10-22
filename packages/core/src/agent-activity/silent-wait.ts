import { ErrorCode, type ResultStatus } from "@agentplugged/protocol";
import { statusAt } from "../checkpoints/resolution-rules.js";
import { AgentPluggedError } from "../errors.js";
import { isSkipped } from "../journey/journey-rules.js";
import { storyIn } from "../projection/agent-reducers.js";
import { checkpointsOf } from "../projection/checkpoint-reducers.js";
import { isStoryDeveloper, untriagedFindings } from "../review/review-rules.js";

/**
 * Nothing stops in silence: an agent that hands back a `partial` result while the work waits for
 * the creator (findings of its story's review it did not sort, or open questions it asks them)
 * must leave a checkpoint open for them, or the creator never sees that anything waits. A
 * `blocked` result opens its own checkpoint; a `complete` one waits for nobody.
 */

/** Why a partial result would wait in silence. */
export type SilentWait = "untriaged" | "waiting";

export interface ResultInput {
  readonly agent: string;
  readonly story?: string | undefined;
  readonly status: ResultStatus;
  readonly open_questions: readonly string[];
}

/**
 * The refusal of a partial result that leaves the creator's decision waiting with no checkpoint
 * open for them, or undefined. Open: a checkpoint of the story, or, without a story, one this agent
 * opened (a waiver past its deadline is open again).
 */
export function silentWaitProblem(
  input: ResultInput,
  state: Readonly<Record<string, unknown>>,
  now: number,
): AgentPluggedError | undefined {
  if (input.status !== "partial") return undefined;
  const story = input.story;
  const open = Object.values(checkpointsOf(state)).some(
    (checkpoint) =>
      (story === undefined ? checkpoint.opened_by === input.agent : checkpoint.story === story) &&
      statusAt(checkpoint, now) === "open",
  );
  if (open) return undefined;
  const entry = story === undefined ? undefined : storyIn(state, story);
  const untriaged =
    story !== undefined &&
    isStoryDeveloper(entry, input.agent) &&
    !isSkipped(state, "story_review", story)
      ? untriagedFindings(entry).length
      : 0;
  const reason: SilentWait | undefined =
    untriaged > 0 ? "untriaged" : input.open_questions.length > 0 ? "waiting" : undefined;
  if (reason === undefined) return undefined;
  return new AgentPluggedError(ErrorCode.DECISION_NOT_OPEN, `error.decision_not_open.${reason}`, {
    story: story ?? null,
    reason,
    untriaged,
  });
}
