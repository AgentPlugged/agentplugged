import {
  CONFLICT_CLASSES,
  type ConflictClass,
  type ConflictFile,
  type ConflictKind,
  type ConflictOption,
  MAX_CONFLICT_FILES,
  MAX_FILE_HUNKS,
  MAX_TEXTUAL_ADDITION_LINES,
  MAX_TEXTUAL_HUNKS,
  RepositoryPathSchema,
  SUBSTANTIVE_CLASSES,
} from "@agentplugged/protocol";
import { sensitivePath } from "../review/review-rules.js";
import { hasConflictMarkers } from "./conflict-markers.js";
import type { ConflictFileProbe, ConflictHunk, ConflictProbe } from "./merge-probe.js";

/**
 * What the engine can say of a conflict with the main branch, without parsing any language
 *: the lines of each block in conflict are compared up to trailing spaces and
 * blank lines (never the indentation nor inner spaces, which change the meaning in some languages). Whether the logic of a function changed is not decidable that way: the engine fixes what
 * is certain (same lines changed on both sides, large additions, structure: of substance; the
 * same code up to spaces: text), leaves the rest to the developer's declaration, and verifies what
 * the declaration promises (`checkResolution`). Pure.
 */

/** A line as compared: without any whitespace; empty lines are not useful. */
export function usefulLines(lines: readonly string[]): string[] {
  const kept: string[] = [];
  for (const line of lines) {
    const compact = line.replace(/\s+/g, "");
    if (compact !== "") kept.push(compact);
  }
  return kept;
}

/**
 * A line as the classification and the conservation compare it: exact, but for its trailing
 * whitespace. Indentation and inner spaces change the meaning in some languages (Python, YAML,
 * string literals): they are never "mere formatting".
 */
export function exactLine(line: string): string {
  return line.trimEnd();
}

/** The lines of a side as compared: exact, blank lines left out. */
export function exactLines(lines: readonly string[]): string[] {
  return lines.filter((line) => line.trim() !== "").map(exactLine);
}

