import {
  RESEARCH_EVIDENCE,
  RESEARCH_ID_PREFIX,
  RESEARCH_KEY_MARK,
  RESEARCH_MAX_CLAIMS,
  RESEARCH_ORIGINS,
  RESEARCH_PROVENANCE,
  RESEARCH_SECTIONS,
  RESEARCH_SHAPES,
  RESEARCH_SOURCE_ID,
  RESEARCH_SOURCE_KINDS,
  RESEARCH_TYPES,
  RESEARCH_UNDATED,
  type ResearchEvidence,
  type ResearchSection,
  type ResearchSourceKind,
} from "@agentplugged/protocol";
import { isRecord } from "../values.js";
import type { DocsProblem, DocsWarning } from "./docs-base.js";
import { pathKey } from "./knowledge-freshness.js";
import { isLine, type LaunchCheck, placeholderProblems } from "./launch-documents.js";
import type { ParsedDocument, Section } from "./parse-document.js";
import { hiddenLines, instructionLines } from "./research-scan.js";
import { selectionChecks } from "./research-selection.js";
import { headingOf, plainCell, problemOf, type Row, tablesOf } from "./research-tables.js";
import { realDate, sectionState } from "./sales-documents.js";
import { warning } from "./story-rules.js";

/**
 * The research reports, as pure functions. A page with a `research` block in its
 * header is a report: `docs check` verifies what a program can. The header (id, subject, types,
 * date), the three sections (claims, sources, instructions detected), that every claim carries
 * its level and its sources (the cascade: a primary source, else a secondary one, else « doubt »
 * said as such), that every source is read as untrusted (an address, a real date, its kind), and
 * that nothing which talks to an agent hides in the synthesis: an instruction found in a page is
 * data, so it is listed with its source in its own section, never carried into the claims. A
 * page of the research folder without the block is a free note: only the scan of what talks to an
 * agent and of hidden characters applies to it.
 *
 * A report is also a decision: every source carries its publication date and its
 * publisher; a claim the conclusion rests on is marked `key` and holds two independent, dated
 * publishers, or is marked doubt; a report imported from another tool says which tool and the day it
 * was made; a report that chooses between candidates carries a weighted matrix, replayed here.
 */

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SUBJECT_MAX = 200;
/** An http(s) address with a host name and no login in it, as an agent copies it from a page. */
const ADDRESS = /^https?:\/\/(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]+(?::\d{1,5})?(?:[/?#]\S*)?$/i;
const NONE_LINE = /^(?:[-*+]\s+)?(?:none|nothing|aucune?|rien)\b[\s.!]*$/i;
const INSTRUCTION_ITEM = /^[-*+]\s+(S-[1-9]\d{0,2})\s*(?::|—|–|-)\s*\S/;
const CLAIM_NUMBER = /^[1-9]\d{0,2}$/;

/** The folder of the research pages. */
const RESEARCH_FOLDER = "/docs/research/";

/** True for a page with a `research` block: a report, not a free note. */
export function isResearchReport(document: ParsedDocument): boolean {
  return document.research !== undefined;
}

/** True for a report that chooses between candidates. */
export function isSelectionReport(document: ParsedDocument): boolean {
  const block = document.research?.value;
  return isRecord(block) && block.shape === "choice";
}

/** True for a page of the research folder: a report or a free note. */
export function isResearchPage(document: ParsedDocument): boolean {
  return isResearchReport(document) || pathKey(document.path).includes(RESEARCH_FOLDER);
}

interface Source {
  readonly id: string;
  readonly kind: ResearchSourceKind;
  /** The publisher as compared: letters and digits only. */
  readonly publisher: string;
  /** The site, as compared (a shared platform is not one publisher). */
  readonly site: string;
  /** False when the page gives no publication date. */
  readonly dated: boolean;
}

/** Platforms where many publishers write: the same site is then no proof of the same publisher. */
const SHARED_SITES = new Set([
  "github.com",
  "gitlab.com",
  "medium.com",
  "substack.com",
  "reddit.com",
  "youtube.com",
  "x.com",
  "twitter.com",
  "linkedin.com",
  "stackoverflow.com",
  "news.ycombinator.com",
  "arxiv.org",
  "doi.org",
  "wikipedia.org",
  "npmjs.com",
  "pypi.org",
  "blogspot.com",
  "wordpress.com",
  "dev.to",
  "hashnode.dev",
  "notion.site",
  "github.io",
  "gitlab.io",
  "readthedocs.io",
  "vercel.app",
  "netlify.app",
  "pages.dev",
]);
/** Second-level suffixes: `bbc.co.uk` is one site name, `sap.de` is another kind. */
const TWO_LEVEL_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.jp",
  "co.nz",
  "co.in",
  "co.za",
  "com.br",
  "com.cn",
  "com.mx",
  "com.tr",
]);
const PUBLISHER_MAX = 80;
const PUBLISHED = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

