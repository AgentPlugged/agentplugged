import { z } from "zod";
import { AgentIdSchema } from "./method-config.js";

/**
 * The team's pause: the creator holds all the agents of a product at once. It is a fact of the
 * journal, not a state of a program: `team.paused` opens a pause, `team.resumed` closes it. The
 * engine reads it (`next` answers `paused`, the commands that start work refuse), so Noah and
 * every sub-agent respect it whatever tool runs them. A pause lets the agent finish the step it
 * is on; the emergency stop is a different gesture (see `ORDER_TYPE_TEAM_STOP`).
 */

/** The orders of the creator that hold the team of a product: one gesture, one signed order. */
export const ORDER_TYPE_TEAM_PAUSE = "team.pause";
export const ORDER_TYPE_TEAM_RESUME = "team.resume";
/**
 * The emergency stop: cuts, by their process id, the programs the bridge itself started for the
 * product (Noah's session and everything it launched), and leaves the team paused. It cannot cut
 * a session the creator opened in their own tool: only the creator can close that one.
 */
export const ORDER_TYPE_TEAM_STOP = "team.stop";

export const TEAM_EVENT_TYPES = {
  paused: "team.paused",
  resumed: "team.resumed",
} as const;

/**
 * The first engine version that knows `team.paused` and `team.resumed`. An older engine answers
 * `UPGRADE_REQUIRED` to every call once the journal holds an event it does not know, so the bridge
 * never writes them for a product that runs an older engine: it keeps its own mark instead.
 */
export const TEAM_PAUSE_MIN_ENGINE = "1.3.0";

/** Who or what paused the team: the creator's gesture, or the emergency stop that follows a cut. */
export const TEAM_PAUSE_REASONS = ["creator", "emergency_stop"] as const;
export type TeamPauseReason = (typeof TEAM_PAUSE_REASONS)[number];

/** `payload` of `team.paused`. */
export const TeamPausedPayloadSchema = z.strictObject({
  reason: z.enum(TEAM_PAUSE_REASONS),
});
export type TeamPausedPayload = z.infer<typeof TeamPausedPayloadSchema>;

/** `payload` of `team.resumed`. */
export const TeamResumedPayloadSchema = z.strictObject({});
export type TeamResumedPayload = z.infer<typeof TeamResumedPayloadSchema>;

/** The orders take no parameter: they hold the whole team of the product. */
export const TeamControlParamsSchema = z.strictObject({});
export type TeamControlParams = z.infer<typeof TeamControlParamsSchema>;

/** The codes a machine answers the team orders with when it does not do what they ask. */
export const TEAM_ORDER_CODES = {
  /** The team is already paused. */
  ALREADY_PAUSED: "TEAM_ALREADY_PAUSED",
  /** The team is not paused: there is nothing to take up again. */
  NOT_PAUSED: "TEAM_NOT_PAUSED",
  /** This machine does not serve the product, or cannot write its journal. */
  UNAVAILABLE: "TEAM_UNAVAILABLE",
  /** The emergency stop cut what it could, but a program of the team did not end. */
  STOP_INCOMPLETE: "TEAM_STOP_INCOMPLETE",
} as const;
export type TeamOrderCode = (typeof TEAM_ORDER_CODES)[keyof typeof TEAM_ORDER_CODES];

/**
 * Input of `pause_team`: Noah's own id, nothing else. Noah writes the pause only once the creator
 * said yes in the conversation (he proposes it, he never imposes it); the resumption stays the
 * creator's gesture.
 */
export const PauseTeamInputSchema = z.strictObject({
  agent: AgentIdSchema.max(64),
});
export type PauseTeamInput = z.infer<typeof PauseTeamInputSchema>;
