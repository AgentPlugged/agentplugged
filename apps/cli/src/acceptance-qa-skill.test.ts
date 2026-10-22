import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import {
  createCommandRegistry,
  type Definition,
  disallowedToolsFor,
  type QaView,
  RESPONSE_FORMS,
  readDefinitions,
  resolveAgent,
  TOOL_GROUPS,
} from "@agentplugged/core";
import { QA_PROOF_DIR } from "@agentplugged/protocol";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The acceptance QA in a browser, on the side of the method and of the tool list: the
 * skill stays short with its detail in `references/`, no tool is added (one action of `review`), the
 * answer fits its form, Tess has the tool she needs, and the product names no other method.
 */
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);
const read = (path: string) => readFileSync(join(methodDir, path), "utf8").replace(/\r\n/g, "\n");
const SKILL = read("skills/acceptance-qa/SKILL.md");
const NAMES = ["scenarios", "run", "verdicts"];
const REFERENCES = NAMES.map((name) => read(`skills/acceptance-qa/references/${name}.md`));
const TOKEN = 4;

let definitions: Definition[];

beforeAll(async () => {
  const source = new NodeWorkspaceFiles(methodDir);
  const agents = await readDefinitions(source, "agents", "agent");
  const skills = await readDefinitions(source, "skills", "skill");
  if (!Array.isArray(agents) || !Array.isArray(skills)) throw new Error("invalid method");
  definitions = [...agents, ...skills];
});

describe("the acceptance QA stays light", () => {
  it("keeps a short skill, short references the skill sends to, and a short description", () => {
    expect(SKILL.length).toBeLessThanOrEqual(2_800);
    for (const [index, name] of NAMES.entries()) {
      expect(REFERENCES[index]?.length ?? 0, name).toBeLessThanOrEqual(2_500);
      expect(SKILL, name).toContain(`references/${name}.md`);
    }
    const skill = definitions.find((d) => d.name === "acceptance-qa") as Definition;
    const description = (skill.frontmatter as { description: string }).description;
    expect(description.length).toBeLessThanOrEqual(100);
  });

  it("adds no tool: one action of `review`, no field of its own", () => {
    expect(Object.keys(TOOL_GROUPS)).toHaveLength(10);
    expect(TOOL_GROUPS.review?.actions.qa).toEqual({ command: "acceptance_qa" });
    const command = createCommandRegistry()
      .agentCommands()
      .find((entry) => entry.name === "acceptance_qa");
    expect(command).toBeDefined();
    // The same field name as the check of the tests: the published list gains no field.
    const reviewTests = createCommandRegistry()
      .agentCommands()
      .find((entry) => entry.name === "review_tests");
    const fields = (c: unknown) =>
      Object.keys(((c as { inputSchema: { shape: object } }).inputSchema.shape ?? {}) as object);
    expect(fields(reviewTests)).toContain("check");
    expect(fields(command).sort()).toEqual(["agent", "check", "story"]);
  });

  it("answers within its form, for the worst report, and costs a few thousand tokens", () => {
    const worst: QaView = {
      story: "18-5",
      line: "passed 20, failed 20, blocked 19, outside 0",
      results: Array.from(
        { length: 20 },
        (_, i) => `${i + 1} failed (3 proofs): ${"x".repeat(90)}`,
      ),
      no_proof: Array.from({ length: 20 }, (_, i) => i + 1),
      dir: `${QA_PROOF_DIR}/`,
    };
    const answer = JSON.stringify(worst).length;
    expect(RESPONSE_FORMS["review.qa"]?.max ?? 0).toBeGreaterThanOrEqual(1_000);
    // A story has a handful of criteria: the usual answer fits the form with room to spare.
    const usual = JSON.stringify({ ...worst, results: worst.results.slice(0, 5) }).length;
    expect(usual).toBeLessThanOrEqual(RESPONSE_FORMS["review.qa"]?.max ?? 0);
    expect(answer).toBeGreaterThan(usual);
    // The skill, its three references, and the engine's answer, once.
    const total = SKILL.length + REFERENCES.join("").length + usual;
    expect(total / TOKEN, `${Math.round(total / TOKEN)} tokens`).toBeLessThanOrEqual(2_250);
  });

  it("gives Tess the `review` tool the skill cites, through her menu", async () => {
    const tess = definitions.find((d) => d.name === "tess") as Definition;
    const menu = resolveAgent(tess).agent.menu;
    expect(menu.find((item) => item.code === "AQ")?.skill).toBe("acceptance-qa");
    const source = new NodeWorkspaceFiles(methodDir);
    const input = { source, definitions } as unknown as Parameters<typeof disallowedToolsFor>[0];
    expect(await disallowedToolsFor(input, resolveAgent(tess))).not.toContain(
      "mcp__agentplugged__review",
    );
  });
});

describe("the acceptance QA is the method's own", () => {
  const sources = [
    "../packages/core/src/qa/qa-command.ts",
    "../packages/core/src/qa/qa-rules.ts",
    "../packages/protocol/src/acceptance-qa.ts",
  ].map((path) => readFileSync(join(methodDir, path), "utf8"));

  it("names no other method in the skill, its references, Tess, Noah or the engine's words", () => {
    const corpus = [
      SKILL,
      ...REFERENCES,
      read("agents/tess/agent.yaml"),
      read("agents/noah/references/team.md"),
      ...sources,
    ]
      .join("\n")
      .toLowerCase();
    const other = new RegExp(
      ["a", "idd"].join("") + "|" + ["ai", "driven"].join("[- ]?") + "|" + ["bm", "ad"].join(""),
    );
    expect(corpus).not.toMatch(other);
  });

  it("covers the steps, the proofs and the report of a browser QA, in its own words", () => {
    const text = [SKILL, ...REFERENCES].join("\n").toLowerCase();
    // Steps: scope from the criteria alone, a prerequisite check, a run, a reset of state.
    for (const word of [
      "never the code",
      "outside",
      "pilot",
      "must already answer",
      "something behind",
      "screenshot",
      "video",
      "sha-256",
      "blocked",
      "failed",
    ]) {
      expect(text, word).toContain(word);
    }
  });
});
