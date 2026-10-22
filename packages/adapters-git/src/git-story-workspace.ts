import { existsSync, realpathSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  AgentPluggedError,
  type BranchEnsured,
  type BranchMergeOutcome,
  type BranchMergeRequest,
  CHAINED_HOOK_NAME,
  COMMIT_CHECK_PATH,
  COMMIT_HOOK_NAME,
  COMMIT_SKIPS_PATH,
  COMMIT_STORIES_DIR,
  type CommitHookFiles,
  type CommitHookInstall,
  type FilesCommitOutcome,
  type FilesCommitRequest,
  isPersonalLayerFile,
  type PathsCommitRequest,
  SKILL_OVERRIDES_DIR,
  type StoryFileOnBranch,
  type StoryWorkspace,
  type StoryWorkspaceCreation,
  type StoryWorkspaceInspection,
  type StoryWorkspaceTarget,
  type WorkflowDetection,
  type WorktreeRemoval,
} from "@agentplugged/core";
import { ErrorCode } from "@agentplugged/protocol";
import type { GitRunner } from "./git-docs-base.js";
import { type GitRun, lastLine, runGit, treeFiles } from "./git-process.js";

/** Longest one Git command may take (a worktree's checkout included). */
const CALL_TIMEOUT_MS = 120_000;

/** Longest the fetch of a story branch may take: the engine goes on without it. */
const FETCH_TIMEOUT_MS = 20_000;

/** How long a read of the remote branch is remembered. */
const REMOTE_READ_TTL_MS = 10_000;

export interface GitStoryWorkspaceOptions {
  /** The workspace root: the folder that holds `.agentplugged/`. */
  readonly cwd: string;
  readonly run?: GitRunner;
  /** The operating system (`process.platform`): paths compare without case on Windows. */
  readonly platform?: string;
}

const REMOTE = "refs/remotes/origin/";

/** The stories' folder, from the workspace root. */
const STORIES_DIR = ".agentplugged/stories";

/** Git refuses the folder, or there is no repository: no workspace to prepare. */
const NO_REPOSITORY =
  /not a git repository|not a work ?tree|dubious ownership|must be run in a work tree/i;

function gitFailure(args: readonly string[], run: Pick<GitRun, "status" | "stderr">): Error {
  return new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
    reason: `git ${args.join(" ")}: ${run.stderr || `exited (${run.status})`}`,
  });
}

/** A branch's name as the engine creates and reads it: no option, no revision syntax. */
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** One worktree of `git worktree list --porcelain`. */
interface ListedWorktree {
  readonly path: string;
  readonly branch: string | null;
  /** Git knows it, but its folder is gone (deleted by hand): treated as absent. */
  readonly stale: boolean;
}

/**
 * The Git side of `story start` and `start_story`: reads what the repository holds
 * for a story, creates its branch and its worktree next to the main repository
 * (`<parent>/<name>.worktrees/<id>`), and installs the commit hook in the hooks folder shared by
 * every worktree. Never pushes, and fetches only the story branch into its remote-tracking reference (`remoteHead`); removes only what a start created and could not
 * record (`discard`). Paths Git prints relative to the folder are resolved here, so no
 * `--path-format` is needed (Git before 2.31).
 */
export class GitStoryWorkspace implements StoryWorkspace {
  readonly #cwd: string;
  readonly #run: GitRunner;
  readonly #windows: boolean;

  constructor(options: GitStoryWorkspaceOptions) {
    this.#cwd = options.cwd;
    this.#run = options.run ?? runGit;
    this.#windows = (options.platform ?? process.platform) === "win32";
  }

