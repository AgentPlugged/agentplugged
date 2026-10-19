import {
  FIND_HITS_MAX,
  FIND_SNIPPET_MAX_CHARS,
  FIND_TITLE_MAX_CHARS,
  type FindHit,
} from "@agentplugged/protocol";
import type { DocumentFile } from "./docs-base.js";
import { isKnowledgePage } from "./knowledge-freshness.js";
import { bodyOf, fileStem, headingOf, passagesOf } from "./knowledge-search.js";
import { parseDocumentFile } from "./parse-document.js";

/**
 * Looking for words in the documents of a product, for the search bar of a device: pure rules
 * over the Markdown files, no model and no cost. A document holds the words when every one of them
 * is in one section of it, or in its title; the answer lists, for each such document, the section
 * where the words weigh most, with the line they are on. Everything read from a file is untrusted
 * text: it is only compared, cut and counted here, never interpreted.
 */

/** The most words of a search that count; the rest of a long search is left out. */
const TERMS_MAX = 8;
/** Occurrences of a word that add to a section's weight; more adds nothing. */
const OCCURRENCES_MAX = 5;

/** Text as compared: no accents, no case. */
function plain(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** The words of a search: letters and digits, at least two long (a lone digit counts), no repeat. */
export function searchTerms(query: string): string[] {
  const words = plain(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2 || /^\p{N}$/u.test(word));
  return [...new Set(words)].slice(0, TERMS_MAX);
}

function countOf(haystack: string, term: string): number {
  let count = 0;
  for (let at = haystack.indexOf(term); at >= 0; at = haystack.indexOf(term, at + term.length)) {
    count += 1;
    if (count >= OCCURRENCES_MAX) break;
  }
  return count;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** A line of Markdown as it reads: no heading marks, emphasis, table bars, quote or list marks. */
function readable(line: string): string {
  return oneLine(
    line
      .replace(/^\s*(?:#{1,6}[ \t]+|>[ \t]*|[-*+][ \t]+)/, "")
      .replace(/\*\*|__|`|~~/g, "")
      .replace(/\|/g, " "),
  );
}

/** The line cut to `FIND_SNIPPET_MAX_CHARS`, around the first of the words when it is long. */
function snippetOf(line: string, terms: readonly string[]): string {
  const text = readable(line);
  if (text.length <= FIND_SNIPPET_MAX_CHARS) return text;
  const folded = plain(text);
  const at = Math.min(
    ...terms.map((term) => folded.indexOf(term)).filter((index) => index >= 0),
    text.length,
  );
  const from = Math.max(0, Math.min(at - 60, text.length - FIND_SNIPPET_MAX_CHARS + 2));
  const body = text.slice(from, from + FIND_SNIPPET_MAX_CHARS - 2).trim();
  return `${from > 0 ? "…" : ""}${body}${from + FIND_SNIPPET_MAX_CHARS - 2 < text.length ? "…" : ""}`;
}

export interface DocumentSearchResult {
  readonly hits: readonly FindHit[];
  /** More documents hold the words than `limit`. */
  readonly truncated: boolean;
}

/**
 * The documents that hold all the words of `query`, best first (ties by path), at most `limit`.
 * A word may also be found in the document's title. A search without any usable word finds nothing.
 */
export function searchDocuments(
  files: readonly DocumentFile[],
  query: string,
  limit: number = FIND_HITS_MAX,
): DocumentSearchResult {
  const terms = searchTerms(query);
  if (terms.length === 0) return { hits: [], truncated: false };
  const found: Array<{ score: number; hit: FindHit }> = [];
  for (const file of files) {
    const parsed = parseDocumentFile(file.path, file.text);
    const { lines, start } = bodyOf(file.text);
    let title = parsed.title?.value;
    if (title === undefined || oneLine(title) === "") {
      for (const line of lines.slice(start, start + 40)) {
        const match = headingOf(line);
        if (match?.level === 1) {
          title = readable(match.text);
          break;
        }
      }
    }
    const name = cut(oneLine(title ?? "") || fileStem(file.path), FIND_TITLE_MAX_CHARS);
    const foldedTitle = plain(name);
    let best: { score: number; from: number; to: number; heading: string | undefined } | undefined;
    for (const passage of passagesOf(file)) {
      const body = plain(passage.text);
      const head = plain(passage.heading ?? "");
      let score = 0;
      let all = true;
      for (const term of terms) {
        const inBody = countOf(body, term);
        const inHead = head.includes(term);
        const inTitle = foldedTitle.includes(term);
        if (inBody === 0 && !inHead && !inTitle) {
          all = false;
          break;
        }
        score += inBody + (inHead ? 3 : 0) + (inTitle ? 2 : 0);
      }
      if (all && (best === undefined || score > best.score)) {
        best = { score, from: passage.line, to: passage.endLine, heading: passage.heading };
      }
    }
    if (best === undefined) continue;
    // The line shown is the first of the section that holds one of the words, as the file has it;
    // the heading line only when the words are in no other (it says less than a line of prose).
    let line = best.from;
    let text = lines[line - 1] ?? "";
    let chosen = false;
    const opensWithHeading = /^ {0,3}#{1,6}[ \t]/.test(lines[best.from - 1] ?? "");
    for (
      let at = best.from + (opensWithHeading ? 1 : 0);
      at <= Math.min(best.to, lines.length) && !chosen;
      at += 1
    ) {
      const candidate = lines[at - 1] ?? "";
      const folded = plain(candidate);
      if (readable(candidate) !== "" && terms.some((term) => folded.includes(term))) {
        line = at;
        text = candidate;
        chosen = true;
      }
    }
    if (!chosen) {
      for (let at = best.from; at <= Math.min(best.to, lines.length); at += 1) {
        const candidate = lines[at - 1] ?? "";
        if (readable(candidate) !== "") {
          line = at;
          text = candidate;
          break;
        }
      }
    }
    const snippet = snippetOf(text, terms);
    if (snippet === "") continue;
    found.push({
      score: best.score,
      hit: {
        path: file.path,
        ...(isKnowledgePage(parsed) ? { kb: true as const } : {}),
        title: name,
        ...(best.heading === undefined || best.heading === ""
          ? {}
          : { heading: cut(best.heading, FIND_TITLE_MAX_CHARS) }),
        line,
        snippet,
      },
    });
  }
  found.sort((a, b) => b.score - a.score || (a.hit.path < b.hit.path ? -1 : 1));
  return {
    hits: found.slice(0, limit).map((entry) => entry.hit),
    truncated: found.length > limit,
  };
}
