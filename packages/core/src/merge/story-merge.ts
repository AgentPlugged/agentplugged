import {
  ErrorCode,
  MERGE_EVENT_TYPES,
  type MergeFailure,
  type MergeMethod,
  type MergeSource,
  type MethodConfig,
  type ProjectionState,
  type WorktreeKeptReason,
  type WorktreeOutcome,
} from "@agentplugged/protocol";
import { defined, type EventSpec } from "../agent-activity/agent-commands.js";
import type { CommandContext } from "../command.js";
import { commitNoticesWithStory, noticeBranchOf } from "../docs/knowledge-notice.js";
import { AgentPluggedError } from "../errors.js";
import { workflowOf } from "../git/git-workflow.js";
import type { StoryStarted } from "../projection/agent-reducers.js";
import { storyIn } from "../projection/agent-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { isMergeCheckpoint } from "../projection/merge-reducers.js";
import type { StoryWeight } from "../reuse/reuse.js";
import { storyWeight } from "../reuse/weight.js";
import { deliveryRemote, oneLine, targetBranch } from "../stories/pull-request.js";
import { resolvePullRequestSettings } from "../stories/pull-request-settings.js";
import { forgeRepositoryOf, isRepositoryPullRequest } from "../stories/story-forge.js";
import { coherenceProblem } from "./merge-guards.js";
import { changedFiles, storyFiles } from "./story-files.js";

export { changedFiles };

/**
 * The merge of an approved story, shared by the three channels of the creator's
 * answer (`answer_checkpoint`, `ask_creator`, `review`): the engine merges the story's pull request
 * with the forge's tool the creator logged in, on the commit reviewed only, before the answer and
 * `story.merged` are written in one write; then it removes the story's worktree. An agent never
 * calls any of this: only an answer of the creator the engine accepted does.
 */

/** What the engine merged (or found merged): recorded by `story.merged`. */
export interface MergeDone {
  readonly story: string;
  readonly checkpoint: string;
  /** The story's branch (its worktree is removed once the merge is written). */
  readonly branch: string;
  /** The pull request's forge, number and address; null for a merge without a pull request (`direct`). */
  readonly forge: "github" | "gitlab" | null;
  readonly pr: number | null;
  readonly url: string | null;
  /**
   * The story reached `into` without a pull request, the creator having chosen it (the
   * engine merged its branch itself, or the story was built on that branch). `on_base`: it had no
   * branch of its own, nothing was merged and there is no worktree to remove.
   */
  readonly direct?: { readonly into: string; readonly on_base: boolean };
  readonly commit: string;
  readonly merge_commit: string | null;
  readonly method: MergeMethod;
  readonly files: readonly string[];
  readonly files_truncated: boolean;
  /** The weight of its code (lines added and removed, duplicates added), when known. */
  readonly weight?: StoryWeight;
  /** The forge had already merged it on the commit reviewed: recorded without merging again. */
  readonly already: boolean;
}

/** What became of the story's worktree once merged. */
export interface WorktreeAfterMerge {
  readonly status: WorktreeOutcome;
  readonly reason?: WorktreeKeptReason;
  readonly message?: string;
}

/** `MERGE_FAILED`: the engine could not merge; nothing written (except `not_recorded`). */
export function mergeFailed(
  story: string,
  checkpoint: string,
  reason: MergeFailure,
  details: { readonly message?: string; readonly url?: string } = {},
): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.MERGE_FAILED, `error.merge_failed.${reason}`, {
    story,
    checkpoint,
    reason,
    ...(details.message === undefined ? {} : { message: oneLine(details.message) }),
    ...(details.url === undefined ? {} : { url: details.url }),
  });
}

/**
 * `FORGE_NOT_LINKED` for a merge (as the reasons of the pull request): nothing merged nor written; the
 * message says to answer again once the forge is linked.
 */
function forgeNotLinked(
  story: string,
  reason: "no_remote" | "unknown_forge" | "cli_missing" | "not_logged_in",
  details: Readonly<Record<string, unknown>> = {},
): AgentPluggedError {
  return new AgentPluggedError(
    ErrorCode.FORGE_NOT_LINKED,
    `error.merge_forge_not_linked.${reason}`,
    { story, reason, ...details },
  );
}

/**
 * True when an answer makes the engine merge: a decision that lifts the blocks of a story's merge
 * checkpoint (`approved`, `approved_with_reservations`).
 */
export function mergesOn(
  checkpoint:
    | (Pick<CheckpointState, "type" | "story"> & { readonly source?: CheckpointState["source"] })
    | undefined,
  decision: string,
): boolean {
  return (
    checkpoint !== undefined &&
    isMergeCheckpoint(checkpoint) &&
    (decision === "approved" || decision === "approved_with_reservations")
  );
}

