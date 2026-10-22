import { readdirSync, readFileSync } from "node:fs";
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
import {
  CONCEPT_TYPES,
  FORGE_LOG_TYPES,
  FORGE_MAX_LINES,
  FORGE_OUTCOMES,
  PRFAQ_CUSTOMER_ANGLES,
  PRFAQ_INTERNAL_ANGLES,
  PRFAQ_QUESTIONS_MAX,
  PRFAQ_QUESTIONS_MIN,
  type SkillFrontmatter,
} from "@agentplugged/protocol";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The forge of an idea and the press release, as the skill `test-idea` teaches them,
 * checked against the shapes the engine reads (`docs check`).
 */
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);
const KB = {
  path: ".agentplugged/docs/index.md",
  text: "---\nid: kb-index\nkind: note\nowner: zoe\nlinks: []\n---\n# Map\n",
};
const FORGE = `${IDEATION_DIR}forge-topic.md`;
const PRFAQ = ".agentplugged/docs/prfaq.md";
const owners = new Set(Object.keys(AGENT_DOMAINS));

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

const skill = () => skills.get("test-idea") as Definition;
const read = (path: string) => readFileSync(join(methodDir, path), "utf8").replace(/\r\n/g, "\n");
const annex = (path: string) => read(`skills/test-idea/${path}`);
const flat = (text: string) => text.replace(/\s+/g, " ");
const problemsOf = (path: string, text: string) =>
  checkDocumentsDetailed({ current: [KB, { path, text }], owners }).problems;

/** The template filled as the skill asks: comments removed, placeholders replaced. */
const filled = (template: string, replacements: Record<string, string> = {}) => {
  let text = annex(template);
  for (const [from, to] of Object.entries(replacements)) text = text.replace(from, to);
  return text.replace(/<!--[\s\S]*?-->\n?/g, "").replace(/<[^<>\n]+>/g, "Something true about it");
};

