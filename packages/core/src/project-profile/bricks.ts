import { isCodePath, isReadableCode, MAX_FILE_BYTES } from "../reuse/code-files.js";
import type { SourceFile } from "../reuse/duplicates.js";
import { functionsOf, nameWords } from "../reuse/twins.js";
import type { SingleSource } from "./profile-file.js";

/**
 * The registry of bricks: the functions and types a module of the product declares, found by
 * reading its source with the same language-agnostic patterns as the duplicate detector, so that an
 * agent asks « does this already exist? » instead of reading the code to find out. Pure; the
 * engine keeps the result in its cache, keyed by the commit it was read at.
 */

export type BrickKind = "fn" | "type";

export interface Brick {
  readonly name: string;
  readonly kind: BrickKind;
  readonly path: string;
  readonly line: number;
  /** The declaration as the file writes it, cut short. */
  readonly sig: string;
}

/** Most bricks kept: past it the registry is cut, never a failure. */
export const MAX_BRICKS = 20_000;
const SIG_MAX = 100;

const TYPE_PATTERN =
  /^\s*(?:(?:export|default|public|private|protected|internal|pub(?:\([^)]*\))?|abstract|final|sealed|static|data|open|partial|declare)\s+)*(class|interface|struct|enum|trait|type|record|protocol|object|union)\s+([A-Za-z_$][\w$]*)/;

/** Names a person would not search for (the same ones the twin detector ignores as generic). */
const SKIP_NAME = new Set(["constructor", "main", "default", "index"]);

/**
 * A function whose parameter list runs over several lines: the declaration line opens the
 * parenthesis and does not close it (`function f(`, `def f(`, `const f = async (`).
 */
const OPEN_DECLARATION =
  /^(?:export\s+)?(?:default\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:(?:function\s*\*?|def|func|fn|fun)\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?)\s*(?:<[^>(]*>)?\s*\(([^)]*)$/;

/** The names of the parameters listed on the lines after an opened parenthesis. */
function multilineParams(first: string, lines: readonly string[], from: number): string[] {
  let raw = first;
  for (let next = from; next < Math.min(lines.length, from + 14); next += 1) {
    const line = lines[next] as string;
    const close = line.indexOf(")");
    if (close !== -1) {
      raw += ` ${line.slice(0, close)}`;
      break;
    }
    raw += ` ${line}`;
  }
  return splitTopLevel(raw)
    .map((part) => /[A-Za-z_$][\w$]*/.exec((part.split(":")[0] ?? "").trim())?.[0])
    .filter((name): name is string => name !== undefined && name !== "readonly");
}

/** The parts of a list split at the commas that are not inside <>, () or []. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if ("<([{".includes(char)) depth += 1;
    else if (">)]}".includes(char)) depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return parts;
}

/** The bricks of one file: the functions other files could import, and the types. */
export function bricksOf(path: string, text: string): Brick[] {
  const found: Brick[] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");
  for (const fn of functionsOf(path, text)) {
    if (fn.nested || SKIP_NAME.has(fn.name)) continue;
    seen.add(`${fn.line}`);
    found.push({
      name: fn.name,
      kind: "fn",
      path,
      line: fn.line,
      sig: `${fn.name}(${fn.params.join(", ")})`.slice(0, SIG_MAX),
    });
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.length > 300 || seen.has(`${index + 1}`)) continue;
    const open = OPEN_DECLARATION.exec(line);
    const opened = open?.[1] ?? open?.[2];
    if (open === null || opened === undefined || SKIP_NAME.has(opened)) continue;
    found.push({
      name: opened,
      kind: "fn",
      path,
      line: index + 1,
      sig: `${opened}(${multilineParams(open[3] ?? "", lines, index + 1).join(", ")})`.slice(
        0,
        SIG_MAX,
      ),
    });
  }
  found.sort((a, b) => a.line - b.line);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.length > 300) continue;
    const match = TYPE_PATTERN.exec(line);
    const name = match?.[2];
    if (match === null || name === undefined || name.length < 3) continue;
    // `type X,` inside an export list is a re-export, not a declaration.
    if (/^\s*[,}]/.test(line.slice(match[0].length))) continue;
    // A lowercase `type x` or `object` in prose or a string is not a declaration worth listing.
    // A `type` is a top-level declaration: indented, it sits in an export list or a body.
    if (
      match[1] === "type" &&
      (/^\s/.test(line) || !/^(?:export\s+)?type\s+[A-Z]/.test(line)) &&
      !(/\.go$/.test(path) && !/^\s/.test(line))
    ) {
      continue;
    }
    found.push({
      name,
      kind: "type",
      path,
      line: index + 1,
      sig: line
        .trim()
        .replace(/\s*[{(=].*$/, "")
        .slice(0, SIG_MAX),
    });
  }
  return found;
}

/** The registry of a set of files (tests, generated code and the like are left out). */
export function buildBricks(files: readonly SourceFile[]): Brick[] {
  const all: Brick[] = [];
  for (const file of files) {
    if (!isCodePath(file.path) || !isReadableCode(file.text)) continue;
    all.push(...bricksOf(file.path, file.text));
    if (all.length >= MAX_BRICKS) break;
  }
  return all.slice(0, MAX_BRICKS);
}

