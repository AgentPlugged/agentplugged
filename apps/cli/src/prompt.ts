import { createInterface } from "node:readline/promises";
import { AgentPluggedError } from "@agentplugged/core";
import type { Translate } from "@agentplugged/i18n";
import { ErrorCode } from "@agentplugged/protocol";
import type { Menu, MenuOption } from "./menu.js";

/** Plain-text questions: one line per answer, no colors, no cursor tricks. */
export interface Prompter {
  /** Writes the question, then returns the next line, or undefined at the end of the input. */
  ask(question: string): Promise<string | undefined>;
  /** Writes a line that is not a question (list of choices, error). */
  say(text: string): void;
  /**
   * Waits `ms` milliseconds, or less when the creator presses `key` (in a terminal, the key alone;
   * otherwise a line holding it) or Ctrl+C: true when cancelled so.
   */
  waitCancel(ms: number, key: string): Promise<boolean>;
  /**
   * Writes the question, then returns the next line without echoing it in a terminal (a
   * passphrase), or undefined at the end of the input or on Ctrl+C. Outside a terminal (tests), a
   * line read as `ask` does.
   */
  askSecret(question: string): Promise<string | undefined>;
  /**
   * The menus of a real terminal: arrows, space, Enter. Absent elsewhere, where the
   * numbered questions stay.
   */
  readonly menu?: Menu;
  close(): void;
}

/**
 * The keys of a secret typed in a raw terminal, character by character: escape sequences (arrows,
 * function keys: CSI `ESC [ … final`, SS3 `ESC O x`, Alt+key `ESC x`) are dropped whole, even split
 * across chunks; a bracketed paste (`ESC [200~ … ESC [201~`) gives its text (line breaks dropped);
 * Backspace erases; Ctrl+C or Ctrl+D cancels; Enter ends, what follows it being handed back.
 */
export class SecretReader {
  #value = "";
  #state: "text" | "escape" | "csi" | "ss3" = "text";
  #params = "";
  #paste = false;

