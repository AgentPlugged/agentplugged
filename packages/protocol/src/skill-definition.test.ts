import { describe, expect, it } from "vitest";
import {
  AgentFrontmatterSchema,
  ClaudeSettingsSchema,
  SkillFrontmatterSchema,
  SyncManifestSchema,
} from "./index.js";

const metadata = { domain: "product", phase: "framing", risk: "low", model_tier: "reasoning" };
const agent = { name: "iris", description: "Frames the product.", metadata };

describe("SkillFrontmatterSchema", () => {
  it("accepts the portable keys", () => {
    const skill = {
      name: "write-prd",
      description: "Writes a PRD.",
      license: "MIT",
      compatibility: "Needs git",
      metadata: { author: "me" },
      "allowed-tools": "Read Grep",
    };
    expect(SkillFrontmatterSchema.parse(skill)).toEqual(skill);
  });

  it.each([
    ["an empty name", { name: "", description: "d" }, "name"],
    ["an upper-case name", { name: "Iris", description: "d" }, "name"],
    ["a leading hyphen", { name: "-iris", description: "d" }, "name"],
    ["a double hyphen", { name: "a--b", description: "d" }, "name"],
    ["a name over 64 characters", { name: "a".repeat(65), description: "d" }, "name"],
    ["an empty description", { name: "a", description: "" }, "description"],
    ["a description over 1024", { name: "a", description: "d".repeat(1025) }, "description"],
    [
      "a non-string metadata value",
      { name: "a", description: "d", metadata: { n: 1 } },
      "metadata",
    ],
    ["a key outside the standard", { name: "a", description: "d", model: "x" }, undefined],
  ])("rejects %s", (_name, value, field) => {
    const result = SkillFrontmatterSchema.safeParse(value);
    expect(result.success).toBe(false);
    if (field) expect(result.error?.issues[0]?.path[0]).toBe(field);
  });

  it("accepts a 64-character name and a 1024-character description", () => {
    const value = { name: "a".repeat(64), description: "d".repeat(1024) };
    expect(SkillFrontmatterSchema.safeParse(value).success).toBe(true);
  });
});

describe("AgentFrontmatterSchema", () => {
  it("accepts an agent, with extra string metadata", () => {
    const value = { ...agent, metadata: { ...metadata, version: "1" } };
    expect(AgentFrontmatterSchema.parse(value)).toEqual(value);
  });

  it.each([
    ["domain", "legal"],
    ["phase", "dreaming"],
    ["risk", "extreme"],
    ["model_tier", "huge"],
  ])("rejects an unknown %s", (key, value) => {
    const result = AgentFrontmatterSchema.safeParse({
      ...agent,
      metadata: { ...metadata, [key]: value },
    });
    expect(result.error?.issues[0]?.path).toEqual(["metadata", key]);
  });

  it("requires metadata", () => {
    const result = AgentFrontmatterSchema.safeParse({ name: "iris", description: "d" });
    expect(result.error?.issues[0]?.path).toEqual(["metadata"]);
  });
});

describe("SyncManifestSchema and ClaudeSettingsSchema", () => {
  it("accepts a manifest and rejects a bad hash", () => {
    const manifest = { format_version: 1, files: { "a.md": "0".repeat(64) }, permissions: [] };
    expect(SyncManifestSchema.parse(manifest)).toEqual(manifest);
    expect(SyncManifestSchema.safeParse({ ...manifest, files: { a: "xyz" } }).success).toBe(false);
  });

  it("keeps unknown settings keys and checks deny", () => {
    const settings = { env: { A: "1" }, permissions: { allow: ["Read"], deny: ["Edit(/x)"] } };
    expect(ClaudeSettingsSchema.parse(settings)).toEqual(settings);
    expect(ClaudeSettingsSchema.safeParse({ permissions: { deny: "x" } }).success).toBe(false);
    expect(ClaudeSettingsSchema.safeParse([]).success).toBe(false);
  });
});
