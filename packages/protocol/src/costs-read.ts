import { z } from "zod";

/**
 * Reading what a product cost, through its machine's bridge: the shape the request and the answer
 * of the file reading carry (`costs`).
 *
 * The bridge reads the measures the engine wrote in the journal (tokens, models, time, the part of
 * each session that served one work of one agent in one phase) and prices them at a dated table of
 * the API's public prices; the device only draws what is below. A figure is never guessed: an amount
 * is `real` (every model of the figure has a price), `partial` (some model has none: the amount
 * leaves it out and the model is named) or `unknown` (no amount at all, only tokens and time).
 * What the agents declared on their own (`cost.reported`) is kept apart and never added to the
 * measured total, so that nothing is counted twice.
 *
 * Every text that comes from the journal (a title, an agent, a goal) is untrusted content that has
 * been through the secret guard; the device shows it as inert text. The device reads the answer
 * with the tolerant reader of the file reading; the request a bridge receives stays strict.
 */

/** The periods a report can cover: the day, 7 days, the sprint in force, 30 days, or everything. */
export const COST_PERIODS = ["today", "week", "sprint", "month", "all"] as const;
export type CostPeriod = (typeof COST_PERIODS)[number];

/** The most phases, works, agents, stories and sprints one answer carries. */
export const COSTS_PHASES_MAX = 12;
export const COSTS_WORKS_MAX = 60;
export const COSTS_AGENTS_MAX = 60;
export const COSTS_STORIES_MAX = 400;
export const COSTS_SPRINTS_MAX = 60;
export const COSTS_UNPRICED_MAX = 8;
/** The longest label of a work, goal or model, in characters. */
export const COSTS_LABEL_MAX_CHARS = 200;

/** How sure an amount is. A device shows a nature it does not know as `unknown`. */
export const COST_NATURES = ["real", "partial", "unknown"] as const;
export type CostNature = (typeof COST_NATURES)[number];

/** The request shape (without the identifier, the version and the product, which the file reading adds). */
export const CostsRequestFields = {
  op: z.literal("costs"),
  period: z.enum(COST_PERIODS).optional(),
} as const;

const Count = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

/** What a set of measured parts consumed, and what it costs at the table's prices. */
export const CostFiguresSchema = z.strictObject({
  /** The dollars of the models the table prices; absent when `nature` is `unknown`. */
  usd: z.number().min(0).max(100_000_000).optional(),
  nature: z.string().min(1).max(16),
  tokens_in: Count,
  tokens_out: Count,
  cache_read: Count,
  cache_write: Count,
  /** Working time, in milliseconds. */
  active_ms: Count,
  /** The models that have no price in the table (their tokens count, their dollars do not). */
  unpriced: z.array(z.string().min(1).max(100)).max(COSTS_UNPRICED_MAX),
});
export type CostFigures = z.infer<typeof CostFiguresSchema>;

/** The kinds of work a part can serve; a device shows a kind it does not know as a plain work. */
export const COST_WORK_KINDS = [
  "document",
  "checkpoint",
  "delegation",
  "story",
  "coordination",
  "session",
] as const;

export const CostWorkSchema = z.strictObject({
  kind: z.string().min(1).max(24),
  /** The file's name, the checkpoint, the story, ... that the work is about. */
  key: z.string().min(1).max(128),
  label: z.string().max(COSTS_LABEL_MAX_CHARS).optional(),
  /** The agent that did it; `noah` for the creator's conversation with Noah. */
  agent: z.string().min(1).max(64),
  story: z
    .string()
    .regex(/^[1-9]\d{0,5}-[1-9]\d{0,5}$/)
    .optional(),
  figures: CostFiguresSchema,
});
export type CostWork = z.infer<typeof CostWorkSchema>;

export const CostPhaseSchema = z.strictObject({
  /** The phase of the method; absent for what ran when no phase was current. */
  phase: z.string().min(1).max(32).optional(),
  figures: CostFiguresSchema,
  works: z.array(CostWorkSchema).max(COSTS_WORKS_MAX),
  /** True when the phase holds more works than listed (the figures count them all). */
  truncated: z.boolean(),
});
export type CostPhase = z.infer<typeof CostPhaseSchema>;

export const CostAgentSchema = z.strictObject({
  agent: z.string().min(1).max(64),
  figures: CostFiguresSchema,
});
export type CostAgent = z.infer<typeof CostAgentSchema>;

export const CostStorySchema = z.strictObject({
  story: z.string().regex(/^[1-9]\d{0,5}-[1-9]\d{0,5}$/),
  /** The sprint that carries it, when one does. */
  sprint: z.string().min(1).max(64).optional(),
  figures: CostFiguresSchema,
});
export type CostStory = z.infer<typeof CostStorySchema>;

export const CostSprintSchema = z.strictObject({
  id: z.string().min(1).max(64),
  goal: z.string().max(COSTS_LABEL_MAX_CHARS),
  /** Where the sprint stands (`in_force`, `superseded`, ...); a device shows an unknown one in neutral words. */
  status: z.string().min(1).max(24),
  stories: Count,
  /** The budget the sprint was planned with, in dollars. */
  budget_usd: z.number().min(0).max(100_000_000),
  figures: CostFiguresSchema,
});
export type CostSprint = z.infer<typeof CostSprintSchema>;

/** What the agents declared on their own, apart from the measure. */
export const CostDeclaredAgentSchema = z.strictObject({
  agent: z.string().min(1).max(64),
  /** Dollars declared as real, and as estimated. */
  usd: z.number().min(0).max(100_000_000),
  usd_estimated: z.number().min(0).max(100_000_000),
  tokens_in: Count,
  tokens_out: Count,
});
export type CostDeclaredAgent = z.infer<typeof CostDeclaredAgentSchema>;

export const CostDeclaredSchema = z.strictObject({
  usd: z.number().min(0).max(100_000_000),
  usd_estimated: z.number().min(0).max(100_000_000),
  tokens_in: Count,
  tokens_out: Count,
  agents: z.array(CostDeclaredAgentSchema).max(COSTS_AGENTS_MAX),
});
export type CostDeclared = z.infer<typeof CostDeclaredSchema>;

export const CostsDataSchema = z.strictObject({
  op: z.literal("costs"),
  period: z.string().min(1).max(16),
  /** The price table the dollars were computed with. */
  table: z.strictObject({
    version: z.string().min(1).max(32),
    as_of: z.string().min(1).max(32),
  }),
  /** False when no session was measured in the period: no figure, never a zero. */
  measured: z.boolean(),
  /** How many measured sessions the figures come from. */
  sessions: Count,
  total: CostFiguresSchema,
  phases: z.array(CostPhaseSchema).max(COSTS_PHASES_MAX),
  agents: z.array(CostAgentSchema).max(COSTS_AGENTS_MAX),
  stories: z.array(CostStorySchema).max(COSTS_STORIES_MAX),
  sprints: z.array(CostSprintSchema).max(COSTS_SPRINTS_MAX),
  /** Absent when no agent declared a cost (or the period is not `all`: declarations carry no date). */
  declared: CostDeclaredSchema.optional(),
  /** True when a list was cut at its limit (the totals count everything). */
  truncated: z.boolean(),
});
export type CostsData = z.infer<typeof CostsDataSchema>;
