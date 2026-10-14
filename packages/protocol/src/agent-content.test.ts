import { describe, expect, it } from "vitest";
import {
  AgentContentSchema,
  CONTENT_MAX_CHARS,
  contentSections,
  contentSize,
  FORM_CONTENT_MAX_CHARS,
  isSkillContent,
  REQUIRED_CONTENT_FIELDS,
  SkillContentSchema,
} from "./agent-content.js";
import { CreatorActionRecordSchema, CreatorActionSchema } from "./creator-action.js";

const AGENT = {
  overview: "Recruits neighbours as testers.",
  produces: ["An announcement in docs/announcement.md"],
  works: ["Asks one question at a time"],
  never: ["Never sends a message herself"],
  principles: ["The creator decides each contact"],
  menu: [{ code: "AN", description: "Write the announcement", prompt: "Ask who, then write it." }],
};

const SKILL = { steps: ["Ask"], outputs: ["A note"], rules: ["Be brief"] };

const hidden = (code: number) => String.fromCodePoint(code);

describe("the definition of an agent", () => {
  it("accepts a complete definition, with or without the optional parts", () => {
    expect(AgentContentSchema.safeParse(AGENT).success).toBe(true);
    const full = {
      ...AGENT,
      identity: "A neighbourhood host.",
      communication_style: "Warm.",
      persistent_facts: ["Testers are neighbours."],
    };
    expect(AgentContentSchema.parse(full)).toEqual(full);
  });

  it("trims the texts, and needs the six parts the creator reads", () => {
    expect(AgentContentSchema.parse({ ...AGENT, overview: "  Hello.  " }).overview).toBe("Hello.");
    for (const field of REQUIRED_CONTENT_FIELDS.agent) {
      const { [field]: _removed, ...rest } = AGENT;
      expect(AgentContentSchema.safeParse(rest).success, field).toBe(false);
    }
    for (const field of ["produces", "works", "never", "principles", "menu"] as const) {
      expect(AgentContentSchema.safeParse({ ...AGENT, [field]: [] }).success, field).toBe(false);
    }
    expect(AgentContentSchema.safeParse({ ...AGENT, extra: "x" }).success).toBe(false);
  });

  it("checks the menu: codes, one per code, a limit of nine", () => {
    const item = AGENT.menu[0] as (typeof AGENT.menu)[number];
    const parse = (menu: unknown) => AgentContentSchema.safeParse({ ...AGENT, menu }).success;
    expect(parse([{ ...item, code: "too-long-a-code" }])).toBe(false);
    expect(parse([{ ...item, code: "a b" }])).toBe(false);
    expect(parse([item, { ...item, code: "an" }])).toBe(false);
    expect(parse([{ code: "AN", description: "x" }])).toBe(false);
    expect(parse([{ ...item, skill: "other" }])).toBe(false);
    const ten = Array.from({ length: 10 }, (_, index) => ({ ...item, code: `C${index}` }));
    expect(parse(ten)).toBe(false);
    expect(parse(ten.slice(0, 9))).toBe(true);
  });

  it("refuses a text that would show the creator another one", () => {
    const parse = (principles: string[]) =>
      AgentContentSchema.safeParse({ ...AGENT, principles }).success;
    expect(parse(["Fine"])).toBe(true);
    expect(parse(["two\nlines"])).toBe(false);
    expect(parse([`bell${hidden(7)}`])).toBe(false);
    expect(parse([`escape${hidden(0x1b)}[2K`])).toBe(false);
    for (const code of [
      0x200b, 0x200d, 0x202e, 0x2066, 0x2028, 0x2029, 0x0085, 0xfeff, 0x00ad, 0xe0041, 0xe0100,
    ]) {
      expect(parse([`Be${hidden(code)}kind`]), code.toString(16)).toBe(false);
    }
    expect(parse(["Hide <!-- a second instruction --> here"])).toBe(false);
    expect(parse(["Close it --> early"])).toBe(false);
    // Emoji and accents are text.
    expect(parse(["Garder le sourire 🙂 — toujours"])).toBe(true);
    expect(parse(["A heart ❤️"])).toBe(true);
  });

  it("refuses what shows nothing, pads a text, hides a block or has no form", () => {
    const parse = (principles: string[]) =>
      AgentContentSchema.safeParse({ ...AGENT, principles }).success;
    const braille = String.fromCodePoint(0x2800);
    const nbsp = String.fromCodePoint(0xa0);
    const combining = String.fromCodePoint(0x301);
    const annotation = String.fromCodePoint(0xfff9);
    const lone = String.fromCharCode(0xd800);
    expect(parse([braille.repeat(3)])).toBe(false);
    expect(parse([`${nbsp}${nbsp}Be kind`])).toBe(true);
    expect(parse([`Be${nbsp}kind`])).toBe(false);
    expect(parse([combining])).toBe(false);
    expect(parse([`A${annotation}B`])).toBe(false);
    expect(parse([`Lone ${lone}`])).toBe(false);
    expect(parse(["<div hidden>secret</div>"])).toBe(false);
    expect(parse(['<span style="display:none">x</span>'])).toBe(false);
    expect(parse(["<?php echo 1 ?>"])).toBe(false);
    expect(parse(["<![CDATA[x]]>"])).toBe(false);
    // A placeholder is text; a heading, a fence or a link definition opening the overview is not.
    expect(parse(["Write docs/<story>.md first"])).toBe(true);
    const overview = (text: string) =>
      AgentContentSchema.safeParse({ ...AGENT, overview: text }).success;
    expect(overview("Recruits neighbours.")).toBe(true);
    for (const text of [
      "## What Rose never does",
      "```",
      "---",
      "[x]: http://e.com",
      "[//]: # (c)",
    ]) {
      expect(overview(text), text).toBe(false);
    }
    // Facts are never an empty list: to clear them, say so in a fact.
    expect(AgentContentSchema.safeParse({ ...AGENT, persistent_facts: [] }).success).toBe(false);
  });

  it("never lets a persistent fact load a file", () => {
    const parse = (persistent_facts: string[]) =>
      AgentContentSchema.safeParse({ ...AGENT, persistent_facts }).success;
    expect(parse(["Testers are neighbours."])).toBe(true);
    expect(parse(["file:.env"])).toBe(false);
    expect(parse(["FILE:docs/brief.md"])).toBe(false);
    expect(parse(["See file:docs/brief.md for more"])).toBe(true);
  });

  it("limits each text and the whole to what the creator can read in one go", () => {
    expect(AgentContentSchema.safeParse({ ...AGENT, overview: "x".repeat(1500) }).success).toBe(
      true,
    );
    expect(AgentContentSchema.safeParse({ ...AGENT, overview: "x".repeat(1501) }).success).toBe(
      false,
    );
    const menu = [{ ...AGENT.menu[0], prompt: "p".repeat(1001) }];
    expect(AgentContentSchema.safeParse({ ...AGENT, menu }).success).toBe(false);
    const lines = (count: number, length: number) =>
      Array.from({ length: count }, () => "x".repeat(length));
    const over = {
      ...AGENT,
      produces: lines(10, 300),
      works: lines(12, 400),
      never: lines(10, 300),
      principles: lines(10, 300),
    };
    expect(contentSize(over)).toBeGreaterThan(CONTENT_MAX_CHARS);
    const refused = AgentContentSchema.safeParse(over);
    expect(refused.success).toBe(false);
    expect(refused.success ? "" : refused.error.issues[0]?.message).toContain(
      String(CONTENT_MAX_CHARS),
    );
    // What a form shows is always within what a request may carry.
    expect(FORM_CONTENT_MAX_CHARS).toBeLessThan(CONTENT_MAX_CHARS);
  });

  it("lists the parts in the order the creator reads them, whole", () => {
    const sections = contentSections({ ...AGENT, identity: "Host." });
    expect(sections.map((section) => section.key)).toEqual([
      "overview",
      "produces",
      "works",
      "never",
      "principles",
      "menu",
      "identity",
    ]);
    expect(sections[0]?.items).toEqual([AGENT.overview]);
    expect(sections[5]?.items).toEqual(["AN · Write the announcement — Ask who, then write it."]);
    expect(isSkillContent(AGENT)).toBe(false);
  });
});