/**
 * Merges the story of an approved merge checkpoint, or says why not, before anything is written:
 * 1. its pull request recorded (`no_pull_request`);
 * 2. the forge: the remote the story delivers to, on GitHub or GitLab, the same forge as the pull
 *    request, its tool installed and logged in (`FORGE_NOT_LINKED`,);
 * 3. the pull request at the forge: closed without a merge (`pull_request_closed`); merged on
 *    the commit reviewed (recorded as `already`, whoever merged it and whatever the channel of the
 *    approval: the creator's gesture at the forge is recorded, never refused); merged
 *    open on another commit (`head_moved`): merged on another commit than the one
 *    reviewed (the creator added commits on the forge) is recorded on the commit the forge merged;
 * 4. the merge of the commit reviewed only (the forge checks it again): refused (`head_moved`,
 *    `not_mergeable`) or failed (`forge_failed`).
 * The merge gate (green CI on the branch's head, done review, no deviation) is the caller's: it
 * is checked first, with the rest of the answer.
 */
export async function mergeStory(
  context: CommandContext,
  config: MethodConfig,
  state: ProjectionState["state"],
  checkpoint: Pick<CheckpointState, "id" | "story">,
  head: string | undefined,
): Promise<MergeDone | AgentPluggedError> {
  const id = checkpoint.story as string;
  const story = storyIn(state, id);
  const started = story?.started;
  const pr = story?.pull_request;
  const failed = (reason: MergeFailure, details?: { message?: string; url?: string }) =>
    mergeFailed(id, checkpoint.id, reason, details);
  // The creator's workflow has no pull request (a direct merge, or a story built on the
  // branch it lands on): the engine merges the branch itself, or finds the story already there.
  const flow = workflowOf(state).resolved;
  if (started !== undefined && (flow.merge === "direct" || started.worktree === ".")) {
    return mergeDirect(context, config, state, checkpoint, started, head);
  }
  if (started === undefined || pr === undefined) return failed("no_pull_request");
  // The commit reviewed: the branch's head as Git reads it here, which the gate checked is the
  // CI's and the review's. Never merged without it.
  if (head === undefined) return failed("head_unreadable");
  const commit = head;
  const forge = context.storyForge;
  if (forge?.merge === undefined || forge.pullRequest === undefined) {
    return failed("forge_failed", { message: "the forge's tool is not available here" });
  }
  try {
    const inspection = await forge.inspect(started.branch, started.base);
    if (!inspection.repository) {
      return new AgentPluggedError(ErrorCode.NOT_A_GIT_REPO, "error.not_a_git_repo", {
        path: ".",
      });
    }
    const remote = deliveryRemote(inspection.remotes, started.base_ref);
    if (remote === undefined) return forgeNotLinked(id, "no_remote");
    const located = forgeRepositoryOf(remote.url);
    if (!("forge" in located) || located.forge !== pr.forge) {
      return forgeNotLinked(id, "unknown_forge", {
        remote: remote.name,
        host: ("host" in located ? located.host : undefined) ?? "local",
      });
    }
    // The repository the pull request was recorded on, never another one a remote names now.
    if (!isRepositoryPullRequest(located, pr.url, pr.number)) {
      return failed("other_repository", { url: pr.url });
    }
    const cli = await forge.cli(located);
    if (cli !== "ready") {
      return forgeNotLinked(id, cli === "missing" ? "cli_missing" : "not_logged_in", {
        forge: located.forge,
        host: located.host,
        cli: located.forge === "github" ? "gh" : "glab",
      });
    }
    const settings = await resolvePullRequestSettings(config, context.mainBranch);
    // GitLab's API cannot ask for a rebase (the project's settings decide it): never recorded
    // as a method the forge did not apply.
    if (located.forge === "gitlab" && settings.merge_method === "rebase") {
      return failed("method_unsupported", { url: pr.url });
    }
    const current = await forge.pullRequest(located, pr.number);
    const files_ = await storyFiles(context, started, commit);
    const { files, truncated } = files_;
    const done = (
      merge_commit: string | null,
      already: boolean,
      weight: StoryWeight | undefined,
    ): MergeDone => ({
      story: id,
      checkpoint: checkpoint.id,
      branch: started.branch,
      forge: located.forge,
      pr: pr.number,
      url: pr.url,
      commit,
      merge_commit,
      method: settings.merge_method,
      files,
      files_truncated: truncated,
      ...(weight === undefined ? {} : { weight }),
      already,
    });
    if (current.state === "closed") return failed("pull_request_closed", { url: pr.url });
    // The workflow changed since the pull request opened and it was not updated: merging it would
    // put the story on another branch than the creator's workflow names now.
    if (
      current.state === "open" &&
      current.base !== undefined &&
      current.base !== null &&
      current.base !== targetBranch(started.base_ref, inspection.remotes)
    ) {
      return failed("base_changed", { url: pr.url });
    }
    if (current.state === "merged") {
      // Merged before this answer (by the creator at the forge, or by this engine when a write was
      // refused after its merge): recorded as `already`. On the commit the forge merged,
      // even when it is not the one reviewed (the creator added commits on the forge): their gesture.
      const weight = await storyWeight(context, files_.diff, commit);
      return { ...done(current.merge_commit, true, weight), commit: current.head ?? commit };
    }
    if (current.head !== null && current.head !== commit) {
      return failed("head_moved", { url: pr.url });
    }
    // The order of the merges and the conflicts, read before the forge merges (a pull
    // request the forge already holds as merged is recorded whatever the order).
    const incoherent = await coherenceProblem(context, state, id, checkpoint.id, commit);
    if (incoherent !== undefined) return incoherent;
    // The weight of the code is read (within its own time limit) before the forge merges: nothing
    // slow follows the merge, which the journal must record.
    const weight = await storyWeight(context, files_.diff, commit);
    const outcome = await forge.merge(located, pr.number, {
      commit,
      method: settings.merge_method,
    });
    if (!outcome.ok) {
      return failed(outcome.reason === "failed" ? "forge_failed" : outcome.reason, {
        message: outcome.message,
        url: pr.url,
      });
    }
    return done(outcome.merge_commit, false, weight);
  } catch (error) {
    if (error instanceof AgentPluggedError) return error;
    return failed("forge_failed", {
      message: error instanceof Error ? error.message : String(error),
      url: pr.url,
    });
  }
}

