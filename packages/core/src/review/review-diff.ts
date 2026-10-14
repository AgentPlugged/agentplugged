/**
 * Port through which a review reads the diff of a story's branch: the changes of
 * `head` since its merge base with `base`, as a unified diff (`git diff <base>...<head>`), in the
 * repository's paths. Implemented in `adapters-git`; tests give a fake one.
 */
export interface StoryDiff {
  /**
   * The unified diff, or undefined when Git cannot read it (no repository, unknown commit). With
   * `ref` (the main branch the story started from, `origin/main`), the diff starts at the merge
   * base of `head` and that branch's tip when Git knows it: the main branch's work merged into the
   * story's branch since is not the story's.
   */
  diff(base: string, head: string, ref?: string): Promise<string | undefined>;
  /**
   * The messages of the commits `base`...`head` holds: what the change says about
   * itself, tried by the review's assertions pass. Undefined when Git cannot read them.
   */
  messages?(base: string, head: string, ref?: string): Promise<string | undefined>;
  /**
   * The diff of a change that belongs to no story: the work not committed yet, a range
   * of commits, a branch against the main branch. Undefined when Git cannot read it.
   */
  free?(request: FreeDiffRequest): Promise<FreeDiff | undefined>;
}

/** Where a free review reads its diff: refs are checked by the adapter, never passed on as options. */
export type FreeDiffRequest =
  | { readonly kind: "uncommitted" }
  | {
      readonly kind: "range";
      readonly from: string;
      readonly to: string;
      /** `..` (the two points) or `...` (since their merge base). */
      readonly dots: ".." | "...";
    }
  | { readonly kind: "branch"; readonly name: string };

/** A free diff and the messages of the commits it holds (empty for work not committed). */
export interface FreeDiff {
  readonly diff: string;
  readonly messages: string;
}
