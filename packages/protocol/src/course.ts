import { z } from "zod";
import { MAX_QUOTE_LENGTH } from "./chat.js";
import { hasControlCharacter } from "./deferred.js";
import { STORY_DOCUMENT_ID_PATTERN } from "./document-header.js";
import { AgentIdSchema } from "./method-config.js";

/**
 * The correction of course. The creator changes their mind on the way: a function
 * less, another rule, a new audience. The engine computes everything the change touches by the
 * trace (requirement, story, test, proof, decision, hypothesis, page of the base), and records it
 * as one short stack, sorted from the most structuring. The creator makes one gesture per element:
 * update it (its author does), retire it (the identifier stays, marked retired, never reused) or
 * keep it as it is (with a reason). A story under way that the change touches does not merge
 * before its decision. The course closes once the engine finds the documents, the stories and the
 * proofs coherent again.
 */

/** Event types, each at version 1. */
export const COURSE_EVENT_TYPES = {
  /** The change of course and the stack the engine computed (`actor.kind: agent`). */
  opened: "course.opened",
  /** The creator's gestures on elements of the stack, relayed by an agent with their words. */
  decided: "course.decided",
  /** The engine found everything coherent again. */
  closed: "course.closed",
} as const;

/** What one call of the action does. */
export const COURSE_STEPS = ["open", "show", "decide", "close"] as const;
export type CourseStep = (typeof COURSE_STEPS)[number];

/** True for a step of the action. */
export function isCourseStep(value: string): value is CourseStep {
  return (COURSE_STEPS as readonly string[]).includes(value);
}

/**
 * The kinds of element of a stack, from the most structuring to the least: an architecture
 * decision, a requirement, a passage of a document, a document that cites them, a story (under
 * way first), a criterion of a story, a hypothesis, a page of the knowledge base.
 */
export const COURSE_KINDS = [
  "decision",
  "requirement",
  "passage",
  "document",
  "story",
  "criterion",
  "hypothesis",
  "page",
] as const;
export type CourseKind = (typeof COURSE_KINDS)[number];

/** The three gestures of the creator on an element. */
export const COURSE_GESTURES = ["update", "retire", "keep"] as const;
export type CourseGesture = (typeof COURSE_GESTURES)[number];

/** Where a story stands when the course opens: not started, under way (started, not done), done. */
export const COURSE_STORY_STATUSES = ["todo", "in_progress", "done"] as const;
export type CourseStoryStatus = (typeof COURSE_STORY_STATUSES)[number];

/** The documents a passage can be named in (a heading or an identifier they hold). */
export const COURSE_DOCUMENTS = ["brief", "prd", "ux", "architecture", "spec"] as const;
export type CourseDocument = (typeof COURSE_DOCUMENTS)[number];

/** Elements a change names to start from, at most. */
export const MAX_COURSE_STARTS = 8;
/** Elements one stack holds, at most: the rest is counted, not asked. */
export const MAX_COURSE_STACK = 80;
/** Proofs a course names as stale, at most. */
export const MAX_COURSE_PROOFS = 20;

const NO_CONTROL = { message: "expected no control character" };

const lineText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((text) => !/[\r\n]/.test(text), { message: "expected a single line" })
    .refine((text) => !hasControlCharacter(text, false), NO_CONTROL);

/** `C-` then the last 10 characters of the ULID of the event that opened the course. */
export const CourseIdSchema = z.string().regex(/^C-[0-9A-HJKMNP-TV-Z]{10}$/, {
  message: "expected C- then 10 characters, for example C-7M2K9QX4TB",
});
export const CourseIdInputSchema = z.string().trim().toUpperCase().pipe(CourseIdSchema);

/** The id of the course opened by the event `eventId`: stable, never renumbered. */
export function courseIdOf(eventId: string): string {
  return `C-${eventId.slice(-10)}`;
}

/** What a start names: an identifier, a story, a criterion of a story or a passage of a document. */
export type CourseStart =
  | { readonly kind: "id"; readonly id: string }
  | { readonly kind: "story"; readonly story: string }
  | { readonly kind: "criterion"; readonly story: string; readonly n: number }
  | { readonly kind: "passage"; readonly document: CourseDocument; readonly passage: string };

const IDENTIFIER = /^(?:EF|ENF|PU|MS|AD)-[1-9]\d*$/i;

/**
 * Reads a start as the creator's agent writes it: `EF-3`, `AD-2`, a story `4-3`, a criterion
 * `4-3#2`, a passage `prd#Public cible` (a heading of the document, or an identifier it holds).
 * Undefined for anything else.
 */
