import { sha256Hex } from "@agentplugged/crypto";
import { ErrorCode, STORY_SECTIONS, UX_ELEMENT_PATTERN } from "@agentplugged/protocol";
import { normalizeText } from "../init/generated.js";
import { METHOD_DIR } from "../init/layout.js";
import type { DocsProblem, DocsWarning, DocumentFile } from "./docs-base.js";
import { type ParsedDocument, parseDocumentFile, sectionTitle } from "./parse-document.js";
import { storiesOf, warning } from "./story-rules.js";
import { uxElementsOf } from "./ux-documents.js";

/**
 * The story sheet: the one file a developer reads to build a story. It is the story file itself
 * (context, intent, criteria, screen, tests, reuse, out of scope) plus a section of excerpts the
 * engine writes: each passage the story cites, quoted with its identifier, its document and a
 * fingerprint. When the cited passage changes, the fingerprints no longer match and the sheet is
 * to be written again. A story without that section is in the former format: it keeps working,
 * and converting it is only proposed. Pure: the caller reads and writes the files.
 */

/** A sheet longer than this is a story too big: it is to be cut. */
export const SHEET_MAX_LINES = 300;

/** Lines of one passage shown in a sheet; the fingerprint always covers the whole passage. */
export const EXCERPT_MAX_LINES = 60;

/** The titles of the section of excerpts (English, then French). */
export const EXCERPT_SECTION_TITLES: readonly string[] = ["excerpts", "extraits"];

/** The sections of the architecture every sheet quotes when they exist (by anchor). */
const ALWAYS_QUOTED = ["stack", "conventions"] as const;

/** The command that writes a sheet again, as typed. */
export function sheetCommand(story?: string): string {
  return story === undefined
    ? "npx agentplugged docs sheet"
    : `npx agentplugged docs sheet ${story}`;
}

const DOCS_PREFIX = `${METHOD_DIR}/docs/`;
const MENTION = /(?<![\w-])((?:EF|ENF|PU|MS|AD|UX)-[1-9]\d{0,5})(?![\w-])/g;
const SECTION_CITATION = /`([\w./-]+\.md)#([a-z0-9-]+)`/g;
const EXCERPT_HEADING = /^###[ \t]+`([^`]+)`[ \t]+·[ \t]+(\S+)[ \t]+·[ \t]+([0-9a-f]{12})[ \t]*$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** A passage a sheet cites: an identifier (`EF-3`, `UX-2`) or a section (`ux.md#calculator`). */
export interface Citation {
  readonly id: string;
}

/** A cited passage as the documents hold it now. */
export interface Passage {
  readonly id: string;
  /** The document, from `.agentplugged/docs/` (`prd.md`). */
  readonly source: string;
  readonly text: string;
  readonly fingerprint: string;
}

/** An excerpt as the sheet records it. */
export interface RecordedExcerpt {
  readonly id: string;
  readonly source: string;
  readonly fingerprint: string;
}

/** Why an excerpt of a sheet is behind the documents. */
export type StaleReason = "changed" | "gone" | "missing";

export interface StaleExcerpt {
  readonly id: string;
  readonly reason: StaleReason;
  /** The passage as the documents hold it now (`changed` and `missing`). */
  readonly current?: Passage;
}

/** A story's sheet as read: its format, its length, and what is behind the documents. */
export interface SheetState {
  readonly story: string;
  readonly path: string;
  /** `sheet`: it holds the excerpts; `legacy`: the former format, without them. */
  readonly format: "sheet" | "legacy";
  readonly lines: number;
  readonly stale: readonly StaleExcerpt[];
}

/** The number of lines of a text, a final line break not counted. */
export function lineCount(text: string): number {
  const plain = normalizeText(text);
  if (plain === "") return 0;
  return plain.replace(/\n$/, "").split("\n").length;
}

