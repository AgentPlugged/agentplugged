import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import {
  checkDocuments,
  type Definition,
  KNOWLEDGE_BASE_INDEX_PATH,
  KNOWLEDGE_BASE_WRITER,
  NEXT_STEPS,
  readDefinitions,
  renderAgentBody,
  renderConstitution,
  renderConstitutionReference,
  resolveAgent,
} from "@agentplugged/core";
import { createTranslator } from "@agentplugged/i18n";
import { beforeAll, describe, expect, it } from "vitest";

/** The knowledge base stays true, and every agent takes its context from it. */
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);
const SKILL = "generate-knowledge-base";

let agents: Definition[];
let skill: Definition;

beforeAll(async () => {
  const source = new NodeWorkspaceFiles(methodDir);
  const shippedAgents = await readDefinitions(source, "agents", "agent");
  const shippedSkills = await readDefinitions(source, "skills", "skill");
  if (!Array.isArray(shippedAgents) || !Array.isArray(shippedSkills)) {
    throw new Error("invalid shipped method");
  }
  agents = shippedAgents;
  const found = shippedSkills.find((definition) => definition.name === SKILL);
  if (found === undefined) throw new Error(`${SKILL} is not shipped`);
  skill = found;
});

const flat = (text: string) => text.replace(/\s+/g, " ");

/** A section of a Markdown text, from its level 2 heading to the next one. */
function section(text: string, title: string): string {
  const start = text.indexOf(`\n## ${title}\n`);
  if (start === -1) return "";
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start, end === -1 ? undefined : end);
}

describe("the knowledge base as the source of context", () => {
  it("tells every agent, in the constitution, to read the base first, in whole documents", () => {
    const base = flat(section(renderConstitutionReference(), "Knowledge base"));
    for (const part of [
      `\`${KNOWLEDGE_BASE_INDEX_PATH}\``,
      "in full",
      "Split one only when it does not fit in your context",
      "not to learn the product",
      "`npx agentplugged docs check`",
      "only Zoé updates the base",
    ]) {
      expect(base, part).toContain(part);
    }
  });

  it("gives each of the nineteen agents and Noah the same rule, read at every request (AGENTS.md)", () => {
    expect(agents).toHaveLength(20);
    // The rule is the constitution's, not repeated in every agent's facts.
    const essentials = flat(renderConstitution());
    expect(essentials).toContain(`\`${KNOWLEDGE_BASE_INDEX_PATH}\``);
    expect(essentials).toContain("whole");
    expect(essentials).toContain("before the repository");
    for (const definition of agents) {
      const resolved = resolveAgent(definition);
      if (definition.name === KNOWLEDGE_BASE_WRITER) {
        const rendered = flat(section(renderAgentBody(resolved), "Persistent facts"));
        expect(rendered).toContain("`knowledge_base_update`");
      }
    }
  });
});

describe("the update of the knowledge base", () => {
  it("gives Zoé an update mode, reached from next, limited to the pages behind", () => {
    const body = skill.body;
    const update = flat(section(body, "Update mode"));
    for (const part of [
      "`npx agentplugged docs check`",
      "`kb_stale`",
      "`kb_source_unrecorded`",
      "never rewrite a page no warning names",
      "`git cat-file -p <blob>`",
      "`sources`",
      "`Last updated`",
      "`document` checkpoint",
    ]) {
      expect(update, part).toContain(part);
    }
    expect(flat(body)).toContain("`knowledge_base_update`");
    expect(flat(body)).toContain("**update**");
    expect(NEXT_STEPS).toContain("knowledge_base_update");
  });

  it("ships templates with an empty sources field that docs check accepts", () => {
    for (const template of [
      "assets/index-template.md",
      "assets/page-template.md",
      "assets/guide-template.md",
    ]) {
      const text = readFileSync(join(methodDir, "skills", SKILL, template), "utf8");
      expect(text.replace(/\r\n/g, "\n").split("\n"), template).toContain("sources: []");
    }
    // The release notes are a dated history: no `sources` field at all.
    const notes = readFileSync(
      join(methodDir, "skills", SKILL, "assets/release-notes-template.md"),
      "utf8",
    );
    expect(notes).not.toMatch(/^sources:/m);
    expect(flat(notes)).toContain("never carry `sources`");
    expect(flat(skill.body)).toContain("`kb_stale`");
    const page = readFileSync(join(methodDir, "skills", SKILL, "assets/page-template.md"), "utf8");
    expect(
      checkDocuments({
        current: [{ path: ".agentplugged/docs/vision.md", text: page }],
        owners: new Set(["zoe"]),
      }),
    ).toEqual([]);
  });

  it("names the step and the warnings in both languages", () => {
    const fr = createTranslator("fr");
    const en = createTranslator("en");
    expect(fr("next.step.knowledge_base_update")).toBe("Mettre à jour la base de connaissance");
    expect(en("next.step.knowledge_base_update")).toBe("Update the knowledge base");
    const details = { path: "p.md", source: "prd.md", checkpoint: "G-1" };
    for (const key of [
      "docs.check.warning.kb_stale",
      "docs.check.warning.kb_source_unrecorded",
    ] as const) {
      expect(fr(key, details)).toContain("G-1");
      expect(fr(key, details)).toContain("tu as validé");
      expect(en(key, details)).toContain("prd.md");
    }
  });
});
