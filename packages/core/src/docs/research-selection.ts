import {
  RESEARCH_CANDIDATES_RANGE,
  RESEARCH_CRITERIA_RANGE,
  RESEARCH_CRITERION_ID,
  RESEARCH_SCORE_RANGE,
  RESEARCH_SELECT_SECTIONS,
  RESEARCH_WEIGHT_RANGE,
  type ResearchSelectSection,
} from "@agentplugged/protocol";
import type { DocsProblem, DocsWarning } from "./docs-base.js";
import { isLine, type LaunchCheck } from "./launch-documents.js";
import type { ParsedDocument, Section } from "./parse-document.js";
import { safeLine } from "./research-scan.js";
import { headingOf, plainCell, problemOf, tablesOf } from "./research-tables.js";
import { sectionState } from "./sales-documents.js";
import { warning } from "./story-rules.js";

/**
 * A report that chooses between candidates, replayed by the engine: the criteria
 * agreed with the creator (hard gates, then preferences with a weight), a matrix with one line per
 * candidate and criterion, each score backed by claims of the report, and a verdict. The engine adds
 * the totals itself (an agent's arithmetic is not trusted), cuts a candidate that fails a gate,
 * checks that the pick is the top of the matrix (or says why not), and shows how far a weight must
 * move for the top to change.
 */

const NAME_MAX = 60;
const TEXT_MIN = 8;
const TEXT_MAX = 300;

export interface Criterion {
  readonly id: string;
  /** Null for a hard gate. */
  readonly weight: number | null;
}

export interface Score {
  readonly candidate: string;
  readonly criterion: string;
  /** A number for a preference, `true` (passes) or `false` (fails) for a gate. */
  readonly value: number | boolean;
}

export interface Outcome {
  /** The candidates that passed every gate, best first, with their totals. */
  readonly ranking: readonly { readonly candidate: string; readonly total: number }[];
  readonly cut: readonly string[];
  /** The leaders (more than one on a tie), empty when no candidate passed the gates. */
  readonly top: readonly string[];
}

/** A name as written in a table or a verdict: no emphasis or code marks. */
const cleanName = (name: string): string => name.replaceAll("*", "").replaceAll("`", "").trim();

/** A candidate's name as compared: no marks, accents or case (« Zoé » and « zoe » are one). */
export const candidateKey = (name: string): string =>
  cleanName(name)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** The weighted matrix, replayed: gates cut, preferences add up as score times weight. */
export function matrixOutcome(
  criteria: readonly Criterion[],
  scores: readonly Score[],
  names: readonly string[],
): Outcome {
  const weights = new Map(criteria.map((criterion) => [criterion.id, criterion.weight]));
  const cut = new Set<string>();
  const totals = new Map<string, number>(names.map((name) => [candidateKey(name), 0]));
  for (const score of scores) {
    const key = candidateKey(score.candidate);
    const weight = weights.get(score.criterion);
    if (weight === undefined) continue;
    if (weight === null) {
      if (score.value === false) cut.add(key);
    } else if (typeof score.value === "number") {
      totals.set(key, (totals.get(key) ?? 0) + weight * score.value);
    }
  }
  const shown = new Map(names.map((name) => [candidateKey(name), name]));
  const ranking = [...totals.entries()]
    .filter(([key]) => !cut.has(key))
    .map(([key, total]) => ({ candidate: shown.get(key) ?? key, total }))
    .sort((a, b) => b.total - a.total || (a.candidate < b.candidate ? -1 : 1));
  const best = ranking[0]?.total;
  return {
    ranking,
    cut: [...cut].map((key) => shown.get(key) ?? key),
    top: ranking.filter((entry) => entry.total === best).map((entry) => entry.candidate),
  };
}

const sameTop = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((name) => b.map(candidateKey).includes(candidateKey(name)));

/**
 * The changes of weight that change the top: each preference moved one step up or down (within the
 * range), then all preferences equal. Empty when the top holds, which is what a creator wants to read.
 */
