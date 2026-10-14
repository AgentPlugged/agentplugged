import { isCodePath, isReadableCode } from "../reuse/code-files.js";
import { type Raw, sourceWords } from "../reuse/tokens.js";

/**
 * The mutations of a change, pure. A mutation is one small, deterministic break of the
 * code a story added: a comparison turned over, a condition negated, a boolean flipped, a constant
 * moved by one, a return dropped. The engine applies them one at a time in a throwaway copy and runs
 * the tests the creator accepted; a break no test notices is a test that cannot fail there.
 *
 * Nothing here knows a language. The code is read as words (the scanner of the duplicate finder,
 * which leaves strings and comments alone), the operators are those every C-like and scripting
 * language shares, and the few spellings that differ (`and`, `None`, `undefined`) come from a small
 * table by extension. A break keeps the type of what it changes (a comparison stays a comparison),
 * so the code still builds and a failing test means something. The order is fixed and spread across
 * files and kinds: the same change gives the same mutations.
 */

export const MUTATION_KINDS = [
  "comparison",
  "condition",
  "logic",
  "boolean",
  "number",
  "return",
] as const;
export type MutationKind = (typeof MUTATION_KINDS)[number];

/** One break: the text `[start, end)` of the file is replaced by `to`. */
export interface Mutation {
  readonly path: string;
  /** The line it starts on, from 1. */
  readonly line: number;
  readonly kind: MutationKind;
  readonly from: string;
  readonly to: string;
  readonly start: number;
  readonly end: number;
}

const COMPARISON: Readonly<Record<string, string>> = {
  "==": "!=",
  "!=": "==",
  "===": "!==",
  "!==": "===",
  "<": ">=",
  "<=": ">",
  ">": "<=",
  ">=": "<",
};
const FLIPPED_WORD: Readonly<Record<string, string>> = {
  true: "false",
  false: "true",
  True: "False",
  False: "True",
};
const LOGIC_MARK: Readonly<Record<string, string>> = { "&&": "||", "||": "&&" };
const LOGIC_WORD: Readonly<Record<string, string>> = { and: "or", or: "and" };

/** Extensions whose `and`/`or` are the boolean operators. */
const WORD_LOGIC = new Set(["py", "rb", "lua"]);
/** Shells and PowerShell: `<` and `>` redirect there, they do not compare. */
const SHELLS = new Set(["sh", "bash", "zsh", "ps1"]);
/** What a function that returns nothing says, by extension; none: no value is returned for it. */
const NOTHING: Readonly<Record<string, string>> = {
  js: "undefined",
  jsx: "undefined",
  mjs: "undefined",
  cjs: "undefined",
  ts: "undefined",
  tsx: "undefined",
  mts: "undefined",
  cts: "undefined",
  vue: "undefined",
  svelte: "undefined",
  py: "None",
  pyi: "None",
  rb: "nil",
  lua: "nil",
  swift: "nil",
  php: "null",
  java: "null",
  kt: "null",
  kts: "null",
  cs: "null",
  dart: "null",
  scala: "null",
  groovy: "null",
};
/** What takes the place of a bare `return`, by extension; the C-like default is an empty statement. */
const DROPPED: Readonly<Record<string, string | null>> = { py: "pass", rb: "nil", lua: null };
const OPEN_OPERATOR = new Set([
  ",",
  "+",
  "-",
  "*",
  "/",
  "%",
  "&&",
  "||",
  "&",
  "|",
  "(",
  "[",
  "{",
  ".",
  "=>",
  "->",
  "?",
  ":",
  "=",
  "??",
  "<",
  ">",
]);

/** A value of a table by key, never one of the object's own methods (`constructor`). */
function lookup(
  table: Readonly<Record<string, string | null>>,
  key: string,
): string | null | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

const extensionOf = (path: string) => (path.toLowerCase().split(".").at(-1) ?? "").trim();

/** The lines a diff added to a file, from its new side (a context line has an old line). */
export function addedLines(lines: ReadonlyMap<number, number | null>): Set<number> {
  return new Set([...lines].filter(([, old]) => old === null).map(([line]) => line));
}

function isSpace(char: string | undefined): boolean {
  return char === " " || char === "\t";
}

