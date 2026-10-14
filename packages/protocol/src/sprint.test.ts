import { describe, expect, it } from "vitest";
import {
  ErrorCode,
  EVENT_TYPE_REGISTRY,
  MAX_SPRINT_GOAL,
  MAX_SPRINT_USD,
  PlanSprintInputSchema,
  SPRINT_EVENT_TYPES,
  SprintIdSchema,
  SprintPlannedPayloadSchema,
  sprintIdOf,
} from "./index.js";

const PAYLOAD = {
  goal: "Sign up and sign in",
  stories: [
    { id: "1-1", owner: "sam", budget_usd: 3.5 },
    { id: "1-2", owner: "creator", budget_usd: 4 },
  ],
  capacity: { agents: ["sam"], humans: 0 },
  budget_usd: 7.5,
  checkpoint: "G-7M2K9QX4TB",
};

const INPUT = {
  agent: "izzy",
  goal: "Sign up and sign in",
  stories: ["1-1", "1-2"],
  capacity: { agents: ["sam", "ethan"], humans: 1 },
  summary: "Accounts first: every later story needs a signed-in user.",
};

function issuePath(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) {
  return result.error?.issues[0]?.path.map(String).join(".");
}

describe("sprints", () => {
  it("registers sprint.planned at version 1", () => {
    expect(EVENT_TYPE_REGISTRY[SPRINT_EVENT_TYPES.planned]?.version).toBe(1);
    expect(ErrorCode.SPRINT_INVALID).toBe("SPRINT_INVALID");
  });

  it("draws a sprint id from its event, like a checkpoint's", () => {
    const id = sprintIdOf("01JZ0000000000007M2K9QX4TB");
    expect(id).toBe("S-7M2K9QX4TB");
    expect(SprintIdSchema.safeParse(id).success).toBe(true);
    expect(SprintIdSchema.safeParse("S-7m2k9qx4tb").success).toBe(false);
  });

  it("accepts a sprint and its checkpoint, a ceiling being optional", () => {
    expect(SprintPlannedPayloadSchema.safeParse(PAYLOAD).success).toBe(true);
    expect(SprintPlannedPayloadSchema.safeParse({ ...PAYLOAD, budget_limit_usd: 10 }).success).toBe(
      true,
    );
  });

  it("refuses a sprint without its checkpoint, with a story twice or a goal on two lines", () => {
    const { checkpoint: _checkpoint, ...without } = PAYLOAD;
    expect(issuePath(SprintPlannedPayloadSchema.safeParse(without))).toBe("checkpoint");
    expect(
      issuePath(
        SprintPlannedPayloadSchema.safeParse({
          ...PAYLOAD,
          stories: [PAYLOAD.stories[0], PAYLOAD.stories[0]],
        }),
      ),
    ).toBe("stories");
    expect(issuePath(SprintPlannedPayloadSchema.safeParse({ ...PAYLOAD, goal: "One\nTwo" }))).toBe(
      "goal",
    );
    expect(issuePath(SprintPlannedPayloadSchema.safeParse({ ...PAYLOAD, stories: [] }))).toBe(
      "stories",
    );
  });

  it("keeps the goal short enough for the checkpoint title, and amounts under the maximum", () => {
    expect(MAX_SPRINT_GOAL).toBe(112);
    const goal = "g".repeat(MAX_SPRINT_GOAL);
    expect(SprintPlannedPayloadSchema.safeParse({ ...PAYLOAD, goal }).success).toBe(true);
    expect(issuePath(SprintPlannedPayloadSchema.safeParse({ ...PAYLOAD, goal: `${goal}g` }))).toBe(
      "goal",
    );
    expect(
      issuePath(
        SprintPlannedPayloadSchema.safeParse({ ...PAYLOAD, budget_usd: MAX_SPRINT_USD + 1 }),
      ),
    ).toBe("budget_usd");
  });

  it("checks the input of plan_sprint: strict, capacity bounded, ceiling above zero", () => {
    expect(PlanSprintInputSchema.safeParse(INPUT).success).toBe(true);
    expect(issuePath(PlanSprintInputSchema.safeParse({ ...INPUT, budget_limit_usd: 0 }))).toBe(
      "budget_limit_usd",
    );
    expect(
      issuePath(
        PlanSprintInputSchema.safeParse({ ...INPUT, capacity: { agents: ["sam"], humans: -1 } }),
      ),
    ).toBe("capacity.humans");
    expect(
      issuePath(
        PlanSprintInputSchema.safeParse({
          ...INPUT,
          capacity: { agents: ["sam", "sam"], humans: 0 },
        }),
      ),
    ).toBe("capacity.agents");
    expect(PlanSprintInputSchema.safeParse({ ...INPUT, checkpoint: "G-7M2K9QX4TB" }).success).toBe(
      false,
    );
  });
});
