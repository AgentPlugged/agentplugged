import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import { type Definition, readDefinitions } from "@agentplugged/core";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The test framework and the API and end-to-end tests are a skill of the developers,
 * short, with its detail in files read when a mode runs, and it covers at least what a test
 * architect's workflows cover (choice and installation of the framework, layout, data and fixtures,
 * API and end-to-end tests, priorities, the CI), in its own words.
 */
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);
const SKILL = "api-e2e-tests";
const flat = (text: string) => text.replace(/\s+/g, " ");
const read = (path: string) => readFileSync(join(methodDir, path), "utf8").replace(/\r\n/g, "\n");

let skills: Definition[];

beforeAll(async () => {
  const shipped = await readDefinitions(new NodeWorkspaceFiles(methodDir), "skills", "skill");
  if (!Array.isArray(shipped)) throw new Error("invalid shipped method");
  skills = shipped;
});

describe("the api-e2e-tests skill", () => {
  it("ships for the developers, in the build phase", () => {
    const skill = skills.find((definition) => definition.name === SKILL);
    expect(skill?.frontmatter).toMatchObject({
      metadata: { agent: "sam ethan hugo lina jade", phase: "build" },
    });
  });

  it("frames from the validated stack, installs through the creator's validation, declares for the engine", () => {
    const text = flat(read(`skills/${SKILL}/SKILL.md`));
    expect(text).toContain("docs read @stack");
    expect(text).toContain("`spec.md`");
    expect(text).toContain("npx agentplugged tests setup");
    expect(text).toContain("The validated stack wins");
    expect(text).toContain("No language, no framework is imposed");
    expect(text).toContain('"Installing dependencies"');
    expect(text).toContain("one point of the stack, one gesture");
    expect(text).toContain("`guard.creator_action`, `kind: proof_commands`");
    expect(text).toContain("Never accept it yourself");
  });

  it("writes from the criteria and the journeys, names the criterion, shows red then green", () => {
    const text = flat(read(`skills/${SKILL}/SKILL.md`));
    expect(text).toContain("named `AC-<story>-<n>`");
    expect(text).toContain("seen red then green by `story.criterion`");
    expect(text).toContain("`seen: untestable`");
    expect(text).toContain("never to decide what to test");
    expect(text).toContain("Never write a test from the code it checks");
    expect(text).toContain("Write the scenario from the words of the criterion");
    expect(text).toContain("break the behaviour uncommitted");
    expect(text).toContain("Not testable");
  });

  it("covers the choice, the layout, the levels, the priorities and the CI", () => {
    const text = flat(read(`skills/${SKILL}/SKILL.md`));
    for (const word of [
      "Layout:",
      "P0",
      "Unstable:",
      "A runner already in use is never replaced",
    ]) {
      expect(text, word).toContain(word);
    }
    const ci = flat(read(`skills/${SKILL}/references/ci.md`));
    expect(ci).toContain("Not checked by the CI");
    expect(ci).toContain("never an `allow_failure`");
    expect(ci).toContain("A gate that can fail");
  });

  it("is reached from the test strategy", () => {
    expect(flat(read("agents/tess/agent.yaml"))).toContain(
      "the developers set them up with the `api-e2e-tests` skill",
    );
  });

  it("extends the CI skill and the acceptance tests instead of repeating them", () => {
    expect(flat(read("skills/setup-ci/SKILL.md"))).toContain("Not checked by the CI");
    expect(flat(read("skills/setup-ci/SKILL.md"))).toContain("`api-e2e-tests`");
    expect(flat(read("skills/develop-story/references/acceptance-tests.md"))).toContain(
      "`api-e2e-tests`",
    );
    expect(read("README.md")).toContain("| `api-e2e-tests` |");
  });

  it("never names another method", () => {
    for (const path of [`skills/${SKILL}/SKILL.md`, `skills/${SKILL}/references/ci.md`]) {
      expect(read(path), path).not.toMatch(
        new RegExp(`${"bm"}${"ad"}|test architect enterprise|\\btea\\b`, "i"),
      );
    }
  });
});

describe("the tests guard and the grid in the method", () => {
  it("lists in the grid the universal rows the engine marks, and never names another method", () => {
    const grid = read("skills/review-story/references/tests.md");
    for (const row of ["navigate_then_read", "fragile_selector", "raw_event"]) {
      expect(grid, row).toContain(`\`${row}\``);
    }
    for (const path of [
      "skills/review-story/references/tests.md",
      "skills/review-story/SKILL.md",
      "skills/develop-story/SKILL.md",
    ]) {
      expect(read(path), path).not.toMatch(
        new RegExp(`${"bm"}${"ad"}|test architect enterprise|\\btea\\b`, "i"),
      );
    }
  });
});
