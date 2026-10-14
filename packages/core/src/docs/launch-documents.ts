import {
  type BrandDocumentReason,
  CAMPAIGN_SECTIONS,
  CONTENT_ID_PREFIXES,
  CONTENT_SECTIONS,
  CONTENT_TYPES,
  ErrorCode,
  KEYWORD_PROVENANCES,
  type LaunchDocumentReason,
  POSITIONING_DOCUMENT_ID,
  POSITIONING_SECTIONS,
  type PositioningSection,
  REFERENCE_PROVENANCES,
  REQUIREMENT_ID_PATTERN,
  SEO_DESCRIPTION_MAX,
  SEO_TITLE_MAX,
  type UxDocumentReason,
} from "@agentplugged/protocol";
import { documentOwner } from "../agents/agent-aliases.js";
import { METHOD_DIR } from "../init/layout.js";
import { approvedAt, byAnswer } from "../phases/phases.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { isRecord } from "../values.js";
import type { DocsProblem, DocsWarning } from "./docs-base.js";
import { blobIdsOf, isKnowledgePage, pathKey } from "./knowledge-freshness.js";
import {
  type ParsedDocument,
  placeholdersOf,
  type Section,
  sectionText,
  tableCells,
} from "./parse-document.js";
import { warning } from "./story-rules.js";

/**
 * The launch documents of Julien, as pure functions. The positioning is the one
 * document the launch builds on (the contents, the sales documents);
 * every page of the product links to it and carries the fields the search engines read. `docs
 * check` verifies what a program can: the header and the sections of the positioning, the search
 * fields of each page, and that a keyword either carries a volume it can prove or is marked as a
 * hypothesis. Whether the positioning is *validated* is read from the checkpoints
 * (`positioningStatus`), never from the document.
 */

/** The positioning: where Julien writes it, and where the launch reads it. */
export const POSITIONING_PATH = `${METHOD_DIR}/docs/launch/positioning.md`;

/** The pages of the product: one file each, under this folder. */
export const LAUNCH_PAGES_DIR = `${METHOD_DIR}/docs/launch/pages/`;

/** True for the positioning document. */
export function isPositioning(document: ParsedDocument): boolean {
  return pathKey(document.path) === POSITIONING_PATH;
}

/** True for a page of the launch. */
export function isLaunchPage(document: ParsedDocument): boolean {
  return pathKey(document.path).startsWith(LAUNCH_PAGES_DIR);
}

/** The owners a launch document may name: Julien (also under a former identifier), or the creator. */
const LAUNCH_OWNERS: ReadonlySet<string> = new Set(["julien", "creator"]);

/** A language tag as `fr`, `en-GB`, `pt-BR` (BCP 47, the part `docs check` can verify). */
const LANGUAGE_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** A calendar date as `2026-10-04`. */
export const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The answers that validate a deliverable: an approval, with or without reservations. */
const APPROVALS: ReadonlySet<string> = new Set(["approved", "approved_with_reservations"]);

/** The statuses a row of the positioning's Evidence table may carry. */
const EVIDENCE_STATUSES: ReadonlySet<string> = new Set(["verified", "stated", "untrusted"]);

/** What a launch document reports. */
export interface LaunchCheck {
  readonly problems: DocsProblem[];
  readonly warnings: DocsWarning[];
}

type Details = Record<string, unknown>;

export function invalid(
  path: string,
  line: number,
  reason: LaunchDocumentReason | UxDocumentReason | BrandDocumentReason,
  details: Details = {},
): DocsProblem {
  return {
    code: ErrorCode.LAUNCH_DOCUMENT_INVALID,
    message_key: `error.launch_document_invalid.${reason}`,
    details: { path, line, reason, ...details },
  };
}

/** A string with something in it, on one line. */
export const isLine = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "" && !/[\r\n]/.test(value.trim());

export function languageProblem(document: ParsedDocument): DocsProblem[] {
  const language = document.language;
  const value = language?.value;
  if (typeof value === "string" && LANGUAGE_PATTERN.test(value)) return [];
  return [invalid(document.path, language?.line ?? 1, "language", { field: "language" })];
}

