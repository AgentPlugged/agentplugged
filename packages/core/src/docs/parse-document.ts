import {
  ArchitectureHeaderSchema,
  BRAND_RULES_FIELD,
  BRAND_STYLE_FILES_FIELD,
  DOCUMENT_ID_PATTERN,
  DOCUMENT_KINDS,
  type DocumentHeader,
  DocumentHeaderSchema,
  EpicHeaderSchema,
  KNOWLEDGE_CODE_FIELD,
  KNOWLEDGE_SOURCES_FIELD,
  KNOWLEDGE_STORY_FIELD,
  LAUNCH_CONTENT_FIELD,
  LAUNCH_LANGUAGE_FIELD,
  LAUNCH_SEO_FIELD,
  REQUIREMENT_ID_PATTERN,
  RESEARCH_FIELD,
  SALES_FIELD,
  STORY_DOCUMENT_ID_PATTERN,
  StoryHeaderSchema,
  UX_SYSTEM_FIELD,
  UX_TOKENS_FIELD,
} from "@agentplugged/protocol";
import { isMap, isScalar, parseDocument } from "yaml";
import { reasonDetails } from "../errors.js";
import { isGenerated, normalizeText, splitFrontmatter } from "../init/generated.js";
import { ROOT_FIELD } from "../init/method-config.js";

/**
 * A requirement identifier opening a line, a list item (bulleted or ordered), a heading, a
 * blockquote line or the first cell of a table row.
 */
export interface Definition {
  readonly id: string;
  readonly path: string;
  /** Line number in the file, from 1. */
  readonly line: number;
  /** The text after the separator, as written (NFC, without `**`). */
  readonly text: string;
  /** True when the text starts with `(retirée)`, `(retired)` or `~~`. */
  readonly retired: boolean;
}

/** A field of the header at fault. */
export interface HeaderIssue {
  readonly field: string;
  readonly line: number;
  /** `reason` (English) and, when known, `reason_key`. */
  readonly details: Readonly<Record<string, unknown>>;
}

/** A value of the header with the line of its key. */
export interface HeaderValue<T> {
  readonly value: T;
  readonly line: number;
}

export interface ParsedDocument {
  readonly path: string;
  /** The header, when valid. */
  readonly header: DocumentHeader | undefined;
  /** Line of the header's `id` key (1 when unknown). */
  readonly idLine: number;
  /** The header's `id` when it is a valid one, even if another field is at fault. */
  readonly id: string | undefined;
  /** The header's `owner` when its format is valid, even if another field is at fault. */
  readonly owner: HeaderValue<string> | undefined;
  /** The header's `kind` when it is a known kind, even if another field is at fault. */
  readonly kind: HeaderValue<string> | undefined;
  /** The header's links of a valid format, even if another field is at fault. */
  readonly links: readonly HeaderValue<string>[];
  readonly issues: readonly HeaderIssue[];
  readonly definitions: readonly Definition[];
  /** Line of a code fence never closed: the lines after it are code, and not read. */
  readonly unclosedFence: number | undefined;
  /** The level 2 sections of the body, in order. */
  readonly sections: readonly Section[];
  /** A story's fields of a valid format, even if another field is at fault. */
  readonly story: StoryFields | undefined;
  /** An epic's `out_of_scope` values of a valid format. */
  readonly outOfScope: readonly HeaderValue<string>[];
  /** The header's `title` when it is a string. */
  readonly title: HeaderValue<string> | undefined;
  /** The template markers left in the body, outside code. */
  readonly placeholders: readonly Placeholder[];
  /**
   * The raw value of the header's `sources` key, with its line, when the key is there (story
   * 3.11: what a page of the knowledge base was built from).
   */
  readonly sources?: HeaderValue<unknown>;
  /** The raw value of `code` (the code a page of the knowledge base describes). */
  readonly code?: HeaderValue<unknown>;
  /** The raw value of `last_story` (the last merged story a page took in). */
  readonly last_story?: HeaderValue<unknown>;
  /** The raw value of `seo` (the search fields of a page of the launch). */
  readonly seo?: HeaderValue<unknown>;
  /** The raw value of `language` (the language a launch document is written in). */
  readonly language?: HeaderValue<unknown>;
  /** The raw value of `sales` (the sales fields of an offer page or of a sequence). */
  readonly sales?: HeaderValue<unknown>;
  /** The raw value of `research` (the fields of a research report). */
  readonly research?: HeaderValue<unknown>;
  /** The raw value of `content` (the block of a content or of a campaign plan). */
  readonly content?: HeaderValue<unknown>;
  /** The raw value of `tokens` (the design tokens of the UX specification). */
  readonly tokens?: HeaderValue<unknown>;
  /** The raw value of `ui_system` (the UI system the specification builds on). */
  readonly ui_system?: HeaderValue<unknown>;
  /** The raw value of `brand_rules` (the fixed rules of the identity). */
  readonly brand_rules?: HeaderValue<unknown>;
  /** The raw value of `style_files` (the style files of the code the rules bind). */
  readonly style_files?: HeaderValue<unknown>;
}

