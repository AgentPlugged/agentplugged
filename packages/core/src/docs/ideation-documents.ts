import {
  IDEATION_AUTHOR_MARK,
  IDEATION_CONVERGENCE,
  IDEATION_DONE_SECTIONS,
  IDEATION_GESTURE_WORDS,
  IDEATION_ID_PREFIX,
  IDEATION_MOVES,
  IDEATION_MOVES_MAX,
  IDEATION_SECTIONS,
  IDEATION_STANCE_WORDS,
} from "@agentplugged/protocol";
import { METHOD_DIR } from "../init/layout.js";
import type { DocsProblem } from "./docs-base.js";
import { pathKey } from "./knowledge-freshness.js";
import {
  invalid,
  type LaunchCheck,
  type LaunchCheckInput,
  placeholderProblems,
} from "./launch-documents.js";
import { noteHeaderProblems, noteSectionProblems } from "./note-documents.js";
import type { ParsedDocument, Section } from "./parse-document.js";
import { sectionState } from "./sales-documents.js";

/**
 * The file of an ideation session (Lou), as pure functions. It is saved from the
 * moment the question is asked, so the checks hold at every stage: while the session goes on (a
 * `Next step:` line) the file needs its question, a stance and its ideas marked with who had them;
 * once finished, it also needs the mirror (the creator's own ideas given back), the ideas kept with
 * the gesture the creator chose, and, when the convergence is there, one or two named moves.
 */

/** The sessions: one file each, under this folder. Other notes of the folder keep their free form. */
export const IDEATION_DIR = `${METHOD_DIR}/docs/ideas/`;

/** A session is a file `ideation-<anything>.md`; its `id` must then be the name of the file. */
export function isIdeationSession(document: ParsedDocument): boolean {
  const path = pathKey(document.path);
  if (!path.startsWith(IDEATION_DIR)) return false;
  const name = path.slice(IDEATION_DIR.length);
  return name.startsWith(IDEATION_ID_PREFIX) && name.endsWith(".md") && !name.includes("/");
}

const NEXT_STEP = /^(?:next step|[eé]tape suivante|prochaine [eé]tape)[ \t]*:[ \t]*\S/im;
const STANCE_LINE = /^(?:stance|posture)[ \t]*:[ \t]*(.*)$/im;
const STANCE_CHANGE = /^(?:stance|posture)[ \t]*:[ \t]*(.*)$/i;
const MOVE_LINE = /^(?:[-*][ \t]+)?(?:move|mouvement)[ \t]*:[ \t]*(.*)$/i;
const ARROW = /(?:→|->|=>)\s*([^→>]*?)\s*$/;

export const plain = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/[\p{M}]/gu, "")
    .toLowerCase();

