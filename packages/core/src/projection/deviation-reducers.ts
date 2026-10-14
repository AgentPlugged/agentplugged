import {
  DEVIATION_EVENT_TYPES,
  type DeviationReportedPayload,
  type DeviationResolvedPayload,
  deviationIdOf,
} from "@agentplugged/protocol";
import { recordById } from "../registers.js";
import { agentMayResolve, type Deviation, storyDeveloper } from "../trace/deviation-rules.js";
import { agentOf, section, startedStory } from "./agent-reducers.js";
import { closerOf } from "./human-reducers.js";
import type { ProjectionDraft, Reducer } from "./reducers.js";

const deviationsOf = (draft: ProjectionDraft) => section<Deviation>(draft, "deviations");

/**
 * The reducers of the deviations: `state.deviations[id]`, each deviation as its
 * `deviation.reported` event wrote it, then its resolution.
 * - `deviation.reported`, by an agent, on a story started and not done. A story in review goes
 *   back to `in_progress`, given by the agent that builds it (its `story.started`), as a failed CI
 *   does: `next` relaunches its developer. Ignored (`invalid`): another actor than an
 *   agent, no story, a story never started or done, an id already taken.
 * - `deviation.resolved`, by the agent that reported it, never the story's developer
 *   (`agentMayResolve`), or by the creator (the
 *   rules of an answer: `unknown_signer`, `unendorsed_human`). Ignored (`invalid`): an unknown or
 *   resolved deviation, another agent.
 */
export const DEVIATION_REDUCERS: Readonly<Record<string, Reducer>> = {
  [DEVIATION_EVENT_TYPES.reported]: (draft, event) => {
    const deviations = deviationsOf(draft);
    const agent = event.actor.kind === "agent" ? event.actor.agent : undefined;
    const id = deviationIdOf(event.id);
    const story = agent === undefined ? undefined : startedStory(draft, event);
    if (agent === undefined || story === undefined || Object.hasOwn(deviations, id)) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    const payload = event.payload as DeviationReportedPayload;
    agentOf(draft, event);
    deviations[id] = {
      id,
      story: event.story as string,
      requirements: [...payload.requirements],
      summary: payload.summary,
      detail: payload.detail ?? null,
      pr: payload.pr ?? null,
      commit: payload.commit ?? null,
      status: "open",
      reported_by: agent,
      reported_at: event.at,
      event: event.id,
      resolved: null,
    };
    if (story.status === "in_review" && story.started !== undefined) {
      story.status = "in_progress";
      // Never before the status it replaces (a clock behind the review's).
      const since = story.status_by?.at;
      const at = since !== undefined && Date.parse(since) > Date.parse(event.at) ? since : event.at;
      story.status_by = { agent: story.started.agent, at };
    }
  },
  [DEVIATION_EVENT_TYPES.resolved]: (draft, event) => {
    const deviations = deviationsOf(draft);
    const payload = event.payload as DeviationResolvedPayload;
    const deviation = recordById(deviations, payload.deviation);
    const closer = closerOf(
      draft,
      event,
      (agent) =>
        deviation !== undefined &&
        agentMayResolve(deviation, agent, storyDeveloper(draft.state, deviation.story)),
    );
    if (closer.refusal !== undefined) {
      draft.ignored.push({ id: event.id, reason: closer.refusal });
      return;
    }
    const by = closer.by;
    if (by === undefined || deviation === undefined || deviation.status !== "open") {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    if (event.actor.kind === "agent") agentOf(draft, event);
    applyDeviationResolution(draft, payload.deviation, {
      reason: payload.reason,
      by,
      at: event.at,
      event: event.id,
    });
  },
};

/**
 * Lifts an open deviation: the effect of `deviation.resolved` and of a `trace_resolve` the
 * creator approved from the chat. False, nothing changed, when the deviation is
 * unknown or resolved.
 */
export function applyDeviationResolution(
  draft: ProjectionDraft,
  id: string,
  resolved: Deviation["resolved"] & {},
): boolean {
  const deviations = deviationsOf(draft);
  const deviation = recordById(deviations, id);
  if (deviation === undefined || deviation.status !== "open") return false;
  deviations[id] = {
    ...deviation,
    status: "resolved",
    resolved: { reason: resolved.reason, by: resolved.by, at: resolved.at, event: resolved.event },
  };
  return true;
}
