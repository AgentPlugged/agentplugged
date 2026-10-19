import { z } from "zod";

/**
 * Searching the text of the documents of a product, through its machine's bridge: the shapes the
 * request and the answer of the file reading carry (`find`).
 *
 * The bridge reads the documents and the pages of the knowledge base in the product's folder and
 * looks for the words the creator typed: no model is asked and nothing is spent. Every text that
 * comes from a document (a title, a section, a line) is untrusted content that has been through
 * the secret guard; the device shows it as inert text. The words searched are not kept anywhere:
 * the device does not keep a copy of this answer, and the bridge does not log them.
 *
 * The device reads the answer with the tolerant reader of the file reading; the request a bridge
 * receives stays strict.
 */

/** The longest search, in characters. */
export const FIND_QUERY_MAX_CHARS = 120;
/** The most places one answer lists: one per document, the best first. */
export const FIND_HITS_MAX = 8;
/** The longest title, section and line shown for a place. */
export const FIND_TITLE_MAX_CHARS = 200;
export const FIND_SNIPPET_MAX_CHARS = 240;

/** The request shape (without the identifier, the version and the product, which the file reading adds). */
export const FindRequestFields = {
  op: z.literal("find"),
  query: z.string().min(1).max(FIND_QUERY_MAX_CHARS),
} as const;

/** A place in a document where the words are: the document, its section, the line and the words around. */
export const FindHitSchema = z.strictObject({
  /** The path from the product's folder, with `/`. */
  path: z.string().min(1).max(300),
  /** True for a page of the knowledge base (it opens in the knowledge base, not in the documents). */
  kb: z.literal(true).optional(),
  title: z.string().min(1).max(FIND_TITLE_MAX_CHARS),
  /** The heading of the section, when it has one. */
  heading: z.string().max(FIND_TITLE_MAX_CHARS).optional(),
  /** The line of the document where the words are, from 1. */
  line: z.int().min(1).max(10_000_000),
  /** The line itself, cut around the words. */
  snippet: z.string().min(1).max(FIND_SNIPPET_MAX_CHARS),
});
export type FindHit = z.infer<typeof FindHitSchema>;

export const FindDataSchema = z.strictObject({
  op: z.literal("find"),
  hits: z.array(FindHitSchema).max(FIND_HITS_MAX),
  /** True when more documents hold the words than the answer lists. */
  truncated: z.boolean(),
  /** True when some document could not be read in full: the answer may miss some. */
  incomplete: z.boolean().optional(),
});
export type FindData = z.infer<typeof FindDataSchema>;