/** Emphasis marks off a line, so `**Move:** …` reads like `Move: …`. */
export const bare = (text: string) => text.replace(/[*_`]/g, "");

/** An idea compared as written, whatever the spacing, the emphasis or the quotes around it. */
const flat = (text: string) =>
  text
    .replace(/[*_`"«»“”‘’']/g, "")
    .replace(/\s+/g, " ")
    .replace(/ ([?!:;])/g, "$1")
    .replace(/[\s.,;:!?]+$/g, "")
    .trim()
    .toLowerCase();

export const clip = (text: string) => (text.length > 80 ? `${text.slice(0, 77)}...` : text);

interface Idea {
  readonly line: number;
  readonly author: "creator" | "lou" | undefined;
  readonly text: string;
  /** The stance in force where the idea stands: a `Stance:` line inside the ideas can change it. */
  readonly stance: string | undefined;
  /** The technique it stands under (the count of `###` headings before it). */
  readonly technique: number;
}

/** The line a stance names, as one of the three; undefined when it names none. */
function stanceOf(value: string): string | undefined {
  const word =
    plain(bare(value))
      .trim()
      .match(/^[a-z]+/)?.[0] ?? "";
  return Object.entries(IDEATION_STANCE_WORDS).find(([, words]) => words.test(word))?.[0];
}

/**
 * The ideas of a section: its top-level bullets, each with the author its mark names, the stance
 * in force and the technique it stands under. Other lines (notes, headings) are not ideas.
 */
function ideasOf(section: Section, first: string | undefined): Idea[] {
  const ideas: Idea[] = [];
  let stance = first;
  let technique = 0;
  section.lines.forEach((text, index) => {
    if (/^###/.test(text)) technique += 1;
    const change = STANCE_CHANGE.exec(bare(text));
    if (change !== null) stance = stanceOf(change[1] ?? "") ?? stance;
    const bullet = /^[-*]\s+(.*)$/.exec(text);
    if (bullet === null) return;
    const body = bullet[1] ?? "";
    const mark = IDEATION_AUTHOR_MARK.exec(body);
    const who = mark?.[1] === undefined ? undefined : plain(mark[1]);
    ideas.push({
      line: section.line + 1 + index,
      author: who === undefined ? undefined : who === "lou" ? "lou" : "creator",
      text: body.replace(IDEATION_AUTHOR_MARK, "").trim(),
      stance,
      technique,
    });
  });
  return ideas;
}

/**
 * The stance is one of the three and every idea says who had it. In the `questions` stance Lou
 * gives no idea, but for one seed per technique when the creator asks outright.
 */
function stanceAndIdeas(
  document: ParsedDocument,
  text: string,
  ideas: readonly Idea[],
): DocsProblem[] {
  const { path } = document;
  const problems: DocsProblem[] = [];
  const found = STANCE_LINE.exec(text);
  if (found === null || stanceOf(found[1] ?? "") === undefined) {
    problems.push(
      invalid(path, 1, "ideation_stance", { problem: found === null ? "missing" : "unknown" }),
    );
  }
  const seeds = new Map<number, number>();
  for (const idea of ideas) {
    if (idea.author === undefined) {
      problems.push(invalid(path, idea.line, "ideation_idea", { idea: clip(idea.text) }));
    } else if (idea.stance === "questions" && idea.author === "lou") {
      const count = (seeds.get(idea.technique) ?? 0) + 1;
      seeds.set(idea.technique, count);
      if (count > 1) {
        problems.push(invalid(path, idea.line, "ideation_stance", { problem: "lou_idea" }));
      }
    }
  }
  return problems;
}

/** The mirror gives the creator back their own ideas, in their own words: three, or all if fewer. */
function mirrorProblems(document: ParsedDocument, ideas: readonly Idea[]): DocsProblem[] {
  const { section } = sectionState(document.sections, IDEATION_DONE_SECTIONS.mirror);
  if (section === undefined) return [];
  const theirs = new Set(
    ideas.filter((idea) => idea.author === "creator").map((idea) => flat(idea.text)),
  );
  theirs.delete("");
  const need = Math.min(3, theirs.size);
  const mirror = flat(section.lines.join("\n"));
  const given = [...theirs].filter((idea) => mirror.includes(idea)).length;
  return given >= need
    ? []
    : [invalid(document.path, section.line, "ideation_mirror", { need, given })];
}

/** One or two moves of the six, one per line; a line naming several counts for each. */
function convergenceProblems(document: ParsedDocument): DocsProblem[] {
  const section = document.sections.find((candidate) =>
    (IDEATION_CONVERGENCE as readonly string[]).includes(candidate.title),
  );
  if (section === undefined) return [];
  const at = (line: number, problem: string) =>
    invalid(document.path, line, "ideation_move", { problem });
  const problems: DocsProblem[] = [];
  let count = 0;
  section.lines.forEach((text, index) => {
    const found = MOVE_LINE.exec(bare(text));
    if (found === null) return;
    const line = section.line + 1 + index;
    const name = plain(found[1] ?? "");
    const named = Object.values(IDEATION_MOVES).filter((pattern) => pattern.test(name)).length;
    count += Math.max(named, 1);
    if (named === 0) problems.push(at(line, "unknown"));
    else if (count > IDEATION_MOVES_MAX) problems.push(at(line, "too_many"));
  });
  if (count === 0) problems.push(at(section.line, "missing"));
  return problems;
}

/** Each idea kept names the gesture the creator chose; a plain line saying nothing stays is enough. */
function keptProblems(document: ParsedDocument): DocsProblem[] {
  const { section } = sectionState(document.sections, IDEATION_DONE_SECTIONS.kept);
  if (section === undefined) return [];
  return section.lines.flatMap((text, index) => {
    const bullet = /^[-*]\s+(.*)$/.exec(text);
    if (bullet === null) return [];
    const word = plain(bare(ARROW.exec(bullet[1] ?? "")?.[1] ?? "")).trim();
    const known = Object.values(IDEATION_GESTURE_WORDS).some((pattern) => pattern.test(word));
    return known
      ? []
      : [
          invalid(document.path, section.line + 1 + index, "ideation_kept", {
            idea: clip(bullet[1] ?? ""),
          }),
        ];
  });
}

/**
 * The rules of the sessions of ideas: header, sections, stance, who had each idea, and, once the
 * session is finished, the mirror, the convergence moves and the gesture of each idea kept.
 */
export function ideationDocumentChecks(input: LaunchCheckInput): LaunchCheck {
  const problems: DocsProblem[] = [];
  for (const document of input.documents) {
    if (!isIdeationSession(document)) continue;
    const text = (input.textOf(document.path) ?? "").replace(/<!--[\s\S]*?(?:-->|$)/g, "");
    const file = pathKey(document.path).slice(IDEATION_DIR.length).replace(/\.md$/, "");
    const finished = !NEXT_STEP.test(text);
    const ideasSection = sectionState(document.sections, IDEATION_DONE_SECTIONS.ideas).section;
    const first = STANCE_LINE.exec(text)?.[1];
    const ideas =
      ideasSection === undefined
        ? []
        : ideasOf(ideasSection, first === undefined ? undefined : stanceOf(first));
    problems.push(
      ...noteHeaderProblems(document, {
        reasons: {
          id: "ideation_id",
          kind: "ideation_kind",
          owner: "ideation_owner",
          section: "ideation_section",
        },
        expected: file,
        idOk: document.id === file,
        owners: new Set(["lou", "creator"]),
        agent: "lou",
      }),
      ...placeholderProblems(document),
      ...noteSectionProblems(
        document,
        finished ? { ...IDEATION_SECTIONS, ...IDEATION_DONE_SECTIONS } : IDEATION_SECTIONS,
        "ideation_section",
      ),
      ...stanceAndIdeas(document, text, ideas),
      ...convergenceProblems(document),
    );
    if (finished) problems.push(...mirrorProblems(document, ideas), ...keptProblems(document));
  }
  return { problems, warnings: [] };
}