/** A heading's anchor: lowercased, letters and digits kept, the rest as single dashes. */
export function anchorOf(title: string): string {
  return title
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replaceAll("`", "")
    .replaceAll("**", "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** A passage's fingerprint: its text with line ends trimmed, hashed (12 hex digits). */
export function fingerprintOf(text: string): string {
  return sha256Hex(plainPassage(text)).slice(0, 12);
}

function plainPassage(text: string): string {
  const lines = normalizeText(text)
    .normalize("NFC")
    .split("\n")
    .map((line) => line.trimEnd());
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

function linesOf(raw: string): string[] {
  return normalizeText(raw).normalize("NFC").split("\n");
}

function indentOf(line: string): number {
  return /^[ \t]*/.exec(line)?.[0].length ?? 0;
}

function isTableLine(line: string): boolean {
  return /^\s*\|/.test(line);
}

/**
 * The passage that opens at `index` (0-based) of `lines`: a heading runs to the next heading of
 * its level or above; a table row comes with the table's first row (its header); a list item or
 * a paragraph line takes the lines indented below it.
 */
export function passageAt(lines: readonly string[], index: number): string {
  const first = lines[index] ?? "";
  const heading = HEADING.exec(first);
  if (heading !== null) {
    const level = heading[1]?.length ?? 1;
    const taken = [first];
    let fence: string | undefined;
    for (let i = index + 1; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      const marker = FENCE.exec(line)?.[1];
      if (fence !== undefined) {
        if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) {
          fence = undefined;
        }
      } else if (marker !== undefined) {
        fence = marker;
      } else {
        const next = HEADING.exec(line);
        if (next !== null && (next[1]?.length ?? 7) <= level) break;
      }
      taken.push(line);
    }
    return plainPassage(taken.join("\n"));
  }
  if (isTableLine(first)) {
    let top = index;
    while (top > 0 && isTableLine(lines[top - 1] ?? "")) top -= 1;
    const header = top < index ? [lines[top] ?? ""] : [];
    return plainPassage([...header, first].join("\n"));
  }
  const base = indentOf(first);
  const taken = [first];
  for (let i = index + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      const after = lines.slice(i + 1).find((next) => next.trim() !== "");
      if (after === undefined || indentOf(after) <= base) break;
      taken.push(line);
      continue;
    }
    // A line that is not indented further continues the text only when it opens nothing new
    // (a lazy continuation): no list item, heading, quote, table row or fence.
    const opensBlock = /^\s*(?:[-*+]\s|\d{1,9}[.)]\s|#|>|\||`{3}|~{3})/.test(line);
    const afterBlank = (taken[taken.length - 1] ?? "").trim() === "";
    if (indentOf(line) <= base && (opensBlock || afterBlank)) break;
    taken.push(line);
  }
  return plainPassage(taken.join("\n"));
}

/** A document of `.agentplugged/docs/`, parsed, with its lines. */
interface SourceDocument {
  readonly name: string;
  readonly parsed: ParsedDocument;
  readonly lines: readonly string[];
  readonly raw: string;
}

/** The documents a sheet quotes from: those of `.agentplugged/docs/`, by name. */
export function sourceDocuments(files: readonly DocumentFile[]): SourceDocument[] {
  return files
    .filter((file) => file.path.replaceAll("\\", "/").startsWith(DOCS_PREFIX))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => ({
      name: file.path.replaceAll("\\", "/").slice(DOCS_PREFIX.length),
      parsed: parseDocumentFile(file.path, file.text),
      lines: linesOf(file.text),
      raw: file.text,
    }));
}

function passage(id: string, source: string, text: string): Passage {
  return { id, source, text, fingerprint: fingerprintOf(text) };
}

/** The passage a citation names in the documents now; undefined when none holds it (or retired). */
export function resolveCitation(
  id: string,
  documents: readonly SourceDocument[],
): Passage | undefined {
  const anchor = /^([\w./-]+\.md)#([a-z0-9-]+)$/.exec(id);
  if (anchor !== null) {
    const [, name, wanted] = anchor;
    const document = documents.find((candidate) => candidate.name === name);
    if (document === undefined) return undefined;
    let fence: string | undefined;
    for (let i = 0; i < document.lines.length; i += 1) {
      const line = document.lines[i] ?? "";
      const marker = FENCE.exec(line)?.[1];
      if (fence !== undefined) {
        if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) {
          fence = undefined;
        }
        continue;
      }
      if (marker !== undefined) {
        fence = marker;
        continue;
      }
      const heading = HEADING.exec(line);
      if (
        heading !== null &&
        (heading[1]?.length ?? 1) >= 2 &&
        anchorOf(heading[2] ?? "") === wanted
      ) {
        return passage(id, document.name, passageAt(document.lines, i));
      }
    }
    return undefined;
  }
  if (UX_ELEMENT_PATTERN.test(id)) {
    for (const document of documents) {
      if (document.parsed.kind?.value !== "ux") continue;
      const element = uxElementsOf(document.raw).find((candidate) => candidate.id === id);
      if (element === undefined || element.retired) continue;
      return passage(id, document.name, passageAt(document.lines, element.line - 1));
    }
    return undefined;
  }
  for (const document of documents) {
    const definition = document.parsed.definitions.find((candidate) => candidate.id === id);
    if (definition === undefined) continue;
    if (definition.retired) return undefined;
    return passage(id, document.name, passageAt(document.lines, definition.line - 1));
  }
  return undefined;
}

