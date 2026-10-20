import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import {
  AGENT_DOMAINS,
  checkDocumentsDetailed,
  createCommandRegistry,
  type Definition,
  readDefinitions,
  STRATEGY_DIR,
  TOOL_GROUPS,
} from "@agentplugged/core";
import type { SkillFrontmatter } from "@agentplugged/protocol";
import { beforeAll, describe, expect, it } from "vitest";

/** The skill `strategy` — solving a problem (Lou) and an innovation strategy (Iris). */
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);
const KB = {
  path: ".agentplugged/docs/index.md",
  text: "---\nid: kb-index\nkind: note\nowner: zoe\nlinks: []\n---\n# Map\n",
};
const PROBLEM = `${STRATEGY_DIR}problem-signup.md`;
const INNOVATION = `${STRATEGY_DIR}innovation-pricing.md`;

let skills: Map<string, Definition>;
let agents: Map<string, Definition>;

beforeAll(async () => {
  const source = new NodeWorkspaceFiles(methodDir);
  const shippedSkills = await readDefinitions(source, "skills", "skill");
  const shippedAgents = await readDefinitions(source, "agents", "agent");
  if (!Array.isArray(shippedSkills) || !Array.isArray(shippedAgents)) {
    throw new Error("invalid shipped method");
  }
  skills = new Map(shippedSkills.map((definition) => [definition.name, definition]));
  agents = new Map(shippedAgents.map((definition) => [definition.name, definition]));
});

const skill = () => skills.get("strategy") as Definition;
const flat = (text: string) => text.replace(/\s+/g, " ");
const read = (path: string) => readFileSync(join(methodDir, path), "utf8").replace(/\r\n/g, "\n");
const annex = (path: string) => read(`skills/strategy/${path}`);

/** A template filled as the skill asks: placeholders replaced, guidance comments removed. */
const filled = (path: string, replacements: Record<string, string> = {}) => {
  let text = annex(path);
  for (const [from, to] of Object.entries(replacements)) text = text.replace(from, to);
  return text
    .replace(/<!--[\s\S]*?-->\n?/g, "")
    .replace(/^Next step:.*\n\n/m, "")
    .replace(/<[^<>\n]+>/g, "Something true about it");
};

const owners = new Set(Object.keys(AGENT_DOMAINS));
const check = (files: Array<{ path: string; text: string }>) =>
  checkDocumentsDetailed({ current: [KB, ...files], owners });

