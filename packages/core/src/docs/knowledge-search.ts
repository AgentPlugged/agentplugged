import {
  KB_CITATIONS_MAX,
  KB_CLAIM_MAX_CHARS,
  KB_CLAIMS_MAX,
  KB_PAGES_MAX,
  KB_QUOTE_MAX_CHARS,
  KB_SUMMARY_MAX_CHARS,
  KB_TITLE_MAX_CHARS,
  type KbCitation,
  type KbClaim,
  type KbPage,
  KnowledgeStorySchema,
} from "@agentplugged/protocol";
import type { DocumentFile } from "./docs-base.js";
import { isKnowledgePage } from "./knowledge-freshness.js";
import { parseDocumentFile } from "./parse-document.js";
import { subjectWords } from "./research-find.js";

/**
 * The knowledge base as a device reads it and as a question is put to it: pure rules over the
 * Markdown files of the base. Nothing here runs a model or reads the disk.
 *
 * - `knowledgeBaseView` lists the pages of the base with what each one says of itself (title, first
 *   lines, the day and the story of its last update), never anything guessed.
 * - `selectPassages` is the local search that makes a question cheap: the pages are cut into
 *   passages, the passages are ranked against the words of the question, and only the best few,
 *   within a size limit, are ever given to a model. A question nothing in the base comes near
 *   selects nothing, and no model is asked.
 * - `verifyAnswer` is the check that makes an answer trustworthy: a statement stays only if one of
 *   its citations quotes, word for word, a passage that was given and that the page still holds.
 *
 * Everything read from a page is untrusted text: it is only compared, cut and counted here, never
 * interpreted.
 */

/** The longest passage, in characters; a longer section is cut at a blank line. */
const PASSAGE_MAX_CHARS = 1_000;
/** A passage shorter than this says nothing a question could rest on. */
const PASSAGE_MIN_CHARS = 24;
/** At most this many passages are kept for one product (a base is small; this is a guard). */
const PASSAGES_MAX = 6_000;
/** What one question may give a model: a number of passages and a total size. */
export const KB_SELECT_MAX_PASSAGES = 8;
export const KB_SELECT_MAX_CHARS = 6_000;
/** A passage whose score is below this share of the best one is left out. */
const SCORE_FLOOR = 0.25;
/** The words of a quotation must be at least this long to count as a quotation. */
const QUOTE_MIN_CHARS = 20;

const LABEL = /(updat|jour|actualiz|aktualis|atualiz|ultim|last|dernie|derni[eè]re)/i;
const ISO_DATE = /\b(\d{4}-\d{2}-\d{2})\b/;

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The lines of a file and the index of the first line after its header (0 without one). */
export function bodyOf(text: string): { lines: string[]; start: number } {
  const lines = text.replace(/^﻿/, "").replaceAll("\r\n", "\n").split("\n");
  let start = 0;
  if ((lines[0] ?? "").trim() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (end > 0) start = end + 1;
  }
  return { lines, start };
}

const HEADING_OPEN = /^ {0,3}(#{1,6})[ \t]+/;
/** A line longer than this is never read as a heading (a guard against pathological input). */
const HEADING_LINE_MAX = 2_000;

/**
 * The level and the text of an ATX heading line (`## Title ##`), or null. Linear in the length of
 * the line: the closing marks are stripped by hand, not by a backtracking pattern.
 */
export function headingOf(raw: string): { level: number; text: string } | null {
  if (raw.length > HEADING_LINE_MAX) return null;
  const open = HEADING_OPEN.exec(raw);
  if (open === null) return null;
  const rest = raw.slice(open[0].length).trimEnd();
  let end = rest.length;
  while (end > 0 && rest.charAt(end - 1) === "#") end -= 1;
  const text = rest.slice(0, end).trimEnd() || rest;
  return text === "" ? null : { level: open[1]?.length ?? 1, text };
}
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** The text of a heading without the emphasis marks around it. */
function headingText(raw: string): string {
  // Emphasis marks only: a single `_` or `*` can belong to a word (and to a secret).
  return oneLine(raw.replace(/\*\*|__|`/g, ""));
}

/** The day a page says it was last updated, from a line like `Last updated: 2026-10-01 — …`. */
function updatedOf(lines: readonly string[], start: number): string | undefined {
  for (const line of lines.slice(start, start + 30)) {
    if (!LABEL.test(line.slice(0, 48))) continue;
    const day = ISO_DATE.exec(line)?.[1];
    if (day === undefined) continue;
    const parsed = Date.parse(`${day}T00:00:00Z`);
    if (!Number.isNaN(parsed)) return day;
  }
  return undefined;
}

/** The first lines of prose of a page: not a heading, a comment, a table, a code fence or the update line. */
function summaryOf(lines: readonly string[], start: number): string | undefined {
  let inComment = false;
  let inFence = false;
  const found: string[] = [];
  for (const raw of lines.slice(start)) {
    const line = raw.trim();
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      continue;
    }
    if (line.startsWith("<!--")) {
      if (!line.includes("-->")) inComment = true;
      continue;
    }
    if (FENCE.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line === "") {
      if (found.length > 0) break;
      continue;
    }
    if (headingOf(raw) !== null || line.startsWith("|") || line.startsWith(">")) {
      if (found.length > 0) break;
      continue;
    }
    if (LABEL.test(line.slice(0, 48)) && ISO_DATE.test(line)) continue;
    found.push(line.replace(/^[-*+]\s+/, ""));
    if (found.join(" ").length >= KB_SUMMARY_MAX_CHARS) break;
  }
  const text = oneLine(found.join(" ").replace(/\*\*|__|`/g, ""));
  return text === "" ? undefined : cut(text, KB_SUMMARY_MAX_CHARS);
}

export function fileStem(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.[^.]+$/, "");
}

