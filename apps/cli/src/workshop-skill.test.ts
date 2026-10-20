import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import {
  analyzeDefinition,
  type CommandContext,
  createCommandRegistry,
  type Definition,
  initCommand,
  readDefinitions,
  resolveProfile,
  TOOL_GROUPS,
  type ToolProbe,
  verifyDefinition,
  type WorkshopResult,
} from "@agentplugged/core";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The skill Lou carries is short and sends its
 * detail to files; the engine's rules say nothing against the shipped agents and skills (their
 * analysis finds no instruction that goes round a rule); an addition made on the real method is
 * written for every tool and leaves the method untouched; a typical session costs a few thousand
 * tokens, and no tool is added.
 */
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);
const read = (path: string) => readFileSync(join(methodDir, path), "utf8").replace(/\r\n/g, "\n");
const TOKEN = 4;

let definitions: Definition[];

beforeAll(async () => {
  const source = new NodeWorkspaceFiles(methodDir);
  const agents = await readDefinitions(source, "agents", "agent");
  const skills = await readDefinitions(source, "skills", "skill");
  if (!Array.isArray(agents) || !Array.isArray(skills)) throw new Error("invalid method");
  definitions = [...agents, ...skills];
});

describe("the skill and its place in the team", () => {
  const skill = () => definitions.find((d) => d.name === "workshop" && d.kind === "skill");

  it("is Lou's, short, and sends the detail to files read when needed", () => {
    const definition = skill() as Definition;
    expect(definition.frontmatter).toMatchObject({ metadata: { agent: "lou" } });
    expect((definition.frontmatter as { description: string }).description.length).toBeLessThan(
      180,
    );
    expect(definition.text.length).toBeLessThanOrEqual(3_600);
    const files = readdirSync(join(methodDir, "skills/workshop/references")).sort();
    expect(files).toEqual(["analyze.md", "create.md", "customize.md", "evaluate.md", "rules.md"]);
    for (const file of files) expect(definition.text, file).toContain(`references/${file}`);
    for (const file of files) {
      expect(read(`skills/workshop/references/${file}`).length, file).toBeLessThanOrEqual(3_600);
    }
  });

  it("is offered by Lou's menu and proposed by Noah, and changes no tool", () => {
    const lou = definitions.find((d) => d.name === "lou" && d.kind === "agent") as Definition;
    expect(lou.agent?.menu.find((item) => item.code === "WK")).toMatchObject({ skill: "workshop" });
    expect(read("agents/noah/references/team.md")).toContain("the skill `workshop` to Lou");
    // One action of an existing tool, no tool of its own.
    expect(TOOL_GROUPS.agent?.actions.workshop?.command).toBe("workshop");
    expect(Object.keys(TOOL_GROUPS)).toHaveLength(10);
  });
});

describe("the rules of the engine against the shipped method (calibration)", () => {
  it("find no instruction that goes round a rule in any shipped agent or skill", () => {
    const skills = new Set(definitions.filter((d) => d.kind === "skill").map((d) => d.name));
    for (const definition of definitions) {
      const findings = analyzeDefinition({
        definition,
        origin: "shipped",
        all: definitions,
        skills,
      });
      const unsafe = findings.filter((finding) => finding.rule === "unsafe_instruction");
      expect(unsafe, definition.name).toEqual([]);
    }
  });

  it("find no broken link and no ceiling broken in the shipped method, and verify it all", () => {
    const skills = new Set(definitions.filter((d) => d.kind === "skill").map((d) => d.name));
    for (const definition of definitions) {
      const findings = analyzeDefinition({
        definition,
        origin: "shipped",
        all: definitions,
        skills,
      });
      const fixes = findings.filter((finding) => finding.severity === "fix");
      expect(fixes, definition.name).toEqual([]);
      const checks = verifyDefinition(
        { definition, origin: "shipped", all: definitions, skills },
        [],
        [],
      );
      expect(
        checks.filter((check) => !check.ok),
        definition.name,
      ).toEqual([]);
    }
  });
});

const noTools: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

/** Every file of the method with its content: the method must come out of a creation as it went in. */
function methodHash(): string {
  const snapshot: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) snapshot.push(`${path}\n${readFileSync(path, "latin1")}`);
    }
  };
  walk(methodDir);
  return snapshot.join("\n--\n");
}

