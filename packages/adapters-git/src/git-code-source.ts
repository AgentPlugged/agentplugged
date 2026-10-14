import type { CodeSource, SourceFile } from "@agentplugged/core";
import type { GitFolderOptions, GitRunner } from "./git-docs-base.js";
import { COMMIT_ID, runGit, treeFiles } from "./git-process.js";

/** Longest each Git command may take: a review does not wait for a huge repository. */
const TIMEOUT_MS = 20_000;

/** The text read at most (bytes): beyond, the repository is too big to compare in a review. */
const MAX_TOTAL_BYTES = 80_000_000;

export type GitCodeSourceOptions = GitFolderOptions;

/**
 * The source files of a repository at a commit, through Git alone: one
 * `git ls-tree -r` for the names and sizes of the tracked files, then one `git cat-file --batch`
 * for the texts of those the caller accepts. Nothing is checked out and the working folder is not
 * read: the files are those of the commit, whatever the folder holds. Undefined when Git cannot
 * read it (no repository, unknown commit).
 */
export class GitCodeSource implements CodeSource {
  readonly #cwd: string;
  readonly #run: GitRunner;

  constructor(options: GitCodeSourceOptions) {
    this.#cwd = options.cwd;
    this.#run = options.run ?? runGit;
  }

  async read(
    commit: string,
    accept: (path: string, bytes: number) => boolean,
    first: ReadonlySet<string> = new Set(),
  ): Promise<readonly SourceFile[] | undefined> {
    if (!COMMIT_ID.test(commit)) return undefined;
    const listed = await this.#run(
      this.#cwd,
      ["-c", "core.quotePath=off", "ls-tree", "-r", "-z", "--long", commit],
      undefined,
      { LC_ALL: "C" },
      TIMEOUT_MS,
    ).catch(() => undefined);
    if (listed === undefined || listed.status !== 0) return undefined;
    const candidates = treeFiles(listed.stdout).filter(
      ({ path, bytes }) => Number.isFinite(bytes) && accept(path, bytes),
    );
    // The files the change touched come first: the size limit never leaves them out.
    candidates.sort((x, y) => Number(first.has(y.path)) - Number(first.has(x.path)));
    const wanted: { oid: string; path: string }[] = [];
    let total = 0;
    for (const { oid, path, bytes } of candidates) {
      if (total + bytes > MAX_TOTAL_BYTES) continue;
      total += bytes;
      wanted.push({ oid, path });
    }
    if (wanted.length === 0) return [];
    const blobs = await this.#run(
      this.#cwd,
      ["cat-file", "--batch"],
      `${wanted.map((entry) => entry.oid).join("\n")}\n`,
      { LC_ALL: "C" },
      TIMEOUT_MS,
    ).catch(() => undefined);
    if (blobs === undefined || blobs.status !== 0) return undefined;
    return parseBatch(blobs.stdout, wanted);
  }
}

/** The texts of `git cat-file --batch`: `<oid> <type> <size>\n<content>\n`, in the order asked. */
export function parseBatch(
  output: Buffer,
  wanted: readonly { oid: string; path: string }[],
): SourceFile[] {
  const files: SourceFile[] = [];
  let offset = 0;
  for (const entry of wanted) {
    const end = output.indexOf(0x0a, offset);
    if (end === -1) break;
    const header = output.toString("utf8", offset, end).split(" ");
    offset = end + 1;
    if (header[1] === "missing") continue;
    const size = Number(header[2]);
    if (!Number.isInteger(size) || offset + size > output.length) break;
    files.push({
      path: entry.path,
      text: output.toString("utf8", offset, offset + size),
    });
    offset += size + 1;
  }
  return files;
}