/** The lines without the tables that have a header and a separator but no filled data row. */
function withoutEmptyTables(lines: readonly string[]): string[] {
  const kept: string[] = [];
  let at = 0;
  while (at < lines.length) {
    if (!/^\s*\|/.test(lines[at] ?? "")) {
      kept.push(lines[at] ?? "");
      at += 1;
      continue;
    }
    let end = at;
    while (end < lines.length && /^\s*\|/.test(lines[end] ?? "")) end += 1;
    const block = lines.slice(at, end);
    const dataRows = /^\s*\|[\s:|-]*$/.test(block[1] ?? "") ? block.slice(2) : block;
    const filled = dataRows.some((row) => tableCells(row).some((cell) => cell !== ""));
    const header = dataRows !== block;
    if (!header || filled) kept.push(...block);
    at = end;
  }
  return kept;
}

/**
 * A section's text as read: HTML comments, invisible characters, a heading alone, a table with no
 * cell filled, an empty bullet and a text of punctuation only (a dash, a dot) are nothing.
 */
export function visibleText(lines: readonly string[]): string {
  const text = withoutEmptyTables(sectionText(lines).split("\n"))
    .join("\n")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/&(?:nbsp|#160|#xa0);/gi, " ")
    .replace(/[­ᅟᅠ᠎​-‏⁠⠀ㅤ﻿]/g, "")
    .split("\n")
    .filter(
      (line) =>
        !/^\s*#{1,6}(?:\s.*)?$/.test(line) &&
        !/^\s*\|[\s:|-]*$/.test(line) &&
        !/^\s*(?:[-*+]|\d+[.)])(?:\s+\[[ xX]\])?\s*$/.test(line),
    )
    .join("\n")
    .trim();
  return /^[\s\p{P}\p{S}]*$/u.test(text) ? "" : text;
}

/** The Evidence table: at least one row whose status is `verified`, `stated` or `untrusted`. */
export function evidenceRated(section: Section): boolean {
  return section.lines.some((line) => {
    const cells = tableCells(line);
    return (
      line.includes("|") &&
      EVIDENCE_STATUSES.has((cells[1] ?? "").replaceAll("`", "").toLowerCase())
    );
  });
}

/** The sections of the positioning: each one present once, with something in it. */
function sectionProblems(document: ParsedDocument): DocsProblem[] {
  const problems: DocsProblem[] = [];
  for (const section of Object.keys(POSITIONING_SECTIONS) as PositioningSection[]) {
    const titles: readonly string[] = POSITIONING_SECTIONS[section];
    const [first, second] = document.sections.filter((candidate) =>
      titles.includes(candidate.title),
    );
    const reason: LaunchDocumentReason | undefined =
      first === undefined
        ? "section_missing"
        : second !== undefined
          ? "section_duplicate"
          : visibleText(first.lines) === ""
            ? "section_empty"
            : section === "evidence" && !evidenceRated(first)
              ? "evidence_status"
              : undefined;
    if (reason === undefined) continue;
    problems.push(
      invalid(document.path, (second ?? first)?.line ?? 1, reason, {
        section,
        heading: `## ${titles[0]?.replace(/^./, (letter) => letter.toUpperCase())}`,
      }),
    );
  }
  return problems;
}

function positioningProblems(document: ParsedDocument): DocsProblem[] {
  const { path } = document;
  const problems: DocsProblem[] = [];
  if (document.id !== undefined && document.id !== POSITIONING_DOCUMENT_ID) {
    problems.push(
      invalid(path, document.idLine, "positioning_id", {
        field: "id",
        expected: POSITIONING_DOCUMENT_ID,
      }),
    );
  }
  if (document.kind !== undefined && document.kind.value !== "note") {
    problems.push(
      invalid(path, document.kind.line, "positioning_kind", { field: "kind", expected: "note" }),
    );
  }
  if (document.owner !== undefined && !LAUNCH_OWNERS.has(documentOwner(document.owner.value))) {
    problems.push(
      invalid(path, document.owner.line, "positioning_owner", {
        field: "owner",
        owner: document.owner.value,
      }),
    );
  }
  // Drawn from the knowledge base: at least one document, not only requirement identifiers.
  if (!document.links.some((link) => !REQUIREMENT_ID_PATTERN.test(link.value))) {
    problems.push(
      invalid(path, document.links[0]?.line ?? 1, "positioning_links", { field: "links" }),
    );
  }
  return [...problems, ...languageProblem(document), ...sectionProblems(document)];
}

