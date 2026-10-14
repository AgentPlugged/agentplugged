/**
 * Port through which `story start` and `start_story` reach Git: what the repository
 * holds for a story, the creation of its branch and worktree, and the commit hook. Implemented in
 * `adapters-git`; `core` decides, the adapter only reads and creates.
 */

/** The story a workspace is prepared for. */
export interface StoryWorkspaceTarget {
  /** `<epic>-<story>`: the worktree's folder name. */
  readonly id: string;
  readonly branch: string;
  /** The story's file, relative to the workspace root (the folder holding `.agentplugged/`). */
  readonly path: string;
}

/** What the repository holds for a story, read without writing anything. */
export type StoryWorkspaceInspection =
  | {
      readonly repository: false;
      /**
       * A repository the engine cannot prepare a worktree for: `bare` (no working tree), or `root`
       * (the main working tree is a file system root: no folder next to it).
       */
      readonly unsupported?: "bare" | "root";
    }
  | {
      readonly repository: true;
      /** The workspace root relative to the repository's top, with `/` (`""` or `app/`). */
      readonly prefix: string;
      /**
       * The workspace root in the repository's main working folder, absolute: where a story built
       * without a branch of its own is worked on. Absent when the adapter cannot say.
       */
      readonly root?: string;
      /** The branch checked out in the main working folder, or null when detached. */
      readonly current?: string | null;
      /**
       * The branch the stories land on and its commit, or null when there is none: the main branch,
       * or the integration branch the creator chose.
       */
      readonly main: { readonly ref: string; readonly commit: string } | null;
      /** The blob of the story's file at the main branch's commit, or null when absent. */
      readonly storyBlob: string | null;
      /**
       * The story's branch when it exists here: its commit, whether the main branch's commit holds
       * it all (`merged`: no commit of its own), and the story's blob at that commit.
       */
      readonly branch: {
        readonly commit: string;
        readonly merged: boolean;
        readonly storyBlob: string | null;
      } | null;
      /**
       * The folder the story's branch is checked out in (a worktree whose folder still exists), and
       * whether it is the expected one.
       */
      readonly checkedOut: { readonly path: string; readonly atTarget: boolean } | null;
      /**
       * Where the story's worktree goes: `<parent of the main repository>/<its name>.worktrees/<id>`,
       * absolute, and relative to the main repository's folder with `/`; whether something is
       * already there.
       */
      readonly target: {
        readonly path: string;
        readonly relative: string;
        readonly exists: boolean;
      };
    };

/** A story file at a branch's last commit: its path from the workspace root, and its blob. */
export interface StoryFileOnBranch {
  readonly path: string;
  readonly blob: string;
}

/** What `create` made:the worktree's folder, and what this call created itself. */
export interface StoryWorkspaceCreation {
  readonly worktree: string;
  readonly createdBranch: boolean;
  readonly createdWorktree: boolean;
}

/** The files of the commit hook, as `core` renders them. */
export interface CommitHookFiles {
  /** The check, a Node module, written to `<git common dir>/agentplugged/commit-msg.mjs`. */
  readonly check: string;
  /** The `commit-msg` hook, a `sh` script marked as generated. */
  readonly hook: string;
  /** The line that marks the hook as ours. */
  readonly marker: string;
  /**
   * The story the hook checks, written to `<git common dir>/agentplugged/stories/<id>.json`: its
   * requirements, read from the approved version the branch starts from. Absent when only what the
   * creator skipped is refreshed.
   */
  readonly story?: { readonly id: string; readonly requirements: readonly string[] };
  /**
   * What the creator skipped that the check reads, written as it is to
   * `<git common dir>/agentplugged/skips.json`. Absent: left as it is.
   */
  readonly skips?: string;
}

/**
 * What became of the hook: `installed` (no hook was there), `updated` or `unchanged` (ours was),
 * `chained` (the creator's hook renamed `commit-msg.pre-agentplugged` and run first), or `manual`
 * (nothing touched: `taken`, a hook of the creator and the chained name both used; `hooks_path`,
 * the hooks folder is outside the Git folder, set by `core.hooksPath`).
 */
