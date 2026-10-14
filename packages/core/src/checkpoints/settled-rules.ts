import { type CheckpointCloseReason, PHASE_STEPS } from "@agentplugged/protocol";
import { KNOWLEDGE_BASE_WRITER } from "../docs/knowledge-base.js";
import { documentStep, isSkipped, skippedWithItsPhase } from "../journey/journey-rules.js";
import { isDocumentReview } from "../phases/phases.js";
import type { StoryState } from "../projection/agent-reducers.js";
import { storiesIn } from "../projection/agent-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { checkpointsOf } from "../projection/checkpoint-reducers.js";

/**
 * The points whose object is already settled, pure: a story merged (on the forge or by
 * the engine), a review done again after the point opened, a request a newer one replaces. Nobody
 * has to answer such a point, nor one about a step the creator skipped: the engine
 * closes it (`checkpoint.closed`) with the reason, and the
 * projection checks the reason with these same rules, so a point still waiting for something is
 * never closed. The creator is never shown a "ghost" point.
 *
 * Two more: a permission asked in the working copy of a story that no longer exists
 * (`worktree_gone`), and a permission that blocks nothing and has waited a day (`lapsed`). The
 * second is decided from the journal alone; the first needs the engine to have looked at the disk
 * (`gone`), which a projection cannot do: it checks the point's shape (a permission of a story still
 * unmerged). The point a blocked result opened closes with the start of its story (`block_lifted`,
 * by the projection itself, `closeLiftedBlocks`).
 */

type State = Readonly<Record<string, unknown>>;

/** How long a permission that blocks nothing may wait before it lapses. */
export const PERMISSION_LAPSE_MS = 24 * 60 * 60 * 1000;

/** What a reader knows beyond the journal when it asks whether a point is settled. */
export interface SettledContext {
  /** The clock, in milliseconds: the point of a permission lapses with time (`lapsed`). */
  readonly now?: number;
  /** Whether the working copy of a story is gone from the disk, as the engine read it. */
  readonly gone?: (story: string) => boolean;
}

/** A reason a point is settled, with the newer point that replaces it (`replaced`). */
export interface Settled {
  readonly reason: CheckpointCloseReason;
  readonly ref?: string;
}

/**
 * The points a story's merge settles: those the engine opened about the story (its merge, a
 * conflict, the review loop, the fast track, a blocked result), a request of the creator's about it
 * (`creator_action`) and an installation it waited for (`permission`). A document, the end of a
 * phase, a publication or a memory change that merely names the story is not about its merge.
 */
function settledByMerge(checkpoint: CheckpointState): boolean {
  const source = checkpoint.source;
  if (
    source === "merge" ||
    source === "merge_conflict" ||
    source === "review_loop" ||
    source === "attempt_limit" ||
    source === "fast_track" ||
    source === "forge_unlinked" ||
    source === "blocked_result"
  ) {
    return true;
  }
  return (
    checkpoint.type === "story" ||
    checkpoint.type === "creator_action" ||
    checkpoint.type === "permission"
  );
}

/**
 * Two requests of the creator that ask the same thing: the same action on the same story, whatever
 * the reason the agent gave.
 */
function sameCreatorAction(a: CheckpointState, b: CheckpointState): boolean {
  if (a.type !== "creator_action" || b.type !== "creator_action") return false;
  if (a.creator_action == null || b.creator_action == null) return false;
  const shape = (value: NonNullable<CheckpointState["creator_action"]>) => {
    const { reason: _reason, ...rest } = value as { reason?: unknown } & Record<string, unknown>;
    return JSON.stringify(rest);
  };
  return a.story === b.story && shape(a.creator_action) === shape(b.creator_action);
}

/** Two installations to validate that ask the same thing: same story, same request digest. */
function sameInstallation(a: CheckpointState, b: CheckpointState): boolean {
  return (
    a.source === "untrusted_action" &&
    b.source === "untrusted_action" &&
    a.request !== null &&
    b.request !== null &&
    a.story === b.story &&
    a.request.digest === b.request.digest
  );
}

/** Two merge checkpoints of the same story. */
function sameMerge(a: CheckpointState, b: CheckpointState): boolean {
  return a.source === "merge" && b.source === "merge" && a.story === b.story && a.story !== null;
}

/** The newer point that asks what `checkpoint` asks, whatever its state, or undefined. */
function replacementOf(
  checkpoint: CheckpointState,
  all: readonly CheckpointState[],
): CheckpointState | undefined {
  return all
    .filter(
      (other) =>
        other.id !== checkpoint.id &&
        other.opened_event > checkpoint.opened_event &&
        (sameCreatorAction(checkpoint, other) ||
          sameInstallation(checkpoint, other) ||
          sameMerge(checkpoint, other)),
    )
    .sort((a, b) => (a.opened_event < b.opened_event ? -1 : 1))
    .at(-1);
}

/**
 * Whether the review of the story was done again after the point opened: a pass closed since, and,
 * for the point of a review loop (the passes reached their limit), a pass that approved it.
 */
function reviewRedone(checkpoint: CheckpointState, story: StoryState | undefined): boolean {
  if (checkpoint.source !== "blocked_result" && checkpoint.source !== "review_loop") return false;
  const opened = Date.parse(checkpoint.opened_at);
  return (story?.review?.passes ?? []).some(
    (pass) =>
      pass.complete &&
      pass.completed_at !== null &&
      Date.parse(pass.completed_at) > opened &&
      (checkpoint.source === "blocked_result" || pass.outcome === "approved"),
  );
}