/** Largest file read to build the registry (bytes). */
export const BRICK_FILE_BYTES = MAX_FILE_BYTES;

/** Lower-case search words of a request: names are split, plurals folded, filler dropped. */
export function searchWords(words: readonly string[]): string[] {
  const filler = new Set(
    "the a an of for to and or in is it does do into from with that this all any how we there already exist exists".split(
      " ",
    ),
  );
  const out = new Set<string>();
  for (const word of words.flatMap((entry) => nameWords(entry))) {
    if (word.length < 2 || filler.has(word)) continue;
    out.add(stem(word));
  }
  return [...out];
}

/**
 * A word folded to its root, so that « parsing dates » finds `parseDate`: plural, `-ing`, `-ed`, a
 * final `e` and a doubled last letter are dropped. Both sides of a comparison go through it.
 */
export const stem = (word: string): string => {
  let root = word;
  if (root.length > 4 && root.endsWith("ies")) root = `${root.slice(0, -3)}y`;
  else if (root.length > 3 && root.endsWith("s") && !root.endsWith("ss")) root = root.slice(0, -1);
  if (root.length > 5 && root.endsWith("ing")) root = root.slice(0, -3);
  else if (root.length > 4 && root.endsWith("ed")) root = root.slice(0, -2);
  if (root.length > 3 && root.endsWith("e")) root = root.slice(0, -1);
  if (root.length > 4 && /([^aeiou])\1$/.test(root) && !root.endsWith("ss"))
    root = root.slice(0, -1);
  return root;
};

/** A brick that answers a request, with the words that matched. */
export interface BrickHit {
  readonly brick: Brick;
  readonly score: number;
}

/** Hits returned at most. */
export const MAX_HITS = 8;

/**
 * The bricks that answer a request: those whose name carries the most of its words (all of them
 * first), then those whose path or signature does. Nothing is returned when no word matches.
 */
export function findBricks(bricks: readonly Brick[], request: readonly string[]): BrickHit[] {
  const wanted = searchWords(request);
  if (wanted.length === 0) return [];
  const hits: BrickHit[] = [];
  for (const brick of bricks) {
    const inName = new Set(nameWords(brick.name).map(stem));
    const inPath = new Set(nameWords(brick.path).map(stem));
    const inSig = new Set(nameWords(brick.sig).map(stem));
    let score = 0;
    let named = 0;
    let covered = 0;
    for (const word of wanted) {
      if (inName.has(word)) {
        score += 3;
        named += 1;
        covered += 1;
      } else if (inPath.has(word)) {
        score += 1;
        covered += 1;
      } else if (inSig.has(word)) {
        score += 0.5;
        covered += 1;
      }
    }
    // Most of the request must be there, and the name must carry some of it (a lone word may
    // be the module's own name: every function of `money.ts` answers « money »).
    if (covered < Math.ceil(wanted.length * 0.6)) continue;
    if (named === 0 && wanted.length > 1) continue;
    if (named === wanted.length) score += 2;
    hits.push({ brick, score });
  }
  return hits
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.brick.path.localeCompare(b.brick.path) ||
        a.brick.line - b.brick.line,
    )
    .slice(0, MAX_HITS);
}

/** A single source that answers a request: every word of its concept is in the request. */
export function matchingSources(
  sources: readonly SingleSource[],
  request: readonly string[],
): SingleSource[] {
  const wanted = new Set(searchWords(request));
  return sources.filter((source) => {
    const words = searchWords([source.concept]);
    return words.length > 0 && words.every((word) => wanted.has(word));
  });
}

/** True when `path` is the owner (a file) or lies under it (a folder written with a final `/`). */
export function isOwner(source: SingleSource, path: string): boolean {
  const owner = source.owner.replaceAll("\\", "/");
  const here = path.replaceAll("\\", "/");
  return owner.endsWith("/") ? here.startsWith(owner) : here === owner;
}

/** A function that a story added outside the one owner of the concept its name carries. */
export interface SourceClash {
  readonly name: string;
  readonly path: string;
  readonly line: number;
  readonly concept: string;
  readonly owner: string;
}

/**
 * The functions of `added` (a path and its added lines) whose name carries every word of a single
 * source's concept while their file is not its owner: the concept has one home, and this is a second.
 */
export function sourceClashes(
  files: readonly SourceFile[],
  added: ReadonlyMap<string, ReadonlySet<number>>,
  sources: readonly SingleSource[],
): SourceClash[] {
  if (sources.length === 0) return [];
  const clashes: SourceClash[] = [];
  for (const file of files) {
    const lines = added.get(file.path);
    if (lines === undefined) continue;
    for (const brick of bricksOf(file.path, file.text)) {
      if (!lines.has(brick.line)) continue;
      const words = new Set(nameWords(brick.name).map(stem));
      for (const source of sources) {
        if (isOwner(source, brick.path)) continue;
        const concept = searchWords([source.concept]);
        if (concept.length > 0 && concept.every((word) => words.has(word))) {
          clashes.push({
            name: brick.name,
            path: brick.path,
            line: brick.line,
            concept: source.concept,
            owner: source.owner,
          });
          break;
        }
      }
    }
  }
  return clashes;
}
