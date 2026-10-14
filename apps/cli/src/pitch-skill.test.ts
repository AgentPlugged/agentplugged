import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import {
  AGENT_DOMAINS,
  checkDocumentsDetailed,
  DECK_PATH,
  DESIGN_DIR,
  type Definition,
  NARRATIVE_PATH,
  readDefinitions,
  renderDeckPage,
} from "@agentplugged/core";
import type { SkillFrontmatter } from "@agentplugged/protocol";
import { beforeAll, describe, expect, it } from "vitest";

/** The skill `pitch` — design thinking (Stella), the story and the deck (Julien). */
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);
const KB = {
  path: ".agentplugged/docs/index.md",
  text: "---\nid: kb-index\nkind: note\nowner: zoe\nlinks: []\n---\n# Map\n",
};
const DESIGN = `${DESIGN_DIR}onboarding.md`;

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

const skill = () => skills.get("pitch") as Definition;
const flat = (text: string) => text.replace(/\s+/g, " ");
const read = (path: string) => readFileSync(join(methodDir, path), "utf8").replace(/\r\n/g, "\n");
const annex = (path: string) => read(`skills/pitch/${path}`);

/** A template filled as the skill asks: placeholders replaced, guidance comments removed. */
const filled = (path: string, replacements: Record<string, string> = {}) => {
  let text = annex(path);
  for (const [from, to] of Object.entries(replacements)) text = text.replace(from, to);
  return text.replace(/<!--[\s\S]*?-->\n?/g, "").replace(/<[^<>\n]+>/g, "Something true about it");
};

const owners = new Set(Object.keys(AGENT_DOMAINS));
const check = (files: Array<{ path: string; text: string }>) =>
  checkDocumentsDetailed({ current: [KB, ...files], owners });

describe("the pitch skill", () => {
  it("ships one skill with three modes, its references and its templates", () => {
    expect([...skill().annexes].sort()).toEqual([
      "assets/deck-template.md",
      "assets/design-template.md",
      "assets/narrative-template.md",
      "references/deck-types.md",
      "references/deck.md",
      "references/design-implementation.md",
      "references/design-methods.md",
      "references/design-thinking.md",
      "references/story-frameworks.md",
      "references/story.md",
    ]);
    expect((skill().frontmatter as SkillFrontmatter).metadata).toMatchObject({ agent: "julien" });
  });

  it("is carried by Julien (story, deck) and Stella (design thinking), in their menus", () => {
    for (const [agent, code] of [
      ["julien", "ST"],
      ["julien", "DK"],
      ["stella", "DT"],
    ] as const) {
      const item = agents.get(agent)?.agent?.menu.find((entry) => entry.code === code);
      expect(item?.skill, `${agent} ${code}`).toBe("pitch");
      expect(item?.prompt, `${agent} ${code}`).toBeUndefined();
    }
  });

  it("is offered by Noah when the creator talks of convincing, pitching or presenting", () => {
    const team = flat(read("agents/noah/references/team.md"));
    for (const word of ["convincing, pitching or presenting", "`pitch`", "`ST`", "`DK`", "`DT`"]) {
      expect(team, word).toContain(word);
    }
  });

  it("starts from the documents of the product and marks a figure without source", () => {
    const text = flat(skill().body);
    for (const part of [
      "**Read what exists**",
      "`prfaq.md`",
      "`launch/positioning.md`",
      "`research/`",
      "ask only for what is missing",
      "`EF-n`",
      "`[to verify]`",
      "`npx agentplugged docs check`",
      "`type: publication`",
      "Never rewrite their text without their gesture",
      "hand back to Noah",
    ]) {
      expect(text, part).toContain(part);
    }
  });

  it("covers the exercises, the structures and the kinds of talk", () => {
    const methods = annex("references/design-methods.md");
    for (const part of [
      "Interviews",
      "Empathy map",
      "Journey map",
      "Jobs to be done",
      "How might we",
      "Eight sketches",
      "Role play",
      "Storyboard",
      "Task test",
      "Service blueprint",
    ]) {
      expect(methods, part).toContain(part);
    }
    const frameworks = annex("references/story-frameworks.md");
    expect(frameworks.match(/^- /gm)?.length).toBeGreaterThanOrEqual(24);
    for (const part of ["Pitch", "Fundraising", "Data", "Origin", "Hook"]) {
      expect(frameworks, part).toContain(part);
    }
    const types = annex("references/deck-types.md");
    for (const part of ["Investor deck", "Conference talk", "Video explainer", "Single visual"]) {
      expect(types, part).toContain(part);
    }
  });

  it("lets the positioning and the sales build on the validated story", () => {
    expect(flat(skills.get("write-positioning")?.body ?? "")).toContain("`launch/narrative.md`");
    expect(flat(skills.get("write-sales")?.body ?? "")).toContain("`launch/narrative.md`");
  });

  it("ships templates that docs check accepts once filled, and refuses while a marker is left", () => {
    const narrative = filled("assets/narrative-template.md", {
      "<verified, stated or untrusted>": "stated",
    });
    const deck = filled("assets/deck-template.md").replace("[narrative]", "[narrative]");
    const design = filled("assets/design-template.md");
    const documents = [
      { path: NARRATIVE_PATH, text: narrative },
      { path: DECK_PATH, text: deck },
      { path: DESIGN, text: design.replace("id: design-topic", "id: design-onboarding") },
    ];
    const prd = {
      path: ".agentplugged/docs/prd.md",
      text: "---\nid: prd\nkind: prd\nowner: maya\nlinks: [brief]\n---\n# PRD\n",
    };
    const brief = {
      path: ".agentplugged/docs/brief.md",
      text: "---\nid: brief\nkind: brief\nowner: iris\nlinks: []\n---\n# Brief\n",
    };
    expect(check([brief, prd, ...documents]).problems).toEqual([]);
    // As shipped, the placeholders are left: nothing is published with them.
    const raw = check([
      brief,
      prd,
      { path: NARRATIVE_PATH, text: annex("assets/narrative-template.md") },
    ]);
    expect(raw.problems.some((problem) => problem.code === "DOC_PLACEHOLDER_LEFT")).toBe(true);
  });
});

