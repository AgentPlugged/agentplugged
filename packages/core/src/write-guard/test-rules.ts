import type { TestGuardRow } from "@agentplugged/protocol";
import { type Raw, sourceWords } from "../reuse/tokens.js";

/**
 * The rules of the tests for the guard before a write, pure: a path and the text a
 * write adds in, the places that break a named rule out. No parser: the same word reading as the
 * duplicate detector (`reuse/tokens.ts`), so a comment or a string never counts, in any language.
 *
 * - `focused`: a test isolated so that the others do not run (`.only`, `fit`, `focus: true`…);
 * - `skipped`: a test disabled with no reason written (a comment beside it, or the reason as an
 *   argument of the skip when the language gives one);
 * - `hard_wait`: a fixed wait (`sleep`, `waitForTimeout`…), unless a reason is written beside it or
 *   the file runs on a fake clock;
 * - `tautology`: an assertion that cannot fail (`expect(true).toBe(true)`, `assert x == x`);
 * - `oversize`: a whole test file over the limit (decided by the caller, from the line count).
 *
 * In doubt a rule says nothing: only what the words show for sure is a violation.
 */

/** One place that breaks a rule: the row of the grid, and the line (from 1; 0 for the whole file). */
export interface TestViolation {
  readonly row: TestGuardRow;
  readonly line: number;
}

/** A stretch of words: from the first to just after the last. */
interface Range {
  from: number;
  to: number;
}

type Family =
  | "js"
  | "python"
  | "ruby"
  | "go"
  | "jvm"
  | "cs"
  | "rust"
  | "php"
  | "swift"
  | "dart"
  | "cpp"
  | "other";

const FAMILIES: Readonly<Record<string, Family>> = {
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  ts: "js",
  tsx: "js",
  mts: "js",
  cts: "js",
  vue: "js",
  svelte: "js",
  astro: "js",
  py: "python",
  rb: "ruby",
  go: "go",
  java: "jvm",
  kt: "jvm",
  kts: "jvm",
  scala: "jvm",
  groovy: "jvm",
  cs: "cs",
  rs: "rust",
  php: "php",
  swift: "swift",
  dart: "dart",
  c: "cpp",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  h: "cpp",
  hpp: "cpp",
};

const familyOf = (path: string): Family =>
  FAMILIES[(path.split(".").at(-1) ?? "").toLowerCase()] ?? "other";

/** The blocks of a JavaScript test file, as they are written before `.only` or `.skip`. */
const JS_BLOCKS = new Set([
  "it",
  "test",
  "describe",
  "context",
  "suite",
  "specify",
  "scenario",
  "feature",
  "spec",
  "bench",
  "concurrent",
  "serial",
  "parallel",
]);
const FOCUS_CALLS = new Set(["fit", "fdescribe", "fcontext", "fspecify", "fscenario", "ffeature"]);
const DISABLED_CALLS = new Set(["xit", "xdescribe", "xtest", "xcontext", "xspecify", "xscenario"]);

/** What a skip is called in Python, and what it is called on (`pytest.mark.skip`, `self.skipTest`). */
const PY_SKIPS = new Set(["skip", "skipIf", "skipUnless", "skipif", "skipTest"]);
const PY_OWNERS = new Set(["pytest", "mark", "unittest", "self", "cls"]);

/** Words that say a file runs on a fake or virtual clock: a wait there costs no real time. */
const FAKE_CLOCK = new Set([
  "useFakeTimers",
  "advanceTimersByTime",
  "advanceTimersToNextTimer",
  "runAllTimers",
  "runOnlyPendingTimers",
  "freeze_time",
  "freezegun",
  "start_paused",
  "TestScheduler",
  "advanceUntilIdle",
  "fakeAsync",
  "FakeClock",
  "FakeTimers",
]);

const SLEEP_WORDS = new Set([
  "sleep",
  "usleep",
  "nanosleep",
  "msleep",
  "Sleep",
  "waitForTimeout",
  "wait_for_timeout",
]);

