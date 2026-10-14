import { secretIgnorePatterns } from "./permissions.js";

/**
 * Cursor's `.cursorignore`: the files the agent may not reach, in the editor and in the
 * CLI, one `.gitignore` pattern per line. The file is the creator's: `sync` keeps its own lines in
 * one marked block (the secrets the permission rules never let an agent read, `.env` and its kin) and
 * touches nothing else. A negation line of the creator's, after the block, lifts a pattern.
 */

const CURSOR_IGNORE_BEGIN = "# >>> agentplugged (generated: secrets agents never read) >>>";
const CURSOR_IGNORE_END = "# <<< agentplugged <<<";

/** The block, without a line break at its end. */
export function cursorIgnoreBlock(eol = "\n"): string {
  return [CURSOR_IGNORE_BEGIN, ...secretIgnorePatterns(), CURSOR_IGNORE_END].join(eol);
}

/** The line break the text uses (a file the creator wrote on Windows keeps its own). */
const eolOf = (text: string) => (text.includes("\r\n") ? "\r\n" : "\n");

/** Where the block sits in a text: the start of its first line and the end of its last, or undefined. */
function blockRange(text: string): { start: number; end: number } | undefined {
  const start = text.indexOf(CURSOR_IGNORE_BEGIN);
  if (start === -1) return undefined;
  const close = text.indexOf(CURSOR_IGNORE_END, start);
  if (close === -1) return undefined;
  return { start, end: close + CURSOR_IGNORE_END.length };
}

/**
 * The creator's `.cursorignore` with our block in it: added at the end when absent, replaced in place
 * when there (so that a block an older engine wrote follows the current patterns). A begin marker
 * with no end marker is the creator's text, left alone: the block is added after it.
 */
export function withCursorIgnoreBlock(current: string | undefined): string {
  if (current === undefined || current.trim() === "") return `${cursorIgnoreBlock()}\n`;
  const eol = eolOf(current);
  const range = blockRange(current);
  if (range !== undefined) {
    return `${current.slice(0, range.start)}${cursorIgnoreBlock(eol)}${current.slice(range.end)}`;
  }
  const separator = current.endsWith("\n") ? eol : `${eol}${eol}`;
  return `${current}${separator}${cursorIgnoreBlock(eol)}${eol}`;
}

/**
 * The creator's `.cursorignore` without our block, or undefined when nothing of the creator's is
 * left (the file is then ours alone and goes). A text without the block is returned as it is.
 */
export function withoutCursorIgnoreBlock(current: string): string | undefined {
  const range = blockRange(current);
  if (range === undefined) return current;
  const before = current.slice(0, range.start).replace(/(?:\r?\n)+$/, "");
  const after = current
    .slice(range.end)
    .replace(/^(?:\r?\n)+/, "")
    .replace(/(?:\r?\n)+$/, "");
  const eol = eolOf(current);
  const rest = [before, after].filter((part) => part.trim() !== "").join(eol);
  return rest.trim() === "" ? undefined : `${rest}${eol}`;
}