export function weightFlips(
  criteria: readonly Criterion[],
  scores: readonly Score[],
  names: readonly string[],
): string[] {
  const base = matrixOutcome(criteria, scores, names).top;
  const flips: string[] = [];
  for (const criterion of criteria) {
    if (criterion.weight === null) continue;
    for (const step of [-1, 1]) {
      const weight = criterion.weight + step;
      if (weight < RESEARCH_WEIGHT_RANGE.min || weight > RESEARCH_WEIGHT_RANGE.max) continue;
      const moved = criteria.map((other) =>
        other.id === criterion.id ? { ...other, weight } : other,
      );
      if (!sameTop(matrixOutcome(moved, scores, names).top, base)) {
        flips.push(`${criterion.id} ${step > 0 ? "+1" : "-1"}`);
      }
    }
  }
  const weighted = criteria.filter((criterion) => criterion.weight !== null);
  if (new Set(weighted.map((criterion) => criterion.weight)).size > 1) {
    const equal = criteria.map((c) => (c.weight === null ? c : { ...c, weight: 1 }));
    if (!sameTop(matrixOutcome(equal, scores, names).top, base)) flips.push("equal weights");
  }
  return flips;
}

const SECTION_FIELDS = {
  pick: ["pick", "choix"],
  runnerUp: ["runner-up", "second"],
  against: ["against", "contre"],
  hedge: ["hedge", "repli"],
  override: ["override", "dérogation"],
} as const;
type VerdictField = keyof typeof SECTION_FIELDS;

/** The `Key: text` lines of the verdict. */
function verdictLines(section: Section): Map<VerdictField, { text: string; line: number }> {
  const found = new Map<VerdictField, { text: string; line: number }>();
  section.lines.forEach((raw, index) => {
    const match = /^(?:[-*+]\s+)?([\p{L}-]+)\s*:\s*(.+)$/u.exec(
      raw.replaceAll("*", "").replaceAll("`", "").trim(),
    );
    if (match === null) return;
    const label = (match[1] ?? "").toLowerCase();
    for (const [field, labels] of Object.entries(SECTION_FIELDS)) {
      if ((labels as readonly string[]).includes(label) && !found.has(field as VerdictField)) {
        found.set(field as VerdictField, {
          text: (match[2] ?? "").trim(),
          line: section.line + 1 + index,
        });
      }
    }
  });
  return found;
}

function sectionOf(
  document: ParsedDocument,
  key: ResearchSelectSection,
  problems: DocsProblem[],
): Section | undefined {
  const titles = RESEARCH_SELECT_SECTIONS[key];
  const state = sectionState(document.sections, titles);
  if (state.problem === undefined) return state.section;
  problems.push(
    problemOf(document.path, state.section?.line ?? 1, "section", {
      section: key,
      problem: state.problem,
      heading: headingOf(titles),
    }),
  );
  return undefined;
}

/** What a verdict says when no candidate (or no second one) survives. */
const NO_ONE: readonly string[] = ["none", "aucun", "aucune"];
const WHOLE = /^\d+$/;
const EVIDENCE = /^#?\d+(?:\s*[,;]\s*#?\d+)*$/;
/** From this score on, a note needs evidence that is not in doubt. */
const STRONG_SCORE = 4;

