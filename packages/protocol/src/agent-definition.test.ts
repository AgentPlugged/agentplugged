import { describe, expect, it } from "vitest";
import { AgentDefinitionSchema, AgentOverrideSchema } from "./index.js";

const minimal = { name: "Iris", title: "Product Analyst" };

describe("AgentDefinitionSchema", () => {
  it("defaults every list to empty", () => {
    expect(AgentDefinitionSchema.parse(minimal)).toEqual({
      ...minimal,
      principles: [],
      persistent_facts: [],
      activation_steps_prepend: [],
      activation_steps_append: [],
      menu: [],
    });
  });

  it("accepts a complete agent", () => {
    const agent = {
      ...minimal,
      icon: "🔎",
      role: "Frames products.",
      identity: "Curious.",
      communication_style: "Plain.",
      principles: ["Evidence first."],
      persistent_facts: ["We ship weekly.", "file:docs/rules.md"],
      activation_steps_prepend: ["Read the brief."],
      activation_steps_append: ["List open questions."],
      menu: [
        { code: "FP", description: "Frame the problem", prompt: "Frame it." },
        { code: "BR", description: "Brainstorm", skill: "brainstorm" },
      ],
      voice: { tone: "Warm and curious", pace: "Unhurried", register: "Plain, friendly" },
    };
    expect(AgentDefinitionSchema.parse(agent)).toEqual(agent);
  });

  it.each([
    ["no name", { title: "t" }, ["name"]],
    ["no title", { name: "Iris" }, ["title"]],
    ["an empty name", { ...minimal, name: " " }, ["name"]],
    ["a name over 40 characters", { ...minimal, name: "a".repeat(41) }, ["name"]],
    ["an unknown key", { ...minimal, mood: "x" }, []],
    [
      "a menu item with skill and prompt",
      { ...minimal, menu: [{ code: "A", description: "d", skill: "s", prompt: "p" }] },
      ["menu", 0, "prompt"],
    ],
    [
      "a menu item with neither",
      { ...minimal, menu: [{ code: "A", description: "d" }] },
      ["menu", 0, "skill"],
    ],
    [
      "a duplicate menu code",
      {
        ...minimal,
        menu: [
          { code: "A", description: "d", prompt: "p" },
          { code: "a", description: "e", prompt: "q" },
        ],
      },
      ["menu", 1, "code"],
    ],
    ["an empty principle", { ...minimal, principles: [" "] }, ["principles", 0]],
    ["an empty file fact", { ...minimal, persistent_facts: ["file:"] }, ["persistent_facts", 0]],
    [
      "a voice with an unknown key",
      { ...minimal, voice: { tone: "t", pace: "p", register: "r", accent: "a" } },
      ["voice"],
    ],
    [
      "a voice without its register",
      { ...minimal, voice: { tone: "t", pace: "p" } },
      ["voice", "register"],
    ],
    [
      "an empty voice trait",
      { ...minimal, voice: { tone: " ", pace: "p", register: "r" } },
      ["voice", "tone"],
    ],
    [
      "a voice trait on two lines",
      { ...minimal, voice: { tone: "t", pace: "slow\nthen fast", register: "r" } },
      ["voice", "pace"],
    ],
    [
      "a voice trait with a carriage return",
      { ...minimal, voice: { tone: "t", pace: "p", register: "plain\rformal" } },
      ["voice", "register"],
    ],
    [
      "a voice trait over 80 characters",
      { ...minimal, voice: { tone: "a".repeat(81), pace: "p", register: "r" } },
      ["voice", "tone"],
    ],
  ])("rejects %s", (_name, value, path) => {
    const result = AgentDefinitionSchema.safeParse(value);
    expect(result.success).toBe(false);
    if (path.length > 0) expect(result.error?.issues[0]?.path).toEqual(path);
  });
});

describe("AgentOverrideSchema", () => {
  it("accepts an empty customisation and keeps lists absent", () => {
    expect(AgentOverrideSchema.parse({})).toEqual({});
  });

  it("accepts every customisable field", () => {
    const override = {
      icon: "🧭",
      role: "r",
      identity: "i",
      communication_style: "c",
      principles: ["p"],
      persistent_facts: ["file:docs/x.md"],
      activation_steps_prepend: ["a"],
      activation_steps_append: ["b"],
      menu: [{ code: "FP", description: "d", prompt: "p" }],
      voice: { tone: "t", pace: "p", register: "r" },
    };
    expect(AgentOverrideSchema.parse(override)).toEqual(override);
  });

  it.each([
    ["name", { name: "X" }, ["name"]],
    ["title", { title: "X" }, ["title"]],
    ["an empty name", { name: null }, ["name"]],
    ["an unknown key", { mood: "x" }, []],
    ["a partial voice", { voice: { tone: "warm" } }, ["voice", "pace"]],
    [
      "a voice with an unknown key",
      { voice: { tone: "t", pace: "p", register: "r", accent: "a" } },
      ["voice"],
    ],
    ["an empty principle", { principles: [""] }, ["principles", 0]],
    [
      "a duplicate menu code",
      {
        menu: [
          { code: "A", description: "d", prompt: "p" },
          { code: "a", description: "e", prompt: "q" },
        ],
      },
      ["menu", 1, "code"],
    ],
  ])("rejects %s", (_name, value, path) => {
    const result = AgentOverrideSchema.safeParse(value);
    expect(result.success).toBe(false);
    if (path.length > 0) expect(result.error?.issues[0]?.path).toEqual(path);
  });
});
