import { describe, expect, it } from "vitest";
import {
  AgentContentSchema,
  contentSections,
  contentSize,
  SkillContentSchema,
} from "./agent-content.js";
import { CreatorActionRecordSchema, CreatorActionSchema } from "./creator-action.js";

/**
 * What the workshop adds to the definition of an agent or a skill: a menu item that
 * calls a skill, and a skill's files of detail (`references/`).
 */

const AGENT = {
  overview: "Prices a small offer with the creator.",
  produces: ["A note in docs/pricing.md"],
  works: ["Asks one question at a time"],
  never: ["Never sends an offer herself"],
  principles: ["The creator decides"],
  menu: [{ code: "AN", description: "Review the prices", prompt: "Read docs/pricing.md." }],
};

const SKILL = { steps: ["Ask"], outputs: ["A note"], rules: ["Be brief"] };

describe("a menu item calls a skill or carries an instruction", () => {
  const item = AGENT.menu[0] as (typeof AGENT.menu)[number];
  const parse = (menu: unknown) => AgentContentSchema.safeParse({ ...AGENT, menu }).success;

  it("accepts a skill by its name, never with an instruction, never neither", () => {
    expect(parse([{ code: "PR", description: "Price an offer", skill: "pricing-check" }])).toBe(
      true,
    );
    expect(parse([{ ...item, skill: "pricing-check" }])).toBe(false);
    expect(parse([{ code: "PR", description: "Price an offer" }])).toBe(false);
    expect(parse([{ code: "PR", description: "Price", skill: "Not A Name" }])).toBe(false);
  });
});

describe("a skill has files of detail", () => {
  const parse = (references: unknown) =>
    SkillContentSchema.safeParse({ ...SKILL, references }).success;
  const file = (name: string) => ({ name, lines: ["One line"] });

  it("takes up to four, each named once, with plain lines", () => {
    expect(parse([file("checklist")])).toBe(true);
    expect(parse([file("a"), file("b"), file("c"), file("d")])).toBe(true);
    expect(parse([file("a"), file("b"), file("c"), file("d"), file("e")])).toBe(false);
    expect(parse([file("a"), file("a")])).toBe(false);
    expect(parse([file("Not A Name")])).toBe(false);
    expect(parse([{ name: "a", lines: [] }])).toBe(false);
    expect(parse([{ name: "a", lines: ["<!-- hidden -->"] }])).toBe(false);
    expect(parse([])).toBe(false);
  });

  it("counts their lines in the total a creator has to read", () => {
    const heavy = Array.from({ length: 19 }, () => "x".repeat(400));
    expect(parse([{ name: "a", lines: heavy }])).toBe(true);
    expect(
      parse([
        { name: "a", lines: heavy },
        { name: "b", lines: heavy },
      ]),
    ).toBe(false);
    expect(contentSize({ ...SKILL, references: [{ name: "a", lines: ["abc", "de"] }] })).toBe(
      contentSize(SKILL) + 6,
    );
  });
});

describe("what the creator reads, and what is recorded", () => {
  it("shows both the way every surface does", () => {
    const sections = contentSections({
      ...SKILL,
      references: [{ name: "checklist", lines: ["One", "Two"] }],
    });
    expect(sections.map((section) => section.key)).toEqual([
      "steps",
      "outputs",
      "rules",
      "references",
    ]);
    expect(sections[3]?.items).toEqual(["checklist · One", "checklist · Two"]);
    const menu = contentSections({
      ...AGENT,
      menu: [{ code: "PR", description: "Price an offer", skill: "pricing-check" }],
    }).find((section) => section.key === "menu");
    expect(menu?.items).toEqual(["PR · Price an offer — skill pricing-check"]);
  });

  it("is recorded whole in the request", () => {
    const skill = { kind: "agent_create", id: "price", definition: "skill", description: "d" };
    const content = { ...SKILL, references: [{ name: "checklist", lines: ["One"] }] };
    expect(CreatorActionSchema.safeParse({ ...skill, content }).success).toBe(true);
    const record = { ...skill, content, reason: "why" };
    expect(CreatorActionRecordSchema.parse(record)).toEqual(record);
  });
});
