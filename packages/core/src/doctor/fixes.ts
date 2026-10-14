import { hasControlCharacter } from "@agentplugged/protocol";
import type { Ask, CatalogCheck, FixOption, Outcome, Text } from "./catalog.js";
import type { EnvironmentProbe, EnvironmentRun } from "./environment-probe.js";

/**
 * The repairs. A repair is chosen from the catalogue for the machine as it is (the
 * platform, the package manager that is really there, the forge), shown as the exact command, and
 * only run when the creator said yes. Commands are arrays of arguments, never a shell line; what the
 * machine showed (a folder, a version) goes in as an argument only when it holds nothing a shell or
 * a script would read. A point the engine cannot repair, or must not repair by itself, gets short
 * steps to follow, copyable and in order.
 */

/** A sentence in both languages (French falls back on English). */
export interface Localized {
  readonly en: string;
  readonly fr: string;
}

/** A value the creator types before the repair runs. */
export interface PlannedAsk {
  readonly name: string;
  readonly say: Localized;
  readonly default: string;
  readonly type: "text" | "email";
}

/** What can be done about a point. */
export interface PlannedFix {
  /** `run`: the engine runs `commands`; `steps`: the creator follows `steps`. */
  readonly kind: "run" | "steps";
  /** The commands, with `{name}` of the questions still in them. */
  readonly commands: readonly (readonly string[])[];
  /** The commands as shown, one per line, before the answers fill the questions in. */
  readonly display: string;
  /** Needs the creator's terminal (a browser, a password, a typed answer): never run from the chat. */
  readonly interactive: boolean;
  readonly asks: readonly PlannedAsk[];
  /** The answer Enter gives to « repair it? ». */
  readonly recommended: boolean;
  /** Safe for `--yes`: local, reversible, nothing installed. */
  readonly unattended: boolean;
  /** What to do by hand, in order; always present for a point that has steps. */
  readonly steps: { readonly en: readonly string[]; readonly fr: readonly string[] };
  /** What to say once the repair ran, when the catalogue gives it. */
  readonly done?: Localized;
}

const PLACEHOLDER = /\{([a-z][a-z0-9_]*)\}/g;

/** A value of the machine that may be put in a command: no quote, no shell or script character. */
const SAFE_VALUE = /^(?!-)[\p{L}\p{N} _.:\\/()@+~,=-]+$/u;

/** A sentence with the facts put in; a fact the machine did not give is left empty. */
export function fillText(text: Text, facts: Readonly<Record<string, string>>): Localized {
  const fill = (value: string) =>
    value
      .replace(PLACEHOLDER, (_all, key: string) => facts[key] ?? "")
      .replace(/\s+/g, " ")
      .trim();
  return { en: fill(text.en), fr: fill(text.fr ?? text.en) };
}

function fillSteps(
  steps: { readonly en: readonly string[]; readonly fr?: readonly string[] | undefined },
  facts: Readonly<Record<string, string>>,
): { en: string[]; fr: string[] } {
  const fill = (list: readonly string[]) =>
    list.map((step) =>
      step
        .replace(PLACEHOLDER, (_all, key: string) => facts[key] ?? "")
        .replace(/\s+/g, " ")
        .trim(),
    );
  return { en: fill(steps.en), fr: fill(steps.fr ?? steps.en) };
}

/** An argument as the creator reads it in the command shown. */
export function quoteArgument(argument: string): string {
  return /^[A-Za-z0-9_@%+=:,./\\-]+$/.test(argument)
    ? argument
    : `"${argument.replaceAll('"', '\\"')}"`;
}

/** A command as shown. */
export function displayCommand(command: readonly string[]): string {
  return command.map(quoteArgument).join(" ");
}

/**
 * The command with the machine's facts put in; the questions of the creator stay as `{name}`.
 * Undefined when a fact holds something unsafe to hand to a program: the option is then not used.
 */
function fillCommand(
  command: readonly string[],
  facts: Readonly<Record<string, string>>,
  asked: ReadonlySet<string>,
): string[] | undefined {
  const filled: string[] = [];
  for (const argument of command) {
    let unsafe = false;
    const next = argument.replace(PLACEHOLDER, (all, key: string) => {
      if (asked.has(key)) return all;
      const value = facts[key];
      if (value === undefined || !SAFE_VALUE.test(value)) {
        unsafe = true;
        return "";
      }
      return value;
    });
    if (unsafe) return undefined;
    filled.push(next);
  }
  return filled;
}

async function optionHolds(
  option: FixOption,
  probe: EnvironmentProbe,
  facts: Readonly<Record<string, string>>,
): Promise<boolean> {
  const when = option.when;
  if (when === undefined) return true;
  if (when.platform !== undefined && when.platform !== probe.platform) return false;
  if (when.forge !== undefined && when.forge !== facts.forge) return false;
  if (when.manager !== undefined && (await probe.find([when.manager])) === undefined) return false;
  return true;
}

