import { describe, expect, it } from "vitest";
import { CheckpointClosedPayloadSchema } from "./checkpoint-closed.js";
import { CreatorActionRecordSchema, CreatorActionSchema } from "./creator-action.js";
import { isStoryStep, JOURNEY_STEPS, JOURNEY_STORY_STEPS, PHASE_STEPS } from "./journey.js";
import { PHASE_IDS } from "./method-config.js";

describe("the journey's steps", () => {
  it("lists every step once, the story's steps last", () => {
    expect(new Set(JOURNEY_STEPS).size).toBe(JOURNEY_STEPS.length);
    const firstStory = JOURNEY_STEPS.findIndex((step) => isStoryStep(step));
    expect(JOURNEY_STEPS.slice(firstStory).every((step) => JOURNEY_STORY_STEPS.has(step))).toBe(
      true,
    );
    expect(JOURNEY_STEPS.slice(0, firstStory).some((step) => isStoryStep(step))).toBe(false);
  });

  it("has one step per phase of the method", () => {
    expect(Object.keys(PHASE_STEPS)).toEqual([...PHASE_IDS]);
    for (const step of Object.values(PHASE_STEPS)) expect(JOURNEY_STEPS).toContain(step);
  });
});

describe("step_skip and step_resume", () => {
  it("take a step of the journey, a story only for the steps of a story", () => {
    expect(CreatorActionSchema.parse({ kind: "step_skip", step: "prd" })).toEqual({
      kind: "step_skip",
      step: "prd",
    });
    expect(
      CreatorActionSchema.parse({ kind: "step_skip", step: "story_review", story: "04-3" }),
    ).toEqual({ kind: "step_skip", step: "story_review", story: "4-3" });
    expect(CreatorActionSchema.parse({ kind: "step_resume", step: "story_ci" })).toEqual({
      kind: "step_resume",
      step: "story_ci",
    });
    for (const refused of [
      { kind: "step_skip", step: "prd", story: "4-3" },
      { kind: "step_skip", step: "unknown" },
      { kind: "step_skip" },
      { kind: "step_skip", step: "prd", reason: "x" },
      { kind: "step_resume", step: "brief", story: "4-3" },
    ]) {
      expect(CreatorActionSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(false);
    }
  });

  it("are recorded with the creator's reason", () => {
    const record = { kind: "step_skip", step: "story_ci", reason: "no CI on this product" };
    expect(CreatorActionRecordSchema.safeParse(record).success).toBe(true);
    expect(
      CreatorActionRecordSchema.safeParse({ kind: "step_skip", step: "story_ci" }).success,
    ).toBe(false);
  });
});

describe("the closing of a skipped step's point", () => {
  it("accepts the reason step_skipped, without a ref", () => {
    const closed = { checkpoint: "G-7M2K9QX4TB", reason: "step_skipped" };
    expect(CheckpointClosedPayloadSchema.safeParse(closed).success).toBe(true);
    expect(
      CheckpointClosedPayloadSchema.safeParse({ ...closed, ref: "G-7M2K9QX4TC" }).success,
    ).toBe(false);
  });
});
