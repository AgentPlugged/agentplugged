import { z } from "zod";
import { hasControlCharacter } from "./deferred.js";
import { AgentIdSchema } from "./method-config.js";

/**
 * The retrospective and the memory of the product: at the end of
 * an epic or a sprint, an agent proposes lessons and actions to the creator (`propose_retrospective`),
 * who validates them in the chat. Approved lessons are recorded (`record_lessons`) as encrypted files
 * of `.agentplugged/memory/lessons/` and anchored in the journal; agents read them at the start of a
 * task (`read_memory`). A lesson useful to every product of the creator is promoted, one checkpoint
 * per promotion (`propose_promotion`, `promote_lesson`), to the common memory of the machine.
 *
 * No text of a lesson, of a retirement or of an action is ever in clear in the journal: the proposal
 * is a sensitive event (`memory.*`, encrypted with the product key), and the clear events and
 * checkpoints carry identifiers, counts and digests only.
 */

/** The sensitive event: the content of a retrospective, encrypted with the product key. */
export const MEMORY_EVENT_TYPES = {
  retrospectiveProposed: "memory.retrospective_proposed",
} as const;

/** The clear events: identifiers, counts and digests, never a text. */
export const LESSON_EVENT_TYPES = {
  recorded: "lessons.recorded",
  promoted: "lessons.promoted",
} as const;

/** Lessons, retirements and actions one retrospective holds, each at most. */
export const MAX_RETRO_ITEMS = 12;

/** Lessons a product keeps active, at most: what `read_memory` may have to serve. */
export const MAX_ACTIVE_LESSONS = 100;

/** The most lessons `read_memory` returns in one call, and its default. */
export const MAX_READ_LIMIT = 100;
export const DEFAULT_READ_LIMIT = 40;

/** How many of the last recorded retrospectives `read_memory` lists the actions of. */
export const RETRO_ACTIONS_SHOWN = 3;

/** `R-` then the last 10 characters of the ULID of the event that proposed the retrospective. */
export const RetroIdSchema = z.string().regex(/^R-[0-9A-HJKMNP-TV-Z]{10}$/, {
  message: "expected R- then 10 characters, for example R-7M2K9QX4TB",
});

/** `L-`, the retrospective's 10 characters, `-` and the lesson's rank (1 to 99). */
export const LessonIdSchema = z.string().regex(/^L-[0-9A-HJKMNP-TV-Z]{10}-[1-9][0-9]?$/, {
  message: "expected L-, 10 characters, - and a rank, for example L-7M2K9QX4TB-1",
});

/** `R-`, the retrospective's 10 characters, `-A` and the action's rank (1 to 99). */
export const ActionIdSchema = z.string().regex(/^R-[0-9A-HJKMNP-TV-Z]{10}-A[1-9][0-9]?$/, {
  message: "expected R-, 10 characters, -A and a rank, for example R-7M2K9QX4TB-A1",
});

/** `C-` then the last 10 characters of the promotion checkpoint's ULID. */
export const CommonLessonIdSchema = z.string().regex(/^C-[0-9A-HJKMNP-TV-Z]{10}$/, {
  message: "expected C- then 10 characters, for example C-7M2K9QX4TB",
});

/** A checkpoint id, as `CheckpointIdSchema` (not imported: `checkpoint.ts` imports this file). */
const CheckpointRef = z.string().regex(/^G-[0-9A-HJKMNP-TV-Z]{10}$/, {
  message: "expected G- then 10 characters, for example G-7M2K9QX4TB",
});

/** A sprint id, as `SprintIdSchema` (not imported: it would make an import cycle). */
const SprintRef = z.string().regex(/^S-[0-9A-HJKMNP-TV-Z]{10}$/, {
  message: "expected S- then 10 characters, for example S-7M2K9QX4TB",
});

/** The id of the retrospective proposed by the event `eventId`. */
export function retroIdOf(eventId: string): string {
  return `R-${eventId.slice(-10)}`;
}

/** The id of the lesson of rank `rank` (from 1) of the retrospective `retro`. */
export function lessonIdOf(retro: string, rank: number): string {
  return `L-${retro.slice(2)}-${rank}`;
}

