import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import {
  AGENT_DOMAINS,
  checkDocumentsDetailed,
  type Definition,
  GENERATED_HEADER,
  LAUNCH_CAMPAIGNS_DIR,
  LAUNCH_CONTENT_DIR,
  POSITIONING_PATH,
  readDefinitions,
  withGeneratedHeader,
} from "@agentplugged/core";
import { gitBlobId, utf8 } from "@agentplugged/crypto";
import { createTranslator } from "@agentplugged/i18n";
import {
  CAMPAIGN_SECTIONS,
  CONTENT_SECTIONS,
  ErrorCode,
  LAUNCH_DOCUMENT_REASONS,
  type SkillFrontmatter,
} from "@agentplugged/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { noahCorpus } from "./__helpers__/noah-text.js";

/** The contents skill: Julien writes articles, posts and campaign plans, never publishes. */
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);
const SKILL = "write-content";
const ARTICLE = `${LAUNCH_CONTENT_DIR}first.md`;
const CAMPAIGN = `${LAUNCH_CAMPAIGNS_DIR}launch.md`;
const KB = {
  path: ".agentplugged/docs/index.md",
  text: "---\nid: kb-index\nkind: note\nowner: zoe\nlinks: []\n---\n# Map\n",
};
const POSITIONING = {
  path: POSITIONING_PATH,
  text: `---\nid: positioning\nkind: note\nowner: julien\nlinks: [kb-index]\nlanguage: en\n---\n# Positioning\n\n${[
    "Audience",
    "Problem",
    "Promise",
    "Difference",
  ]
    .map((title) => `## ${title}\n\nSomething true about it.\n`)
    .join(
      "\n",
    )}\n## Evidence\n\n| Claim | Status | Source |\n| --- | --- | --- |\n| It syncs | verified | kb-index |\n`,
};
const BLOB = gitBlobId(utf8(POSITIONING.text), "sha1");

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

/** A template filled as the skill asks: the blob of the positioning, then every placeholder replaced. */
const filled = (path: string) =>
  annex(path)
    .replace("<blob of the positioning this content was written on>", BLOB)
    .replace("<blob of the positioning this plan was written on>", BLOB)
    .replace(/<[^<>\n]+>/g, "Something true about it");

const owners = new Set(Object.keys(AGENT_DOMAINS));
const check = (files: Array<{ path: string; text: string }>) =>
  checkDocumentsDetailed({ current: [KB, POSITIONING, ...files], owners });