  /** Reads a chunk: undefined while the secret goes on, else its value (undefined: cancelled). */
  feed(chunk: string): { value: string | undefined; rest: string } | undefined {
    const chars = [...chunk];
    for (let i = 0; i < chars.length; i++) {
      const char = chars[i] as string;
      if (this.#state === "escape") {
        this.#state = char === "[" ? "csi" : char === "O" ? "ss3" : "text";
        this.#params = "";
        continue;
      }
      if (this.#state === "ss3") {
        this.#state = "text";
        continue;
      }
      if (this.#state === "csi") {
        const code = char.codePointAt(0) ?? 0;
        if (code >= 0x40 && code <= 0x7e) {
          if (char === "~" && this.#params === "200") this.#paste = true;
          if (char === "~" && this.#params === "201") this.#paste = false;
          this.#state = "text";
        } else this.#params += char;
        continue;
      }
      if (char === "\u001b") {
        this.#state = "escape";
        continue;
      }
      if (this.#paste) {
        if (char !== "\r" && char !== "\n" && char >= " ") this.#value += char;
        continue;
      }
      if (char === "\r" || char === "\n") {
        // A CR LF pair is one Enter.
        const next = char === "\r" && chars[i + 1] === "\n" ? i + 2 : i + 1;
        return { value: this.#value, rest: chars.slice(next).join("") };
      }
      if (char === "\u0003" || char === "\u0004") return { value: undefined, rest: "" };
      if (char === "\u007f" || char === "\b") this.#value = [...this.#value].slice(0, -1).join("");
      else if (char >= " ") this.#value += char;
    }
    return undefined;
  }
}

export function createPrompter(
  input: NodeJS.ReadableStream,
  write: (text: string) => void,
  menu?: Menu,
): Prompter {
  const readline = createInterface({ input, terminal: false });
  // The iterator buffers lines that arrive before the question is asked.
  const lines = readline[Symbol.asyncIterator]();
  let ended = false;
  // The next line asked for and not consumed yet (a wait that ended before it came).
  let pending: Promise<IteratorResult<string>> | undefined;
  const nextLine = () => {
    pending ??= lines.next();
    return pending;
  };
  const tty = input as NodeJS.ReadStream;
  const ask = async (question: string): Promise<string | undefined> => {
    write(question);
    if (ended) return undefined;
    const next = await nextLine();
    pending = undefined;
    if (next.done) {
      ended = true;
      write("\n");
      return undefined;
    }
    return next.value;
  };
  return {
    ask,
    ...(menu === undefined ? {} : { menu }),
    async askSecret(question) {
      if (tty.isTTY !== true || typeof tty.setRawMode !== "function") return ask(question);
      // A terminal: the keys are read in raw mode and never echoed; the readline interface does
      // not see them (its listeners are set aside), and the terminal's mode is restored.
      write(question);
      const wasRaw = tty.isRaw === true;
      const wasPaused = tty.isPaused();
      const others = tty.listeners("data") as Array<(chunk: Buffer | string) => void>;
      return new Promise<string | undefined>((done) => {
        const secret = new SecretReader();
        let finished = false;
        const finish = (result: string | undefined, rest = "") => {
          if (finished) return;
          finished = true;
          tty.off("data", onData);
          tty.off("end", onEnd);
          tty.off("close", onEnd);
          tty.setRawMode(wasRaw);
          for (const listener of others) tty.on("data", listener);
          // What followed Enter in the same chunk belongs to the next question.
          if (rest !== "") tty.unshift(Buffer.from(rest, "utf8"));
          if (wasPaused) tty.pause();
          write("\n");
          done(result);
        };
        const onData = (chunk: Buffer | string) => {
          const outcome = secret.feed(String(chunk));
          if (outcome !== undefined) finish(outcome.value, outcome.rest);
        };
        const onEnd = () => finish(undefined);
        for (const listener of others) tty.off("data", listener);
        tty.setRawMode(true);
        tty.on("data", onData);
        tty.once("end", onEnd);
        tty.once("close", onEnd);
        tty.resume();
      });
    },
    say(text) {
      write(`${text}\n`);
    },
    async waitCancel(ms, key) {
      if (tty.isTTY === true && typeof tty.setRawMode === "function") {
        // A terminal: the key alone cancels, without Enter. The readline interface does not see
        // the keys of the window (its listeners are set aside), and the terminal's mode and
        // flow are restored afterwards. Only a chunk that is exactly the key (either case) or
        // Ctrl+C cancels: arrows, other keys or pasted text never do.
        const cancels = new Set([key.toLowerCase(), key.toUpperCase(), "\u0003"]);
        const wasRaw = tty.isRaw === true;
        const wasPaused = tty.isPaused();
        const others = tty.listeners("data") as Array<(chunk: Buffer | string) => void>;
        return new Promise<boolean>((done) => {
          const finish = (cancelled: boolean) => {
            clearTimeout(timer);
            tty.off("data", onData);
            tty.setRawMode(wasRaw);
            for (const listener of others) tty.on("data", listener);
            if (wasPaused) tty.pause();
            done(cancelled);
          };
          const onData = (chunk: Buffer | string) => {
            if (cancels.has(String(chunk))) finish(true);
          };
          const timer = setTimeout(() => finish(false), ms);
          for (const listener of others) tty.off("data", listener);
          tty.setRawMode(true);
          tty.on("data", onData);
          tty.resume();
        });
      }
      const deadline = Date.now() + ms;
      for (;;) {
        const left = deadline - Date.now();
        if (left <= 0) return false;
        // The end of the input cancels nothing: the window runs to its end.
        if (ended) {
          await new Promise((done) => setTimeout(done, left));
          return false;
        }
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<"timeout">((done) => {
          timer = setTimeout(() => done("timeout"), left);
        });
        const next = await Promise.race([nextLine(), timeout]);
        clearTimeout(timer);
        if (next === "timeout") return false;
        pending = undefined;
        if (next.done) {
          ended = true;
          continue;
        }
        if (next.value.trim().toLowerCase() === key) return true;
      }
    },
    close() {
      readline.close();
    },
  };
}

/** `1-3,5` for [1, 2, 3, 5]. */
export function formatSelection(numbers: readonly number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && (sorted[j + 1] ?? 0) === (sorted[j] ?? 0) + 1) j++;
    parts.push(j > i ? `${sorted[i]}-${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return parts.join(",");
}

/** Numbers between 1 and `max` from `1,3-5` (commas or spaces); undefined when invalid or empty. */
export function parseSelection(answer: string, max: number): number[] | undefined {
  const tokens = answer.split(/[\s,;]+/).filter((token) => token !== "");
  if (tokens.length === 0) return undefined;
  const result = new Set<number>();
  for (const token of tokens) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(token);
    if (!match) return undefined;
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (from < 1 || to > max || from > to) return undefined;
    for (let n = from; n <= to; n++) result.add(n);
  }
  return [...result].sort((a, b) => a - b);
}

/**
 * Asks until the answer is valid; Enter accepts the default. The end of the input (Ctrl+D)
 * cancels the whole interview: `CANCELLED` is thrown, before anything is written.
 */
async function askUntilValid<T>(
  t: Translate,
  prompter: Prompter,
  question: string,
  fallback: T,
  parse: (answer: string) => T | undefined,
): Promise<T> {
  for (;;) {
    const answer = await prompter.ask(question);
    if (answer === undefined) {
      throw new AgentPluggedError(ErrorCode.CANCELLED, "error.cancelled");
    }
    if (answer.trim() === "") return fallback;
    const value = parse(answer.trim());
    if (value !== undefined) return value;
    prompter.say(t("profile.prompt.invalid", { answer: answer.trim() }));
  }
}

/** One choice among numbered options; returns its index (from 0). */
export function askChoice(
  t: Translate,
  prompter: Prompter,
  question: (fallback: string) => string,
  count: number,
  fallback: number,
): Promise<number> {
  return askUntilValid(t, prompter, question(String(fallback + 1)), fallback, (answer) => {
    const choice = parseSelection(answer, count);
    return choice?.length === 1 && choice[0] !== undefined ? choice[0] - 1 : undefined;
  });
}

/** Several numbered options; returns their indexes (from 0), at least one. */
export function askSelection(
  t: Translate,
  prompter: Prompter,
  question: (fallback: string) => string,
  count: number,
  fallback: readonly number[],
): Promise<number[]> {
  const shown = formatSelection(fallback.map((index) => index + 1));
  return askUntilValid(t, prompter, question(shown), [...fallback], (answer) =>
    parseSelection(answer, count)?.map((n) => n - 1),
  );
}

/** A whole number between `min` and `max`. */
export function askNumber(
  t: Translate,
  prompter: Prompter,
  question: (fallback: string) => string,
  min: number,
  max: number,
  fallback: number,
): Promise<number> {
  return askUntilValid(t, prompter, question(String(fallback)), fallback, (answer) => {
    if (!/^\d+$/.test(answer)) return undefined;
    const value = Number(answer);
    return value >= min && value <= max ? value : undefined;
  });
}

const YES = new Set(["y", "yes", "o", "oui"]);
const NO = new Set(["n", "no", "non"]);

/** A question without the « (O/n) » it ends with: a menu shows the choices itself. */
function plainQuestion(question: string): string {
  return question.replace(/\s*\([OoYyNn]\/[OoYyNn]\)\s*:?\s*$/, "").trim();
}

/** Yes or no; the default is no, unless `fallback` says otherwise. */
export function askYesNo(
  t: Translate,
  prompter: Prompter,
  question: string,
  fallback = false,
): Promise<boolean> {
  if (prompter.menu !== undefined) return prompter.menu.confirm(plainQuestion(question), fallback);
  return askUntilValid(t, prompter, question, fallback, (answer) => {
    const word = answer.toLowerCase();
    return YES.has(word) ? true : NO.has(word) ? false : undefined;
  });
}

/**
 * Free text. Enter gives `fallback` when there is one; otherwise a required answer is asked
 * again, and an optional one returns undefined. `check` returns why an answer is refused (shown,
 * then the question is asked again). The end of the input cancels, like every other question.
 */
export async function askText(
  t: Translate,
  prompter: Prompter,
  question: string,
  options: {
    readonly required: boolean;
    readonly fallback?: string;
    readonly check?: (answer: string) => string | undefined;
  },
): Promise<string | undefined> {
  for (;;) {
    const answer = await prompter.ask(question);
    if (answer === undefined) {
      throw new AgentPluggedError(ErrorCode.CANCELLED, "error.cancelled");
    }
    const trimmed = answer.trim() === "" ? options.fallback : answer.trim();
    if (trimmed === undefined) {
      if (!options.required) return undefined;
      prompter.say(t("agent.prompt.required"));
      continue;
    }
    const refused = options.check?.(trimmed);
    if (refused === undefined) return trimmed;
    prompter.say(refused);
  }
}

/** `  1. label — hint` per line, the way every numbered question shows its choices. */
export function numberedOptions(options: readonly MenuOption[]): string {
  const width = String(options.length).length;
  return options
    .map(
      (option, i) =>
        `  ${String(i + 1).padStart(width)}. ${option.label}${option.hint === undefined ? "" : ` — ${option.hint}`}`,
    )
    .join("\n");
}

/**
 * A titled choice among options: a menu in a terminal (arrows, Enter), else the title, the numbered
 * list and the question, `fallback` (from 0) being what Enter gives in both.
 */
export async function chooseOne(
  t: Translate,
  prompter: Prompter,
  spec: {
    readonly title: string;
    readonly options: readonly MenuOption[];
    readonly question: (fallback: string) => string;
    readonly fallback: number;
  },
): Promise<number> {
  if (prompter.menu !== undefined) {
    return prompter.menu.select(spec.title, spec.options, spec.fallback);
  }
  prompter.say(spec.title);
  prompter.say(numberedOptions(spec.options));
  return askChoice(t, prompter, spec.question, spec.options.length, spec.fallback);
}

/**
 * One of `values` (the modes of a setting), as a titled choice: Enter gives `current`, else
 * `fallback`, which is also what a wrong answer gives.
 */
export async function chooseValue<T>(
  t: Translate,
  prompter: Prompter,
  spec: {
    readonly title: string;
    readonly values: readonly T[];
    readonly option: (value: T) => MenuOption;
    readonly question: (fallback: string) => string;
    readonly current: T | undefined;
    readonly fallback: T;
  },
): Promise<T> {
  const index = await chooseOne(t, prompter, {
    title: spec.title,
    options: spec.values.map(spec.option),
    question: spec.question,
    fallback: spec.values.indexOf(spec.current ?? spec.fallback),
  });
  return spec.values[index] ?? spec.fallback;
}

/** Like `chooseOne` for several choices, at least one: space ticks in a menu, `1,3-5` in a question. */
export async function chooseMany(
  t: Translate,
  prompter: Prompter,
  spec: {
    readonly title: string;
    readonly options: readonly MenuOption[];
    readonly question: (fallback: string) => string;
    readonly fallback: readonly number[];
  },
): Promise<number[]> {
  if (prompter.menu !== undefined) {
    return prompter.menu.multiselect(spec.title, spec.options, spec.fallback);
  }
  prompter.say(spec.title);
  prompter.say(numberedOptions(spec.options));
  return askSelection(t, prompter, spec.question, spec.options.length, spec.fallback);
}