/** The sections of a story that cite: neither its excerpts nor its out of scope. */
function ownSections(story: ParsedDocument) {
  const skipped: readonly string[] = [...EXCERPT_SECTION_TITLES, ...STORY_SECTIONS.out_of_scope];
  return story.sections.filter((section) => !skipped.includes(section.title));
}

/**
 * What a story cites, in order and once each: its `requirements`, the identifiers its sections
 * mention, the sections it names (`` `ux.md#calculator` ``), then the architecture's stack and
 * conventions when they exist.
 */
export function citationsOf(story: ParsedDocument, documents: readonly SourceDocument[]): string[] {
  const found: string[] = [];
  const add = (id: string) => {
    if (!found.includes(id)) found.push(id);
  };
  for (const value of story.story?.requirements ?? []) add(value.value);
  for (const section of ownSections(story)) {
    for (const line of section.lines) {
      for (const match of line.matchAll(MENTION)) add(match[1] ?? "");
      for (const match of line.matchAll(SECTION_CITATION)) add(`${match[1]}#${match[2]}`);
    }
  }
  const architecture = documents.find((document) => document.parsed.kind?.value === "architecture");
  if (architecture !== undefined) {
    for (const anchor of ALWAYS_QUOTED) {
      const id = `${architecture.name}#${anchor}`;
      if (resolveCitation(id, documents) !== undefined) add(id);
    }
  }
  return found.filter((id) => id !== "");
}

/** The excerpts a sheet records, from its section of excerpts; undefined in the former format. */
export function recordedExcerpts(story: ParsedDocument): RecordedExcerpt[] | undefined {
  const section = story.sections.find((candidate) =>
    EXCERPT_SECTION_TITLES.includes(candidate.title),
  );
  if (section === undefined) return undefined;
  const excerpts: RecordedExcerpt[] = [];
  for (const line of section.lines) {
    const match = EXCERPT_HEADING.exec(line);
    if (match === null) continue;
    excerpts.push({ id: match[1] ?? "", source: match[2] ?? "", fingerprint: match[3] ?? "" });
  }
  return excerpts;
}

/** A sheet's state against the documents as they stand. */
export function sheetStateOf(
  story: ParsedDocument,
  raw: string,
  documents: readonly SourceDocument[],
): SheetState {
  const id = story.id ?? "";
  const recorded = recordedExcerpts(story);
  const lines = lineCount(raw);
  if (recorded === undefined) {
    return { story: id, path: story.path, format: "legacy", lines, stale: [] };
  }
  const stale: StaleExcerpt[] = [];
  for (const excerpt of recorded) {
    const current = resolveCitation(excerpt.id, documents);
    if (current === undefined) stale.push({ id: excerpt.id, reason: "gone" });
    else if (current.fingerprint !== excerpt.fingerprint) {
      stale.push({ id: excerpt.id, reason: "changed", current });
    }
  }
  const held = new Set(recorded.map((excerpt) => excerpt.id));
  for (const cited of citationsOf(story, documents)) {
    if (held.has(cited)) continue;
    const current = resolveCitation(cited, documents);
    // A citation no document holds is told by the other rules (a dangling link), not here.
    if (current !== undefined) stale.push({ id: cited, reason: "missing", current });
  }
  return { story: id, path: story.path, format: "sheet", lines, stale };
}

