import {
  type GitCiMode,
  type GitMergeMode,
  type GitWorkflow,
  recommendedGitWorkflow,
} from "@agentplugged/protocol";
import { openDeferred } from "../deferred/deferred-rules.js";
import type { StoryState } from "../projection/agent-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { lastRelease, stagedStories, workflowOf } from "./git-workflow.js";

/**
 * What `next` and `get_state` say of the creator's Git workflow, pure: the choices in
 * force, the recommendation while nothing is chosen, and with a staging branch (`main` + `dev`) what
 * waits there and whether it is the time to put it into production. Noah reads it: he offers the
 * choice once, follows the staging, and proposes the release when the engine's reading says so.
 */

/** One story that waits in staging: merged on the integration branch, not in production yet. */
export interface WaitingStory {
  readonly story: string;
  readonly merged_at: string;
  /** The last CI the story had, or null (a story merged with no CI read). */
  readonly ci: string | null;
}

/** Why the engine would wait before a release, in words Noah says in one sentence. */
export type ReleaseBrake =
  | "stories_in_progress"
  | "ci_not_green"
  | "deferred_open"
  | "blocked"
  | "points_open";

/** The staging branch and what waits there since the last release. */
export interface StagingView {
  /** The integration branch (staging) and the production branch (`null`: the repository's main branch). */
  readonly branch: string;
  readonly production: string | null;
  readonly environments: {
    readonly staging?: { readonly name?: string; readonly url?: string };
    readonly production?: { readonly name?: string; readonly url?: string };
  };
  /** The stories waiting, the oldest first. */
  readonly waiting: readonly WaitingStory[];
  /** Whole days since the oldest waiting story was merged; null when none waits. */
  readonly oldest_days: number | null;
  /** The last release, or null when none was made. */
  readonly last_release: { readonly at: string; readonly stories: number } | null;
  /**
   * What the engine reads before saying « on met en production ? »: the open items of deferred work,
   * the stories blocked, the stories in progress, a story merged without a green CI.
   */
  readonly brakes: readonly ReleaseBrake[];
  /**
   * The engine's reading: `release` (something waits and nothing holds it back: Noah offers it, in
   * one sentence, with the notes), `wait` (something waits and a brake says wait: he says it in
   * one sentence and recommends waiting), `nothing` (nothing waits).
   */
  readonly advice: "release" | "wait" | "nothing";
  /** The release's point is already open on the creator's side: do not offer it again. */
  readonly release_open: boolean;
}

/** The workflow as `next` and `get_state` show it. */
export interface GitView {
  /** The creator chose a workflow; false: the recommendation applies and Noah offers the choice once. */
  readonly chosen: boolean;
  readonly branches: {
    /** The branch the stories land on; null: the main branch. */
    readonly integration: string | null;
    readonly production: string | null;
  };
  readonly story_branches: boolean;
  readonly ci: GitCiMode;
  readonly merge: GitMergeMode;
  readonly review: boolean;
  /** The recommendation for this repository (on a forge or not), always given: « garde la recommandation ». */
  readonly recommended: GitWorkflow;
  /** With a staging branch only. */
  readonly staging?: StagingView;
}

const DAY_MS = 86_400_000;

/** The creator's workflow, the recommendation and, with a staging branch, what waits there. */
export function gitView(
  state: Readonly<Record<string, unknown>>,
  now: number,
  facts: { readonly forge: boolean },
): GitView {
  const view = workflowOf(state);
  const flow = view.resolved;
  const base: GitView = {
    chosen: view.chosen,
    branches: { integration: flow.integration ?? null, production: flow.production ?? null },
    story_branches: flow.story_branches,
    ci: flow.ci,
    merge: flow.merge,
    review: flow.review,
    recommended: recommendedGitWorkflow(facts),
  };
  if (!flow.staged || flow.integration === undefined) return base;

  const stories = (state.stories as Record<string, StoryState> | undefined) ?? {};
  const waiting: WaitingStory[] = stagedStories(state).map((entry) => ({
    story: entry.story,
    merged_at: entry.at,
    ci: stories[entry.story]?.ci?.status ?? null,
  }));
  const oldest = waiting
    .map((entry) => Date.parse(entry.merged_at))
    .filter((time) => Number.isFinite(time))
    .sort((a, b) => a - b)[0];
  const checkpoints = Object.values(
    (state.checkpoints as Record<string, CheckpointState> | undefined) ?? {},
  );
  const brakes: ReleaseBrake[] = [];
  if (
    Object.values(stories).some(
      (story) => story.started !== undefined && story.merged === undefined,
    )
  ) {
    brakes.push("stories_in_progress");
  }
  if (waiting.some((entry) => entry.ci === "fail" || entry.ci === "pending")) {
    brakes.push("ci_not_green");
  }
  if (openDeferred(state).length > 0) brakes.push("deferred_open");
  if (Object.values(stories).some((story) => story.status === "blocked")) brakes.push("blocked");
  // An open point that blocks work: something is not settled yet.
  if (checkpoints.some((point) => point.status === "open" && point.blocks.length > 0)) {
    brakes.push("points_open");
  }
  const last = lastRelease(state);
  const releaseOpen = checkpoints.some(
    (point) =>
      point.status === "open" &&
      point.type === "creator_action" &&
      point.creator_action?.kind === "release",
  );
  // Only a real obstacle says wait: stories still being built are the next release's, not a brake.
  const holding = brakes.filter((brake) => brake !== "stories_in_progress");
  return {
    ...base,
    staging: {
      branch: flow.integration,
      production: flow.production ?? null,
      environments: flow.environments,
      waiting,
      oldest_days: oldest === undefined ? null : Math.max(0, Math.floor((now - oldest) / DAY_MS)),
      last_release: last === undefined ? null : { at: last.at, stories: last.stories.length },
      brakes,
      advice: waiting.length === 0 ? "nothing" : holding.length > 0 ? "wait" : "release",
      release_open: releaseOpen,
    },
  };
}
