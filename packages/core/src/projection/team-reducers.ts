import { NOAH_AGENT, TEAM_EVENT_TYPES, type TeamPausedPayload } from "@agentplugged/protocol";
import type { TeamState } from "../team/team-rules.js";
import { actingAgent } from "./agent-reducers.js";
import type { Reducer } from "./reducers.js";

/**
 * The reducers of the team's pause. A pause is opened and closed by the machine that serves the
 * product (`system`: the creator's gesture from a device), by the creator (`human`), or by Noah when
 * the creator asked him in the chat of their tool. Any other agent cannot hold the team: its event
 * is ignored (`invalid`). A second pause while one is open, or a resumption with none open, changes
 * nothing.
 */

function mayHold(event: { actor: { kind: string; agent?: string | undefined } }): boolean {
  if (event.actor.kind === "system" || event.actor.kind === "human") return true;
  return actingAgent(event) === NOAH_AGENT;
}

export const TEAM_REDUCERS: Readonly<Record<string, Reducer>> = {
  [TEAM_EVENT_TYPES.paused]: (draft, event) => {
    if (!mayHold(event)) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    const current = draft.state.team as TeamState | undefined;
    if (current?.paused === true) return;
    const { reason } = event.payload as TeamPausedPayload;
    draft.state.team = {
      paused: true,
      since: event.at,
      reason,
      event: event.id,
    } satisfies TeamState;
  },
  [TEAM_EVENT_TYPES.resumed]: (draft, event) => {
    if (!mayHold(event)) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    const current = draft.state.team as TeamState | undefined;
    if (current?.paused !== true) return;
    draft.state.team = { paused: false, resumed_at: event.at } satisfies TeamState;
  },
};