export interface KnowledgeBaseView {
  readonly pages: readonly KbPage[];
  /** More pages than a list carries. */
  readonly truncated: boolean;
  /** The files of the pages, kept in the order of the list (for the search). */
  readonly files: readonly DocumentFile[];
}

/**
 * The pages of the knowledge base among the document files: the Markdown files of
 * `.agentplugged/docs/` that Zoé owns. The index (the map of the base) comes first, then the
 * pages in path order.
 */
export function knowledgeBaseView(documents: readonly DocumentFile[]): KnowledgeBaseView {
  const rows: Array<{ page: KbPage; file: DocumentFile }> = [];
  for (const file of documents) {
    const parsed = parseDocumentFile(file.path, file.text);
    if (!isKnowledgePage(parsed)) continue;
    const { lines, start } = bodyOf(file.text);
    let title = parsed.title?.value;
    if (title === undefined || oneLine(title) === "") {
      for (const line of lines.slice(start, start + 40)) {
        const match = headingOf(line);
        if (match?.level === 1) {
          title = headingText(match.text);
          break;
        }
      }
    }
    const story = KnowledgeStorySchema.safeParse(parsed.last_story?.value);
    const updated = updatedOf(lines, start);
    const summary = summaryOf(lines, start);
    rows.push({
      file,
      page: {
        path: file.path,
        title: cut(oneLine(title ?? "") || fileStem(file.path), KB_TITLE_MAX_CHARS),
        ...(summary === undefined ? {} : { summary }),
        ...(updated === undefined ? {} : { updated }),
        ...(story.success ? { story: story.data } : {}),
      },
    });
  }
  const isIndex = (path: string): boolean => fileStem(path).toLowerCase() === "index";
  rows.sort((a, b) => {
    const left = isIndex(a.file.path) ? 0 : 1;
    const right = isIndex(b.file.path) ? 0 : 1;
    if (left !== right) return left - right;
    return a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0;
  });
  const kept = rows.slice(0, KB_PAGES_MAX);
  return {
    pages: kept.map((row) => row.page),
    truncated: rows.length > KB_PAGES_MAX,
    files: kept.map((row) => row.file),
  };
}

/** A part of a page a question can rest on: a section, or a run of paragraphs of a long one. */
export interface KnowledgePassage {
  readonly path: string;
  /** The nearest heading above it, without its marks. */
  readonly heading: string | undefined;
  /** The line where it starts and the line where it ends, from 1, in the file. */
  readonly line: number;
  readonly endLine: number;
  readonly text: string;
}

