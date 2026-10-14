import { MAX_MERGED_FILES, RepositoryPathSchema } from "@agentplugged/protocol";
import type { CommandContext } from "../command.js";
import { parseDiff } from "../review/review-rules.js";

/**
 * The files a story changed, relative to the repository: both sides of a renamed file, each once,
 * in the diff's order, at most `MAX_MERGED_FILES` (`truncated` beyond); none when Git cannot read
 * the diff here.
 */
export function changedFiles(diff: string | undefined): { files: string[]; truncated: boolean } {
  if (diff === undefined) return { files: [], truncated: false };
  const seen = new Set<string>();
  for (const file of parseDiff(diff)) {
    for (const path of [file.old_path, file.path]) {
      if (path !== null && RepositoryPathSchema.safeParse(path).success) seen.add(path);
    }
  }
  const all = [...seen];
  return { files: all.slice(0, MAX_MERGED_FILES), truncated: all.length > MAX_MERGED_FILES };
}

/** The files a story changed, and whether Git could read them here at all. */
export interface StoryFiles {
  readonly files: string[];
  readonly truncated: boolean;
  /** False when no diff could be read (no port, no repository, an unknown commit). */
  readonly known: boolean;
  /** The diff read, for what else is counted from it (the weight of the code). */
  readonly diff?: string;
}

/**
 * The files a story changed: from its merge base with the main branch's tip; when that diff is
 * empty (the main branch already holds the story: merged and pulled), from the commit it started
 * from.
 */
export async function storyFiles(
  context: CommandContext,
  started: { readonly base: string; readonly base_ref: string },
  commit: string,
): Promise<StoryFiles> {
  const source = context.storyDiff;
  if (source === undefined) return { files: [], truncated: false, known: false };
  const read = async (ref?: string) => {
    const diff = await source.diff(started.base, commit, ref).catch(() => undefined);
    // A path the journal cannot hold makes the files unknown: every other story is then careful.
    const invalid =
      diff !== undefined &&
      parseDiff(diff).some((file) =>
        [file.old_path, file.path].some(
          (path) => path !== null && !RepositoryPathSchema.safeParse(path).success,
        ),
      );
    return {
      ...changedFiles(diff),
      known: diff !== undefined && !invalid,
      ...(diff === undefined ? {} : { diff }),
    };
  };
  const first = await read(started.base_ref);
  return first.files.length > 0 || !first.known ? first : await read();
}

/**
 * The files whose added lines open or close a conflict marker (`<<<<<<<`, `>>>>>>>`): a failed
 * merge or rebase left them in the story's changes.
 */
export function addedMarkerFiles(diff: string | undefined): string[] {
  return filesAddingLine(diff, (line) => /^(?:<{7}|>{7})(?: |$)/.test(line));
}

/** The files that say things in words, not in code: a mention of the marker there is no probe. */
const WORDS_FILE = /\.(?:md|mdx|markdown|txt|rst|adoc)$/i;
/** The marker as a probe carries it: in a comment (`//`, `/*`, `#`, `--`, `;`, `%`, `<!--`). */
const PROBE = /(?:\/\/|\/\*|#|--|;|%|<!--)\s*agentplugged:debug/;

/** What temporary diagnostic code carries on its line: a comment that names it. */
export const INSTRUMENTATION_MARKER = "agentplugged:debug";

/**
 * The files whose added lines carry the marker of temporary diagnostic code in a comment: a log or
 * a probe written to find a bug's cause and not taken out before the review. A file of
 * words (documentation) that talks about the marker is no probe.
 */
export function instrumentedFiles(diff: string | undefined): string[] {
  return filesAddingLine(
    diff,
    (line) => PROBE.test(line),
    (path) => !WORDS_FILE.test(path),
  );
}

/** The files with at least one added line the test accepts, in the order of the diff. */
function filesAddingLine(
  diff: string | undefined,
  accepts: (line: string) => boolean,
  readsFile: (path: string) => boolean = () => true,
): string[] {
  if (diff === undefined) return [];
  const found = new Set<string>();
  for (const file of parseDiffLines(diff)) {
    if (file.path !== "" && readsFile(file.path) && file.added.some(accepts)) found.add(file.path);
  }
  return [...found];
}

function parseDiffLines(diff: string): { path: string; added: string[] }[] {
  const files: { path: string; added: string[] }[] = [];
  let current: { path: string; added: string[] } | undefined;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = { path: /^diff --git a\/.+? b\/(.+)$/.exec(line)?.[1] ?? "", added: [] };
      files.push(current);
      inHunk = false;
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk && line.startsWith("+++ ")) {
      const path = line
        .slice(4)
        .replace(/^"?b\//, "")
        .replace(/"$/, "");
      if (path !== "/dev/null") current.path = path;
      continue;
    }
    if (inHunk && line.startsWith("+") && !line.startsWith("+++ "))
      current.added.push(line.slice(1));
  }
  return files;
}
