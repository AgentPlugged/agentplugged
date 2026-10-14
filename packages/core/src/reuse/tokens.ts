/**
 * The words of a source file, for any language. No parser: a scanner
 * by regular expressions that every C-like or scripting language fits. Comments and blanks are
 * dropped; identifiers become one word, numbers one word, strings one word, and the keywords (the
 * union of the common languages') are kept: two functions that only differ by their names and
 * values read the same. Statements made only of references to other files (imports) are dropped:
 * many files import the same things, which is not a duplicate. Pure: text in, words out.
 */

/** The words of a file: one interned number per word and the line (from 1) it stands on. */
export interface FileWords {
  readonly ids: Uint32Array;
  readonly lines: Uint32Array;
}

/** The interned words of a run: one number per distinct normalised word. */
export class WordTable {
  readonly #ids = new Map<string, number>();

  intern(word: string): number {
    const known = this.#ids.get(word);
    if (known !== undefined) return known;
    const id = this.#ids.size + 1;
    this.#ids.set(word, id);
    return id;
  }
}

type CommentStyle = "slash" | "hash" | "dash" | "slashhash";

const HASH = new Set([
  "py",
  "rb",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "pl",
  "pm",
  "r",
  "ex",
  "exs",
  "nim",
  "cr",
  "yml",
  "yaml",
  "toml",
]);
const DASH = new Set(["sql", "lua", "hs", "elm", "ada"]);
const SLASH_HASH = new Set(["php", "pl", "pm"]);

function styleOf(path: string): CommentStyle {
  const extension = path.toLowerCase().split(".").at(-1) ?? "";
  if (SLASH_HASH.has(extension)) return "slashhash";
  if (HASH.has(extension)) return "hash";
  return DASH.has(extension) ? "dash" : "slash";
}

/** The words of a text, as a set: lists of names written once, space-separated. */
export function wordSet(text: string): Set<string> {
  return new Set(text.split(/\s+/).filter((word) => word !== ""));
}

const KEYWORDS = wordSet(
  `if else elif elsif unless for foreach while do until loop switch case default match when where
  break continue return yield await async function def fn func fun class struct enum interface trait
  impl type typedef let const var val mut static final abstract public private protected internal
  override virtual readonly try catch except finally rescue ensure throw throws raise new delete
  null nil none true false undefined this self super in of is as and or not with lambda pass defer
  go chan select range import from export package use using module namespace extends implements
  instanceof typeof void goto then begin end`,
);

/** Words that open a statement made only of references to other files. */
const IMPORTS = new Set([
  "import",
  "from",
  "using",
  "package",
  "use",
  "require",
  "require_relative",
]);
const PREPROCESSOR = new Set(["include", "pragma", "import", "ifndef", "ifdef", "endif"]);

const OPERATORS =
  ">>>=|<<=|>>=|\\*\\*=|\\.\\.\\.|===|!==|=>|->|::|&&|\\|\\||\\?\\?|\\?\\.|==|!=|<=|>=|\\+\\+|--|\\+=|-=|\\*=|/=|%=|&=|\\|=|\\^=|<<|>>|\\*\\*|\\.\\.";

function scannerOf(style: CommentStyle): string {
  const comment =
    style === "slash"
      ? "//[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|$)"
      : style === "slashhash"
        ? "//[^\\n]*|#[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|$)"
        : style === "hash"
          ? "(?<![${])#[^\\n]*"
          : "--\\[\\[[\\s\\S]*?(?:\\]\\]|$)|--[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|$)";
  return [
    "(\\s+)",
    `(${comment})`,
    "(\"\"\"[\\s\\S]*?(?:\"\"\"|$)|'''[\\s\\S]*?(?:'''|$))",
    "(\"(?:\\\\.|[^\"\\\\\\n])*\"?|'(?:\\\\.|[^'\\\\\\n])*'?|`(?:\\\\[\\s\\S]|[^`\\\\])*`?)",
    "([\\p{L}_$][\\p{L}\\p{N}_$]*)",
    "(\\d[\\w.]*)",
    `(${OPERATORS}|[\\s\\S])`,
  ].join("|");
}

const SCANNERS: Record<CommentStyle, string> = {
  slash: scannerOf("slash"),
  slashhash: scannerOf("slashhash"),
  hash: scannerOf("hash"),
  dash: scannerOf("dash"),
};

