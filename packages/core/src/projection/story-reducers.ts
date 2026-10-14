import {
  CREATOR_OWNER,
  MACHINE_DEVICE_PATTERN,
  MAIN_SESSION_AGENT,
  STORY_EVENT_TYPES,
  type StoryPrOpenedPayload,
  type StoryStartedPayload,
} from "@agentplugged/protocol";
import { storyDoneAt } from "../sprints/sprint-rules.js";
import { agentOf, instanceOf, storyById } from "./agent-reducers.js";
import { type CheckpointState, closeLiftedBlocks } from "./checkpoint-reducers.js";
import type { ProjectionDraft, Reducer } from "./reducers.js";

/**
 * The reducer of a story's start: `story.started` moves the story to `in_progress`,
 * given by the agent that builds it, and records how it started (`started`). Written by an agent
 * for itself (the MCP server), or by a machine (`system`, the CLI). Ignored (`invalid`): any other
 * actor, an agent naming another builder, an event without a story, a story already started (the
 * first in projection order wins) or already given a status, and a story done.
 */
export const STORY_REDUCERS: Readonly<Record<string, Reducer>> = {
  [STORY_EVENT_TYPES.started]: (draft: ProjectionDraft, event) => {
    const payload = event.payload as StoryStartedPayload;
    const byAgent = event.actor.kind === "agent" && event.actor.agent === payload.agent;
    const bySystem =
      event.actor.kind === "system" && MACHINE_DEVICE_PATTERN.test(event.actor.device);
    if ((!byAgent && !bySystem) || event.story === undefined) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    const story = storyById(draft, event.story);
    const checkpoints = Object.values(
      (draft.state.checkpoints as Record<string, CheckpointState> | undefined) ?? {},
    );
    if (
      story.started !== undefined ||
      story.status !== null ||
      storyDoneAt(checkpoints, event.story, story) !== undefined
    ) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    // The instance that builds it, started by the agent or by the CLI for an agent.
    if (payload.agent !== CREATOR_OWNER && payload.agent !== MAIN_SESSION_AGENT) {
      instanceOf(draft, payload.agent, event.story, event.at);
    }
    if (byAgent) agentOf(draft, event);
    story.status = "in_progress";
    story.status_by = { agent: payload.agent, at: event.at };
    story.started = {
      agent: payload.agent,
      branch: payload.branch,
      base: payload.base,
      base_ref: payload.base_ref,
      worktree: payload.worktree,
      device: event.actor.device,
      at: event.at,
      event: event.id,
    };
    // What a `blocked` result said about the story is over once it started.
    closeLiftedBlocks(draft, event.story, event);
  },
  /**
   * A story's pull request: the last `story.pr_opened` is its `pull_request`; the
   * story's status does not change. Ignored (`invalid`): an event without a story, or an actor
   * that is neither an agent nor a machine's engine (`system`).
   */
  [STORY_EVENT_TYPES.prOpened]: (draft: ProjectionDraft, event) => {
    const payload = event.payload as StoryPrOpenedPayload;
    const byAgent = event.actor.kind === "agent" && event.actor.agent !== undefined;
    const bySystem =
      event.actor.kind === "system" && MACHINE_DEVICE_PATTERN.test(event.actor.device);
    if ((!byAgent && !bySystem) || event.story === undefined) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    if (byAgent) agentOf(draft, event);
    const story = storyById(draft, event.story);
    story.pull_request = {
      forge: payload.forge,
      number: payload.number,
      url: payload.url,
      branch: payload.branch,
      base: payload.base,
      head: payload.head,
      criteria: [...payload.criteria],
      tests: payload.tests,
      tests_summary: payload.tests_summary ?? null,
      body_sha256: payload.body_sha256,
      by: byAgent ? (event.actor.agent ?? null) : null,
      at: event.at,
      event: event.id,
    };
  },
};