/** A keyword of `seo.keywords`: a term, then a proven volume or the mark of a hypothesis. */
function keywordProblems(
  path: string,
  line: number,
  entry: unknown,
  index: number,
  now: number | undefined,
): DocsProblem[] {
  const field = `seo.keywords.${index}`;
  if (!isRecord(entry) || !isLine(entry.term)) {
    return [invalid(path, line, "keyword_invalid", { field: `${field}.term`, index })];
  }
  const keyword = entry.term;
  const at = { keyword, index };
  const hypothesis = entry.hypothesis;
  if (hypothesis !== undefined && typeof hypothesis !== "boolean") {
    return [invalid(path, line, "keyword_invalid", { field: `${field}.hypothesis`, ...at })];
  }
  const claims = ["volume", "source", "as_of", "provenance"].filter(
    (key) => entry[key] !== undefined && entry[key] !== null,
  );
  if (hypothesis === true) {
    // A hypothesis claims nothing: no volume, no source that would make it look verified, and no
    // other field to carry a figure.
    const extra = Object.keys(entry).filter((key) => key !== "term" && key !== "hypothesis");
    const claimed = [...claims, ...extra.filter((key) => !claims.includes(key))];
    return claimed.length === 0
      ? []
      : [invalid(path, line, "keyword_conflict", { field: `${field}.${claimed[0]}`, ...at })];
  }
  const volume = entry.volume;
  if (volume === undefined || volume === null) {
    return [invalid(path, line, "keyword_unverified", { field: `${field}.volume`, ...at })];
  }
  const proof = (key: string, ok: boolean) =>
    ok ? [] : [invalid(path, line, "keyword_proof", { field: `${field}.${key}`, ...at })];
  const date = typeof entry.as_of === "string" ? DATE_PATTERN.exec(entry.as_of) : null;
  const real =
    date !== null &&
    new Date(Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3])))
      .toISOString()
      .slice(0, 10) === entry.as_of;
  return [
    ...proof("volume", typeof volume === "number" && Number.isFinite(volume) && volume >= 0),
    ...proof("source", isLine(entry.source) && placeholdersOf(entry.source).length === 0),
    ...proof("as_of", real && (now === undefined || Date.parse(`${entry.as_of}T00:00:00Z`) <= now)),
    ...proof(
      "provenance",
      typeof entry.provenance === "string" &&
        (KEYWORD_PROVENANCES as readonly string[]).includes(entry.provenance),
    ),
  ];
}