export interface CommitHookInstall {
  readonly status: "installed" | "updated" | "unchanged" | "chained" | "manual";
  /** The hook's path (the hooks folder for `manual`). */
  readonly path: string;
  readonly reason?: "taken" | "hooks_path";
}

/**
 * What removing a story's worktree after its merge did: `removed`; `absent` (no
 * worktree of the branch here, its folder already gone); `kept`, with why: `dirty` (changes not
 * committed: never forced), `other_folder` (the branch is checked out in another folder than the
 * story's own: never touched), `in_use` (the engine itself runs inside it), `failed` (Git
 * refused, with its line).
 */
export type WorktreeRemoval =
  | { readonly status: "removed" | "absent"; readonly path?: string }
  | {
      readonly status: "kept";
      readonly reason: "dirty" | "other_folder" | "in_use" | "failed";
      readonly path?: string;
      readonly message?: string;
    };

/**
 * What the engine reads of a repository to propose a workflow that fits it, without
 * writing anything: the branches that exist (short names, local and `origin`, never the journal),
 * the main branch, whether a remote is set, how many branches look like a story's (`feat/`,
 * `feature/`) and whether the history holds merges of pull requests.
 */
export type WorkflowDetection =
  | { readonly repository: false }
  | {
      readonly repository: true;
      readonly main: string | null;
      readonly branches: readonly string[];
      readonly remote: boolean;
      readonly story_branches: number;
      readonly pull_request_merges: boolean;
    };

/** What `ensureBranch` did: created (from `from`), already there, or its source is missing. */
export type BranchEnsured =
  | { readonly status: "created"; readonly from: string }
  | { readonly status: "exists" }
  | { readonly status: "missing_source" | "failed"; readonly message?: string };

/** A merge the engine does itself: `from` into `into`, with the creator's method. */
export interface BranchMergeRequest {
  readonly from: string;
  readonly into: string;
  /** `merge` and `rebase` make a merge commit (a rebase of a history is never done here); `squash` one commit. */
  readonly method: "merge" | "squash" | "rebase";
  /** The commit's message, one line. */
  readonly message: string;
  /** The commit that `from` must be at: another one is refused (the commit reviewed). */
  readonly expect?: string;
}

/**
 * A merge done, or why not: a branch is not here (`branch_missing`), the branch to merge into is
 * checked out with changes not committed (`base_dirty`), the histories conflict (`conflict`,
 * nothing changed), `head_moved` (`from` is not at `expect`), Git refused (`failed`).
 */
export type BranchMergeOutcome =
  | {
      readonly ok: true;
      /** `from`'s commit that was merged. */
      readonly commit: string;
      /** The commit the merge created on `into`, or null when `into` already held everything. */
      readonly merge_commit: string | null;
    }
  | {
      readonly ok: false;
      readonly reason: "branch_missing" | "base_dirty" | "conflict" | "head_moved" | "failed";
      readonly message: string;
    };

/** Files the engine commits by itself on a branch (the late notices of the base). */
export interface FilesCommitRequest {
  /**
   * The branch the commit goes on: it must be checked out somewhere (the workspace itself, or a
   * story's worktree, where the same workspace root is used).
   */
  readonly branch: string;
  /**
   * The files to change, each path from the workspace root, with the change to make to the text
   * the branch holds there: applied in the folder that holds the branch, so a file is never
   * replaced by another copy. A file the change leaves as it is is not committed.
   */
  readonly files: readonly {
    readonly path: string;
    readonly edit: (current: string) => string;
  }[];
  /** The commit's message, one line. */
  readonly message: string;
}

/**
 * The files written and committed together, or why nothing was touched: the branch is not the one
 * checked out here (`not_current`), a file is not tracked or has changes not committed (`dirty`),
 * Git refused (`failed`, the files put back). The working copy is clean after every outcome.
 */
