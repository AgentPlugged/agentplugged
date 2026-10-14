import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import {
  type CommandContext,
  initCommand,
  readCases,
  readDefinitions,
  resolveProfile,
  routeByWords,
  syncCommand,
  type ToolProbe,
} from "@agentplugged/core";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The cases of the method's key skills on the real method: valid, discriminating,
 * short, called by the words of their descriptions, and never carried to the AI tools.
 */
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);
const KEY_SKILLS = ["develop-story", "review-story", "write-prd", "round-table"] as const;
const casesPath = (skill: string) => join(methodDir, "skills", skill, "evals", "cases.yaml");

let candidates: Array<{ name: string; description: string }>;

beforeAll(async () => {
  const skills = await readDefinitions(new NodeWorkspaceFiles(methodDir), "skills", "skill");
  if (!Array.isArray(skills)) throw new Error("invalid method");
  candidates = skills.map((skill) => ({
    name: skill.name,
    description: (skill.frontmatter as { description: string }).description,
  }));
});

describe("the cases of the key skills", () => {
  it.each(KEY_SKILLS)("%s has valid cases, with a rubric that discriminates", (skill) => {
    const description = candidates.find((entry) => entry.name === skill)?.description;
    const read = readCases(readFileSync(casesPath(skill), "utf8"), description);
    expect(read.problems, skill).toEqual([]);
    expect(read.warnings, skill).toEqual([]);
    const file = read.file;
    expect(file?.cases.length, skill).toBeGreaterThanOrEqual(2);
    for (const entry of file?.cases ?? []) {
      expect(entry.rubric.length + entry.checks.length, entry.id).toBeGreaterThanOrEqual(2);
      // The run has no engine tool: the case says what the engine answered.
      expect(entry.state, entry.id).toBeDefined();
    }
  });

  it.each(KEY_SKILLS)("%s is called by its words and left quiet by the near misses", (skill) => {
    const file = readCases(readFileSync(casesPath(skill), "utf8")).file;
    const queries = file?.triggers ?? [];
    expect(queries.filter((q) => q.should_trigger).length, skill).toBeGreaterThanOrEqual(3);
    expect(queries.filter((q) => !q.should_trigger).length, skill).toBeGreaterThanOrEqual(2);
    for (const query of queries) {
      const routed = routeByWords(query.query, candidates).skill;
      expect(routed === skill, `${skill}: ${query.query} → ${routed}`).toBe(query.should_trigger);
    }
  });

  it("stays small: a file of cases is read by the engine and costs a run each", () => {
    for (const skill of KEY_SKILLS) {
      expect(statSync(casesPath(skill)).size, skill).toBeLessThanOrEqual(6_000);
    }
  });
});

describe("what the AI tools receive", () => {
  const noTools: ToolProbe = {
    which: async () => undefined,
    version: async () => undefined,
    extensions: async () => [],
  };
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "agentplugged-evalmethod-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("never carries the cases to a product or to a tool: the files of a skill that load at a request stay the same", async () => {
    const context: CommandContext = {
      files: new NodeWorkspaceFiles(cwd),
      tools: noTools,
      method: new NodeWorkspaceFiles(methodDir),
      actor: "human",
      engineVersion: "1.0.0",
    };
    const init = await initCommand.run(context, { profile: resolveProfile("new-product") });
    expect(init.ok).toBe(true);
    const synced = await syncCommand.run(context, {});
    expect(synced.ok).toBe(true);
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else found.push(path);
      }
    };
    walk(cwd);
    expect(found.length).toBeGreaterThan(50);
    expect(found.filter((path) => /[\\/]evals[\\/]|cases\.yaml$/.test(path))).toEqual([]);
    expect(existsSync(join(cwd, ".agentplugged", "skills", "write-prd", "SKILL.md"))).toBe(true);
  });
});