/**
 * The day a source was published, as its first day (`2026` is 2026-01-01, `2026-03` is 2026-03-01),
 * `undated` when the page gives none, undefined when the cell is neither.
 */
export function publishedOn(cell: string | undefined, now?: number): string | undefined {
  const text = (cell ?? "").replaceAll("`", "").trim();
  if (text.toLowerCase() === RESEARCH_UNDATED) return RESEARCH_UNDATED;
  const parts = PUBLISHED.exec(text);
  if (parts === null || Number(parts[1]) < 1900) return undefined;
  const day = `${parts[1]}-${parts[2] ?? "01"}-${parts[3] ?? "01"}`;
  return realDate(day, now) ? day : undefined;
}

const siteOf = (address: string): string => {
  const host =
    address
      .replace(/^<|>$/g, "")
      .replace(/^https?:\/\//i, "")
      .split(/[/?#:]/)[0] ?? "";
  const labels = host
    .toLowerCase()
    .replace(/^www\./, "")
    .split(".");
  const suffix = labels.slice(-2).join(".");
  return labels.slice(TWO_LEVEL_SUFFIXES.has(suffix) ? -3 : -2).join(".");
};

const publisherKey = (cell: string | undefined): string =>
  (cell ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

function sourceProblems(
  path: string,
  rows: readonly Row[],
  pageDate: string | undefined,
  now: number | undefined,
): { problems: DocsProblem[]; sources: Map<string, Source>; undated: number } {
  const problems: DocsProblem[] = [];
  const sources = new Map<string, Source>();
  let undated = 0;
  const bad = (row: Row, field: string) =>
    problems.push(problemOf(path, row.line, "source_row", { field, source: row.cells[0] ?? "" }));
  for (const row of rows) {
    const [idCell, address, readOn, kindCell, provenance, publishedCell, publisherCell] = row.cells;
    const id = (idCell ?? "").replaceAll("`", "").replaceAll("*", "").trim();
    if (!RESEARCH_SOURCE_ID.test(id) || sources.has(id)) {
      bad(row, "id");
      continue;
    }
    const shown = (address ?? "").replace(/^<|>$/g, "").trim();
    if (!ADDRESS.test(shown)) bad(row, "address");
    const date = (readOn ?? "").replaceAll("`", "").trim();
    if (!realDate(date, now)) bad(row, "read_on");
    else if (pageDate !== undefined && date > pageDate) bad(row, "read_after_report");
    const kind = plainCell(kindCell);
    if (!(RESEARCH_SOURCE_KINDS as readonly string[]).includes(kind)) bad(row, "kind");
    if (plainCell(provenance) !== RESEARCH_PROVENANCE) bad(row, "provenance");
    const published = publishedOn(publishedCell, now);
    if (published === undefined) bad(row, "published");
    else if (published !== RESEARCH_UNDATED && realDate(date, undefined) && published > date) {
      bad(row, "published_after_read");
    }
    if (published === RESEARCH_UNDATED) undated += 1;
    const publisher = (publisherCell ?? "").trim();
    if (!isLine(publisher) || publisher.length > PUBLISHER_MAX || publisherKey(publisher) === "") {
      bad(row, "publisher");
    }
    sources.set(id, {
      id,
      kind: kind === "primary" ? "primary" : "secondary",
      publisher: publisherKey(publisher),
      site: siteOf(shown),
      dated: published !== undefined && published !== RESEARCH_UNDATED,
    });
  }
  return { problems, sources, undated };
}

/**
 * How many independent publishers the dated sources among `ids` come from. Two sources are one
 * publisher when they name the same publisher, or sit on the same site (a shared platform aside):
 * an agreement that is an echo is not a second source.
 */
export function independentPublishers(
  ids: readonly string[],
  sources: ReadonlyMap<string, Source>,
): number {
  const dated = ids.flatMap((id) => {
    const source = sources.get(id);
    return source?.dated === true ? [source] : [];
  });
  const parent = dated.map((_, index) => index);
  const find = (index: number): number => {
    let at = index;
    while (parent[at] !== at) at = parent[at] ?? at;
    return at;
  };
  dated.forEach((a, i) => {
    dated.forEach((b, j) => {
      const sameSite = a.site === b.site && !SHARED_SITES.has(a.site);
      if (j > i && (a.publisher === b.publisher || sameSite)) parent[find(j)] = find(i);
    });
  });
  return new Set(dated.map((_, index) => find(index))).size;
}

function claimProblems(
  path: string,
  rows: readonly Row[],
  sources: ReadonlyMap<string, Source>,
  warnings: DocsWarning[],
): DocsProblem[] {
  const problems: DocsProblem[] = [];
  if (rows.length === 0 || rows.length > RESEARCH_MAX_CLAIMS) {
    return [problemOf(path, 1, "claims", { count: rows.length, max: RESEARCH_MAX_CLAIMS })];
  }
  const numbers = new Set<string>();
  let keys = 0;
  let verifiedKeys = 0;
  for (const row of rows) {
    const [number, claim, levelCell, sourceCell, keyCell] = row.cells;
    const keyMark = plainCell(keyCell);
    const key = keyMark === RESEARCH_KEY_MARK;
    if (key) keys += 1;
    else if (keyMark !== "" && keyMark !== "-") {
      problems.push(problemOf(path, row.line, "claim_key", { claim: (number ?? "").trim() }));
    }
    const claimNumber = (number ?? "").trim();
    const at = { claim: claimNumber };
    const level = plainCell(levelCell);
    const numbered = CLAIM_NUMBER.test(claimNumber) && !numbers.has(claimNumber);
    numbers.add(claimNumber);
    if (!numbered || !isLine(claim) || !(RESEARCH_EVIDENCE as readonly string[]).includes(level)) {
      problems.push(problemOf(path, row.line, "claim_level", at));
      continue;
    }
    const cited = (sourceCell ?? "").match(/S-\d+/g) ?? [];
    const unknown = cited.filter((id) => !sources.has(id));
    if (unknown.length > 0) {
      problems.push(problemOf(path, row.line, "claim_source", { ...at, source: unknown[0] }));
      continue;
    }
    if (level === "doubt") continue;
    if (cited.length === 0) {
      problems.push(problemOf(path, row.line, "claim_unsourced", at));
      continue;
    }
    // A claim the conclusion rests on is checked by a second, independent, dated publisher, or it
    // is said to be in doubt: it never stands on one voice.
    const independent = independentPublishers(cited, sources);
    if (key && independent < 2) {
      problems.push(problemOf(path, row.line, "claim_second_source", { ...at, independent }));
    } else if (key) {
      verifiedKeys += 1;
    }
    // The cascade: a claim is primary when one of its sources is first hand, else secondary.
    const best: ResearchEvidence = cited.some((id) => sources.get(id)?.kind === "primary")
      ? "primary"
      : "secondary";
    if (best !== level) {
      problems.push(problemOf(path, row.line, "claim_cascade", { ...at, level, best }));
    }
  }
  if (keys === 0) problems.push(problemOf(path, 1, "no_key_claim"));
  // Every key claim in doubt is an honest report of thin public data, but the creator must hear it.
  else if (verifiedKeys === 0) warnings.push(warning("research_no_verified_key", { path }));
  return problems;
}

/** What the Instructions section holds: the sources it blames, the lines that are the place for an instruction, or a problem. */
function instructionProblems(
  path: string,
  section: Section,
  sources: ReadonlyMap<string, Source>,
): { problems: DocsProblem[]; flagged: number; items: Set<number> } {
  const problems: DocsProblem[] = [];
  const items = new Set<number>();
  let none = 0;
  let flagged = 0;
  section.lines.forEach((text, index) => {
    const line = section.line + 1 + index;
    const trimmed = text.replace(/<!--[\s\S]*?(?:-->|$)/g, "").trim();
    if (trimmed === "" || /^```/.test(trimmed)) return;
    if (NONE_LINE.test(trimmed)) {
      none += 1;
      return;
    }
    const item = INSTRUCTION_ITEM.exec(trimmed);
    if (item === null) {
      problems.push(problemOf(path, line, "instructions_section"));
      return;
    }
    flagged += 1;
    items.add(line);
    if (!sources.has(item[1] ?? "")) {
      problems.push(problemOf(path, line, "instruction_source", { source: item[1] }));
    }
  });
  if (none > 0 && flagged > 0) {
    problems.push(problemOf(path, section.line, "instructions_section"));
  }
  return { problems, flagged, items };
}

function missingSection(
  document: ParsedDocument,
  key: ResearchSection,
): { section?: Section; problems: DocsProblem[] } {
  const titles = RESEARCH_SECTIONS[key];
  const state = sectionState(document.sections, titles);
  if (state.problem === undefined) return { section: state.section, problems: [] };
  return {
    problems: [
      problemOf(document.path, state.section?.line ?? 1, "section", {
        section: key,
        problem: state.problem,
        heading: headingOf(titles),
      }),
    ],
  };
}

function headerProblems(document: ParsedDocument, now: number | undefined): DocsProblem[] {
  const { path } = document;
  const problems: DocsProblem[] = [];
  if (
    document.id !== undefined &&
    !(
      document.id.startsWith(RESEARCH_ID_PREFIX) &&
      SLUG.test(document.id.slice(RESEARCH_ID_PREFIX.length))
    )
  ) {
    problems.push(
      problemOf(path, document.idLine, "id", {
        field: "id",
        expected: `${RESEARCH_ID_PREFIX}<slug>`,
      }),
    );
  }
  const block = document.research;
  const line = block?.line ?? 1;
  if (!isRecord(block?.value)) {
    return [...problems, problemOf(path, line, "block", { field: "research" })];
  }
  const fields = block.value;
  const field = (name: string) => problemOf(path, line, "field", { field: `research.${name}` });
  if (
    !isLine(fields.subject) ||
    fields.subject.trim().length < 3 ||
    fields.subject.length > SUBJECT_MAX
  ) {
    problems.push(field("subject"));
  }
  const types = fields.types;
  if (
    !Array.isArray(types) ||
    types.length === 0 ||
    new Set(types).size !== types.length ||
    !types.every((type) => (RESEARCH_TYPES as readonly unknown[]).includes(type))
  ) {
    problems.push(field("types"));
  }
  if (!realDate(fields.date, now)) problems.push(field("date"));
  const { origin, tool, report_date: madeOn, shape } = fields;
  if (shape !== undefined && !(RESEARCH_SHAPES as readonly unknown[]).includes(shape)) {
    problems.push(field("shape"));
  }
  const imported = origin !== undefined;
  if (imported && !(RESEARCH_ORIGINS as readonly unknown[]).includes(origin)) {
    problems.push(field("origin"));
  } else if (imported) {
    // The report of another tool: which one, and the day it was made, which is what ages it.
    if (!isLine(tool) || tool.trim().length < 2 || tool.length > PUBLISHER_MAX) {
      problems.push(problemOf(path, line, "import", { field: "research.tool" }));
    }
    if (
      !realDate(madeOn, now) ||
      (realDate(fields.date, undefined) && String(madeOn) > String(fields.date))
    ) {
      problems.push(problemOf(path, line, "import", { field: "research.report_date" }));
    }
  } else if (tool !== undefined || madeOn !== undefined) {
    problems.push(problemOf(path, line, "import", { field: "research.origin" }));
  }
  return problems;
}

/** The header date of a report, when it is a plain date. */
function reportDate(document: ParsedDocument): string | undefined {
  const value = document.research?.value;
  return isRecord(value) && realDate(value.date, undefined) ? (value.date as string) : undefined;
}

/** What talks to an agent or hides in a text, outside the lines made for flagged instructions. */
function scanProblems(path: string, text: string, flagged: ReadonlySet<number>): DocsProblem[] {
  return [
    ...instructionLines(text, flagged).map((line) =>
      problemOf(path, line, "instruction_unflagged"),
    ),
    ...hiddenLines(text).map((line) => problemOf(path, line, "hidden_characters")),
  ];
}

/** What `docs check` finds in one research report. */
function reportChecks(
  document: ParsedDocument,
  text: string | undefined,
  now: number | undefined,
): LaunchCheck {
  const { path } = document;
  const problems = headerProblems(document, now);
  const warnings: DocsWarning[] = [];
  const claims = missingSection(document, "claims");
  const sourcesSection = missingSection(document, "sources");
  const instructions = missingSection(document, "instructions");
  problems.push(...claims.problems, ...sourcesSection.problems, ...instructions.problems);
  const sourceTable =
    sourcesSection.section === undefined ? undefined : tablesOf(sourcesSection.section);
  const claimTable = claims.section === undefined ? undefined : tablesOf(claims.section);
  for (const [section, table] of [
    ["sources", sourceTable],
    ["claims", claimTable],
  ] as const) {
    for (const line of table?.broken ?? [])
      problems.push(problemOf(path, line, "table", { section }));
  }
  const read = sourceProblems(path, sourceTable?.rows ?? [], reportDate(document), now);
  problems.push(...read.problems);
  if (read.undated > 0) {
    warnings.push(warning("research_source_undated", { path, count: read.undated }));
  }
  if (claimTable !== undefined)
    problems.push(...claimProblems(path, claimTable.rows, read.sources, warnings));
  let flaggedLines: ReadonlySet<number> = new Set();
  if (instructions.section !== undefined) {
    const listed = instructionProblems(path, instructions.section, read.sources);
    problems.push(...listed.problems);
    flaggedLines = listed.items;
    if (listed.flagged > 0) {
      warnings.push(warning("research_instruction_flagged", { path, count: listed.flagged }));
    }
  }
  if (text !== undefined) problems.push(...scanProblems(path, text, flaggedLines));
  if (isSelectionReport(document)) {
    const chosen = selectionChecks(
      document,
      new Map(
        (claimTable?.rows ?? []).map((row) => [
          (row.cells[0] ?? "").trim(),
          plainCell(row.cells[2]),
        ]),
      ),
    );
    problems.push(...chosen.problems);
    warnings.push(...chosen.warnings);
  }
  problems.push(...placeholderProblems(document));
  return { problems, warnings };
}

/** True when `docs check` finds nothing to refuse in the report: what `docs research` trusts. */
export function reportIsSound(
  document: ParsedDocument,
  text: string,
  now: number | undefined,
): boolean {
  return reportChecks(document, text, now).problems.length === 0;
}

/**
 * The rules of the research pages: every page with a `research` block is a report; every other
 * page of the research folder is scanned for what talks to an agent and for hidden characters.
 * Warnings: instructions found in sources and listed (the creator is told, nothing was followed).
 */
export function researchReportChecks(input: {
  readonly documents: readonly ParsedDocument[];
  readonly textOf: (path: string) => string | undefined;
  readonly now?: number;
}): LaunchCheck {
  const problems: DocsProblem[] = [];
  const warnings: DocsWarning[] = [];
  for (const document of input.documents) {
    if (!isResearchPage(document)) continue;
    const text = input.textOf(document.path);
    if (isResearchReport(document)) {
      const result = reportChecks(document, text, input.now);
      problems.push(...result.problems);
      warnings.push(...result.warnings);
    } else if (text !== undefined) {
      problems.push(...scanProblems(document.path, text, new Set()));
    }
  }
  return { problems, warnings };
}

/** The claims of a report, as `docs research` reads them. */
export interface ReportClaim {
  readonly n: number;
  readonly level: string;
  readonly sources: readonly string[];
}

/** A report read leniently (a lookup never fails on a page that `docs check` would refuse). */
export interface ReportSummary {
  readonly subject: string;
  readonly types: readonly string[];
  /** A real date; a page without one is no report for the lookup. */
  readonly date: string;
  /** The day an imported report was made: it ages from there, not from the day it was filed. */
  readonly madeOn?: string;
  readonly claims: readonly ReportClaim[];
  /** Source id -> the day it was read, and the day it was published (absent when undated). */
  readonly sources: ReadonlyMap<string, { readonly read: string; readonly published?: string }>;
  readonly flagged: number;
}

/** A report's header, claims, sources and flagged instructions, or undefined when it is no report. */
export function summaryOfReport(document: ParsedDocument): ReportSummary | undefined {
  const block = document.research?.value;
  if (
    !isRecord(block) ||
    !isLine(block.subject) ||
    block.subject.length > SUBJECT_MAX ||
    !realDate(block.date, undefined)
  ) {
    return undefined;
  }
  const types = Array.isArray(block.types)
    ? block.types.filter((type): type is string =>
        (RESEARCH_TYPES as readonly unknown[]).includes(type),
      )
    : [];
  const section = (key: ResearchSection) =>
    document.sections.find((candidate) =>
      (RESEARCH_SECTIONS[key] as readonly string[]).includes(candidate.title),
    );
  const claimsSection = section("claims");
  const sourcesSection = section("sources");
  const instructionsSection = section("instructions");
  const claims = (claimsSection === undefined ? [] : tablesOf(claimsSection).rows).map(
    (row, index) => ({
      n: Number(/\d+/.exec(row.cells[0] ?? "")?.[0] ?? index + 1),
      level: plainCell(row.cells[2]),
      sources: (row.cells[3] ?? "").match(/S-\d+/g) ?? [],
    }),
  );
  const sources = new Map<string, { read: string; published?: string }>();
  for (const row of sourcesSection === undefined ? [] : tablesOf(sourcesSection).rows) {
    const id = (row.cells[0] ?? "").replaceAll("`", "").replaceAll("*", "").trim();
    const published = publishedOn(row.cells[5]);
    sources.set(id, {
      read: (row.cells[2] ?? "").replaceAll("`", "").trim(),
      ...(published === undefined || published === RESEARCH_UNDATED ? {} : { published }),
    });
  }
  const flagged = (instructionsSection?.lines ?? []).filter((line) =>
    INSTRUCTION_ITEM.test(line.trim()),
  ).length;
  return {
    subject: block.subject.trim(),
    types,
    date: block.date as string,
    ...(block.origin === "import" && realDate(block.report_date, undefined)
      ? { madeOn: block.report_date as string }
      : {}),
    claims,
    sources,
    flagged,
  };
}