function plannedAsk(ask: Ask, facts: Readonly<Record<string, string>>): PlannedAsk {
  return {
    name: ask.name,
    say: fillText(ask.say, facts),
    default: (ask.default ?? "").replace(PLACEHOLDER, (_all, key: string) => facts[key] ?? ""),
    type: ask.type ?? "text",
  };
}

/** The repair of a point, or undefined when the catalogue gives none for this outcome. */
export async function planFix(
  check: Pick<CatalogCheck, "fix" | "level">,
  outcome: Outcome,
  facts: Readonly<Record<string, string>>,
  probe: EnvironmentProbe,
): Promise<PlannedFix | undefined> {
  const fix = check.fix?.find(
    (entry) => entry.outcomes === undefined || entry.outcomes.includes(outcome),
  );
  if (fix === undefined) return undefined;
  const recommended = fix.recommended ?? check.level === "fail";
  const unattended = fix.unattended === true;
  const steps = fix.steps === undefined ? { en: [], fr: [] } : fillSteps(fix.steps, facts);
  for (const option of fix.options ?? []) {
    if (!(await optionHolds(option, probe, facts))) continue;
    const asked = new Set((option.ask ?? []).map((ask) => ask.name));
    const commands: string[][] = [];
    for (const command of option.commands) {
      const filled = fillCommand(command, facts, asked);
      if (filled === undefined) break;
      commands.push(filled);
    }
    if (commands.length !== option.commands.length) continue;
    // What the creator will type is shown as <name> until they have typed it.
    const shown = commands.map((command) =>
      command.map((argument) =>
        argument.replace(PLACEHOLDER, (all, key: string) => (asked.has(key) ? `<${key}>` : all)),
      ),
    );
    return {
      kind: "run",
      commands,
      display: shown.map(displayCommand).join("\n"),
      interactive: option.interactive === true || (option.ask ?? []).length > 0,
      asks: (option.ask ?? []).map((ask) => plannedAsk(ask, facts)),
      recommended,
      unattended,
      steps,
      ...(fix.done === undefined ? {} : { done: fillText(fix.done, facts) }),
    };
  }
  if (steps.en.length === 0) return undefined;
  return {
    kind: "steps",
    commands: [],
    display: "",
    interactive: false,
    asks: [],
    // Steps are read, not run: nothing to say yes to.
    recommended: false,
    unattended: false,
    steps,
  };
}

/** True when the engine itself can run the repair without anyone at a terminal. */
export function isAutomatic(fix: PlannedFix): boolean {
  return fix.kind === "run" && !fix.interactive;
}

/** An answer is one plain line, at most 100 characters; an email also looks like an address. */
export function answerProblem(ask: PlannedAsk, answer: string): boolean {
  // Never an option for the program that receives it (`-x`, `--config=…`).
  if (
    answer.trim() === "" ||
    answer.length > 100 ||
    answer.trim().startsWith("-") ||
    hasControlCharacter(answer, false)
  ) {
    return true;
  }
  return ask.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(answer.trim());
}

/** The commands with the creator's answers put in. */
export function withAnswers(
  fix: PlannedFix,
  answers: Readonly<Record<string, string>>,
): string[][] {
  return fix.commands.map((command) =>
    command.map((argument) =>
      argument.replace(PLACEHOLDER, (all, key: string) => answers[key]?.trim() ?? all),
    ),
  );
}

/** What a repair did. */
export interface FixRun {
  /** The commands run, as shown. */
  readonly ran: string;
  /** The exit code of the last command run; null when it could not be started or timed out. */
  readonly status: number | null;
  /** The tail of what the last command printed (not in a terminal, where the creator saw it). */
  readonly output: string;
  readonly missing: boolean;
  readonly timedOut: boolean;
}

/** Longest time one repair command may take (an installer included). */
export const FIX_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_TAIL = 600;

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= OUTPUT_TAIL ? trimmed : `…${trimmed.slice(-OUTPUT_TAIL)}`;
}

/**
 * Runs the commands of a repair, in order, until one fails. In a terminal the creator sees the
 * programs work and answers their questions; otherwise the output is captured (and its tail kept).
 */
export async function runFix(
  probe: EnvironmentProbe,
  commands: readonly (readonly string[])[],
  mode: "terminal" | "captured",
): Promise<FixRun> {
  let last: EnvironmentRun = { status: 0, stdout: "", stderr: "" };
  for (const command of commands) {
    if (mode === "terminal") {
      const result = await probe.runInTerminal(command);
      last = {
        status: result.status,
        stdout: "",
        stderr: "",
        ...(result.missing === true ? { missing: true } : {}),
      };
    } else {
      last = await probe.run(command, { timeoutMs: FIX_TIMEOUT_MS });
    }
    if (last.status !== 0) break;
  }
  return {
    ran: commands.map(displayCommand).join("\n"),
    status: last.status,
    output: tail(`${last.stdout}\n${last.stderr}`),
    missing: last.missing === true,
    timedOut: last.timedOut === true,
  };
}
