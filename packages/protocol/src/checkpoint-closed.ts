import { z } from "zod";
import { CheckpointIdSchema } from "./checkpoint.js";

/**
 * A point closed by the engine itself: when what a checkpoint asks about is already
 * settled, nobody has to answer it. The engine writes `checkpoint.closed` with the reason, and the
 * projection checks the reason against the journal (a point that is still waiting for something is
 * never closed). The creator is never shown a point whose object is settled.
 */

/** Event type of the closing of a checkpoint by the engine, at version 1. */
export const CHECKPOINT_CLOSED_EVENT_TYPES = {
  closed: "checkpoint.closed",
} as const;

/**
 * Why the engine closed a checkpoint: `story_merged` (its story is merged, on the forge or by the
 * engine), `review_redone` (the story's review was done again after the point opened), `replaced`
 * (a newer request asks the same thing: `ref` names it), `step_skipped` (the creator skipped the
 * step the point was about: the end of a phase, a document, a sprint, a retrospective). `block_lifted` (a blocked
 * result's point whose cause is gone: the story started since), `worktree_gone` (a permission
 * asked in a story's working copy that no longer exists), `lapsed` (a permission that blocks
 * nothing and has waited more than a day: the session that asked is over).
 */
export const CHECKPOINT_CLOSE_REASONS = [
  "story_merged",
  "review_redone",
  "replaced",
  "step_skipped",
  "block_lifted",
  "worktree_gone",
  "lapsed",
] as const;
export type CheckpointCloseReason = (typeof CHECKPOINT_CLOSE_REASONS)[number];

/** `payload` of `checkpoint.closed`: the checkpoint, why, and the newer one for `replaced`. */
export const CheckpointClosedPayloadSchema = z
  .strictObject({
    checkpoint: CheckpointIdSchema,
    reason: z.enum(CHECKPOINT_CLOSE_REASONS),
    /** The checkpoint that replaces it: with `replaced`, and only with it. */
    ref: CheckpointIdSchema.optional(),
  })
  .refine((payload) => (payload.reason === "replaced") === (payload.ref !== undefined), {
    message: "a ref goes with replaced, and only with it",
    path: ["ref"],
  });
export type CheckpointClosedPayload = z.infer<typeof CheckpointClosedPayloadSchema>;