/** A permission point, which a story's working copy or a session asked for. */
function isPermission(checkpoint: CheckpointState): boolean {
  return checkpoint.type === "permission";
}

/**
 * Whether the point is about a step the creator skipped: the end of a skipped phase, the
 * review of a document whose step (or phase) is skipped, the proposal of a sprint when sprint
 * planning is, a retrospective when it is, the knowledge base's own reviews when it is. The point is
 * no longer anyone's to answer.
 */
function aboutSkippedStep(state: State, checkpoint: CheckpointState): boolean {
  if (checkpoint.type === "phase_end") {
    return checkpoint.phase !== null && isSkipped(state, PHASE_STEPS[checkpoint.phase]);
  }
  if (isDocumentReview(checkpoint)) {
    const steps = checkpoint.documents.flatMap((cited) => documentStep(cited.path)?.step ?? []);
    return steps.length > 0 && steps.every((step) => skippedWithItsPhase(state, step));
  }
  if (checkpoint.memory?.kind === "retrospective") return isSkipped(state, "retrospective");
  const sprints = (state.sprints as Record<string, { checkpoint: string }> | undefined) ?? {};
  if (Object.values(sprints).some((sprint) => sprint.checkpoint === checkpoint.id)) {
    return isSkipped(state, "sprint_planning");
  }
  return (
    checkpoint.opened_by === KNOWLEDGE_BASE_WRITER &&
    checkpoint.story === null &&
    checkpoint.blocks.length === 0 &&
    (checkpoint.type === "document" || checkpoint.type === "decision") &&
    isSkipped(state, "knowledge_base")
  );
}

/**
 * Whether `reason` holds for an open point (`ref`: the newer point of `replaced`), from the
 * projection's state: the writer picks a reason with `settledReason`, the projection checks it here.
 */
export function reasonHolds(
  state: State,
  checkpoint: CheckpointState,
  reason: CheckpointCloseReason,
  ref?: string,
  context: SettledContext = {},
): boolean {
  if (checkpoint.status !== "open") return false;
  const story = checkpoint.story === null ? undefined : storiesIn(state)[checkpoint.story];
  if (reason === "story_merged") {
    return story?.merged !== undefined && settledByMerge(checkpoint);
  }
  if (reason === "worktree_gone") {
    return (
      isPermission(checkpoint) &&
      story?.started !== undefined &&
      story.merged === undefined &&
      (context.gone === undefined || context.gone(checkpoint.story as string))
    );
  }
  if (reason === "lapsed") {
    const opened = Date.parse(checkpoint.opened_at);
    return (
      isPermission(checkpoint) &&
      (checkpoint.story === null || story?.started === undefined) &&
      // It blocks nothing: a permission that blocks an action is waited for, however long.
      checkpoint.blocks.length === 0 &&
      context.now !== undefined &&
      !Number.isNaN(opened) &&
      context.now - opened >= PERMISSION_LAPSE_MS
    );
  }
  if (reason === "review_redone") {
    return story?.merged === undefined && reviewRedone(checkpoint, story);
  }
  if (reason === "step_skipped") return aboutSkippedStep(state, checkpoint);
  if (ref === undefined) return false;
  const all = checkpointsOf(state);
  const newer = Object.hasOwn(all, ref) ? all[ref] : undefined;
  return (
    newer !== undefined &&
    replacementOf(checkpoint, [newer])?.id === newer.id &&
    // A story merged settles its points whatever replaced them: never `replaced` for that one.
    story?.merged === undefined
  );
}

/** Why an open point is settled, or undefined while it still waits for something. */
export function settledReason(
  state: State,
  checkpoint: CheckpointState,
  context: SettledContext = {},
): Settled | undefined {
  if (checkpoint.status !== "open") return undefined;
  if (reasonHolds(state, checkpoint, "story_merged")) return { reason: "story_merged" };
  if (reasonHolds(state, checkpoint, "review_redone")) return { reason: "review_redone" };
  if (reasonHolds(state, checkpoint, "step_skipped")) return { reason: "step_skipped" };
  // The disk is read only for a permission of a started story (`gone`: the engine asked it).
  if (
    context.gone !== undefined &&
    reasonHolds(state, checkpoint, "worktree_gone", undefined, context)
  ) {
    return { reason: "worktree_gone" };
  }
  if (reasonHolds(state, checkpoint, "lapsed", undefined, context)) return { reason: "lapsed" };
  const newer = replacementOf(checkpoint, Object.values(checkpointsOf(state)));
  if (newer !== undefined && reasonHolds(state, checkpoint, "replaced", newer.id)) {
    return { reason: "replaced", ref: newer.id };
  }
  return undefined;
}

/** Every open point of the projection that is settled, with its reason, oldest first. */
export function settledPoints(
  state: State,
  context: SettledContext = {},
): Array<Settled & { readonly checkpoint: string }> {
  const found: Array<Settled & { readonly checkpoint: string }> = [];
  const open = Object.values(checkpointsOf(state))
    .filter((checkpoint) => checkpoint.status === "open")
    .sort((a, b) => (a.opened_event < b.opened_event ? -1 : 1));
  for (const checkpoint of open) {
    const settled = settledReason(state, checkpoint, context);
    if (settled !== undefined) found.push({ checkpoint: checkpoint.id, ...settled });
  }
  return found;
}
