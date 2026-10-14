import type { MainBranchRead, MainBranchReader } from "@agentplugged/core";
import type { GitRunner } from "./git-docs-base.js";
import { type GitRun, runGit } from "./git-process.js";

/** Longest one Git command of the read may take. */
const CALL_TIMEOUT_MS = 15_000;
/** Longest the whole read may take: `sync` then falls back on the working copy. */
const TOTAL_TIMEOUT_MS = 30_000;

/** No repository here. */
const NO_REPOSITORY = /not a git repository/i;
/** Git refuses to use the folder as a repository: treated like no repository, and said. */
const REFUSED = /not a work ?tree|dubious ownership|must be run in a work tree/i;

export interface GitMainBranchReaderOptions {
  readonly cwd: string;
  readonly run?: GitRunner;
  /** The clock (milliseconds), for the total time limit. */
  readonly now?: () => number;
}

function failure(args: readonly string[], run: Pick<GitRun, "status" | "stderr">): Error {
  return new Error(`git ${args.join(" ")}: ${run.stderr || `exited (${run.status})`}`);
}

const REMOTE = "refs/remotes/origin/";

/**
 * Reads a file of the main branch for `sync` and `rules`. The remote-tracking branch is
 * preferred: the remote's default branch (`refs/remotes/origin/HEAD`), else `origin/main`, else
 * `origin/master`. Except when the local branch of the same name has commits the
 * remote one lacks and none the other way round (its history simply goes on from the remote's):
 * the settings the creator recorded there (`method.yaml`, the points they keep, the level) apply
 * at once, without waiting for a push the agents cannot do, and the read says how many commits
 * are not published (`unpublished`). A local branch that diverged, or is behind, never counts: the
 * remote one is read and the difference reported (`local`). The local `main`, then `master`, are
 * read alone when no remote-tracking one exists. Nothing is written,
 * nothing is fetched: the read never reaches the network. Each Git call has 15 s, the whole read
 * 30 s. "Not a repository" (Git missing, dubious ownership…) is `no_repository`; any other
 * failure throws.
 */
export class GitMainBranchReader implements MainBranchReader {
  readonly #cwd: string;
  readonly #run: GitRunner;
  readonly #now: () => number;

  constructor(options: GitMainBranchReaderOptions) {
    this.#cwd = options.cwd;
    this.#run = options.run ?? runGit;
    this.#now = options.now ?? Date.now;
  }

