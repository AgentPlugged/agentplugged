import { maskSecrets } from "../doctor/support-report.js";
import type { ProofRunResult } from "./proof-runner.js";

/**
 * What the engine keeps of a command's output: the whole kept output, masked, in a
 * local file outside the journal; a few useful lines for the agent when the command failed; one
 * short line for the journal. Everything passes through the masking of secrets first.
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape sequences of a terminal are the point.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** Control characters other than the line feed and the tab, which an output never needs. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: that is what is removed.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** The text of an output made safe to keep: no escape sequence, no control character, carriage returns folded. */
export function cleanOutput(text: string): string {
  return text
    .replace(ANSI, "")
    .split("\n")
    .map((line) => line.replace(/\r+$/, "").split("\r").pop() ?? "")
    .join("\n")
    .replace(CONTROL, " ");
}

/** The kept output as one text: the middle dropped says how much, a cut word is not kept. */
export function wholeOutput(result: Pick<ProofRunResult, "head" | "tail" | "omitted">): string {
  if (result.omitted <= 0) return result.head + result.tail;
  // A word cut by the dropped part could keep the start of a secret the masking would not know.
  const head = result.head.replace(/\S*$/, "");
  const tail = result.tail.replace(/^\S*/, "");
  return `${head}\n[... ${result.omitted} bytes of output not kept ...]\n${tail}`;
}

/** The output, cleaned and masked: the only form that is written or sent anywhere. */
export function safeOutput(result: Pick<ProofRunResult, "head" | "tail" | "omitted">): string {
  return maskSecrets(cleanOutput(wholeOutput(result)));
}

/** Lines that say something failed, in the output of most tools and languages. */
const FAILURE_LINE =
  /(?:\b(?:fail(?:ed|ure|ures|ing|s)?|error|errors|exception|assert(?:ion)?(?:error)?|panic|traceback|not ok|timed out|timeout|expected|denied|unhandled|fatal|segmentation|cannot|can't)\b|[✗✖×]|\bFAIL\b)/i;

/** The most useful lines kept for the agent, and the most characters one may have. */
export const MAX_USEFUL_LINES = 12;
export const MAX_USEFUL_LINE_LENGTH = 160;
const MAX_USEFUL_CHARACTERS = 1200;

function shortLine(line: string): string {
  const flat = line.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_USEFUL_LINE_LENGTH
    ? flat
    : `${flat.slice(0, MAX_USEFUL_LINE_LENGTH - 1)}…`;
}

/**
 * The lines of a failed run that matter, from the cleaned, masked output: those that say something
 * failed (the first ones, where the cause is, then the last), or the last lines when none does.
 * At most 12 lines of 160 characters and 1 200 characters in all.
 */
export function usefulLines(output: string): string[] {
  const lines = output
    .split("\n")
    .map(shortLine)
    .filter((line) => line !== "");
  const failing = lines.filter((line) => FAILURE_LINE.test(line));
  const picked =
    failing.length === 0
      ? lines.slice(-8)
      : failing.length <= MAX_USEFUL_LINES
        ? failing
        : [...failing.slice(0, MAX_USEFUL_LINES - 4), ...failing.slice(-4)];
  const kept: string[] = [];
  let size = 0;
  for (const line of picked) {
    if (size + line.length > MAX_USEFUL_CHARACTERS) break;
    kept.push(line);
    size += line.length + 1;
  }
  return [...new Set(kept)];
}

/** The last line of an output, shortened: what a passing run says last (a count, "ok"). */
export function lastLine(output: string): string {
  const lines = output
    .split("\n")
    .map(shortLine)
    .filter((line) => line !== "");
  return lines.at(-1) ?? "";
}

/**
 * The number that follows `prefix` on the last line of the output that holds it (`p95_ms=` then
 * `182.5`), or undefined. A plain search, not a pattern: the project's text never becomes an
 * expression.
 */
export function measuredAfter(output: string, prefix: string): number | undefined {
  let found: number | undefined;
  for (const line of output.split("\n")) {
    const at = line.lastIndexOf(prefix);
    if (at < 0) continue;
    const match = /^\s*[:=]?\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/.exec(
      line.slice(at + prefix.length),
    );
    if (match?.[1] !== undefined) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) found = value;
    }
  }
  return found;
}