/** The criteria table: ids `C-n` once, gate or preference, a weight on each preference. */
function criteriaOf(path: string, section: Section, problems: DocsProblem[]): readonly Criterion[] {
  const { rows, broken } = tablesOf(section);
  for (const line of broken) problems.push(problemOf(path, line, "table", { section: "criteria" }));
  const criteria: Criterion[] = [];
  const bad = (line: number, problem: string, id = "") =>
    problems.push(problemOf(path, line, "criteria", { problem, criterion: id }));
  for (const row of rows) {
    const [idCell, text, weightCell, kindCell] = row.cells;
    const id = (idCell ?? "").replaceAll("`", "").replaceAll("*", "").trim();
    const kind = plainCell(kindCell);
    const weight = (weightCell ?? "").replaceAll("`", "").trim();
    if (!RESEARCH_CRITERION_ID.test(id) || criteria.some((criterion) => criterion.id === id)) {
      bad(row.line, "id", id);
    } else if (!isLine(text)) {
      bad(row.line, "text", id);
    } else if (kind === "gate") {
      if (weight !== "" && weight !== "-") bad(row.line, "gate_weight", id);
      else criteria.push({ id, weight: null });
    } else if (kind === "weighted") {
      const value = WHOLE.test(weight) ? Number(weight) : -1;
      if (value < RESEARCH_WEIGHT_RANGE.min || value > RESEARCH_WEIGHT_RANGE.max) {
        bad(row.line, "weight", id);
      } else criteria.push({ id, weight: value });
    } else bad(row.line, "kind", id);
  }
  const count = rows.length;
  if (count < RESEARCH_CRITERIA_RANGE.min || count > RESEARCH_CRITERIA_RANGE.max) {
    bad(section.line, "count");
  } else if (!criteria.some((criterion) => criterion.weight !== null)) {
    bad(section.line, "no_preference");
  }
  return criteria;
}

/** The matrix: one line per candidate and criterion, every pair once, every score backed by claims. */
function matrixOf(
  path: string,
  section: Section,
  criteria: readonly Criterion[],
  claims: ReadonlyMap<string, string>,
  problems: DocsProblem[],
): { scores: Score[]; names: string[] } {
  const { rows, broken } = tablesOf(section);
  for (const line of broken) problems.push(problemOf(path, line, "table", { section: "matrix" }));
  const gates = new Set(criteria.filter((c) => c.weight === null).map((c) => c.id));
  const known = new Set(criteria.map((c) => c.id));
  const scores: Score[] = [];
  const names: string[] = [];
  const seen = new Set<string>();
  const bad = (line: number, problem: string, detail = "") =>
    problems.push(problemOf(path, line, "matrix", { problem, detail: safeLine(detail, 60) }));
  for (const row of rows) {
    const [candidate, criterionCell, scoreCell, evidence] = row.cells;
    const name = cleanName(candidate ?? "");
    const criterion = (criterionCell ?? "").replaceAll("`", "").replaceAll("*", "").trim();
    const raw = plainCell(scoreCell);
    if (!isLine(name) || name.length > NAME_MAX) {
      bad(row.line, "candidate");
      continue;
    }
    if (!known.has(criterion)) {
      bad(row.line, "criterion", criterion);
      continue;
    }
    const pair = `${candidateKey(name)}|${criterion}`;
    if (seen.has(pair)) {
      bad(row.line, "duplicate", `${name} / ${criterion}`);
      continue;
    }
    seen.add(pair);
    if (!names.some((existing) => candidateKey(existing) === candidateKey(name))) names.push(name);
    let value: number | boolean | undefined;
    if (gates.has(criterion)) value = raw === "pass" ? true : raw === "fail" ? false : undefined;
    else if (WHOLE.test(raw)) {
      const number = Number(raw);
      value =
        number >= RESEARCH_SCORE_RANGE.min && number <= RESEARCH_SCORE_RANGE.max
          ? number
          : undefined;
    }
    if (value === undefined) {
      bad(row.line, "score", `${name} / ${criterion}`);
      continue;
    }
    // The evidence is claim numbers, nothing else: « 1, 3 » or « #2 », each one in the report.
    const shown = (evidence ?? "").replaceAll("`", "").trim();
    const cited = EVIDENCE.test(shown) ? (shown.match(/\d+/g) ?? []) : [];
    if (cited.length === 0 || cited.some((number) => !claims.has(number))) {
      bad(row.line, "evidence", `${name} / ${criterion}`);
    } else if (
      cited.every((number) => claims.get(number) === "doubt") &&
      (value === true || (typeof value === "number" && value >= STRONG_SCORE))
    ) {
      // A strong score or a pass cannot rest only on what the report itself calls doubt.
      bad(row.line, "evidence_doubt", `${name} / ${criterion}`);
    }
    scores.push({ candidate: name, criterion, value });
  }
  if (
    names.length < RESEARCH_CANDIDATES_RANGE.min ||
    names.length > RESEARCH_CANDIDATES_RANGE.max
  ) {
    bad(section.line, "candidates", String(names.length));
  }
  for (const name of names) {
    for (const criterion of known) {
      if (!seen.has(`${candidateKey(name)}|${criterion}`)) {
        bad(section.line, "missing_pair", `${name} / ${criterion}`);
      }
    }
  }
  return { scores, names };
}

