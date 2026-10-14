import {
  GIT_EVENT_TYPES,
  type GitReleasedPayload,
  type GitWorkflowSetPayload,
  MACHINE_DEVICE_PATTERN,
} from "@agentplugged/protocol";
import type { ReleaseRecord, WorkflowRecord } from "../git/git-workflow.js";
import { type StoryState, section } from "./agent-reducers.js";
import type { ProjectionDraft, Reducer } from "./reducers.js";

/**
 * The reducers of the creator's Git workflow. `git.workflow_set` records the choice
 * (`state.git_workflow`), `git.released` the release of what waited in staging (`state.git_release`).
 * Both are the engine's own writes (`system`, signed by a machine), made once the creator chose or
 * approved: an agent cannot write them, and an event from anyone else changes nothing.
 */

/** The number of merges recorded so far: what waits in staging starts after them. */
function mergesSoFar(draft: ProjectionDraft): number {
  const stories = section<StoryState>(draft, "stories");
  return Object.values(stories).filter((story) => story.merged !== undefined).length;
}

function byMachine(event: { readonly actor: { readonly kind: string; readonly device: string } }) {
  return event.actor.kind === "system" && MACHINE_DEVICE_PATTERN.test(event.actor.device);
}

export const GIT_REDUCERS: Readonly<Record<string, Reducer>> = {
  [GIT_EVENT_TYPES.workflowSet]: (draft, event) => {
    if (!byMachine(event)) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    const payload = event.payload as GitWorkflowSetPayload;
    const record: WorkflowRecord = {
      workflow: payload.workflow,
      forge: payload.forge,
      source: payload.source,
      at: event.at,
      event: event.id,
      merges: mergesSoFar(draft),
    };
    draft.state.git_workflow = record;
    // The stories in progress aim at the branch the creator chose now (nothing of their
    // work is lost: their branch stays, only the branch they land on changes). A story built on the
    // integration branch itself keeps the commit it started from.
    const landing = payload.workflow.integration ?? payload.main;
    if (landing === undefined) return;
    const stories = section<StoryState>(draft, "stories");
    for (const story of Object.values(stories)) {
      const started = story.started;
      if (started === undefined || story.merged !== undefined || started.worktree === ".") continue;
      const remote = started.base_ref.startsWith("origin/");
      (started as { base_ref: string }).base_ref = remote ? `origin/${landing}` : landing;
    }
  },
  [GIT_EVENT_TYPES.released]: (draft, event) => {
    if (!byMachine(event)) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    const payload = event.payload as GitReleasedPayload;
    const record: ReleaseRecord = {
      from: payload.from,
      to: payload.to,
      commit: payload.commit,
      merge_commit: payload.merge_commit ?? null,
      via: payload.via,
      pr: payload.pr ?? null,
      url: payload.url ?? null,
      stories: payload.stories,
      checkpoint: payload.checkpoint,
      at: event.at,
      event: event.id,
      merges: mergesSoFar(draft),
    };
    draft.state.git_release = record;
  },
};
