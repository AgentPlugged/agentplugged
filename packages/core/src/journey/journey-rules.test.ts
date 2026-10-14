import { JOURNEY_STEPS, type JourneyStep } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { JOURNEY_CATALOG, skipWarning } from "./journey-catalog.js";
import {
  documentProblemIsWarning,
  documentStep,
  isSkipped,
  isSkippedExactly,
  skipKey,
  skippedList,
  skippedPhases,
  skippedSteps,
} from "./journey-rules.js";
import { journeyView } from "./journey-view.js";

/** A projection state with the steps skipped, in the order given. */
function skipsState(...entries: Array<readonly [JourneyStep, string?]>) {
  const skips: Record<string, unknown> = {};
  entries.forEach(([step, story], index) => {
    skips[skipKey(step, story)] = {
      step,
      story: story ?? null,
      reason: `reason ${index}`,
      by: "creator",
      source: "chat",
      at: `2026-10-06T10:0${index}:00.000Z`,
      event: `01JZ0000000000000000000${index}`,
      checkpoint: `G-000000000${index}`,
    };
  });
  return { skips };
}

describe("what the creator skipped", () => {
  it("is nothing without a skips section", () => {
    expect(isSkipped({}, "prd")).toBe(false);
    expect(skippedList({})).toEqual([]);
    expect(skippedPhases({}).size).toBe(0);
  });

  it("covers a step of the product by itself", () => {
    const state = skipsState(["prd"]);
    expect(isSkipped(state, "prd")).toBe(true);
    expect(isSkipped(state, "brief")).toBe(false);
    expect(isSkippedExactly(state, "prd")).toBe(true);
  });

  it("skips the stories' CI when the creator skipped the setting up of the CI", () => {
    expect(isSkipped(skipsState(["ci_setup"]), "story_ci", "4-3")).toBe(true);
    expect(isSkipped(skipsState(["ci_setup"]), "story_review", "4-3")).toBe(false);
  });

  it("covers a step of a story for every story, or for one story only", () => {
    const everyStory = skipsState(["story_review"]);
    expect(isSkipped(everyStory, "story_review", "4-3")).toBe(true);
    expect(isSkipped(everyStory, "story_review")).toBe(true);
    const one = skipsState(["story_review", "4-3"]);
    expect(isSkipped(one, "story_review", "4-3")).toBe(true);
    expect(isSkipped(one, "story_review", "4-4")).toBe(false);
    // Without a story, a skip of one story's step is not a skip of the step.
    expect(isSkipped(one, "story_review")).toBe(false);
    expect(isSkippedExactly(one, "story_review", "4-3")).toBe(true);
    expect(isSkippedExactly(one, "story_review")).toBe(false);
    // The skip of a story's step never reaches another step.
    expect(isSkipped(one, "story_ci", "4-3")).toBe(false);
  });

  it("lists the skipped steps in the order they were skipped", () => {
    const state = skipsState(["story_ci"], ["prd"], ["phase_design"]);
    expect(skippedList(state).map((skip) => skip.step)).toEqual([
      "story_ci",
      "prd",
      "phase_design",
    ]);
    expect([...skippedSteps(state)].sort()).toEqual(["phase_design", "prd", "story_ci"]);
    expect([...skippedPhases(state)]).toEqual(["design"]);
  });

  it("is shown with who said it and why, cut when long", () => {
    const state = skipsState(["prd"]);
    expect(journeyView(state)).toEqual({
      skipped: [
        {
          step: "prd",
          story: null,
          reason: "reason 0",
          by: "creator",
          source: "chat",
          at: "2026-10-06T10:00:00.000Z",
        },
      ],
      skipped_total: 1,
    });
    const long = skipsState(["prd"]);
    (long.skips[skipKey("prd")] as { reason: string }).reason = "x".repeat(500);
    expect(journeyView(long).skipped[0]?.reason).toHaveLength(200);
  });
});

