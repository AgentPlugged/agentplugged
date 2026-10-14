import type { CheckpointOpenedPayload } from "@agentplugged/protocol";
import { checkpointPayload, truncate } from "../checkpoints/checkpoint-rules.js";
import type { StoryState } from "../projection/agent-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { storyReviewDone } from "../review/review-rules.js";
import { isSkipped } from "./journey-rules.js";

/**
 * The merge point of a story whose review the creator skipped, pure. The merge point is
 * opened when a story's review is done; with the review skipped there is none to open it, so the
 * engine does it (written as the machine, like the closing of a settled point): the story in review
 * gets its point, held by its gate until its CI is green (or skipped), then shown to the creator.
 * It is never opened again for the same stay in review: a point the creator refused stays refused.
 */

type State = Readonly<Record<string, unknown>>;

/** A story that waits for its merge point, with what the creator skipped on its way. */
export interface DueMergePoint {
  readonly story: string;
  /** The checks of the gate the creator skipped, in words: `review`, `security`, `ci`. */
  readonly skipped: readonly string[];
}

/** True when a merge point was opened for the story since it went to review (open, or answered). */
function openedSince(checkpoints: readonly CheckpointState[], id: string, since: string): boolean {
  const from = Date.parse(since);
  return checkpoints.some(
    (checkpoint) =>
      checkpoint.type === "story" &&
      checkpoint.source === "merge" &&
      checkpoint.story === id &&
      !(Date.parse(checkpoint.opened_at) < from),
  );
}

/**
 * The stories in review that the engine opens a merge point for: the review skipped, or (a security
 * review the creator skipped while the quality review was in) the review closed by that skip, and no
 * merge point opened since the story went to review.
 */
export function dueMergePoints(state: State): DueMergePoint[] {
  const stories = (state.stories as Record<string, StoryState> | undefined) ?? {};
  const checkpoints = Object.values(
    (state.checkpoints as Record<string, CheckpointState> | undefined) ?? {},
  );
  const due: DueMergePoint[] = [];
  for (const [id, story] of Object.entries(stories)) {
    if (story.started === undefined || story.merged !== undefined) continue;
    if (story.status !== "in_review" || story.status_by === null) continue;
    const reviewSkipped = isSkipped(state, "story_review", id);
    const securitySkipped = isSkipped(state, "story_security", id);
    const ciSkipped = isSkipped(state, "story_ci", id);
    if (!reviewSkipped && !(securitySkipped && storyReviewDone(story, undefined, ciSkipped))) {
      continue;
    }
    if (openedSince(checkpoints, id, story.status_by.at)) continue;
    due.push({
      story: id,
      skipped: [
        ...(reviewSkipped ? ["review"] : securitySkipped ? ["security"] : []),
        ...(ciSkipped ? ["ci"] : []),
      ],
    });
  }
  return due.sort((a, b) => (a.story < b.story ? -1 : a.story > b.story ? 1 : 0));
}

/** What each skipped check is called in the creator's question. */
const WORDS: Readonly<Record<string, string>> = {
  review: "its independent review",
  security: "its security review",
  ci: "its CI",
};

/** The merge checkpoint the engine opens for such a story (source `merge`, a medium risk). */
export function skippedMergeCheckpoint(point: DueMergePoint): CheckpointOpenedPayload {
  const what = point.skipped.map((entry) => WORDS[entry] ?? entry).join(" and ");
  return {
    ...checkpointPayload({
      type: "story",
      risk: "medium",
      title: truncate(`Merge story ${point.story}`, 120),
      summary: truncate(
        `You skipped ${what} for story ${point.story}: it is ready to merge as it stands. Approve and the engine merges its pull request into the main branch with your forge's tool, then removes its worktree (a git revert of the merge undoes it); ask for changes to send it back to its developer with your note.`,
        2000,
      ),
    }),
    source: "merge" as const,
  };
}