function pageProblems(document: ParsedDocument, now: number | undefined): LaunchCheck {
  const { path } = document;
  const problems: DocsProblem[] = [];
  const warnings: DocsWarning[] = [];
  if (!document.links.some((link) => link.value === POSITIONING_DOCUMENT_ID)) {
    problems.push(
      invalid(path, document.links[0]?.line ?? 1, "page_positioning_link", {
        field: "links",
        expected: POSITIONING_DOCUMENT_ID,
      }),
    );
  }
  problems.push(...languageProblem(document));
  const seo = document.seo;
  const line = seo?.line ?? 1;
  if (!isRecord(seo?.value)) {
    problems.push(invalid(path, line, "seo_missing", { field: "seo" }));
    return { problems, warnings };
  }
  const fields = seo.value;
  for (const key of ["intent", "title", "description"]) {
    if (!isLine(fields[key])) {
      problems.push(invalid(path, line, "seo_field", { field: `seo.${key}` }));
    }
  }
  const title = fields.title;
  if (isLine(title) && [...title].length > SEO_TITLE_MAX) {
    warnings.push(
      warning("launch_seo_title_long", { path, length: [...title].length, max: SEO_TITLE_MAX }),
    );
  }
  const description = fields.description;
  if (isLine(description) && [...description].length > SEO_DESCRIPTION_MAX) {
    warnings.push(
      warning("launch_seo_description_long", {
        path,
        length: [...description].length,
        max: SEO_DESCRIPTION_MAX,
      }),
    );
  }
  const keywords = fields.keywords;
  if (!Array.isArray(keywords) || keywords.length === 0) {
    problems.push(invalid(path, line, "keywords_missing", { field: "seo.keywords" }));
  } else {
    keywords.forEach((entry: unknown, index) => {
      problems.push(...keywordProblems(path, line, entry, index, now));
    });
  }
  // A template marker left in a search field: it would be published as it is.
  const texts = [fields.intent, fields.title, fields.description].filter(isLine);
  for (const entry of Array.isArray(keywords) ? (keywords as unknown[]) : []) {
    if (isRecord(entry) && isLine(entry.term)) texts.push(entry.term);
  }
  for (const marker of texts.flatMap((text) => placeholdersOf(text))) {
    problems.push({
      code: ErrorCode.DOC_PLACEHOLDER_LEFT,
      message_key: "error.doc_placeholder_left",
      details: { path, line, marker },
    });
  }
  return { problems, warnings };
}

/** The template markers left in the body of a launch document. */
export function placeholderProblems(document: ParsedDocument): DocsProblem[] {
  return document.placeholders.map(({ line, marker }) => ({
    code: ErrorCode.DOC_PLACEHOLDER_LEFT,
    message_key: "error.doc_placeholder_left",
    details: { path: document.path, line, marker },
  }));
}

/** Where the positioning stands, for the documents that build on it. */
export type PositioningState = "absent" | "draft" | "validated" | "changed";

export interface PositioningStatus {
  readonly state: PositioningState;
  /** The `publication` checkpoint that validated the version (`validated`), or the last one (`changed`). */
  readonly checkpoint?: string;
}

/**
 * Whether the positioning is validated: the last `publication` checkpoint approved (a lifting
 * decision, never a waiver, in the order of the answers) that cites the positioning in its
 * `documents` cites the very version the working copy holds (its Git blob). `absent`: no file;
 * `draft`: no such approval; `changed`: approved once, edited since (it must be validated again
 * before another document builds on it). A document or a phase end never validates it: the
 * positioning is a deliverable, and a deliverable is validated by its publication.
 */
export function positioningStatus(
  text: string | undefined,
  checkpoints: Iterable<CheckpointState>,
  now: number,
): PositioningStatus {
  return deliverableStatus(POSITIONING_PATH, text, checkpoints, now, ["publication"]);
}

/**
 * The same reading for any deliverable of the launch (the narrative): the last
 * approved checkpoint of one of `types` that cites `path` cites the version the file holds.
 */
export function deliverableStatus(
  path: string,
  text: string | undefined,
  checkpoints: Iterable<CheckpointState>,
  now: number,
  types: readonly string[],
): PositioningStatus {
  if (text === undefined) return { state: "absent" };
  const approved = [...checkpoints]
    .filter(
      (checkpoint) =>
        types.includes(checkpoint.type) &&
        approvedAt(checkpoint, now) &&
        // An option picked on a publication is a choice, not an approval of the text.
        APPROVALS.has(checkpoint.resolution?.decision ?? "") &&
        (checkpoint.documents ?? []).some((cited) => pathKey(cited.path) === path),
    )
    .sort(byAnswer);
  const last = approved.at(-1);
  if (last === undefined) return { state: "draft" };
  const cited = (last.documents ?? []).find((item) => pathKey(item.path) === path);
  const held = blobIdsOf(text);
  return held.includes(cited?.blob_sha.toLowerCase() ?? "")
    ? { state: "validated", checkpoint: last.id }
    : { state: "changed", checkpoint: last.id };
}