describe("the contents skill", () => {
  it("ships the skill with its annexes, called from Julien's menu", () => {
    expect([...skill().annexes].sort()).toEqual([
      "assets/campaign-template.md",
      "assets/content-template.md",
      "references/content-checklist.md",
    ]);
    const metadata = (skill().frontmatter as SkillFrontmatter).metadata;
    expect(metadata).toMatchObject({ agent: "julien", phase: "launch" });
    const menu = agents.get("julien")?.agent?.menu ?? [];
    for (const code of ["CT", "CP"]) {
      const item = menu.find((entry) => entry.code === code);
      expect(item?.skill, code).toBe(SKILL);
      expect(item?.prompt, code).toBeUndefined();
    }
    // The positioning and the pages keep their own skill.
    for (const code of ["PO", "PG"]) {
      expect(menu.find((entry) => entry.code === code)?.skill, code).toBe("write-positioning");
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
    expect(steps).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  const step = (n: number) => {
    const body = skill().body;
    const start = body.indexOf(`\n${n}. **`);
    const next = body.indexOf(`\n${n + 1}. **`, start + 1);
    return flat(body.slice(start, next === -1 ? body.indexOf("\n## When") : next));
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
    expect(step(11)).toContain("`type: publication`");
    expect(step(11)).toContain("`git rev-parse HEAD:<path>`");
    expect(step(11).indexOf("`git commit`")).toBeLessThan(step(11).indexOf("`checkpoint.open`"));
    expect(step(11)).toContain("One checkpoint per deliverable");
    expect(step(12)).toContain("`story.result`");
  });

  it("produces nothing without a validated positioning, and reads the same rule as the engine", () => {
    expect(step(2)).toContain("**not validated**");
    expect(step(2)).toContain("write nothing, open nothing");
    expect(step(2)).toContain("never a waiver, never an option picked");
    expect(step(2)).toContain("the last *approved* `publication` checkpoint");
    expect(step(2)).toContain("is the blob of the file as it is now in the working copy");
    for (const state of ["no file", "a draft", "edited since the approval"]) {
      expect(step(2), state).toContain(state);
    }
    expect(flat(skill().body)).toContain("Produce nothing without a validated positioning");
  });

  it("never publishes, schedules or spends, and writes only the contents and the campaigns", () => {
    const rules = flat(skill().body.slice(skill().body.indexOf("\n## Rules")));
    expect(rules).toContain("Never publish, send, schedule, book, buy or pay anything");
    expect(rules).toContain("the creator spends");
    expect(rules).toContain("Write only the files of `.agentplugged/docs/launch/content/`");
    expect(rules).toContain("Never invent a fact");
    expect(step(8)).toContain("nothing is scheduled by you");
    expect(step(8)).toContain("A plan never spends");
    expect(step(8)).toContain("Julien does none of them");
    const written = [...skill().body.matchAll(/`(\.agentplugged\/docs\/[^`]+)`/g)].map((m) => m[1]);
    const own =
      /^\.agentplugged\/docs\/(?:launch\/(?:positioning\.md|pages\/.*|content\/.*|campaigns\/.*)|index\.md)$/;
    for (const path of written) expect(path, path).toMatch(own);
    expect(written).toContain(".agentplugged/docs/launch/content/<slug>.md");
    expect(written).toContain(".agentplugged/docs/launch/campaigns/<slug>.md");
  });

  it("links every content to the positioning and to the pages of the base it uses", () => {
    expect(step(7)).toContain("`positioning`");
    expect(step(7)).toContain("the id of each page of the base");
    expect(step(7)).toContain("`positioning_blob`");
    expect(flat(skill().body)).toContain("Link every content to the positioning");
    expect(skill().body).toContain("`launch_content_positioning_outdated`");
  });

  it("sources every figure, declares outside reads before they are made and keeps them untrusted", () => {
    expect(step(6)).toContain("declare the read first, then read");
    expect(step(6)).toContain("`untrusted`");
    expect(step(6)).toContain("never a promise");
    expect(step(6)).toContain("Never invent or round a figure");
    expect(step(7)).toContain("every figure or outside claim in it has its reference");
    const rules = flat(skill().body.slice(skill().body.indexOf("\n## Rules")));
    expect(rules).toContain("always has its source");
    expect(rules).toContain("never state it as the product's own claim");
    const checklist = flat(annex("references/content-checklist.md"));
    for (const part of ["**before**", "`untrusted`", "« according to … »", "ignored"]) {
      expect(checklist, part).toContain(part);
    }
  });

  it("opens a decision instead of inventing a fact, and says no budget in a sentence", () => {
    expect(step(5)).toContain("becomes a `decision`");
    expect(flat(skill().body)).toContain("is never guessed");
    expect(step(8)).toContain("No budget: every action is free.");
    expect(step(4)).toContain("Never decide a budget");
    expect(step(11)).toContain("high for a campaign plan whose budget is above zero");
  });

  it("stops without a knowledge base, without a launch phase and in review mode", () => {
    expect(step(1)).toContain("`launch`");
    expect(step(1)).toContain("`partial`");
    expect(step(3)).toContain("Without `index.md` there is no knowledge base");
    expect(step(4)).toContain("never copy a template");
    expect(step(4)).toContain("never open a checkpoint");
    expect(flat(skill().body)).toContain("**the audience of its channel**");
  });

  it("ships templates whose sections are the ones docs check reads", () => {
    const headings = (path: string) =>
      annex(path)
        .split("\n")
        .filter((line) => line.startsWith("## "))
        .map((line) => line.slice(3).toLowerCase());
    for (const titles of Object.values(CONTENT_SECTIONS)) {
      expect(
        headings("assets/content-template.md").some((h) =>
          (titles as readonly string[]).includes(h),
        ),
      ).toBe(true);
    }
    for (const titles of Object.values(CAMPAIGN_SECTIONS)) {
      expect(
        headings("assets/campaign-template.md").some((h) =>
          (titles as readonly string[]).includes(h),
        ),
      ).toBe(true);
    }
  });

  it("ships templates that pass docs check once filled, and refuses their markers before", () => {
    const article = { path: ARTICLE, text: filled("assets/content-template.md") };
    const campaign = { path: CAMPAIGN, text: filled("assets/campaign-template.md") };
    expect(check([article, campaign]).problems).toEqual([]);
    const raw = check([
      { path: ARTICLE, text: annex("assets/content-template.md") },
      { path: CAMPAIGN, text: annex("assets/campaign-template.md") },
    ]).problems;
    expect(raw.length).toBeGreaterThan(0);
    expect(new Set(raw.map((problem) => problem.code))).toEqual(
      new Set([ErrorCode.DOC_PLACEHOLDER_LEFT, ErrorCode.LAUNCH_DOCUMENT_INVALID]),
    );
    // A figure sample and a source sample of the article template stand as models only.
    expect(annex("assets/content-template.md")).toContain("provenance: untrusted");
    expect(annex("assets/content-template.md")).toContain("provenance: knowledge_base");
  });

  it("writes every marker of a template with several words, so that docs check sees it left behind", () => {
    for (const path of ["assets/content-template.md", "assets/campaign-template.md"]) {
      const body = annex(path).replace(/<!--[\s\S]*?-->/g, "");
      for (const [marker] of body.matchAll(/<[^<>\n]+>/g)) {
        expect(marker, `${path}: ${marker}`).toMatch(/\s|…/);
      }
    }
  });

  it("refuses a template copied with its generated line, and accepts it once the line is gone", () => {
    const files = [
      { path: ARTICLE, text: withGeneratedHeader(filled("assets/content-template.md")) },
      { path: CAMPAIGN, text: withGeneratedHeader(filled("assets/campaign-template.md")) },
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

  it("explains every refusal and warning, in French (tu) and in English", () => {
    const fr = createTranslator("fr");
    const en = createTranslator("en");
    for (const reason of LAUNCH_DOCUMENT_REASONS) {
      const key = `error.launch_document_invalid.${reason}` as Parameters<typeof fr>[0];
      expect(fr(key), key).not.toBe(key);
      expect(en(key), key).not.toBe(key);
      expect(fr(key), key).not.toBe(en(key));
    }
    for (const reason of [
      "launch_content_positioning_outdated",
      "launch_content_figure_unsourced",
    ]) {
      const key = `docs.check.warning.${reason}` as Parameters<typeof fr>[0];
      expect(fr(key), key).not.toBe(key);
      expect(en(key), key).not.toBe(key);
      expect(fr(key), key).not.toBe(en(key));
    }
    expect(fr("error.launch_document_invalid.content_goal" as never)).toMatch(/donne/);
    expect(fr("error.launch_document_invalid.content_section_empty" as never)).toMatch(/dis-le/);
  });

  it("lets Noah offer contents once the positioning is validated, in the conversation", () => {
    const noah = flat(noahCorpus(methodDir));
    expect(noah).toContain("articles, community posts (`CT`) and campaign plans (`CP`)");
    expect(noah).toContain("validated version of the positioning only");
    expect(noah).toContain("the creator publishes, sends, books and pays");
  });
});