describe("an addition made on the real method", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "agentplugged-workshop-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const context = (actor: "human" | "agent" = "human"): CommandContext => ({
    files: new NodeWorkspaceFiles(cwd),
    tools: noTools,
    method: new NodeWorkspaceFiles(methodDir),
    actor,
    engineVersion: "1.0.0",
  });

  /** The action of the same creation as `guard.creator_action` takes it. */
  const request = (input: { action: string; kind: string; [key: string]: unknown }) => {
    const { action: _action, kind, ...rest } = input;
    return { ...rest, kind: "agent_create", definition: kind };
  };

  const SKILL = {
    action: "create",
    kind: "skill",
    id: "pricing-check",
    description: "Price an offer step by step with the creator, from costs they know.",
    content: {
      steps: [
        "Ask which offer to price, and for whom.",
        "List the costs they know; read references/checklist.md for the ones they forget.",
        "Propose three prices with the reasoning; the creator picks.",
      ],
      outputs: ["A note with the chosen price and its reasoning, in docs/pricing.md"],
      rules: ["Never invent a cost: ask.", "The creator decides the price."],
      references: [{ name: "checklist", lines: ["Hosting and tools", "Time", "Taxes and fees"] }],
    },
  };
  const AGENT = {
    action: "create",
    kind: "agent",
    id: "pilot",
    title: "Pricing pilot",
    description: "Prices a small offer with the creator during the launch phase.",
    domain: "sales",
    phase: "launch",
    content: {
      overview: "Pilot prices a small offer with the creator and keeps the reasoning.",
      produces: ["A pricing note in docs/pricing.md"],
      works: ["Asks one question at a time and recommends one price"],
      never: ["Never publishes a price nor sends an offer"],
      principles: ["The creator decides", "A price comes with its reasoning"],
      menu: [{ code: "PR", description: "Price an offer", skill: "pricing-check" }],
    },
  };

  it("is checked, created, written for every tool, verified, and the method is untouched", async () => {
    const registry = createCommandRegistry();
    const before = methodHash();
    const init = await initCommand.run(context(), { profile: resolveProfile("new-product") });
    expect(init.ok).toBe(true);

    // Check first, as the skill says: nothing is written, the cost is told.
    const checked = await registry.run("workshop", context("agent"), {
      workshop: { op: "check", action: request(SKILL) },
    });
    expect(checked.ok).toBe(true);
    for (const [name, input] of [
      ["skill", SKILL],
      ["agent", AGENT],
    ] as const) {
      const created = await registry.run("agent", context(), input);
      expect(created.ok, name).toBe(true);
    }
    const synced = await registry.run("sync", context(), {});
    expect(synced.ok).toBe(true);
    const paths = new Set(
      (synced.ok
        ? (synced.value as { entries: Array<{ path: string; group: string }> })
        : { entries: [] }
      ).entries.map((entry) => `${entry.group}:${entry.path}`),
    );
    // The same source reaches Claude Code, and the tools that read the shared skills.
    expect(paths.has("claude-code:.claude/skills/pricing-check/SKILL.md")).toBe(true);
    expect(paths.has("claude-code:.claude/skills/pricing-check/references/checklist.md")).toBe(
      true,
    );
    expect(paths.has("claude-code:.claude/agents/pilot.md")).toBe(true);
    const groups = (name: string) =>
      new Set([...paths].filter((path) => path.includes(`/${name}`)).map((p) => p.split(":")[0]));
    expect(groups("pilot")).toEqual(groups("tess"));
    expect(groups("pricing-check")).toEqual(groups("write-spec"));

    for (const id of ["pricing-check", "pilot"]) {
      const verified = await registry.run("workshop", context("agent"), {
        workshop: { op: "verify", id, triggers: ["price my offer"] },
      });
      expect(verified.ok && (verified.value as WorkshopResult), id).toMatchObject({
        ok: true,
        origin: "creator",
      });
    }
    // The method shipped is exactly what it was.
    expect(methodHash()).toBe(before);
  });

  it("refuses a name that a shipped agent or skill already has, and lists the rest", async () => {
    const registry = createCommandRegistry();
    await initCommand.run(context(), { profile: resolveProfile("new-product") });
    const taken = await registry.run("agent", context(), { ...SKILL, id: "write-spec" });
    expect(taken.ok ? "" : taken.error.code).toBe("AGENT_EXISTS");
    const other = await registry.run("agent", context(), { ...AGENT, id: "tess" });
    expect(other.ok ? "" : other.error.code).toBe("AGENT_EXISTS");
    const named = await registry.run("agent", context(), { ...AGENT, id: "pixel", name: "Tess" });
    expect(named.ok ? "" : String(named.error.details.problems)).toContain(
      "is the name of the agent tess",
    );
  });

  it("costs a few thousand tokens for a typical creation, and adds no tool", async () => {
    const registry = createCommandRegistry();
    await initCommand.run(context(), { profile: resolveProfile("new-product") });
    const checked = await registry.run("workshop", context("agent"), {
      workshop: { op: "check", action: request(SKILL) },
    });
    expect(checked.ok).toBe(true);
    // What a session reads to create a skill: the skill, the way to create, the rules of the
    // engine, and the engine's answer to the check (analyze.md is read for an analysis only).
    const read = (file: string) =>
      (definitions.find((d) => d.name === "workshop") as Definition) &&
      0 + readFileSync(join(methodDir, file), "utf8").length;
    const skill = (definitions.find((d) => d.name === "workshop") as Definition).text.length;
    const answer = JSON.stringify(checked.ok ? checked.value : {}).length;
    const tokens =
      (skill +
        read("skills/workshop/references/create.md") +
        read("skills/workshop/references/rules.md") +
        answer) /
      TOKEN;
    expect(tokens, `${Math.round(tokens)} tokens`).toBeLessThanOrEqual(2_100);
    expect(answer).toBeLessThanOrEqual(400);
    expect(registry.agentCommands()).toHaveLength(65);
  });
});
