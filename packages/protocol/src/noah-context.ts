import { z } from "zod";

/**
 * How heavy Noah's conversation is, as the tool reports it, and the order that makes him start a
 * clean one. Nothing here is estimated: the tokens are what the tool said it read for Noah's last
 * turn, and a tool that does not say is told as such.
 */

/**
 * The context size (tokens read at one turn) from which a clean conversation is proposed. A bare
 * Noah already reads about 60 000 tokens at his first turn because of the tool's own definitions,
 * so 100 000 is where a clean start spares tens of thousands of tokens at every message while the
 * tool's own compaction (near the end of its window) is still far away.
 */
export const CONTEXT_PROPOSE_TOKENS = 100_000;

/**
 * The least a clean start must spare, in tokens at each message, to be worth proposing at all
 * (before a story, or at the threshold): below it the creator would lose the thread for nothing.
 */
export const CONTEXT_MIN_SAVING_TOKENS = 20_000;

/** After « later », the proposal comes back only once the conversation grew by this many tokens. */
export const CONTEXT_LATER_STEP_TOKENS = 25_000;

/** The most tokens a reading may carry (a sanity bound, far above any window). */
export const CONTEXT_TOKENS_MAX = 100_000_000;

/** Why a clean conversation is proposed: the threshold was reached, or a story is about to start. */
export const CONTEXT_ADVICES = ["threshold", "before_story"] as const;
export type ContextAdvice = (typeof CONTEXT_ADVICES)[number];

/**
 * What the live reading tells of Noah's context. `measure`: `ready` (the tool gave the tokens of
 * his last turn), `pending` (the conversation has no turn measured yet) or `unavailable` (the
 * tool does not give them).
 */
export const LiveContextSchema = z.strictObject({
  measure: z.enum(["ready", "pending", "unavailable"]),
  /** Tokens read at Noah's last turn, in the conversation itself (his sub-agents excluded). */
  tokens: z.number().int().min(0).max(CONTEXT_TOKENS_MAX).optional(),
  /** The window of his model, as the tool announced it; absent when it did not. */
  window: z.number().int().min(1).max(CONTEXT_TOKENS_MAX).optional(),
  /** Tokens read at the first turn of this conversation: what a clean one costs. */
  opening: z.number().int().min(0).max(CONTEXT_TOKENS_MAX).optional(),
  /** The threshold from which a clean conversation is proposed. */
  threshold: z.number().int().min(1).max(CONTEXT_TOKENS_MAX),
  /** Set when a clean conversation is worth proposing now. */
  advice: z.enum(CONTEXT_ADVICES).optional(),
  /** Tokens a clean conversation spares at each message (tokens minus opening). */
  saving: z.number().int().min(0).max(CONTEXT_TOKENS_MAX).optional(),
  /** The story about to start, for the `before_story` advice. */
  story: z.string().min(1).max(32).optional(),
  /** A short fingerprint of the conversation, so a view can remember « later » for this one only. */
  session: z.string().min(1).max(32).optional(),
});
export type LiveContext = z.infer<typeof LiveContextSchema>;

/** The order of a device that makes Noah start a clean conversation (a new session of the tool). */
export const ORDER_TYPE_NOAH_FRESH = "noah.fresh";

/** The order takes no parameter: it acts on the conversation of the product. */
export const NoahFreshParamsSchema = z.strictObject({});
export type NoahFreshParams = z.infer<typeof NoahFreshParamsSchema>;

/** The codes the machine answers `noah.fresh` with when it cannot: Noah is answering, or nothing to leave. */
export const NOAH_FRESH_CODES = {
  BUSY: "FRESH_BUSY",
  NONE: "FRESH_NONE",
} as const;
export type NoahFreshCode = (typeof NOAH_FRESH_CODES)[keyof typeof NOAH_FRESH_CODES];