export interface LaunchCheckInput {
  readonly documents: readonly ParsedDocument[];
  /** The text of a document of the working copy, by its path as listed. */
  readonly textOf: (path: string) => string | undefined;
  /** The checkpoints and the clock: without them, whether the positioning is validated is not read. */
  readonly validations?: { readonly checkpoints: readonly CheckpointState[]; readonly now: number };
}

/**
 * The rules of the launch documents: the positioning (header, sections, language), each page
 * (link to the positioning, language, search fields, keywords) and the template markers left in
 * either. Warnings: a title or a description longer than a search engine shows, and a page
 * written while the positioning it builds on is not validated.
 */
export function launchDocumentChecks(input: LaunchCheckInput): LaunchCheck {
  const problems: DocsProblem[] = [];
  const warnings: DocsWarning[] = [];
  const positioning = input.documents.find(isPositioning);
  const positioningText = positioning === undefined ? undefined : input.textOf(positioning.path);
  const status =
    input.validations === undefined || positioning === undefined
      ? undefined
      : positioningStatus(positioningText, input.validations.checkpoints, input.validations.now);
  for (const document of input.documents) {
    if (isPositioning(document)) {
      problems.push(...positioningProblems(document), ...placeholderProblems(document));
    } else if (isLaunchPage(document)) {
      const page = pageProblems(document, input.validations?.now);
      problems.push(...page.problems, ...placeholderProblems(document));
      warnings.push(...page.warnings);
      if (status !== undefined && (status.state === "draft" || status.state === "changed")) {
        warnings.push(
          warning("launch_positioning_not_validated", {
            path: document.path,
            state: status.state,
          }),
        );
      }
    } else if (isLaunchContent(document)) {
      // The contents and the campaign plans build on the positioning too.
      const content = contentChecks(document, input, positioningText);
      problems.push(...content.problems, ...placeholderProblems(document));
      warnings.push(...content.warnings);
      if (status !== undefined && (status.state === "draft" || status.state === "changed")) {
        warnings.push(
          warning("launch_positioning_not_validated", {
            path: document.path,
            state: status.state,
          }),
        );
      }
    }
  }
  return { problems, warnings };
}

/** The contents of the launch: articles and community posts, one file each. */
export const LAUNCH_CONTENT_DIR = `${METHOD_DIR}/docs/launch/content/`;

/** The campaign plans of the launch: one file each. */
export const LAUNCH_CAMPAIGNS_DIR = `${METHOD_DIR}/docs/launch/campaigns/`;

/** True for a content or a campaign plan of the launch. */
export function isLaunchContent(document: ParsedDocument): boolean {
  const key = pathKey(document.path);
  return key.startsWith(LAUNCH_CONTENT_DIR) || key.startsWith(LAUNCH_CAMPAIGNS_DIR);
}

/** A Git blob id: SHA-1 or SHA-256, in hexadecimal. */
const BLOB_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** A date as `docs check` reads it: a real calendar day written `AAAA-MM-JJ`. */
function isRealDate(value: unknown): value is string {
  const date = typeof value === "string" ? DATE_PATTERN.exec(value) : null;
  return (
    date !== null &&
    new Date(Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3])))
      .toISOString()
      .slice(0, 10) === value
  );
}

/** A number as written in a text: `3`, `3,5`, `1 234`, `1.234,56` (bounded, no backtracking blow-up). */
const NUMBER = String.raw`\d+(?:[   ,.]\d{3})*(?:[.,]\d+)?`;
const GAP = String.raw`[   ]?`;

/**
 * A figure that needs its source: a percentage, an amount of money, a multiplier (`3x`, `10k`), a
 * count of users or customers, « nine out of ten ». An heuristic, not a proof: what it misses is
 * left to the skill and to the creator who reads the text before approving it.
 */
