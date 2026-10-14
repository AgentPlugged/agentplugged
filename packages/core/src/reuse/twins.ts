import type { SourceFile } from "./duplicates.js";
import { wordSet } from "./tokens.js";

/**
 * Probable twin functions: a function the change added whose name and
 * parameters look like those of a function the repository already holds. Two functions that do the
 * same thing written differently are not found by comparing code; their names and parameters often
 * give them away. What is returned is a hint, never a finding: the reader decides.
 */

/** A function as its declaration line shows it. */
export interface FunctionSignature {
  readonly name: string;
  readonly params: readonly string[];
  readonly path: string;
  readonly line: number;
  /** Indented: a method or a function inside another one, not one other files could import. */
  readonly nested: boolean;
}

/** A function added by the change and the one that may do the same thing. */
export interface Twin {
  readonly name: string;
  readonly path: string;
  readonly line: number;
  readonly twin: { readonly name: string; readonly path: string; readonly line: number };
  /** `same_name`: the same name once split into words; `close_name`: close names, close parameters. */
  readonly why: "same_name" | "close_name";
}

const MODIFIERS =
  "(?:(?:public|private|protected|internal|static|final|abstract|virtual|override|open|async|suspend|inline|operator|sealed|synchronized|export|default|pub(?:\\([^)]*\\))?|unsafe)\\s+)";

const PATTERNS: readonly RegExp[] = [
  new RegExp(
    `^\\s*${MODIFIERS}*function\\s*\\*?\\s*([A-Za-z_$][\\w$]*)\\s*(?:<[^>(]*>)?\\s*\\(([^)]*)\\)`,
  ),
  /^\s*(?:async\s+)?def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)\s*(?:\(([^)]*)\))?/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\(([^)]*)\)/,
  new RegExp(
    `^\\s*${MODIFIERS}*(?:fn|fun)\\s+(?:<[^>]*>\\s*)?([A-Za-z_]\\w*)\\s*(?:<[^>(]*>)?\\s*\\(([^)]*)\\)`,
  ),
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*(?::[^=]+)?=>/,
  new RegExp(
    `^\\s*${MODIFIERS}+[\\w<>\\[\\],.?*&:\\s]+?\\s+([A-Za-z_]\\w*)\\s*\\(([^)]*)\\)\\s*(?:throws [\\w, .]+)?\\s*(?:\\{|=>|$)`,
  ),
  /^\s{2,}(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::\s*[^{=]+)?\{\s*$/,
];

/** Names that say nothing about what a function does. */
const GENERIC = wordSet(
  `constructor main run init setup start stop test render handle handler get set add remove update
  delete create build parse format validate check apply call exec execute map filter reduce toString
  equals hashCode compare close open read write load save new default index each next`,
);
const NOT_A_FUNCTION = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "else",
]);

/** The functions a file declares, one per declaration line. */
export function functionsOf(path: string, text: string): FunctionSignature[] {
  const found: FunctionSignature[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.length > 400) continue;
    for (const pattern of PATTERNS) {
      const match = pattern.exec(line);
      const name = match?.[1];
      if (match === null || name === undefined || NOT_A_FUNCTION.has(name)) continue;
      const raw = match[2] ?? match[3] ?? "";
      found.push({
        name,
        params: paramsOf(raw, path),
        path,
        line: index + 1,
        nested: /^\s/.test(line),
      });
      break;
    }
  }
  return found;
}

const PARAM_MODIFIERS = new Set([
  "final",
  "const",
  "mut",
  "ref",
  "val",
  "var",
  "readonly",
  "in",
  "out",
]);

/**
 * The names of the parameters, not their types: `name: Type` and Go's `name Type` give the first
 * word, `Type name` (Java, C, C#) the last.
 */
function paramsOf(raw: string, path: string): string[] {
  const nameFirst = /\.go$/i.test(path);
  return raw
    .split(",")
    .map((part) => {
      const bare = part.split("=")[0] ?? "";
      const words = ((bare.split(":")[0] ?? "").match(/[A-Za-z_$][\w$]*/g) ?? []).filter(
        (word) => !PARAM_MODIFIERS.has(word),
      );
      return bare.includes(":") || nameFirst ? words[0] : words.at(-1);
    })
    .filter((name): name is string => name !== undefined && name !== "self" && name !== "this");
}

