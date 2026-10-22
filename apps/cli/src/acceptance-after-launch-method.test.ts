import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import { type Definition, readDefinitions } from "@agentplugged/core";
import { JOURNEY_STEPS } from "@agentplugged/protocol";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The acceptance run and the look back after a launch are two short work sheets: one author each,
 * in writing, no meeting; the place of the acceptance is the creator's; the step names are the
 * ones the engine proposes and the creator may skip.
 */
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);
const read = (path: string) => readFileSync(join(methodDir, path), "utf8").replace(/\r\n/g, "\n");

let skills: Definition[];

beforeAll(async () => {
  const shipped = await readDefinitions(new NodeWorkspaceFiles(methodDir), "skills", "skill");
  if (!Array.isArray(shipped)) throw new Error("invalid shipped method");
  skills = shipped;
});

const sheet = (name: string) => read(`skills/${name}/SKILL.md`);

describe("the skill run-acceptance", () => {
  it("is a short sheet for Quentin in the delivery phase, with one reference for the template", () => {
    const skill = skills.find((definition) => definition.name === "run-acceptance");
    expect(skill?.frontmatter).toMatchObject({ metadata: { agent: "quentin", phase: "delivery" } });
    const text = sheet("run-acceptance");
    expect(text.length).toBeLessThanOrEqual(5_000);
    expect(text.length).toBeGreaterThan(3_000);
    expect(
      existsSync(join(methodDir, "skills", "run-acceptance", "references", "template.md")),
    ).toBe(true);
    expect(text).toContain("references/template.md");
  });

  it("takes the place from the profile, proposes it in one line, and never imposes staging", () => {
    const text = sheet("run-acceptance");
    expect(text).toContain("docs profile accept <local|staging> [how]");
    expect(text).toContain("`Acceptance`");
    expect(text).toMatch(/on their machine/);
    expect(text).toMatch(/Never impose staging/);
    expect(text).toMatch(/never create an account/i);
  });

  it("covers the journeys, the screens against the mockups, accessibility and speed, with proofs", () => {
    const text = sheet("run-acceptance");
    for (const word of ["Journeys", "Screens", "Quality", "mockup", "accessibility", "speed"]) {
      expect(text.toLowerCase(), word).toContain(word.toLowerCase());
    }
    expect(text).toMatch(/Never claim a pass without its proof/);
    expect(text).toContain("`unknown`");
  });

  it("asks « Recette passée ? » once, in the chat, on a document point the engine reads", () => {
    const text = sheet("run-acceptance");
    expect(text).toContain("Recette passée ?");
    expect(text).toContain("`checkpoint.open` `type: document`");
    expect(text).toContain("`chat.answer`");
  });
});

describe("the skill review-after-launch", () => {
  it("is a short sheet for Iris written by one agent, in writing, with no discussion between agents", () => {
    const skill = skills.find((definition) => definition.name === "review-after-launch");
    expect(skill?.frontmatter).toMatchObject({ metadata: { agent: "iris", phase: "launch" } });
    const text = sheet("review-after-launch");
    expect(text.length).toBeLessThanOrEqual(5_000);
    expect(text.length).toBeGreaterThan(3_000);
    expect(text).toMatch(/alone: one agent, in writing, short/);
    expect(text).toMatch(/Never call or direct another agent, never hold a discussion/);
  });

  it("measures usage, errors and cost with their sources, and never invents a figure", () => {
    const text = sheet("review-after-launch");
    for (const word of ["Usage and results", "Errors", "Cost of building", "`unknown`"]) {
      expect(text, word).toContain(word);
    }
    expect(text).toContain("npx agentplugged usage --since");
    expect(text).toMatch(/Never write a figure no source gives/);
  });

  it("turns the feedback into tickets for Izzy and asks « Ce qu'on fait ensuite » once", () => {
    const text = sheet("review-after-launch");
    expect(text).toContain("`plan.defer`");
    expect(text).toContain("`owner: izzy`");
    expect(text).toContain("Ce qu'on fait ensuite");
    expect(text).toContain("no `locks`");
  });
});

describe("the two steps of the journey", () => {
  it("are steps the creator may skip, named in the constitution and in Noah's reference", () => {
    expect(JOURNEY_STEPS).toContain("acceptance");
    expect(JOURNEY_STEPS).toContain("after_launch");
    expect(read("agents/noah/references/journey.md")).toContain("`acceptance`, `after_launch`");
  });

  it("add no meeting procedure to the method (the method is written for one agent at a time)", () => {
    const files: string[] = [];
    const walk = (dir: string, base: string) => {
      for (const entry of readdirSync(join(methodDir, dir), { withFileTypes: true })) {
        const path = `${base}${entry.name}`;
        if (entry.isDirectory()) walk(`${dir}/${entry.name}`, `${path}/`);
        else if (/\.(md|ya?ml)$/.test(entry.name)) files.push(path);
      }
    };
    walk("skills/run-acceptance", "skills/run-acceptance/");
    walk("skills/review-after-launch", "skills/review-after-launch/");
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) {
      const text = read(file).replace(/\s+/g, " ");
      expect(text, file).not.toMatch(/\b(meeting|round table|party mode|roundtable)\b/i);
      expect(text.toLowerCase(), file).not.toContain("cock" + "pit");
      expect(text, file).not.toMatch(/\b(EF|AD)-\d/);
      expect(text, file).not.toMatch(/story \d+\.\d+/i);
    }
  });
});
