import { describe, expect, it } from "vitest";
import {
  CreatorActionSchema,
  contentSections,
  isSkillOverrideContent,
  projectPathProblem,
  SKILL_OVERRIDE_FIELDS,
  SKILL_OVERRIDE_LIMITS,
  SkillOverrideSchema,
} from "./index.js";

/** The customisation of a skill shipped with the method, in the protocol. */
describe("the customisation of a skill", () => {
  it("has the fields the content of a request is recognised by, and no more", () => {
    expect(Object.keys(SkillOverrideSchema.shape)).toEqual([...SKILL_OVERRIDE_FIELDS]);
    expect(isSkillOverrideContent({})).toBe(true);
    expect(isSkillOverrideContent({ checks: ["a"] })).toBe(true);
    expect(isSkillOverrideContent({ steps: ["a"] })).toBe(false);
    expect(isSkillOverrideContent({ overview: "a" })).toBe(false);
  });

  it("refuses an unknown field, a hidden character, a path outside the product and too many lines", () => {
    expect(SkillOverrideSchema.safeParse({ role: "x" }).success).toBe(false);
    expect(SkillOverrideSchema.safeParse({ checks: ["a\u200Bb"] }).success).toBe(false);
    expect(SkillOverrideSchema.safeParse({ checks: ["<!-- hidden -->"] }).success).toBe(false);
    expect(SkillOverrideSchema.safeParse({ output_model: "../x.md" }).success).toBe(false);
    expect(SkillOverrideSchema.safeParse({ facts: ["file:/etc/passwd"] }).success).toBe(false);
    expect(SkillOverrideSchema.safeParse({ facts: ["file:"] }).success).toBe(false);
    const many = Array.from({ length: SKILL_OVERRIDE_LIMITS.checks + 1 }, (_, i) => `line ${i}`);
    expect(SkillOverrideSchema.safeParse({ checks: many }).success).toBe(false);
    expect(
      SkillOverrideSchema.safeParse({
        facts: ["file:docs/a.md", "A sentence."],
        when_done: "Say it.",
        output_model: "docs/model.md",
        reviewers: [{ name: "ours", instruction: "Look." }],
      }).success,
    ).toBe(true);
  });

  it("judges a path", () => {
    for (const bad of ["a\\b", "/a", "C:/a", "~/a", "a/../b", "./a", "a//b", ".git/hooks/x"]) {
      expect(projectPathProblem(bad), bad).toBeDefined();
    }
    expect(projectPathProblem("docs/a.md")).toBeUndefined();
  });

  it("is the content of an agent_edit, with a layer that goes with it only", () => {
    const edit = { kind: "agent_edit", id: "write-prd" };
    const parse = (value: Record<string, unknown>) => CreatorActionSchema.safeParse(value).success;
    expect(parse({ ...edit, content: { checks: ["a"] } })).toBe(true);
    expect(parse({ ...edit, content: { checks: ["a"] }, layer: "personal" })).toBe(true);
    expect(parse({ ...edit, tier: "fast", layer: "personal" })).toBe(false);
    expect(parse({ ...edit, content: { checks: ["a"] }, layer: "mine" })).toBe(false);
  });

  it("shows its sections in the order the creator reads them", () => {
    const sections = contentSections({
      reviewers: [{ name: "ours", instruction: "Look." }],
      checks: ["A check."],
      facts: ["A fact."],
      when_done: "Done.",
    });
    expect(sections).toEqual([
      { key: "facts", items: ["A fact."] },
      { key: "checks", items: ["A check."] },
      { key: "when_done", items: ["Done."] },
      { key: "reviewers", items: ["ours · Look."] },
    ]);
  });
});