/** A level 2 section of a document's body: up to the next level 1 or 2 heading. */
export interface Section {
  /** The heading's text, NFC, lowercased, `’` read as `'`. */
  readonly title: string;
  /** Line of the heading in the file. */
  readonly line: number;
  /** The lines below the heading (code fences included), as written. */
  readonly lines: readonly string[];
}

/** The fields of a story header that `docs check` follows, each with the line of its key. */
export interface StoryFields {
  readonly epic: HeaderValue<string> | undefined;
  readonly reviewer: HeaderValue<string> | undefined;
  readonly requirements: readonly HeaderValue<string>[];
  readonly dependsOn: readonly HeaderValue<string>[];
}

const SPACE = "[ \\t\\u00A0\\u202F]";
const QUOTE = new RegExp(`^(?: {0,3}>${SPACE}?)+`);
const PREFIX = new RegExp(`^(#{1,6}${SPACE}+|[-*+]${SPACE}+|\\d{1,9}[.)]${SPACE}+)?`);
const IDENTIFIER = /^(?:EF|ENF|PU|MS|AD)-[1-9]\d*(?![\w-])/;
const TAGS = new RegExp(`^(?:${SPACE}*\\[[^\\]\\n]*\\])*${SPACE}*`);
const SEPARATOR = new RegExp(`^(?:[:—–]|-(?=${SPACE}|$))${SPACE}*`);
const RETIRED = /^(?:\(retirée\)|\(retired\)|~~)/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const OWNER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Fewer letters and digits than this, and a text never counts as moved (`TBD`, `N/A`…). */
export const MIN_COMPARED_LENGTH = 12;

function definitionOf(id: string, text: string): Pick<Definition, "id" | "text" | "retired"> {
  return { id, text, retired: RETIRED.test(text) };
}

/**
 * The cells of a table row, trimmed: the outer pipes are optional, an escaped pipe (`\|`) stays
 * in its cell.
 */