/**
 * The merge of a story without a pull request, by the engine itself: the story's
 * branch into the branch the creator's workflow lands the stories on, Git's merge in a folder where
 * that branch is checked out clean or in a temporary one, never pushed, never forced. A story built
 * on that branch has nothing to merge: it is delivered where it is, at the commit reviewed.
 */
async function mergeDirect(
  context: CommandContext,
  config: MethodConfig,
  state: ProjectionState["state"],
  checkpoint: Pick<CheckpointState, "id" | "story">,
  started: StoryStarted,
  head: string | undefined,
): Promise<MergeDone | AgentPluggedError> {
  const id = checkpoint.story as string;
  const failed = (reason: MergeFailure, details?: { message?: string }) =>
    mergeFailed(id, checkpoint.id, reason, details);
  if (head === undefined) return failed("head_unreadable");
  const commit = head;
  const onBase = started.worktree === ".";
  const into = onBase ? started.branch : targetBranchOf(started.base_ref);
  try {
    // The order of the merges and the conflicts, read before anything moves.
    const incoherent = await coherenceProblem(context, state, id, checkpoint.id, commit);
    if (incoherent !== undefined) return incoherent;
    const settings = await resolvePullRequestSettings(config, context.mainBranch);
    const read = await storyFiles(context, started, commit);
    const { files, truncated } = read;
    // Before anything moves: the merge done, nothing slow follows.
    const weight = await storyWeight(context, read.diff, commit);
    const done = (merge_commit: string | null): MergeDone => ({
      story: id,
      checkpoint: checkpoint.id,
      branch: started.branch,
      forge: null,
      pr: null,
      url: null,
      direct: { into, on_base: onBase },
      commit,
      merge_commit,
      method: settings.merge_method,
      files,
      files_truncated: truncated,
      ...(weight === undefined ? {} : { weight }),
      already: false,
    });
    if (onBase) {
      if (noticeBranchOf(state) === into) {
        await commitNoticesWithStory(context, state, { id, files }, into);
      }
      return done(null);
    }
    const workspace = context.storyWorkspace;
    if (workspace?.mergeBranch === undefined) {
      return failed("direct_failed", { message: "Git's merge is not available here" });
    }
    const outcome = await workspace.mergeBranch({
      from: started.branch,
      into,
      method: settings.merge_method,
      message: `Merge story ${id}`,
      expect: commit,
    });
    if (!outcome.ok) {
      const reason: Record<typeof outcome.reason, MergeFailure> = {
        branch_missing: "base_missing",
        base_dirty: "base_dirty",
        conflict: "direct_conflict",
        head_moved: "head_moved",
        failed: "direct_failed",
      };
      return failed(reason[outcome.reason], { message: outcome.message });
    }
    if (noticeBranchOf(state) === into) {
      await commitNoticesWithStory(context, state, { id, files }, into);
    }
    return { ...done(outcome.merge_commit), already: outcome.merge_commit === null };
  } catch (error) {
    if (error instanceof AgentPluggedError) return error;
    return failed("direct_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** `origin/dev` is `dev`; a ref without a remote stays as it is. */
function targetBranchOf(ref: string): string {
  return ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
}

/** The `story.merged` of a merge, written right after the creator's approval. */
export function mergedEvent(merge: MergeDone, source: MergeSource): EventSpec {
  return {
    type: MERGE_EVENT_TYPES.merged,
    story: merge.story,
    payload: defined({
      checkpoint: merge.checkpoint,
      ...(merge.direct === undefined
        ? { forge: merge.forge, pr: merge.pr, url: merge.url }
        : { direct: true, into: merge.direct.into }),
      commit: merge.commit,
      merge_commit: merge.merge_commit ?? undefined,
      method: merge.method,
      files: [...merge.files],
      files_truncated: merge.files_truncated ? true : undefined,
      weight: merge.weight === undefined ? undefined : { ...merge.weight },
      source,
      already: merge.already ? true : undefined,
    }),
  };
}

/**
 * Removes a merged story's worktree: never forced, never another folder than the
 * story's own; never a failure of the command that merged.
 */
export async function removeMergedWorktree(
  context: CommandContext,
  story: string,
  branch: string,
): Promise<WorktreeAfterMerge> {
  const workspace = context.storyWorkspace;
  if (workspace?.removeWorktree === undefined) return { status: "kept", reason: "unavailable" };
  try {
    const removal = await workspace.removeWorktree({ id: story, branch });
    if (removal.status !== "kept") return { status: removal.status };
    return {
      status: "kept",
      reason: removal.reason,
      ...(removal.message === undefined ? {} : { message: oneLine(removal.message) }),
    };
  } catch (error) {
    return {
      status: "kept",
      reason: "failed",
      message: oneLine(error instanceof Error ? error.message : String(error)),
    };
  }
}

/** What each channel returns of a merge: what was merged, and the worktree. */
export type MergeResult = Omit<MergeDone, "files" | "files_truncated" | "checkpoint"> & {
  /** How many files the story changed (recorded in `story.merged`). */
  readonly files: number;
  readonly worktree: WorktreeAfterMerge;
};

/** The merge a channel returns, once written: the worktree removed. */
export async function afterMerge(context: CommandContext, merge: MergeDone): Promise<MergeResult> {
  // A story built on the branch it landed on has no worktree of its own.
  const worktree: WorktreeAfterMerge =
    merge.direct?.on_base === true
      ? { status: "absent" }
      : await removeMergedWorktree(context, merge.story, merge.branch);
  const { files, files_truncated: _truncated, checkpoint: _checkpoint, ...rest } = merge;
  return { ...rest, files: files.length, worktree };
}

/**
 * The merges done in this process whose write is not known yet, by checkpoint: a write refused
 * after the forge merged turns into `MERGE_FAILED` `not_recorded` (answer again: the merge,
 * found at the forge, is then recorded).
 */
const pending = new Map<string, { readonly merge: MergeDone; readonly token: symbol }>();

/** Notes a merge done for the call that holds `token` (`CommandContext.mergeToken`). */
export function notePendingMerge(merge: MergeDone, token: symbol | undefined): void {
  if (token !== undefined) pending.set(merge.checkpoint, { merge, token });
}

/**
 * The merge already done by this very call for a checkpoint, kept: a write planned again
 * (another writer came first) reuses it instead of asking the forge again.
 */
export function pendingMergeOf(
  checkpoint: string,
  token: symbol | undefined,
): MergeDone | undefined {
  const entry = pending.get(checkpoint);
  return entry !== undefined && entry.token === token ? entry.merge : undefined;
}

/** The merge this call noted for a checkpoint, forgotten once read; another call's stays. */
export function takePendingMerge(checkpoint: string, token: symbol): MergeDone | undefined {
  const entry = pending.get(checkpoint);
  if (entry === undefined || entry.token !== token) return undefined;
  pending.delete(checkpoint);
  return entry.merge;
}

/** `MERGE_FAILED` `not_recorded`, with what refused the write. */
export function notRecorded(merge: MergeDone, cause: AgentPluggedError): AgentPluggedError {
  return mergeFailed(merge.story, merge.checkpoint, "not_recorded", {
    message: `${cause.code}`,
    ...(merge.url === null ? {} : { url: merge.url }),
  });
}
