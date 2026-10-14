import type { ForgeId, MergeMethod } from "@agentplugged/protocol";

/**
 * Port through which `story pr` and `open_pull_request` reach Git and the forge: the
 * repository's remotes and the story's branch, the push of that branch, and the forge's
 * command-line tool (`gh`, `glab`) the creator already logged in. Implemented in `adapters-git`;
 * `core` decides, the adapter only reads, pushes and runs the tool with fixed arguments. The
 * forge's token is never read, shown nor passed on: the tool holds it.
 */

/**
 * A Git remote: its name, and the address Git really pushes to (`git remote get-url --push`:
 * `pushurl`, `insteadOf` and `pushInsteadOf` applied), never shown: it may hold credentials. The
 * forge is detected from that address, so a remote that fetches from GitHub but pushes elsewhere
 * is never taken for GitHub.
 */
export interface ForgeRemote {
  readonly name: string;
  readonly url: string;
}

/** What the repository holds for a story's branch, read without writing anything. */
export type ForgeInspection =
  | { readonly repository: false }
  | {
      readonly repository: true;
      /** The workspace root relative to the repository's top, with `/` (`""` or `app/`). */
      readonly prefix: string;
      readonly remotes: readonly ForgeRemote[];
      /** The branch's commit, or null when the branch does not exist here. */
      readonly head: string | null;
      /**
       * The branch's own commits since its base (`rev-list --count <merge-base>..<head>`), or null
       * when they cannot be counted (the base is not here).
       */
      readonly commits: number | null;
    };

/** A repository on a forge, read from a remote's address. */
export interface ForgeRepository {
  readonly forge: ForgeId;
  /** The host, lowercase, without port nor credentials (`github.com`). */
  readonly host: string;
  /** The repository's path on the host, without `.git` (`ada/shop`, `group/sub/shop`). */
  readonly path: string;
}

/** The forge's tool: `ready` (installed, logged in to the host), `missing`, or `logged_out`. */
export type ForgeCliState = "ready" | "missing" | "logged_out";

/**
 * A pull request (a merge request on GitLab) of the branch, opened from the repository itself
 * (never from a fork whose branch has the same name), with its title and text as the forge holds
 * them.
 */
export interface ForgePullRequest {
  readonly number: number;
  readonly url: string;
  readonly state: "open" | "closed" | "merged";
  readonly title: string;
  readonly body: string;
}

/** What a pull request is opened or updated with. */
export interface PullRequestDraft {
  /** The branch it targets (`main`). */
  readonly base: string;
  /** The story's branch. */
  readonly branch: string;
  readonly title: string;
  readonly body: string;
}

/**
 * A push: done, or refused as not a fast-forward (`push_rejected`: fetch and rebase), or failed
 * (`push_failed`: the network, a remote hook or a protected branch), with Git's line.
 */
export type BranchPushOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "push_rejected" | "push_failed";
      readonly message: string;
    };

