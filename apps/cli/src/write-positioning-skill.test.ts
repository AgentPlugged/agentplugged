import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import {
  AGENT_DOMAINS,
  checkDocumentsDetailed,
  type Definition,
  GENERATED_HEADER,
  LAUNCH_PAGES_DIR,
  NEXT_STEPS,
  POSITIONING_PATH,
  readDefinitions,
  withGeneratedHeader,
} from "@agentplugged/core";
import { createTranslator } from "@agentplugged/i18n";
import {
  ErrorCode,
  LAUNCH_DOCUMENT_REASONS,
  POSITIONING_SECTIONS,
  type SkillFrontmatter,
} from "@agentplugged/protocol";
import { beforeAll, describe, expect, it } from "vitest";

/** The positioning skill: Julien writes the positioning, then the pages, never publishes. */
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);
const SKILL = "write-positioning";
const PAGE = `${LAUNCH_PAGES_DIR}home.md`;
const KB = {
  path: ".agentplugged/docs/index.md",
  text: "---\nid: kb-index\nkind: note\nowner: zoe\nlinks: []\n---\n# Map\n",
};

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

/** A template filled as the skill asks: every placeholder in angle brackets replaced by a text. */
const filled = (path: string) =>
  annex(path)
    .replace("<verified, stated or untrusted>", "stated")
    .replace(/<[^<>\n]+>/g, "Something true about it");

const owners = new Set(Object.keys(AGENT_DOMAINS));
const check = (files: Array<{ path: string; text: string }>) =>
  checkDocumentsDetailed({ current: [KB, ...files], owners });