describe("the strategy skill", () => {
  it("ships one skill with two modes, its references and its templates", () => {
    expect([...skill().annexes].sort()).toEqual([
      "assets/innovation-template.md",
      "assets/problem-template.md",
      "references/costs.md",
      "references/gestures.md",
      "references/innovate-frameworks.md",
      "references/innovate.md",
      "references/solve-methods.md",
      "references/solve.md",
    ]);
    expect((skill().frontmatter as SkillFrontmatter).metadata).toMatchObject({ agent: "lou" });
  });

  it("is carried by Lou (solve) and Iris (innovate), in their menus, and offered by Noah", () => {
    for (const [agent, code] of [
      ["lou", "PS"],
      ["iris", "IS"],
    ] as const) {
      const item = agents.get(agent)?.agent?.menu.find((entry) => entry.code === code);
      expect(item?.skill, `${agent} ${code}`).toBe("strategy");
      expect(item?.prompt, `${agent} ${code}`).toBeUndefined();
    }
    const team = flat(read("agents/noah/references/team.md"));
    for (const word of [
      "a hard problem",
      "business model",
      "`strategy`",
      "`PS`",
      "`IS`",
      "`docs costs`",
    ]) {
      expect(team, word).toContain(word);
    }
  });

  it("starts from the documents and the research, guides by step with a menu and a save", () => {
    const text = flat(skill().body);
    for (const part of [
      "**Read what exists**",
      "docs research <subject>",
      "ask only for what is missing",
      "`Next step:`",
      "continue, go deeper, go back, challenge",
      "ask the table",
      "finish fast",
      "stop here",
      "`[to verify]`",
      "`npx agentplugged docs check`",
      "`document` checkpoint",
      "Never rewrite their text without their gesture",
      "hand back to Noah",
    ]) {
      expect(text, part).toContain(part);
    }
  });

  it("covers every method of the problem course and every framework of the strategy course", () => {
    const methods = flat(annex("references/solve-methods.md")).toLowerCase();
    for (const part of [
      "five whys",
      "cause map",
      "is / is not",
      "systems view",
      "force field",
      "80/20",
      "gap analysis",
      "bottleneck",
      "failure modes",
      "triz",
      "lateral thinking",
      "morphological",
      "nature analogy",
      "synectics",
      "assumption busting",
      "random word",
      "reverse brainstorm",
      "six hats",
      "seven lenses",
      "weighted matrix",
      "cost and benefit",
      "risk grid",
      "trial protocol",
      "feasibility",
      "plan, do, check, adjust",
      "sequence and dependencies",
      "people map",
      "change handling",
      "indicator board",
      "statement sharpening",
    ]) {
      expect(methods, part).toContain(part);
    }
    expect(annex("references/solve-methods.md").match(/^- /gm)?.length).toBeGreaterThanOrEqual(30);
    const frameworks = flat(annex("references/innovate-frameworks.md")).toLowerCase();
    for (const part of [
      "market size in three rings",
      "five forces",
      "outside forces",
      "timing",
      "positioning map",
      "business model canvas",
      "value fit",
      "model patterns",
      "revenue ideas",
      "cost redesign",
      "disruption from below",
      "jobs to be done",
      "blue ocean",
      "crossing the gap",
      "platform",
      "three horizons",
      "build, measure, learn",
      "ambition grid",
      "strategic intent",
      "scenarios",
      "value chain",
      "unbundling",
      "ecosystem design",
      "make or buy",
      "partnerships",
      "adoption curve",
      "s-curve",
      "technology roadmap",
      "open innovation",
      "digital shift",
    ]) {
      expect(frameworks, part).toContain(part);
    }
    expect(
      annex("references/innovate-frameworks.md").match(/^- /gm)?.length,
    ).toBeGreaterThanOrEqual(30);
    // The courses: nine steps each, with the depth of the diagnosis, the options and the roadmap.
    const solve = flat(annex("references/solve.md"));
    for (const part of [
      "9. **Lessons**",
      "at least ten options",
      "plan B",
      "confidence",
      "No dates",
    ]) {
      expect(solve, part).toContain(part);
    }
    const innovate = flat(annex("references/innovate.md"));
    for (const part of [
      "9. **Risks.**",
      "three different strategic options",
      "Three phases, no dates",
      "decision gate",
      "break-even",
    ]) {
      expect(innovate, part).toContain(part);
    }
  });

  it("builds the economics on estimated and declared costs, and never on a real one", () => {
    const costs = flat(annex("references/costs.md"));
    for (const part of [
      "npx agentplugged docs costs",
      "`estimated`",
      "`declared`",
      "never guessed and never left at zero",
      "Break-even: <n> customers",
      "nothing else",
    ]) {
      expect(costs, part).toContain(part);
    }
    // No text of the skill speaks of a real, actual or measured cost.
    const everything = ["SKILL.md", ...skill().annexes]
      .map((path) => (path === "SKILL.md" ? skill().body : annex(path)))
      .join("\n");
    expect(everything).not.toMatch(/\b(?:real|actual|measured) costs?\b/i);
  });

  it("turns the conclusions into gestures: hypotheses, stories proposed, a decision point", () => {
    const gestures = flat(annex("references/gestures.md"));
    for (const part of [
      "`review.critique` with `kind: idea`",
      "critique-deliverable",
      "Story proposed",
      "Maya",
      "Izzy",
      "`checkpoint.open` with `type: decision`",
      "Write no story and no requirement yourself",
    ]) {
      expect(gestures, part).toContain(part);
    }
  });

  it("ships templates that docs check accepts once filled, and refuses while a marker is left", () => {
    const problem = filled("assets/problem-template.md").replace(
      "id: problem-topic",
      "id: problem-signup",
    );
    const innovation = filled("assets/innovation-template.md", {
      "| <build with the agents> | estimated | <amount, currency> | one-off | <`docs costs`, how many stories, its basis> |":
        "| Build with the agents | estimated | 240 USD | one-off | `docs costs`, 40 stories, the reference |",
      "| <hosting> | declared | <amount, currency> | monthly | <the creator, or the page and day> |":
        "| Hosting | declared | 12 USD | monthly | the creator |",
      "Price: <the creator's price and model> [source: <the creator>].":
        "Price: 19 USD a month [source: the creator].",
      "Break-even: <n> customers [source: docs costs].":
        "Break-even: 7 customers [source: docs costs].",
    }).replace("id: innovation-topic", "id: innovation-pricing");
    const documents = [
      { path: PROBLEM, text: problem },
      { path: INNOVATION, text: innovation },
    ];
    const prd = {
      path: ".agentplugged/docs/prd.md",
      text: "---\nid: prd\nkind: prd\nowner: maya\nlinks: [brief]\n---\n# PRD\n",
    };
    const brief = {
      path: ".agentplugged/docs/brief.md",
      text: "---\nid: brief\nkind: brief\nowner: iris\nlinks: []\n---\n# Brief\n",
    };
    const done = check([brief, prd, ...documents]);
    expect(done.problems).toEqual([]);
    // As shipped, the placeholders are left: nothing is validated with them.
    for (const [path, template] of [
      [PROBLEM, "assets/problem-template.md"],
      [INNOVATION, "assets/innovation-template.md"],
    ] as const) {
      const raw = check([brief, prd, { path, text: annex(template) }]);
      expect(
        raw.problems.some((problem) => problem.code === "DOC_PLACEHOLDER_LEFT"),
        template,
      ).toBe(true);
    }
  });
});

