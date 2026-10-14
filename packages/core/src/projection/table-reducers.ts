import {
  TABLE_EVENT_TYPES,
  type TableClosedPayload,
  type TableProposedPayload,
} from "@agentplugged/protocol";
import { offeredStories, withOffer } from "../table/table-rules.js";
import { actingAgent } from "./agent-reducers.js";
import type { ProjectionDraft, Reducer } from "./reducers.js";

/** `state.tables.offered`: the stories whose three views were offered or held, the latest last. */
function remember(draft: ProjectionDraft, story: string): void {
  draft.state.tables = { offered: withOffer(offeredStories(draft.state), story) };
}

/**
 * The reducers of the round table. The journal keeps each closing as an event (who
 * sat, the synthesis, the gesture, the creator's words); the state keeps only what the engine
 * needs to decide later, `state.tables.offered`: a story whose three views were offered, or held,
 * is never offered again. Both events are an agent's (Noah's); one from anyone else is ignored.
 */
export const TABLE_REDUCERS: Readonly<Record<string, Reducer>> = {
  [TABLE_EVENT_TYPES.proposed]: (draft, event) => {
    if (actingAgent(event) === undefined) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    remember(draft, (event.payload as TableProposedPayload).story);
  },
  [TABLE_EVENT_TYPES.closed]: (draft, event) => {
    if (actingAgent(event) === undefined) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    const payload = event.payload as TableClosedPayload;
    if (payload.format === "three_views" && payload.story !== undefined) {
      remember(draft, payload.story);
    }
  },
};