  async #git(deadline: number, args: readonly string[]): Promise<GitRun> {
    const left = deadline - this.#now();
    if (left <= 0) throw new Error(`git: the main branch could not be read within 30 s`);
    const timeout = Math.min(CALL_TIMEOUT_MS, left);
    const run = await this.#run(this.#cwd, args, undefined, { LC_ALL: "C" }, timeout);
    if (run.timedOut === true) throw failure(args, run);
    return run;
  }

  /** The commit a reference names, or undefined. */
  async #commit(deadline: number, ref: string): Promise<string | undefined> {
    const run = await this.#git(deadline, ["rev-parse", "-q", "--verify", `${ref}^{commit}`]);
    return run.status === 0 ? run.stdout.toString("utf8").trim() : undefined;
  }

  /** The remote-tracking candidates, in order: `[reference, local name]`. */
  async #remoteCandidates(deadline: number): Promise<Array<readonly [string, string]>> {
    const candidates: Array<readonly [string, string]> = [];
    const head = await this.#git(deadline, ["symbolic-ref", "-q", `${REMOTE}HEAD`]);
    const target = head.status === 0 ? head.stdout.toString("utf8").trim() : "";
    if (target.startsWith(REMOTE)) candidates.push([target, target.slice(REMOTE.length)]);
    for (const name of ["main", "master"]) candidates.push([`${REMOTE}${name}`, name]);
    return candidates;
  }

  async read(path: string): Promise<MainBranchRead> {
    const deadline = this.#now() + TOTAL_TIMEOUT_MS;
    const prefixArgs = ["rev-parse", "--show-prefix"];
    let prefix: GitRun;
    try {
      prefix = await this.#git(deadline, prefixArgs);
    } catch (error) {
      // Git is not installed: there is no branch to read.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { found: false, reason: "no_repository" };
      }
      throw error;
    }
    if (prefix.status !== 0) {
      if (REFUSED.test(prefix.stderr)) {
        const refused = prefix.stderr.split(/\r?\n/).find((line) => REFUSED.test(line)) ?? "";
        return { found: false, reason: "no_repository", refused: refused.trim() };
      }
      if (NO_REPOSITORY.test(prefix.stderr)) return { found: false, reason: "no_repository" };
      throw failure(prefixArgs, prefix);
    }
    // `path` is relative to `cwd`; with `--full-tree`, Git wants it from the top of the
    // repository, taken literally (no pathspec magic).
    const full = `${prefix.stdout.toString("utf8").trim()}${path}`;

    for (const [ref, name] of await this.#remoteCandidates(deadline)) {
      const commit = await this.#commit(deadline, ref);
      if (commit === undefined) continue;
      const local = await this.#localDifference(deadline, name, commit);
      if (local !== undefined && local.ahead > 0 && local.behind === 0) {
        return {
          found: true,
          branch: name,
          text: await this.#file(deadline, local.commit, full),
          unpublished: { remote: `origin/${name}`, ahead: local.ahead },
        };
      }
      const text = await this.#file(deadline, commit, full);
      return {
        found: true,
        branch: `origin/${name}`,
        text,
        ...(local === undefined
          ? {}
          : { local: { branch: local.branch, ahead: local.ahead, behind: local.behind } }),
      };
    }
    for (const name of ["main", "master"]) {
      const commit = await this.#commit(deadline, `refs/heads/${name}`);
      if (commit === undefined) continue;
      return { found: true, branch: name, text: await this.#file(deadline, commit, full) };
    }
    const current = await this.#git(deadline, ["symbolic-ref", "-q", "--short", "HEAD"]);
    const currentName = current.status === 0 ? current.stdout.toString("utf8").trim() : "";
    return currentName === ""
      ? { found: false, reason: "no_main_branch" }
      : { found: false, reason: "no_main_branch", current: currentName };
  }

  /** The file at `full` (from the top of the repository) in `commit`; undefined when absent. */
  async #file(deadline: number, commit: string, full: string): Promise<string | undefined> {
    const listArgs = ["--literal-pathspecs", "ls-tree", "-z", "--full-tree", commit, "--", full];
    const listed = await this.#git(deadline, listArgs);
    if (listed.status !== 0) throw failure(listArgs, listed);
    const match = /^(\d+) blob ([0-9a-f]+)\t/.exec(listed.stdout.toString("utf8"));
    // A symbolic link is never followed, like a missing file.
    if (match === null || match[1] === "120000") return undefined;
    const catArgs = ["cat-file", "blob", match[2] ?? ""];
    const blob = await this.#git(deadline, catArgs);
    if (blob.status !== 0) throw failure(catArgs, blob);
    return blob.stdout.toString("utf8");
  }

  /** How the local branch `name` differs from the remote-tracking `commit`, if it does. */
  async #localDifference(
    deadline: number,
    name: string,
    commit: string,
  ): Promise<{ branch: string; ahead: number; behind: number; commit: string } | undefined> {
    const local = await this.#commit(deadline, `refs/heads/${name}`);
    if (local === undefined || local === commit) return undefined;
    const countArgs = ["rev-list", "--left-right", "--count", `${local}...${commit}`];
    const counted = await this.#git(deadline, countArgs);
    if (counted.status !== 0) throw failure(countArgs, counted);
    const [ahead, behind] = counted.stdout.toString("utf8").trim().split(/\s+/).map(Number);
    return { branch: name, ahead: ahead ?? 0, behind: behind ?? 0, commit: local };
  }
}
