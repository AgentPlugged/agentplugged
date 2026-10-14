import { AgentPluggedError } from "@agentplugged/core";
import { ErrorCode } from "@agentplugged/protocol";
import { confirm, isCancel, multiselect, select } from "@clack/prompts";

/**
 * The menus of the terminal: arrows to move, space to tick, Enter to validate, Escape
 * to go back one question (Ctrl+C leaves, before anything is written). They are drawn by
 * `@clack/prompts` in a real terminal only; everywhere else (a script, a pipe, the tests) the
 * numbered questions of `prompt.ts` stay, with the same defaults, so one Enter per question still
 * gives a correct installation.
 */

/** One choice of a menu: what it is, and a sentence that says what it changes. */
export interface MenuOption {
  readonly label: string;
  readonly hint?: string;
}

/** What the creator asked for with Escape: the question before this one. */
export class GoBack extends Error {
  constructor() {
    super("go back");
    this.name = "GoBack";
  }
}

export interface Menu {
  /** One choice; the index chosen. */
  select(message: string, options: readonly MenuOption[], initial: number): Promise<number>;
  /** Several choices, at least one; the indexes chosen. */
  multiselect(
    message: string,
    options: readonly MenuOption[],
    initial: readonly number[],
  ): Promise<number[]>;
  /** Yes or no (the keys y and n answer at once). */
  confirm(message: string, initial: boolean): Promise<boolean>;
}

/** A terminal that draws menus: both ends are terminals able to read single keys. */
export function canDrawMenus(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream | undefined,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const tty = input as NodeJS.ReadStream;
  const out = output as NodeJS.WriteStream | undefined;
  return (
    tty.isTTY === true &&
    typeof tty.setRawMode === "function" &&
    out?.isTTY === true &&
    env.TERM !== "dumb" &&
    env.AGENTPLUGGED_MENUS !== "off"
  );
}

/**
 * Menus on `input` and `output`. The line reader of the questions is set aside while a menu runs
 * (it would take the keys for lines), and the terminal is given back as it was.
 */
export function createMenu(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Menu {
  const tty = input as NodeJS.ReadStream;
  const streams = { input: tty, output: output as NodeJS.WriteStream };
  // The listeners of the line reader, seen before the first menu draws anything: only those are set
  // aside (the menus add and remove their own key decoder, which must be left alone).
  let lineReader: Array<(chunk: Buffer | string) => void> | undefined;

  const run = async <T>(draw: () => Promise<T | symbol>): Promise<T> => {
    const wasRaw = tty.isRaw === true;
    const wasPaused = tty.isPaused();
    lineReader ??= tty.listeners("data") as Array<(chunk: Buffer | string) => void>;
    const others = lineReader.filter((listener) => tty.listeners("data").includes(listener));
    // Escape alone (the arrows arrive as longer sequences) asks for the question before.
    let back = false;
    const watch = (chunk: Buffer | string) => {
      if (String(chunk) === "\u001b") back = true;
    };
    for (const listener of others) tty.off("data", listener);
    tty.on("data", watch);
    let result: T | symbol;
    try {
      result = await draw();
    } finally {
      tty.off("data", watch);
      tty.setRawMode(wasRaw);
      for (const listener of others) tty.on("data", listener);
      if (wasPaused) tty.pause();
      else tty.resume();
    }
    if (isCancel(result)) {
      if (back) throw new GoBack();
      throw new AgentPluggedError(ErrorCode.CANCELLED, "error.cancelled");
    }
    return result as T;
  };

  const options = (list: readonly MenuOption[]) =>
    list.map((option, index) => ({
      value: index,
      label: option.label,
      ...(option.hint === undefined ? {} : { hint: option.hint }),
    }));

  return {
    select: (message, list, initial) =>
      run<number>(() =>
        select<number>({
          ...streams,
          message,
          options: options(list),
          initialValue: initial,
          withGuide: false,
        }),
      ),
    multiselect: (message, list, initial) =>
      run<number[]>(() =>
        multiselect<number>({
          ...streams,
          message,
          options: options(list),
          initialValues: [...initial],
          required: true,
          withGuide: false,
        }),
      ),
    confirm: (message, initial) =>
      run<boolean>(() => confirm({ ...streams, message, initialValue: initial, withGuide: false })),
  };
}
