import {
  FAST_TRACK_EVENT_TYPES,
  type FastTrackCheckedPayload,
  type FastTrackEnteredPayload,
  type FastTrackLeftPayload,
  MACHINE_DEVICE_PATTERN,
} from "@agentplugged/protocol";
import { currentDeveloper } from "../agents/agent-aliases.js";
import { agentOf, type StoryState, section } from "./agent-reducers.js";
import type { ProjectionDraft, Reducer } from "./reducers.js";

/**
 * The reducers of a story's fast track. `story.fast_track_entered` is the mode
 * the story carries, accepted only in the write that started it, from its developer;
 * `story.fast_track_checked` is the engine's reading of a commit's changes; `story.fast_track_left`
 * sends the story back to the full lane for good and blocks it until the creator answers. Ignored
 * (`invalid`): an event without a story, a story not started or already merged, an actor that is
 * neither an agent nor a machine's engine, anything out of its place (a second entry, a reading or
 * an exit when the story is not in the fast track).
 */

function storyOf(draft: ProjectionDraft, id: string | undefined): StoryState | undefined {
  if (id === undefined) return undefined;
  const stories = section<StoryState>(draft, "stories");
  return Object.hasOwn(stories, id) ? stories[id] : undefined;
}

/** The story an event may change while it is in the fast track, else undefined. */
function activeStory(draft: ProjectionDraft, id: string | undefined): StoryState | undefined {
  const story = storyOf(draft, id);
  if (story?.started === undefined || story.merged !== undefined) return undefined;
  return story.fast_track?.status === "active" ? story : undefined;
}

function refuse(draft: ProjectionDraft, id: string): void {
  draft.ignored.push({ id, reason: "invalid" });
}

function machine(event: { actor: { kind: string; device: string } }): boolean {
  return event.actor.kind === "system" && MACHINE_DEVICE_PATTERN.test(event.actor.device);
}

export const FAST_TRACK_REDUCERS: Readonly<Record<string, Reducer>> = {
  [FAST_TRACK_EVENT_TYPES.entered]: (draft, event) => {
    const payload = event.payload as FastTrackEnteredPayload;
    const story = storyOf(draft, event.story);
    const started = story?.started;
    if (story === undefined || started === undefined || story.merged !== undefined) {
      refuse(draft, event.id);
      return;
    }
    // Once, in the write that started the story, from the developer who started it.
    const byDeveloper =
      event.actor.kind === "agent" &&
      event.actor.agent === payload.agent &&
      payload.agent === started.agent;
    if (
      story.fast_track !== undefined ||
      !byDeveloper ||
      draft.parents.get(event.id) !== started.event
    ) {
      refuse(draft, event.id);
      return;
    }
    agentOf(draft, event);
    story.fast_track = {
      status: "active",
      agent: payload.agent,
      summary: payload.summary,
      declared: payload.declared,
      entered_at: event.at,
      entered_event: event.id,
    };
  },
  [FAST_TRACK_EVENT_TYPES.checked]: (draft, event) => {
    const payload = event.payload as FastTrackCheckedPayload;
    const story = activeStory(draft, event.story);
    if (story?.fast_track === undefined || (event.actor.kind !== "agent" && !machine(event))) {
      refuse(draft, event.id);
      return;
    }
    if (event.actor.kind === "agent") agentOf(draft, event);
    story.fast_track.checked = {
      commit: payload.commit,
      count: payload.count,
      files: [...payload.files],
      files_truncated: payload.files_truncated === true,
      ok: payload.ok,
      reasons: [...payload.reasons],
      at: event.at,
      event: event.id,
    };
  },
  [FAST_TRACK_EVENT_TYPES.left]: (draft, event) => {
    const payload = event.payload as FastTrackLeftPayload;
    const story = activeStory(draft, event.story);
    const started = story?.started;
    if (story?.fast_track === undefined || started === undefined) {
      refuse(draft, event.id);
      return;
    }
    // The developer leaves for themselves; the engine leaves from a command of any agent or machine.
    const allowed =
      payload.by === "agent"
        ? event.actor.kind === "agent" &&
          event.actor.agent !== undefined &&
          currentDeveloper(event.actor.agent) === currentDeveloper(started.agent)
        : event.actor.kind === "agent" || machine(event);
    if (!allowed) {
      refuse(draft, event.id);
      return;
    }
    if (event.actor.kind === "agent") agentOf(draft, event);
    story.fast_track.status = "left";
    story.fast_track.left = {
      by: payload.by,
      reasons: [...payload.reasons],
      detail: payload.detail ?? null,
      commit: payload.commit ?? null,
      at: event.at,
      event: event.id,
    };
    // Back to the full lane waits for the creator: the story stops where it is.
    if (story.status === "in_progress" || story.status === "in_review") {
      story.status = "blocked";
      story.status_by = { agent: started.agent, at: event.at };
    }
  },
};