describe("the documents a step owns", () => {
  it.each([
    [".agentplugged/docs/brief.md", "brief", undefined],
    [".agentplugged/docs/prd.md", "prd", undefined],
    [".agentplugged/docs/ux.md", "ux", undefined],
    [".agentplugged/docs/architecture.md", "architecture", undefined],
    [".agentplugged/docs/security-reviews/architecture.md", "architecture_security", undefined],
    [".agentplugged/epics/epic-1.md", "breakdown", undefined],
    [".agentplugged/stories/4-3-sign-in.md", "breakdown", "4-3"],
    [".agentplugged/stories/04-03.md", "breakdown", "4-3"],
    [".agentplugged/docs/launch/positioning.md", "positioning", undefined],
    [".agentplugged/docs/launch/pages/home.md", "phase_launch", undefined],
    [".agentplugged/docs/index.md", "knowledge_base", undefined],
  ])("%s belongs to %s", (path, step, story) => {
    expect(documentStep(path)).toEqual(story === undefined ? { step } : { step, story });
  });

  it("belongs to no step for another document", () => {
    expect(documentStep(".agentplugged/docs/notes.md")).toBeUndefined();
  });

  it("turns the problems of a skipped step's document into warnings, and only them", () => {
    const prd = ".agentplugged/docs/prd.md";
    const story = ".agentplugged/stories/4-3-sign-in.md";
    expect(documentProblemIsWarning({}, prd)).toBe(false);
    expect(documentProblemIsWarning(skipsState(["prd"]), prd)).toBe(true);
    expect(documentProblemIsWarning(skipsState(["prd"]), ".agentplugged/docs/ux.md")).toBe(false);
    // The phase that owns the document counts too.
    expect(documentProblemIsWarning(skipsState(["phase_planning"]), prd)).toBe(true);
    // The check itself.
    expect(
      documentProblemIsWarning(skipsState(["docs_check"]), ".agentplugged/docs/notes.md"),
    ).toBe(true);
    // A story's file: the breakdown, or the contract of that story.
    expect(documentProblemIsWarning(skipsState(["breakdown"]), story)).toBe(true);
    expect(documentProblemIsWarning(skipsState(["story_contract", "4-3"]), story)).toBe(true);
    expect(documentProblemIsWarning(skipsState(["story_contract", "4-4"]), story)).toBe(false);
    expect(documentProblemIsWarning(skipsState(["story_contract"]), story)).toBe(true);
  });
});

describe("the warning said once", () => {
  it("has a catalogue entry for every step, and only known dependents", () => {
    expect(Object.keys(JOURNEY_CATALOG).sort()).toEqual([...JOURNEY_STEPS].sort());
    for (const step of JOURNEY_STEPS) {
      for (const dependent of JOURNEY_CATALOG[step].dependents) {
        expect(JOURNEY_STEPS, `${step} -> ${dependent}`).toContain(dependent);
        expect(dependent).not.toBe(step);
      }
    }
  });

  it("names what rests on the step, the risk and the lightest option, in one sentence", () => {
    const warning = skipWarning("architecture", new Set());
    expect(warning.dependents).toEqual(["architecture_security", "breakdown", "story_review"]);
    expect(warning.sentence).toContain("the architecture");
    expect(warning.sentence).toContain("lightest option: a minimal architecture");
    expect(warning.sentence.split("\n")).toHaveLength(1);
  });

  it("leaves out what is already skipped, and still gives the lighter option for a leaf step", () => {
    const warning = skipWarning("architecture", new Set<JourneyStep>(["breakdown"]));
    expect(warning.dependents).toEqual(["architecture_security", "story_review"]);
    const leaf = skipWarning("retrospective", new Set());
    expect(leaf.dependents).toEqual([]);
    expect(leaf.sentence).toContain("lightest option");
  });

  it("asks for a high risk only where a security check is dropped", () => {
    const high = JOURNEY_STEPS.filter((step) => JOURNEY_CATALOG[step].risk === "high");
    expect(high).toEqual(["architecture_security", "story_security", "story_ci"]);
  });
});
