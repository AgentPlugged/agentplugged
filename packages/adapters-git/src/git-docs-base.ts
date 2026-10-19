import type { DocsBase, DocsBaseRead, DocumentFile } from "@agentplugged/core";
import { type GitRun, runGit } from "./git-process.js";

/** Longest a Git command of a base read may take before the read fails. */
const TIMEOUT_MS = 60_000;

/** Runs one `git` command (`runGit` by default; tests give another). */
export type GitRunner = (
  cwd: string,
  args: readonly string[],
  input?: string,
  env?: Readonly<Record<string, string>>,
  timeoutMs?: number,
  maxBytes?: number,
) => Promise<GitRun>;

/** What an adapter needs to run Git in a folder: the folder, and a runner (tests give theirs). */
export interface GitFolderOptions {
  readonly cwd: string;
  readonly run?: GitRunner;
}

export type GitDocsBaseOptions = GitFolderOptions;

function failure(args: readonly string[], run: Pick<GitRun, "status" | "stderr">): Error {
  return new Error(`git ${args.join(" ")}: ${run.stderr || `exited (${run.status})`}`);
}

/**
 * Reads the Markdown documents of a base version for `docs check`: `rev-parse` resolves the
 * reference, `ls-tree` lists the files of the folders at that commit, and one `cat-file --batch`
 * reads the `.md` ones. Symbolic links are skipped, as in the working copy. Paths are relative to
 * `cwd`, like the workspace's. Nothing is written. Any Git failure other than "not a repository",
 * "no commit" or "unknown reference" (a timeout, a repository Git refuses to use…) throws.
 */
export class GitDocsBase implements DocsBase {
  readonly #cwd: string;
  readonly #run: GitRunner;

  constructor(options: GitDocsBaseOptions) {
    this.#cwd = options.cwd;
    this.#run = options.run ?? runGit;
  }

  async #git(args: readonly string[], input?: string): Promise<GitRun> {
    const run = await this.#run(this.#cwd, args, input, { LC_ALL: "C" }, TIMEOUT_MS);
    if (run.timedOut === true) throw failure(args, run);
    return run;
  }

  async read(ref: string, dirs: readonly string[]): Promise<DocsBaseRead> {
    const prefixArgs = ["rev-parse", "--show-prefix"];
    let prefix: GitRun;
    try {
      prefix = await this.#git(prefixArgs);
    } catch (error) {
      // Git is not installed: there is no base to read.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { found: false, reason: "no_repository" };
      }
      throw error;
    }
    if (prefix.status !== 0) {
      if (/not a git repository/i.test(prefix.stderr)) {
        return { found: false, reason: "no_repository" };
      }
      throw failure(prefixArgs, prefix);
    }
    const resolved = await this.#git(["rev-parse", "-q", "--verify", `${ref}^{commit}`]);
    if (resolved.status !== 0) {
      // HEAD unresolved: this branch has no commit yet. Another reference: unknown, unless the
      // repository has no reference at all.
      if (ref === "HEAD") return { found: false, reason: "no_commit" };
      const refsArgs = ["for-each-ref", "--count=1", "--format=%(refname)"];
      const refs = await this.#git(refsArgs);
      if (refs.status !== 0) throw failure(refsArgs, refs);
      const any = refs.stdout.toString("utf8").trim() !== "";
      return { found: false, reason: any ? "unknown_ref" : "no_commit" };
    }
    const commit = resolved.stdout.toString("utf8").trim();
    // The folders are given relative to `cwd`; Git prints full paths, made relative again here.
    const top = prefix.stdout.toString("utf8").trim();
    const listArgs = ["ls-tree", "-r", "-z", "--full-name", commit, "--", ...dirs];
    const listed = await this.#git(listArgs);
    if (listed.status !== 0) throw failure(listArgs, listed);
    const entries: { path: string; oid: string }[] = [];
    for (const record of listed.stdout.toString("utf8").split("\0")) {
      // `<mode> SP <type> SP <oid> TAB <path>`: blobs only (no submodule), never a symbolic link.
      const match = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(record);
      if (match?.[2] !== "blob" || match[1] === "120000") continue;
      const full = match[4] ?? "";
      if (!full.startsWith(top) || full.includes("\n")) continue;
      if (!full.toLowerCase().endsWith(".md")) continue;
      entries.push({ path: full.slice(top.length), oid: match[3] ?? "" });
    }
    if (entries.length === 0) return { found: true, commit, files: [] };
    const catArgs = ["cat-file", "--batch"];
    const read = await this.#git(catArgs, entries.map((entry) => `${entry.oid}\n`).join(""));
    if (read.status !== 0) throw failure(catArgs, read);
    const files: DocumentFile[] = [];
    let offset = 0;
    const out = read.stdout;
    for (const entry of entries) {
      const end = out.indexOf(10, offset);
      const header = end === -1 ? "" : out.subarray(offset, end).toString("utf8");
      const size = Number(/^[0-9a-f]+ blob (\d+)$/.exec(header)?.[1]);
      if (!Number.isInteger(size)) throw failure(catArgs, { ...read, stderr: header });
      const start = end + 1;
      files.push({ path: entry.path, text: out.subarray(start, start + size).toString("utf8") });
      offset = start + size + 1;
    }
    return { found: true, commit, files };
  }

  /**
   * Reads Git blobs by id with one `cat-file --batch`. An id Git does not hold (or
   * that names no blob) is left out; outside a repository, or without Git, the map is empty.
   */
  async readBlobs(ids: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const blobs = new Map<string, string>();
    const wanted = ids.filter((id) => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(id));
    if (wanted.length === 0) return blobs;
    const catArgs = ["cat-file", "--batch"];
    let read: GitRun;
    try {
      read = await this.#git(catArgs, wanted.map((id) => `${id}\n`).join(""));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return blobs;
      throw error;
    }
    if (read.status !== 0) {
      if (/not a git repository/i.test(read.stderr)) return blobs;
      throw failure(catArgs, read);
    }
    const out = read.stdout;
    let offset = 0;
    for (const id of wanted) {
      const end = out.indexOf(10, offset);
      if (end === -1) throw failure(catArgs, { ...read, stderr: "truncated output" });
      const header = out.subarray(offset, end).toString("utf8");
      offset = end + 1;
      // `<oid> <type> <size>` then the content and a newline, or `<id> missing`.
      const match = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
      if (match === null) continue;
      const size = Number(match[2]);
      if (match[1] === "blob") {
        blobs.set(id, out.subarray(offset, offset + size).toString("utf8"));
      }
      offset += size + 1;
    }
    return blobs;
  }

  /**
   * The blobs, among `ids`, that the history of `HEAD` ever held, at any path:
   * `git log -1 --find-object=<id> HEAD` names a commit that added or removed it. Outside a
   * repository, without Git or without a commit, none.
   */
  async blobsInHistory(ids: readonly string[]): Promise<ReadonlySet<string>> {
    const held = new Set<string>();
    for (const id of new Set(ids)) {
      if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(id)) continue;
      const args = ["log", "-1", "--format=%H", `--find-object=${id}`, "HEAD", "--"];
      let run: GitRun;
      try {
        run = await this.#git(args);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return held;
        throw error;
      }
      if (run.status !== 0) {
        // Not a repository, or `HEAD` names no commit yet: no history holds anything.
        if (
          /not a git repository|unknown revision|bad revision|does not have any commits/i.test(
            run.stderr,
          )
        ) {
          return held;
        }
        throw failure(args, run);
      }
      if (run.stdout.toString("utf8").trim() !== "") held.add(id);
    }
    return held;
  }
}