/** Whether two sides are the same code up to trailing spaces and blank lines. */
function sameCode(a: readonly string[], b: readonly string[]): boolean {
  const left = exactLines(a);
  const right = exactLines(b);
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

const WEIGHT = new Map<ConflictClass, number>(CONFLICT_CLASSES.map((name, index) => [name, index]));

/** The heavier of two classes. */
export function heavier(a: ConflictClass, b: ConflictClass): ConflictClass {
  return (WEIGHT.get(a) ?? 0) >= (WEIGHT.get(b) ?? 0) ? a : b;
}

/** The class of one block: text, additions on both sides, large, or both sides changing lines. */
export function hunkClass(hunk: ConflictHunk): ConflictClass {
  if (sameCode(hunk.main, hunk.story)) return "whitespace";
  if (usefulLines(hunk.base).length > 0) return "both_modified";
  const most = Math.max(usefulLines(hunk.main).length, usefulLines(hunk.story).length);
  return most > MAX_TEXTUAL_ADDITION_LINES ? "large" : "additions";
}

/** The class of a file: the heaviest of its blocks; `structural` without readable blocks. */
export function fileClass(file: ConflictFileProbe): ConflictClass {
  if (file.structural || file.hunks.length === 0) return "structural";
  if (file.hunks_truncated || file.hunks.length > MAX_FILE_HUNKS) return "large";
  return file.hunks.map(hunkClass).reduce(heavier, "whitespace" as ConflictClass);
}

/** What the engine reads of a conflict: its files with their class, and the ceiling it fixes. */
export interface ConflictAnalysis {
  readonly files: readonly ConflictFile[];
  readonly files_truncated: boolean;
  /** `textual` when the agent may call it so; `substantive` when the engine forces it. */
  readonly ceiling: ConflictKind;
  /** Blocks in conflict, in all (the ones the adapter kept). */
  readonly hunks: number;
}

/** The analysis of a conflict the adapter read. */
export function analyseConflict(
  probe: Extract<ConflictProbe, { status: "conflict" }>,
): ConflictAnalysis {
  // A path the journal cannot hold (a backslash, a line break, too long) is left out: the conflict
  // is then incomplete, so only the creator may settle it.
  const valid = probe.files.filter((file) => RepositoryPathSchema.safeParse(file.path).success);
  const kept = valid.slice(0, MAX_CONFLICT_FILES);
  const files: ConflictFile[] = kept.map((file) => ({ path: file.path, class: fileClass(file) }));
  const truncated =
    probe.files_truncated ||
    valid.length !== probe.files.length ||
    probe.files.length > MAX_CONFLICT_FILES;
  const hunks = kept.reduce((sum, file) => sum + file.hunks.length, 0);
  const textual =
    files.length > 0 &&
    !truncated &&
    hunks <= MAX_TEXTUAL_HUNKS &&
    files.every((file) => !SUBSTANTIVE_CLASSES.has(file.class));
  return {
    files,
    files_truncated: truncated,
    ceiling: textual ? "textual" : "substantive",
    hunks,
  };
}

/** The files of an analysis the engine forces to be of substance. */
export function forcedFiles(analysis: ConflictAnalysis): ConflictFile[] {
  return analysis.files.filter((file) => SUBSTANTIVE_CLASSES.has(file.class));
}

/** Whether `part` is in `whole`, in order, not necessarily next to each other. */
function isSubsequence(part: readonly string[], whole: readonly string[]): boolean {
  let at = 0;
  for (const line of whole) {
    if (at < part.length && line === part[at]) at += 1;
  }
  return at === part.length;
}

/** What a resolution must keep of the blocks: both sides, one of them, or nothing in particular. */
export type KeepRule = "both" | "story" | "main" | "none";

/** The rule a qualification asks: textual keeps both, the creator's option keeps its side. */
export function keepRuleOf(kind: ConflictKind, option: ConflictOption | undefined): KeepRule {
  if (kind === "textual") return "both";
  if (option === "keep_story") return "story";
  if (option === "keep_main") return "main";
  return "none";
}

/** Why a resolution does not hold: markers left, or lines of a kept side lost. */
export interface ResolutionCheck {
  readonly ok: boolean;
  readonly why?: "markers" | "dropped";
  readonly files: readonly string[];
}

/**
 * Checks the head's text of each conflicted file against what the resolution promised: no marker
 * left, then every line of the kept sides still there, exact but for trailing spaces, in each
 * side's own order. It cannot see a line commented out or left in dead code: the CI and the
 * review of the new commit are the guard for that.
 * A file the head no longer has loses what it should keep (nothing when `none`). A `structural`
 * file has no block to compare: only its markers are looked for.
 */
export function checkResolution(input: {
  readonly files: readonly ConflictFileProbe[];
  readonly keep: KeepRule;
  readonly resolved: ReadonlyMap<string, string | undefined>;
}): ResolutionCheck {
  const marked: string[] = [];
  const dropped: string[] = [];
  for (const file of input.files) {
    const text = input.resolved.get(file.path);
    if (text !== undefined && hasConflictMarkers(text)) {
      marked.push(file.path);
      continue;
    }
    if (input.keep === "none" || file.structural || file.hunks.length === 0) continue;
    if (text === undefined) {
      dropped.push(file.path);
      continue;
    }
    const present = exactLines(text.split(/\r?\n/));
    const sides = [
      ...(input.keep === "both" || input.keep === "main"
        ? [exactLines(file.hunks.flatMap((hunk) => hunk.main))]
        : []),
      ...(input.keep === "both" || input.keep === "story"
        ? [exactLines(file.hunks.flatMap((hunk) => hunk.story))]
        : []),
    ];
    // Each kept side is still there, line by line, in its own order (other lines may sit between).
    if (sides.some((side) => !isSubsequence(side, present))) dropped.push(file.path);
  }
  if (marked.length > 0) return { ok: false, why: "markers", files: marked };
  if (dropped.length > 0) return { ok: false, why: "dropped", files: dropped };
  return { ok: true, files: [] };
}

/** The label and the consequence of each answer of a conflict of substance, as the creator reads them. */
export const CONFLICT_OPTION_TEXT: Readonly<
  Record<ConflictOption, { readonly label: string; readonly consequence: string }>
> = {
  keep_story: {
    label: "Keep the story's version",
    consequence:
      "The story's developer resolves the conflict on the story's branch keeping the story's lines where the two versions differ; the story then goes through CI and review again.",
  },
  keep_main: {
    label: "Keep the main branch's version",
    consequence:
      "The story's developer resolves the conflict on the story's branch keeping the main branch's lines where the two versions differ; the story then goes through CI and review again.",
  },
  combine: {
    label: "Combine both versions",
    consequence:
      "The story's developer combines both versions on the story's branch; the story then goes through CI and review again. Review the result carefully.",
  },
};

/** A commit as the summary names it; the engine writes zeros when Git could not be read. */
function shortCommit(commit: string): string {
  return /^0+$/.test(commit) ? "unreadable here" : commit.slice(0, 12);
}

const SUMMARY_LIMIT = 2000;
const EXCERPT_LINES = 6;
const EXCERPT_WIDTH = 160;

/** One file of the conflict as the checkpoint's summary shows it. */
export interface ConflictSummaryFile {
  readonly path: string;
  readonly class: ConflictClass;
  readonly hunks: readonly ConflictHunk[];
}

/** Lines that look like a secret are never written in the journal. */
const SECRET_LINE =
  /(?:sk-[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{12,}|-----BEGIN|pass(?:word|wd)|secret|token|api[_-]?key|authorization|credential|private[_-]?key)/i;

function excerpt(lines: readonly string[]): string[] {
  const shown = lines.slice(0, EXCERPT_LINES).map((line) => {
    if (SECRET_LINE.test(line)) return "    | [line hidden: it looks like a secret]";
    const clean = [...line.replaceAll("\t", "  ")]
      .map((char) => (char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f ? " " : char))
      .join("");
    return `    | ${clean.length > EXCERPT_WIDTH ? `${clean.slice(0, EXCERPT_WIDTH - 1)}…` : clean}`;
  });
  if (shown.length === 0) shown.push("    | (nothing)");
  if (lines.length > EXCERPT_LINES)
    shown.push(`    | … ${lines.length - EXCERPT_LINES} more line(s)`);
  return shown;
}

/**
 * The summary of the `decision` checkpoint of a conflict of substance: both versions of each block,
 * the developer's recommendation and reasoning. Never cut inside a block: what does not fit is
 * counted, and read on the story's branch. A sensitive file's lines are never shown.
 */
export function conflictSummary(input: {
  readonly story: string;
  readonly main: string;
  readonly head: string;
  readonly rationale: string;
  readonly recommendation: ConflictOption;
  readonly files: readonly ConflictSummaryFile[];
  readonly files_truncated: boolean;
}): string {
  const option = CONFLICT_OPTION_TEXT[input.recommendation];
  const head = [
    `Story ${input.story} cannot merge cleanly into the main branch (main ${shortCommit(input.main)}, story ${shortCommit(input.head)}): the two sides changed the same code.`,
    `The developer recommends: ${input.recommendation} (${option.label}). Reasoning: "${input.rationale.replace(/\s+/g, " ")}"`,
    "Both versions, by file (main branch, then story):",
  ];
  const parts: string[] = [head.join("\n")];
  let length = parts[0]?.length ?? 0;
  let hidden = 0;
  const hiddenFiles = new Set<string>();
  const room = (more: string) => length + 1 + more.length <= SUMMARY_LIMIT - 120;
  for (const file of input.files) {
    if (sensitivePath(file.path)) {
      const line = `- ${file.path} [${file.class}]: content hidden (sensitive file)`;
      if (room(line)) {
        parts.push(line);
        length += line.length + 1;
      } else {
        hiddenFiles.add(file.path);
      }
      continue;
    }
    if (file.hunks.length === 0) {
      const line = `- ${file.path} [${file.class}]: no readable block (deleted, renamed or binary on one side)`;
      if (room(line)) {
        parts.push(line);
        length += line.length + 1;
      } else {
        hiddenFiles.add(file.path);
      }
      continue;
    }
    const title = `- ${file.path} [${file.class}]`;
    let titled = false;
    file.hunks.forEach((hunk, index) => {
      const block = [
        `  block ${index + 1}, main branch:`,
        ...excerpt(hunk.main),
        `  block ${index + 1}, story:`,
        ...excerpt(hunk.story),
      ].join("\n");
      const text = titled ? block : `${title}\n${block}`;
      if (room(text)) {
        parts.push(text);
        length += text.length + 1;
        titled = true;
      } else {
        hidden += 1;
        hiddenFiles.add(file.path);
      }
    });
  }
  if (hidden > 0 || hiddenFiles.size > 0 || input.files_truncated) {
    parts.push(
      `(${hidden} more block(s) in ${hiddenFiles.size} file(s) not shown${input.files_truncated ? ", and more files beyond the first 100" : ""}: read them on the story's branch)`,
    );
  }
  return parts.join("\n").slice(0, SUMMARY_LIMIT);
}
