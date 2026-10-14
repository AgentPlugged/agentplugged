import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import {
  AGENT_DOMAINS,
  checkDocuments,
  type Definition,
  GENERATED_HEADER,
  KNOWLEDGE_BASE_INDEX_PATH,
  KNOWLEDGE_BASE_WRITER,
  NEXT_STEPS,
  parseDocumentFile,
  readDefinitions,
  withGeneratedHeader,
} from "@agentplugged/core";
import { createTranslator } from "@agentplugged/i18n";
import type { SkillFrontmatter } from "@agentplugged/protocol";
import { beforeAll, describe, expect, it } from "vitest";

/** The knowledge base skill: Zoé writes the base, then asks the creator to read it. */
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);
const SKILL = "generate-knowledge-base";

/** Each template, with the page it becomes. */
const TEMPLATES = [
  { template: "assets/index-template.md", document: KNOWLEDGE_BASE_INDEX_PATH, id: "kb-index" },
  { template: "assets/page-template.md", document: ".agentplugged/docs/vision.md", id: "kb-topic" },
  {
    template: "assets/guide-template.md",
    document: ".agentplugged/docs/guides/getting-started.md",
    id: "kb-guide-topic",
  },
  {
    template: "assets/release-notes-template.md",
    document: ".agentplugged/docs/release-notes/1-0-0.md",
    id: "kb-release-version",
  },
] as const;

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

function skill(): Definition {
  const definition = skills.get(SKILL);
  if (definition === undefined) throw new Error(`${SKILL} is not shipped`);
  return definition;
}

const flat = (text: string) => text.replace(/\s+/g, " ");
const annex = (path: string) =>
  readFileSync(join(methodDir, "skills", SKILL, path), "utf8").replace(/\r\n/g, "\n");

describe("the knowledge base skill", () => {
  it("ships the skill with its annexes, called from Zoé's menu", () => {
    expect([...skill().annexes].sort()).toEqual(
      [...TEMPLATES.map((entry) => entry.template), "references/kb-checklist.md"]
        .concat(
          "references/living-docs.md",
          "references/repository-scan.md",
          "references/reuse-map.md",
        )
        .sort(),
    );
    const metadata = (skill().frontmatter as SkillFrontmatter).metadata;
    expect(metadata).toMatchObject({ agent: KNOWLEDGE_BASE_WRITER, phase: "build" });
    const item = agents
      .get(KNOWLEDGE_BASE_WRITER)
      ?.agent?.menu.find((entry) => entry.code === "KB");
    expect(item?.skill).toBe(SKILL);
    expect(item?.prompt).toBeUndefined();
  });

  it("gives the skill its sections and its numbered steps", () => {
    const { body } = skill();
    for (const title of ["Overview", "Before you start", "Decisions", "Steps", "Rules"]) {
      const headings = body.split("\n").filter((line) => line === `## ${title}`);
      expect(headings, `## ${title}`).toHaveLength(1);
    }
    const steps = [...body.matchAll(/^(\d{1,2})\. \*\*/gm)].map((match) => Number(match[1]));
    expect(steps).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  /** The text of step `n` of the skill, up to the next step. */
  const step = (n: number) => {
    const body = skill().body;
    const start = body.indexOf(`\n${n}. **`);
    const next = body.indexOf(`\n${n + 1}. **`, start + 1);
    return flat(body.slice(start, next === -1 ? body.indexOf("\n## Rules") : next));
  };

  it("names only its own annexes, and every one of them", () => {
    const named = new Set(
      [...skill().body.matchAll(/`((?:assets|references)\/[\w.-]+\.md)`/g)].map((m) => m[1]),
    );
    expect([...named].sort()).toEqual([...skill().annexes].sort());
  });

  it("writes only Zoé's pages of the base", () => {
    const own =
      /^\.agentplugged\/docs\/(?:index\.md|vision\.md|conventions\.md|(?:guides|reference|release-notes)\/.+)$/;
    const written = [...step(5).matchAll(/`(\.agentplugged\/docs\/[^`]+)`/g)].map((m) => m[1]);
    expect(written.length).toBeGreaterThan(5);
    for (const path of written) expect(path, path).toMatch(own);
    expect(written).toContain(KNOWLEDGE_BASE_INDEX_PATH);
  });

  it("works through the MCP server as Zoé, from next to a document checkpoint", () => {
    const text = flat(skill().body);
    for (const call of ["agent.status", "state.get", "checkpoint.open", "story.result"]) {
      expect(text, call).toContain(`\`${call}\``);
    }
    expect(text).toContain("`agent: zoe`");
    // It starts from next, reads the repository only when it is a source, checks, then commits
    // and asks the creator to review the pages.
    expect(step(1)).toContain("`npx agentplugged next --json`");
    for (const id of ["knowledge_base", "knowledge_base_review", "knowledge_base_decision"]) {
      expect(NEXT_STEPS).toContain(id);
      expect(step(1)).toContain(`\`${id}\``);
    }
    expect(step(4)).toContain("only for what step 3 gave to the repository");
    expect(step(7)).toContain("`npx agentplugged docs check`");
    expect(step(9)).toContain("`type: document`");
    expect(step(9)).toContain("`git rev-parse HEAD:<path>`");
    expect(step(9).indexOf("`git commit`")).toBeLessThan(step(9).indexOf("`checkpoint.open`"));
    expect(step(10)).toContain("`story.result`");
  });

  it("tells Zoé how to read a repository and what to check before showing the base", () => {
    const scan = flat(annex("references/repository-scan.md"));
    for (const part of ["manifests", "entry points", "CI", "Git tags", "never copy the value"]) {
      expect(scan, part).toContain(part);
    }
    const checklist = flat(annex("references/kb-checklist.md"));
    for (const part of ["lists every page", "**Sources**", "Last updated", "docs check"]) {
      expect(checklist, part).toContain(part);
    }
  });

  const owners = new Set(Object.keys(AGENT_DOMAINS));
  const pages = () =>
    TEMPLATES.map(({ template, document }) => ({ path: document, text: annex(template) }));

  it("ships templates that pass docs check, owned by Zoé, defining no identifier", () => {
    expect(checkDocuments({ current: pages(), owners })).toEqual([]);
    for (const { template, document, id } of TEMPLATES) {
      const parsed = parseDocumentFile(document, annex(template));
      expect(parsed.header, template).toMatchObject({ id, kind: "note", owner: "zoe" });
      expect(parsed.definitions, template).toEqual([]);
      expect(annex(template), template).toContain("Last updated: <date> — <what changed it>");
      expect(annex(template).split("\n"), template).toContain("## Sources");
    }
  });

  it("refuses a template copied with its generated line, and accepts it once the line is gone", () => {
    const rendered = pages().map((file) => ({ ...file, text: withGeneratedHeader(file.text) }));
    const problems = checkDocuments({ current: rendered, owners });
    expect(problems.map((problem) => problem.details.reason_key)).toEqual(
      rendered.map(() => "reason.doc_generated_marker"),
    );
    const cleaned = rendered.map((file) => ({
      ...file,
      text: file.text.replace(`${GENERATED_HEADER}\n`, ""),
    }));
    expect(checkDocuments({ current: cleaned, owners })).toEqual([]);
  });

  it("names the step of next in both languages", () => {
    expect(NEXT_STEPS).toContain("knowledge_base");
    expect(createTranslator("fr")("next.step.knowledge_base")).toBe(
      "Générer la base de connaissance",
    );
    expect(createTranslator("en")("next.step.knowledge_base")).toBe("Generate the knowledge base");
  });
});
