import { z } from "zod";
import { StoryIdSchema } from "./agent-activity.js";
import { canonicalStoryId, hasControlCharacter } from "./deferred.js";
import { REQUIREMENT_ID_PATTERN } from "./document-header.js";
import { AgentIdSchema } from "./method-config.js";
import { CommitIdSchema } from "./story.js";

/**
 * Traceability and deviations. Each requirement of the PRD (`EF-n`, `ENF-n`) is linked,
 * at read time, to the stories that cite it, their pull requests, the tests that cite it and the
 * deviations recorded on it: nothing of that link is ever written in a document. A deviation is a
 * signed event of the journal: an agent (the QA reviewer) found the delivered work drifting from
 * requirements a started story cites. Its id, like an item of deferred work's, is `V-` then the
 * last 10 characters of the ULID of its event, never written in the `payload`, never reused.
 */

/** Event types of the deviations, each at version 1. */
export const DEVIATION_EVENT_TYPES = {
  reported: "deviation.reported",
  resolved: "deviation.resolved",
} as const;

/** Where a requirement stands: to do, in development, in review, delivered, or deviating. */
export const REQUIREMENT_STATUSES = [
  "todo",
  "in_development",
  "in_review",
  "delivered",
  "deviation",
] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

/** The requirements traced: the functional and non-functional ones of the PRD. */
export const TRACED_REQUIREMENT_PATTERN = /^(?:EF|ENF)-[1-9]\d*$/;

/** A traced requirement as typed (`ef-18`, with spaces): trimmed, in upper case, then checked. */
export const TracedRequirementInputSchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(
    z.string().regex(TRACED_REQUIREMENT_PATTERN, {
      message: "expected EF-n or ENF-n, for example EF-18",
    }),
  );

/** Requirements one deviation names, at most. */
export const MAX_DEVIATION_REQUIREMENTS = 20;

/** `V-` then the last 10 characters of the ULID of the event that reported the deviation. */
export const DeviationIdSchema = z.string().regex(/^V-[0-9A-HJKMNP-TV-Z]{10}$/, {
  message: "expected V- then 10 characters, for example V-7M2K9QX4TB",
});

/** An id as typed (`v-7m2k9qx4tb`, with spaces): trimmed and in upper case, then checked. */
export const DeviationIdInputSchema = z.string().trim().toUpperCase().pipe(DeviationIdSchema);

/** The id of the deviation reported by the event `eventId`: stable, never renumbered. */
export function deviationIdOf(eventId: string): string {
  return `V-${eventId.slice(-10)}`;
}

const NO_CONTROL = { message: "expected no control character" };

const SummarySchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((summary) => !/[\r\n]/.test(summary), { message: "expected a single line" })
  .refine((summary) => !hasControlCharacter(summary, false), NO_CONTROL);

const DetailSchema = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((detail) => !hasControlCharacter(detail, true), NO_CONTROL);

const ReasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine((reason) => !hasControlCharacter(reason, true), NO_CONTROL);

const RequirementIdSchema = z.string().regex(REQUIREMENT_ID_PATTERN, {
  message: "expected a requirement id (EF-n, ENF-n, PU-n, MS-n or AD-n)",
});

const requirementsOf = (id: z.ZodType<string>) =>
  z
    .array(id)
    .min(1)
    .max(MAX_DEVIATION_REQUIREMENTS)
    .refine((ids) => new Set(ids).size === ids.length, { message: "requirements must differ" });

/**
 * `payload` of `deviation.reported`. The story is the envelope's (required); `pr` is the number of
 * the story's pull request when the deviation was reported, set by the engine from the journal.
 */
export const DeviationReportedPayloadSchema = z.strictObject({
  requirements: requirementsOf(RequirementIdSchema),
  summary: SummarySchema,
  detail: DetailSchema.optional(),
  pr: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  /** The commit compared with the requirements. */
  commit: CommitIdSchema.optional(),
});
export type DeviationReportedPayload = z.infer<typeof DeviationReportedPayloadSchema>;

/** `payload` of `deviation.resolved`: the deviation, and how it was fixed or why it is lifted. */
export const DeviationResolvedPayloadSchema = z.strictObject({
  deviation: DeviationIdSchema,
  reason: ReasonSchema,
});
export type DeviationResolvedPayload = z.infer<typeof DeviationResolvedPayloadSchema>;

/** A requirement id as typed: in upper case, then checked. */
const RequirementInputSchema = z.string().trim().toUpperCase().pipe(RequirementIdSchema);

/** Input of `report_deviation`: the story brought to its canonical form. */
export const ReportDeviationInputSchema = z.strictObject({
  agent: AgentIdSchema.max(64),
  story: StoryIdSchema.overwrite(canonicalStoryId),
  requirements: requirementsOf(RequirementInputSchema),
  summary: SummarySchema,
  detail: DetailSchema.optional(),
  commit: CommitIdSchema.optional(),
});
export type ReportDeviationInput = z.infer<typeof ReportDeviationInputSchema>;

/** Input of `lift_deviation`: the agent that reported it lifts it, with why. */
export const ResolveDeviationInputSchema = z.strictObject({
  agent: AgentIdSchema.max(64),
  deviation: DeviationIdInputSchema,
  reason: ReasonSchema,
});
export type ResolveDeviationInput = z.infer<typeof ResolveDeviationInputSchema>;

/** The reason the creator gives at the terminal (`trace resolve`). */
export const DeviationReasonSchema = ReasonSchema;

/** Input of `get_trace`: one requirement, or every one when absent. */
export const GetTraceInputSchema = z.strictObject({
  requirement: z.string().max(32).optional(),
});
export type GetTraceInput = z.infer<typeof GetTraceInputSchema>;

/** Why a deviation cannot be reported (`DEVIATION_NOT_REPORTABLE`). */
export const DEVIATION_NOT_REPORTABLE_REASONS = [
  "unknown_story",
  "not_linked",
  "not_started",
  "done",
] as const;
export type DeviationNotReportableReason = (typeof DEVIATION_NOT_REPORTABLE_REASONS)[number];
