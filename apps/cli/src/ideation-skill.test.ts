import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import {
  AGENT_DOMAINS,
  checkDocumentsDetailed,
  type Definition,
  IDEATION_DIR,
  readDefinitions,
} from "@agentplugged/core";
import type { SkillFrontmatter } from "@agentplugged/protocol";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The skill `ideation` — a library of techniques read by category, a session saved
 * from the first question and picked up where it stopped, a stance chosen once with every idea
 * marked, a convergence, and the gestures that carry the kept ideas out.
 */
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);
const KB = {
  path: ".agentplugged/docs/index.md",
  text: "---\nid: kb-index\nkind: note\nowner: zoe\nlinks: []\n---\n# Map\n",
};
const SESSION = `${IDEATION_DIR}ideation-onboarding.md`;
const CATEGORIES = [
  "borrowed",
  "deep",
  "frames",
  "futures",
  "limits",
  "people",
  "sparks",
  "together",
];

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

const skill = () => skills.get("ideation") as Definition;
const flat = (text: string) => text.replace(/\s+/g, " ");
const read = (path: string) => readFileSync(join(methodDir, path), "utf8").replace(/\r\n/g, "\n");
const annex = (path: string) => read(`skills/ideation/${path}`);
const library = (category: string) => annex(`references/techniques-${category}.md`);
const techniquesOf = (text: string) => text.split("\n").filter((line) => line.startsWith("- "));

/** The template filled as the skill asks: placeholders replaced, guidance comments removed. */
const filled = (replacements: Record<string, string> = {}) => {
  let text = annex("assets/session-template.md").replace("ideation-topic", "ideation-onboarding");
  for (const [from, to] of Object.entries(replacements)) text = text.replace(from, to);
  return text.replace(/<!--[\s\S]*?-->\n?/g, "").replace(/<[^<>\n]+>/g, "Something true about it");
};
const owners = new Set(Object.keys(AGENT_DOMAINS));
const problemsOf = (text: string) =>
  checkDocumentsDetailed({ current: [KB, { path: SESSION, text }], owners }).problems;

describe("the ideation skill", () => {
  it("ships one short skill, its references, its eight categories and its template", () => {
    expect([...skill().annexes].sort()).toEqual(
      [
        "assets/session-template.md",
        "references/choose.md",
        "references/close.md",
        "references/converge.md",
        "references/gestures.md",
        "references/stances.md",
        ...CATEGORIES.map((category) => `references/techniques-${category}.md`),
      ].sort(),
    );
    expect((skill().frontmatter as SkillFrontmatter).metadata).toMatchObject({
      agent: "lou",
      phase: "framing",
    });
    expect((skill().frontmatter as { description: string }).description.length).toBeLessThan(180);
    expect(skill().text.length).toBeLessThanOrEqual(3_600);
  });

  it("sends the detail to files read when needed, each short", () => {
    const body = skill().body;
    for (const file of ["stances", "choose", "converge", "close"]) {
      expect(body, file).toContain(`references/${file}.md`);
    }
    expect(body).toContain("references/techniques-<category>.md");
    for (const file of readdirSync(join(methodDir, "skills/ideation/references"))) {
      expect(annex(`references/${file}`).length, file).toBeLessThanOrEqual(1_800);
    }
  });

  it("holds the library: about fifty techniques in eight categories, one line each, read by category", () => {
    let total = 0;
    for (const category of CATEGORIES) {
      const lines = techniquesOf(library(category));
      expect(lines.length, category).toBeGreaterThanOrEqual(5);
      for (const line of lines) {
        // A name, its principle, and when to use it: one line each.
        expect(line, line).toMatch(/^- [^:]{3,40}: .{20,}[.?] Use .{8,}\.$/);
        expect(line.length, line).toBeLessThanOrEqual(260);
      }
      total += lines.length;
    }
    expect(total).toBeGreaterThanOrEqual(50);
    expect(total).toBeLessThanOrEqual(70);
    // Only the file of a category is read; no file carries the whole library.
    const text = flat(skill().body);
    expect(text).toContain("read only the file of the category you draw from");
    expect(text).toContain("never all of them");
    for (const category of CATEGORIES) {
      expect(flat(annex("references/choose.md")), category).toContain(`\`${category}\``);
    }
  });

  it("covers the techniques people expect, in our own words", () => {
    const all = CATEGORIES.map(library).join("\n").toLowerCase();
    for (const name of [
      "yes, and",
      "what if",
      "analogy",
      "forced pairing",
      "scamper",
      "six hats",
      "how might we",
      "job to be done",
      "empathy map",
      "mind map",
      "five whys",
      "question storm",
      "pre-mortem",
      "nothing to spend",
      "single purpose",
      "backcasting",
      "day in the life",
      "extreme users",
      "nature's answer",
      "hidden rules",
    ]) {
      expect(all, name).toContain(name);
    }
  });
});

