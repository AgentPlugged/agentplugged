/**
 * Port through which the order of the merges and the conflicts read Git: what merging
 * a story's head into the main branch would conflict on, the content of a file at a commit, the
 * ancestry of commits and the merges a branch holds. Implemented in `adapters-git`; `core`
 * decides, the adapter only reads. It never writes a reference nor the working folder.
 */

/**
 * One block in conflict: the lines of the main branch's side, of the common base, and of the story's
 * side (the story's head is the side being merged into the main branch).
 */
export interface ConflictHunk {
  readonly main: readonly string[];
  readonly base: readonly string[];
  readonly story: readonly string[];
}

/** A conflicted file: its blocks, or `structural` when no readable marker tells them. */
export interface ConflictFileProbe {
  /** The file's path, relative to the repository, with `/`. */
  readonly path: string;
  /** A deletion, a rename, a binary file, unreadable or unbalanced markers. */
  readonly structural: boolean;
  readonly hunks: readonly ConflictHunk[];
  /** More blocks than the adapter keeps. */
  readonly hunks_truncated: boolean;
}

/** What merging a head into the main branch's tip would do. */
export type ConflictProbe =
  | { readonly status: "clean"; readonly main: string }
  | {
      readonly status: "conflict";
      readonly main: string;
      readonly files: readonly ConflictFileProbe[];
      /** More files in conflict than the adapter keeps. */
      readonly files_truncated: boolean;
    }
  /** Git cannot tell here (too old, a commit it does not hold). */
  | { readonly status: "unavailable" };

/** A merge commit of a branch: its commit and its parents, the first one being the branch's own. */
export interface BranchMerge {
  readonly commit: string;
  readonly parents: readonly string[];
}

export interface MergeProbe {
  /** The commit of a branch name (`main`, `origin/main`), or undefined when Git does not know it. */
  resolve(ref: string): Promise<string | undefined>;
  /** What merging `head` into `main` (both commits) would conflict on. */
  probe(main: string, head: string): Promise<ConflictProbe>;
  /** The text of `path` at `commit`, or undefined when the commit has no such text file. */
  show(commit: string, path: string): Promise<string | undefined>;
  /**
   * Whether `ancestor` is an ancestor of `descendant`; undefined when Git does not hold one of
   * them.
   */
  isAncestor(ancestor: string, descendant: string): Promise<boolean | undefined>;
  /**
   * The tree Git merges `own` and `main` into by itself, when they merge without conflict; else
   * undefined. A merge commit whose tree is another one holds changes of its author's.
   */
  mergedTree(main: string, own: string): Promise<string | undefined>;
  /** The tree of a commit, or undefined. */
  treeOf(commit: string): Promise<string | undefined>;
  /**
   * Whether a commit was made elsewhere than on this machine: by the forge (GitHub's
   * web editor, the "resolve conflicts" button, "update branch") or by another identity than this
   * repository's own. The creator's gesture on the forge: the engine accepts it as part of the
   * story. Undefined when Git cannot tell.
   */
  madeOnForge?(commit: string): Promise<boolean | undefined>;
  /** The merge commits on `head` since `base` (`base..head`), oldest first; undefined if unreadable. */
  merges(base: string, head: string): Promise<readonly BranchMerge[] | undefined>;
}
