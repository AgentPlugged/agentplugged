import {
  CHECKPOINT_CLOSED_EVENT_TYPES,
  CHECKPOINT_EVENT_TYPES,
  MERGE_EVENT_TYPES,
  type MethodConfig,
  type ProjectionState,
} from "@agentplugged/protocol";
import { project } from "../agent-activity/agent-commands.js";
import { type SettledContext, settledPoints } from "../checkpoints/settled-rules.js";
import type { CommandContext } from "../command.js";
import { METHOD_CONFIG_PATH } from "../init/layout.js";
import { loadMethodConfig } from "../init/method-config.js";
import type { EventDraft, StateStore } from "../journal/state-store.js";
import { dueMergePoints, skippedMergeCheckpoint } from "../journey/merge-point.js";
import type { StoryState } from "../projection/agent-reducers.js";
import { storiesIn } from "../projection/agent-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { storyWeight } from "../reuse/weight.js";
import { deliveryRemote, targetBranch } from "../stories/pull-request.js";
import { resolvePullRequestSettings } from "../stories/pull-request-settings.js";
import { forgeRepositoryOf, isRepositoryPullRequest } from "../stories/story-forge.js";
import { storyFiles } from "./story-files.js";
import { removeMergedWorktree } from "./story-merge.js";

/**
 * The engine follows the forge. What the creator does on GitHub or GitLab is their own
 * gesture, never one to "regularise": a pull request merged by hand is recorded as the creator's
 * merge (`story.merged`, source `forge`, with the account, the date and the commit the forge gives),
 * the story is done, and the points that waited for it are closed. The points whose object is
 * settled (a story merged, a review done again, a request replaced) are closed by the engine with
 * their reason (`checkpoint.closed`), so that none is ever shown to the creator.
 *
 * Read at `next`, `get_state` and `check_ci`. Best effort: it never throws, never asks anything,
 * and a forge that cannot be reached leaves things as they are.
 */

const DEFAULT_THROTTLE_MS = 20_000;

/** When the forge was last read, by journal (the journal object stands for the product here). */
const lastRead = new WeakMap<StateStore, number>();

type State = ProjectionState["state"];

/** The stories whose pull request the forge may have merged: started, not merged, with one. */
function followable(state: State): Array<[string, StoryState]> {
  return Object.entries(storiesIn(state)).filter(
    ([, story]) =>
      story.started !== undefined && story.merged === undefined && story.pull_request !== undefined,
  );
}

/** The `story.merged` payload of a pull request the forge shows merged, or undefined. */
async function forgeMerge(
  context: CommandContext,
  config: MethodConfig,
  state: State,
  id: string,
  story: StoryState,
): Promise<Record<string, unknown> | undefined> {
  const forge = context.storyForge;
  const started = story.started;
  const pr = story.pull_request;
  if (forge?.pullRequest === undefined || started === undefined || pr === undefined) {
    return undefined;
  }
  const inspection = await forge.inspect(started.branch, started.base);
  if (!inspection.repository) return undefined;
  const remote = deliveryRemote(inspection.remotes, started.base_ref);
  if (remote === undefined) return undefined;
  const located = forgeRepositoryOf(remote.url);
  if (!("forge" in located) || located.forge !== pr.forge) return undefined;
  if (!isRepositoryPullRequest(located, pr.url, pr.number)) return undefined;
  const current = await forge.pullRequest(located, pr.number);
  if (current.state !== "merged") return undefined;
  // Merged into another branch than the main one (a stacked pull request): nothing was delivered.
  if (
    current.base !== undefined &&
    current.base !== null &&
    current.base !== targetBranch(started.base_ref, inspection.remotes)
  ) {
    return undefined;
  }
  const commit = current.head ?? pr.head;
  const settings = await resolvePullRequestSettings(config, context.mainBranch);
  const files = await storyFiles(context, started, commit).catch(() => undefined);
  const weight = await storyWeight(context, files?.diff, commit);
  const checkpoints = (state.checkpoints as Record<string, CheckpointState> | undefined) ?? {};
  const open = Object.values(checkpoints).find(
    (checkpoint) =>
      checkpoint.story === id && checkpoint.source === "merge" && checkpoint.status === "open",
  );
  return {
    ...(open === undefined ? {} : { checkpoint: open.id }),
    forge: pr.forge,
    pr: pr.number,
    url: pr.url,
    commit,
    ...(current.merge_commit === null ? {} : { merge_commit: current.merge_commit }),
    method: settings.merge_method,
    files: files?.files ?? [],
    ...(files?.truncated === true ? { files_truncated: true } : {}),
    ...(weight === undefined ? {} : { weight }),
    source: "forge",
    already: true,
    merged_by: current.merged_by ?? "forge",
    merged_at: current.merged_at ?? new Date((context.now ?? Date.now)()).toISOString(),
  };
}

/**
 * The stories whose working copy is gone from the disk, among those a permission point still open
 * is about: started, not merged, no folder checked out and nothing at the expected
 * place. Only the disk of this machine says so, so the engine reads it here; a repository it cannot
 * read leaves every story as it is (never a point closed on a doubt).
 */