/** Words of a comment that are no reason by themselves. */
const FILLER = new Set([
  "skip",
  "skipped",
  "disabled",
  "todo",
  "fixme",
  "ignore",
  "ignored",
  "wip",
  "tmp",
  "temp",
  "temporarily",
  "xxx",
  "hack",
]);
const PRAGMA =
  /^\s*(?:eslint|prettier|biome|istanbul|c8|@ts-|noqa|pragma|nolint|rubocop|pylint|type:|mypy|tslint|stylelint|jshint|coverage)/i;

const TRUE_WORDS = new Set(["true", "True", "TRUE"]);
const LITERAL_WORDS = new Set([
  "true",
  "false",
  "True",
  "False",
  "TRUE",
  "FALSE",
  "null",
  "nil",
  "None",
  "NULL",
  "undefined",
]);
/** Words that make a line a loop or a poll: a wait there is an interval, not a fixed wait. */
const LOOPS = new Set([
  "while",
  "for",
  "do",
  "loop",
  "until",
  "repeat",
  "foreach",
  "waitFor",
  "waitUntil",
  "retry",
  "poll",
  "eventually",
]);
const COMPARES = new Set(["==", "===", "is", ">=", "<="]);

/** A reading of a file: its words, its text, and where its comments are. */
class Reading {
  readonly raws: Raw[];
  readonly #comments = new Map<number, string>();
  readonly #code = new Set<number>();
  readonly #firsts = new Map<number, number>();
  readonly #starts: number[] = [0];
  readonly #indents: number[] = [];
  readonly #loops = new Set<number>();
  /** How many words the argument readings may walk over in all: a hostile file cannot make a hook slow. */
  #budget = 3_000_000;
  readonly #deadline = Date.now() + 1500;

  /** Spends one step of the budget; true once it is gone (spent up, or the time is). */
  #spent(): boolean {
    this.#budget -= 1;
    if (this.#budget % 4096 === 0 && Date.now() > this.#deadline) this.#budget = -1;
    return this.#budget < 0;
  }

  /** True when a reading was cut short: the budget ran out, so the rules saw only part of the file. */
  get partial(): boolean {
    return this.#budget < 0;
  }