describe("the choice of techniques, the stance and the session", () => {
  it("offers the four ways to choose: named, recommended with a reason, drawn, chained, and invented", () => {
    const choose = flat(annex("references/choose.md"));
    for (const part of [
      "They name it",
      "Recommended",
      "say in one line each why it fits",
      "Drawn",
      "A chain",
      "Invented",
      "`### <name> (new)`",
      "3 or 4 techniques",
      "more techniques, narrow down, or wrap up",
    ]) {
      expect(choose, part).toContain(part);
    }
  });

  it("holds the three stances, the attribution and the ratio", () => {
    const stances = flat(annex("references/stances.md"));
    for (const part of [
      "`Stance: questions`",
      "`Stance: exchange`",
      "`Stance: proposal`",
      "You bring no idea of your own",
      "offer a single seed",
      "`[creator]` or `[lou]`",
      "if you have given more than they have lately",
      "ten ideas, each marked `[lou]`",
      "write their idea word for word",
      "the engine allows one per technique",
      "add a line `Stance: <new one>`",
      "Say at the start how it works and that they steer",
    ]) {
      expect(stances, part).toContain(part);
    }
  });

  it("creates the file at the first question and saves at every batch, so a cut session resumes", () => {
    const text = flat(skill().body);
    for (const part of [
      "**Create the file now**",
      "`Next step:`",
      "**Save at every batch**",
      "A cut session loses nothing",
      "**Resume**",
      "read it whole, once",
      "past fifty ideas",
      "switch after five to ten exchanges",
      "one question per message, no list of choices while ideas flow",
    ]) {
      expect(text.toLowerCase(), part).toContain(part.toLowerCase());
    }
    expect(read("agents/lou/agent.yaml")).toContain("those with a `Next step:` line first");
  });

  it("starts from the documents of the product and invites the table", () => {
    const text = flat(skill().body);
    for (const part of [
      "**Read what exists**",
      "brief, PRD, research",
      "docs research",
      "hypotheses of `state.get`",
      "Offer the table (Noah opens it)",
    ]) {
      expect(text, part).toContain(part);
    }
    expect(existsSync(join(methodDir, "skills/round-table/SKILL.md"))).toBe(true);
  });

  it("accepts the template filled as the skill asks, at every stage", () => {
    const started = filled({ "Stance: <questions | exchange | proposal>": "Stance: questions" })
      .replace(/## Ideas[\s\S]*$/, "")
      .trim();
    expect(problemsOf(`${started}\n`)).toEqual([]);
    const idea = "Let the product work before any account exists";
    const finished = filled({
      "Stance: <questions | exchange | proposal>": "Stance: exchange",
      "- [creator] <idea, as said>": `- [creator] ${idea}\n- [lou] An idea of mine`,
      "<the creator's own ideas as written, odd ones included; then lines starting `Link:` for what they missed>": `${idea}\n\nLink: one idea.`,
      "Move: <move>": "Move: group by theme",
      "- <idea> → <hypothesis | story | decision | nothing | later>": `- ${idea} → hypothesis`,
    }).replace(/^Next step:.*\n/m, "");
    expect(problemsOf(finished)).toEqual([]);
    // The same file with the creator's idea smoothed in the mirror is refused.
    expect(
      problemsOf(finished.replace(`\n${idea}\n\nLink`, "\nAn account-free product.\n\nLink"))
        .length,
    ).toBe(1);
  });
});

describe("the convergence and the gestures", () => {
  it("has the six moves, one chosen for the goal, two at most, the decision the creator's", () => {
    const converge = flat(annex("references/converge.md")).toLowerCase();
    for (const part of [
      "group by theme",
      "impact and effort",
      "new, useful, feasible",
      "forced ranking",
      "plus, minus, interesting",
      "must, should, could, not now",
      "pick one tool for this goal and name it",
      "a third is refused",
      "the creator says which ideas stay",
      "never during a technique that still yields",
    ]) {
      expect(converge, part).toContain(part);
    }
  });

  it("closes with the mirror first, then the links, then the gestures the creator chooses", () => {
    const close = flat(annex("references/close.md"));
    const order = [
      "Their ideas back to them",
      "the bridges they did not see",
      "What stays",
      "Wrap up",
    ].map((part) => close.indexOf(part));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(close).toContain("three at least");
    expect(close).toContain("the strange, the stray and the forgotten ones");
    const gestures = flat(annex("references/gestures.md"));
    for (const part of [
      "**hypothesis**",
      "**story**",
      "**decision**",
      "**nothing**",
      "**later**",
      "`checkpoint.open`",
      "Never choose for them",
      "Write neither",
    ]) {
      expect(gestures, part).toContain(part);
    }
    // The hypothesis gesture uses the file of the skill `strategy`, which exists, and adds no tool.
    expect(gestures).toContain(".agentplugged/skills/strategy/references/gestures.md");
    expect(existsSync(join(methodDir, "skills/strategy/references/gestures.md"))).toBe(true);
    expect(read("skills/strategy/references/gestures.md")).toContain("review.critique");
  });

  it("is Lou's, in his menu, offered by Noah, and adds no tool", () => {
    const lou = agents.get("lou");
    const menu = lou?.agent?.menu ?? [];
    const id = menu.find((entry) => entry.code === "ID");
    expect(id?.skill).toBe("ideation");
    expect(id?.prompt).toBeUndefined();
    for (const code of ["TQ", "CN", "CV", "NT"]) {
      expect(menu.find((entry) => entry.code === code)?.prompt, code).toContain("`ideation`");
    }
    const team = flat(read("agents/noah/references/team.md"));
    for (const word of ["`ideation`", "`ID`", "`NT`", "`Next step:`"]) {
      expect(team, word).toContain(word);
    }
  });

  it("never rewrites the creator's text, and leaves the deciding to them", () => {
    const text = flat(skill().body);
    expect(text).toContain("Never rewrite or sharpen their idea: write it as said.");
    expect(text).toContain("never converge, choose or close for them");
    expect(text).toContain("hand back to Noah");
    expect(text).toContain('Follow "Rules for skills and agents"');
  });
});