const FIGURE_PATTERN = new RegExp(
  `${NUMBER}${GAP}[kKmMbB]?(?:%|％|[€$£¥]|(?:percent|per ?cent|pour ?cent|pct|euros?|dollars?|eur|usd|gbp|chf|millions?|milliards?|billions?|users?|utilisateurs?|customers?|clients?|teams?|équipes?|companies|entreprises?|downloads?|téléchargements?)(?![\\p{L}\\d]))|` +
    `${NUMBER}[kKxX×](?![\\p{L}\\d])|` +
    `(?:[€$£¥]|(?<![\\p{L}\\d])(?:USD|EUR|GBP|CHF)(?![\\p{L}\\d]))${GAP}${NUMBER}|` +
    `(?<![\\p{L}\\d])(?:out of|sur) (?:ten|dix|\\d+)(?![\\p{L}\\d])`,
  "giu",
);

/** The figures a text states, left out of code, each with the number that must be sourced. */
export function figuresOf(text: string): Array<{ figure: string; digits: string }> {
  const prose = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  return [...prose.matchAll(FIGURE_PATTERN)].map((match) => {
    const number = new RegExp(NUMBER).exec(match[0]);
    return {
      figure: match[0].trim().toLowerCase(),
      digits: (number?.[0] ?? "").replace(/\D/g, ""),
    };
  });
}

/** True when a reference names the figure: the same number, or the same words. */
function figureCovered(
  { figure, digits }: { figure: string; digits: string },
  claims: readonly string[],
): boolean {
  return claims.some((claim) => {
    if (digits === "") return claim.toLowerCase().includes(figure);
    return [...claim.matchAll(new RegExp(NUMBER, "g"))].some(
      (match) => match[0].replace(/\D/g, "") === digits,
    );
  });
}

/** The keys a `content` block, its goal and one of its references may carry: no state, no cost. */
const CONTENT_KEYS: ReadonlySet<string> = new Set([
  "type",
  "channel",
  "positioning_blob",
  "goal",
  "references",
]);
const GOAL_KEYS: ReadonlySet<string> = new Set(["metric", "target", "by", "observed_with"]);
const REFERENCE_KEYS: ReadonlySet<string> = new Set(["claim", "source", "provenance", "as_of"]);

/** The day in milliseconds: a date of the day in a time zone ahead of UTC is not in the future. */
const DAY_MS = 86_400_000;

/** The required sections of a content, each present once with something in it. */
function contentSectionProblems(
  document: ParsedDocument,
  sections: Readonly<Record<string, readonly string[]>>,
): DocsProblem[] {
  const problems: DocsProblem[] = [];
  for (const [section, titles] of Object.entries(sections)) {
    const [first, second] = document.sections.filter((candidate) =>
      titles.includes(candidate.title),
    );
    const reason: LaunchDocumentReason | undefined =
      first === undefined
        ? "content_section_missing"
        : second !== undefined
          ? "content_section_duplicate"
          : visibleText(first.lines) === ""
            ? "content_section_empty"
            : undefined;
    if (reason === undefined) continue;
    problems.push(
      invalid(document.path, (second ?? first)?.line ?? 1, reason, {
        section,
        heading: `## ${titles[0]?.replace(/^./, (letter) => letter.toUpperCase())}`,
      }),
    );
  }
  return problems;
}

function contentKey(path: string, line: number, field: string): DocsProblem {
  return invalid(path, line, "content_key", { field });
}

/** The goal of a content: a metric, a target, a date and the way to observe it. */
function goalProblems(path: string, line: number, goal: unknown): DocsProblem[] {
  const field = (key: string) =>
    invalid(path, line, "content_goal", { field: `content.goal.${key}` });
  if (!isRecord(goal)) return [field("metric")];
  const problems: DocsProblem[] = Object.keys(goal)
    .filter((key) => !GOAL_KEYS.has(key))
    .map((key) => contentKey(path, line, `content.goal.${key}`));
  if (!isLine(goal.metric)) problems.push(field("metric"));
  if (typeof goal.target !== "number" || !Number.isFinite(goal.target) || goal.target <= 0) {
    problems.push(field("target"));
  }
  if (!isRealDate(goal.by)) problems.push(field("by"));
  if (!isLine(goal.observed_with)) problems.push(field("observed_with"));
  return problems;
}

