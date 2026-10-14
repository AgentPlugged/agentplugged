import type { DetectedWorkflow } from "@agentplugged/core";
import { createTranslator } from "@agentplugged/i18n";
import { describe, expect, it } from "vitest";
import type { Prompter } from "./prompt.js";
import { chooseGitWorkflow, workflowFromOptions, workflowLine } from "./workflow-flow.js";

/** The questions of the Git workflow, and the options that answer them. */

function prompter(answers: string[]) {
  const said: string[] = [];
  const asked: string[] = [];
  const fake: Prompter = {
    ask: async (question) => {
      asked.push(question);
      return answers.shift();
    },
    say: (text) => said.push(text),
    waitCancel: async () => false,
    askSecret: async () => undefined,
    close: () => undefined,
  };
  return { fake, said, asked };
}

const facts = (over: Partial<DetectedWorkflow["facts"]> = {}) => ({
  repository: true,
  forge: true,
  main: "main",
  staging: null,
  ci: { files: [], where: null },
  story_branches: 0,
  pull_request_merges: false,
  main_protected: undefined,
  ...over,
});

const plain: DetectedWorkflow = {
  existing: false,
  workflow: { story_branches: true, ci: "remote", merge: "pr", review: true },
  found: [],
  facts: facts(),
};

const t = createTranslator("fr");

describe("the Git workflow questions", () => {
  it("keeps the recommendation for everything with one word", async () => {
    const { fake, said } = prompter(["o"]);
    const workflow = await chooseGitWorkflow(t, fake, plain, undefined);
    expect(workflow).toEqual({ story_branches: true, ci: "remote", merge: "pr", review: true });
    expect(said.join("\n")).toContain("créateur solo");
  });

  it("proposes what the product already does instead of replacing it", async () => {
    const found: DetectedWorkflow = {
      existing: true,
      workflow: {
        integration: "develop",
        production: "main",
        story_branches: true,
        ci: "local",
        merge: "pr",
        review: true,
      },
      found: ["branches", "ci"],
      facts: facts({
        staging: "develop",
        ci: { files: [".github/workflows/ci.yml"], where: "local" },
      }),
    };
    const { fake, said } = prompter([""]);
    const workflow = await chooseGitWorkflow(t, fake, found, undefined);
    expect(workflow).toEqual(found.workflow);
    expect(said.join("\n")).toContain("develop");
  });

  it("asks each choice with its recommendation and an argument, and follows the creator", async () => {
    // not the recommendation; main + dev; no branch per story; no CI; no review; no addresses.
    const { fake, said } = prompter(["n", "2", "2", "1", "2", "", ""]);
    const workflow = await chooseGitWorkflow(t, fake, plain, undefined);
    expect(workflow).toEqual({
      integration: "dev",
      production: "main",
      story_branches: false,
      ci: "none",
      merge: "direct",
      review: false,
    });
    const text = said.join("\n");
    expect(text).toContain("(recommandé)");
    expect(text).toContain("main + dev");
    expect(text).toContain("le plus simple pour une personne");
  });

  it("builds a workflow from the options, a word for the recommendation", () => {
    const base = { current: undefined, forge: true, main: "main" };
    expect(workflowFromOptions({}, base)).toBeUndefined();
    expect(workflowFromOptions({ workflow: "recommended" }, base)).toEqual({
      story_branches: true,
      ci: "remote",
      merge: "pr",
      review: true,
    });
    expect(workflowFromOptions({ branches: "main+dev", ci: "none", review: "no" }, base)).toEqual({
      integration: "dev",
      production: "main",
      story_branches: true,
      ci: "none",
      merge: "pr",
      review: false,
    });
    expect(workflowFromOptions({ branches: "prod+staging" }, base)).toMatchObject({
      integration: "staging",
      production: "prod",
    });
    for (const wrong of [
      { ci: "x" },
      { merge: "x" },
      { review: "maybe" },
      { branches: "a+a" },
      { workflow: "x" },
    ]) {
      expect(typeof workflowFromOptions(wrong, base)).toBe("string");
    }
  });

  it("says a workflow in the creator's words", () => {
    expect(
      workflowLine(t, { integration: "dev", production: "main", ci: "none", review: false }),
    ).toContain("pas de CI");
  });
});