/**
 * Solving and the strategy are one skill with two modes (one name and one
 * description paid at every request), the method of each mode lives in files read only when that
 * mode runs, no tool is added, and a typical path reads far less than the method of reference does
 * before its first question (22 941 and 25 399 characters: its two workflows with their method
 * tables and templates).
 */
describe("solving and strategy stay light", () => {
  const TOKEN = 4;
  const REFERENCE = { solve: 22_941, innovate: 25_399 };
  const length = (path: string) => annex(path).length;
  const body = () => skill().body.length;
  const modes = {
    solve: ["references/solve.md", "references/solve-methods.md", "assets/problem-template.md"],
    innovate: [
      "references/innovate.md",
      "references/innovate-frameworks.md",
      "references/costs.md",
      "assets/innovation-template.md",
    ],
  } as const;

  it("keeps a short skill and short references, each sent to by the skill", () => {
    expect(body()).toBeLessThanOrEqual(3_200);
    for (const path of skill().annexes) {
      expect(length(path), path).toBeLessThanOrEqual(3_500);
      expect(skill().body, path).toContain(path);
    }
    const description = (skill().frontmatter as { description: string }).description;
    expect(description.length).toBeLessThanOrEqual(150);
  });

  it("costs a few thousand tokens for a typical path, much less than reading the reference method", () => {
    for (const [mode, used] of Object.entries(modes)) {
      const read = body() + used.reduce((sum, path) => sum + length(path), 0);
      // What the agent writes: the file (≈ 3 500 characters) and eight short exchanges, the gestures once.
      const path = (read + length("references/gestures.md") + 3_500 + 8 * 300) / TOKEN;
      expect(path, `${mode}: ${Math.round(path)} tokens`).toBeLessThanOrEqual(
        mode === "solve" ? 4_700 : 5_600,
      );
      expect(read, mode).toBeLessThan(REFERENCE[mode as keyof typeof REFERENCE] / 1.5);
    }
  });

  it("adds no tool and no action", () => {
    expect(createCommandRegistry().agentCommands()).toHaveLength(65);
    expect(Object.keys(TOOL_GROUPS)).toHaveLength(10);
  });
});