export function tableCells(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

/**
 * A table row whose first cell is exactly an identifier: the other cells are its text. The row
 * may start without a pipe (`AD-1 | … | …`).
 */
function tableDefinition(line: string): Pick<Definition, "id" | "text" | "retired"> | undefined {
  const row = line.trim();
  if (!row.startsWith("|") && !/(?<!\\)\|/.test(row)) return undefined;
  const cells = tableCells(row);
  const id = (cells[0] ?? "").replaceAll("**", "").trim();
  if (!REQUIREMENT_ID_PATTERN.test(id)) return undefined;
  const text = cells
    .slice(1)
    .map((cell) => cell.trim())
    .filter((cell) => cell !== "")
    .join(" | ");
  return definitionOf(id, text);
}

/**
 * The definition a line opens, if any: an identifier at its start (after `>` quote markers, a
 * list marker or a heading's `#`), optional `[tags]`, then a separator (`:`, `—`, `–` or ` - `);
 * `**` are ignored. A heading may end right after the identifier. In a table row, the first cell
 * must be the identifier. Anywhere else, an identifier is a mention.
 */
export function parseDefinitionLine(
  line: string,
): Pick<Definition, "id" | "text" | "retired"> | undefined {
  const unquoted = line.normalize("NFC").replace(QUOTE, "");
  const table = tableDefinition(unquoted);
  if (table !== undefined) return table;
  const prefix = PREFIX.exec(unquoted);
  const heading = prefix?.[1]?.startsWith("#") === true;
  let rest = unquoted.slice(prefix?.[0].length ?? 0).replaceAll("**", "");
  const id = IDENTIFIER.exec(rest)?.[0];
  if (id === undefined) return undefined;
  rest = rest.slice(id.length);
  rest = rest.slice(TAGS.exec(rest)?.[0].length ?? 0);
  const separator = SEPARATOR.exec(rest);
  if (separator) return definitionOf(id, rest.slice(separator[0].length).trim());
  if (heading && rest.trim() === "") return definitionOf(id, "");
  return undefined;
}

/** Every definition of a body, and the line of a code fence left open, if any. */
export function parseDefinitions(
  path: string,
  body: string,
  firstLine = 1,
): { definitions: Definition[]; unclosedFence: number | undefined } {
  const definitions: Definition[] = [];
  let fence: { marker: string; line: number } | undefined;
  body.split("\n").forEach((line, index) => {
    const marker = FENCE.exec(line)?.[1];
    if (fence !== undefined) {
      const open = fence.marker;
      if (marker !== undefined && marker[0] === open[0] && marker.length >= open.length) {
        fence = undefined;
      }
      return;
    }
    if (marker !== undefined) {
      fence = { marker, line: firstLine + index };
      return;
    }
    const found = parseDefinitionLine(line);
    if (found) definitions.push({ ...found, path, line: firstLine + index });
  });
  return { definitions, unclosedFence: fence?.line };
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/** A heading's title as compared: NFC, `**` removed, spaces normalised, lowercased, `’` → `'`. */
export function sectionTitle(text: string): string {
  return text
    .normalize("NFC")
    .replaceAll("**", "")
    .replaceAll("’", "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** A setext underline: `===` (level 1) or `---` (level 2) under a paragraph line. */
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;

/** A line that may be a setext heading's text: plain paragraph text, nothing else. */
function isParagraphText(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "" || /^ {4}/.test(line)) return false;
  return !/^(?:#|>|[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$)|\||<!--)/.test(trimmed);
}

/**
 * A template marker left in a text: `<…>` holding a space or `…`, outside inline
 * code, and neither an HTML tag with attributes (`=`, `"`), a comment (`<!`) nor a link (`/`).
 */
const PLACEHOLDER = /<(?!!)[^<>=/"\n]*[\s…][^<>=/"\n]*>/g;

/** The template markers of one line, inline code left out. */
export function placeholdersOf(line: string): string[] {
  return [...line.replace(/`+[^`]*`+/g, "").matchAll(PLACEHOLDER)].map((match) => match[0]);
}

/** A template marker found in a document, with its line. */
export interface Placeholder {
  readonly line: number;
  readonly marker: string;
}

/**
 * The level 2 sections of a body (ATX `## ` or setext `---` headings): each runs to the next level
 * 1 or 2 heading. Headings inside a code fence are text. Also the template markers left outside
 * code fences.
 */
export function scanBody(
  body: string,
  firstLine = 1,
): { sections: Section[]; placeholders: Placeholder[] } {
  const sections: { title: string; line: number; lines: string[] }[] = [];
  const placeholders: Placeholder[] = [];
  let current: { title: string; line: number; lines: string[] } | undefined;
  let fence: string | undefined;
  let previous: string | undefined;
  body.split("\n").forEach((line, index) => {
    const marker = FENCE.exec(line)?.[1];
    if (fence !== undefined) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined;
      }
      current?.lines.push(line);
      previous = undefined;
      return;
    }
    if (marker !== undefined) {
      fence = marker;
      current?.lines.push(line);
      previous = undefined;
      return;
    }
    const setext = SETEXT.exec(line)?.[1];
    if (setext !== undefined && previous !== undefined && isParagraphText(previous)) {
      // The paragraph line above becomes the heading's text.
      current?.lines.pop();
      const title = previous;
      current =
        setext[0] === "-"
          ? { title: sectionTitle(title), line: firstLine + index - 1, lines: [] }
          : undefined;
      if (current !== undefined) sections.push(current);
      previous = undefined;
      return;
    }
    for (const found of placeholdersOf(line)) {
      placeholders.push({ line: firstLine + index, marker: found });
    }
    const heading = HEADING.exec(line);
    const level = heading?.[1]?.length ?? 0;
    if (heading !== null && level <= 2) {
      current =
        level === 2
          ? { title: sectionTitle(heading[2] ?? ""), line: firstLine + index, lines: [] }
          : undefined;
      if (current !== undefined) sections.push(current);
      previous = undefined;
      return;
    }
    current?.lines.push(line);
    previous = heading !== null ? undefined : line;
  });
  return { sections, placeholders };
}

/** The level 2 sections of a body (see `scanBody`). */
export function parseSections(body: string, firstLine = 1): Section[] {
  return scanBody(body, firstLine).sections;
}

/**
 * A section's text as compared for a frozen intent: NFC, spaces at the end of lines removed,
 * blank lines at the start and the end removed.
 */
export function sectionText(lines: readonly string[]): string {
  const trimmed = lines.map((line) => line.normalize("NFC").trimEnd());
  let start = 0;
  let end = trimmed.length;
  while (start < end && trimmed[start] === "") start += 1;
  while (end > start && trimmed[end - 1] === "") end -= 1;
  return trimmed.slice(start, end).join("\n");
}

/**
 * Text compared to detect a renumbering: NFC, retired markers and `~~` removed, spaces
 * normalised, case ignored. Empty when it holds fewer than `MIN_COMPARED_LENGTH` letters and
 * digits: such a text never counts as moved.
 */
export function comparableText(text: string): string {
  const plain = text
    .normalize("NFC")
    .replace(/^\s*\((?:retirée|retired)\)/i, "")
    .replaceAll("~~", "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return plain.replace(/[^\p{L}\p{N}]/gu, "").length < MIN_COMPARED_LENGTH ? "" : plain;
}

/** Line of a top-level key in the header (the header's first line is 2), or 1. */
function keyLine(yaml: string, key: string): number {
  const document = parseDocument(yaml);
  if (isMap(document.contents)) {
    for (const pair of document.contents.items) {
      if (isScalar(pair.key) && String(pair.key.value) === key && pair.key.range) {
        return 2 + yaml.slice(0, pair.key.range[0]).split("\n").length - 1;
      }
    }
  }
  return 1;
}

function issueOf(field: string, line: number, reason: string, reasonKey?: string): HeaderIssue {
  return { field, line, details: reasonDetails(reason, reasonKey) };
}

const NO_HEADER = {
  header: undefined,
  idLine: 1,
  id: undefined,
  owner: undefined,
  kind: undefined,
  story: undefined,
  outOfScope: [],
  title: undefined,
};

/** The strings of a header list that match `pattern`, each with the line of its key. */
function listValues(
  record: Readonly<Record<string, unknown>> | undefined,
  yaml: string,
  key: string,
  pattern: RegExp,
): HeaderValue<string>[] {
  const list = record?.[key];
  if (!Array.isArray(list)) return [];
  const line = keyLine(yaml, key);
  return (list as unknown[])
    .filter((item): item is string => typeof item === "string" && pattern.test(item))
    .map((item) => ({ value: item, line }));
}

/** A header string that matches `pattern`, with the line of its key. */
function stringValue(
  record: Readonly<Record<string, unknown>> | undefined,
  yaml: string,
  key: string,
  pattern: RegExp,
): HeaderValue<string> | undefined {
  const value = record?.[key];
  return typeof value === "string" && pattern.test(value)
    ? { value, line: keyLine(yaml, key) }
    : undefined;
}

/** The schema of a header: a story's or an epic's contract, else the common one. */
function schemaOf(kind: unknown) {
  if (kind === "story") return StoryHeaderSchema;
  if (kind === "epic") return EpicHeaderSchema;
  if (kind === "architecture") return ArchitectureHeaderSchema;
  return DocumentHeaderSchema;
}

/**
 * Reads a document: its header, checked against the schema (every field at fault is reported),
 * and its requirement definitions. A document carrying the "Generated by agentplugged" marker
 * (first line, or right after its header — a template copied from a generated skill folder) is
 * reported too: the marker would make every agent treat the document as generated, never to be
 * edited.
 */
export function parseDocumentFile(path: string, raw: string): ParsedDocument {
  const parsed = parseDocumentText(path, raw);
  const text = normalizeText(raw).normalize("NFC");
  if (!isGenerated(text)) return parsed;
  const parts = splitFrontmatter(text);
  const line = parts === undefined ? 1 : 3 + parts.yaml.split("\n").length - 1;
  const marker = issueOf(
    ROOT_FIELD,
    line,
    'the "Generated by agentplugged" line is left: remove it',
    "reason.doc_generated_marker",
  );
  return { ...parsed, issues: [...parsed.issues, marker] };
}

function parseDocumentText(path: string, raw: string): ParsedDocument {
  const text = normalizeText(raw).normalize("NFC");
  const parts = splitFrontmatter(text);
  if (parts === undefined) {
    const missing = "the header (YAML frontmatter) is missing";
    return {
      path,
      ...NO_HEADER,
      links: [],
      issues: [issueOf(ROOT_FIELD, 1, missing, "reason.doc_header_missing")],
      ...parseDefinitions(path, text),
      ...scanBody(text),
    };
  }
  const bodyLine = 3 + parts.yaml.split("\n").length - 1;
  const body = {
    ...parseDefinitions(path, parts.body, bodyLine),
    ...scanBody(parts.body, bodyLine),
  };
  const document = parseDocument(parts.yaml, { uniqueKeys: true });
  const syntaxError = document.errors[0];
  if (syntaxError) {
    const reason = syntaxError.message.split("\n")[0] ?? syntaxError.code;
    const line = 1 + (syntaxError.linePos?.[0]?.line ?? 0);
    return { path, ...NO_HEADER, links: [], issues: [issueOf(ROOT_FIELD, line, reason)], ...body };
  }
  const value: unknown = document.toJS();
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  // The values of a valid format, read even when another field is at fault.
  const idLine = keyLine(parts.yaml, "id");
  const rawId = record?.id;
  const id = typeof rawId === "string" && DOCUMENT_ID_PATTERN.test(rawId) ? rawId : undefined;
  const ownerValue = record?.owner;
  const owner =
    typeof ownerValue === "string" && OWNER_PATTERN.test(ownerValue)
      ? { value: ownerValue, line: keyLine(parts.yaml, "owner") }
      : undefined;
  const kindValue = record?.kind;
  const kind =
    typeof kindValue === "string" && (DOCUMENT_KINDS as readonly string[]).includes(kindValue)
      ? { value: kindValue, line: keyLine(parts.yaml, "kind") }
      : undefined;
  const linksLine = keyLine(parts.yaml, "links");
  const links = (Array.isArray(record?.links) ? (record.links as unknown[]) : [])
    .filter(
      (link): link is string =>
        typeof link === "string" &&
        (DOCUMENT_ID_PATTERN.test(link) || REQUIREMENT_ID_PATTERN.test(link)),
    )
    .map((link) => ({ value: link, line: linksLine }));
  const story: StoryFields | undefined =
    kindValue === "story"
      ? {
          epic: stringValue(record, parts.yaml, "epic", /^[a-z0-9-]+$/),
          reviewer: stringValue(record, parts.yaml, "reviewer", OWNER_PATTERN),
          requirements: listValues(record, parts.yaml, "requirements", REQUIREMENT_ID_PATTERN),
          dependsOn: listValues(record, parts.yaml, "depends_on", STORY_DOCUMENT_ID_PATTERN),
        }
      : undefined;
  const outOfScope =
    kindValue === "epic"
      ? listValues(record, parts.yaml, "out_of_scope", REQUIREMENT_ID_PATTERN)
      : [];
  const title = stringValue(record, parts.yaml, "title", /[\s\S]/);
  const sources =
    record !== undefined && Object.hasOwn(record, KNOWLEDGE_SOURCES_FIELD)
      ? {
          value: record[KNOWLEDGE_SOURCES_FIELD],
          line: keyLine(parts.yaml, KNOWLEDGE_SOURCES_FIELD),
        }
      : undefined;
  const rawField = (field: string) =>
    record !== undefined && Object.hasOwn(record, field)
      ? { value: record[field], line: keyLine(parts.yaml, field) }
      : undefined;
  const code = rawField(KNOWLEDGE_CODE_FIELD);
  const lastStory = rawField(KNOWLEDGE_STORY_FIELD);
  const seo = rawField(LAUNCH_SEO_FIELD);
  const language = rawField(LAUNCH_LANGUAGE_FIELD);
  const sales = rawField(SALES_FIELD);
  const content = rawField(LAUNCH_CONTENT_FIELD);
  const research = rawField(RESEARCH_FIELD);
  const tokens = rawField(UX_TOKENS_FIELD);
  const uiSystem = rawField(UX_SYSTEM_FIELD);
  const brandRules = rawField(BRAND_RULES_FIELD);
  const styleFiles = rawField(BRAND_STYLE_FILES_FIELD);
  const values = {
    idLine,
    id,
    owner,
    kind,
    links,
    story,
    outOfScope,
    title,
    ...(sources === undefined ? {} : { sources }),
    ...(code === undefined ? {} : { code }),
    ...(lastStory === undefined ? {} : { last_story: lastStory }),
    ...(seo === undefined ? {} : { seo }),
    ...(language === undefined ? {} : { language }),
    ...(sales === undefined ? {} : { sales }),
    ...(content === undefined ? {} : { content }),
    ...(research === undefined ? {} : { research }),
    ...(tokens === undefined ? {} : { tokens }),
    ...(uiSystem === undefined ? {} : { ui_system: uiSystem }),
    ...(brandRules === undefined ? {} : { brand_rules: brandRules }),
    ...(styleFiles === undefined ? {} : { style_files: styleFiles }),
  };

  const result = schemaOf(kindValue).safeParse(value);
  if (result.success) return { path, header: result.data, ...values, issues: [], ...body };
  if (record === undefined) {
    const issue = issueOf(ROOT_FIELD, 1, "expected keys and values", "reason.invalid_value");
    return { path, header: undefined, ...values, issues: [issue], ...body };
  }
  const issues = result.error.issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.map(String).join(".") : ROOT_FIELD;
    const top = issue.path[0];
    const line = typeof top === "string" ? keyLine(parts.yaml, top) : 1;
    if (issue.path.length === 1 && typeof top === "string" && record[top] === undefined) {
      return issueOf(field, line, "missing", "reason.required");
    }
    return issueOf(field, line, issue.message);
  });
  return { path, header: undefined, ...values, issues, ...body };
}
