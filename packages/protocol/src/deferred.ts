import { z } from "zod";
import { StoryIdSchema } from "./agent-activity.js";
import { AgentIdSchema, PHASE_IDS } from "./method-config.js";

/**
 * The register of deferred work: a review finding sorted « defer », or a point put
 * off on purpose, recorded in the journal with a stable id (`D-` then the last 10 characters of
 * the ULID of its event, never written in the `payload`, never reused). An open item may lock
 * stories: a locked story neither starts nor merges until the item is done or dropped.
 */

/** Event types of the register, each at version 1. */
export const DEFERRED_EVENT_TYPES = {
  recorded: "deferred.recorded",
  closed: "deferred.closed",
} as const;

/** Where an item comes from: a review finding sorted « defer », or a deliberate deferral. */
export const DEFERRED_ORIGINS = ["review", "deliberate"] as const;
export type DeferredOrigin = (typeof DEFERRED_ORIGINS)[number];

/** How an item was closed: done (treated), or dropped (only by the creator). */
export const DEFERRED_OUTCOMES = ["done", "dropped"] as const;
export type DeferredOutcome = (typeof DEFERRED_OUTCOMES)[number];

/** Stories one item locks, at most. */
export const MAX_DEFERRED_LOCKS = 50;

/** `D-` then the last 10 characters of the ULID of the event that recorded the item. */
export const DeferredIdSchema = z.string().regex(/^D-[0-9A-HJKMNP-TV-Z]{10}$/, {
  message: "expected D- then 10 characters, for example D-7M2K9QX4TB",
});

/** An id as typed (`d-7m2k9qx4tb`, with spaces): trimmed and in upper case, then checked. */
export const DeferredIdInputSchema = z.string().trim().toUpperCase().pipe(DeferredIdSchema);

/** The id of the item recorded by the event `eventId`: stable, never renumbered. */
export function deferredIdOf(eventId: string): string {
  return `D-${eventId.slice(-10)}`;
}

/**
 * True when `text` holds a control character (C0, DEL, C1: ANSI escapes among them), line breaks
 * and tabs aside when `lines` allows them.
 */
export function hasControlCharacter(text: string, lines: boolean): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (lines && (code === 0x09 || code === 0x0a || code === 0x0d)) continue;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

const NO_CONTROL = { message: "expected no control character" };

const TitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((title) => !/[\r\n]/.test(title), { message: "expected a single line" })
  .refine((title) => !hasControlCharacter(title, false), NO_CONTROL);

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

/** Who treats the item: an agent, or `creator` (the same format as a document's `owner`). */
const OwnerSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/** A story id in its canonical form: no leading zero (`2-6`, never `02-06`). */
export function canonicalStoryId(id: string): string {
  return id
    .split("-")
    .map((part) => String(Number(part)))
    .join("-");
}

/** Compares two story ids by their numbers (`2-9` before `2-10`): the reading order. */
export function compareStoryIds(a: string, b: string): number {
  const [ae = 0, as = 0] = a.split("-").map(Number);
  const [be = 0, bs = 0] = b.split("-").map(Number);
  return ae - be || as - bs || (a < b ? -1 : a > b ? 1 : 0);
}

/** A story id an item records: canonical only. */
const RecordedStoryIdSchema = StoryIdSchema.refine((id) => canonicalStoryId(id) === id, {
  message: "expected a canonical story id, without leading zeros",
});

/** A story id as typed: brought to its canonical form. */
const StoryIdInputSchema = StoryIdSchema.overwrite(canonicalStoryId);

const locksOf = (story: z.ZodType<string>) =>
  z
    .array(story)
    .max(MAX_DEFERRED_LOCKS)
    .refine((locks) => new Set(locks).size === locks.length, { message: "locks must differ" });

/**
 * `payload` of `deferred.recorded`. The story the item comes from is the envelope's `story`
 * (required for a review finding).
 */
export const DeferredRecordedPayloadSchema = z.strictObject({
  title: TitleSchema,
  detail: DetailSchema.optional(),
  origin: z.enum(DEFERRED_ORIGINS),
  owner: OwnerSchema,
  /** The stories the item locks while open, canonical: none start nor merge. */
  locks: locksOf(RecordedStoryIdSchema),
  /** The phase to treat it in: a hint, nothing enforces it. */
  phase: z.enum(PHASE_IDS).optional(),
});
export type DeferredRecordedPayload = z.infer<typeof DeferredRecordedPayloadSchema>;

/** `payload` of `deferred.closed`: the item, how it was closed, and why. */
export const DeferredClosedPayloadSchema = z.strictObject({
  item: DeferredIdSchema,
  outcome: z.enum(DEFERRED_OUTCOMES),
  reason: ReasonSchema,
});
export type DeferredClosedPayload = z.infer<typeof DeferredClosedPayloadSchema>;

/** Input of `defer_work`: story ids brought to their canonical form. */
export const DeferWorkInputSchema = z
  .strictObject({
    agent: AgentIdSchema.max(64),
    title: TitleSchema,
    detail: DetailSchema.optional(),
    origin: z.enum(DEFERRED_ORIGINS),
    /** The story the item comes from: required for a review finding. */
    story: StoryIdInputSchema.optional(),
    /** Who treats it: the calling agent when absent (`creator` for `main`). */
    owner: OwnerSchema.optional(),
    locks: locksOf(StoryIdInputSchema).optional(),
    phase: z.enum(PHASE_IDS).optional(),
  })
  .refine((input) => input.origin !== "review" || input.story !== undefined, {
    message: "a review finding names its story",
    path: ["story"],
  });
export type DeferWorkInput = z.infer<typeof DeferWorkInputSchema>;

/** Input of `complete_deferred`: an agent marks an item done, with why. */
export const CompleteDeferredInputSchema = z.strictObject({
  agent: AgentIdSchema.max(64),
  item: DeferredIdInputSchema,
  reason: ReasonSchema,
});
export type CompleteDeferredInput = z.infer<typeof CompleteDeferredInputSchema>;

/** The reason of a closing, as the creator types it (`deferred resolve|drop`). */
export const DeferredReasonSchema = ReasonSchema;

/** What a locked story may not do: start, or merge. */
export const LOCKED_ACTIONS = ["start", "merge"] as const;
export type LockedAction = (typeof LOCKED_ACTIONS)[number];