/**
 * What a content cites: each reference names the claim, its source, its provenance and, outside
 * the base, its date. A source of the base is a document the content links to; anything else is
 * read outside the product (`untrusted`) or given by the creator.
 */
function referenceProblems(
  path: string,
  line: number,
  references: unknown,
  links: ReadonlySet<string>,
  bases: ReadonlySet<string>,
  now: number | undefined,
): DocsProblem[] {
  if (references === undefined || references === null) return [];
  if (!Array.isArray(references)) {
    return [invalid(path, line, "content_reference", { field: "content.references" })];
  }
  const problems: DocsProblem[] = [];
  references.forEach((entry: unknown, index) => {
    const field = (key: string) =>
      invalid(path, line, "content_reference", {
        field: `content.references.${index}.${key}`,
        index,
      });
    if (!isRecord(entry)) {
      problems.push(field("claim"));
      return;
    }
    if (!isLine(entry.claim)) problems.push(field("claim"));
    for (const key of Object.keys(entry).filter((key) => !REFERENCE_KEYS.has(key))) {
      problems.push(contentKey(path, line, `content.references.${index}.${key}`));
    }
    const provenance = entry.provenance;
    if (
      typeof provenance !== "string" ||
      !(REFERENCE_PROVENANCES as readonly string[]).includes(provenance)
    ) {
      problems.push(field("provenance"));
    }
    const source = entry.source;
    if (!isLine(source) || placeholdersOf(source).length > 0) {
      problems.push(field("source"));
    } else if (
      provenance === "knowledge_base" &&
      !(links.has(source.trim()) && bases.has(source.trim()))
    ) {
      // A source of the base is a page of the base the content links to, never a name, never the
      // positioning or another content (the only source held as verified).
      problems.push(field("source"));
    }
    if (provenance === "untrusted" || provenance === "creator") {
      const dated =
        isRealDate(entry.as_of) &&
        (now === undefined || Date.parse(`${entry.as_of}T00:00:00Z`) <= now + DAY_MS);
      if (!dated) problems.push(field("as_of"));
    }
  });
  return problems;
}

/**
 * The rules of a content or a campaign plan: its id, its `content` block (type, channel, goal,
 * the version of the positioning it was written on, what it cites), the links to the positioning
 * and to a page of the base, its language and its sections. Warnings: written on a version of
 * the positioning that is not the one in the file, and a figure with no reference.
 */
