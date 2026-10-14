import {
  type CreatorAction,
  type CreatorActionRecord,
  ErrorCode,
  FORGE_CREATOR_ACTIONS,
  type ForgeGestureReason,
  MAX_MERGED_FILES,
  RepositoryPathSchema,
} from "@agentplugged/protocol";
import { CI_CONFIG_PATHS, isWorkflowFile } from "../ci/ci-rules.js";
import type { CommandContext } from "../command.js";
import { currentState } from "../deferred/deferred-commands.js";
import { AgentPluggedError } from "../errors.js";
import { stagedStories, workflowOf } from "../git/git-workflow.js";
import { loadMethodConfig } from "../init/method-config.js";
import { JOURNAL_REMOTE_NAME, type JournalBackupPort } from "../journal/journal-backup.js";
import { parseDiff } from "../review/review-rules.js";
import { oneLine } from "../stories/pull-request.js";
import { resolvePullRequestSettings } from "../stories/pull-request-settings.js";
import {
  type ForgeRemote,
  type ForgeRepository,
  forgeCli,
  forgeRepositoryOf,
  isRepositoryPullRequest,
  type StoryForge,
} from "../stories/story-forge.js";

/**
 * The three gestures of the forge the creator used to type: creating the remote
 * repository, pushing the main branch the first time, merging the pull request of the CI. The
 * engine does them with the forge's tool the creator connected (`gh`, `glab`) and Git, only after
 * the creator's approval is written and the projection accepted it (`carryOutForgeGesture` is
 * called from nowhere else), never forced, never past the forge's protections.
 *
 * Each one is read the same way three times: at the request (the facts the record keeps: the
 * commit and the repository), at the approval before it is written (`forgeGestureProblem`: the
 * facts must still be true), and right before the gesture itself. Each one is idempotent: what is
 * already done is `already`, not done again.
 */

/** True for one of the three gestures. */
export function isForgeAction(record: { readonly kind: string }): boolean {
  return (FORGE_CREATOR_ACTIONS as ReadonlySet<string>).has(record.kind);
}

type ForgeKind = "forge_repo_create" | "forge_push_main" | "forge_merge_ci" | "release";
type RepoCreate = Extract<CreatorAction, { kind: "forge_repo_create" }>;

/** The branch the CI's pull request is opened for, named like the engine's own title. */
const CI_PULL_REQUEST_TITLE = "Set up the CI";

/** `FORGE_GESTURE_FAILED`: the gesture cannot be done; nothing was done. */
export function gestureFailed(
  kind: string,
  reason: ForgeGestureReason,
  details: Readonly<Record<string, unknown>> = {},
): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.FORGE_GESTURE_FAILED, `error.forge_gesture.${reason}`, {
    kind,
    reason,
    ...details,
  });
}

/** `CREATOR_ACTION_STALE`: the repository moved since the request; nothing is written. */
function stale(
  checkpoint: string | undefined,
  kind: string,
  reason: "head_moved" | "target_changed",
  details: Readonly<Record<string, unknown>> = {},
): AgentPluggedError {
  return new AgentPluggedError(
    ErrorCode.CREATOR_ACTION_STALE,
    `error.creator_action_stale.${reason}`,
    { ...(checkpoint === undefined ? {} : { checkpoint }), kind, reason, ...details },
  );
}

/** What each gesture reads of the repository, as it is now. */
interface Ground {
  readonly forge: StoryForge;
  readonly remotes: readonly ForgeRemote[];
  readonly main: { readonly branch: string | null; readonly head: string | null };
}

