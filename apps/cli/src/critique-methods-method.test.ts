import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createCommandRegistry } from "@agentplugged/core";
import { CRITIQUE_METHODS, MAX_RECONCILED } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";

/**
 * The critique of a deliverable has a method for each family of risk, read one at a
 * time (two when blended); the grids of judgment live in the checklists of the skills that write
 * the documents; the reconciliation of the creator's inputs is one more method, not one more tool.
 */
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);
const read = (path: string) => readFileSync(join(methodDir, path), "utf8").replace(/\r\n/g, "\n");
const critique = (name: string) => read(`skills/critique-deliverable/references/${name}.md`);
const fileOf = (method: string) => method.replaceAll("_", "-");
/** The test of an idea has its own skill; every other method is a file of the critique. */
const OWN_FILE = CRITIQUE_METHODS.filter((method) => method !== "personas");
const TOKEN = 4;

describe("a method for each family of risk", () => {
  it("has a short file per method, and a choice that names every one of them", () => {
    const choose = critique("choose");
    for (const method of OWN_FILE) {
      expect(critique(fileOf(method)).length, method).toBeLessThanOrEqual(1_000);
      expect(choose, method).toContain(`\`${method}\``);
    }
    expect(OWN_FILE.length).toBeGreaterThanOrEqual(17);
    expect(choose.length).toBeLessThanOrEqual(2_000);
    // The families the document names, each by a method.
    for (const family of [
      "divergence",
      "assumption_audit",
      "steelman",
      "failure_modes",
      "second_order",
      "domain_expert",
      "extreme_user",
      "compare_existing",
    ]) {
      expect(CRITIQUE_METHODS).toContain(family);
    }
  });

  it("states the divergence test of an architecture in the words of its builders", () => {
    const text = critique("divergence").toLowerCase();
    expect(flat(text)).toContain("every decision of the document exactly as written");
    expect(text).toContain("do not fit");
    // The architecture's own checklist offers it for a high-stakes document.
    expect(read("skills/write-architecture/references/self-check.md")).toContain("`divergence`");
  });

  it("explains the blend: two methods, two files, never three, and the solo ones", () => {
    const choose = flat(critique("choose"));
    expect(choose).toContain("Blend");
    expect(choose).toContain("Never three");
    expect(choose).toContain("`personas` and `reconcile` stand alone");
    expect(flat(read("skills/critique-deliverable/SKILL.md"))).toContain("two files if blended");
  });

  it("costs a few thousand tokens for a blended critique, two files of method and no more", () => {
    const shared = [read("skills/critique-deliverable/SKILL.md"), critique("format")]
      .concat(critique("choose"), critique("gestures"))
      .reduce((sum, text) => sum + text.length, 0);
    const read2 = shared + critique("divergence").length + critique("failure-modes").length;
    const all = OWN_FILE.reduce((sum, method) => sum + critique(fileOf(method)).length, shared);
    // An estimate at 4 characters a token, not a measure: the files read are real, what the agent
    // writes is assumed. What the agent writes: eight objections of ≈ 450 characters, a stack of eight lines of ≈ 120
    // and three gestures with the creator's words.
    const tokens = (read2 + 8 * 450 + 8 * 120 + 3 * 120 + 300) / TOKEN;
    expect(tokens, `${Math.round(tokens)} tokens`).toBeLessThanOrEqual(5_000);
    expect(read2).toBeLessThan(all * 0.6);
  });

  it("adds no tool and no command: the reconciliation and the blend are the same action", () => {
    const registry = createCommandRegistry();
    expect(registry.agentCommands().filter((c) => c.name === "critique")).toHaveLength(1);
  });
});

describe("the grids of judgment and the control of excess", () => {
  it("asks four questions of the whole PRD, with a verdict, in the PRD checklist", () => {
    const text = read("skills/write-prd/references/prd-checklist.md");
    const grid = text.slice(text.indexOf("## Judgment of the whole"));
    for (const question of ["Thesis", "Theater", "Trade-offs", "Form fit"]) {
      expect(grid, question).toContain(`**${question}.**`);
    }
    expect(grid).toContain("holds, thin or broken");
    expect(grid).toContain("`judgment`");
    expect(text.indexOf("## Judgment of the whole")).toBeLessThan(
      text.indexOf("## Scope and form"),
    );
  });

  it("controls the excess of a UX specification: tokens, restating, prose, unreached screens", () => {
    const text = read("skills/write-ux-spec/references/ux-checklist.md");
    const grid = text.slice(text.indexOf("## Excess (over-specification)"));
    for (const point of ["One home per value", "One home per fact", "A reader per section"]) {
      expect(grid, point).toContain(`**${point}.**`);
    }
    expect(flat(grid)).toContain("that no journey of the PRD reaches");
    expect(grid).toContain("`judgment`");
  });

  it("gives the judgment its own short method, which sends to the grid and reports the closed form", () => {
    const text = critique("judgment");
    expect(text.length).toBeLessThanOrEqual(1_000);
    expect(text).toContain("prd-checklist.md");
    expect(text).toContain("ux-checklist.md");
    expect(text).toContain("thin and the broken");
  });
});

describe("the reconciliation of the creator's inputs", () => {
  it("is asked before the PRD, the UX specification and the architecture are validated", () => {
    for (const skill of ["write-prd", "write-ux-spec", "write-architecture"]) {
      const text = flat(read(`skills/${skill}/SKILL.md`));
      expect(text, skill).toContain("reconcile the inputs");
      expect(text, skill).toContain("`critique-deliverable/references/reconcile.md`");
      expect(text, skill).toContain('`lenses: ["reconcile"]`, 5 findings at most');
      expect(text, skill).toContain("one gesture per finding");
    }
    expect(MAX_RECONCILED).toBe(5);
  });

  it("looks for the qualitative first, reports nothing it cannot quote, and never rewrites", () => {
    const text = flat(critique("reconcile"));
    expect(text.length).toBeLessThanOrEqual(1_000);
    expect(text).toContain("qualitative");
    expect(text).toContain("quoted");
    expect(text).toContain("never a rewriting");
    expect(text).toContain("Keep five at most");
  });

  it("costs a few thousand tokens, in a fresh context that reads only what it needs", () => {
    // Estimates, not measures: the sources and the document are assumed, the method files are real.
    const sources = 3 * 1_500; // the brief and two notes
    const document = 6_000; // a PRD of a few pages
    const read1 = critique("reconcile").length + critique("format").length + sources + document;
    const written = 5 * 450 + 5 * 120 + 300;
    const tokens = (read1 + written + critique("gestures").length) / TOKEN;
    expect(tokens, `${Math.round(tokens)} tokens`).toBeLessThanOrEqual(5_000);
  });
});

function flat(text: string) {
  return text.replace(/\s+/g, " ");
}