describe("the definition of a skill", () => {
  it("needs steps, outputs and rules", () => {
    expect(SkillContentSchema.safeParse(SKILL).success).toBe(true);
    for (const field of REQUIRED_CONTENT_FIELDS.skill) {
      const { [field]: _removed, ...rest } = SKILL;
      expect(SkillContentSchema.safeParse(rest).success, field).toBe(false);
    }
    expect(
      SkillContentSchema.safeParse({ ...SKILL, rules: ["Be <!-- hidden --> brief"] }).success,
    ).toBe(false);
    expect(isSkillContent(SKILL)).toBe(true);
    expect(contentSections(SKILL).map((section) => section.key)).toEqual([
      "steps",
      "outputs",
      "rules",
    ]);
  });
});

describe("the definition inside a creator's action", () => {
  const create = {
    kind: "agent_create",
    id: "rose",
    title: "Rose",
    description: "d",
    domain: "marketing",
    phase: "launch",
  };

  it("goes with its kind: an agent's with an agent, a skill's with a skill", () => {
    expect(CreatorActionSchema.safeParse({ ...create, content: AGENT }).success).toBe(true);
    expect(CreatorActionSchema.safeParse({ ...create, content: SKILL }).success).toBe(false);
    const skill = { kind: "agent_create", id: "price", definition: "skill", description: "d" };
    expect(CreatorActionSchema.safeParse({ ...skill, content: SKILL }).success).toBe(true);
    expect(CreatorActionSchema.safeParse({ ...skill, content: AGENT }).success).toBe(false);
    // A request without it still parses: the engine refuses it and says what to add.
    expect(CreatorActionSchema.safeParse(create).success).toBe(true);
  });

  it("is given to agent_edit apart from the settings", () => {
    const edit = { kind: "agent_edit", id: "rose" };
    expect(CreatorActionSchema.safeParse({ ...edit, content: AGENT }).success).toBe(true);
    expect(CreatorActionSchema.safeParse({ ...edit, tier: "fast" }).success).toBe(true);
    expect(CreatorActionSchema.safeParse(edit).success).toBe(false);
    expect(CreatorActionSchema.safeParse({ ...edit, tier: "fast", content: AGENT }).success).toBe(
      false,
    );
  });

  it("is recorded whole with the reason, and a journal of the old form still reads", () => {
    const record = { ...create, content: AGENT, reason: "why" };
    expect(CreatorActionRecordSchema.parse(record)).toEqual(record);
    expect(CreatorActionRecordSchema.safeParse({ ...create, reason: "why" }).success).toBe(true);
  });
});