/** The verdict: the pick (the top of the matrix, or an override said as such), the runner-up, the best argument against, the cheapest hedge. */
function verdictProblems(
  path: string,
  section: Section,
  outcome: Outcome,
  names: readonly string[],
): DocsProblem[] {
  const problems: DocsProblem[] = [];
  const fields = verdictLines(section);
  const top = safeLine(outcome.top.join(", ") || "none", 60);
  const bad = (problem: string, line = section.line, detail = "") =>
    problems.push(problemOf(path, line, "verdict", { problem, detail: safeLine(detail, 60), top }));
  const text = (field: VerdictField) => fields.get(field)?.text ?? "";
  const known = new Set(names.map(candidateKey));
  const survivors = new Set(outcome.ranking.map((entry) => candidateKey(entry.candidate)));
  const pick = text("pick");
  if (pick === "") bad("pick_missing");
  else if (survivors.size === 0) {
    if (!NO_ONE.includes(candidateKey(pick))) {
      bad("pick_none", fields.get("pick")?.line);
    }
  } else if (!survivors.has(candidateKey(pick))) {
    bad(
      known.has(candidateKey(pick)) ? "pick_cut" : "pick_unknown",
      fields.get("pick")?.line,
      pick,
    );
  } else if (
    !outcome.top.map(candidateKey).includes(candidateKey(pick)) &&
    (text("override").match(/[\p{L}\p{N}]/gu) ?? []).length < TEXT_MIN
  ) {
    bad("pick_not_top", fields.get("pick")?.line, pick);
  }
  const runnerUp = text("runnerUp");
  if (survivors.size >= 2) {
    if (!survivors.has(candidateKey(runnerUp)) || candidateKey(runnerUp) === candidateKey(pick)) {
      bad("runner_up", fields.get("runnerUp")?.line);
    }
  } else if (!NO_ONE.includes(candidateKey(runnerUp)))
    bad("runner_up", fields.get("runnerUp")?.line);
  for (const field of ["against", "hedge"] as const) {
    const value = text(field);
    if (value.length < TEXT_MIN || value.length > TEXT_MAX) bad(field, fields.get(field)?.line);
  }
  return problems;
}

/** What `docs check` finds in the choice of a report: criteria, matrix and verdict, and the replayed result. */
export function selectionChecks(
  document: ParsedDocument,
  claims: ReadonlyMap<string, string>,
): LaunchCheck {
  const { path } = document;
  const problems: DocsProblem[] = [];
  const warnings: DocsWarning[] = [];
  const criteriaSection = sectionOf(document, "criteria", problems);
  const matrixSection = sectionOf(document, "matrix", problems);
  const verdictSection = sectionOf(document, "verdict", problems);
  if (criteriaSection === undefined || matrixSection === undefined) return { problems, warnings };
  const criteria = criteriaOf(path, criteriaSection, problems);
  const { scores, names } = matrixOf(path, matrixSection, criteria, claims, problems);
  const outcome = matrixOutcome(criteria, scores, names);
  const sound = problems.length === 0;
  if (verdictSection !== undefined) {
    problems.push(...verdictProblems(path, verdictSection, outcome, names));
  }
  // The replayed result is shown whenever the criteria and the matrix are whole: it is what the
  // verdict is written from.
  if (sound) {
    const flips = weightFlips(criteria, scores, names);
    warnings.push(
      warning("research_matrix", {
        path,
        ranking:
          outcome.ranking
            .map((entry) => `${safeLine(entry.candidate, 60)} ${entry.total}`)
            .join(", ") || "none",
        cut: outcome.cut.map((name) => safeLine(name, 60)).join(", ") || "none",
        flips: flips.length === 0 ? "none" : flips.join(", "),
      }),
    );
  }
  return { problems, warnings };
}