async function goneWorktrees(context: CommandContext, state: State): Promise<ReadonlySet<string>> {
  const workspace = context.storyWorkspace;
  const gone = new Set<string>();
  if (workspace === undefined) return gone;
  const stories = storiesIn(state);
  const checkpoints = (state.checkpoints as Record<string, CheckpointState> | undefined) ?? {};
  const asked = new Set<string>();
  for (const checkpoint of Object.values(checkpoints)) {
    if (
      checkpoint.status === "open" &&
      checkpoint.type === "permission" &&
      checkpoint.story !== null
    ) {
      asked.add(checkpoint.story);
    }
  }
  for (const id of asked) {
    const started = Object.hasOwn(stories, id) ? stories[id]?.started : undefined;
    if (started === undefined || stories[id]?.merged !== undefined) continue;
    try {
      const seen = await workspace.inspect({ id, branch: started.branch, path: "" });
      // The branch is here but its folder is not: removed on this machine. A story built on another
      // machine has neither, and is not gone.
      if (
        seen.repository &&
        seen.branch !== null &&
        seen.checkedOut === null &&
        !seen.target.exists
      ) {
        gone.add(id);
      }
    } catch {
      // Unreadable: the point stays.
    }
  }
  return gone;
}

/**
 * Reads the forge and the journal, and writes what follows: the merges the creator did on the forge,
 * then the closing of the points whose object is settled. Returns how many events it wrote (0 when
 * nothing changed or anything went wrong). `force` reads the forge even if it was read a moment ago.
 */
export async function followForge(
  context: CommandContext,
  options: { readonly force?: boolean } = {},
): Promise<number> {
  try {
    const journal = context.journal;
    if (journal === undefined || !(await context.files.exists(METHOD_CONFIG_PATH))) return 0;
    const loaded = await loadMethodConfig(context.files);
    if (!("config" in loaded)) return 0;
    const config = loaded.config;
    const product = config.product_id ?? (await journal.productId());
    if (product === null) return 0;
    const clock = context.now ?? Date.now;
    const throttle = context.forgeThrottleMs ?? DEFAULT_THROTTLE_MS;
    const before = lastRead.get(journal);
    const readForge =
      options.force === true || before === undefined || clock() - before >= throttle;
    let written = 0;
    const merged: Array<{ id: string; branch: string }> = [];
    if (readForge) {
      lastRead.set(journal, clock());
      const state = (await project(context, config, await journal.list())).state;
      const drafts: EventDraft[] = [];
      for (const [id, story] of followable(state)) {
        const payload = await forgeMerge(context, config, state, id, story).catch(() => undefined);
        if (payload === undefined) continue;
        drafts.push({
          type: MERGE_EVENT_TYPES.merged,
          actor: { kind: "system" },
          product,
          story: id,
          provenance: "trusted",
          payload,
        });
        merged.push({ id, branch: (story.started as { branch: string }).branch });
      }
      if (drafts.length > 0) {
        const events = await journal.appendAll(drafts, {
          precondition: async (current) => {
            const latest = (await project(context, config, current)).state;
            for (const entry of merged) {
              if (storiesIn(latest)[entry.id]?.merged !== undefined) {
                throw new Error("merged meanwhile");
              }
            }
          },
        });
        written += events.length;
      }
    }
    // The points settled now (this merge, an earlier one, a review done again, a replaced request).
    const state = (await project(context, config, await journal.list())).state;
    const gone = await goneWorktrees(context, state);
    const settledContext: SettledContext = {
      now: clock(),
      gone: (story) => gone.has(story),
    };
    const settled = settledPoints(state, settledContext);
    if (settled.length > 0) {
      const events = await journal.appendAll(
        settled.map((point) => ({
          type: CHECKPOINT_CLOSED_EVENT_TYPES.closed,
          actor: { kind: "system" as const },
          product,
          provenance: "trusted" as const,
          payload: {
            checkpoint: point.checkpoint,
            reason: point.reason,
            ...(point.ref === undefined ? {} : { ref: point.ref }),
          },
        })),
      );
      written += events.length;
    }
    // A story in review whose review the creator skipped gets its merge point from the
    // engine (nothing else would open it). Checked again under the journal's lock.
    const due = dueMergePoints(state);
    if (due.length > 0) {
      const events = await journal.appendAll(
        due.map((point) => ({
          type: CHECKPOINT_EVENT_TYPES.opened,
          actor: { kind: "system" as const },
          product,
          story: point.story,
          provenance: "trusted" as const,
          payload: { ...skippedMergeCheckpoint(point) },
        })),
        {
          precondition: async (current) => {
            const latest = (await project(context, config, current)).state;
            const still = new Set(dueMergePoints(latest).map((point) => point.story));
            if (!due.every((point) => still.has(point.story))) throw new Error("opened meanwhile");
          },
        },
      );
      written += events.length;
    }
    // The worktree of a story merged on the forge: removed as after any merge (never forced).
    for (const entry of merged) await removeMergedWorktree(context, entry.id, entry.branch);
    return written;
  } catch {
    return 0;
  }
}
