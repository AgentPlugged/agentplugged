import {
  ErrorCode,
  NOAH_AGENT,
  type PauseTeamInput,
  PauseTeamInputSchema,
  TEAM_EVENT_TYPES,
} from "@agentplugged/protocol";
import { agentEventCommand } from "../agent-activity/agent-commands.js";
import { roleForbidden } from "../agents/noah-role.js";
import { AgentPluggedError } from "../errors.js";
import { openPause } from "./team-rules.js";

/**
 * `pause_team`: Noah holds the whole team once the creator agreed to it in the conversation (he
 * noticed that requests to change course piled up, proposed the pause, and heard yes). It writes
 * the same fact the creator's pause button writes (`team.paused`), so the engine refuses new work
 * whatever tool runs the agents; the bridge orchestrates nothing. Only Noah calls it; resuming
 * stays the creator's gesture. Allowed while a checkpoint is open: it holds, it starts nothing.
 */
export const pauseTeamCommand = agentEventCommand<typeof PauseTeamInputSchema>({
  name: "pause_team",
  description:
    "Noah only, and only after the creator said yes to your proposal in the conversation: hold the whole team (nobody starts new work until the creator resumes it; agents finish their step). `agent` is `noah`. Refused, nothing written: ROLE_FORBIDDEN (only Noah), TEAM_ALREADY_PAUSED.",
  inputSchema: PauseTeamInputSchema,
  needsState: () => true,
  events(_input: PauseTeamInput) {
    return { events: [{ type: TEAM_EVENT_TYPES.paused, payload: { reason: "creator" } }] };
  },
  check(input, state) {
    if (input.agent !== NOAH_AGENT) return roleForbidden(input.agent, "pause_team");
    const open = openPause(state);
    if (open !== undefined) {
      return new AgentPluggedError(ErrorCode.TEAM_ALREADY_PAUSED, "error.team_already_paused", {
        since: open.since,
      });
    }
    return undefined;
  },
});