/** The id of the action of rank `rank` (from 1) of the retrospective `retro`. */
export function actionIdOf(retro: string, rank: number): string {
  return `${retro}-A${rank}`;
}

/** The id of the common-memory entry a promotion checkpoint writes. */
export function commonIdOf(checkpoint: string): string {
  return `C-${checkpoint.slice(2)}`;
}

/** What a retrospective looks back on: an epic (its number), or a sprint. */
export const RetroScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("epic"), id: z.string().regex(/^[1-9][0-9]{0,3}$/) }),
  z.strictObject({ kind: z.literal("sprint"), id: SprintRef }),
]);
export type RetroScope = z.infer<typeof RetroScopeSchema>;

/** A scope as a readable label: `epic 4`, `sprint S-…`. */
export function scopeLabel(scope: RetroScope): string {
  return `${scope.kind} ${scope.id}`;
}

/** The title of a retrospective's checkpoint, and the one of a promotion's. */
export function retroTitle(scope: RetroScope): string {
  return `Retrospective: ${scopeLabel(scope)}`;
}
export const PROMOTION_TITLE = "Promote a lesson to the shared memory";

/**
 * What a `memory` checkpoint is about, in clear and without any content: set by the engine, never
 * by an agent. A retrospective names its scope; a promotion the lesson and the common entries it
 * replaces.
 */
export const MemoryRecordSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("retrospective"), scope: RetroScopeSchema }),
  z.strictObject({
    kind: z.literal("promotion"),
    lesson: LessonIdSchema,
    replaces: z.array(CommonLessonIdSchema).max(5).optional(),
  }),
]);
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

/** The decisions that approve a `memory` checkpoint. */
export const MEMORY_APPROVING_DECISIONS: ReadonlySet<string> = new Set([
  "approved",
  "approved_with_reservations",
]);

/**
 * True when `text` hides characters: Unicode format characters (zero-width, bidirectional marks,
 * the tag characters U+E0000 to U+E007F that models read and people do not see) and the line and
 * paragraph separators. A lesson every agent reads must show what it says.
 */
export function hasInvisibleCharacter(text: string): boolean {
  return /[\p{Cf}\u2028\u2029]/u.test(text);
}

/** A text of 1 to `max` characters, trimmed; line breaks and tabs only when `lines`. */
const text = (max: number, lines: boolean) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !hasControlCharacter(value, lines), {
      message: "expected no control character but line breaks and tabs",
    })
    .refine((value) => !hasInvisibleCharacter(value), {
      message: "expected no invisible character (zero-width, bidirectional, tag)",
    })
    .refine((value) => lines || !/[\r\n]/.test(value), { message: "expected a single line" });

/** A tag: lowercase letters, digits and hyphens. */
const TagSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
  message: "expected a lowercase tag of letters, digits and hyphens",
});
const agentId = AgentIdSchema.max(64);

const unique = <T extends z.ZodType<string>>(item: T, max: number, what: string) =>
  z
    .array(item)
    .max(max)
    .refine((items) => new Set(items).size === items.length, { message: `${what} must differ` });

/** A lesson as an agent proposes it. */
export const LessonDraftSchema = z.strictObject({
  title: text(120, false),
  text: text(1000, true),
  tags: unique(TagSchema.max(32), 5, "tags").optional(),
  /** The agents the lesson is for; absent: every agent. */
  agents: unique(agentId, 10, "agents").optional(),
  /** The active lessons of this product this one replaces (they stop being served once approved). */
  replaces: unique(LessonIdSchema, 5, "replaced lessons").optional(),
});
export type LessonDraft = z.infer<typeof LessonDraftSchema>;

/** A lesson that is no longer true. */
export const RetireDraftSchema = z.strictObject({
  lesson: LessonIdSchema,
  reason: text(300, true),
});
export type RetireDraft = z.infer<typeof RetireDraftSchema>;

