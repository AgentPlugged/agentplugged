import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The skill that improves a costly session reads the engine's
 * measures, proposes three changes at most, and applies none by itself.
 */
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);
const read = (path: string) => readFileSync(join(methodDir, path), "utf8").replace(/\r\n/g, "\n");
const flat = (text: string) => text.replace(/\s+/g, " ");
const skill = flat(read("skills/improve-session/SKILL.md"));

describe("improve-session", () => {
  it("reads the engine's report and never the conversation", () => {
    expect(skill).toContain("npx agentplugged usage --by session");
    expect(skill).toContain("--session <tool>:<id>");
    expect(skill).toContain("never in the conversation");
  });

  it("proposes three changes at most, from facts only, and applies none alone", () => {
    expect(skill).toContain("at most **three** changes");
    expect(skill).toContain("One proposal per fact of the habits, three at most");
    expect(skill).toContain("Never apply anything yourself");
    expect(skill).toContain("each change is one gesture of the creator");
    for (const kind of ["loaded N times", "read N times", "failed N times"]) {
      expect(skill).toContain(kind);
    }
  });

  it("says where a figure comes from, never turns an unknown into a zero, and shows no money", () => {
    expect(skill).toContain("named by the tool");
    expect(skill).toContain("deduced from the journal");
    expect(skill).toContain("never zero");
    expect(skill).toContain("never `--json`");
    expect(skill).toContain("Never round an unknown into a zero");
    expect(skill).toContain("Tokens only: no amount of money");
    expect(skill).toContain("cannot be measured");
  });

  it("belongs to Lou's menu and stays short", () => {
    expect(read("agents/lou/agent.yaml")).toContain("skill: improve-session");
    expect(read("skills/improve-session/SKILL.md").length).toBeLessThanOrEqual(3_300);
  });
});
