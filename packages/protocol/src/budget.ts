import { z } from "zod";
import { CheckpointIdSchema } from "./checkpoint.js";
import { BUDGET_EXCEED_MODES, MIN_ALERT_RATIO } from "./method-config.js";

/**
 * Budgets: each story's ceiling comes from the journal (the last sprint approved that
 * holds it, or the creator's answer to a budget checkpoint); its cost from the agents' declared
 * costs (`cost.reported`, encrypted). When a declared cost reaches the alert ratio, or goes over
 * the ceiling, `core` writes `budget.threshold_reached` (no amount of cost in it), right after
 * that cost in the same write. Over the ceiling, with `on_exceed: block`, it opens a budget
 * checkpoint in between, and the story's write tools answer `BUDGET_EXCEEDED` until the creator
 * answers it.
 */

/** Event types of budgets, each at version 1. */
export const BUDGET_EVENT_TYPES = {
  thresholdReached: "budget.threshold_reached",
} as const;

/** The thresholds a story's cost may reach: the alert ratio, then the ceiling itself. */
export const BUDGET_LEVELS = ["alert", "exceeded"] as const;
export type BudgetLevel = (typeof BUDGET_LEVELS)[number];

/** The largest ceiling, in US dollars (raising a ceiling stops there). */
export const MAX_BUDGET_USD = 1_000_000_000;

/**
 * The options of a budget checkpoint: raise the ceiling by half (at least to $1), double it (at
 * least to $2), go on without a ceiling, or stop the story. A raise that would change nothing (at
 * `MAX_BUDGET_USD`) is never offered.
 */
export const BUDGET_OPTIONS = ["raise-50", "raise-100", "no-limit", "stop"] as const;
export type BudgetOption = (typeof BUDGET_OPTIONS)[number];

/** The option a budget checkpoint recommends when it offers it (else `stop`). */
export const BUDGET_RECOMMENDATION: BudgetOption = "raise-50";

/** The prefix of a budget checkpoint's title, before the story. */
export const BUDGET_TITLE_PREFIX = "Budget exceeded: ";

/**
 * The source of a ceiling: the sprint (`S-…`) whose approval set it, or the budget checkpoint
 * (`G-…`) whose answer did. A threshold counts only for the ceiling it names.
 */
export const CeilingIdSchema = z.string().regex(/^[SG]-[0-9A-HJKMNP-TV-Z]{10}$/, {
  message: "expected the id of a sprint (S-…) or of a checkpoint (G-…)",
});

/**
 * `payload` of `budget.threshold_reached`: the level reached, the ceiling it was measured against
 * (its amount and its source, never the cost), the settings in force, and the budget checkpoint
 * opened just before it in the same write (`exceeded` under `block` only; absent when one is
 * already open).
 */
export const BudgetThresholdReachedPayloadSchema = z
  .strictObject({
    level: z.enum(BUDGET_LEVELS),
    budget_usd: z.number().finite().min(0).max(MAX_BUDGET_USD),
    ceiling: CeilingIdSchema,
    alert_ratio: z.number().finite().min(MIN_ALERT_RATIO).max(1),
    on_exceed: z.enum(BUDGET_EXCEED_MODES),
    checkpoint: CheckpointIdSchema.optional(),
  })
  .superRefine((value, context) => {
    if (
      value.checkpoint !== undefined &&
      (value.level !== "exceeded" || value.on_exceed !== "block")
    ) {
      context.addIssue({
        code: "custom",
        path: ["checkpoint"],
        message: "a checkpoint goes only with an exceeded level under block",
      });
    }
  });
export type BudgetThresholdReachedPayload = z.infer<typeof BudgetThresholdReachedPayloadSchema>;
