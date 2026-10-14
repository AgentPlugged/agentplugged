import type { BranchMerge, ConflictFileProbe, ConflictProbe, MergeProbe } from "@agentplugged/core";
import { parseConflictMarkers } from "@agentplugged/core";
import type { GitFolderOptions, GitRunner } from "./git-docs-base.js";
import { COMMIT_ID, runGit } from "./git-process.js";

/** Longest a read may take. */
const TIMEOUT_MS = 60_000;

/** Most conflicted files and blocks of a file the probe keeps (the engine reads one more). */
const MAX_FILES = 101;
const MAX_HUNKS = 11;

export type GitMergeProbeOptions = GitFolderOptions;

/**
 * What a merge would conflict on, read through Git: `git merge-tree --write-tree`
 * merges the main branch's commit and the story's head in memory, in the `diff3` style, and the
 * blocks in conflict are read from the markers of the tree it writes. It touches no reference and
 * no working folder (Git only adds unreferenced objects, which it collects later), whatever the
 * user's Git settings say. Anything Git cannot answer (too old, a commit it does not hold) is
 * `unavailable`: the engine then trusts nothing it cannot read.
 */
export class GitMergeProbe implements MergeProbe {
  readonly #cwd: string;
  readonly #run: GitRunner;

  constructor(options: GitMergeProbeOptions) {
    this.#cwd = options.cwd;
    this.#run = options.run ?? runGit;
  }

  async #git(args: readonly string[], input?: string) {
    return this.#run(this.#cwd, args, input, { LC_ALL: "C" }, TIMEOUT_MS).catch(() => undefined);
  }

  async resolve(ref: string): Promise<string | undefined> {
    if (!/^[\w./-]+$/.test(ref) || ref.startsWith("-")) return undefined;
    const run = await this.#git([
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${ref}^{commit}`,
    ]);
    const commit = run?.status === 0 ? run.stdout.toString("utf8").trim() : "";
    return COMMIT_ID.test(commit) ? commit : undefined;
  }

  async probe(main: string, head: string): Promise<ConflictProbe> {
    if (!COMMIT_ID.test(main) || !COMMIT_ID.test(head)) return { status: "unavailable" };
    const run = await this.#git([
      "-c",
      "merge.conflictStyle=diff3",
      "-c",
      "core.quotePath=off",
      "merge-tree",
      "--write-tree",
      "--name-only",
      "--no-messages",
      "-z",
      main,
      head,
    ]);
    if (run === undefined || (run.status !== 0 && run.status !== 1))
      return { status: "unavailable" };
    const fields = run.stdout.toString("utf8").split("\0");
    const tree = fields[0] ?? "";
    if (!COMMIT_ID.test(tree)) return { status: "unavailable" };
    if (run.status === 0) return { status: "clean", main };
    const names = [...new Set(fields.slice(1).filter((name) => name !== ""))];
    const files: ConflictFileProbe[] = [];
    for (const path of names.slice(0, MAX_FILES)) {
      files.push(await this.#conflictedFile(tree, path));
    }
    return { status: "conflict", main, files, files_truncated: names.length > MAX_FILES };
  }

  async #conflictedFile(tree: string, path: string): Promise<ConflictFileProbe> {
    const structural: ConflictFileProbe = {
      path,
      structural: true,
      hunks: [],
      hunks_truncated: false,
    };
    const blob = await this.#git(["cat-file", "blob", `${tree}:${path}`]);
    if (blob === undefined || blob.status !== 0 || blob.stdout.includes(0)) return structural;
    const parsed = parseConflictMarkers(blob.stdout.toString("utf8"));
    if (!parsed.ok) return structural;
    return {
      path,
      structural: false,
      hunks: parsed.hunks.slice(0, MAX_HUNKS),
      hunks_truncated: parsed.hunks.length > MAX_HUNKS,
    };
  }

  async show(commit: string, path: string): Promise<string | undefined> {
    if (!COMMIT_ID.test(commit) || path.startsWith("-")) return undefined;
    const run = await this.#git(["cat-file", "blob", `${commit}:${path}`]);
    if (run === undefined || run.status !== 0 || run.stdout.includes(0)) return undefined;
    return run.stdout.toString("utf8");
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean | undefined> {
    if (!COMMIT_ID.test(ancestor) || !COMMIT_ID.test(descendant)) return undefined;
    const run = await this.#git(["merge-base", "--is-ancestor", ancestor, descendant]);
    if (run?.status === 0) return true;
    return run?.status === 1 ? false : undefined;
  }

  async mergedTree(main: string, own: string): Promise<string | undefined> {
    if (!COMMIT_ID.test(main) || !COMMIT_ID.test(own)) return undefined;
    const run = await this.#git(["merge-tree", "--write-tree", "--no-messages", main, own]);
    if (run === undefined || run.status !== 0) return undefined;
    const tree = run.stdout.toString("utf8").trim().split("\n")[0] ?? "";
    return COMMIT_ID.test(tree) ? tree : undefined;
  }

  async treeOf(commit: string): Promise<string | undefined> {
    if (!COMMIT_ID.test(commit)) return undefined;
    const run = await this.#git(["rev-parse", "--verify", "--quiet", `${commit}^{tree}`]);
    const tree = run?.status === 0 ? run.stdout.toString("utf8").trim() : "";
    return COMMIT_ID.test(tree) ? tree : undefined;
  }

  /**
   * A commit whose committer is GitHub itself (`noreply@github.com`: the web editor, "resolve
   * conflicts", "update branch") or another identity than this repository's own e-mail (a merge made
   * on another machine or on a forge that signs as the user): made elsewhere than here.
   */
  async madeOnForge(commit: string): Promise<boolean | undefined> {
    if (!COMMIT_ID.test(commit)) return undefined;
    const committer = await this.#git(["log", "-1", "--format=%ce", commit]);
    if (committer === undefined || committer.status !== 0) return undefined;
    const email = committer.stdout.toString("utf8").trim().toLowerCase();
    if (email === "") return undefined;
    if (email === "noreply@github.com") return true;
    const own = await this.#git(["config", "user.email"]);
    const mine = own?.status === 0 ? own.stdout.toString("utf8").trim().toLowerCase() : "";
    return mine === "" ? undefined : email !== mine;
  }

  async merges(base: string, head: string): Promise<readonly BranchMerge[] | undefined> {
    if (!COMMIT_ID.test(base) || !COMMIT_ID.test(head)) return undefined;
    // The branch's own line only (`--first-parent`): the merge commits of the main branch it took
    // in are not its own merges.
    const run = await this.#git([
      "rev-list",
      "--first-parent",
      "--merges",
      "--parents",
      "--reverse",
      `${base}..${head}`,
    ]);
    if (run === undefined || run.status !== 0) return undefined;
    const found: BranchMerge[] = [];
    for (const line of run.stdout.toString("utf8").split("\n")) {
      const [commit, ...parents] = line.trim().split(" ");
      if (commit === undefined || !COMMIT_ID.test(commit)) continue;
      if (!parents.every((parent) => COMMIT_ID.test(parent))) return undefined;
      found.push({ commit, parents });
    }
    return found;
  }
}