  async #git(args: readonly string[]): Promise<GitRun> {
    const run = await this.#run(this.#cwd, args, undefined, { LC_ALL: "C" }, CALL_TIMEOUT_MS);
    if (run.timedOut === true) throw gitFailure(args, run);
    return run;
  }

  async #ok(args: readonly string[]): Promise<string> {
    const run = await this.#git(args);
    if (run.status !== 0) throw gitFailure(args, run);
    return run.stdout.toString("utf8").trim();
  }

  /** A path Git printed, resolved from the workspace folder. */
  async #path(args: readonly string[]): Promise<string> {
    return resolve(this.#cwd, await this.#ok(args));
  }

  /** The commit a reference names, or undefined. */
  async #commit(ref: string): Promise<string | undefined> {
    const run = await this.#git(["rev-parse", "-q", "--verify", `${ref}^{commit}`]);
    return run.status === 0 ? run.stdout.toString("utf8").trim() : undefined;
  }

  /** The blob at `path` (from the repository's top) in `commit`, or null. */
  async #blobAt(commit: string, path: string): Promise<string | null> {
    const object = `${commit}:${path}`;
    const type = await this.#git(["cat-file", "-t", object]);
    if (type.status !== 0 || type.stdout.toString("utf8").trim() !== "blob") return null;
    return this.#ok(["rev-parse", object]);
  }

  /** Two paths name the same folder (without case on Windows). */
  #same(a: string, b: string): boolean {
    const left = resolve(a);
    const right = resolve(b);
    return this.#windows ? left.toLowerCase() === right.toLowerCase() : left === right;
  }

  async #worktrees(): Promise<ListedWorktree[]> {
    const text = await this.#ok(["worktree", "list", "--porcelain"]);
    const listed: ListedWorktree[] = [];
    for (const block of text.split(/\r?\n\r?\n/)) {
      let path: string | undefined;
      let branch: string | null = null;
      let prunable = false;
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
        else if (line.startsWith("branch ")) branch = line.slice("branch ".length);
        else if (line.startsWith("prunable")) prunable = true;
      }
      if (path === undefined) continue;
      const absolute = resolve(path);
      listed.push({ path: absolute, branch, stale: prunable || !existsSync(absolute) });
    }
    return listed;
  }

  /** The worktree holding the branch, its folder still there. */
  #holder(worktrees: readonly ListedWorktree[], branch: string): ListedWorktree | undefined {
    const ref = `refs/heads/${branch}`;
    return worktrees.find((worktree) => worktree.branch === ref && !worktree.stale);
  }

  /**
   * The main branch: the remote's default one, `main`, `master`; local first, else remote. With
   * `base` (the creator's integration branch), that branch alone: local first, else
   * remote, null when neither exists.
   */
  async #main(base?: string): Promise<{ ref: string; commit: string } | null> {
    const names: string[] = [];
    if (base !== undefined) {
      names.push(base);
    } else {
      const head = await this.#git(["symbolic-ref", "-q", `${REMOTE}HEAD`]);
      const target = head.status === 0 ? head.stdout.toString("utf8").trim() : "";
      if (target.startsWith(REMOTE)) names.push(target.slice(REMOTE.length));
      for (const name of ["main", "master"]) if (!names.includes(name)) names.push(name);
    }
    for (const name of names) {
      const local = await this.#commit(`refs/heads/${name}`);
      if (local !== undefined) return { ref: name, commit: local };
      const remote = await this.#commit(`${REMOTE}${name}`);
      if (remote !== undefined) return { ref: `origin/${name}`, commit: remote };
    }
    return null;
  }

  /** The remote the branches follow: `origin`, else the only one. */
  async #remote(): Promise<string | undefined> {
    const run = await this.#run(this.#cwd, ["remote"], undefined, { LC_ALL: "C" }, 10_000);
    if (run.status !== 0) return undefined;
    const names = run.stdout
      .toString("utf8")
      .split("\n")
      .map((name) => name.trim())
      .filter((name) => name !== "");
    return names.includes("origin") ? "origin" : names.length === 1 ? names[0] : undefined;
  }

  /** Recent reads of a remote branch, by branch: the commit (or none) and when. */
  readonly #remoteReads = new Map<
    string,
    { at: number; local: string; head: string | undefined }
  >();

  async remoteHead(
    branch: string,
    local: string,
    options: { readonly fresh?: boolean } = {},
  ): Promise<string | undefined> {
    try {
      const recent = this.#remoteReads.get(branch);
      if (
        options.fresh !== true &&
        recent !== undefined &&
        recent.local === local &&
        Date.now() - recent.at < REMOTE_READ_TTL_MS
      ) {
        return recent.head;
      }
      const remote = await this.#remote();
      if (remote === undefined || branch.startsWith("-")) return undefined;
      const tracking = `refs/remotes/${remote}/${branch}`;
      const fetched = await this.#run(
        this.#cwd,
        ["fetch", "--quiet", "--no-tags", remote, `+refs/heads/${branch}:${tracking}`],
        undefined,
        { LC_ALL: "C" },
        FETCH_TIMEOUT_MS,
      );
      let head: string | undefined;
      if (fetched.status === 0) {
        const found = await this.#commit(tracking);
        if (found !== undefined && found !== local) {
          const ancestor = await this.#git(["merge-base", "--is-ancestor", local, found]);
          if (ancestor.status === 0) head = found;
        }
      }
      this.#remoteReads.set(branch, { at: Date.now(), local, head });
      return head;
    } catch {
      return undefined;
    }
  }

  /** The expected worktree folder, from the main worktree (the first one Git lists). */
  #targetOf(main: string, id: string): { path: string; relative: string } {
    const name = `${basename(main)}.worktrees`;
    return { path: join(dirname(main), name, id), relative: `../${name}/${id}` };
  }

  async inspect(
    target: StoryWorkspaceTarget,
    options: { readonly base?: string } = {},
  ): Promise<StoryWorkspaceInspection> {
    const bare = await this.#bareCheck();
    if (bare === undefined) return { repository: false };
    if (bare.status !== 0) {
      if (NO_REPOSITORY.test(bare.stderr)) return { repository: false };
      throw gitFailure(["rev-parse", "--is-bare-repository"], bare);
    }
    if (bare.stdout.toString("utf8").trim() === "true") {
      return { repository: false, unsupported: "bare" };
    }
    const prefixRun = await this.#git(["rev-parse", "--show-prefix"]);
    if (prefixRun.status !== 0) {
      if (NO_REPOSITORY.test(prefixRun.stderr)) return { repository: false, unsupported: "bare" };
      throw gitFailure(["rev-parse", "--show-prefix"], prefixRun);
    }
    // The workspace folder (the one holding `.agentplugged/`) inside the repository.
    const prefix = prefixRun.stdout.toString("utf8").trim();
    const worktrees = await this.#worktrees();
    const mainWorktree = worktrees[0]?.path ?? (await this.#path(["rev-parse", "--show-toplevel"]));
    if (dirname(mainWorktree) === mainWorktree) return { repository: false, unsupported: "root" };
    const where = this.#targetOf(mainWorktree, target.id);
    const main = await this.#main(options.base);
    const storyPath = `${prefix}${target.path}`;
    const storyBlob = main === null ? null : await this.#blobAt(main.commit, storyPath);
    const branchCommit = await this.#commit(`refs/heads/${target.branch}`);
    let branch: { commit: string; merged: boolean; storyBlob: string | null } | null = null;
    if (branchCommit !== undefined) {
      const merged =
        main !== null &&
        (await this.#git(["merge-base", "--is-ancestor", branchCommit, main.commit])).status === 0;
      branch = {
        commit: branchCommit,
        merged,
        storyBlob: await this.#blobAt(branchCommit, storyPath),
      };
    }
    const holder = this.#holder(worktrees, target.branch);
    return {
      repository: true,
      prefix,
      root: prefix === "" ? mainWorktree : join(mainWorktree, ...prefix.split("/").filter(Boolean)),
      current:
        (await this.#in(mainWorktree, ["symbolic-ref", "--short", "-q", "HEAD"]).then((run) =>
          run.status === 0 ? run.stdout.toString("utf8").trim() : null,
        )) || null,
      main,
      storyBlob,
      branch,
      checkedOut:
        holder === undefined
          ? null
          : { path: holder.path, atTarget: this.#same(holder.path, where.path) },
      target: { ...where, exists: existsSync(where.path) },
    };
  }

  async create(target: StoryWorkspaceTarget, base: string): Promise<StoryWorkspaceCreation> {
    let createdBranch = false;
    if ((await this.#commit(`refs/heads/${target.branch}`)) === undefined) {
      await this.#ok(["branch", "--no-track", target.branch, base]);
      createdBranch = true;
    }
    let worktrees = await this.#worktrees();
    const holder = this.#holder(worktrees, target.branch);
    if (holder !== undefined) {
      return { worktree: holder.path, createdBranch, createdWorktree: false };
    }
    // A worktree whose folder was deleted by hand still holds the branch for Git: pruned first.
    if (worktrees.some((worktree) => worktree.stale)) {
      await this.#ok(["worktree", "prune"]);
      worktrees = await this.#worktrees();
    }
    const main = worktrees[0]?.path ?? resolve(this.#cwd);
    const where = this.#targetOf(main, target.id);
    await mkdir(dirname(where.path), { recursive: true });
    await this.#ok(["worktree", "add", where.path, target.branch]);
    await this.#carryPersonalLayers(main, where.path);
    return { worktree: where.path, createdBranch, createdWorktree: true };
  }

  /**
   * A person's own layers of the skills' customisation (`<skill>.local.yaml`) are
   * ignored by Git, so a new working copy does not hold them: the agent working in it would never
   * read them. They are copied in once, as they are when the story starts. Never a reason to fail.
   */
  async #carryPersonalLayers(main: string, worktree: string): Promise<void> {
    try {
      const root = resolve(this.#cwd);
      const inside = relative(main, root);
      if (inside.startsWith("..") || isAbsolute(inside)) return;
      const from = join(root, SKILL_OVERRIDES_DIR);
      const to = join(worktree, inside, SKILL_OVERRIDES_DIR);
      for (const entry of await readdir(from, { withFileTypes: true })) {
        if (!entry.isFile() || !isPersonalLayerFile(entry.name)) continue;
        await mkdir(to, { recursive: true });
        await copyFile(join(from, entry.name), join(to, entry.name));
      }
    } catch {
      // No such folder, or a file that cannot be copied: the story goes on without.
    }
  }

  async discard(
    target: StoryWorkspaceTarget,
    base: string,
    created: StoryWorkspaceCreation,
  ): Promise<boolean> {
    try {
      if (created.createdWorktree) {
        const removed = await this.#git(["worktree", "remove", created.worktree]);
        if (removed.status !== 0) return false;
      }
      if (created.createdBranch) {
        // Only a branch still at its base: never a commit someone made meanwhile.
        if ((await this.#commit(`refs/heads/${target.branch}`)) !== base) return false;
        const deleted = await this.#git(["branch", "-D", target.branch]);
        if (deleted.status !== 0) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async removeWorktree(
    story: Pick<StoryWorkspaceTarget, "id" | "branch">,
  ): Promise<WorktreeRemoval> {
    try {
      const worktrees = await this.#worktrees();
      const main = worktrees[0]?.path ?? resolve(this.#cwd);
      const where = this.#targetOf(main, story.id);
      const holder = this.#holder(worktrees, story.branch);
      if (holder === undefined) {
        // A folder still there (a detached head, another branch checked out in it): kept. Its
        // folder deleted by hand: absent (Git forgets it at the next prune, never forced here:
        // a prune would forget every other stale worktree too).
        if (existsSync(where.path)) {
          return { status: "kept", reason: "other_folder", path: where.path };
        }
        return { status: "absent", path: where.path };
      }
      // Never the main worktree, never a folder other than the story's own.
      if (this.#same(holder.path, main) || !this.#same(holder.path, where.path)) {
        return { status: "kept", reason: "other_folder", path: holder.path };
      }
      const real = (path: string) => {
        try {
          return realpathSync(path);
        } catch {
          return resolve(path);
        }
      };
      const here = real(this.#cwd);
      const inside = relative(real(holder.path), here);
      if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) {
        return { status: "kept", reason: "in_use", path: holder.path };
      }
      const removed = await this.#git(["worktree", "remove", holder.path]);
      if (removed.status === 0) return { status: "removed", path: holder.path };
      const message = removed.stderr.trim().split(/\r?\n/).at(-1) ?? "";
      return /modified or untracked|is dirty|uncommitted/i.test(removed.stderr)
        ? { status: "kept", reason: "dirty", path: holder.path, message }
        : { status: "kept", reason: "failed", path: holder.path, message };
    } catch (error) {
      return {
        status: "kept",
        reason: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Runs Git in another folder than the workspace's (a worktree), same limits. */
  async #in(cwd: string, args: readonly string[]): Promise<GitRun> {
    const run = await this.#run(cwd, args, undefined, { LC_ALL: "C" }, CALL_TIMEOUT_MS);
    if (run.timedOut === true) throw gitFailure(args, run);
    return run;
  }

  async ensureBranch(name: string, from?: string): Promise<BranchEnsured> {
    try {
      if (name.startsWith("-") || !SAFE_BRANCH.test(name)) {
        return { status: "failed", message: "refused to create that branch" };
      }
      if ((await this.#commit(`refs/heads/${name}`)) !== undefined) return { status: "exists" };
      // The remote holds it: the local branch follows it (without upstream), never a new history.
      const remote = await this.#commit(`${REMOTE}${name}`);
      if (remote !== undefined) {
        await this.#ok(["branch", "--no-track", name, remote]);
        return { status: "created", from: `origin/${name}` };
      }
      const source = await this.#main(from);
      if (source === null) return { status: "missing_source" };
      await this.#ok(["branch", "--no-track", name, source.commit]);
      return { status: "created", from: source.ref };
    } catch (error) {
      return { status: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** What `rev-parse --is-bare-repository` says here; undefined when Git is not installed. */
  async #bareCheck(): Promise<GitRun | undefined> {
    try {
      return await this.#git(["rev-parse", "--is-bare-repository"]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async detectWorkflow(): Promise<WorkflowDetection> {
    const bare = await this.#bareCheck();
    if (bare === undefined) return { repository: false };
    if (bare.status !== 0 || bare.stdout.toString("utf8").trim() === "true") {
      return { repository: false };
    }
    const listed = await this.#git([
      "for-each-ref",
      "--format=%(refname)",
      "refs/heads/",
      "refs/remotes/origin/",
    ]);
    const names = new Set<string>();
    if (listed.status === 0) {
      for (const line of listed.stdout.toString("utf8").split(/\r?\n/)) {
        const name = line.startsWith("refs/heads/")
          ? line.slice("refs/heads/".length)
          : line.startsWith(REMOTE)
            ? line.slice(REMOTE.length)
            : "";
        // The journal's orphan branch and the remote's pointer are not branches of the creator's.
        if (name === "" || name === "HEAD" || name.startsWith("agentplugged/")) continue;
        names.add(name);
      }
    }
    const main = await this.#main();
    const remotes = await this.#git(["remote"]);
    const subjects = await this.#git(["log", "--merges", "-n", "50", "--format=%s"]);
    const branches = [...names].sort();
    return {
      repository: true,
      main: main === null ? null : main.ref.replace(/^origin\//, ""),
      branches,
      remote: remotes.status === 0 && remotes.stdout.toString("utf8").trim() !== "",
      story_branches: branches.filter((name) => /^(?:feat|feature)\//.test(name)).length,
      pull_request_merges:
        subjects.status === 0 && /^Merge pull request/m.test(subjects.stdout.toString("utf8")),
    };
  }

  async mergeBranch(request: BranchMergeRequest): Promise<BranchMergeOutcome> {
    const { from, into, method, message } = request;
    if ([from, into].some((name) => name.startsWith("-") || !SAFE_BRANCH.test(name))) {
      return { ok: false, reason: "failed", message: "refused to merge those branches" };
    }
    let temporary: string | undefined;
    try {
      const fromCommit =
        (await this.#commit(`refs/heads/${from}`)) ?? (await this.#commit(`${REMOTE}${from}`));
      if (fromCommit === undefined) return { ok: false, reason: "branch_missing", message: from };
      if (request.expect !== undefined && request.expect !== fromCommit) {
        return { ok: false, reason: "head_moved", message: from };
      }
      // The branch to merge into: its local one, else created from the remote's, never a new history.
      const ensured = await this.ensureBranch(into);
      if (ensured.status === "missing_source" || ensured.status === "failed") {
        return { ok: false, reason: "branch_missing", message: into };
      }
      const intoCommit = (await this.#commit(`refs/heads/${into}`)) as string;
      const contained = await this.#git(["merge-base", "--is-ancestor", fromCommit, intoCommit]);
      if (contained.status === 0) return { ok: true, commit: fromCommit, merge_commit: null };
      const worktrees = await this.#worktrees();
      const holder = this.#holder(worktrees, into);
      let folder: string;
      if (holder !== undefined) {
        const status = await this.#in(holder.path, [
          "status",
          "--porcelain",
          "--untracked-files=no",
        ]);
        if (status.status !== 0 || status.stdout.toString("utf8").trim() !== "") {
          return { ok: false, reason: "base_dirty", message: holder.path };
        }
        folder = holder.path;
      } else {
        const main = worktrees[0]?.path ?? resolve(this.#cwd);
        folder = join(
          dirname(main),
          `${basename(main)}.worktrees`,
          `.merge-${process.pid}-${Date.now().toString(36)}`,
        );
        await mkdir(dirname(folder), { recursive: true });
        await this.#ok(["worktree", "add", "--detach", folder, intoCommit]);
        temporary = folder;
      }
      // The creator's own identity when Git has one; the engine's when it has none (a merge needs it).
      const identity = await this.#in(folder, ["config", "user.name"]);
      const who =
        identity.status === 0 && identity.stdout.toString("utf8").trim() !== ""
          ? []
          : ["-c", "user.name=AgentPlugged", "-c", "user.email=noreply@agentplugged.invalid"];
      const flags = method === "squash" ? ["--squash"] : ["--no-ff", "--no-edit", "-m", message];
      const merged = await this.#in(folder, [...who, "merge", ...flags, fromCommit]);
      if (merged.status !== 0) {
        const output = `${merged.stdout.toString("utf8")}\n${merged.stderr}`;
        // A merge in progress is aborted, a squash leaves the index to put back: nothing changes.
        await this.#in(folder, ["merge", "--abort"]).catch(() => undefined);
        await this.#in(folder, ["reset", "--hard", intoCommit]).catch(() => undefined);
        return /CONFLICT|Automatic merge failed/i.test(output)
          ? { ok: false, reason: "conflict", message: lastLine(output) }
          : { ok: false, reason: "failed", message: lastLine(output) };
      }
      if (method === "squash") {
        const committed = await this.#in(folder, [...who, "commit", "-m", message]);
        if (committed.status !== 0) {
          await this.#in(folder, ["reset", "--hard", intoCommit]).catch(() => undefined);
          const output = `${committed.stdout.toString("utf8")}\n${committed.stderr}`;
          return { ok: false, reason: "failed", message: lastLine(output) };
        }
      }
      const head = await this.#in(folder, ["rev-parse", "HEAD"]);
      const created = head.stdout.toString("utf8").trim();
      if (head.status !== 0 || created === "") {
        return { ok: false, reason: "failed", message: "the merge commit cannot be read" };
      }
      if (temporary !== undefined) {
        // The branch moves only from the commit read above: never over a commit made meanwhile.
        const moved = await this.#git(["update-ref", `refs/heads/${into}`, created, intoCommit]);
        if (moved.status !== 0) {
          return { ok: false, reason: "failed", message: lastLine(moved.stderr) };
        }
      }
      return { ok: true, commit: fromCommit, merge_commit: created };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: "failed", message: text };
    } finally {
      if (temporary !== undefined) {
        await this.#git(["worktree", "remove", "--force", temporary]).catch(() => undefined);
      }
    }
  }

  async commitFiles(request: FilesCommitRequest): Promise<FilesCommitOutcome> {
    const paths = request.files.map((file) => file.path);
    if (paths.length === 0 || paths.some((path) => path.startsWith("-") || isAbsolute(path))) {
      return { ok: false, reason: "failed", message: "no valid file to commit" };
    }
    try {
      // The folder where the branch is checked out: this one, or a story's worktree, with the same
      // place for the workspace root inside it.
      const worktrees = await this.#worktrees();
      const holder = this.#holder(worktrees, request.branch);
      const main = worktrees[0]?.path ?? resolve(this.#cwd);
      if (holder === undefined)
        return { ok: false, reason: "not_current", message: request.branch };
      const inner = relative(main, resolve(this.#cwd));
      const folder = this.#same(holder.path, main) ? this.#cwd : join(holder.path, inner);
      const run = (args: readonly string[]) => this.#in(folder, args);
      // Every file tracked and clean: the commit takes exactly the change made here, nothing else.
      const tracked = await run(["ls-files", "-z", "--", ...paths]);
      const known = new Set(tracked.stdout.toString("utf8").split("\0").filter(Boolean));
      const status = await run(["status", "--porcelain", "--untracked-files=no", "--", ...paths]);
      if (
        tracked.status !== 0 ||
        status.status !== 0 ||
        paths.some((path) => !known.has(path)) ||
        status.stdout.toString("utf8").trim() !== ""
      ) {
        return { ok: false, reason: "dirty", message: paths.join(", ") };
      }
      // The new text of each file, from what the branch holds there (not from another copy).
      const edits: { path: string; text: string }[] = [];
      for (const file of request.files) {
        const absolute = join(folder, ...file.path.split("/"));
        const current = await readFile(absolute, "utf8");
        const text = file.edit(current);
        if (text !== current) edits.push({ path: file.path, text });
      }
      const head = async () => (await run(["rev-parse", "HEAD"])).stdout.toString("utf8").trim();
      if (edits.length === 0) return { ok: true, commit: await head() };
      const identity = await run(["config", "user.name"]);
      const who =
        identity.status === 0 && identity.stdout.toString("utf8").trim() !== ""
          ? []
          : ["-c", "user.name=AgentPlugged", "-c", "user.email=noreply@agentplugged.invalid"];
      const changed = edits.map((edit) => edit.path);
      const restore = async () => {
        await run(["reset", "-q", "HEAD", "--", ...changed]).catch(() => undefined);
        await run(["checkout", "-q", "--", ...changed]).catch(() => undefined);
      };
      for (const edit of edits) {
        await writeFile(join(folder, ...edit.path.split("/")), edit.text, "utf8");
      }
      const added = await run(["add", "--", ...changed]);
      const committed =
        added.status === 0
          ? await run([...who, "commit", "-q", "-m", request.message, "--only", "--", ...changed])
          : added;
      if (committed.status !== 0) {
        await restore();
        return {
          ok: false,
          reason: "failed",
          message: lastLine(`${committed.stdout.toString("utf8")}\n${committed.stderr}`),
        };
      }
      return { ok: true, commit: await head() };
    } catch (error) {
      return {
        ok: false,
        reason: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async commitPaths(request: PathsCommitRequest): Promise<FilesCommitOutcome> {
    const { paths } = request;
    if (paths.length === 0 || paths.some((path) => path.startsWith("-") || isAbsolute(path))) {
      return { ok: false, reason: "failed", message: "no valid file to commit" };
    }
    try {
      const worktrees = await this.#worktrees();
      const main = worktrees[0]?.path ?? resolve(this.#cwd);
      const inner = relative(main, resolve(this.#cwd));
      let folder: string;
      if (request.branch === undefined) {
        // The main folder of the repository, and this workspace is in it (not a story's worktree).
        if (worktrees[0] === undefined || inner.startsWith("..") || isAbsolute(inner)) {
          return { ok: false, reason: "not_current", message: "main folder" };
        }
        folder = this.#cwd;
      } else {
        const holder = this.#holder(worktrees, request.branch);
        if (holder === undefined) {
          return { ok: false, reason: "not_current", message: request.branch };
        }
        folder = this.#same(holder.path, main) ? this.#cwd : join(holder.path, inner);
      }
      const run = (args: readonly string[]) => this.#in(folder, ["--literal-pathspecs", ...args]);
      if (request.branch !== undefined) {
        const current = await run(["symbolic-ref", "-q", "--short", "HEAD"]);
        if (current.status !== 0 || current.stdout.toString("utf8").trim() !== request.branch) {
          return { ok: false, reason: "not_current", message: request.branch };
        }
      }
      const head = async () => (await run(["rev-parse", "HEAD"])).stdout.toString("utf8").trim();
      // What differs from the branch at those paths: modified, deleted, new and not ignored.
      const listed = await run([
        "ls-files",
        "-z",
        "-m",
        "-d",
        "-o",
        "--exclude-standard",
        "--",
        ...paths,
      ]);
      if (listed.status !== 0) {
        return { ok: false, reason: "failed", message: lastLine(listed.stderr) };
      }
      const changed = [...new Set(listed.stdout.toString("utf8").split("\0").filter(Boolean))];
      if (changed.length === 0) return { ok: true, commit: await head() };
      const identity = await run(["config", "user.name"]);
      const who =
        identity.status === 0 && identity.stdout.toString("utf8").trim() !== ""
          ? []
          : ["-c", "user.name=AgentPlugged", "-c", "user.email=noreply@agentplugged.invalid"];
      const added = await run(["add", "-A", "--", ...changed]);
      const committed =
        added.status === 0
          ? await run([...who, "commit", "-q", "-m", request.message, "--only", "--", ...changed])
          : added;
      if (committed.status !== 0) {
        await run(["reset", "-q", "HEAD", "--", ...changed]).catch(() => undefined);
        return {
          ok: false,
          reason: "failed",
          message: lastLine(`${committed.stdout.toString("utf8")}\n${committed.stderr}`),
        };
      }
      return { ok: true, commit: await head() };
    } catch (error) {
      return {
        ok: false,
        reason: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async readBlob(blob: string): Promise<string | undefined> {
    const run = await this.#git(["cat-file", "blob", blob]);
    return run.status === 0 ? run.stdout.toString("utf8") : undefined;
  }

  async storyFilesOn(branch: string): Promise<readonly StoryFileOnBranch[] | undefined> {
    let prefixRun: GitRun;
    try {
      prefixRun = await this.#git(["rev-parse", "--show-prefix"]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (prefixRun.status !== 0) {
      if (NO_REPOSITORY.test(prefixRun.stderr)) return undefined;
      throw gitFailure(["rev-parse", "--show-prefix"], prefixRun);
    }
    const prefix = prefixRun.stdout.toString("utf8").trim();
    const commit = await this.#commit(`refs/heads/${branch}`);
    if (commit === undefined) return undefined;
    const dir = `${prefix}${STORIES_DIR}`;
    const args = ["ls-tree", "-r", "-z", "--full-tree", commit, "--", dir];
    const listing = await this.#git(args);
    if (listing.status !== 0) throw gitFailure(args, listing);
    const files: StoryFileOnBranch[] = [];
    for (const { path, oid } of treeFiles(listing.stdout)) {
      if (!path.toLowerCase().endsWith(".md") || !path.startsWith(`${dir}/`)) continue;
      files.push({ path: path.slice(prefix.length), blob: oid });
    }
    return files;
  }

  async installCommitHook(files: CommitHookFiles): Promise<CommitHookInstall> {
    // The common Git folder holds `objects` (`--git-path` is relative to this folder).
    const common = dirname(await this.#path(["rev-parse", "--git-path", "objects"]));
    const hooks = await this.#path(["rev-parse", "--git-path", "hooks"]);
    // The check and the story's requirements always live in the Git folder, ours alone.
    const check = join(common, ...COMMIT_CHECK_PATH.split("/"));
    await mkdir(dirname(check), { recursive: true });
    if ((await readText(check)) !== files.check) await writeFile(check, files.check);
    if (files.story !== undefined) {
      const stories = join(common, ...COMMIT_STORIES_DIR.split("/"));
      await mkdir(stories, { recursive: true });
      await writeFile(
        join(stories, `${files.story.id}.json`),
        `${JSON.stringify({ id: files.story.id, requirements: files.story.requirements })}\n`,
      );
    }
    // What the creator skipped: the check reads it, whatever the story.
    if (files.skips !== undefined) {
      await writeFile(join(common, ...COMMIT_SKIPS_PATH.split("/")), files.skips);
    }
    // A hooks folder outside the Git folder (`core.hooksPath`: tracked, or shared by every
    // repository) is never written: the creator adds the line.
    const inside = relative(common, hooks);
    if (inside === "" || inside.split(sep)[0] === ".." || isAbsolute(inside)) {
      return { status: "manual", path: hooks, reason: "hooks_path" };
    }
    await mkdir(hooks, { recursive: true });
    const hook = join(hooks, COMMIT_HOOK_NAME);
    const chained = join(hooks, CHAINED_HOOK_NAME);
    const current = await readText(hook);
    if (current !== undefined && !current.includes(files.marker)) {
      if (await exists(chained)) return { status: "manual", path: hook, reason: "taken" };
      await rename(hook, chained);
      await writeHook(hook, files.hook);
      return { status: "chained", path: hook };
    }
    if (current === files.hook) {
      await chmod(hook, 0o755);
      return { status: "unchanged", path: hook };
    }
    await writeHook(hook, files.hook);
    return { status: current === undefined ? "installed" : "updated", path: hook };
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function writeHook(path: string, text: string): Promise<void> {
  await writeFile(path, text, { mode: 0o755 });
  await chmod(path, 0o755);
}