/** The index of the token that closes the bracket opened at `open`, or -1. */
function closing(tokens: readonly Raw[], open: number, limit: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length && i <= open + limit; i += 1) {
    const text = (tokens[i] as Raw).text;
    if ((tokens[i] as Raw).kind !== "mark") continue;
    if (text === "(") depth += 1;
    else if (text === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function conditionOf(
  path: string,
  text: string,
  tokens: readonly Raw[],
  index: number,
): Mutation | undefined {
  const token = tokens[index] as Raw;
  const next = tokens[index + 1];
  if (next === undefined || next.line !== token.line) return undefined;
  if (next.text === "let") return undefined;
  const make = (from: [number, number], to: string): Mutation => ({
    path,
    line: token.line,
    kind: "condition",
    from: text.slice(from[0], from[1]),
    to,
    start: from[0],
    end: from[1],
  });
  if (next.text === "(") {
    const close = closing(tokens, index + 1, 80);
    if (close === -1 || (tokens[close] as Raw).line - token.line > 3) return undefined;
    const inner = text.slice(next.end, (tokens[close] as Raw).start);
    if (inner.trim() === "" || /;|:=/.test(inner)) return undefined;
    return make([next.end, (tokens[close] as Raw).start], `!(${inner})`);
  }
  // `if x:` (Python) and `if x == y {` (Go, Rust, Swift): the condition runs to the last mark of the line.
  let last = index;
  while (tokens[last + 1] !== undefined && (tokens[last + 1] as Raw).line === token.line) {
    last += 1;
  }
  const end = tokens[last] as Raw;
  const colon = extensionOf(path) === "py" || extensionOf(path) === "pyi";
  if (end.kind !== "mark" || end.text !== (colon ? ":" : "{") || last === index + 1) {
    return undefined;
  }
  const inner = text.slice(token.end, end.start).trim();
  if (inner === "" || /;|:=/.test(inner)) return undefined;
  return make([token.end, end.start], colon ? ` not (${inner})` : ` !(${inner}) `);
}

function returnOf(
  path: string,
  text: string,
  tokens: readonly Raw[],
  index: number,
): Mutation | undefined {
  const token = tokens[index] as Raw;
  const next = tokens[index + 1];
  const extension = extensionOf(path);
  const make = (start: number, end: number, to: string): Mutation => ({
    path,
    line: token.line,
    kind: "return",
    from: text.slice(start, end),
    to,
    start,
    end,
  });
  if (next === undefined || next.line !== token.line || next.text === ";" || next.text === "}") {
    // A bare `return`: the function goes on instead of leaving.
    const dropped = Object.hasOwn(DROPPED, extension) ? lookup(DROPPED, extension) : ";";
    return dropped === null || dropped === undefined
      ? undefined
      : make(token.start, token.end, dropped);
  }
  const nothing = lookup(NOTHING, extension);
  if (nothing === undefined || nothing === null) return undefined;
  // `return <expression>` on one line, whole: brackets closed, nothing left hanging.
  let depth = 0;
  let last = index;
  for (let i = index + 1; i < tokens.length; i += 1) {
    const current = tokens[i] as Raw;
    if (current.line !== token.line || current.text === ";") break;
    if (current.kind === "mark") {
      if (current.text === "(" || current.text === "[" || current.text === "{") depth += 1;
      else if (current.text === ")" || current.text === "]" || current.text === "}") depth -= 1;
      if (depth < 0) break;
    }
    last = i;
  }
  const first = next;
  const end = tokens[last] as Raw;
  if (depth !== 0 || (end.kind === "mark" && OPEN_OPERATOR.has(end.text))) return undefined;
  const after = tokens[last + 1];
  if (
    after !== undefined &&
    after.line === token.line &&
    after.text !== ";" &&
    after.text !== "}"
  ) {
    return undefined;
  }
  // A single value the other kinds already move, or the nothing it would become.
  if (last === index + 1) {
    if (
      first.kind === "number" ||
      first.text === nothing ||
      lookup(FLIPPED_WORD, first.text) !== undefined
    ) {
      return undefined;
    }
  }
  return make(first.start, end.end, nothing);
}

/**
 * The mutations a file allows on the lines the change added, in the order of the text. Nothing for
 * a file that is not code the product keeps (a test, a generated file, a document, a binary).
 */
export function proposeMutations(
  path: string,
  text: string,
  added: ReadonlySet<number>,
): Mutation[] {
  if (added.size === 0 || !isCodePath(path) || !isReadableCode(text)) return [];
  const extension = extensionOf(path);
  const tokens = sourceWords(path, text);
  const found: Mutation[] = [];
  const push = (token: Raw, kind: MutationKind, to: string) => {
    found.push({
      path,
      line: token.line,
      kind,
      from: text.slice(token.start, token.end),
      to,
      start: token.start,
      end: token.end,
    });
  };
  tokens.forEach((token, index) => {
    if (!added.has(token.line)) return;
    const before = tokens[index - 1];
    const word = token.text;
    if (token.kind === "mark") {
      const flipped = lookup(COMPARISON, word);
      if (flipped !== undefined && flipped !== null) {
        const bare = word === "<" || word === ">";
        const spaced = isSpace(text[token.start - 1]) && isSpace(text[token.end]);
        if (!bare || (spaced && !SHELLS.has(extension))) push(token, "comparison", flipped);
        return;
      }
      const swapped = lookup(LOGIC_MARK, word);
      if (
        swapped !== undefined &&
        swapped !== null &&
        before !== undefined &&
        before.line === token.line &&
        (before.kind !== "mark" || before.text === ")" || before.text === "]")
      ) {
        push(token, "logic", swapped);
      }
      return;
    }
    if (token.kind === "number") {
      const source = text.slice(token.start, token.end);
      if (before?.text === "." || before?.text === "-" || before?.text === "$") return;
      if (/^(?:0|[1-9]\d{0,8})$/.test(source)) {
        push(token, "number", source === "0" ? "1" : String(Number(source) + 1));
      } else if (/^[1-9]\d{0,8}\.\d{1,8}$/.test(source) || /^0\.\d{1,8}$/.test(source)) {
        const [whole = "0", fraction = "0"] = source.split(".");
        push(token, "number", `${Number(whole) + 1}.${fraction}`);
      }
      return;
    }
    if (token.kind !== "word") return;
    if (before?.text === ".") return;
    const flipped = lookup(FLIPPED_WORD, word);
    if (flipped !== undefined && flipped !== null) {
      push(token, "boolean", flipped);
      return;
    }
    const swapped = lookup(LOGIC_WORD, word);
    if (swapped !== undefined && swapped !== null && WORD_LOGIC.has(extension)) {
      push(token, "logic", swapped);
      return;
    }
    if (word === "if" || word === "while" || word === "elif") {
      const condition = conditionOf(path, text, tokens, index);
      if (condition !== undefined) found.push(condition);
      return;
    }
    if (word === "return") {
      const dropped = returnOf(path, text, tokens, index);
      if (dropped !== undefined) found.push(dropped);
    }
  });
  const seen = new Set<string>();
  return found.filter((mutation) => {
    const key = `${mutation.start}:${mutation.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The file with the break applied, or undefined when the text there is no longer the one proposed. */
export function applyMutation(text: string, mutation: Mutation): string | undefined {
  if (text.slice(mutation.start, mutation.end) !== mutation.from) return undefined;
  return text.slice(0, mutation.start) + mutation.to + text.slice(mutation.end);
}

/**
 * At most `max` mutations out of all those proposed, spread: files in the order of their paths, and
 * in each file the kinds in turn, then files in turn. The same proposals give the same choice.
 */
export function selectMutations(all: readonly Mutation[], max: number): Mutation[] {
  const byPath = new Map<string, Mutation[]>();
  for (const mutation of [...all].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.start - b.start,
  )) {
    const list = byPath.get(mutation.path) ?? [];
    list.push(mutation);
    byPath.set(mutation.path, list);
  }
  const queues = [...byPath.values()].map((list) => {
    const kinds = MUTATION_KINDS.map((kind) => list.filter((mutation) => mutation.kind === kind));
    const turn: Mutation[] = [];
    for (let round = 0; kinds.some((kind) => kind.length > round); round += 1) {
      for (const kind of kinds) if (kind[round] !== undefined) turn.push(kind[round] as Mutation);
    }
    return turn;
  });
  const chosen: Mutation[] = [];
  for (
    let round = 0;
    chosen.length < max && queues.some((queue) => queue.length > round);
    round += 1
  ) {
    for (const queue of queues) {
      const mutation = queue[round];
      if (mutation !== undefined && chosen.length < max) chosen.push(mutation);
    }
  }
  return chosen;
}

/** The longest side of a mutation shown in a line. */
const SIDE_MAX = 28;

function side(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= SIDE_MAX ? flat : `${flat.slice(0, SIDE_MAX - 1)}…`;
}

/** One line for a mutation: `src/a.ts:12 comparison "<" -> ">="`. */
export function describeMutation(mutation: Mutation): string {
  return `${mutation.path}:${mutation.line} ${mutation.kind} \`${side(mutation.from)}\` -> \`${side(mutation.to)}\``;
}