export interface StoryForge {
  /** The workspace's place in the repository, its remotes, the branch's commit and own commits. */
  inspect(branch: string, base: string): Promise<ForgeInspection>;
  /**
   * Whether the forge's tool is installed and logged in to the repository's host. Throws when the
   * tool does not answer in time.
   */
  cli(repository: ForgeRepository): Promise<ForgeCliState>;
  /**
   * Pushes the branch to the remote under the same name (`refs/heads/<b>:refs/heads/<b>`), never
   * forced, never prompting; refuses the target branch `base`, `main`, `master` and `HEAD`.
   */
  push(remote: string, branch: string, base: string): Promise<BranchPushOutcome>;
  /**
   * The pull requests of the repository whose source is the branch, in any state. Throws when the
   * tool fails.
   */
  pullRequests(repository: ForgeRepository, branch: string): Promise<ForgePullRequest[]>;
  /** Opens a pull request. Throws when the tool fails. */
  create(
    repository: ForgeRepository,
    draft: PullRequestDraft,
  ): Promise<{ number: number; url: string }>;
  /**
   * Replaces an open pull request's title and text, and the branch it targets (`draft.base`: the
   * creator may change their workflow while it is open). Throws when the tool fails.
   */
  update(repository: ForgeRepository, number: number, draft: PullRequestDraft): Promise<void>;
  /**
   * Points an open pull request at another branch (the creator's integration branch
   * changed). Throws when the tool fails.
   */
  retarget?(repository: ForgeRepository, number: number, base: string): Promise<void>;
  /**
   * Whether the forge protects a branch (read by `init` to propose a workflow that
   * fits): `protected`, `open`, or `unknown` (not allowed to say, the tool failing).
   */
  branchProtection?(
    repository: ForgeRepository,
    branch: string,
  ): Promise<"protected" | "open" | "unknown">;
  /**
   * Posts a review on a pull request: its text, and one comment per finding on its
   * line of the new side of the diff. Throws when the tool fails.
   */
  postReview?(repository: ForgeRepository, number: number, review: ForgeReviewDraft): Promise<void>;
  /** Posts a comment on a pull request (a deviation). Throws when the tool fails. */
  comment?(repository: ForgeRepository, number: number, body: string): Promise<void>;
  /**
   * One pull request as the forge holds it now: its state, its head commit, the
   * commit its merge created. Throws when the tool fails.
   */
  pullRequest?(repository: ForgeRepository, number: number): Promise<ForgePullRequestState>;
  /**
   * The unified diff of a pull request as the forge shows it (the free review of a
   * contribution that is not a story's). Throws when the tool fails.
   */
  pullRequestDiff?(repository: ForgeRepository, number: number): Promise<string>;
  /**
   * Merges a pull request on the commit given only (the forge refuses another head), with the
   * method given, never deleting its branch nor bypassing the forge's protections.
   * Throws only when the tool cannot be run; a refusal of the forge is an outcome.
   */
  merge?(
    repository: ForgeRepository,
    number: number,
    request: ForgeMergeRequest,
  ): Promise<ForgeMergeOutcome>;
  /**
   * The repository's main branch as Git holds it here, with the workspace's place and remotes
   *: the local `main` or `master` that has a commit. Reads only.
   */
  inspectMain?(): Promise<MainInspection>;
  /**
   * Where a remote's branch stands against a local commit: asks the remote itself
   * (`git ls-remote`), fetches what it holds (never writes the working tree nor a local branch),
   * then compares. Never throws for a remote that cannot be reached: `unreadable`.
   */
  remoteBranch?(remote: string, branch: string, commit: string): Promise<RemoteBranchState>;
  /**
   * Pushes the commit to the remote as its branch: `git push <remote>
   * <commit>:refs/heads/<branch>`, never forced, never prompting; only the main branch, and
   * the engine checked the remote was empty or behind just before. Then sets the branch's upstream.
   */
  pushMain?(remote: string, branch: string, commit: string): Promise<BranchPushOutcome>;
  /**
   * Creates a repository on the forge with its tool, private unless asked otherwise, and adds it as
   * the remote `origin`. Pushes nothing. A refusal is an outcome; it throws only when
   * the tool cannot be run.
   */
  createRepository?(request: RepositoryRequest): Promise<RepositoryCreation>;
}

/** What `inspectMain` read. */
export interface MainInspection {
  readonly repository: boolean;
  /** The workspace root relative to the repository's top, with `/` (`""` at the top). */
  readonly prefix?: string;
  readonly remotes?: readonly ForgeRemote[];
  /** The local main branch (`main` or `master`) with a commit, or null. */
  readonly branch?: string | null;
  /** Its commit, or null. */
  readonly head?: string | null;
}

/**
 * A remote branch against a local commit: `missing` (no such branch there: an empty remote, or a
 * branch not pushed), `same` (already at the commit), `behind` (the remote's branch is an
 * ancestor: a fast-forward), `ahead` (the commit is behind the remote's branch), `diverged`.
 */
export type RemoteBranchState =
  | { readonly state: "missing" }
  | { readonly state: "same" | "behind" | "ahead" | "diverged"; readonly head: string }
  | { readonly state: "unreadable"; readonly message: string };

/** A repository to create: the forge, its host, the account, the name, the visibility. */
export interface RepositoryRequest {
  readonly forge: ForgeId;
  readonly host: string;
  readonly owner?: string;
  readonly name: string;
  readonly visibility: "private" | "public";
  /**
   * The name of the remote the repository is added as (`origin` by default). The
   * separate private repository of the journal of a public product is `agentplugged-journal`.
   */
  readonly remote?: string;
}

/** A repository created: its remote (`origin`, with the address Git pushes to). */
export type RepositoryCreation =
  | { readonly ok: true; readonly remote: ForgeRemote }
  | {
      readonly ok: false;
      readonly reason: "exists" | "failed";
      readonly message: string;
    };

/** A pull request's state at the forge. */
export interface ForgePullRequestState {
  readonly state: "open" | "closed" | "merged";
  /** Its head commit, or null when the forge does not say. */
  readonly head: string | null;
  /** The commit its merge created on the target branch, or null (not merged, or not given). */
  readonly merge_commit: string | null;
  /** The branch it merges into (the CI gesture refuses another than the main branch). */
  readonly base?: string | null;
  /** The account that merged it, when it is merged and the forge says, else null. */
  readonly merged_by?: string | null;
  /** When the forge says it was merged (an ISO date), else null. */
  readonly merged_at?: string | null;
}

