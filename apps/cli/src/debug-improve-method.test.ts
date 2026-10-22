import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  createCommandRegistry,
  INSTRUMENTATION_MARKER,
  parseHypothesis,
  TOOL_GROUPS,
} from "@agentplugged/core";
import { LOOP_MAX_ATTEMPTS, LOOP_SEEN } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";

/**
 * Debugging and improving code, on the side of the method: two short skills with
 * their detail in `references/`, no tool added (the hypotheses go through the loop's action), the
 * words of the skills match what the engine does, and the reference method is not named.
 */
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);
const read = (path: string) => readFileSync(join(methodDir, path), "utf8").replace(/\r\n/g, "\n");
const DIAGNOSE = read("skills/diagnose-bug/SKILL.md");
const IMPROVE = read("skills/improve-code/SKILL.md");
const REFERENCES = {
  "diagnose-bug": ["hypotheses", "probes"],
  "improve-code": ["axes"],
} as const;
const TOKEN = 4;

describe("the two skills stay short and add no tool", () => {
  it("keeps each body to 4 400 characters and each reference to 2 500", () => {
    expect(DIAGNOSE.length).toBeLessThanOrEqual(4_400);
    expect(IMPROVE.length).toBeLessThanOrEqual(4_400);
    for (const [skill, names] of Object.entries(REFERENCES)) {
      for (const name of names) {
        const path = `skills/${skill}/references/${name}.md`;
        expect(existsSync(join(methodDir, path)), path).toBe(true);
        expect(read(path).length, path).toBeLessThanOrEqual(2_500);
        expect(skill === "diagnose-bug" ? DIAGNOSE : IMPROVE, path).toContain(`${name}.md`);
      }
    }
  });

  it("goes through the actions that exist: the loop's, the criterion's, the proofs'", () => {
    expect(Object.keys(TOOL_GROUPS)).toHaveLength(10);
    expect(TOOL_GROUPS.story?.actions.loop).toEqual({ command: "loop" });
    expect(createCommandRegistry().agentCommands()).toHaveLength(65);
    for (const word of ["story.loop", "story.criterion", "story.start", "story.result"]) {
      expect(DIAGNOSE, word).toContain(word);
    }
    for (const word of ["measure.run", "story.criterion", "story.result", "plan.defer"]) {
      expect(IMPROVE, word).toContain(word);
    }
  });

  it("costs a few thousand tokens for a run with its references", () => {
    const size = (skill: keyof typeof REFERENCES) =>
      REFERENCES[skill].reduce(
        (sum, name) => sum + read(`skills/${skill}/references/${name}.md`).length,
        0,
      );
    const diagnose = DIAGNOSE.length + size("diagnose-bug");
    const improve = IMPROVE.length + size("improve-code");
    // Measured about 2 070 and 1 680 tokens.
    expect(diagnose / TOKEN).toBeLessThanOrEqual(2_150);
    expect(improve / TOKEN).toBeLessThanOrEqual(1_750);
  });
});

describe("the diagnosis follows what the engine keeps", () => {
  it("speaks the loop's words: hypothesis, ruled out, confirmed, three failures", () => {
    for (const seen of ["hypothesis", "ruled_out", "confirmed"]) {
      expect(LOOP_SEEN as readonly string[], seen).toContain(seen);
      expect(DIAGNOSE, seen).toContain(seen);
    }
    expect(LOOP_MAX_ATTEMPTS).toBe(3);
    expect(DIAGNOSE).toContain("three fixes that failed");
    expect(DIAGNOSE).toContain("cause_unconfirmed");
    // The example the skill gives is a hypothesis the engine reads.
    const example = /note: "(\d+\/10 [^"]+)"/.exec(DIAGNOSE)?.[1];
    expect(example === undefined ? undefined : parseHypothesis(example)?.confidence).toBe(7);
  });

  it("names the marker of temporary code as the engine reads it, and how to take it out", () => {
    const probes = read("skills/diagnose-bug/references/probes.md");
    expect(probes).toContain(INSTRUMENTATION_MARKER);
    expect(probes).toContain("debug_instrumentation_left");
    expect(DIAGNOSE).toContain("debug_instrumentation_left");
  });

  it("starts from a failing test and never fixes before the cause", () => {
    expect(DIAGNOSE).toMatch(/A test that fails/);
    expect(DIAGNOSE).toMatch(/Never fix before the failing test, nor before a cause is confirmed/);
  });
});

describe("the improvement proves behaviour unchanged with the engine", () => {
  it("runs the project's commands before the first change and after the last", () => {
    expect(IMPROVE).toMatch(/Before: the baseline/);
    expect(IMPROVE).toMatch(/\*\*After\.\*\*/);
    expect(IMPROVE).toContain("measure.run");
    expect(IMPROVE).toMatch(/never to your word|on your word/);
  });

  it("takes its input from the findings of the audit, the duplicates, the tests and the review", () => {
    for (const source of ["audit-pillars", "reuse", "review.tests", "review finding"]) {
      expect(IMPROVE, source).toContain(source);
    }
    const axes = read("skills/improve-code/references/axes.md");
    for (const axis of ["cleanup", "performance", "security", "architecture"]) {
      expect(IMPROVE, axis).toContain(axis);
      expect(axes, axis).toContain(`## ${axis}`);
    }
  });
});

describe("the quick lane hands a bug that is not trivial to the diagnosis", () => {
  it("names diagnose-bug in its triage, and Noah routes to it", () => {
    const triage = read("skills/develop-story/references/quick-lane.md");
    expect(triage).toContain("diagnose-bug");
    expect(read("agents/noah/references/team.md")).toContain("`diagnose-bug`");
  });
});