/** The passages of a page: one per section, a long section cut at blank lines. */
export function passagesOf(file: DocumentFile): KnowledgePassage[] {
  const { lines, start } = bodyOf(file.text);
  const passages: KnowledgePassage[] = [];
  let heading: string | undefined;
  let from = -1;
  let buffer: string[] = [];
  let inFence = false;
  let inComment = false;
  const flush = (end: number): void => {
    const text = buffer.join("\n").trim();
    if (from >= 0 && text.replace(/\s+/g, " ").length >= PASSAGE_MIN_CHARS) {
      passages.push({
        path: file.path,
        heading,
        line: from + 1,
        endLine: end,
        text,
      });
    }
    from = -1;
    buffer = [];
  };
  for (let index = start; index < lines.length; index += 1) {
    const raw = (lines[index] ?? "").replace(/\r$/, "");
    const trimmed = raw.trim();
    if (inComment) {
      if (trimmed.includes("-->")) inComment = false;
      continue;
    }
    if (!inFence && trimmed.startsWith("<!--")) {
      if (!trimmed.includes("-->")) inComment = true;
      continue;
    }
    if (FENCE.test(raw)) inFence = !inFence;
    const match = inFence ? null : headingOf(raw);
    if (match !== null) {
      flush(index);
      heading = headingText(match.text);
      // The heading opens the passage: its words count for a question, and it is a real line.
      from = index;
      buffer = [raw];
      continue;
    }
    if (from < 0) {
      if (trimmed === "") continue;
      from = index;
    }
    // A long section is cut at a blank line, so that a passage stays a few paragraphs.
    if (!inFence && trimmed === "" && buffer.join("\n").length >= PASSAGE_MAX_CHARS) {
      flush(index);
      continue;
    }
    buffer.push(raw);
    if (buffer.join("\n").length > PASSAGE_MAX_CHARS * 2 && !inFence) flush(index + 1);
    if (passages.length >= PASSAGES_MAX) break;
  }
  flush(lines.length);
  return passages;
}

/** Two words match when they are the same, or share a long start (`relancer`, `relance`). */
function matches(term: string, token: string): 0 | 0.6 | 1 {
  if (term === token) return 1;
  if (term.length >= 6 && token.length >= 6 && term.slice(0, 5) === token.slice(0, 5)) return 0.6;
  return 0;
}

export interface SelectedPassages {
  /** Best first; the position in this list, plus one, is the number a model cites (`S1`...). */
  readonly passages: readonly KnowledgePassage[];
  /** The words of the question the search used. */
  readonly terms: number;
}

/**
 * The passages of the base that a question comes near, best first, within the size a model is
 * given. A passage counts by how many of the question's words it holds (rarer words count more,
 * the words of its heading and of its page's name count twice). Nothing near: no passage.
 */
export function selectPassages(
  files: readonly DocumentFile[],
  question: string,
  limits: { readonly passages?: number; readonly chars?: number } = {},
): SelectedPassages {
  const terms = subjectWords(question);
  if (terms.length === 0) return { passages: [], terms: 0 };
  const all = files.flatMap((file) => passagesOf(file));
  if (all.length === 0) return { passages: [], terms: terms.length };
  const documents = all.map((passage) => {
    const body = subjectWords(passage.text);
    const head = subjectWords(`${passage.heading ?? ""} ${fileStem(passage.path)}`);
    return { tokens: [...body, ...head], length: Math.max(1, body.length + head.length) };
  });
  const average = documents.reduce((sum, entry) => sum + entry.length, 0) / documents.length;
  // How many passages hold each word: the rarer a word, the more it says.
  const holders = terms.map(
    (term) =>
      documents.filter((entry) => entry.tokens.some((token) => matches(term, token) > 0)).length,
  );
  const scored = all.map((passage, index) => {
    const entry = documents[index];
    if (entry === undefined) return { passage, score: 0, hit: 0 };
    let score = 0;
    let hit = 0;
    terms.forEach((term, at) => {
      let count = 0;
      for (const token of entry.tokens) {
        const weight = matches(term, token);
        if (weight > 0) {
          count += weight;
        }
      }
      if (count === 0) return;
      hit += 1;
      const idf = Math.log(
        1 + (all.length - (holders[at] ?? 0) + 0.5) / ((holders[at] ?? 0) + 0.5),
      );
      const frequency = (count * 2.2) / (count + 1.2 * (0.25 + (0.75 * entry.length) / average));
      score += idf * frequency;
    });
    return { passage, score, hit };
  });
  // A question of several words needs a passage that holds more than one of them.
  const needed = Math.max(1, Math.ceil(terms.length * 0.34));
  const ranked = scored
    .filter((row) => row.score > 0 && row.hit >= Math.min(needed, 2))
    .sort((a, b) => b.score - a.score || (a.passage.path < b.passage.path ? -1 : 1));
  const best = ranked[0]?.score ?? 0;
  const maxPassages = limits.passages ?? KB_SELECT_MAX_PASSAGES;
  const maxChars = limits.chars ?? KB_SELECT_MAX_CHARS;
  const chosen: KnowledgePassage[] = [];
  let size = 0;
  for (const row of ranked) {
    if (row.score < best * SCORE_FLOOR || chosen.length >= maxPassages) break;
    const room = maxChars - size;
    if (room < PASSAGE_MIN_CHARS) break;
    // The last passage that fits is cut rather than dropped; it stays a real part of the page.
    const text =
      row.passage.text.length > room ? row.passage.text.slice(0, room) : row.passage.text;
    chosen.push({ ...row.passage, text });
    size += text.length;
  }
  return { passages: chosen, terms: terms.length };
}