/** The section of excerpts of a story, written from the documents as they stand. */
export function excerptSection(
  storyId: string,
  passages: readonly Passage[],
  unresolved: readonly string[],
): string {
  const out = [
    "## Excerpts",
    "",
    `<!-- Written by \`${sheetCommand(storyId)}\` from the documents: never edit it by hand. -->`,
  ];
  for (const found of passages) {
    const all = found.text.split("\n");
    const shown = all.slice(0, EXCERPT_MAX_LINES);
    const longest = Math.max(2, ...[...found.text.matchAll(/~+/g)].map((match) => match[0].length));
    const fence = "~".repeat(longest + 1);
    out.push(
      "",
      `### \`${found.id}\` · ${found.source} · ${found.fingerprint}`,
      "",
      `${fence}text`,
    );
    out.push(...shown);
    if (all.length > shown.length) {
      out.push(`… ${all.length - shown.length} more lines in ${found.source}`);
    }
    out.push(fence);
  }
  if (unresolved.length > 0) {
    out.push("", `Not found in the documents: ${unresolved.map((id) => `\`${id}\``).join(", ")}.`);
  }
  return `${out.join("\n")}\n`;
}

/** What writing a sheet gives: the new text, its length, and the citations no document holds. */
export interface WrittenSheet {
  readonly text: string;
  readonly lines: number;
  readonly excerpts: number;
  readonly unresolved: readonly string[];
}

/**
 * The story's text with its section of excerpts written again from the documents: put in place of
 * the former one, or at the end. Everything else is kept as written.
 */
export function writeSheet(
  story: ParsedDocument,
  raw: string,
  documents: readonly SourceDocument[],
): WrittenSheet {
  const passages: Passage[] = [];
  const unresolved: string[] = [];
  for (const id of citationsOf(story, documents)) {
    const found = resolveCitation(id, documents);
    if (found === undefined) unresolved.push(id);
    else passages.push(found);
  }
  const section = excerptSection(story.id ?? "", passages, unresolved);
  const lines = normalizeText(raw).split("\n");
  // The body's section of excerpts, from its heading to the next level 1 or 2 heading.
  let start = -1;
  let end = lines.length;
  let fence: string | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const marker = FENCE.exec(line)?.[1];
    if (fence !== undefined) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (marker !== undefined) {
      fence = marker;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading === null || (heading[1]?.length ?? 3) > 2) continue;
    if (start >= 0) {
      end = i;
      break;
    }
    if (heading[1] === "##" && EXCERPT_SECTION_TITLES.includes(sectionTitle(heading[2] ?? ""))) {
      start = i;
    }
  }
  let text: string;
  if (start < 0) {
    text = `${lines.join("\n").replace(/\s*$/, "")}\n\n${section}`;
  } else {
    const before = lines.slice(0, start).join("\n").replace(/\s*$/, "");
    const after = lines.slice(end).join("\n").replace(/^\s*/, "").replace(/\s*$/, "");
    text = `${before}\n\n${section}${after === "" ? "" : `\n${after}\n`}`;
  }
  return { text, lines: lineCount(text), excerpts: passages.length, unresolved };
}

/** The sheets of the working copy's stories, against its documents. */
export function sheetStates(files: readonly DocumentFile[]): SheetState[] {
  const documents = sourceDocuments(files);
  const texts = new Map(files.map((file) => [file.path, file.text]));
  const parsed = files
    .filter((file) => file.path.replaceAll("\\", "/").includes(`${METHOD_DIR}/stories/`))
    .map((file) => parseDocumentFile(file.path, file.text));
  return [...storiesOf(parsed).values()].map((story) =>
    sheetStateOf(story, texts.get(story.path) ?? "", documents),
  );
}

/** One line per stale excerpt: `EF-1 (changed)`. */
export function staleList(stale: readonly StaleExcerpt[]): string {
  return stale.map((excerpt) => `${excerpt.id} (${excerpt.reason})`).join(", ");
}

/**
 * What `docs check` says of the sheets: a sheet over `SHEET_MAX_LINES` lines is a problem (the
 * story is to be cut); a sheet behind the documents is a warning; the stories in the former
 * format not approved yet are one warning together (the breakdown forgot to write them; an
 * approved story keeps working as it is, its conversion never pushed). `done`: the stories
 * merged, never told again; `approved`: the stories a `document` checkpoint approved.
 */
export function sheetChecks(
  states: readonly SheetState[],
  done: ReadonlySet<string>,
  approved: ReadonlySet<string> = new Set(),
): { problems: DocsProblem[]; warnings: DocsWarning[] } {
  const problems: DocsProblem[] = [];
  const warnings: DocsWarning[] = [];
  const legacy: string[] = [];
  for (const state of states) {
    if (done.has(state.story)) continue;
    if (state.format === "legacy") {
      if (!approved.has(state.story)) legacy.push(state.story);
      continue;
    }
    if (state.lines > SHEET_MAX_LINES) {
      problems.push({
        code: ErrorCode.STORY_SHEET_TOO_LONG,
        message_key: "error.story_sheet_too_long",
        details: {
          path: state.path,
          line: 1,
          story: state.story,
          lines: state.lines,
          max: SHEET_MAX_LINES,
        },
      });
    }
    if (state.stale.length > 0) {
      warnings.push(
        warning("sheet_stale", {
          story: state.story,
          path: state.path,
          excerpts: staleList(state.stale),
          command: sheetCommand(state.story),
        }),
      );
    }
  }
  if (legacy.length > 0) {
    warnings.push(
      warning("sheet_legacy", {
        stories: legacy.join(", "),
        count: legacy.length,
        command: sheetCommand(),
      }),
    );
  }
  return { problems, warnings };
}
