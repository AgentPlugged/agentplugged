import {
  BREAK_EVEN_LINE,
  COST_BASIS_CELL,
  COST_REAL_CELL,
  COST_REAL_WORDING,
  INNOVATION_ID_PREFIX,
  INNOVATION_SECTIONS,
  PROBLEM_ID_PREFIX,
  PROBLEM_SECTIONS,
  plainWording,
} from "@agentplugged/protocol";
import { METHOD_DIR } from "../init/layout.js";
import type { DocsProblem, DocsWarning } from "./docs-base.js";
import { pathKey } from "./knowledge-freshness.js";
import {
  invalid,
  type LaunchCheck,
  type LaunchCheckInput,
  placeholderProblems,
} from "./launch-documents.js";
import { noteHeaderProblems, noteSectionProblems } from "./note-documents.js";
import { type ParsedDocument, type Section, tableCells } from "./parse-document.js";
import { figureWarnings } from "./pitch-documents.js";
import { sectionState } from "./sales-documents.js";
import { warning } from "./story-rules.js";

/**
 * The documents of problem solving (Lou) and of innovation strategy (Iris).14, as pure
 * functions. They are notes of `.agentplugged/docs/strategy/`, validated by a checkpoint like the
 * other deliverables. `docs check` verifies what a program can: the header, the sections, and, in
 * the economics of a strategy, that every cost says where it comes from (an estimate or a
 * declaration, never a measure), that no cost is missing its amount or silently zero, and that
 * nothing is shown as a real cost: the real cost is not this document's to state.
 */

/** The problem analyses and the strategies: one file each, under this folder. */
export const STRATEGY_DIR = `${METHOD_DIR}/docs/strategy/`;

type Kind = "problem" | "innovation";

const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";
const FILE_PATTERN = new RegExp(`^(${PROBLEM_ID_PREFIX}|${INNOVATION_ID_PREFIX})(${SLUG})\\.md$`);

/** The kind of strategy document a file is, or undefined. */
export function strategyKindOf(document: ParsedDocument): Kind | undefined {
  const path = pathKey(document.path);
  if (!path.startsWith(STRATEGY_DIR)) return undefined;
  const prefix = FILE_PATTERN.exec(path.slice(STRATEGY_DIR.length))?.[1];
  if (prefix === undefined) return undefined;
  return prefix === PROBLEM_ID_PREFIX ? "problem" : "innovation";
}

/** Who may own each: the agent that carries it, or the creator. */
const OWNERS: Record<Kind, ReadonlySet<string>> = {
  problem: new Set(["lou", "creator"]),
  innovation: new Set(["iris", "creator"]),
};

function headerProblems(document: ParsedDocument, kind: Kind): DocsProblem[] {
  const file = pathKey(document.path).slice(STRATEGY_DIR.length).replace(/\.md$/, "");
  return noteHeaderProblems(document, {
    reasons: {
      id: "strategy_id",
      kind: "strategy_kind",
      owner: "strategy_owner",
      links: "strategy_links",
      section: "strategy_section",
    },
    expected: file,
    idOk: document.id === file,
    owners: OWNERS[kind],
    agent: kind === "problem" ? "lou" : "iris",
  });
}

/** The words a creator uses to say a cost is nothing. */
/** In a Source cell "real" is ordinary (a real page); a measure is not. */
const SOURCE_REAL = /\b(?:actual|measured|mesure\w*|reel\w*|effectif\w*|constate\w*)\b/;
const NEGATIVE = /(?:^|[\s(])[-−]\s?\d/;
const ZERO_WORDS = /^(?:[-–—]|free|gratuit[e]?s?|none|aucun[e]?|nul(?:le)?|n\/a|nil)$/i;

/** The numbers in a cell: `1 200`, `3,5`, `2–14` give 1200, 3.5, 2 and 14. */
function amountsIn(cell: string): number[] {
  const numbers = cell.match(/\d+(?:[   ]\d{3})*(?:[.,]\d+)?/g) ?? [];
  return numbers.map((text) => Number(text.replace(/[   ]/g, "").replace(",", ".")));
}

const AMOUNT_COLUMN = /^(?:amount|montant)\b/;
const AMOUNT_HEADER =
  /amount|montant|per month|par mois|monthly|mensuel|\/ ?mo\b|\/ ?mois|total|one[- ]?off|ponctuel/i;
const COST_HEADER = /^(?:\*\*)?\s*(?:costs?|co[uû]ts?)\b/i;

interface Table {
  /** The line of the header row in the document, 1-based from the section's first line. */
  readonly header: string[];
  readonly rows: Array<{ cells: string[]; line: number }>;
}

/** The tables of a section: a header row, its `| --- |` separator, then the data rows. */
function tablesOf(section: Section): Table[] {
  const tables: Table[] = [];
  const lines = section.lines;
  let at = 0;
  while (at < lines.length) {
    if (!/^\s*\|/.test(lines[at] ?? "")) {
      at += 1;
      continue;
    }
    let end = at;
    while (end < lines.length && /^\s*\|/.test(lines[end] ?? "")) end += 1;
    const separated = /^\s*\|[\s:|-]*$/.test(lines[at + 1] ?? "");
    if (separated) {
      tables.push({
        header: tableCells(lines[at] ?? ""),
        rows: lines
          .slice(at + 2, end)
          .map((text, index) => ({
            cells: tableCells(text),
            line: section.line + 1 + at + 2 + index,
          }))
          .filter((row) => row.cells.some((cell) => cell !== "")),
      });
    }
    at = end;
  }
  return tables;
}

/** The lines of a section with its comments blanked (a comment may end a line of text). */
function proseLines(section: Section): Array<{ text: string; line: number }> {
  const text = section.lines
    .join("\n")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => comment.replace(/[^\n]/g, " "));
  return text.split("\n").map((line, index) => ({ text: line, line: section.line + 1 + index }));
}

