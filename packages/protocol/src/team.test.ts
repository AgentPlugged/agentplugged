import { describe, expect, it } from "vitest";
import {
  baseOrderTypes,
  KNOWN_EVENT_TYPES,
  ORDER_TYPE_TEAM_PAUSE,
  ORDER_TYPE_TEAM_RESUME,
  ORDER_TYPE_TEAM_STOP,
  PauseTeamInputSchema,
  TEAM_EVENT_TYPES,
  TEAM_ORDER_CODES,
  TEAM_PAUSE_MIN_ENGINE,
  TeamControlParamsSchema,
  TeamPausedPayloadSchema,
  TeamResumedPayloadSchema,
} from "./index.js";

describe("the team's pause", () => {
  it("is two additive facts of the journal, read by the engine from 1.3.0", () => {
    expect(TEAM_EVENT_TYPES).toEqual({ paused: "team.paused", resumed: "team.resumed" });
    expect(TEAM_PAUSE_MIN_ENGINE).toBe("1.3.0");
    expect(KNOWN_EVENT_TYPES).toContain(TEAM_EVENT_TYPES.paused);
    expect(KNOWN_EVENT_TYPES).toContain(TEAM_EVENT_TYPES.resumed);
  });

  it("says why the team was held, and nothing else", () => {
    expect(TeamPausedPayloadSchema.safeParse({ reason: "creator" }).success).toBe(true);
    expect(TeamPausedPayloadSchema.safeParse({ reason: "emergency_stop" }).success).toBe(true);
    expect(TeamPausedPayloadSchema.safeParse({ reason: "agent" }).success).toBe(false);
    expect(TeamPausedPayloadSchema.safeParse({ reason: "creator", note: "x" }).success).toBe(false);
    expect(TeamResumedPayloadSchema.safeParse({}).success).toBe(true);
    expect(TeamResumedPayloadSchema.safeParse({ reason: "creator" }).success).toBe(false);
  });

  it("is held by three orders of the creator that take no parameter", () => {
    expect(TeamControlParamsSchema.safeParse({}).success).toBe(true);
    expect(TeamControlParamsSchema.safeParse({ agent: "sam" }).success).toBe(false);
    const registry = baseOrderTypes();
    for (const type of [ORDER_TYPE_TEAM_PAUSE, ORDER_TYPE_TEAM_RESUME, ORDER_TYPE_TEAM_STOP]) {
      const declaration = registry.get(`order.${type}/v1`);
      expect(declaration, type).toMatchObject({ risk: "medium", target: "primary" });
    }
  });

  it("answers with codes of its own", () => {
    expect(Object.values(TEAM_ORDER_CODES).sort()).toEqual([
      "TEAM_ALREADY_PAUSED",
      "TEAM_NOT_PAUSED",
      "TEAM_STOP_INCOMPLETE",
      "TEAM_UNAVAILABLE",
    ]);
  });
});

describe("the pause Noah writes himself", () => {
  it("takes Noah's id and nothing else", () => {
    expect(PauseTeamInputSchema.parse({ agent: "noah" })).toEqual({ agent: "noah" });
    expect(PauseTeamInputSchema.safeParse({}).success).toBe(false);
    expect(PauseTeamInputSchema.safeParse({ agent: "noah", reason: "creator" }).success).toBe(
      false,
    );
  });
});
