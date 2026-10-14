import type { ReviewFinding } from "@agentplugged/protocol";
import type { CommandContext } from "../command.js";
import type { DiffFile } from "../review/review-rules.js";
import { isCodePath, isReadableCode, MAX_FILE_BYTES } from "./code-files.js";
import {
  type DetectOptions,
  type Duplicate,
  detectDuplicates,
  type SourceFile,
} from "./duplicates.js";
import { findTwins, type Twin } from "./twins.js";

/**
 * What the engine proves about the reuse of a change: the code the
 * change added that already exists elsewhere in the repository, and the functions that probably do
 * what an existing one does. Detection costs no token: the agents only read the result, in few
 * lines.
 */

/** The source files of a repository at a commit, through Git (an adapter), already filtered. */
export interface CodeSource {
  /**
   * The text of the files tracked at `commit` that `accept` takes (given the path and the size in
   * bytes), the files of `first` before the others should a size limit cut the list. Undefined
   * when the repository cannot be read here.
   */
  read(
    commit: string,
    accept: (path: string, bytes: number) => boolean,
    first?: ReadonlySet<string>,
  ): Promise<readonly SourceFile[] | undefined>;
}

export interface ReuseReport {
  readonly duplicates: readonly Duplicate[];
  readonly twins: readonly Twin[];
  /** The time ran out: the duplicates are those found so far (an empty list proves nothing). */
  readonly partial: boolean;
  /** Files read and time taken, for the engine's own accounts. */
  readonly files: number;
  readonly ms: number;
}

/** The lines the change added, by file (the new side of the diff). */
export function addedLinesOf(files: readonly DiffFile[]): Map<string, Set<number>> {
  const added = new Map<string, Set<number>>();
  for (const file of files) {
    if (!isCodePath(file.path)) continue;
    const lines = new Set<number>();
    for (const [line, old] of file.lines) if (old === null) lines.add(line);
    if (lines.size > 0) added.set(file.path, lines);
  }
  return added;
}

/** The report for a change, from the files of the repository as the change leaves it. Pure. */
export function analyzeReuse(
  files: readonly DiffFile[],
  tree: readonly SourceFile[],
  options: DetectOptions = {},
): ReuseReport {
  const clock = options.clock ?? Date.now;
  const started = clock();
  const added = addedLinesOf(files);
  if (added.size === 0) return { duplicates: [], twins: [], partial: false, files: 0, ms: 0 };
  const readable = tree.filter((file) => isCodePath(file.path) && isReadableCode(file.text));
  const detection = detectDuplicates(readable, added, options);
  const twins = findTwins(readable, added);
  return {
    duplicates: detection.duplicates,
    twins,
    partial: detection.partial,
    files: detection.files,
    ms: Math.max(0, clock() - started),
  };
}

/** Longest the review waits for the detector (milliseconds). */
export const REVIEW_MAX_MS = 15_000;

/**
 * The report for the change of a story at `commit`, reading the repository through the port; undefined
 * without the port, without a repository, or when anything goes wrong (never a failure).
 */
export async function reuseOf(
  context: CommandContext,
  diffFiles: readonly DiffFile[],
  commit: string,
  options: DetectOptions = {},
): Promise<ReuseReport | undefined> {
  const source = context.codeSource;
  if (source === undefined || addedLinesOf(diffFiles).size === 0) return undefined;
  try {
    // One budget for reading the repository and comparing: what Git took is not given twice.
    const clock = options.clock ?? Date.now;
    const budget = options.maxMs ?? REVIEW_MAX_MS;
    const started = clock();
    const tree = await source.read(
      commit,
      (path, bytes) => isCodePath(path) && bytes <= MAX_FILE_BYTES,
      new Set(addedLinesOf(diffFiles).keys()),
    );
    if (tree === undefined) return undefined;
    const left = budget - (clock() - started);
    return analyzeReuse(diffFiles, tree, { ...options, maxMs: Math.max(1_000, left) });
  } catch {
    return undefined;
  }
}

/** Duplicates and twins shown to a reader, at most (the rest is counted). */
export const SHOWN_DUPLICATES = 5;
export const SHOWN_TWINS = 5;
const LINE_MAX = 150;

const cut = (text: string, max: number) =>
  text.length <= max ? text : `…${text.slice(text.length - max + 1)}`;
const placeText = (place: { path: string; from: number; to: number }) =>
  `${cut(place.path, 55)}:${place.from}-${place.to}`;