/**
 * The economics of a strategy. Every row of a cost table says its basis (`estimated` or
 * `declared`) and carries an amount; an amount of zero is the creator's declaration, never an
 * estimate; nothing is called a real, actual or measured cost. A break-even line is expected.
 */
function economicsChecks(document: ParsedDocument): LaunchCheck {
  const { path } = document;
  const problems: DocsProblem[] = [];
  const warnings: DocsWarning[] = [];
  const { section } = sectionState(document.sections, INNOVATION_SECTIONS.economics);
  if (section === undefined) return { problems, warnings };
  const field = (
    reason: "strategy_cost_basis" | "strategy_cost_amount",
    line: number,
    problem: string,
    extra = {},
  ) => problems.push(invalid(path, line, reason, { problem, ...extra }));
  const costTables = tablesOf(section).filter((table) => COST_HEADER.test(table.header[0] ?? ""));
  if (costTables.length === 0) field("strategy_cost_basis", section.line, "table");
  for (const table of costTables) {
    const strict = table.header.findIndex(
      (cell, index) => index > 0 && AMOUNT_COLUMN.test(plainWording(cell)),
    );
    const amountAt =
      strict !== -1
        ? strict
        : table.header.findIndex((cell, index) => index > 0 && AMOUNT_HEADER.test(cell));
    const sourceAt = table.header.findIndex(
      (cell, index) => index > 0 && /source|origine/i.test(cell),
    );
    if (amountAt === -1) field("strategy_cost_amount", section.line, "column");
    if (
      !table.header.some(
        (cell, index) => index > 0 && /basis|base|origin|origine|nature|kind|type/i.test(cell),
      )
    ) {
      field("strategy_cost_basis", section.line, "column");
    }
    if (table.rows.length === 0) field("strategy_cost_basis", section.line, "rows");
    for (const row of table.rows) {
      const label = row.cells[0] ?? "";
      const others = row.cells.slice(1);
      const claimsReal = row.cells.some((cell, index) =>
        index === 0
          ? false
          : (index === sourceAt ? SOURCE_REAL : COST_REAL_CELL).test(plainWording(cell)),
      );
      if (claimsReal) {
        problems.push(invalid(path, row.line, "strategy_cost_real", { cost: label }));
        continue;
      }
      const basis = others
        .map((cell) => COST_BASIS_CELL.exec(cell)?.[1]?.toLowerCase())
        .find((value) => value !== undefined);
      if (basis === undefined) {
        field("strategy_cost_basis", row.line, "row", { cost: label });
        continue;
      }
      if (amountAt === -1) continue;
      const cell = (row.cells[amountAt] ?? "").replaceAll("*", "").trim();
      const numbers = amountsIn(cell);
      const nothing = numbers.length === 0 && ZERO_WORDS.test(cell);
      // A cost below zero is not a cost: it is asked again, not read as its absolute value.
      if ((numbers.length === 0 && !nothing) || NEGATIVE.test(cell)) {
        field("strategy_cost_amount", row.line, "row", { cost: label });
      } else if (nothing || numbers.every((value) => value === 0)) {
        // A zero is something the creator declares (a free tier): never an estimate, never silent.
        if (!/^d[ée]clar|^declared/i.test(basis)) {
          problems.push(invalid(path, row.line, "strategy_cost_zero", { cost: label }));
        }
      }
    }
  }
  // The economics, and the direction where the price is argued, never call a cost real.
  const direction = sectionState(document.sections, INNOVATION_SECTIONS.direction).section;
  for (const scanned of [section, direction]) {
    if (scanned === undefined) continue;
    const found = proseLines(scanned).find(({ text }) =>
      COST_REAL_WORDING.test(plainWording(text)),
    );
    if (found !== undefined) {
      problems.push(invalid(path, found.line, "strategy_cost_real", { cost: "" }));
      break;
    }
  }
  const stated = proseLines(section).some(
    ({ text }) => BREAK_EVEN_LINE.test(text) && /\d/.test(text),
  );
  if (!stated) warnings.push(warning("strategy_no_break_even", { path, line: section.line }));
  return { problems, warnings };
}

/**
 * The rules of the problem analyses and of the strategies: header, sections, economics; a
 * warning for a figure with no source or a strategy with no break-even point.
 */
export function strategyDocumentChecks(input: LaunchCheckInput): LaunchCheck {
  const problems: DocsProblem[] = [];
  const warnings: DocsWarning[] = [];
  for (const document of input.documents) {
    const kind = strategyKindOf(document);
    if (kind === undefined) continue;
    problems.push(
      ...headerProblems(document, kind),
      ...placeholderProblems(document),
      ...noteSectionProblems(
        document,
        kind === "problem" ? PROBLEM_SECTIONS : INNOVATION_SECTIONS,
        "strategy_section",
      ),
    );
    if (kind === "innovation") {
      const economics = economicsChecks(document);
      problems.push(...economics.problems);
      warnings.push(...economics.warnings);
    }
    warnings.push(...figureWarnings(document));
  }
  return { problems, warnings };
}