describe("the positioning skill", () => {
  it("ships the skill with its annexes, called from Julien's menu", () => {
    expect([...skill().annexes].sort()).toEqual([
      "assets/page-template.md",
      "assets/positioning-template.md",
      "references/positioning-checklist.md",
      "references/seo-checklist.md",
    ]);
    const metadata = (skill().frontmatter as SkillFrontmatter).metadata;
    expect(metadata).toMatchObject({ agent: "julien", phase: "launch" });
    const menu = agents.get("julien")?.agent?.menu ?? [];
    for (const code of ["PO", "PG"]) {
      const item = menu.find((entry) => entry.code === code);
      expect(item?.skill, code).toBe(SKILL);
      expect(item?.prompt, code).toBeUndefined();
    }
    // The search plan and the visuals keep their own prompts; contents and campaign plans have their own skill.
    for (const code of ["SE", "VI"]) {
      expect(menu.find((entry) => entry.code === code)?.prompt, code).toBeDefined();
    }
  });

  it("gives the skill its sections and its numbered steps", () => {
    const { body } = skill();
    for (const title of ["Overview", "Before you start", "Decisions", "Steps", "Rules"]) {
      expect(
        body.split("\n").filter((line) => line === `## ${title}`),
        title,
      ).toHaveLength(1);
    }
    const steps = [...body.matchAll(/^(\d{1,2})\. \*\*/gm)].map((match) => Number(match[1]));
    expect(steps).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

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

  it("works through the MCP server as Julien, from next to a publication checkpoint", () => {
    const text = flat(skill().body);
    for (const call of [
      "agent.status",
      "state.get",
      "checkpoint.open",
      "story.result",
      "guard.external_read",
      "chat.answer",
    ]) {
      expect(text, call).toContain(`\`${call}\``);
    }
    expect(text).toContain("`agent: julien`");
    expect(step(1)).toContain("`npx agentplugged next --json`");
    expect(NEXT_STEPS).toContain("positioning");
    expect(step(9)).toContain("`type: publication`");
    expect(step(9)).toContain("`git rev-parse HEAD:<path>`");
    expect(step(9).indexOf("`git commit`")).toBeLessThan(step(9).indexOf("`checkpoint.open`"));
    expect(step(9)).toContain("One checkpoint per deliverable");
    expect(step(11)).toContain("`story.result`");
  });

  it("never publishes, and writes only the positioning and the pages", () => {
    const rules = flat(skill().body.slice(skill().body.indexOf("\n## Rules")));
    expect(rules).toContain("Never publish, send, schedule, buy or pay anything");
    expect(rules).toContain("Write only `.agentplugged/docs/launch/positioning.md`");
    expect(rules).toContain("Never invent a fact");
    const written = [...skill().body.matchAll(/`(\.agentplugged\/docs\/[^`]+)`/g)].map((m) => m[1]);
    const own = /^\.agentplugged\/docs\/(?:launch\/(?:positioning\.md|pages\/.*)?|index\.md)$/;
    for (const path of written) expect(path, path).toMatch(own);
    expect(written).toContain(POSITIONING_PATH);
  });

  it("starts from the press release when the creator validated it, without copying it", () => {
    const read = step(2);
    expect(read).toContain("`prfaq.md`");
    expect(read).toContain("the creator validated it");
    expect(read).toContain("Start from it, never copy it");
    expect(read).toContain("still needs its row in **Evidence**");
    expect(read).toContain("Add its id (`prfaq`) to `links`");
  });

  it("opens a decision instead of inventing a fact the base lacks", () => {
    const text = flat(skill().body);
    expect(step(3)).toContain("becomes a `decision`");
    expect(text).toContain("`type: decision`");
    expect(text).toContain("is never guessed");
    // A statement of the creator is never presented as verified in the base.
    expect(text).toContain("as `stated`, with its date");
  });

  it("stops without a knowledge base, without a launch phase, and before a validated positioning", () => {
    expect(step(1)).toContain("`launch`");
    expect(step(1)).toContain("`partial`");
    expect(step(2)).toContain("Without `index.md` there is no knowledge base");
    expect(step(2)).toContain("**pages** — the positioning is **validated**");
    expect(step(2)).toContain("write nothing");
    expect(step(10)).toContain("`publication`");
    expect(step(10)).toContain("equal to it");
  });

  it("treats a keyword without data as a hypothesis and reads the web declared and untrusted", () => {
    expect(step(6)).toContain("`hypothesis: true`");
    expect(step(6)).toContain("never a volume from memory");
    expect(step(6)).toContain("declare the read first, then read");
    expect(step(6)).toContain("marked `untrusted`");
    const seo = flat(annex("references/seo-checklist.md"));
    for (const part of ["Hypothesis", "provenance", "**before**", "`untrusted`", "70", "170"]) {
      expect(seo, part).toContain(part);
    }
  });

  it("handles a product without a website and a language other than the creator's", () => {
    expect(step(6)).toContain("A product without a website has no page in this folder");
    expect(flat(skill().body)).toContain("**product's language**");
    expect(flat(annex("references/seo-checklist.md"))).toContain("does not exist");
  });

  it("ships a positioning template whose sections are the ones docs check reads", () => {
    const headings = annex("assets/positioning-template.md")
      .split("\n")
      .filter((line) => line.startsWith("## "))
      .map((line) => line.slice(3).toLowerCase());
    for (const titles of Object.values(POSITIONING_SECTIONS)) {
      expect(headings.some((heading) => (titles as readonly string[]).includes(heading))).toBe(
        true,
      );
    }
  });

  it("ships templates that pass docs check once filled, and refuses their markers before", () => {
    const positioning = { path: POSITIONING_PATH, text: filled("assets/positioning-template.md") };
    const page = { path: PAGE, text: filled("assets/page-template.md") };
    expect(check([positioning, page]).problems).toEqual([]);
    const raw = check([
      { path: POSITIONING_PATH, text: annex("assets/positioning-template.md") },
      { path: PAGE, text: annex("assets/page-template.md") },
    ]).problems;
    expect(raw.length).toBeGreaterThan(0);
    // A marker left is refused, and so is a sample left standing as a measure or as evidence.
    expect(raw.map((problem) => problem.code)).toContain(ErrorCode.DOC_PLACEHOLDER_LEFT);
    expect(new Set(raw.map((problem) => problem.code))).toEqual(
      new Set([ErrorCode.DOC_PLACEHOLDER_LEFT, ErrorCode.LAUNCH_DOCUMENT_INVALID]),
    );
    // The two sample keywords of the page template: one measured, one hypothesis.
    expect(annex("assets/page-template.md")).toContain("hypothesis: true");
    expect(annex("assets/page-template.md")).toContain("provenance: untrusted");
  });

  it("refuses a template copied with its generated line, and accepts it once the line is gone", () => {
    const files = [
      {
        path: POSITIONING_PATH,
        text: withGeneratedHeader(filled("assets/positioning-template.md")),
      },
      { path: PAGE, text: withGeneratedHeader(filled("assets/page-template.md")) },
    ];
    expect(check(files).problems.map((problem) => problem.details.reason_key)).toEqual([
      "reason.doc_generated_marker",
      "reason.doc_generated_marker",
    ]);
    const cleaned = files.map((file) => ({
      ...file,
      text: file.text.replace(`${GENERATED_HEADER}\n`, ""),
    }));
    expect(check(cleaned).problems).toEqual([]);
  });

  it("explains every refusal, in French (tu) and in English", () => {
    const fr = createTranslator("fr");
    const en = createTranslator("en");
    for (const reason of LAUNCH_DOCUMENT_REASONS) {
      const key = `error.launch_document_invalid.${reason}` as Parameters<typeof fr>[0];
      expect(fr(key), key).not.toBe(key);
      expect(en(key), key).not.toBe(key);
      expect(fr(key), key).not.toBe(en(key));
    }
    for (const reason of [
      "launch_seo_title_long",
      "launch_seo_description_long",
      "launch_positioning_not_validated",
    ]) {
      const key = `docs.check.warning.${reason}` as Parameters<typeof fr>[0];
      expect(fr(key), key).not.toBe(key);
      expect(en(key), key).not.toBe(key);
    }
    expect(fr("next.step.positioning")).toBe("Rédiger le positionnement");
    expect(en("next.step.positioning")).toBe("Write the positioning");
    expect(fr("error.launch_document_invalid.keyword_unverified" as never)).toMatch(/marque-le/);
  });
});
