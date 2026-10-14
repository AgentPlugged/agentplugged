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
    expect(text).toContain(".agentplugged/docs/architecture.md");
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
    const generate = flat(read(`skills/${SKILL}/references/generate.md`));
    expect(generate).toContain("From the words, never from the code");
    expect(generate).toContain("Break the behaviour in the working copy, uncommitted");
    expect(generate).toContain("What cannot be tested end to end");
  });

  it("covers the choice, the layout, the data, the levels, the priorities and the CI", () => {
    const frameworks = flat(read(`skills/${SKILL}/references/frameworks.md`));
    for (const word of [
      "the validated architecture",
      "## Layout",
      "## Data and fixtures",
      "## Configuration",
      "Contract",
      "Never production data",
    ]) {
      expect(frameworks, word).toContain(word);
    }
    // Every runner the engine knows is named where a developer chooses one, in the table or beside it.
    expect(frameworks).toContain("Vitest or Jest");
    expect(frameworks).toContain("pytest");
    expect(frameworks).toContain("Playwright");
    const generate = flat(read(`skills/${SKILL}/references/generate.md`));
    for (const word of ["**P0**", "## API tests", "## End-to-end tests", "An unstable test"]) {
      expect(generate, word).toContain(word);
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
    for (const path of [
      `skills/${SKILL}/SKILL.md`,
      `skills/${SKILL}/references/frameworks.md`,
      `skills/${SKILL}/references/generate.md`,
      `skills/${SKILL}/references/ci.md`,
    ]) {
      expect(read(path), path).not.toMatch(
        new RegExp(`${"bm"}${"ad"}|test architect enterprise|\\btea\\b`, "i"),
      );
    }
  });
});

describe("the tests guard and the grid in the method", () => {
  it("makes the developers stop and ask under a confidence threshold, in both skills", () => {
    for (const path of ["skills/develop-story/SKILL.md", `skills/${SKILL}/SKILL.md`]) {
      const text = flat(read(path));
      expect(text, path).toContain("from 1 to 10");
      expect(text, path).toContain(
        "under 5, stop and ask the creator the one question that blocks most",
      );
      expect(text, path).toContain("from 5 to 6, write it and state the assumption");
    }
  });

  it("lists in the grid the universal rows the engine marks, and never names another method", () => {
    const grid = read("skills/review-tests/references/grid.md");
    for (const row of ["navigate_then_read", "fragile_selector", "raw_event"]) {
      expect(grid, row).toContain(`\`${row}\``);
    }
    for (const path of [
      "skills/review-tests/references/grid.md",
      "skills/review-tests/SKILL.md",
      "skills/develop-story/SKILL.md",
    ]) {
      expect(read(path), path).not.toMatch(
        new RegExp(`${"bm"}${"ad"}|test architect enterprise|\\btea\\b`, "i"),
      );
    }
  });
});
