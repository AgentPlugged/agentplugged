import { z } from "zod";
import { StoryIdSchema } from "./agent-activity.js";
import { CHECKPOINT_STATUSES, CHECKPOINT_TYPES, CheckpointIdSchema } from "./checkpoint.js";
import { ULID_PATTERN } from "./event-envelope.js";
import { AgentIdSchema } from "./method-config.js";

/**
 * The input of `get_state`: nothing for the abridged state, or ONE option to read a
 * part of it in full. The abridged state never exceeds what an AI tool accepts of a tool's output
 * (about 50 000 characters); the options give the detail it cuts.
 */

/** The most checkpoints one page of `checkpoints` holds. */
export const MAX_CHECKPOINTS_PAGE = 30;
/** The most delegations one page of `delegations` holds. */
export const MAX_DELEGATIONS_PAGE = 10;

/** A page of checkpoints, newest first: filtered by status, type or story, before an id. */
export const StateCheckpointsInputSchema = z.strictObject({
  status: z.enum(CHECKPOINT_STATUSES).optional(),
  type: z.enum(CHECKPOINT_TYPES).optional(),
  story: StoryIdSchema.optional(),
  limit: z.number().int().min(1).max(MAX_CHECKPOINTS_PAGE).optional(),
  before: CheckpointIdSchema.optional(),
});

/** A page of Noah's handovers, newest first, before the id of one. */
export const StateDelegationsInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(MAX_DELEGATIONS_PAGE).optional(),
  before: z.string().regex(ULID_PATTERN, { message: "expected the id of a delegation" }).optional(),
});

/** The options of `get_state`: at most one. */
export const STATE_OPTIONS = [
  "checkpoint",
  "checkpoints",
  "agent",
  "story",
  "delegations",
  "full",
] as const;
export type StateOption = (typeof STATE_OPTIONS)[number];

export const GetStateInputSchema = z
  .strictObject({
    checkpoint: CheckpointIdSchema.optional(),
    checkpoints: StateCheckpointsInputSchema.optional(),
    agent: AgentIdSchema.optional(),
    story: StoryIdSchema.optional(),
    delegations: StateDelegationsInputSchema.optional(),
    /** The whole abridged state (the previous default), for what the summary leaves out. */
    full: z.literal(true).optional(),
  })
  .superRefine((input, context) => {
    const given = STATE_OPTIONS.filter((option) => input[option] !== undefined);
    if (given.length > 1) {
      context.addIssue({
        code: "custom",
        path: [given[1] as string],
        message: `one option at a time (${given.join(", ")} given)`,
      });
    }
  });
export type GetStateInput = z.infer<typeof GetStateInputSchema>;