export type FilesCommitOutcome =
  | { readonly ok: true; readonly commit: string }
  | {
      readonly ok: false;
      readonly reason: "not_current" | "dirty" | "failed";
      readonly message: string;
    };

export interface StoryWorkspace {
  /**
   * Writes files and commits only them on the branch checked out here, with the
   * creator's Git identity, else the engine's. Never pushes, never touches another file.
   */
  commitFiles?(request: FilesCommitRequest): Promise<FilesCommitOutcome>;
  /**
   * What the repository holds for a story. `base`: the branch the stories land on (the creator's
   * integration branch); absent, the main branch.
   */
  inspect(
    target: StoryWorkspaceTarget,
    options?: { readonly base?: string },
  ): Promise<StoryWorkspaceInspection>;
  /**
   * Makes sure the branch `name` exists here: created at `from` (else at the main
   * branch) without upstream, or from `origin/<name>` when the remote holds it. Never moves an
   * existing branch.
   */
  ensureBranch?(name: string, from?: string): Promise<BranchEnsured>;
  /** What the repository holds that says how the creator already works. */
  detectWorkflow?(): Promise<WorkflowDetection>;
  /**
   * Merges a branch into another here, without a pull request: in the folder where
   * `into` is checked out when it is clean, else in a temporary one. Never pushes, never forces; a
   * conflict leaves everything as it was.
   */
  mergeBranch?(request: BranchMergeRequest): Promise<BranchMergeOutcome>;
  /**
   * Creates what is missing: the branch at `base` (without upstream) when it does not exist, then
   * the worktree at the expected folder when the branch is checked out nowhere (a worktree whose
   * folder was deleted by hand is pruned first). Returns the worktree's folder (the existing one
   * when the branch is already checked out) and what this call created.
   */
  create(target: StoryWorkspaceTarget, base: string): Promise<StoryWorkspaceCreation>;
  /**
   * Undoes what `create` made when nothing was recorded: the worktree it added, then the branch it
   * created, only while the branch is still at `base` (no commit of its own). Never throws: says
   * whether everything created is gone.
   */
  discard(
    target: StoryWorkspaceTarget,
    base: string,
    created: StoryWorkspaceCreation,
  ): Promise<boolean>;
  /** The text of a blob, or undefined when the repository does not hold it. */
  readBlob(blob: string): Promise<string | undefined>;
  /**
   * The story files at the last commit of `branch`: the Markdown files under the
   * workspace's `.agentplugged/stories/`, at any depth, each with its path relative to the
   * workspace root (`/` separators) and its blob. Undefined when no repository holds the folder or
   * the branch does not exist.
   */
  storyFilesOn(branch: string): Promise<readonly StoryFileOnBranch[] | undefined>;
  /** Installs the commit hook, never overwriting a hook of the creator. */
  installCommitHook(files: CommitHookFiles): Promise<CommitHookInstall>;
  /**
   * Removes the story's worktree once merged: `git worktree remove` of the expected
   * folder only, never forced (changes not committed keep it), a worktree whose folder is gone
   * pruned. The branch stays. Never throws.
   */
  removeWorktree?(story: Pick<StoryWorkspaceTarget, "id" | "branch">): Promise<WorktreeRemoval>;
  /**
   * The commit the remote holds for the story's branch when it is strictly ahead of `local` (story
   * 3.28: commits the creator added on the forge, a conflict resolved there, a suggestion accepted):
   * the branch is fetched into its remote-tracking reference only, never into a local branch nor the
   * working folder. Undefined when the remote has nothing newer, cannot be reached, or has history of
   * its own that `local` lacks (diverged): then the local head stands. `fresh` skips the short
   * memory of a recent read. Never throws.
   */
  remoteHead?(
    branch: string,
    local: string,
    options?: { readonly fresh?: boolean },
  ): Promise<string | undefined>;
}
