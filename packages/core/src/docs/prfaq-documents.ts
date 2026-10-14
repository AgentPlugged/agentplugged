import {
  PRFAQ_ANGLE_WORDS,
  PRFAQ_CUSTOMER_ANGLES,
  PRFAQ_INTERNAL_ANGLES,
  PRFAQ_QUESTIONS_MAX,
  PRFAQ_QUESTIONS_MIN,
  PRFAQ_SECTIONS,
  PRFAQ_VERDICT_CATEGORIES,
  PRFAQ_VERDICT_NONE,
  PRFAQ_VERDICT_WORDS,
  type PrfaqAngle,
  type PrfaqVerdictCategory,
} from "@agentplugged/protocol";
import type { DocsProblem } from "./docs-base.js";
import { conceptProblem } from "./forge-documents.js";
import { bare, clip, plain } from "./ideation-documents.js";
import { invalid, type LaunchCheck, type LaunchCheckInput } from "./launch-documents.js";
import type { ParsedDocument, Section } from "./parse-document.js";
import { sectionState } from "./sales-documents.js";

/**
 * The shape of the press release once a verdict closes it, as pure functions. A
 * release in progress is written a section at a time and is not held to any of this; the verdict
 * is what closes it: then the concept type is named in the header, each list holds 6 to 10
 * questions, each tagged with its angle between brackets, every angle is asked at least once (the
 * dreaded question included), and the verdict names its three categories, the last two with what
 * to do. What the answers say stays the creator's.
 */

const BULLET = /^[-*]\s+(.*)$/;
const TAGS = /^((?:\[[^\]\n]*\]\s*)+)/;
const ARROW = /(?:→|->)\s*\S/;
const LABEL = /^(?:[-*]\s+)?([^:\n]{1,24}?)\s*:\s*(.*)$/;
const ITEM = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/;

/** The angle a question names in its tags, if any (the other tags, `[open]`, are not angles). */
function angleOf(text: string, angles: readonly PrfaqAngle[]): PrfaqAngle | undefined {
  const tags = TAGS.exec(text)?.[1] ?? "";
  for (const tag of tags.matchAll(/\[([^\]\n]*)\]/g)) {
    const word = plain(tag[1] ?? "").trim();
    const found = angles.find((angle) => PRFAQ_ANGLE_WORDS[angle].test(word));
    if (found !== undefined) return found;
  }
  return undefined;
}

interface List {
  readonly key: "customer" | "internal";
  readonly angles: readonly PrfaqAngle[];
}

const LISTS: readonly List[] = [
  { key: "customer", angles: PRFAQ_CUSTOMER_ANGLES },
  { key: "internal", angles: PRFAQ_INTERNAL_ANGLES },
];

function questionProblems(document: ParsedDocument, list: List, section: Section): DocsProblem[] {
  const questions = section.lines.flatMap((text, index) => {
    const bullet = BULLET.exec(text);
    return bullet === null ? [] : [{ line: section.line + 1 + index, text: bullet[1] ?? "" }];
  });
  const at = (line: number, problem: string, detail: string) =>
    invalid(document.path, line, "prfaq_faq", { faq: list.key, problem, detail });
  const problems: DocsProblem[] = [];
  if (questions.length < PRFAQ_QUESTIONS_MIN || questions.length > PRFAQ_QUESTIONS_MAX) {
    problems.push(at(section.line, "count", `${questions.length} questions`));
  }
  const seen = new Set<PrfaqAngle>();
  for (const question of questions) {
    const angle = angleOf(question.text, list.angles);
    if (angle === undefined) problems.push(at(question.line, "angle", clip(question.text)));
    else seen.add(angle);
  }
  for (const angle of list.angles.filter((candidate) => !seen.has(candidate))) {
    problems.push(at(section.line, "missing_angle", `[${angle}]`));
  }
  return problems;
}

/** The category a label of the verdict names, if any. */
function categoryOf(label: string): PrfaqVerdictCategory | undefined {
  const word = plain(label).trim();
  return PRFAQ_VERDICT_CATEGORIES.find((category) => PRFAQ_VERDICT_WORDS[category].test(word));
}

/**
 * The verdict: one line per category (`Holds:`, `Soft:`, `Breaks:`). The items of a category are
 * the rest of its line and each bullet below it; a line that is not a bullet goes on with the
 * item above. Every item of the last two says what to do, after an arrow.
 */
function verdictProblems(document: ParsedDocument, section: Section): DocsProblem[] {
  const at = (line: number, problem: string, category: string, detail: string) =>
    invalid(document.path, line, "prfaq_verdict", { problem, category, detail });
  const categories = new Map<PrfaqVerdictCategory, { line: number; items: string[] }>();
  let current: { line: number; items: string[] } | undefined;
  section.lines.forEach((text, index) => {
    const line = section.line + 1 + index;
    const label = LABEL.exec(bare(text).trim());
    const category = label === null ? undefined : categoryOf(label[1] ?? "");
    if (category !== undefined && !categories.has(category)) {
      current = { line, items: [label?.[2] ?? ""] };
      categories.set(category, current);
      return;
    }
    if (current === undefined || text.trim() === "") return;
    const item = ITEM.exec(bare(text));
    if (item !== null) current.items.push(item[1] ?? "");
    else current.items[current.items.length - 1] += ` ${bare(text).trim()}`;
  });
  const problems: DocsProblem[] = [];
  for (const category of PRFAQ_VERDICT_CATEGORIES) {
    const entry = categories.get(category);
    const items = (entry?.items ?? []).map((item) => item.trim()).filter((item) => item !== "");
    if (entry === undefined || items.length === 0) {
      const problem = entry === undefined ? "missing" : "empty";
      problems.push(at(entry?.line ?? section.line, problem, category, category));
      continue;
    }
    if (category === "holds") continue;
    for (const item of items) {
      if (PRFAQ_VERDICT_NONE.test(plain(item).trim()) || ARROW.test(item)) continue;
      problems.push(at(entry.line, "move", category, clip(item)));
    }
  }
  return problems;
}

/** The rules of the press release: the lists and the verdict that closes it, the concept type. */
export function prfaqDocumentChecks(input: LaunchCheckInput): LaunchCheck {
  const problems: DocsProblem[] = [];
  for (const document of input.documents) {
    if (document.kind?.value !== "prfaq") continue;
    const verdict = sectionState(document.sections, PRFAQ_SECTIONS.verdict);
    // Until a verdict closes it, a release is written a section at a time and nothing is asked.
    if (verdict.section === undefined) continue;
    problems.push(...conceptProblem(document, true, "prfaq_concept"));
    for (const list of LISTS) {
      const { section } = sectionState(document.sections, PRFAQ_SECTIONS[list.key]);
      if (section === undefined) {
        const detail = `## ${PRFAQ_SECTIONS[list.key][0]}`;
        problems.push(
          invalid(document.path, 1, "prfaq_faq", { faq: list.key, problem: "missing", detail }),
        );
        continue;
      }
      problems.push(...questionProblems(document, list, section));
    }
    problems.push(...verdictProblems(document, verdict.section));
  }
  return { problems, warnings: [] };
}
