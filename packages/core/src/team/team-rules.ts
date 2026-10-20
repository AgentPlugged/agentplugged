import type { TeamPauseReason } from "@agentplugged/protocol";

/**
 * What the projection keeps of the team's pause (`state.team`): an open pause, with when and why,
 * or the trace of the last resumption. Absent: the team was never held.
 */
export type TeamState =
  | {
      readonly paused: true;
      readonly since: string;
      readonly reason: TeamPauseReason;
      /** The event that opened the pause. */
      readonly event: string;
    }
  | { readonly paused: false; readonly resumed_at: string };

/** The open pause of the team, or undefined when the team is free to work. */
export function openPause(
  state: Readonly<Record<string, unknown>>,
): Extract<TeamState, { paused: true }> | undefined {
  const team = state.team as TeamState | undefined;
  return team?.paused === true ? team : undefined;
}
