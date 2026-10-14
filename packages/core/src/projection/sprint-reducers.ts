import { SPRINT_EVENT_TYPES, type SprintPlannedPayload, sprintIdOf } from "@agentplugged/protocol";
import { type SprintState, sprintCheckpoints } from "../sprints/sprint-rules.js";
import { dictionary } from "./agent-reducers.js";
import type { CheckpointState } from "./checkpoint-reducers.js";
import type { ProjectionDraft, Reducer } from "./reducers.js";

/**
 * The checkpoint a `sprint.planned` names, when it is the one its write opened: a `document`
 * checkpoint, opened by the same agent, by the event this one chains on (the same append), and
 * named by no other sprint.
 */
function ownCheckpoint(
  draft: ProjectionDraft,
  sprints: Readonly<Record<string, SprintState>>,
  eventId: string,
  agent: string,
  id: string,
): boolean {
  const checkpoints = draft.state.checkpoints as Record<string, CheckpointState> | undefined;
  const checkpoint =
    checkpoints !== undefined && Object.hasOwn(checkpoints, id) ? checkpoints[id] : undefined;
  return (
    checkpoint !== undefined &&
    checkpoint.type === "document" &&
    checkpoint.opened_by === agent &&
    draft.parents.get(eventId) === checkpoint.opened_event &&
    !sprintCheckpoints(sprints).has(id)
  );
}

/**
 * The reducer of sprints: `state.sprints[id]`, each sprint as its `sprint.planned`
 * event recorded it, with the agent that proposed it. Whether it is in force follows from its
 * checkpoint, at read time (`currentSprint`). Ignored (`invalid`): an actor that is not an agent,
 * an id already taken, and a checkpoint that is not the `document` one its own write opened, or
 * that another sprint already names.
 */
export const SPRINT_REDUCERS: Readonly<Record<string, Reducer>> = {
  [SPRINT_EVENT_TYPES.planned]: (draft: ProjectionDraft, event) => {
    const agent = event.actor.kind === "agent" ? event.actor.agent : undefined;
    const id = sprintIdOf(event.id);
    let sprints = draft.state.sprints as Record<string, SprintState> | undefined;
    if (sprints === undefined) {
      sprints = dictionary<SprintState>();
      draft.state.sprints = sprints;
    }
    const payload = event.payload as SprintPlannedPayload;
    if (
      agent === undefined ||
      Object.hasOwn(sprints, id) ||
      !ownCheckpoint(draft, sprints, event.id, agent, payload.checkpoint)
    ) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    sprints[id] = {
      id,
      goal: payload.goal,
      stories: payload.stories.map((story) => ({ ...story })),
      capacity: { agents: [...payload.capacity.agents], humans: payload.capacity.humans },
      budget_usd: payload.budget_usd,
      budget_limit_usd: payload.budget_limit_usd ?? null,
      checkpoint: payload.checkpoint,
      planned_by: agent,
      at: event.at,
      event: event.id,
    };
  },
};
