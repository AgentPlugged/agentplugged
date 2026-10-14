/** A file as the main branch holds it, or why there is no main branch. */
export type MainBranchRead =
  | {
      readonly found: true;
      /** The branch read, as shown to the creator (`origin/main`, or `main` without a remote). */
      readonly branch: string;
      /** The file's text on that branch; undefined when the branch has no such file. */
      readonly text: string | undefined;
      /**
       * When the remote-tracking branch is read and a local branch of the same name exists with
       * other commits: how many commits the local branch has that the remote one lacks (`ahead`),
       * and the reverse (`behind`). Only a local branch that diverged or is behind is reported here:
       * the remote one is then read.
       */
      readonly local?: { readonly branch: string; readonly ahead: number; readonly behind: number };
      /**
       * The local branch was read, because it has commits the remote one lacks and none
       * the other way round: the settings recorded there apply at once. `ahead` is how many of its
       * commits are not published to `remote`.
       */
      readonly unpublished?: { readonly remote: string; readonly ahead: number };
    }
  | {
      readonly found: false;
      /**
       * `no_repository`: the folder is not in a Git repository Git accepts to use (not a
       * repository, not a work tree, dubious ownership), or Git is missing.
       * `no_main_branch`: neither the remote's default branch (`refs/remotes/origin/HEAD`) nor
       * `main` nor `master` has a commit.
       */
      readonly reason: "no_repository" | "no_main_branch";
      /** The current branch, when there is one (`feature/x`). */
      readonly current?: string;
      /**
       * `no_repository` because Git refused the folder (dubious ownership, not a work tree), not
       * because there is no repository: Git's message, on one line.
       */
      readonly refused?: string;
    };

/**
 * Port through which `sync` and `rules` read a file of the main branch: the remote's default
 * branch (`refs/remotes/origin/HEAD`), else `origin/main`, else `origin/master`; the local `main`
 * or `master` when it has commits the remote-tracking one lacks and none the other way round
 * (`unpublished`), or when no remote-tracking one exists. `path` is relative to the workspace root
 * (the folder holding `.agentplugged/`, possibly a subfolder of the repository), with `/` as
 * separator, like `WorkspaceFiles`. Nothing is written. A failure (a timeout, a damaged
 * repository) is thrown: the caller falls back on the working copy and says so.
 */
export interface MainBranchReader {
  read(path: string): Promise<MainBranchRead>;
}