/** A follow-up the team owes, and who it falls to (an agent, or `creator`). */
export const ActionDraftSchema = z.strictObject({
  text: text(300, true),
  owner: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(64)
    .optional(),
});
export type ActionDraft = z.infer<typeof ActionDraftSchema>;

const items = <T extends z.ZodType>(item: T) => z.array(item).max(MAX_RETRO_ITEMS).optional();

/**
 * Input of `propose_retrospective`: the scope, what the retrospective looked at, and the lessons,
 * retirements and actions it proposes (at least one of them).
 */
export const ProposeRetrospectiveInputSchema = z
  .strictObject({
    agent: agentId,
    scope: RetroScopeSchema,
    summary: text(1500, true),
    lessons: items(LessonDraftSchema),
    retire: items(RetireDraftSchema),
    actions: items(ActionDraftSchema),
  })
  .superRefine((value, context) => {
    if (
      (value.lessons?.length ?? 0) + (value.retire?.length ?? 0) + (value.actions?.length ?? 0) ===
      0
    ) {
      context.addIssue({
        code: "custom",
        path: ["lessons"],
        message: "propose at least a lesson, a retirement or an action",
      });
    }
  });
export type ProposeRetrospectiveInput = z.infer<typeof ProposeRetrospectiveInputSchema>;

/**
 * A lesson of a proposal as the engine keeps it: its draft and the salt of its digest. Its id is
 * drawn from the retrospective's (`lessonIdOf`) and its rank, never written in the payload (the
 * event's own id is not known when the payload is built).
 */
export const ProposedLessonSchema = LessonDraftSchema.extend({
  /** 32 random hexadecimal characters: makes the digest of a short lesson unguessable. */
  salt: z.string().regex(/^[0-9a-f]{32}$/),
});
export type ProposedLesson = z.infer<typeof ProposedLessonSchema>;

/**
 * `payload` of `memory.retrospective_proposed` (sensitive: written encrypted): the content of the
 * retrospective, and the checkpoint that submits it (set by the journal, the one opened just
 * before in the same write).
 */
export const RetrospectiveProposedPayloadSchema = z.strictObject({
  checkpoint: CheckpointRef,
  scope: RetroScopeSchema,
  summary: z.string().min(1).max(1500),
  lessons: z.array(ProposedLessonSchema).max(MAX_RETRO_ITEMS),
  retire: z.array(RetireDraftSchema).max(MAX_RETRO_ITEMS),
  actions: z.array(ActionDraftSchema).max(MAX_RETRO_ITEMS),
});
export type RetrospectiveProposedPayload = z.infer<typeof RetrospectiveProposedPayloadSchema>;

/** The SHA-256 of a lesson's record, in hexadecimal. */
const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** A lesson retired when a retrospective is recorded, and the lesson that replaced it, if any. */
export const RetiredLessonSchema = z.strictObject({
  lesson: LessonIdSchema,
  by: LessonIdSchema.optional(),
});
export type RetiredLesson = z.infer<typeof RetiredLessonSchema>;

/**
 * `payload` of `lessons.recorded` (clear: no text): the retrospective whose lessons were recorded,
 * each with the digest of its record, the lessons retired or replaced, and what the creator's
 * reservations left out.
 */
export const LessonsRecordedPayloadSchema = z.strictObject({
  checkpoint: CheckpointRef,
  retro: RetroIdSchema,
  lessons: z
    .array(z.strictObject({ id: LessonIdSchema, digest: DigestSchema }))
    .max(MAX_RETRO_ITEMS),
  retired: z.array(RetiredLessonSchema).max(MAX_RETRO_ITEMS + MAX_RETRO_ITEMS * 5),
  excepted: z.array(z.union([LessonIdSchema, ActionIdSchema])).max(MAX_RETRO_ITEMS * 3),
});
export type LessonsRecordedPayload = z.infer<typeof LessonsRecordedPayloadSchema>;

/** `payload` of `lessons.promoted` (clear): the promotion's checkpoint, the lesson and its entry. */
export const LessonsPromotedPayloadSchema = z.strictObject({
  checkpoint: CheckpointRef,
  lesson: LessonIdSchema,
  common: CommonLessonIdSchema,
});
export type LessonsPromotedPayload = z.infer<typeof LessonsPromotedPayloadSchema>;

