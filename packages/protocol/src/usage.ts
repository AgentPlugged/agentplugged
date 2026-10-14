import { z } from "zod";
import { StoryIdSchema } from "./agent-activity.js";
import { AgentIdSchema, PHASE_IDS } from "./method-config.js";

/**
 * What the engine measures of an AI tool's sessions: the tokens, the models and the
 * time of a session, read in the traces the tool keeps on the machine (Claude Code's transcripts
 * first). The measure is the engine's own: an agent never writes it, and what an agent declares
 * with `report_cost` stays an indication. The event holds no money: a dollar amount is computed
 * when it is shown, from a dated and versioned price table, so that a table that changes later
 * never rewrites the past.
 */

/** Event types of the measure, at version 1. */
export const USAGE_EVENT_TYPES = {
  measured: "usage.measured",
} as const;

/** The tools whose traces the engine knows how to read. */
export const USAGE_SOURCES = ["claude-code", "codex", "antigravity"] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

/**
 * How a session was tied to its story: `journal` (the agent that ran it wrote events on that
 * story while it ran), `label` (the session's own title names the story), `none` (the session
 * belongs to no story: the creator's own conversation, planning).
 */
export const USAGE_BASES = ["journal", "label", "none"] as const;
export type UsageBasis = (typeof USAGE_BASES)[number];

const Count = z.number().int().min(0).max(1_000_000_000_000);

/** The consumption of one model in one session. */
export const UsageModelSchema = z.strictObject({
  model: z.string().trim().min(1).max(100),
  /** Distinct answers of the model. */
  messages: Count,
  tokens_in: Count,
  tokens_out: Count,
  /** Tokens read from the prompt cache. */
  cache_read: Count,
  /** Tokens written to the prompt cache, all durations. */
  cache_write: Count,
  /** The part of `cache_write` kept one hour (priced higher than the five minutes). */
  cache_write_1h: Count,
});
export type UsageModel = z.infer<typeof UsageModelSchema>;

/** An identifier of a session in its tool's traces. */
export const UsageSessionSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/, {
  message: "expected 1 to 128 letters, digits, dots, colons, hyphens or underscores",
});

/**
 * What a part of a session was for, read from the journal by the engine: a `document`
 * the agent wrote (`key`: the file's name without extension, `prd`, `architecture`), a `checkpoint`
 * it opened for the creator (`key`: its id), a `delegation` Noah gave it (`key`: the event's id,
 * `label`: the start of the brief), a `story` it built or reviewed (`key`: the story id), the
 * `coordination` of the creator's conversation with Noah, or only the `session`'s own title when
 * the journal says nothing more.
 */
export const USAGE_WORK_KINDS = [
  "document",
  "checkpoint",
  "delegation",
  "story",
  "coordination",
  "session",
] as const;
export type UsageWorkKind = (typeof USAGE_WORK_KINDS)[number];

export const UsageWorkSchema = z.strictObject({
  kind: z.enum(USAGE_WORK_KINDS),
  key: z.string().trim().min(1).max(128),
  label: z.string().trim().min(1).max(200).optional(),
});
export type UsageWork = z.infer<typeof UsageWorkSchema>;

/**
 * Where the name of a step or of a skill comes from: `tool` (the AI tool's own trace
 * names it: Claude Code's `Skill` call), `interval` (the engine deduced it from an interval the
 * journal bounds: a skill an agent reported starting and stopping, a phase the creator approved the
 * end of, a story an agent built). A part with neither is unattributed: absent, never named by
 * guess, and its tokens are counted as unattributed, never as zero.
 */
export const USAGE_ORIGINS = ["tool", "interval"] as const;
export type UsageOrigin = (typeof USAGE_ORIGINS)[number];

/** The steps of the work a part can be attributed to: the `state.next` steps that name a kind of work. */
export const USAGE_STEPS = [
  "framing",
  "planning",
  "design",
  "build",
  "review",
  "delivery",
  "launch",
] as const;
export type UsageStep = (typeof USAGE_STEPS)[number];

/** A skill as the AI tool or the journal names it (a plug-in's `brand-voice:writer` included). */
export const UsageSkillNameSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/, {
  message: "expected 1 to 64 letters, digits, dots, colons, hyphens or underscores",
});

export const UsageStepAttributionSchema = z.strictObject({
  name: z.enum(USAGE_STEPS),
  origin: z.enum(USAGE_ORIGINS),
});
export const UsageSkillAttributionSchema = z.strictObject({
  name: UsageSkillNameSchema,
  origin: z.enum(USAGE_ORIGINS),
});
export type UsageStepAttribution = z.infer<typeof UsageStepAttributionSchema>;
export type UsageSkillAttribution = z.infer<typeof UsageSkillAttributionSchema>;

/**
 * One part of a measured session: the share of the session that served one work of
 * one agent in one phase. A conversation with Noah is cut where he handed the conversation over to
 * another agent (`agent.delegated`, `conversation`) and where that agent returned its result: the
 * PRD with Maya is a part, the rest is Noah's. A sub-agent's session is one part. The parts of a
 * session add up to its `models` and its `active_ms`. The phase is the one the journal's approved
 * `phase_end` checkpoints say was current when the part ran (absent when no phase was).
 */
export const UsagePartSchema = z.strictObject({
  agent: AgentIdSchema.max(64),
  phase: z.enum(PHASE_IDS).optional(),
  work: UsageWorkSchema,
  story: StoryIdSchema.optional(),
  /** The step and the skill the part is attributed to, with the origin of each. */
  step: UsageStepAttributionSchema.optional(),
  skill: UsageSkillAttributionSchema.optional(),
  started_at: z.string().datetime(),
  ended_at: z.string().datetime(),
  active_ms: Count,
  models: z.array(UsageModelSchema).max(16),
});
export type UsagePart = z.infer<typeof UsagePartSchema>;

/** The most parts a session is cut into. */
export const MAX_USAGE_PARTS = 200;

/**
 * `payload` of `usage.measured`: one session as the engine read it, whole. A later measure of the
 * same session (agent, story, session) replaces the earlier one, so measuring again never counts
 * twice. Sensitive: written encrypted with the product key, like the costs. The story is the
 * envelope's; written by the engine (`actor.kind: system`), never by an agent.
 */
export const UsageMeasuredPayloadSchema = z.strictObject({
  source: z.enum(USAGE_SOURCES),
  session: UsageSessionSchema,
  /** The agent that ran the session, or `main` for the creator's own conversation. */
  agent: AgentIdSchema.max(64),
  basis: z.enum(USAGE_BASES),
  started_at: z.string().datetime(),
  ended_at: z.string().datetime(),
  /** Time the session worked, in milliseconds: the gaps between two answers over five minutes do not count. */
  active_ms: Count,
  models: z.array(UsageModelSchema).max(16),
  /** What each part of the session served: absent on a measure made before it. */
  parts: z.array(UsagePartSchema).max(MAX_USAGE_PARTS).optional(),
});
export type UsageMeasuredPayload = z.infer<typeof UsageMeasuredPayloadSchema>;

/** Input of `measure_usage`: who asks, nothing else: the engine reads, the agent gives no figure. */
export const MeasureUsageInputSchema = z.strictObject({
  agent: AgentIdSchema.max(64),
});
export type MeasureUsageInput = z.infer<typeof MeasureUsageInputSchema>;