/** What the engine asks the forge to merge: the commit reviewed, and how. */
export interface ForgeMergeRequest {
  readonly commit: string;
  readonly method: MergeMethod;
}

/**
 * A merge: done (with the commit it created when the forge gives it), or refused: `head_moved`
 * (the pull request is on another commit), `not_mergeable` (a conflict, a protected branch, a
 * review the forge requires), `failed` (any other refusal), with the forge's line.
 */
export type ForgeMergeOutcome =
  | { readonly ok: true; readonly merge_commit: string | null }
  | {
      readonly ok: false;
      readonly reason: "head_moved" | "not_mergeable" | "failed";
      readonly message: string;
    };

/** A comment of a review on one line of the new side of the pull request's diff. */
export interface ForgeLineComment {
  /** The file's path in the repository, as the diff names it. */
  readonly path: string;
  /** Its path before the change (a renamed file), else the same. */
  readonly old_path: string;
  readonly line: number;
  /** The line on the old side for a line the change left as it was, else null (added). */
  readonly old_line: number | null;
  readonly body: string;
}

/** What one review posts: on the commit reviewed, its text and its line comments. */
export interface ForgeReviewDraft {
  readonly commit: string;
  readonly body: string;
  readonly comments: readonly ForgeLineComment[];
}

/** The forge a host belongs to: GitHub or GitLab, by name; undefined for any other. */
export function forgeOfHost(host: string): ForgeId | undefined {
  const name = host.toLowerCase();
  if (name === "github.com" || name.includes("github")) return "github";
  if (name === "gitlab.com" || name.includes("gitlab")) return "gitlab";
  return undefined;
}

/**
 * The host and path a remote's address names, credentials and port dropped: `https://…`,
 * `http://…`, `ssh://…`, `git://…` and the short form `git@host:path`. Undefined for a local path
 * (`/srv/x.git`, `C:\x`, `file://…`) or anything else.
 */
export function remoteLocation(url: string): { host: string; path: string } | undefined {
  const text = url.trim();
  let host: string | undefined;
  let path: string | undefined;
  const full = /^(?:https?|ssh|git|git\+ssh):\/\/(?:[^@/]*@)?([^/:]+)(?::\d*)?\/(.+)$/i.exec(text);
  if (full !== null) {
    host = full[1];
    path = full[2];
  } else {
    const short = /^(?:[^@/\s]+@)?([^/:\s]+):(?!\/)(.+)$/.exec(text);
    // `C:/repo` or `C:\repo` is a Windows path, not `host:path`.
    if (short !== null && (short[1]?.length ?? 0) > 1) {
      host = short[1];
      path = short[2];
    }
  }
  if (host === undefined || path === undefined) return undefined;
  const cleaned = path
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+/, "");
  if (cleaned === "" || !/^[\w.-]+(?:\/[\w.-]+)*$/.test(cleaned)) return undefined;
  return { host: host.toLowerCase(), path: cleaned };
}

/**
 * The repository a remote names on GitHub or GitLab, or why not (`unknown_forge`, with the host
 * when there is one: a forge needs at least `<owner>/<name>`).
 */
export function forgeRepositoryOf(url: string): ForgeRepository | { readonly host?: string } {
  const location = remoteLocation(url);
  if (location === undefined) return {};
  const forge = forgeOfHost(location.host);
  if (forge === undefined || !location.path.includes("/")) return { host: location.host };
  return { forge, ...location };
}

/** The web address of a repository: `https://<host>/<path>`. */
export function repositoryWebUrl(repository: ForgeRepository): string {
  return `https://${repository.host}/${repository.path}`;
}

/**
 * True when a pull request's address is one of the repository's own: `…/<path>/pull/<n>` on
 * GitHub, `…/<path>/-/merge_requests/<n>` on GitLab, on its host.
 */
export function isRepositoryPullRequest(
  repository: ForgeRepository,
  url: string,
  number: number,
): boolean {
  const own = `${repositoryWebUrl(repository)}/${repository.forge === "gitlab" ? "-/merge_requests" : "pull"}/${number}`;
  return url.toLowerCase().replace(/\/+$/, "") === own.toLowerCase();
}

/** The command-line tool of a forge. */
export function forgeCli(forge: ForgeId): "gh" | "glab" {
  return forge === "github" ? "gh" : "glab";
}
