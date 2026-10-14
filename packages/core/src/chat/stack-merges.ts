import type { MethodConfig, ProjectionState } from "@agentplugged/protocol";
import type { CommandContext } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { currentOrder } from "../merge/merge-guards.js";
import { type MergeDone, mergeStory } from "../merge/story-merge.js";
import type { StoryMerged, StoryState } from "../projection/agent-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { isMergeCheckpoint } from "../projection/merge-reducers.js";
import { mergeHead } from "../review/merge-head.js";

/**
 * The merges of a stack answered once: the stories whose merge point the creator
 * approves together are merged by the engine one after the other, in the order of the graph of the
 * stories (their dependencies first), then written in the same write as the answer. Nothing here
 * writes: the forge is asked before the write, as for one story (`mergeStory`), and a merge that
 * fails leaves its point open while the others go through.
 */

/** What the forge did for the merge points of a stack. */
export interface StackMerges {
  /** The merges done (or found done on the forge), by merge checkpoint, in the order of the graph. */
  readonly done: ReadonlyMap<string, MergeDone>;
  /** The merges that failed, by merge checkpoint: their point stays open. */
  readonly failed: ReadonlyMap<string, AgentPluggedError>;
}

/** No merge to do. */
export const NO_MERGES: StackMerges = { done: new Map(), failed: new Map() };

type State = ProjectionState["state"];

/** The state as if `merge` were written: its story is merged, so the next one sees it done. */
function withMerged(state: State, merge: MergeDone, at: string): State {
  const stories = (state.stories as Record<string, StoryState> | undefined) ?? {};
  const story = Object.hasOwn(stories, merge.story) ? stories[merge.story] : undefined;
  if (story === undefined) return state;
  const merged: StoryMerged = {
    checkpoint: merge.checkpoint,
    forge: merge.forge,
    pr: merge.pr,
    url: merge.url,
    into: merge.direct?.into ?? null,
    commit: merge.commit,
    merge_commit: merge.merge_commit,
    method: merge.method,
    files: merge.files,
    files_truncated: merge.files_truncated,
    source: "chat",
    already: merge.already,
    merged_by: null,
    by: null,
    at,
    event: "",
    seq: 0,
  };
  return { ...state, stories: { ...stories, [merge.story]: { ...story, merged } } };
}

/**
 * Merges the stories of the merge points of `points`, in the order of the graph: the ready stories'
 * order (dependencies first, then the sprint, then the opening of the point). The order check of
 * every merge sees the earlier ones of the stack as done. A point that is not a merge point is
 * left to the caller.
 */
export async function mergeStackPoints(
  context: CommandContext,
  config: MethodConfig,
  state: State,
  points: readonly CheckpointState[],
): Promise<StackMerges> {
  const merges = points.filter((point) => isMergeCheckpoint(point));
  if (merges.length === 0) return NO_MERGES;
  const { order } = await currentOrder(context, state);
  const place = (point: CheckpointState): number => {
    const entry = order.find((candidate) => candidate.story === point.story);
    return entry === undefined || entry.position === 0 ? Number.POSITIVE_INFINITY : entry.position;
  };
  const sorted = [...merges].sort(
    (a, b) =>
      place(a) - place(b) ||
      (a.opened_event < b.opened_event ? -1 : a.opened_event > b.opened_event ? 1 : 0),
  );
  const done = new Map<string, MergeDone>();
  const failed = new Map<string, AgentPluggedError>();
  const at = new Date((context.now ?? Date.now)()).toISOString();
  let working = state;
  for (const point of sorted) {
    const head = await mergeHead(context, working, point);
    const outcome = await mergeStory(context, config, working, point, head);
    if (outcome instanceof AgentPluggedError) {
      failed.set(point.id, outcome);
      continue;
    }
    done.set(point.id, outcome);
    working = withMerged(working, outcome, at);
  }
  return { done, failed };
}
