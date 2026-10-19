import { z } from "zod";
import { ULID_PATTERN } from "./event-envelope.js";

/**
 * Consulting the knowledge base of a product and asking it a question, through its machine's
 * bridge: the shapes the requests and the answers of the file reading carry (`kb`, `ask`).
 *
 * The pages are read by the bridge in the product's folder, like any document. A question is
 * answered by the creator's own AI tool on their machine, from the few passages of the base the
 * bridge picked for it; the bridge then checks every citation against the real files and sends
 * only the statements that hold. Everything that comes from a page or from the model is untrusted
 * content that has been through the secret guard; the device shows it as inert text.
 *
 * A question can last longer than one request may wait: the device chooses an `ask` identifier,
 * and asks again with the same one until the state is no longer `working`.
 *
 * The device reads these answers with the tolerant reader of the file reading; the requests a
 * bridge receives stay strict.
 */

/** The most pages one answer lists. */
export const KB_PAGES_MAX = 200;
/** The longest question, in characters. */
export const KB_QUESTION_MAX_CHARS = 800;
/** The most statements an answer carries, and the most citations of one statement. */
export const KB_CLAIMS_MAX = 12;
export const KB_CITATIONS_MAX = 4;
/** The longest title, summary, statement and quotation, in characters. */
export const KB_TITLE_MAX_CHARS = 200;
export const KB_SUMMARY_MAX_CHARS = 300;
export const KB_CLAIM_MAX_CHARS = 1_200;
export const KB_QUOTE_MAX_CHARS = 300;

/** Why a question could not be answered; a stable code the views translate. */
export const KB_FAILURES = ["NO_TOOL", "TOOL_FAILED", "TIMEOUT", "UNREADABLE"] as const;
export type KbFailure = (typeof KB_FAILURES)[number];

/** Where the cost of a question comes from. A device shows a basis it does not know as `unknown`. */
export const KB_COST_BASES = ["reported", "estimated", "unknown"] as const;
export type KbCostBasis = (typeof KB_COST_BASES)[number];

/** The request shapes (without the identifier, the version and the product, which the file reading adds). */
export const KbListRequestFields = { op: z.literal("kb") } as const;
export const KbAskRequestFields = {
  op: z.literal("ask"),
  /** Chosen by the device: asking again with it reads the same question's state, it never starts a second one. */
  ask: z.string().regex(ULID_PATTERN),
  question: z.string().min(1).max(KB_QUESTION_MAX_CHARS),
} as const;

/** One page of the knowledge base. */
export const KbPageSchema = z.strictObject({
  /** The path from the product's folder, with `/`. */
  path: z.string().min(1).max(300),
  title: z.string().min(1).max(KB_TITLE_MAX_CHARS),
  /** The first lines of the page, as written. */
  summary: z.string().max(KB_SUMMARY_MAX_CHARS).optional(),
  /** The day the page says it was last updated (`2026-10-01`), when it says one. */
  updated: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** The last story the page says it took in (`2-3`), when it says one. */
  story: z
    .string()
    .regex(/^[1-9]\d{0,5}-[1-9]\d{0,5}$/)
    .optional(),
});
export type KbPage = z.infer<typeof KbPageSchema>;

export const KbListDataSchema = z.strictObject({
  op: z.literal("kb"),
  pages: z.array(KbPageSchema).max(KB_PAGES_MAX),
  /** True when the product holds more pages than the bridge lists. */
  truncated: z.boolean(),
  /** True when some page could not be read in full: the list may miss some. */
  incomplete: z.boolean().optional(),
  /** Whether the machine can answer a question: an AI tool it knows how to run is there. */
  askable: z.boolean(),
});
export type KbListData = z.infer<typeof KbListDataSchema>;

/** A place of the base a statement stands on: the page, the section, the line and the words. */
export const KbCitationSchema = z.strictObject({
  path: z.string().min(1).max(300),
  /** The heading of the section the passage is in, when it has one. */
  heading: z.string().max(KB_TITLE_MAX_CHARS).optional(),
  /** The line of the page where the quotation starts, from 1. */
  line: z.int().min(1).max(10_000_000),
  /** The words of the page, as they are written there. */
  quote: z.string().min(1).max(KB_QUOTE_MAX_CHARS),
});
export type KbCitation = z.infer<typeof KbCitationSchema>;

export const KbClaimSchema = z.strictObject({
  text: z.string().min(1).max(KB_CLAIM_MAX_CHARS),
  /** At least one: a statement without a source that holds never leaves the bridge. */
  citations: z.array(KbCitationSchema).min(1).max(KB_CITATIONS_MAX),
});
export type KbClaim = z.infer<typeof KbClaimSchema>;

export const KbCostSchema = z.strictObject({
  usd: z.number().min(0).max(1_000_000).optional(),
  basis: z.string().min(1).max(16),
  tokens_in: z.int().min(0).max(1_000_000_000).optional(),
  tokens_out: z.int().min(0).max(1_000_000_000).optional(),
});
export type KbCost = z.infer<typeof KbCostSchema>;

export const KbAskDataSchema = z.strictObject({
  op: z.literal("ask"),
  ask: z.string().regex(ULID_PATTERN),
  /** `working`: ask again; `answered`: the answer is below; `failed`: `failure` says why. */
  state: z.enum(["working", "answered", "failed"]),
  failure: z.string().min(1).max(32).optional(),
  answer: z
    .strictObject({
      claims: z.array(KbClaimSchema).max(KB_CLAIMS_MAX),
      /** True when nothing in the base answers the question (or nothing that was said held). */
      no_source: z.boolean(),
      /** How many statements the bridge removed because no citation of theirs held. */
      dropped: z.int().min(0).max(1_000),
    })
    .optional(),
  /** How many passages of the base the AI tool was given (0: it was not asked). */
  passages: z.int().min(0).max(100),
  cost: KbCostSchema.optional(),
});
export type KbAskData = z.infer<typeof KbAskDataSchema>;
