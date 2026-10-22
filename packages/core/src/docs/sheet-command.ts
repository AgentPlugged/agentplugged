import { ErrorCode, STORY_DOCUMENT_ID_PATTERN } from "@agentplugged/protocol";
import type { CommandContext } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { normalizeText } from "../init/generated.js";
import { validationOf } from "../sprints/sprint-rules.js";
import { readSprintStories } from "../sprints/sprint-stories.js";
import { journalCheckpoints, readDocumentFiles } from "./docs-command.js";
import { parseDocumentFile } from "./parse-document.js";
import { idOfName, storiesOf } from "./story-rules.js";
import { SHEET_MAX_LINES, sourceDocuments, writeSheet } from "./story-sheet.js";

/** One sheet `docs sheet` wrote or found already up to date. */
export interface SheetWritten {
  readonly story: string;
  readonly path: string;
  readonly lines: number;
  readonly excerpts: number;
  /** False when the file already held this text: nothing written. */
  readonly written: boolean;
  /** Over `SHEET_MAX_LINES` lines: the story is too big, to be cut. */
  readonly too_long: boolean;
  /** Citations no document holds: told, never invented. */
  readonly unresolved: readonly string[];
}

/** The answer of `docs sheet`. */
export interface SheetsWritten {
  readonly sheets: readonly SheetWritten[];
  /**
   * The stories the creator had validated whose file changed now: a new `document` checkpoint on
   * each is needed before they start.
   */
  readonly revalidate: readonly string[];
  readonly max_lines: number;
}

function invalid(reason: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", { reason });
}

/**
 * `docs sheet [<story>…]`: writes the section of excerpts of each story named (none: every story
 * not merged yet) from the documents as they stand. Writes only the files whose text changes;
 * never commits, never opens a checkpoint.
 */
export async function writeSheets(
  context: CommandContext,
  given: readonly string[],
): Promise<SheetsWritten | AgentPluggedError> {
  // A story named by its file (`.agentplugged/stories/1-2-sign-in.md`) is that story.
  const words = given.map((word) => (word.endsWith(".md") ? (idOfName(word) ?? word) : word));
  for (const word of words) {
    if (!STORY_DOCUMENT_ID_PATTERN.test(word)) return invalid(`docs sheet ${word}`);
  }
  const { files } = context;
  const current = await readDocumentFiles(files);
  const documents = sourceDocuments(current);
  const stories = storiesOf(
    current
      .filter((file) => file.path.includes("/stories/"))
      .map((file) => parseDocumentFile(file.path, file.text)),
  );
  const unknown = words.filter((word) => !stories.has(word));
  if (unknown.length > 0) return invalid(`docs sheet ${unknown.join(" ")}: no such story`);
  const { checkpoints, merges } = await journalCheckpoints(context);
  const merged = new Set(merges.map((entry) => entry.story));
  const targets =
    words.length > 0 ? [...new Set(words)] : [...stories.keys()].filter((id) => !merged.has(id));
  const now = (context.now ?? Date.now)();
  const validated = validationOf(await readSprintStories(files), checkpoints, now);
  const texts = new Map(current.map((file) => [file.path, file.text]));
  const sheets: SheetWritten[] = [];
  const revalidate: string[] = [];
  for (const id of targets) {
    const story = stories.get(id);
    if (story === undefined) continue;
    const before = texts.get(story.path) ?? "";
    const sheet = writeSheet(story, before, documents);
    // Line ends do not count as a change; a file written with CRLF keeps them.
    const written = sheet.text !== normalizeText(before);
    if (written) {
      const crlf = before.includes("\r\n");
      await files.writeText(story.path, crlf ? sheet.text.replace(/\n/g, "\r\n") : sheet.text);
      if (validated.get(id) === "validated") revalidate.push(id);
    }
    sheets.push({
      story: id,
      path: story.path,
      lines: sheet.lines,
      excerpts: sheet.excerpts,
      written,
      too_long: sheet.lines > SHEET_MAX_LINES,
      unresolved: sheet.unresolved,
    });
  }
  return { sheets, revalidate, max_lines: SHEET_MAX_LINES };
}
