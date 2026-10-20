import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  createCommandRegistry,
  RESPONSE_FORMS,
  type ReadyResult,
  TOOL_GROUPS,
} from "@agentplugged/core";
import { JOURNEY_STEPS, READINESS_EVENT_TYPES } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";

/**
 * The readiness gate, on the side of the method and of the tool list: the skill stays
 * short with its detail in `references/`, no tool is added (one action of `review`), the answers fit
 * their form, and the reference method is not named.
 */
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);
const read = (path: string) => readFileSync(join(methodDir, path), "utf8").replace(/\r\n/g, "\n");
const SKILL = read("skills/check-readiness/SKILL.md");
const REFERENCES = ["judge", "settle"].map((name) =>
  read(`skills/check-readiness/references/${name}.md`),
);
const TOKEN = 4;

describe("the readiness gate stays light", () => {
  it("keeps a short skill, short references, and adds a tool to no one", () => {
    expect(SKILL.length).toBeLessThanOrEqual(2_000);
    for (const reference of REFERENCES) expect(reference.length).toBeLessThanOrEqual(1_200);
    expect(Object.keys(TOOL_GROUPS)).toHaveLength(10);
    expect(TOOL_GROUPS.review?.actions.ready).toEqual({ command: "ready" });
    expect(createCommandRegistry().agentCommands()).toHaveLength(65);
  });

  it("costs a few thousand tokens for a check with its gestures", () => {
    const worst: ReadyResult = {
      stage: "build",
      track: "full",
      judged: "current",
      verdict: "blocking",
      open: { blocking: 12, should_fix: 12, minor: 12 },
      accepted: 3,
      stack: Array.from({ length: 12 }, () => "x".repeat(150)),
      more: 20,
      documents: Array.from({ length: 6 }, () => ".agentplugged/docs/architecture.md"),
      epics: 8,
      stories: 60,
      ids: { EF: 40, ENF: 12, PU: 8, AD: 20 },
    };
    const answer = JSON.stringify(worst).length;
    expect(answer).toBeLessThanOrEqual(RESPONSE_FORMS["review.ready"]?.max ?? 0);
    // The skill, its two references, the engine's reading and the report's answer.
    const total = SKILL.length + REFERENCES.join("").length + 2 * answer;
    expect(total / TOKEN, `${Math.round(total / TOKEN)} tokens`).toBeLessThanOrEqual(3_500);
  });
});

describe("the readiness gate is the method's own", () => {
  it("names no other method in the skill, its references or the engine's words", () => {
    const corpus = [SKILL, ...REFERENCES, read("agents/noah/references/decisions.md")].join("\n");
    const other = new RegExp(["bm", "ad"].join("") + "|" + ["bm", "m"].join(""));
    expect(corpus.toLowerCase()).not.toMatch(other);
  });

  it("repeats no run of six words of the gate it was studied from", () => {
    const other = ["bm", "ad"].join("");
    const path = join(
      methodDir,
      "..",
      ".claude",
      "skills",
      other + "-sprint-planning",
      "references",
      "readiness-gate.md",
    );
    if (!existsSync(path)) return;
    const words = (text: string) =>
      text
        .toLowerCase()
        .replace(/[^a-z0-9s]+/g, " ")
        .split(/s+/)
        .filter(Boolean);
    const runs = (list: string[]) =>
      new Set(list.slice(5).map((_, i) => list.slice(i, i + 6).join(" ")));
    const theirs = runs(words(readFileSync(path, "utf8")));
    const ours = runs(
      words([SKILL, ...REFERENCES, read("agents/noah/references/decisions.md")].join(" ")),
    );
    expect([...ours].filter((run) => theirs.has(run))).toEqual([]);
  });

  it("is a step the creator can skip, and a skill Noah can hand over", () => {
    expect(JOURNEY_STEPS).toContain("readiness");
    expect(READINESS_EVENT_TYPES.reported).toBe("readiness.reported");
    const noah = read("agents/noah/references/decisions.md").replace(/\s+/g, " ");
    expect(noah).toContain("`readiness`");
    expect(noah).toContain("`check-readiness`");
    expect(noah).toContain("`step_skip`");
  });
});