/** The repository's ground: a Git repository, at the product's root, and the forge's port. */
async function groundOf(
  context: CommandContext,
  kind: ForgeKind,
): Promise<Ground | AgentPluggedError> {
  const forge = context.storyForge;
  if (
    forge?.inspectMain === undefined ||
    forge.remoteBranch === undefined ||
    forge.pushMain === undefined ||
    forge.createRepository === undefined
  ) {
    return gestureFailed(kind, "not_available");
  }
  try {
    const main = await forge.inspectMain();
    if (!main.repository) return gestureFailed(kind, "no_repository");
    if ((main.prefix ?? "") !== "") return gestureFailed(kind, "not_repository_root");
    return {
      forge,
      remotes: main.remotes ?? [],
      main: { branch: main.branch ?? null, head: main.head ?? null },
    };
  } catch (error) {
    return gestureFailed(kind, "forge_failed", { message: oneLine(messageOf(error)) });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The forge's tool installed and connected to the repository's host, or why not. */
async function cliProblem(
  forge: StoryForge,
  kind: ForgeKind,
  repository: ForgeRepository,
): Promise<AgentPluggedError | undefined> {
  let state: Awaited<ReturnType<StoryForge["cli"]>>;
  try {
    state = await forge.cli(repository);
  } catch (error) {
    return gestureFailed(kind, "forge_failed", { message: oneLine(messageOf(error)) });
  }
  if (state === "ready") return undefined;
  return gestureFailed(kind, state === "missing" ? "cli_missing" : "not_logged_in", {
    forge: repository.forge,
    host: repository.host,
    cli: forgeCli(repository.forge),
  });
}

/** The repository `origin` names on GitHub or GitLab, or why not. */
function originOf(
  ground: Ground,
  kind: ForgeKind,
): { readonly remote: ForgeRemote; readonly repository: ForgeRepository } | AgentPluggedError {
  const remote = ground.remotes.find((entry) => entry.name === "origin");
  if (remote === undefined) return gestureFailed(kind, "no_remote");
  const located = forgeRepositoryOf(remote.url);
  if (!("forge" in located)) {
    return gestureFailed(kind, "unknown_forge", { host: located.host ?? "local" });
  }
  return { remote, repository: located };
}

/** The repository a gesture targets, as the record names it: `<host>/<path>`. */
export function targetOf(repository: ForgeRepository): string {
  return `${repository.host}/${repository.path}`.toLowerCase();
}

/** The default host of each forge: a repository is created on GitHub or GitLab's own site. */
function hostOf(forge: "github" | "gitlab"): string {
  return forge === "github" ? "github.com" : "gitlab.com";
}

/** What the engine reads of a repository to create. */
interface CreatePlan {
  readonly kind: "forge_repo_create";
  readonly already: boolean;
  /**
   * `origin` is a public repository, so this one is the separate private repository
   * that keeps the journal, added as the remote `agentplugged-journal`.
   */
  readonly journal: boolean;
}

/** True when the journal's own port says the repository `origin` names can be read by anyone. */
async function originIsPublic(context: CommandContext): Promise<boolean> {
  const port = context.journal as Partial<JournalBackupPort> | undefined;
  if (port?.remoteExposure === undefined) return false;
  try {
    return (await port.remoteExposure("origin")) === "public";
  } catch {
    return false;
  }
}

/** True when the address of a remote names the repository `action` asks for. */
function namesRepository(url: string, action: RepoCreate): boolean {
  const located = forgeRepositoryOf(url);
  const wanted = (action.owner === undefined ? "" : `${action.owner}/`) + action.name;
  return (
    "forge" in located &&
    located.forge === action.forge &&
    (action.owner === undefined
      ? located.path.toLowerCase().endsWith(`/${action.name.toLowerCase()}`)
      : located.path.toLowerCase() === wanted.toLowerCase())
  );
}

async function planCreate(
  context: CommandContext,
  action: RepoCreate,
): Promise<CreatePlan | AgentPluggedError> {
  const ground = await groundOf(context, action.kind);
  if (ground instanceof AgentPluggedError) return ground;
  const cliPlan = async (journal: boolean): Promise<CreatePlan | AgentPluggedError> =>
    (await cliProblem(ground.forge, action.kind, {
      forge: action.forge,
      host: hostOf(action.forge),
      path: `${action.owner ?? "owner"}/${action.name}`,
    })) ?? { kind: action.kind, already: false, journal };
  const origin = ground.remotes.find((entry) => entry.name === "origin");
  if (origin !== undefined) {
    // The repository asked for is already origin: nothing to create. Any other origin stays,
    // unless it is public: the repository asked for then keeps the journal.
    if (namesRepository(origin.url, action)) {
      return { kind: action.kind, already: true, journal: false };
    }
    if (action.visibility === "public" || !(await originIsPublic(context))) {
      return gestureFailed(action.kind, "remote_exists", { remote: "origin" });
    }
    const kept = ground.remotes.find((entry) => entry.name === JOURNAL_REMOTE_NAME);
    if (kept !== undefined) {
      if (namesRepository(kept.url, action)) {
        return { kind: action.kind, already: true, journal: true };
      }
      return gestureFailed(action.kind, "remote_exists", { remote: JOURNAL_REMOTE_NAME });
    }
    return cliPlan(true);
  }
  return cliPlan(false);
}

/** What the engine reads before the first push of the main branch. */
interface PushPlan {
  readonly kind: "forge_push_main";
  readonly already: boolean;
  readonly branch: string;
  readonly commit: string;
  readonly target: string;
}

async function planPush(
  context: CommandContext,
  kind: "forge_push_main",
): Promise<PushPlan | AgentPluggedError> {
  const ground = await groundOf(context, kind);
  if (ground instanceof AgentPluggedError) return ground;
  const { branch, head } = ground.main;
  if (branch === null || head === null) return gestureFailed(kind, "no_main_branch");
  const origin = originOf(ground, kind);
  if (origin instanceof AgentPluggedError) return origin;
  const cli = await cliProblem(ground.forge, kind, origin.repository);
  if (cli !== undefined) return cli;
  let state: Awaited<ReturnType<NonNullable<StoryForge["remoteBranch"]>>>;
  try {
    state = await (ground.forge.remoteBranch as NonNullable<StoryForge["remoteBranch"]>)(
      origin.remote.name,
      branch,
      head,
    );
  } catch (error) {
    return gestureFailed(kind, "remote_unreadable", { message: oneLine(messageOf(error)) });
  }
  const target = targetOf(origin.repository);
  switch (state.state) {
    case "unreadable":
      return gestureFailed(kind, "remote_unreadable", { message: oneLine(state.message) });
    case "ahead":
      return gestureFailed(kind, "remote_ahead", { branch });
    case "diverged":
      return gestureFailed(kind, "remote_diverged", { branch });
    case "same":
      return { kind, already: true, branch, commit: head, target };
    default:
      // `missing` (an empty remote) or `behind` (a fast-forward): the only pushes the engine does.
      return { kind, already: false, branch, commit: head, target };
  }
}

/** What the engine reads before merging the CI's pull request. */
interface MergePlan {
  readonly kind: "forge_merge_ci";
  readonly already: boolean;
  readonly base: string;
  readonly commit: string;
  readonly target: string;
  readonly repository: ForgeRepository;
  /** The files the pull request changes: all of the CI, or of the product's documentation. */
  readonly files: readonly string[];
  /** The pull request open for the branch, when there is one. */
  readonly pullRequest?: { readonly number: number; readonly url: string };
}

/** True for a file of the CI, or of the product's documentation (`.agentplugged/docs/`). */
function isCiBranchFile(path: string): { readonly ci: boolean; readonly allowed: boolean } {
  const ci =
    isWorkflowFile(path) ||
    (CI_CONFIG_PATHS as readonly string[]).some(
      (entry) => path === entry || path.startsWith(`${entry}/`),
    );
  // The documentation, but never the architecture: it feeds the list of planned dependencies.
  const docs = /^\.agentplugged\/docs\/(?!architecture\.md$)[^/]+\.md$/.test(path);
  return { ci, allowed: ci || docs };
}

/**
 * The files of the pull request's diff, both sides of a rename, or undefined when any of them
 * cannot be read with certainty (a path the journal cannot hold, a space or a quote that makes the
 * header ambiguous): the engine merges nothing it cannot read whole.
 */
function ciDiffFiles(diff: string): { files: string[]; truncated: boolean } | undefined {
  const seen = new Set<string>();
  const parsed = parseDiff(diff);
  const headers = diff.split("\n").filter((line) => line.startsWith("diff --git ")).length;
  if (parsed.length !== headers) return undefined;
  for (const file of parsed) {
    for (const path of [file.old_path, file.path]) {
      if (path === null) continue;
      if (path === "" || /[\s"\\]/.test(path) || !RepositoryPathSchema.safeParse(path).success) {
        return undefined;
      }
      seen.add(path);
    }
  }
  const all = [...seen];
  return { files: all.slice(0, MAX_MERGED_FILES), truncated: all.length > MAX_MERGED_FILES };
}

async function planMerge(
  context: CommandContext,
  branch: string,
  /** The commit the creator approved: a pull request merged on it, branch gone, is `already`. */
  approved?: string,
): Promise<MergePlan | AgentPluggedError> {
  const kind = "forge_merge_ci";
  const ground = await groundOf(context, kind);
  if (ground instanceof AgentPluggedError) return ground;
  const { branch: base, head: baseHead } = ground.main;
  if (base === null || baseHead === null) return gestureFailed(kind, "no_main_branch");
  const origin = originOf(ground, kind);
  if (origin instanceof AgentPluggedError) return origin;
  const forge = ground.forge;
  const remote = origin.remote.name;
  // The main branch must already be at the remote: a pull request needs its base there.
  let onRemote: Awaited<ReturnType<NonNullable<StoryForge["remoteBranch"]>>>;
  let state: Awaited<ReturnType<NonNullable<StoryForge["remoteBranch"]>>>;
  let inspection: Awaited<ReturnType<StoryForge["inspect"]>>;
  try {
    inspection = await forge.inspect(branch, base);
    if (!inspection.repository || inspection.head === null) {
      return (
        (await alreadyMerged(forge, origin.repository, branch, approved, base)) ??
        gestureFailed(kind, "branch_not_pushed", { branch })
      );
    }
    // Called on the port itself: an adapter's methods hold their own state.
    onRemote = await (forge.remoteBranch as NonNullable<StoryForge["remoteBranch"]>)(
      remote,
      base,
      baseHead,
    );
    state = await (forge.remoteBranch as NonNullable<StoryForge["remoteBranch"]>)(
      remote,
      branch,
      inspection.head,
    );
  } catch (error) {
    return gestureFailed(kind, "remote_unreadable", { message: oneLine(messageOf(error)) });
  }
  if (onRemote.state === "unreadable") {
    return gestureFailed(kind, "remote_unreadable", { message: oneLine(onRemote.message) });
  }
  if (onRemote.state === "missing")
    return gestureFailed(kind, "branch_not_pushed", { branch: base });
  // The diff is read against the local main branch: it must be the one the remote holds, or the
  // "CI only" pull request could carry unpushed commits of the main branch with it.
  if (onRemote.state !== "same") return gestureFailed(kind, "main_not_pushed", { branch: base });
  if (state.state === "unreadable") {
    return gestureFailed(kind, "remote_unreadable", { message: oneLine(state.message) });
  }
  // The branch is at the remote exactly at the commit read here: nothing else is merged.
  if (state.state !== "same") {
    return (
      (await alreadyMerged(forge, origin.repository, branch, approved, base)) ??
      gestureFailed(kind, "branch_not_pushed", { branch })
    );
  }
  const commit = inspection.head;
  // Only the CI's files, and the product's documentation, changed: this is the CI's pull request.
  const source = context.storyDiff;
  if (source === undefined) return gestureFailed(kind, "diff_unreadable");
  const diff = await source.diff(baseHead, commit).catch(() => undefined);
  if (diff === undefined) return gestureFailed(kind, "diff_unreadable");
  const read = ciDiffFiles(diff);
  if (read === undefined) return gestureFailed(kind, "diff_unreadable");
  const { files, truncated } = read;
  const kinds = files.map(isCiBranchFile);
  if (
    truncated ||
    files.length === 0 ||
    kinds.some((entry) => !entry.allowed) ||
    !kinds.some((entry) => entry.ci)
  ) {
    return gestureFailed(kind, "not_ci_change", {
      files: files
        .filter((_, index) => kinds[index]?.allowed !== true)
        .slice(0, 5)
        .join(", "),
    });
  }
  const cli = await cliProblem(forge, kind, origin.repository);
  if (cli !== undefined) return cli;
  const repository = origin.repository;
  let pullRequests: Awaited<ReturnType<StoryForge["pullRequests"]>>;
  try {
    pullRequests = await forge.pullRequests(repository, branch);
  } catch (error) {
    return gestureFailed(kind, "forge_failed", { message: oneLine(messageOf(error)) });
  }
  const target = targetOf(repository);
  const open = pullRequests.find((entry) => entry.state === "open");
  if (open !== undefined) {
    // The pull request open is on the commit the creator saw: the forge says it, before anything
    // is written.
    if (forge.pullRequest !== undefined) {
      try {
        const current = await forge.pullRequest(repository, open.number);
        if (current.state === "closed") {
          return gestureFailed(kind, "pull_request_closed", { url: open.url });
        }
        if (current.state === "open" && current.head !== null && current.head !== commit) {
          return gestureFailed(kind, "head_moved", { url: open.url });
        }
        // The pull request must merge into the branch the diff was read against.
        if (current.base !== base) {
          return stale(undefined, kind, "target_changed", { url: open.url });
        }
      } catch (error) {
        return gestureFailed(kind, "forge_failed", { message: oneLine(messageOf(error)) });
      }
    }
    return { kind, already: false, base, commit, target, repository, files, pullRequest: open };
  }
  // A pull request the forge merged already, on the commit read: nothing more to do.
  const merged = pullRequests.find((entry) => entry.state === "merged");
  if (merged !== undefined && forge.pullRequest !== undefined) {
    try {
      const current = await forge.pullRequest(repository, merged.number);
      if (current.state === "merged" && current.head === commit && current.base === base) {
        return {
          kind,
          already: true,
          base,
          commit,
          target,
          repository,
          files,
          pullRequest: merged,
        };
      }
    } catch {
      // Not readable: the pull request is opened again below, or the forge refuses it.
    }
  }
  return { kind, already: false, base, commit, target, repository, files };
}

/** What the engine reads before a release: the two branches, and how the release goes in. */
interface ReleasePlan {
  readonly kind: "release";
  readonly already: boolean;
  /** The integration branch (staging) and the production branch. */
  readonly from: string;
  readonly to: string;
  /** The commit of `from` that is released. */
  readonly commit: string;
  /** `pr`: a pull request on the forge; `direct`: a merge by the engine, in this repository. */
  readonly via: "pr" | "direct";
  /** `<host>/<path>` of the repository, for a pull request. */
  readonly target?: string;
  readonly repository?: ForgeRepository;
  readonly remote?: string;
  /** What the remote holds of `from`: it is published first when `missing` or `behind`. */
  readonly published?: "same" | "missing" | "behind";
  /** The pull request open from `from` into `to`, when there is one. */
  readonly pullRequest?: { readonly number: number; readonly url: string };
  /** The stories waiting in staging, in the order they were merged. */
  readonly stories: readonly string[];
}

/** The title of the release's pull request, fixed by the engine. */
const RELEASE_PULL_REQUEST_TITLE = "Release";

async function planRelease(context: CommandContext): Promise<ReleasePlan | AgentPluggedError> {
  const kind = "release";
  const loaded = await loadMethodConfig(context.files);
  if (loaded instanceof AgentPluggedError) return loaded;
  let state: Readonly<Record<string, unknown>>;
  try {
    state = await currentState(context);
  } catch (error) {
    return gestureFailed(kind, "forge_failed", { message: oneLine(messageOf(error)) });
  }
  const flow = workflowOf(state).resolved;
  if (flow.integration === undefined) return gestureFailed(kind, "not_staged");
  const ground = await groundOf(context, kind);
  if (ground instanceof AgentPluggedError) return ground;
  const from = flow.integration;
  const to = flow.production ?? ground.main.branch;
  if (to === null) return gestureFailed(kind, "no_main_branch");
  const forge = ground.forge;
  let fromHead: string | null;
  let toHead: string | null;
  try {
    const source = await forge.inspect(from, to);
    const target = await forge.inspect(to, to);
    fromHead = source.repository ? source.head : null;
    toHead = target.repository ? target.head : null;
  } catch (error) {
    return gestureFailed(kind, "forge_failed", { message: oneLine(messageOf(error)) });
  }
  if (fromHead === null) return gestureFailed(kind, "branch_missing", { branch: from });
  if (toHead === null) return gestureFailed(kind, "branch_missing", { branch: to });
  const stories = stagedStories(state).map((entry) => entry.story);
  const contained = await context.mergeProbe?.isAncestor(fromHead, toHead).catch(() => undefined);
  const base = { kind, from, to, commit: fromHead, stories } as const;
  // Production already holds everything staging does (a release made by hand, nothing waiting).
  if (contained === true) return { ...base, already: true, via: "direct" };
  if (flow.merge !== "pr") return { ...base, already: false, via: "direct" };

  // Through the forge: a pull request from staging into production, on the repository itself.
  const origin = originOf(ground, kind);
  if (origin instanceof AgentPluggedError) return origin;
  const cli = await cliProblem(forge, kind, origin.repository);
  if (cli !== undefined) return cli;
  const repository = origin.repository;
  const remote = origin.remote.name;
  const remoteBranch = forge.remoteBranch as NonNullable<StoryForge["remoteBranch"]>;
  let production: Awaited<ReturnType<typeof remoteBranch>>;
  let staging: Awaited<ReturnType<typeof remoteBranch>>;
  let pullRequests: Awaited<ReturnType<StoryForge["pullRequests"]>>;
  try {
    production = await remoteBranch.call(forge, remote, to, toHead);
    staging = await remoteBranch.call(forge, remote, from, fromHead);
    pullRequests = await forge.pullRequests(repository, from);
  } catch (error) {
    return gestureFailed(kind, "forge_failed", { message: oneLine(messageOf(error)) });
  }
  if (production.state === "unreadable") {
    return gestureFailed(kind, "remote_unreadable", { message: oneLine(production.message) });
  }
  if (production.state === "missing")
    return gestureFailed(kind, "branch_not_pushed", { branch: to });
  // A pull request needs production at the remote as it is here, or ahead of it (a pull request merged
  // on the forge: the remote moved, the local branch follows at the next pull).
  if (production.state !== "same" && production.state !== "ahead") {
    return gestureFailed(kind, "main_not_pushed", { branch: to });
  }
  if (staging.state === "unreadable") {
    return gestureFailed(kind, "remote_unreadable", { message: oneLine(staging.message) });
  }
  if (staging.state === "diverged") return gestureFailed(kind, "remote_diverged", { branch: from });
  // Staging ahead at the remote (its stories were merged there): that commit is the one released.
  const published =
    staging.state === "missing" ? "missing" : staging.state === "ahead" ? "same" : staging.state;
  const commit = staging.state === "ahead" ? staging.head : fromHead;
  const open = pullRequests.find(
    (entry) =>
      entry.state === "open" && isRepositoryPullRequest(repository, entry.url, entry.number),
  );
  return {
    ...base,
    commit,
    already: false,
    via: "pr",
    target: targetOf(repository),
    repository,
    remote,
    published,
    ...(open === undefined ? {} : { pullRequest: { number: open.number, url: open.url } }),
  };
}

/**
 * A pull request the forge merged already on the commit the creator approved, whose branch is
 * gone (the forge deletes it at the merge): nothing more to do, `already`. Only with the commit
 * the creator approved: a request without one never finds it.
 */
async function alreadyMerged(
  forge: StoryForge,
  repository: ForgeRepository,
  branch: string,
  approved: string | undefined,
  base: string,
): Promise<MergePlan | undefined> {
  if (approved === undefined || forge.pullRequest === undefined) return undefined;
  try {
    const merged = (await forge.pullRequests(repository, branch)).find(
      (entry) => entry.state === "merged",
    );
    if (merged === undefined) return undefined;
    const current = await forge.pullRequest(repository, merged.number);
    if (current.state !== "merged" || current.head !== approved || current.base !== base) {
      return undefined;
    }
    return {
      kind: "forge_merge_ci",
      already: true,
      base,
      commit: approved,
      target: targetOf(repository),
      repository,
      files: [],
      pullRequest: merged,
    };
  } catch {
    return undefined;
  }
}

/**
 * The record a request keeps, with the facts the engine read (never the agent's): the main
 * branch, the commit and the repository for a push; the base, the commit and the repository for the
 * CI. Refused with `FORGE_GESTURE_FAILED` when the repository does not allow it, and with
 * `unchanged` when it is already so.
 */
export async function forgeRecordOf(
  context: CommandContext,
  action: Extract<CreatorAction, { kind: ForgeKind }>,
  reason: string,
): Promise<
  { readonly record: CreatorActionRecord; readonly already: boolean } | AgentPluggedError
> {
  switch (action.kind) {
    case "forge_repo_create": {
      const plan = await planCreate(context, action);
      if (plan instanceof AgentPluggedError) return plan;
      return { record: { ...action, reason }, already: plan.already };
    }
    case "forge_push_main": {
      const plan = await planPush(context, action.kind);
      if (plan instanceof AgentPluggedError) return plan;
      return {
        record: {
          ...action,
          branch: plan.branch,
          commit: plan.commit,
          target: plan.target,
          reason,
        },
        already: plan.already,
      };
    }
    case "forge_merge_ci": {
      const plan = await planMerge(context, action.branch);
      if (plan instanceof AgentPluggedError) return plan;
      return {
        record: {
          ...action,
          base: plan.base,
          commit: plan.commit,
          target: plan.target,
          files: [...plan.files],
          reason,
        },
        already: plan.already,
      };
    }
    case "release": {
      const plan = await planRelease(context);
      if (plan instanceof AgentPluggedError) return plan;
      return {
        record: {
          ...action,
          from: plan.from,
          to: plan.to,
          commit: plan.commit,
          ...(plan.target === undefined ? {} : { target: plan.target }),
          stories: plan.stories.length,
          reason,
        },
        already: plan.already,
      };
    }
  }
}

/**
 * What is checked at the approval, before it is written, and again right before the gesture: the
 * repository still allows it and the facts of the request still hold (`CREATOR_ACTION_STALE`
 * `head_moved`: the branch has a newer commit; `target_changed`: origin points elsewhere). Returns
 * `already` when there is nothing to do.
 */
export async function forgeGestureCheck(
  context: CommandContext,
  checkpoint: string | undefined,
  record: CreatorActionRecord,
): Promise<
  | {
      readonly already: boolean;
      readonly journal?: boolean;
      readonly plan?: MergePlan | ReleasePlan;
    }
  | AgentPluggedError
> {
  switch (record.kind) {
    case "forge_repo_create": {
      const plan = await planCreate(context, record);
      return plan instanceof AgentPluggedError
        ? plan
        : { already: plan.already, journal: plan.journal };
    }
    case "forge_push_main": {
      const plan = await planPush(context, record.kind);
      if (plan instanceof AgentPluggedError) return plan;
      if (plan.target !== record.target) {
        return stale(checkpoint, record.kind, "target_changed", { target: record.target });
      }
      if (plan.branch !== record.branch || plan.commit !== record.commit) {
        return stale(checkpoint, record.kind, "head_moved", {
          commit: record.commit,
          head: plan.commit,
        });
      }
      return { already: plan.already };
    }
    case "forge_merge_ci": {
      const plan = await planMerge(context, record.branch, record.commit);
      if (plan instanceof AgentPluggedError) return plan;
      if (plan.target !== record.target || plan.base !== record.base) {
        return stale(checkpoint, record.kind, "target_changed", { target: record.target });
      }
      if (plan.commit !== record.commit) {
        return stale(checkpoint, record.kind, "head_moved", {
          commit: record.commit,
          head: plan.commit,
        });
      }
      return { already: plan.already, plan };
    }
    case "release": {
      const plan = await planRelease(context);
      if (plan instanceof AgentPluggedError) return plan;
      if (plan.from !== record.from || plan.to !== record.to || plan.target !== record.target) {
        return stale(checkpoint, record.kind, "target_changed", { target: record.target });
      }
      if (plan.commit !== record.commit) {
        return stale(checkpoint, record.kind, "head_moved", {
          commit: record.commit,
          head: plan.commit,
        });
      }
      return { already: plan.already, plan };
    }
    default:
      return gestureFailed(record.kind, "not_available");
  }
}

/** What a gesture did: done, or already so; the repository and, for the CI, the pull request. */
export interface GestureDone {
  readonly kind: string;
  readonly status: "done" | "already";
  readonly target?: string;
  readonly branch?: string;
  readonly commit?: string;
  readonly pr?: number;
  readonly url?: string;
  readonly merge_commit?: string | null;
}

/**
 * Carries out an approved gesture, once its approval is written and the projection holds it
 * (`afterExecution` checked that): the facts are checked once more, then the engine does it with
 * the forge's tool and Git, never forced. `FORGE_GESTURE_FAILED` when it cannot or the forge
 * refuses; what was done stays done and a new request finds it `already`.
 */
export async function carryOutForgeGesture(
  context: CommandContext,
  checkpoint: string,
  record: CreatorActionRecord,
): Promise<GestureDone | AgentPluggedError> {
  const checked = await forgeGestureCheck(context, checkpoint, record);
  if (checked instanceof AgentPluggedError) return checked;
  const forge = context.storyForge as StoryForge;
  try {
    switch (record.kind) {
      case "forge_repo_create": {
        if (checked.already) return { kind: record.kind, status: "already" };
        const created = await (
          forge.createRepository as NonNullable<StoryForge["createRepository"]>
        )({
          forge: record.forge,
          host: hostOf(record.forge),
          ...(record.owner === undefined ? {} : { owner: record.owner }),
          name: record.name,
          // The journal's repository is never public, whatever the request says.
          visibility: checked.journal === true ? "private" : (record.visibility ?? "private"),
          ...(checked.journal === true ? { remote: JOURNAL_REMOTE_NAME } : {}),
        });
        if (!created.ok) {
          return gestureFailed(
            record.kind,
            created.reason === "exists" ? "name_taken" : "forge_failed",
            {
              message: oneLine(created.message),
            },
          );
        }
        const located = forgeRepositoryOf(created.remote.url);
        // The journal is sent to the new repository now, not at the next retry.
        void context.journalBackup?.kick();
        return {
          kind: record.kind,
          status: "done",
          ...("forge" in located ? { target: targetOf(located) } : {}),
        };
      }
      case "forge_push_main": {
        if (checked.already) {
          return {
            kind: record.kind,
            status: "already",
            target: record.target,
            branch: record.branch,
            commit: record.commit,
          };
        }
        const pushed = await (forge.pushMain as NonNullable<StoryForge["pushMain"]>)(
          "origin",
          record.branch,
          record.commit,
        );
        if (!pushed.ok) {
          return gestureFailed(
            record.kind,
            pushed.reason === "push_rejected" ? "remote_ahead" : "forge_failed",
            { message: oneLine(pushed.message), branch: record.branch },
          );
        }
        return {
          kind: record.kind,
          status: "done",
          target: record.target,
          branch: record.branch,
          commit: record.commit,
        };
      }
      case "release":
        return await carryOutRelease(context, record, checked.plan as ReleasePlan);
      case "forge_merge_ci": {
        const plan = checked.plan as MergePlan;
        if (plan.already && plan.pullRequest !== undefined) {
          return {
            kind: record.kind,
            status: "already",
            target: record.target,
            branch: record.branch,
            commit: record.commit,
            pr: plan.pullRequest.number,
            url: plan.pullRequest.url,
          };
        }
        const repository = plan.repository;
        let pullRequest = plan.pullRequest;
        if (pullRequest === undefined) {
          pullRequest = await forge.create(repository, {
            base: record.base,
            branch: record.branch,
            title: CI_PULL_REQUEST_TITLE,
            body: `Delivers the CI of the product from branch \`${record.branch}\` (commit ${record.commit.slice(0, 12)}), opened by the engine once the creator approved it.`,
          });
        }
        if (forge.pullRequest === undefined || forge.merge === undefined) {
          return gestureFailed(record.kind, "not_available");
        }
        const current = await forge.pullRequest(repository, pullRequest.number);
        if (current.state === "closed") {
          return gestureFailed(record.kind, "pull_request_closed", { url: pullRequest.url });
        }
        if (current.head !== null && current.head !== record.commit) {
          return gestureFailed(record.kind, "head_moved", { url: pullRequest.url });
        }
        if (current.base !== record.base) {
          return gestureFailed(record.kind, "not_mergeable", { url: pullRequest.url });
        }
        if (current.state === "merged") {
          return {
            kind: record.kind,
            status: "already",
            target: record.target,
            branch: record.branch,
            commit: record.commit,
            pr: pullRequest.number,
            url: pullRequest.url,
            merge_commit: current.merge_commit,
          };
        }
        const loaded = await loadMethodConfig(context.files);
        const method =
          loaded instanceof AgentPluggedError
            ? "merge"
            : (await resolvePullRequestSettings(loaded.config, context.mainBranch)).merge_method;
        const outcome = await forge.merge(repository, pullRequest.number, {
          commit: record.commit,
          method: method === "rebase" && repository.forge === "gitlab" ? "merge" : method,
        });
        if (!outcome.ok) {
          return gestureFailed(
            record.kind,
            outcome.reason === "failed" ? "forge_failed" : outcome.reason,
            { message: oneLine(outcome.message), url: pullRequest.url },
          );
        }
        return {
          kind: record.kind,
          status: "done",
          target: record.target,
          branch: record.branch,
          commit: record.commit,
          pr: pullRequest.number,
          url: pullRequest.url,
          merge_commit: outcome.merge_commit,
        };
      }
      default:
        return gestureFailed(record.kind, "not_available");
    }
  } catch (error) {
    if (error instanceof AgentPluggedError) return error;
    return gestureFailed(record.kind, "forge_failed", { message: oneLine(messageOf(error)) });
  }
}

/** Carries out an approved release: the pull request merged on the forge, or the merge by the engine. */
async function carryOutRelease(
  context: CommandContext,
  record: Extract<CreatorActionRecord, { kind: "release" }>,
  plan: ReleasePlan,
): Promise<GestureDone | AgentPluggedError> {
  const kind = record.kind;
  const done = (extra: Partial<GestureDone> = {}): GestureDone => ({
    kind,
    status: "done",
    ...(record.target === undefined ? {} : { target: record.target }),
    branch: record.to,
    commit: record.commit,
    ...extra,
  });
  if (plan.already) return done({ status: "already" });
  // A merge commit, whatever method the stories use: a squash would make the next release conflict
  // with the same content.
  const method = "merge" as const;

  if (plan.via === "direct") {
    const workspace = context.storyWorkspace;
    if (workspace?.mergeBranch === undefined) return gestureFailed(kind, "not_available");
    const outcome = await workspace.mergeBranch({
      from: record.from,
      into: record.to,
      method,
      message: `${RELEASE_PULL_REQUEST_TITLE}: ${record.from} into ${record.to}`,
      expect: record.commit,
    });
    if (!outcome.ok) {
      const reasons: Record<typeof outcome.reason, ForgeGestureReason> = {
        branch_missing: "branch_missing",
        base_dirty: "base_dirty",
        conflict: "conflict",
        head_moved: "head_moved",
        failed: "merge_failed",
      };
      return gestureFailed(kind, reasons[outcome.reason], {
        message: oneLine(outcome.message),
        branch: outcome.reason === "base_dirty" ? record.to : record.from,
      });
    }
    return done({ merge_commit: outcome.merge_commit });
  }

  const forge = context.storyForge as StoryForge;
  const repository = plan.repository as ForgeRepository;
  const remote = plan.remote as string;
  if (forge.pullRequest === undefined || forge.merge === undefined) {
    return gestureFailed(kind, "not_available");
  }
  // Staging is published first (a fast-forward of what the remote holds, never forced).
  if (plan.published === "missing" || plan.published === "behind") {
    const pushed = await (forge.pushMain as NonNullable<StoryForge["pushMain"]>)(
      remote,
      record.from,
      record.commit,
    );
    if (!pushed.ok) {
      return gestureFailed(
        kind,
        pushed.reason === "push_rejected" ? "remote_ahead" : "forge_failed",
        { message: oneLine(pushed.message), branch: record.from },
      );
    }
  }
  let pullRequest = plan.pullRequest;
  if (pullRequest === undefined) {
    pullRequest = await forge.create(repository, {
      base: record.to,
      branch: record.from,
      title: `${RELEASE_PULL_REQUEST_TITLE}: ${record.from} into ${record.to}`,
      body: `Puts what waits in ${record.from} (commit ${record.commit.slice(0, 12)}) into ${record.to}, which is production. Opened by the engine once the creator approved the release.${record.stories === undefined ? "" : ` ${record.stories} merged stories.`}`,
    });
  }
  const current = await forge.pullRequest(repository, pullRequest.number);
  if (current.state === "closed") {
    return gestureFailed(kind, "pull_request_closed", { url: pullRequest.url });
  }
  if (current.head !== null && current.head !== record.commit) {
    return gestureFailed(kind, "head_moved", { url: pullRequest.url });
  }
  if (current.base !== undefined && current.base !== null && current.base !== record.to) {
    return gestureFailed(kind, "not_mergeable", { url: pullRequest.url });
  }
  if (current.state === "merged") {
    return done({
      status: "already",
      pr: pullRequest.number,
      url: pullRequest.url,
      merge_commit: current.merge_commit,
    });
  }
  const outcome = await forge.merge(repository, pullRequest.number, {
    commit: record.commit,
    method,
  });
  if (!outcome.ok) {
    return gestureFailed(kind, outcome.reason === "failed" ? "forge_failed" : outcome.reason, {
      message: oneLine(outcome.message),
      url: pullRequest.url,
    });
  }
  return done({ pr: pullRequest.number, url: pullRequest.url, merge_commit: outcome.merge_commit });
}