/** Input of `record_lessons`: the approved retrospective's checkpoint, and what to leave out. */
export const RecordLessonsInputSchema = z.strictObject({
  agent: agentId,
  checkpoint: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(CheckpointRef),
  /**
   * What the creator's reservations leave out: lessons proposed, lessons the retrospective retires,
   * actions (`R-…-A1`). Required with reservations (empty when they leave nothing out), refused
   * with a whole approval.
   */
  except: unique(
    z.union([LessonIdSchema, ActionIdSchema]),
    MAX_RETRO_ITEMS * 3,
    "excepted items",
  ).optional(),
});
export type RecordLessonsInput = z.infer<typeof RecordLessonsInputSchema>;

/** Input of `read_memory`: the agent reading, tags to narrow to, and how many lessons at most. */
export const ReadMemoryInputSchema = z.strictObject({
  agent: agentId,
  tags: unique(TagSchema.max(32), 5, "tags").optional(),
  limit: z.number().int().min(1).max(MAX_READ_LIMIT).optional(),
});
export type ReadMemoryInput = z.infer<typeof ReadMemoryInputSchema>;

/** Input of `propose_promotion`: the lesson to promote, and the common entries it replaces. */
export const ProposePromotionInputSchema = z.strictObject({
  agent: agentId,
  lesson: LessonIdSchema,
  replaces: unique(CommonLessonIdSchema, 5, "replaced entries").optional(),
});
export type ProposePromotionInput = z.infer<typeof ProposePromotionInputSchema>;

/** Input of `promote_lesson`: the approved promotion's checkpoint. */
export const PromoteLessonInputSchema = z.strictObject({
  agent: agentId,
  checkpoint: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(CheckpointRef),
});
export type PromoteLessonInput = z.infer<typeof PromoteLessonInputSchema>;

/** Why a memory command refuses (`MEMORY_INVALID`); nothing is written. */
export const MEMORY_INVALID_REASONS = [
  /** An epic without a story file, or a sprint the journal does not know. */
  "unknown_scope",
  /** A story of the epic is not done, or the sprint is still running. */
  "scope_not_finished",
  /** A retrospective of this scope is open or approved already. */
  "scope_taken",
  /** A lesson to replace or retire is not active in this product. */
  "lesson_unknown",
  /** A lesson replaced or retired twice. */
  "lesson_conflict",
  /** The product would keep more than `MAX_ACTIVE_LESSONS` active lessons. */
  "memory_full",
  /** The checkpoint is no `memory` checkpoint of the right kind, or the engine does not know it. */
  "unknown_checkpoint",
  /** The creator did not approve the checkpoint (open, refused, or another decision). */
  "not_approved",
  /** The retrospective's lessons were recorded already (a repair only rewrites missing files). */
  "already_recorded",
  /** `except` names no lesson of the proposal. */
  "except_unknown",
  /** Reservations give `except`, empty when they leave nothing out. */
  "except_required",
  /** `except` with a whole approval: only reservations leave something out. */
  "except_not_allowed",
  /** The lesson's file does not decrypt, or does not match its digest. */
  "lesson_altered",
  /** An entry of the common memory of this lesson is active here already. */
  "already_promoted",
  /** A promotion of this lesson waits for the creator. */
  "promotion_pending",
  /** A common entry to replace does not exist, or is not active. */
  "common_unknown",
  /** The machine key is missing: the common memory cannot be read nor written here. */
  "common_unavailable",
] as const;
export type MemoryInvalidReason = (typeof MEMORY_INVALID_REASONS)[number];

/** The warnings of `read_memory`: stable codes. */
export const MEMORY_WARNINGS = [
  "product_key_missing",
  "lesson_missing",
  "lesson_altered",
  "lessons_unvalidated",
  "keychain_unavailable",
  "common_unavailable",
  "common_altered",
  "truncated",
] as const;
export type MemoryWarningCode = (typeof MEMORY_WARNINGS)[number];
