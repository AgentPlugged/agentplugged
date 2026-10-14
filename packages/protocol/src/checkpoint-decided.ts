import { z } from "zod";
import { CHAT_DECISIONS } from "./chat.js";
import { CheckpointIdSchema } from "./checkpoint.js";
import { AgentIdSchema } from "./method-config.js";

/**
 * A point decided by the agent responsible for it. The creator keeps for
 * themselves the points they chose (`validation.points` of `method.yaml`); any other point is
 * decided by an agent, which says why. The decision is written as the agent (`actor.kind: agent`,
 * signed by the machine key), never as the creator: its source and its assurance are `agent`, so
 * the history, the morning summary and every surface always tell it apart from an answer of the
 * creator, and the creator can reopen it at any time.
 */

/** Event type of a point decided by an agent, at version 1. */
export const CHECKPOINT_DECIDED_EVENT_TYPES = {
  decided: "checkpoint.decided",
} as const;

/** The decisions an agent may take on a point: the chat's, never a waiver. */
export const DECIDED_DECISIONS = CHAT_DECISIONS;

/**
 * What `decide_checkpoint` may be given: a decision, or `escalate`, the agent handing the point back
 * to the creator with its reason when it cannot or should not decide it (a merge the forge refuses
 * and nobody can fix, a point it finds beyond its remit). The point then waits for the creator.
 */
export const DECIDE_CHOICES = [...DECIDED_DECISIONS, "escalate"] as const;
export type DecideChoice = (typeof DECIDE_CHOICES)[number];

const ShortIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/, {
  message: "expected 1 to 32 letters, digits, dots, hyphens or underscores",
});

/** Why the agent decided so: 1 to 1000 characters, recorded in the journal. */
export const DECISION_REASON_MAX = 1000;
const ReasonSchema = z.string().trim().min(1).max(DECISION_REASON_MAX);

function checkOption(
  value: { readonly decision: string; readonly option?: string | undefined },
  context: z.RefinementCtx,
): void {
  if ((value.decision === "option_chosen") !== (value.option !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["option"],
      message: "an option goes with option_chosen, and only with it",
    });
  }
}

/**
 * Input of `decide_checkpoint`: the agent that decides, the point, its decision and the reason.
 * `option` goes with `option_chosen` only.
 */
export const DecideCheckpointInputSchema = z
  .strictObject({
    agent: AgentIdSchema.max(64),
    checkpoint: z.string().trim().toUpperCase().pipe(CheckpointIdSchema),
    decision: z.enum(DECIDE_CHOICES),
    option: ShortIdSchema.optional(),
    reason: ReasonSchema,
  })
  .superRefine(checkOption);
export type DecideCheckpointInput = z.infer<typeof DecideCheckpointInputSchema>;

/** `payload` of `checkpoint.decided`: the point, the decision and the agent's reason. */
export const CheckpointDecidedPayloadSchema = z
  .strictObject({
    checkpoint: CheckpointIdSchema,
    decision: z.enum(DECIDE_CHOICES),
    option: ShortIdSchema.optional(),
    reason: ReasonSchema,
  })
  .superRefine(checkOption);
export type CheckpointDecidedPayload = z.infer<typeof CheckpointDecidedPayloadSchema>;
