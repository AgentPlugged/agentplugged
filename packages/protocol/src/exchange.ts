import { z } from "zod";
import { hasControlCharacter } from "./deferred.js";
import { AgentIdSchema } from "./method-config.js";

/**
 * The summary of an exchange: at the end of each exchange with the creator, Noah writes a short
 * note to the journal (what was asked, what was decided, what was promised). Whatever session Noah
 * runs in (the AI tool's or the bridge's), a fresh session reads the latest notes in the state of
 * the product and takes the thread up where it was left, without any session to resume.
 */

/** Event type of the summary, at version 1. */
export const EXCHANGE_EVENT_TYPES = {
  summarized: "exchange.summarized",
} as const;

/** The most characters of a note: it stays short, the journal is not a log. */
export const EXCHANGE_SUMMARY_MAX = 300;

/** How many summaries the projection keeps, the latest ones. */
export const EXCHANGES_KEPT = 30;

/** One line, 1 to 300 characters, no control character. */
const SummarySchema = z
  .string()
  .trim()
  .min(1)
  .max(EXCHANGE_SUMMARY_MAX)
  .refine((text) => !hasControlCharacter(text, false), {
    message: "expected one line without control character",
  })
  // Unicode line separators and bidirectional marks would make a note look like two lines or hide
  // its text on screen.
  .refine((text) => !/[\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(text), {
    message: "expected one line without separator or direction mark",
  });

/** Input of `summarize`: Noah's own id and the note. */
export const SummarizeInputSchema = z.strictObject({
  agent: AgentIdSchema.max(64),
  summary: SummarySchema,
});
export type SummarizeInput = z.infer<typeof SummarizeInputSchema>;

/** `payload` of `exchange.summarized`. */
export const ExchangeSummarizedPayloadSchema = z.strictObject({
  summary: SummarySchema,
});
export type ExchangeSummarizedPayload = z.infer<typeof ExchangeSummarizedPayloadSchema>;