/** Text as compared: no emphasis marks, table bars or case, runs of space as one. */
function comparable(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\*\*|__|`|~~/g, "")
    .replace(/[\s|]+/g, " ")
    .toLowerCase()
    .trim();
}

/**
 * Where a quotation stands in a passage: the file line of the first line it touches, or undefined
 * when the passage does not hold it. `fileLines` are the lines of the page as it is now.
 */
function locate(
  fileLines: readonly string[],
  passage: KnowledgePassage,
  quote: string,
): number | undefined {
  const wanted = comparable(quote);
  if (wanted.length < QUOTE_MIN_CHARS) return undefined;
  let joined = "";
  const starts: Array<{ offset: number; line: number }> = [];
  for (let line = passage.line; line <= passage.endLine; line += 1) {
    const text = comparable(fileLines[line - 1] ?? "");
    if (text === "") continue;
    starts.push({ offset: joined.length, line });
    joined = joined === "" ? text : `${joined} ${text}`;
    if (joined.length > 4 * PASSAGE_MAX_CHARS) break;
  }
  const at = joined.indexOf(wanted);
  if (at < 0) return undefined;
  let found = starts[0]?.line;
  for (const start of starts) {
    if (start.offset <= at) found = start.line;
  }
  return found;
}

export interface VerifiedAnswer {
  readonly claims: readonly KbClaim[];
  /** The statements removed because none of their citations held. */
  readonly dropped: number;
  /** False when the answer was not an answer in the asked form: nothing could be read from it. */
  readonly readable: boolean;
}

/** Parses the JSON object of a model's reply, which may sit in a code fence or after a few words. */
function jsonOf(reply: string): unknown {
  const text = reply.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const candidates = [text, ...(fenced === undefined ? [] : [fenced.trim()])];
  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  if (open >= 0 && close > open) candidates.push(text.slice(open, close + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // The next form.
    }
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What of a model's answer stands. The model is asked for `{"claims":[{"text","cites":[{"source",
 * "quote"}]}]}`, each `source` being the number of a passage it was given (`S2`). A statement
 * stays when at least one of its citations names a passage that was given and quotes it word for
 * word, and the page still holds that passage as it is now (`files` are read again after the
 * model answered). The line and the section come from the page, never from the model. Anything
 * else is removed and counted.
 */
export function verifyAnswer(
  reply: string,
  given: readonly KnowledgePassage[],
  files: readonly DocumentFile[],
): VerifiedAnswer {
  const parsed = jsonOf(reply);
  if (!isObject(parsed) || !Array.isArray(parsed.claims)) {
    return { claims: [], dropped: 0, readable: false };
  }
  const lines = new Map<string, string[]>();
  for (const file of files) lines.set(file.path, bodyOf(file.text).lines);
  const claims: KbClaim[] = [];
  let dropped = 0;
  for (const entry of parsed.claims.slice(0, KB_CLAIMS_MAX * 2)) {
    if (!isObject(entry) || typeof entry.text !== "string" || !Array.isArray(entry.cites)) {
      dropped += 1;
      continue;
    }
    const citations: KbCitation[] = [];
    for (const cite of entry.cites.slice(0, KB_CITATIONS_MAX * 2)) {
      if (!isObject(cite) || typeof cite.source !== "string" || typeof cite.quote !== "string") {
        continue;
      }
      const number = /^S(\d{1,3})$/.exec(cite.source.trim())?.[1];
      const passage = number === undefined ? undefined : given[Number(number) - 1];
      const fileLines = passage === undefined ? undefined : lines.get(passage.path);
      if (passage === undefined || fileLines === undefined) continue;
      const quote = oneLine(cite.quote).slice(0, KB_QUOTE_MAX_CHARS);
      const line = locate(fileLines, passage, quote);
      if (line === undefined) continue;
      if (citations.some((kept) => kept.path === passage.path && kept.line === line)) continue;
      citations.push({
        path: passage.path,
        ...(passage.heading === undefined || passage.heading === ""
          ? {}
          : { heading: cut(passage.heading, KB_TITLE_MAX_CHARS) }),
        line,
        quote,
      });
      if (citations.length >= KB_CITATIONS_MAX) break;
    }
    const text = oneLine(entry.text);
    if (citations.length === 0 || text === "") {
      dropped += 1;
      continue;
    }
    if (claims.length >= KB_CLAIMS_MAX) continue;
    claims.push({ text: cut(text, KB_CLAIM_MAX_CHARS), citations });
  }
  return { claims, dropped, readable: true };
}