/** A name in lower-case words: `getUserById` and `get_user_by_id` are the same. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter((word) => word !== "");
}

function distance(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        (previous[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = row;
  }
  return previous[b.length] as number;
}

/** Closeness (0 to 1) of two names, once split into words. */
export function nameLikeness(a: string, b: string): number {
  const left = nameWords(a).join(" ");
  const right = nameWords(b).join(" ");
  const longest = Math.max(left.length, right.length);
  return longest === 0 ? 0 : 1 - distance(left, right) / longest;
}

/** Closeness of the parameters: shared names over the names of the longer list. */
function paramsLikeness(a: readonly string[], b: readonly string[]): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 0;
  const names = new Set(b.map((name) => nameWords(name).join(" ")));
  const shared = a.filter((name) => names.has(nameWords(name).join(" "))).length;
  return shared / longest;
}

/** Names this close are probably the same intent. */
export const CLOSE_NAME = 0.8;
/** Parameters this close, with close names. */
export const CLOSE_PARAMS = 0.5;
/** Most twins returned. */
export const MAX_TWINS = 10;

/** Languages whose functions all live inside a class: an indented declaration is then the norm. */
const CLASS_ONLY = /\.(?:java|kt|kts|scala|groovy|cs|php|swift|dart)$/i;

/**
 * Two methods (or inner functions) of the same name in different files are the two sides of an
 * interface, a port and its adapter: not a function written twice. Only a declaration other files
 * could import counts, on one side at least.
 */
function bothInside(a: FunctionSignature, b: FunctionSignature): boolean {
  return a.nested && b.nested && !CLASS_ONLY.test(a.path) && !CLASS_ONLY.test(b.path);
}

function meaningful(name: string): boolean {
  const words = nameWords(name);
  return !GENERIC.has(name) && (words.length >= 2 || name.length >= 8);
}

/**
 * The functions of `added` (declared on a line the change added) that look like a function of the
 * repository: the same name in words, or a close name with close parameters. Never the function
 * itself; generic names (`get`, `run`, `handle`) and short ones say nothing and are left out.
 */
export function findTwins(
  files: readonly SourceFile[],
  added: ReadonlyMap<string, ReadonlySet<number>>,
): Twin[] {
  const all = files.flatMap((file) => functionsOf(file.path, file.text));
  const fresh = all.filter(
    (fn) => added.get(fn.path)?.has(fn.line) === true && meaningful(fn.name),
  );
  if (fresh.length === 0) return [];
  const byWord = new Map<string, FunctionSignature[]>();
  for (const fn of all) {
    if (!meaningful(fn.name)) continue;
    for (const word of new Set(nameWords(fn.name))) {
      if (word.length < 3) continue;
      const list = byWord.get(word);
      if (list === undefined) byWord.set(word, [fn]);
      else if (list.length < 300) list.push(fn);
    }
  }
  const twins: Twin[] = [];
  for (const fn of fresh) {
    const candidates = new Set<FunctionSignature>();
    for (const word of nameWords(fn.name))
      for (const other of byWord.get(word) ?? []) candidates.add(other);
    let best: { fn: FunctionSignature; why: Twin["why"]; score: number } | undefined;
    for (const other of candidates) {
      if (other.path === fn.path && other.line === fn.line) continue;
      if (bothInside(fn, other)) continue;
      // A function the change added too, further on, is reported from its own side only.
      if (
        added.get(other.path)?.has(other.line) === true &&
        (other.path < fn.path || (other.path === fn.path && other.line < fn.line))
      ) {
        continue;
      }
      const likeness = nameLikeness(fn.name, other.name);
      const same = nameWords(fn.name).join(" ") === nameWords(other.name).join(" ");
      let why: Twin["why"] | undefined;
      if (same) why = "same_name";
      else if (likeness >= CLOSE_NAME && paramsLikeness(fn.params, other.params) >= CLOSE_PARAMS) {
        why = "close_name";
      }
      if (why === undefined) continue;
      const score = (same ? 2 : 1) + likeness;
      if (best === undefined || score > best.score) best = { fn: other, why, score };
    }
    if (best !== undefined) {
      twins.push({
        name: fn.name,
        path: fn.path,
        line: fn.line,
        twin: { name: best.fn.name, path: best.fn.path, line: best.fn.line },
        why: best.why,
      });
    }
  }
  return twins.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line).slice(0, MAX_TWINS);
}