  constructor(
    readonly path: string,
    readonly text: string,
  ) {
    this.raws = sourceWords(path, text);
    this.raws.forEach((raw, index) => {
      this.#code.add(raw.line);
      if (raw.first && !this.#firsts.has(raw.line)) this.#firsts.set(raw.line, index);
      if (raw.kind === "word" && LOOPS.has(raw.text)) this.#loops.add(raw.line);
    });
    const starts = this.#starts;
    for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1))
      starts.push(at + 1);
    for (const start of starts) {
      let at = start;
      while (text[at] === " " || text[at] === "\t") at += 1;
      this.#indents.push(at - start);
    }
    const lineAt = (offset: number) => {
      let low = 0;
      let high = starts.length - 1;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if ((starts[middle] as number) <= offset) low = middle;
        else high = middle - 1;
      }
      return low + 1;
    };
    // Between two words there is only blank and comment: what is not blank is a comment.
    const gap = (from: number, to: number) => {
      const chunk = text.slice(from, to);
      if (!/\S/.test(chunk)) return;
      let offset = from;
      for (const part of chunk.split("\n")) {
        if (part.trim() !== "") {
          const line = lineAt(offset);
          const known = this.#comments.get(line);
          this.#comments.set(line, known === undefined ? part.trim() : `${known} ${part.trim()}`);
        }
        offset += part.length + 1;
      }
    };
    let from = 0;
    for (const raw of this.raws) {
      gap(from, raw.start);
      from = raw.end;
    }
    gap(from, text.length);
  }

  val(index: number): string {
    const raw = this.raws[index];
    return raw === undefined ? "" : this.text.slice(raw.start, raw.end);
  }

  /** The text of a word or mark (empty for a number or a string). */
  word(index: number): string {
    return this.raws[index]?.text ?? "";
  }

  kind(index: number): Raw["kind"] | undefined {
    return this.raws[index]?.kind;
  }

  line(index: number): number {
    return this.raws[index]?.line ?? 0;
  }

  /** True when the comment text is a reason: some words that are not only fillers or pragmas. */
  #reason(comment: string): boolean {
    const stripped = comment.replace(/^[\s/*#\-!;]+/, "").replace(/\*\/\s*$/, "");
    if (PRAGMA.test(stripped)) return false;
    const words = stripped
      .split(/\s+/)
      .filter(
        (word) => /\p{L}{2,}/u.test(word) && !FILLER.has(word.toLowerCase().replace(/\W/g, "")),
      );
    return words.length >= 2 && stripped.length >= 8;
  }

  /** True when a reason is written on `line`, or in the comment lines directly above it. */
  reasoned(line: number): boolean {
    const own = this.#comments.get(line);
    if (own !== undefined && this.#reason(own)) return true;
    let above = "";
    for (let at = line - 1; at > 0 && this.#comments.has(at) && !this.#code.has(at); at -= 1) {
      above += ` ${this.#comments.get(at)}`;
    }
    return above !== "" && this.#reason(above);
  }

  #indentOf(line: number): number {
    return this.#indents[line - 1] ?? 0;
  }

  /** The nearest line above `line` that holds code, or 0. */
  #previousCode(line: number): number {
    let at = line - 1;
    while (at > 0 && !this.#firsts.has(at)) {
      at -= 1;
      if (this.#spent()) return 0;
    }
    return at;
  }

  /**
   * True when the line is inside a loop (`while`, `for`, `loop`…) or is one: a wait there is the
   * interval of a poll, not a fixed wait. Read from the indentation of the lines above, a few
   * levels up; true when the reading costs too much, since a doubt lets the write through.
   */
  inLoop(line: number): boolean {
    if (this.#loops.has(line)) return true;
    let indent = this.#indentOf(line);
    let at = line - 1;
    for (let level = 0; level < 4 && indent > 0; level += 1) {
      while (at > 0 && (!this.#firsts.has(at) || this.#indentOf(at) >= indent)) {
        at -= 1;
        if (this.#spent()) return true;
      }
      const first = this.#firsts.get(at);
      if (first === undefined) return false;
      if (this.#loops.has(at)) return true;
      indent = this.#indentOf(at);
      // A brace on its own line (Allman style) belongs to the line above it.
      if (this.word(first) === "{" && this.#loops.has(this.#previousCode(at))) return true;
      at -= 1;
    }
    return false;
  }

  /** The tokens of the arguments of the call at `index` (parenthesis, or bare to the end of line). */
  args(index: number, bare: boolean): Range[] | undefined {
    let open = index + 1;
    if (this.word(open) === "!" && this.kind(open) === "mark") open += 1;
    const parens = this.word(open) === "(" && this.kind(open) === "mark";
    if (!parens && !(bare && this.raws[index]?.first === true)) return undefined;
    const list: Range[] = [];
    let depth = 0;
    let from = parens ? open + 1 : index + 1;
    const line = this.line(index);
    for (let at = from; at < this.raws.length; at += 1) {
      const raw = this.raws[at] as Raw;
      if (!parens && raw.line !== line && depth <= 0) {
        list.push({ from, to: at });
        return list;
      }
      if (raw.kind === "mark") {
        if (raw.text === "(" || raw.text === "[" || raw.text === "{") depth += 1;
        else if (raw.text === ")" || raw.text === "]" || raw.text === "}") {
          if (depth === 0 && parens) {
            list.push({ from, to: at });
            return list;
          }
          depth -= 1;
        } else if (raw.text === "," && depth === 0) {
          list.push({ from, to: at });
          from = at + 1;
        } else if (raw.text === ";" && depth === 0 && !parens) {
          list.push({ from, to: at });
          return list;
        }
      }
      if (at - index > 400 || this.#spent()) return undefined;
    }
    return parens ? undefined : [...list, { from, to: this.raws.length }];
  }

  key(range: Range): string {
    const parts: string[] = [];
    for (let at = range.from; at < range.to; at += 1) parts.push(this.val(at));
    return parts.join("\u0001");
  }

  size(range: Range): number {
    return range.to - range.from;
  }

  hasCall(range: Range): boolean {
    for (let at = range.from; at < range.to; at += 1) {
      if (this.kind(at) === "mark" && this.word(at) === "(") return true;
    }
    return false;
  }

  literal(range: Range): boolean {
    if (this.size(range) !== 1) return false;
    const kind = this.kind(range.from);
    return (
      kind === "number" ||
      kind === "string" ||
      (kind === "word" && LITERAL_WORDS.has(this.word(range.from)))
    );
  }

  truthy(range: Range): boolean {
    if (this.size(range) !== 1) return false;
    if (this.kind(range.from) === "word") return TRUE_WORDS.has(this.word(range.from));
    return this.kind(range.from) === "number" && !/^0+(?:\.0*)?$/.test(this.val(range.from));
  }

  /** `X op X` at the top of the tokens, without any call: a comparison that cannot fail. */
  selfCompared(range: Range): boolean {
    for (let at = range.from + 1; at < range.to - 1; at += 1) {
      const raw = this.raws[at] as Raw;
      if (!COMPARES.has(raw.text) || (raw.kind !== "mark" && raw.kind !== "word")) continue;
      const left = { from: range.from, to: at };
      const right = { from: at + 1, to: range.to };
      if (this.hasCall(left) || this.hasCall(right) || this.size(left) === 0) return false;
      return this.key(left) === this.key(right);
    }
    return false;
  }
}

const EQUAL_NAMES = new Set([
  "assertequal",
  "assertequals",
  "assertsame",
  "assertis",
  "asserteq",
  "assertstrictequal",
  "assertdeepequal",
  "assertstrictequals",
  "areequal",
  "aresame",
]);
const BARE_EQUAL_NAMES = new Set(["equal", "equals", "same", "strictequal", "deepequal"]);
const TRUTHY_NAMES = new Set(["assert", "asserttrue", "assertistrue"]);
const BARE_TRUTHY_NAMES = new Set(["true", "istrue", "ok"]);
const SUBJECTS = new Set(["expect", "Expect", "assertThat", "expectThat"]);
const ASSERTERS = new Set(["assert", "Assert", "require", "Require"]);

/** The tautologies of a file. */
function tautologies(read: Reading): TestViolation[] {
  const found: TestViolation[] = [];
  const { raws } = read;
  for (let index = 0; index < raws.length; index += 1) {
    const raw = raws[index] as Raw;
    if (raw.kind !== "word") continue;
    const name = raw.text;
    const receiver =
      read.word(index - 1) === "." && read.kind(index - 2) === "word" ? read.word(index - 2) : "";
    const normal = name.replaceAll("_", "").toLowerCase();
    if (SUBJECTS.has(name)) {
      // `result.expect("msg")` (Rust) and the like are no subject of an assertion.
      if (read.word(index - 1) === "." && receiver !== "chai") continue;
      const args = read.args(index, false);
      const subject = args?.[0];
      if (args === undefined || args.length !== 1 || subject === undefined) continue;
      const close = subject.to;
      if (read.word(close + 1) !== ".") continue;
      // The first word of the chain that is called is the matcher: `.toBe(`, `to eq(`, `.isTrue(`.
      let matcher: Range[] | undefined;
      let chained = false;
      for (let at = close + 1; at < Math.min(raws.length, close + 16); at += 1) {
        if (read.line(at) > read.line(close) + 1) break;
        if (read.kind(at) === "mark" && read.word(at) === ";") break;
        if (read.kind(at) === "word" && read.word(at + 1) === "(" && read.kind(at + 1) === "mark") {
          matcher = read.args(at, false);
          break;
        }
        chained = chained || read.word(at) === ".";
      }
      if (matcher === undefined && !chained) continue;
      const wanted = matcher ?? [];
      const constant =
        read.literal(subject) && wanted.every((arg) => read.size(arg) === 0 || read.literal(arg));
      const first = wanted[0];
      const same =
        first !== undefined &&
        read.size(subject) > 0 &&
        !read.hasCall(subject) &&
        read.key(subject) === read.key(first);
      if (constant || same) found.push({ row: "tautology", line: raw.line });
      continue;
    }
    const bareName = BARE_TRUTHY_NAMES.has(normal) || BARE_EQUAL_NAMES.has(normal);
    if (bareName && !ASSERTERS.has(receiver)) continue;
    const truthy = TRUTHY_NAMES.has(normal) || BARE_TRUTHY_NAMES.has(normal);
    const equal = EQUAL_NAMES.has(normal) || BARE_EQUAL_NAMES.has(normal);
    if (!truthy && !equal) continue;
    // `assert.equal(…)` is read at `equal`, not here.
    if (read.word(index + 1) === ".") continue;
    // A word that is only the end of a longer path (`obj.assert`) or an assignment is no call.
    const args = read.args(index, true);
    if (args === undefined || args.length === 0) continue;
    if (truthy) {
      const hit =
        args.some(
          (arg) => read.size(arg) === 1 && read.kind(arg.from) === "word" && read.truthy(arg),
        ) ||
        (args.length === 1 && read.truthy(args[0] as Range)) ||
        read.selfCompared(args[0] as Range);
      if (hit) found.push({ row: "tautology", line: raw.line });
      continue;
    }
    const pairs = [args.slice(0, 2), args.slice(-2)];
    const same = pairs.some((pair) => {
      const [left, right] = pair;
      return (
        left !== undefined &&
        right !== undefined &&
        pair.length === 2 &&
        read.size(left) > 0 &&
        !read.hasCall(left) &&
        read.key(left) === read.key(right)
      );
    });
    if (same) found.push({ row: "tautology", line: raw.line });
  }
  return found;
}

/** True when the arguments hold a string that says why (two words at least). */
function reasonInArguments(read: Reading, args: Range[] | undefined): boolean {
  for (const arg of args ?? []) {
    for (let at = arg.from; at < arg.to; at += 1) {
      if (read.kind(at) !== "string") continue;
      const inner = read.val(at).replace(/^["'`]+|["'`]+$/g, "");
      if (inner.length >= 8 && /\s/.test(inner.trim())) return true;
    }
  }
  return false;
}

/** The focused tests of a file. */
function focused(read: Reading, family: Family): TestViolation[] {
  const found: TestViolation[] = [];
  const { raws } = read;
  for (let index = 0; index < raws.length; index += 1) {
    const raw = raws[index] as Raw;
    if (raw.kind !== "word") continue;
    const after = read.word(index + 1);
    const dotted = read.word(index - 1) === ".";
    if (family === "js" && raw.text === "only" && dotted) {
      const owner = read.word(index - 2);
      const next =
        read.kind(index + 1) === "string" || after === "(" || after === "." || after === "";
      if (JS_BLOCKS.has(owner) && next) found.push({ row: "focused", line: raw.line });
    } else if ((family === "js" || family === "ruby") && FOCUS_CALLS.has(raw.text) && !dotted) {
      // `fit("name", …)`, Ruby's `fit "name" do`: the name of a test follows; `fit(model)` is something else.
      const named =
        read.kind(index + 1) === "string" || (after === "(" && read.kind(index + 2) === "string");
      if (named) found.push({ row: "focused", line: raw.line });
    } else if (family === "ruby" && raw.text === "focus") {
      const symbol = read.word(index - 1) === ":" && (raws[index - 1] as Raw).end === raw.start;
      const flag = after === ":" && TRUE_WORDS.has(read.word(index + 2));
      const arrow = after === "=>" && TRUE_WORDS.has(read.word(index + 2));
      if (symbol || flag || arrow) found.push({ row: "focused", line: raw.line });
    } else if (
      family === "dart" &&
      raw.text === "solo" &&
      after === ":" &&
      read.word(index + 2) === "true"
    ) {
      found.push({ row: "focused", line: raw.line });
    }
  }
  return found;
}

/** The disabled tests of a file that give no reason. */
function skipped(read: Reading, family: Family): TestViolation[] {
  const found: TestViolation[] = [];
  const { raws } = read;
  for (let index = 0; index < raws.length; index += 1) {
    const raw = raws[index] as Raw;
    if (raw.kind !== "word") continue;
    const word = raw.text;
    const before = read.word(index - 1);
    const dotted = before === ".";
    const after = read.word(index + 1);
    const owner = dotted ? read.word(index - 2) : "";
    // A site is a place that disables a test. A definition (the name of the test is its first
    // argument) cannot carry a reason in its arguments: a comment alone does.
    let site = false;
    let definition = false;
    let args: Range[] | undefined;
    if ((family === "js" || family === "ruby") && DISABLED_CALLS.has(word) && !dotted) {
      site = after === "(" || read.kind(index + 1) === "string";
      definition = true;
    } else if (family === "js") {
      if ((word === "skip" || word === "fixme") && dotted && JS_BLOCKS.has(owner)) {
        site = after === "(" || after === "." || read.kind(index + 1) === "string";
        args = after === "(" ? read.args(index, false) : undefined;
        // Mocha's `context` is a block; `context.skip("why")` of Vitest skips the running test.
        if (owner === "context" && (args?.length ?? 0) < 2) site = false;
        const first = args?.[0];
        // `test.skip("name", () => …)` defines a disabled test; `test.skip(cond, "why")` skips on a condition.
        definition = first === undefined || read.kind(first.from) === "string";
      }
    } else if (family === "jvm" || family === "cs") {
      const marked = before === "@" || before === "[";
      if (marked && (word === "Disabled" || word === "Ignore")) {
        site = true;
        args = read.args(index, false);
      } else if (family === "jvm" && word === "ignore" && after === "(" && !dotted) {
        site = true;
        definition = true;
      } else if (family === "cs" && word === "Skip" && after === "=") {
        site = read.kind(index + 2) !== "word";
        args = [{ from: index + 2, to: index + 3 }];
      }
    } else if (family === "rust") {
      if (word === "ignore" && before === "[" && read.word(index - 2) === "#") {
        site = true;
        args = [{ from: index + 1, to: Math.min(raws.length, index + 4) }];
      }
    } else if (family === "dart") {
      if (word === "skip" && after === ":" && read.word(index + 2) !== "false") {
        site = true;
        args = [{ from: index + 2, to: index + 3 }];
      }
    } else if (family === "cpp") {
      site = word.startsWith("DISABLED_");
      definition = true;
    } else if (family === "python") {
      if (dotted && PY_SKIPS.has(word) && PY_OWNERS.has(owner)) {
        site = true;
        args = read.args(index, false);
      }
    } else if (family === "go") {
      if (dotted && (word === "Skip" || word === "Skipf" || word === "SkipNow")) {
        site = true;
        args = read.args(index, false);
      }
    } else if (family === "ruby") {
      if ((word === "skip" || word === "pending") && !dotted && raw.first) {
        site = true;
        args = read.args(index, true);
      }
    } else if (family === "php") {
      if (
        word === "markTestSkipped" ||
        word === "markTestIncomplete" ||
        (word === "skip" && before === "->")
      ) {
        site = true;
        args = read.args(index, false);
      }
    } else if (family === "swift") {
      if (word === "XCTSkip" || word === "XCTSkipIf" || word === "XCTSkipUnless") {
        site = true;
        args = read.args(index, false);
      }
    }
    if (!site || read.reasoned(raw.line)) continue;
    if (!definition && reasonInArguments(read, args)) continue;
    found.push({ row: "skipped", line: raw.line });
  }
  return found;
}

const DEFINERS = new Set(["function", "def", "fn", "func", "fun", "sub"]);
const ZERO = /^0+(?:\.0*)?$/;

/** The fixed waits of a file. */
function waits(read: Reading): TestViolation[] {
  const found: TestViolation[] = [];
  const { raws } = read;
  if (raws.some((raw) => raw.kind === "word" && FAKE_CLOCK.has(raw.text))) return found;
  const soleNumber = (index: number) => {
    const sole = read.args(index, false)?.[0];
    return sole !== undefined && read.size(sole) === 1 && read.kind(sole.from) === "number";
  };
  for (let index = 0; index < raws.length; index += 1) {
    const raw = raws[index] as Raw;
    if (raw.kind !== "word") continue;
    const before = read.word(index - 1) === "." ? read.word(index - 2) : "";
    const call = read.word(index + 1) === "(" || read.word(index + 1) === "!";
    let hit = false;
    if (SLEEP_WORDS.has(raw.text)) {
      if (DEFINERS.has(read.word(index - 1))) continue;
      if (call) {
        // A call whose arguments cannot be read (never closed, a budget spent) is no sure wait.
        const args = read.args(index, false);
        const sole = args?.[0];
        hit =
          args !== undefined &&
          !(sole !== undefined && read.size(sole) === 1 && ZERO.test(read.val(sole.from)));
      } else if (
        raw.first &&
        read.kind(index + 1) === "number" &&
        read.line(index + 1) === raw.line
      ) {
        hit = !ZERO.test(read.val(index + 1));
      }
    } else if (raw.text === "wait" && before === "cy") {
      hit = call && soleNumber(index);
    } else if (raw.text === "Delay" && before === "Task") {
      hit = call;
    } else if (raw.text === "pause" && (before === "browser" || before === "driver")) {
      hit = call && soleNumber(index);
    } else if (raw.text === "setTimeout" && call) {
      const [callback, delay] = read.args(index, false) ?? [];
      hit =
        callback !== undefined &&
        delay !== undefined &&
        read.size(callback) === 1 &&
        read.kind(callback.from) === "word" &&
        read.size(delay) === 1 &&
        read.kind(delay.from) === "number" &&
        // `setTimeout(done, 0)` only lets the event loop turn.
        !ZERO.test(read.val(delay.from));
    }
    if (hit && !read.reasoned(raw.line) && !read.inLoop(raw.line))
      found.push({ row: "hard_wait", line: raw.line });
  }
  return found;
}

/** What a reading of a text found, and whether it was cut short (a doubt: the rules saw only part). */
export interface TestReading {
  readonly violations: TestViolation[];
  readonly partial: boolean;
}

/**
 * The places of `text` (what a write adds to the test file `path`) that break a rule of the tests,
 * in order of line. A text too hostile to read within the budget is read in part (`partial`).
 */
export function readTests(path: string, text: string): TestReading {
  const family = familyOf(path);
  const read = new Reading(path, text);
  const violations = [
    ...focused(read, family),
    ...skipped(read, family),
    ...waits(read),
    ...tautologies(read),
  ].sort((a, b) => a.line - b.line);
  return { violations, partial: read.partial };
}

/** The places that break a rule, without the doubt (`readTests`). */
export function testViolations(path: string, text: string): TestViolation[] {
  return readTests(path, text).violations;
}

/** The number of lines of a whole file's text: a final newline does not start another. */
export function lineCount(text: string): number {
  if (text === "") return 0;
  let count = 1;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) count += 1;
  return text.endsWith("\n") ? count - 1 : count;
}
