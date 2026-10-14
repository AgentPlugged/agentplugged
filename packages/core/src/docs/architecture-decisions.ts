import { ErrorCode } from "@agentplugged/protocol";
import { normalizeText } from "../init/generated.js";
import { holdsDecisions } from "../spec/spec-kinds.js";
import type { DocsProblem } from "./check-docs.js";
import type { DocumentFile } from "./docs-base.js";
import { type ParsedDocument, parseDefinitionLine, tableCells } from "./parse-document.js";

/**
 * The three fields of an architecture decision: what it binds, what it prevents and
 * the rule every builder follows, by their English label or their French one. In a decision's
 * block, a field opens a line (`- **Binds:** …`, `Règle : …`); in a table, it is a column
 * (`| Id | Binds | Prevents | Rule |`) or opens a cell (`| AD-1 | Binds: … |`).
 */
export const AD_FIELDS: ReadonlyArray<{ readonly field: string; readonly labels: string }> = [
  { field: "Binds", labels: "binds|lie" },
  { field: "Prevents", labels: "prevents|empêche" },
  { field: "Rule", labels: "rule|règle" },
];

const SP = "[ \\t\\u00A0\\u202F]";
const QUOTE = new RegExp(`^(?: {0,3}>${SP}?)+`);
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = new RegExp(`^ {0,3}(#{1,6})(?:${SP}|$)`);
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const LIST_ITEM = new RegExp(`^ {0,3}(?:[-*+]|\\d{1,9}[.)])${SP}`);
const INDENTED = /^(?: {4}|\t)/;
const BOLD = "(?:\\*\\*|__)";
const LIST = `(?:[-*+]${SP}+|\\d{1,9}[.)]${SP}+)?`;
const END = `${SP}*(?::${SP}*${BOLD}?|${BOLD}${SP}*:)`;
const DELIMITER = /^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/** A field opening a line: optional list marker and bold, its label, then a colon. */
function fieldLine(labels: string): RegExp {
  return new RegExp(`^${SP}*${LIST}${BOLD}?${SP}*(?:${labels})${END}`, "iu");
}

/** A column header naming a field: its label alone, bold or not, with or without a colon. */
function fieldHeader(labels: string): RegExp {
  return new RegExp(`^${BOLD}?(?:${labels})${SP}*:?${BOLD}?$`, "iu");
}

const unquote = (line: string) => line.replace(QUOTE, "");
const blank = (line: string) => line.trim() === "";

/** The level of an ATX heading line (1 to 6), or undefined. */
function headingLevel(line: string): number | undefined {
  return HEADING.exec(unquote(line))?.[1]?.length;
}

/**
 * The lines of the block a definition opens: the lines after it, up to the next heading (ATX or
 * setext) of the same or a higher level (any heading for a definition that is not one), or the
 * next definition. Lines of fenced or indented code never count.
 */
export function blockOf(lines: readonly string[], index: number): string[] {
  const level = headingLevel(lines[index] ?? "");
  const block: string[] = [];
  let fence: string | undefined;
  let previous = { blank: false, code: false, text: false };
  let inList = LIST_ITEM.test(unquote(lines[index] ?? ""));
  for (let i = index + 1; i < lines.length; i++) {
    const line = unquote(lines[i] ?? "");
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
    if (blank(line)) {
      previous = { blank: true, code: previous.code, text: false };
      continue;
    }
    if (INDENTED.test(line) && !inList && (previous.blank || previous.code)) {
      previous = { blank: false, code: true, text: false };
      continue;
    }
    // A setext underline turns the paragraph line above it into a heading.
    const setext = SETEXT.exec(line)?.[1];
    if (setext !== undefined && previous.text) {
      block.pop();
      const underlined = setext.startsWith("=") ? 1 : 2;
      if (level === undefined || underlined <= level) break;
      previous = { blank: false, code: false, text: false };
      continue;
    }
    const heading = headingLevel(line);
    if (heading !== undefined && (level === undefined || heading <= level)) break;
    if (parseDefinitionLine(line) !== undefined) break;
    const item = LIST_ITEM.test(line);
    if (item) inList = true;
    else if (!INDENTED.test(line) && previous.blank) inList = false;
    block.push(line);
    previous = { blank: false, code: false, text: heading === undefined && !item };
  }
  return block;
}

/** True when a line is a row of a table: it holds an unescaped pipe. */
function isRow(line: string): boolean {
  return /(?<!\\)\|/.test(unquote(line));
}

/**
 * The fields missing from a decision written as a table row: a column of the table's header
 * holds a field (its cell must not be empty), else a cell of the row starts with it.
 */
function rowMissing(lines: readonly string[], index: number): string[] {
  let start = index;
  while (start > 0 && isRow(lines[start - 1] ?? "")) start--;
  const header =
    start < index && DELIMITER.test(unquote(lines[start + 1] ?? "").trim())
      ? tableCells(unquote(lines[start] ?? ""))
      : [];
  const cells = tableCells(unquote(lines[index] ?? ""));
  return AD_FIELDS.filter(({ labels }) => {
    const column = header.findIndex((cell) => fieldHeader(labels).test(cell));
    if (column !== -1) return (cells[column] ?? "").replaceAll("**", "").trim() === "";
    return !cells.some((cell) => fieldLine(labels).test(cell));
  }).map(({ field }) => field);
}

/**
 * Every active architecture decision (`AD-n`, not retired) of a `kind: architecture` document
 * states its three fields (`AD_FIELDS_MISSING`, at the decision's line).
 */
export function decisionFieldProblems(
  files: readonly DocumentFile[],
  documents: readonly ParsedDocument[],
): DocsProblem[] {
  const texts = new Map(files.map((file) => [file.path, file.text]));
  const problems: DocsProblem[] = [];
  for (const document of documents) {
    if (!holdsDecisions(document.kind?.value)) continue;
    const decisions = document.definitions.filter(
      (definition) => definition.id.startsWith("AD-") && !definition.retired,
    );
    if (decisions.length === 0) continue;
    const lines = normalizeText(texts.get(document.path) ?? "")
      .normalize("NFC")
      .split("\n");
    for (const decision of decisions) {
      const index = decision.line - 1;
      const opening = unquote(lines[index] ?? "");
      const row =
        headingLevel(opening) === undefined &&
        isRow(opening) &&
        (tableCells(opening)[0] ?? "").replaceAll("**", "").trim() === decision.id;
      const missing = row
        ? rowMissing(lines, index)
        : AD_FIELDS.filter(
            ({ labels }) => !blockOf(lines, index).some((line) => fieldLine(labels).test(line)),
          ).map(({ field }) => field);
      if (missing.length === 0) continue;
      problems.push({
        code: ErrorCode.AD_FIELDS_MISSING,
        message_key: "error.ad_fields_missing",
        details: { path: document.path, line: decision.line, id: decision.id, missing },
      });
    }
  }
  return problems;
}