/** A word of a source file as it stands: what kind, its text (words and marks), where it lies. */
export interface Raw {
  readonly kind: "word" | "number" | "string" | "mark";
  readonly text: string;
  readonly line: number;
  /** First word of its line. */
  readonly first: boolean;
  /** Where it lies in the text: offsets of its first character and just after its last. */
  readonly start: number;
  readonly end: number;
}

function countLines(chunk: string): number {
  let count = 0;
  for (let i = chunk.indexOf("\n"); i !== -1; i = chunk.indexOf("\n", i + 1)) count += 1;
  return count;
}

function scan(text: string, style: CommentStyle): Raw[] {
  const scanner = new RegExp(SCANNERS[style], "uy");
  const raws: Raw[] = [];
  let line = 1;
  let first = true;
  let position = 0;
  while (position < text.length) {
    scanner.lastIndex = position;
    const match = scanner.exec(text);
    if (match === null || match[0] === "") {
      position += 1;
      continue;
    }
    const from = position;
    position = scanner.lastIndex;
    const [chunk, blank, comment, , , word, number, mark] = match;
    const startLine = line;
    line += countLines(chunk);
    if (blank !== undefined) {
      if (countLines(blank) > 0) first = true;
      continue;
    }
    if (comment !== undefined) continue;
    // Only words and marks keep their text: a string or a number is one word whatever it says.
    const kind =
      word !== undefined
        ? "word"
        : mark !== undefined
          ? "mark"
          : number !== undefined
            ? "number"
            : "string";
    raws.push({
      kind,
      text: word ?? mark ?? "",
      line: startLine,
      first,
      start: from,
      end: position,
    });
    first = false;
  }
  return raws;
}

const OPENING = new Set(["(", "[", "{"]);
const CLOSING = new Set([")", "]", "}"]);

/**
 * The indexes of the raw words that belong to a statement of references (`import x from "y"`,
 * `use a::{b, c};`, `#include <x>`, `from a import (b,\n c)`): from its first word to the end of its
 * line, or of its brackets.
 */
function referenceWords(raws: readonly Raw[]): Set<number> {
  const skipped = new Set<number>();
  for (let i = 0; i < raws.length; i += 1) {
    const raw = raws[i] as Raw;
    if (!raw.first || skipped.has(i)) continue;
    const next = raws[i + 1];
    let reference = false;
    if (raw.kind === "word" && IMPORTS.has(raw.text)) {
      // `using (var x = ...)` is a statement, not a reference.
      reference = !(raw.text === "using" && next?.text === "(");
    } else if (raw.kind === "word" && raw.text === "export") {
      reference = next?.text === "*" || next?.text === "{";
    } else if (raw.kind === "mark" && raw.text === "#" && next?.kind === "word") {
      reference = PREPROCESSOR.has(next.text);
    }
    if (!reference) continue;
    let depth = 0;
    let j = i;
    for (; j < raws.length; j += 1) {
      const current = raws[j] as Raw;
      if (j > i && current.line !== (raws[j - 1] as Raw).line && depth <= 0) break;
      skipped.add(j);
      if (OPENING.has(current.text)) depth += 1;
      else if (CLOSING.has(current.text)) depth -= 1;
      else if (current.text === ";" && depth <= 0) {
        j += 1;
        break;
      }
    }
    i = j - 1;
  }
  return skipped;
}

/**
 * The words of a file as they stand, comments left out, with their lines and offsets: what the
 * mutations need to change a comparison, a constant or a return without touching a
 * string or a comment. `path` tells the comment style.
 */
export function sourceWords(path: string, text: string): Raw[] {
  return scan(text, styleOf(path));
}

/** The normalised words of a file, with their lines. `path` tells the comment style. */
export function wordsOf(path: string, text: string, table: WordTable): FileWords {
  const raws = scan(text, styleOf(path));
  const skipped = referenceWords(raws);
  const ids: number[] = [];
  const lines: number[] = [];
  raws.forEach((raw, index) => {
    if (skipped.has(index)) return;
    let word: string;
    if (raw.kind === "word") word = KEYWORDS.has(raw.text) ? raw.text : "\u0001id";
    else if (raw.kind === "number") word = "\u0001num";
    else if (raw.kind === "string") word = "\u0001str";
    else word = raw.text;
    ids.push(table.intern(word));
    lines.push(raw.line);
  });
  return { ids: Uint32Array.from(ids), lines: Uint32Array.from(lines) };
}