/**
 * What a reader is given, in few lines: the duplicates the engine proved (the reader does not
 * re-prove them) and the twins it only suspects (the reader decides). Empty when there is nothing.
 */
export function reuseLines(report: ReuseReport | undefined): string[] {
  if (report === undefined) return [];
  const lines: string[] = [];
  for (const duplicate of report.duplicates.slice(0, SHOWN_DUPLICATES)) {
    const more = duplicate.others > 0 ? ` +${duplicate.others}` : "";
    lines.push(
      `duplicate ${placeText(duplicate.here)} = ${placeText(duplicate.there)} (${duplicate.tokens} words${more})`.slice(
        0,
        LINE_MAX,
      ),
    );
  }
  if (report.duplicates.length > SHOWN_DUPLICATES) {
    lines.push(`+${report.duplicates.length - SHOWN_DUPLICATES} more duplicates`);
  }
  for (const twin of report.twins.slice(0, SHOWN_TWINS)) {
    lines.push(
      `twin? ${twin.name} ${cut(twin.path, 45)}:${twin.line} ~ ${twin.twin.name} ${cut(twin.twin.path, 45)}:${twin.twin.line}`.slice(
        0,
        LINE_MAX,
      ),
    );
  }
  if (report.twins.length > SHOWN_TWINS) {
    lines.push(`+${report.twins.length - SHOWN_TWINS} more twins?`);
  }
  if (report.partial) lines.push("partial: time ran out, an empty list proves nothing");
  return lines;
}

/** Findings the engine adds to a review, at most: the rest is in the counted line of the reader. */
export const MAX_ENGINE_FINDINGS = 10;

/**
 * A proved duplicate is a finding « to fix » of the structure lens, written by the engine: the
 * reviewer cannot drop it, and the developer who rejects it must say why (triage). The twins are
 * not findings: they are hints the reader settles.
 */
export function duplicateFindings(report: ReuseReport | undefined): ReviewFinding[] {
  if (report === undefined) return [];
  return report.duplicates.slice(0, MAX_ENGINE_FINDINGS).map(
    (duplicate): ReviewFinding => ({
      severity: "should_fix",
      title:
        `Duplicated code: ${placeText(duplicate.here)} repeats ${placeText(duplicate.there)}`.slice(
          0,
          200,
        ),
      detail: `The engine compared the words of both places (names and values aside): ${duplicate.tokens} words in a row are the same${duplicate.others > 0 ? `, and ${duplicate.others} other place(s) hold them too` : ""}.`,
      path: duplicate.here.path,
      line: duplicate.here.from,
      lens: "structure",
      recommendation: "Reuse the existing code, or extract it where both can call it",
    }),
  );
}

/** What the journal keeps of a merged story's weight. */
export interface StoryWeight {
  readonly added: number;
  readonly removed: number;
  /** Absent when the engine could not look (no repository to read, time ran out): never a false zero. */
  readonly duplicates?: number;
}

/** True when `value` has the shape of a report (a cache file is read back as data, never trusted). */
export function isReuseReport(value: unknown): value is ReuseReport {
  if (typeof value !== "object" || value === null) return false;
  const report = value as Record<string, unknown>;
  const place = (candidate: unknown): boolean => {
    const p = candidate as Record<string, unknown> | null;
    return (
      typeof p === "object" &&
      p !== null &&
      typeof p.path === "string" &&
      Number.isInteger(p.from) &&
      Number.isInteger(p.to)
    );
  };
  return (
    typeof report.partial === "boolean" &&
    Array.isArray(report.duplicates) &&
    report.duplicates.every(
      (entry: Record<string, unknown>) =>
        place(entry?.here) &&
        place(entry?.there) &&
        Number.isInteger(entry?.tokens) &&
        Number.isInteger(entry?.others),
    ) &&
    Array.isArray(report.twins) &&
    report.twins.every(
      (entry: Record<string, unknown>) =>
        typeof entry?.name === "string" &&
        typeof entry?.path === "string" &&
        Number.isInteger(entry?.line) &&
        typeof (entry?.twin as Record<string, unknown> | undefined)?.name === "string" &&
        typeof (entry?.twin as Record<string, unknown> | undefined)?.path === "string" &&
        Number.isInteger((entry?.twin as Record<string, unknown> | undefined)?.line),
    )
  );
}

/** The lines of code a change added and removed (tests, documents and lockfiles apart). */
export function codeLines(files: readonly DiffFile[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const file of files) {
    if (!isCodePath(file.path)) continue;
    added += file.added;
    removed += file.removed;
  }
  return { added, removed };
}
