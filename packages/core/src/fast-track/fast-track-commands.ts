import {
  CHECKPOINT_EVENT_TYPES,
  ErrorCode,
  FAST_TRACK_EVENT_TYPES,
  type FastTrackRefusal,
  LeaveFastTrackInputSchema,
} from "@agentplugged/protocol";
import { agentEventCommand } from "../agent-activity/agent-commands.js";
import { AgentPluggedError } from "../errors.js";
import { storyIn } from "../projection/agent-reducers.js";
import { checkpointsOf } from "../projection/checkpoint-reducers.js";
import { isStoryDeveloper } from "../review/review-rules.js";
import { storyDoneAt } from "../sprints/sprint-rules.js";
import { exitCheckpointPayload } from "./fast-track-check.js";
import { openExitCheckpoint } from "./fast-track-rules.js";

/**
 * `FAST_TRACK_NOT_POSSIBLE`: the fast track cannot be entered or left; nothing written
 *.
 */
export function fastTrackNotPossible(
  story: string,
  reason: FastTrackRefusal,
  details: Readonly<Record<string, unknown>> = {},
): AgentPluggedError {
  return new AgentPluggedError(
    ErrorCode.FAST_TRACK_NOT_POSSIBLE,
    `error.fast_track_not_possible.${reason}`,
    { story, reason, ...details },
  );
}

/** Why `agent` cannot send the story back to the full lane now, or undefined. */
export function leaveProblem(
  state: Readonly<Record<string, unknown>> | undefined,
  id: string,
  agent: string,
): AgentPluggedError | undefined {
  const story = storyIn(state, id);
  if (story?.started === undefined) return fastTrackNotPossible(id, "not_started");
  const checkpoints = Object.values(checkpointsOf(state ?? {}));
  if (storyDoneAt(checkpoints, id, story) !== undefined) return fastTrackNotPossible(id, "done");
  if (!isStoryDeveloper(story, agent)) {
    return fastTrackNotPossible(id, "not_builder", { agent, builder: story.started.agent });
  }
  if (story.fast_track === undefined) return fastTrackNotPossible(id, "not_fast_track");
  if (story.fast_track.status === "left") return fastTrackNotPossible(id, "already_left");
  return undefined;
}

/**
 * `leave_fast_track`: the developer of a story in the fast track sends it back to the full lane
 * when they find an ambiguity of intent, an action that could not be undone or
 * a scope that grows: a step out of the fast track, never a way to skip a review.
 */
export const leaveFastTrackCommand = agentEventCommand({
  name: "leave_fast_track",
  description:
    "Send a story you build in the fast track back to the full lane. Call it the moment you find that the goal can be read two ways (`ambiguous_intent`), a step could not be undone (`irreversible_action`), the change keeps growing past a small change (`growing_scope`), or it needs a public interface change (`public_interface`), a data migration (`data_migration`) or a new dependency (`new_dependency`): `reasons` (each once) and `detail`, what you found, for the creator. Never bend a limit to keep a change in the fast track. The engine records the exit, blocks the story and opens, in the same write, a `decision` checkpoint that explains it to the creator (continue in the full lane, or stop); the way back is final. Do not open a checkpoint of your own, do not move the story's status: hand back to Noah with `submit_result` (`partial`). The engine also leaves the fast track itself, with the same checkpoint, when it reads a commit of the story that touches 5 files or more, a dependency manifest, a migration or an interface's contract. Refused with FAST_TRACK_NOT_POSSIBLE, nothing written (not_started: the story is unknown or never started, done, not_builder: only the story's developer leaves it, not_fast_track: the story is in the full lane, already_left).",
  inputSchema: LeaveFastTrackInputSchema,
  needsState: () => true,
  replanned: true,
  events: ({ story, reasons, detail }, state) => {
    const checkpoints = Object.values(checkpointsOf(state ?? {}));
    const events: {
      type: string;
      story: string;
      payload: Record<string, unknown>;
    }[] = [
      {
        type: FAST_TRACK_EVENT_TYPES.left,
        story,
        payload: { by: "agent", reasons, detail },
      },
    ];
    if (openExitCheckpoint(checkpoints, story) === undefined) {
      events.push({
        type: CHECKPOINT_EVENT_TYPES.opened,
        story,
        payload: exitCheckpointPayload(story, "agent", reasons, detail),
      });
    }
    return { events };
  },
  check: (input, state) => leaveProblem(state, input.story, input.agent),
});