function contentChecks(
  document: ParsedDocument,
  input: LaunchCheckInput,
  positioningText: string | undefined,
): LaunchCheck {
  const { path } = document;
  const problems: DocsProblem[] = [];
  const warnings: DocsWarning[] = [];
  const folder = pathKey(path).startsWith(LAUNCH_CAMPAIGNS_DIR) ? "campaigns" : "content";
  const prefix = CONTENT_ID_PREFIXES[folder];
  if (
    document.id !== undefined &&
    !(document.id.startsWith(prefix) && document.id.length > prefix.length)
  ) {
    problems.push(
      invalid(path, document.idLine, "content_id", { field: "id", expected: `${prefix}<slug>` }),
    );
  }
  const linkValues = new Set(document.links.map((link) => link.value));
  const linksLine = document.links[0]?.line ?? 1;
  if (!linkValues.has(POSITIONING_DOCUMENT_ID)) {
    problems.push(
      invalid(path, linksLine, "content_positioning_link", {
        field: "links",
        expected: POSITIONING_DOCUMENT_ID,
      }),
    );
  }
  // The pages of the base (or of the site) it uses: at least one link that is a document of them.
  // The positioning and the other contents are not pages of the base, even if their header says so.
  const idsOf = (keep: (candidate: ParsedDocument) => boolean) =>
    new Set(
      input.documents
        .filter(keep)
        .flatMap((candidate) => (candidate.id === undefined ? [] : [candidate.id])),
    );
  const bases = idsOf(
    (candidate) =>
      isKnowledgePage(candidate) && !isPositioning(candidate) && !isLaunchContent(candidate),
  );
  const pages = new Set([...bases, ...idsOf(isLaunchPage)]);
  if (![...linkValues].some((link) => pages.has(link))) {
    problems.push(invalid(path, linksLine, "content_base_link", { field: "links" }));
  }
  problems.push(...languageProblem(document));

  const block = document.content;
  const line = block?.line ?? 1;
  const fields = isRecord(block?.value) ? block.value : undefined;
  const texts: string[] = [];
  let type: string | undefined;
  if (fields === undefined) {
    problems.push(invalid(path, line, "content_type", { field: "content" }));
  } else {
    for (const key of Object.keys(fields).filter((key) => !CONTENT_KEYS.has(key))) {
      problems.push(contentKey(path, line, `content.${key}`));
    }
    const declared = fields.type;
    type =
      typeof declared === "string" && Object.hasOwn(CONTENT_TYPES, declared) ? declared : undefined;
    const expectedFolder =
      type === undefined ? undefined : CONTENT_TYPES[type as keyof typeof CONTENT_TYPES];
    if (type === undefined || expectedFolder !== folder) {
      problems.push(
        invalid(path, line, "content_type", { field: "content.type", folder: `launch/${folder}/` }),
      );
      type = undefined;
    }
    if (type !== undefined && type !== "campaign_plan") {
      if (isLine(fields.channel)) texts.push(fields.channel);
      else problems.push(invalid(path, line, "content_channel", { field: "content.channel" }));
    }
    const blob = fields.positioning_blob;
    if (typeof blob !== "string" || !BLOB_PATTERN.test(blob)) {
      problems.push(
        invalid(path, line, "content_positioning_blob", { field: "content.positioning_blob" }),
      );
    } else if (
      positioningText !== undefined &&
      !blobIdsOf(positioningText).includes(blob.toLowerCase())
    ) {
      warnings.push(warning("launch_content_positioning_outdated", { path }));
    }
    problems.push(...goalProblems(path, line, fields.goal));
    const goal = isRecord(fields.goal) ? fields.goal : {};
    for (const value of [goal.metric, goal.observed_with]) if (isLine(value)) texts.push(value);
    problems.push(
      ...referenceProblems(
        path,
        line,
        fields.references,
        linkValues,
        bases,
        input.validations?.now,
      ),
    );
    for (const entry of Array.isArray(fields.references) ? (fields.references as unknown[]) : []) {
      if (isRecord(entry)) {
        for (const value of [entry.claim, entry.source]) if (isLine(value)) texts.push(value);
      }
    }
  }
  // A template marker left in the header: it would be published as it is.
  for (const marker of texts.flatMap((text) => placeholdersOf(text))) {
    problems.push({
      code: ErrorCode.DOC_PLACEHOLDER_LEFT,
      message_key: "error.doc_placeholder_left",
      details: { path, line, marker },
    });
  }

  problems.push(
    ...contentSectionProblems(
      document,
      folder === "campaigns" ? CAMPAIGN_SECTIONS : CONTENT_SECTIONS,
    ),
  );
  // A figure in the text of an article or a post, and nothing cited: a warning.
  if (type !== undefined && type !== "campaign_plan") {
    const text = document.sections.find((section) =>
      (CONTENT_SECTIONS.text as readonly string[]).includes(section.title),
    );
    const claims = (
      fields !== undefined && Array.isArray(fields.references)
        ? (fields.references as unknown[])
        : []
    ).flatMap((entry) => (isRecord(entry) && isLine(entry.claim) ? [entry.claim] : []));
    // Each figure of the text must be named by a reference: one unrelated reference covers none.
    const bare =
      text === undefined
        ? []
        : figuresOf(visibleText(text.lines)).filter((figure) => !figureCovered(figure, claims));
    if (text !== undefined && bare.length > 0) {
      warnings.push(
        warning("launch_content_figure_unsourced", {
          path,
          line: text.line,
          figure: bare[0]?.figure ?? "",
          count: bare.length,
        }),
      );
    }
  }
  return { problems, warnings };
}