export function parseCourseStart(text: string): CourseStart | undefined {
  const value = text.trim();
  if (IDENTIFIER.test(value)) return { kind: "id", id: value.toUpperCase() };
  if (STORY_DOCUMENT_ID_PATTERN.test(value)) return { kind: "story", story: value };
  const hash = value.indexOf("#");
  if (hash <= 0) return undefined;
  const head = value.slice(0, hash);
  const tail = value.slice(hash + 1).trim();
  if (tail === "") return undefined;
  if (STORY_DOCUMENT_ID_PATTERN.test(head) && /^[1-9]\d?$/.test(tail)) {
    return { kind: "criterion", story: head, n: Number(tail) };
  }
  const document = head.toLowerCase();
  if ((COURSE_DOCUMENTS as readonly string[]).includes(document)) {
    return { kind: "passage", document: document as CourseDocument, passage: tail };
  }
  return undefined;
}

/** One entry of `items`: the creator's gesture on an element of the stack, by its number. */
export const CourseGestureSchema = z.strictObject({
  n: z.number().int().min(1).max(MAX_COURSE_STACK),
  gesture: z.enum(COURSE_GESTURES),
  /** Required to keep an element as it is. */
  reason: lineText(300).optional(),
});
export type CourseDecision = z.infer<typeof CourseGestureSchema>;

/**
 * Input of the action `plan.course`, one flat shape for four steps:
 * - open: `starts` (what the change touches, 1 to 8, see `parseCourseStart`), `summary` (the
 *   change, one line) and the creator's `quote`; the engine computes the impact.
 * - show: `item` C-… alone: what is left to decide.
 * - decide: `item` C-…, `items` (one gesture per element) and the creator's `quote`.
 * - close: `item` C-… and `step` close: the engine checks the documents, stories and proofs.
 */
export const CourseInputSchema = z.strictObject({
  agent: AgentIdSchema.max(64),
  // Checked against the four steps, but published as a plain string: the tool list stays short.
  step: z.string().refine(isCourseStep, { message: `expected ${COURSE_STEPS.join(", ")}` }),
  item: CourseIdInputSchema.optional(),
  summary: lineText(300).optional(),
  starts: z.array(lineText(140)).min(1).max(MAX_COURSE_STARTS).optional(),
  items: z.array(CourseGestureSchema).min(1).max(MAX_COURSE_STACK).optional(),
  quote: z.string().max(MAX_QUOTE_LENGTH).trim().min(1).optional(),
});
export type CourseInput = z.infer<typeof CourseInputSchema>;

/** One element of the stack as the journal keeps it. */
export const CourseEntrySchema = z.strictObject({
  kind: z.enum(COURSE_KINDS),
  /** What it is: an identifier, a story, `story#n`, a path, `path#heading`. */
  ref: lineText(160),
  /** Why the change touches it, one line. */
  why: lineText(200),
  /** A story: where it stood when the course opened. */
  status: z.enum(COURSE_STORY_STATUSES).optional(),
  /** A story under way: the agent that builds it, who is told. */
  developer: AgentIdSchema.max(64).optional(),
  /** A requirement or a decision: a mark of its text when the course opened. */
  sig: z
    .string()
    .regex(/^[0-9a-f]{12}$/)
    .optional(),
  /** The agent that writes the update, from the header of the document. */
  owner: AgentIdSchema.max(64).optional(),
});
export type CourseEntry = z.infer<typeof CourseEntrySchema>;

/** `payload` of `course.opened`. */
export const CourseOpenedPayloadSchema = z.strictObject({
  summary: lineText(300),
  quote: z.string().max(MAX_QUOTE_LENGTH).trim().min(1),
  starts: z.array(lineText(140)).min(1).max(MAX_COURSE_STARTS),
  stack: z.array(CourseEntrySchema).min(1).max(MAX_COURSE_STACK),
  /** Elements the stack could not hold: counted, not asked. */
  more: z.number().int().min(0).max(100_000),
  /** The requirements whose proof the change makes stale. */
  proofs: z.array(lineText(40)).max(MAX_COURSE_PROOFS),
});
export type CourseOpenedPayload = z.infer<typeof CourseOpenedPayloadSchema>;

/** `payload` of `course.decided`. */
export const CourseDecidedPayloadSchema = z.strictObject({
  course: CourseIdSchema,
  decisions: z.array(CourseGestureSchema).min(1).max(MAX_COURSE_STACK),
  quote: z.string().max(MAX_QUOTE_LENGTH).trim().min(1),
});
export type CourseDecidedPayload = z.infer<typeof CourseDecidedPayloadSchema>;

/** `payload` of `course.closed`. */
export const CourseClosedPayloadSchema = z.strictObject({
  course: CourseIdSchema,
});
export type CourseClosedPayload = z.infer<typeof CourseClosedPayloadSchema>;