describe("the pitch skill, whole courses", () => {
  it("offers the same menu after each step and saves where the creator stopped", () => {
    const text = flat(skill().body);
    for (const part of [
      "continue, go deeper, challenge",
      "go back, or stop here",
      "<!-- resume: next step -->",
      "offer to pick up there",
    ]) {
      expect(text, part).toContain(part);
    }
  });

  it("ends design thinking with a plan to test, feedback to collect and a way into the product", () => {
    expect(flat(skill().body)).toContain("references/design-implementation.md");
    expect(annex("references/design-thinking.md")).toContain("7. **Implementation.**");
    const step = flat(annex("references/design-implementation.md"));
    for (const part of [
      "Test plan",
      "success criterion",
      "Feedback to collect",
      "hypothesis",
      "`review.critique`",
      "`kind: idea`",
      "`plan.defer`",
      "story",
      "Pilot",
      "one gesture per line",
    ]) {
      expect(step, part).toContain(part);
    }
    expect(annex("assets/design-template.md")).toContain("## Implementation");
  });

  it("draws the deck of the template once filled, and a resume note changes nothing", () => {
    const deck = filled("assets/deck-template.md");
    const page = renderDeckPage(deck);
    expect(page.slides).toBe(3);
    expect(page.notes).toBe(3);
    // A note to resume under the title is no marker left, no section, no slide, nothing on the page.
    const resumed = deck.replace("# Deck:", "<!-- resume: Slide 3 -->\n# Deck:");
    const narrative = filled("assets/narrative-template.md", {
      "<verified, stated or untrusted>": "stated",
    });
    const noted = [
      {
        path: ".agentplugged/docs/prd.md",
        text: "---\nid: prd\nkind: prd\nowner: maya\nlinks: [brief]\n---\n# PRD\n",
      },
      {
        path: ".agentplugged/docs/brief.md",
        text: "---\nid: brief\nkind: brief\nowner: iris\nlinks: []\n---\n# Brief\n",
      },
      { path: DECK_PATH, text: resumed },
      { path: NARRATIVE_PATH, text: narrative.replace("\n# ", "\n<!-- resume: Proof -->\n# ") },
    ];
    expect(check(noted).problems).toEqual([]);
    expect(renderDeckPage(resumed).html).toBe(page.html);
    expect(page.html).not.toContain("resume");
    expect(skill().body).toContain("docs slides");
    expect(annex("references/deck.md")).toContain("docs slides");
  });
});