describe("the skill test-idea carries the forge", () => {
  it("is one skill of Iris with its files, one more for each part, and no tool added", () => {
    expect([...skill().annexes].sort()).toEqual(
      [
        "assets/forge-template.md",
        "assets/prfaq-template.md",
        "references/faq.md",
        "references/forge.md",
        "references/personas.md",
        "references/prfaq.md",
      ].sort(),
    );
    expect((skill().frontmatter as SkillFrontmatter).metadata).toMatchObject({ agent: "iris" });
    const menu = agents.get("iris")?.agent?.menu ?? [];
    expect(menu.find((item) => item.code === "TI")?.description).toMatch(/forge/i);
    // Each exercise reads its files only: the forge never loads the press release's.
    expect(annex("references/forge.md")).not.toMatch(/faq\.md|verdict|prfaq\.md/);
  });

  it("steers like a questioning conversation: modes, log types, the three outcomes, the limit", () => {
    const forge = flat(annex("references/forge.md"));
    for (const mode of ["attack", "defend", "switch roles"])
      expect(forge, mode).toContain(`*${mode}*`);
    for (const type of FORGE_LOG_TYPES) expect(forge, type).toContain(`\`[${type}]\``);
    for (const outcome of FORGE_OUTCOMES) expect(forge, outcome).toContain(`*${outcome}*`);
    expect(forge).toContain(`at most ${FORGE_MAX_LINES} lines`);
    // It reads the documents of a change to an existing project, offers to resume, and names the file.
    for (const part of ["`scope: change`", "no `Outcome:` line", "personas.md"]) {
      expect(forge, part).toContain(part);
    }
  });

  it("names the four kinds of concept, and sends a reader-less idea back to the forge", () => {
    const concept = flat(annex("references/forge.md"));
    for (const type of CONCEPT_TYPES) expect(concept, type).toContain(`\`${type}\``);
    expect(concept).toContain("back to the forge");
  });

  it("asks for six to ten questions on fixed angles, in both languages", () => {
    const faq = annex("references/faq.md");
    expect(faq).toContain(`**${PRFAQ_QUESTIONS_MIN} to ${PRFAQ_QUESTIONS_MAX} questions**`);
    for (const angle of new Set([...PRFAQ_CUSTOMER_ANGLES, ...PRFAQ_INTERNAL_ANGLES])) {
      expect(faq, angle).toContain(`\`[${angle}]\``);
    }
    // The French words the file names are the ones the engine reads.
    for (const word of ["changer", "sûreté", "redouté", "construire", "durer", "moyens"]) {
      expect(faq, word).toContain(`[${word}]`);
    }
    for (const word of ["pourquoi-nous", "évité"]) expect(faq, word).toContain(`[${word}]`);
    expect(faq).toContain("forge.md");
  });

  it("holds the release to bars and sends the unsourced claim to research", () => {
    const prfaq = flat(annex("references/prfaq.md"));
    for (const part of [
      "`[imagined]`",
      "stays `[assumption]`",
      "`deep-research`",
      "faq.md",
      "## Verdict",
    ]) {
      expect(prfaq, part).toContain(part);
    }
  });

  it("gives a verdict in three categories, as the engine reads them", () => {
    const verdict = annex("references/prfaq.md");
    for (const label of ["Holds:", "Soft:", "Breaks:", "`Tient`", "`Fragile`", "`Casse`"]) {
      expect(verdict, label).toContain(label);
    }
  });

  it("starts the brief from a hardened forge and names no other method", () => {
    expect(flat(skills.get("write-brief")?.body ?? "")).toContain(
      "A hardened forge there (`forge-*.md`) is the starting point",
    );
    const folders = ["skills/test-idea", "skills/write-brief"];
    const texts = folders.flatMap((folder) =>
      (["", "/references", "/assets"] as const).flatMap((sub) => {
        try {
          return readdirSync(join(methodDir, folder + sub), { withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => read(`${folder}${sub}/${entry.name}`));
        } catch {
          return [];
        }
      }),
    );
    // The labels of the reference's verdict are not ours (the scan of the product for the reference's
    // names is in `method.test.ts`).
    const labels = [
      ["forged", "in", "steel"],
      ["needs", "more", "heat"],
      ["cracks", "in", "the", "foundation"],
    ];
    for (const text of texts) {
      for (const words of labels) expect(text.toLowerCase()).not.toContain(words.join(" "));
    }
  });
});

describe("the files the skill asks for pass the engine", () => {
  const concept = { "concept: <type>": "concept: internal" };

  it("accepts the forge template as filled, and each outcome it closes on", () => {
    const started = filled("assets/forge-template.md", concept);
    expect(problemsOf(FORGE, started)).toEqual([]);
    // The outcome stands under the title; the log goes.
    const close = (outcome: string, sections: string) =>
      started
        .replace(/## Log[\s\S]*$/, "")
        .replace("# Forge: Something true about it", `$&\n\nOutcome: ${outcome}`)
        .concat(`${sections}\n`);
    const hardened = close(
      "hardened",
      "## Decisions\n\n- Opt-out.\n\n## Rejected\n\n- A video tour: nobody watches it.",
    );
    expect(problemsOf(FORGE, hardened)).toEqual([]);
    expect(problemsOf(FORGE, close("killed", "## Cause\n\nNobody asked for it."))).toEqual([]);
    expect(problemsOf(FORGE, close("clearer", "## Clearer\n\nThe user is the buyer."))).toEqual([]);
    // The log stays while it goes on, and goes at the close.
    expect(problemsOf(FORGE, `${hardened}\n## Log\n\n- [chose] opt-out\n`)).toHaveLength(1);
  });

  it("accepts the press release template, then a closed release built on its own rules", () => {
    expect(problemsOf(PRFAQ, filled("assets/prfaq-template.md"))).toEqual([]);
    const questions = (angles: readonly string[]) =>
      [...angles, angles[0] as string].map((angle) => `- [${angle}] A question — An answer.`);
    const verdict = annex("references/prfaq.md").match(/```\n([\s\S]*?)```/)?.[1] ?? "";
    expect(verdict).toContain("Holds:");
    const closed = filled("assets/prfaq-template.md", {
      "links: []": "links: []\nconcept: internal",
    })
      .replace(/## Customer FAQ[\s\S]*$/, "")
      .concat(
        `## Customer FAQ\n\n${questions(PRFAQ_CUSTOMER_ANGLES).join("\n")}\n\n`,
        `## Internal FAQ\n\n${questions(PRFAQ_INTERNAL_ANGLES).join("\n")}\n\n`,
        `## Verdict\n\n${verdict}`,
      );
    expect(problemsOf(PRFAQ, closed)).toEqual([]);
    // Without a concept type, or with an angle missing, the closed release is refused.
    expect(problemsOf(PRFAQ, closed.replace("concept: internal\n", ""))).toHaveLength(1);
    const thin = closed.replace("- [dreaded] A question — An answer.\n", "");
    expect(problemsOf(PRFAQ, thin).length).toBeGreaterThan(0);
  });
});
