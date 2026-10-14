import type { ConflictHunk } from "./merge-probe.js";

/**
 * The blocks of a file Git left in conflict, read from its markers in the `diff3`
 * style: `<<<<<<<` the main branch's lines, `|||||||` the base's, `=======`, the story's lines,
 * `>>>>>>>`. Without a base section (`merge` style) the base is empty. Pure: the markers' size is
 * the default seven characters. `ok` is false when the markers are not balanced or hold no block:
 * the file is then `structural` for the engine, which reads nothing more of it.
 */
export function parseConflictMarkers(text: string): { ok: boolean; hunks: ConflictHunk[] } {
  const lines = text.split(/\r?\n/);
  const hunks: ConflictHunk[] = [];
  let part: "outside" | "main" | "base" | "story" = "outside";
  let main: string[] = [];
  let base: string[] = [];
  let story: string[] = [];
  for (const line of lines) {
    if (part === "outside") {
      if (/^<{7}(?: |$)/.test(line)) {
        part = "main";
        main = [];
        base = [];
        story = [];
      } else if (/^(?:\|{7}|>{7})(?: |$)/.test(line)) {
        return { ok: false, hunks };
      }
      continue;
    }
    if (/^<{7}(?: |$)/.test(line)) return { ok: false, hunks };
    if (/^\|{7}(?: |$)/.test(line)) {
      if (part !== "main") return { ok: false, hunks };
      part = "base";
      continue;
    }
    if (/^={7}$/.test(line)) {
      if (part === "story") return { ok: false, hunks };
      part = "story";
      continue;
    }
    if (/^>{7}(?: |$)/.test(line)) {
      if (part !== "story") return { ok: false, hunks };
      hunks.push({ main, base, story });
      part = "outside";
      continue;
    }
    if (part === "main") main.push(line);
    else if (part === "base") base.push(line);
    else story.push(line);
  }
  return { ok: part === "outside" && hunks.length > 0, hunks };
}

/**
 * True when the text holds a line that opens or closes a conflict marker (`<<<<<<<` or
 * `>>>>>>>` at the start of a line): a failed merge or rebase left it. `=======` alone is not
 * looked for (a Markdown title underline looks the same).
 */
export function hasConflictMarkers(text: string): boolean {
  return /^(?:<{7}|>{7})(?: |$)/m.test(text);
}
