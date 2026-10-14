import { gitBlobId, utf8 } from "@agentplugged/crypto";
import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  checkDocumentsDetailed,
  type DocumentFile,
  LAUNCH_CAMPAIGNS_DIR,
  LAUNCH_CONTENT_DIR,
  LAUNCH_PAGES_DIR,
  POSITIONING_PATH,
} from "../index.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { answered } from "../testing/checkpoint-state.js";

/** `docs check` on the contents and the campaign plans of the launch. */

const ARTICLE = `${LAUNCH_CONTENT_DIR}first.md`;
const CAMPAIGN = `${LAUNCH_CAMPAIGNS_DIR}launch.md`;
const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);

const KB = "---\nid: kb-index\nkind: note\nowner: zoe\nlinks: []\n---\n# Map\n";
const EVIDENCE =
  "| Claim | Status | Source |\n| --- | --- | --- |\n| It syncs | verified | kb-index |\n";
const POSITIONING = `---\nid: positioning\nkind: note\nowner: julien\nlinks: [kb-index]\nlanguage: en\n---\n# Positioning\n\n${[
  "Audience",
  "Problem",
  "Promise",
  "Difference",
]
  .map((title) => `## ${title}\n\nSomething true about it.\n`)
  .join("\n")}\n## Evidence\n\n${EVIDENCE}`;
const BLOB = gitBlobId(utf8(POSITIONING), "sha1");

const GOAL = `  goal:
    metric: "visits from a query"
    target: 500
    by: 2026-12-31
    observed_with: "the search console"
`;

interface Overrides {
  readonly id?: string;
  readonly links?: string;
  readonly language?: string | null;
  /** The whole `content` block, without its first line. */
  readonly block?: string;
  readonly body?: string;
}

const ARTICLE_BODY = "## Text\n\nAn honest text.\n\n## Sources\n\nNone.\n";
const CAMPAIGN_BODY = [
  "Objective",
  "Audience",
  "Channels",
  "Calendar",
  "Budget",
  "Measurement",
  "Creator actions",
  "Sources",
]
  .map((title) => `## ${title}\n\nSomething true about it.\n`)
  .join("\n");

function content(type: string, overrides: Overrides = {}): string {
  const channel = type === "campaign_plan" ? "" : '  channel: "the blog"\n';
  const block =
    overrides.block ?? `  type: ${type}\n${channel}  positioning_blob: ${BLOB}\n${GOAL}`;
  const language = overrides.language === null ? "" : `language: ${overrides.language ?? "en"}\n`;
  const id = overrides.id ?? (type === "campaign_plan" ? "campaign-launch" : "content-first");
  return `---\nid: ${id}\nkind: note\nowner: julien\nlinks: ${overrides.links ?? "[positioning, kb-index]"}\n${language}content:\n${block}---\n# Content\n\n${overrides.body ?? (type === "campaign_plan" ? CAMPAIGN_BODY : ARTICLE_BODY)}`;
}

const article = (overrides: Overrides = {}) => content("article", overrides);
const campaign = (overrides: Overrides = {}) => content("campaign_plan", overrides);

function check(files: Record<string, string>, checkpoints?: CheckpointState[]) {
  const current: DocumentFile[] = Object.entries({
    ".agentplugged/docs/index.md": KB,
    [POSITIONING_PATH]: POSITIONING,
    ...files,
  }).map(([path, text]) => ({ path, text }));
  return checkDocumentsDetailed({
    current,
    owners: new Set(["julien", "zoe"]),
    ...(checkpoints === undefined ? {} : { validations: { checkpoints, now: NOW } }),
  });
}

const launchProblems = (result: ReturnType<typeof check>) =>
  result.problems.filter((problem) => problem.code === ErrorCode.LAUNCH_DOCUMENT_INVALID);
const reasons = (result: ReturnType<typeof check>) =>
  launchProblems(result).map((problem) => problem.details.reason);
const warningReasons = (result: ReturnType<typeof check>) =>
  result.warnings.map((entry) => entry.reason);

describe("docs check: the contents", () => {
  it("accepts an article and a campaign plan with their header and their sections", () => {
    expect(check({ [ARTICLE]: article(), [CAMPAIGN]: campaign() }).problems).toEqual([]);
  });

  it("accepts a community post, and sections and a language in French", () => {
    const french = "## Texte\n\nUn texte honnête.\n\n## Sources\n\nAucune.\n";
    const post = content("community_post", { language: "fr", body: french });
    expect(check({ [ARTICLE]: post }).problems).toEqual([]);
  });

  it("accepts a campaign plan with no budget, said in a sentence", () => {
    const body = CAMPAIGN_BODY.replace(
      /## Budget\n\nSomething true about it\./,
      "## Budget\n\nNo budget: every action is free.",
    );
    expect(check({ [CAMPAIGN]: campaign({ body }) }).problems).toEqual([]);
  });

  it("refuses a content that does not link to the positioning, or to any page of the base", () => {
    expect(reasons(check({ [ARTICLE]: article({ links: "[kb-index]" }) }))).toEqual([
      "content_positioning_link",
    ]);
    expect(reasons(check({ [ARTICLE]: article({ links: "[positioning]" }) }))).toEqual([
      "content_base_link",
    ]);
    // A requirement identifier is not a page of the base.
    expect(reasons(check({ [ARTICLE]: article({ links: "[positioning, EF-43]" }) }))).toEqual([
      "content_base_link",
    ]);
  });

  it("accepts a page of the site as the page it builds on", () => {
    const page = `---\nid: page-home\nkind: note\nowner: julien\nlinks: [positioning]\nlanguage: en\nseo:\n  intent: "Find it"\n  title: "A title"\n  description: "A description."\n  keywords:\n    - term: "snippets"\n      hypothesis: true\n---\n# Home\n`;
    const result = check({
      [`${LAUNCH_PAGES_DIR}home.md`]: page,
      [ARTICLE]: article({ links: "[positioning, page-home]" }),
    });
    expect(launchProblems(result)).toEqual([]);
  });

  it("refuses a link to a page of the base that no longer exists", () => {
    const result = check({ [ARTICLE]: article({ links: "[positioning, kb-gone]" }) });
    expect(result.problems.map((problem) => problem.code)).toContain(ErrorCode.DOC_LINK_DANGLING);
    expect(reasons(result)).toContain("content_base_link");
  });

  it("reports a positioning that does not exist, and no page left once the only one is gone", () => {
    const current: DocumentFile[] = [
      { path: ".agentplugged/docs/index.md", text: KB },
      { path: ARTICLE, text: article() },
    ];
    const absent = checkDocumentsDetailed({ current, owners: new Set(["julien", "zoe"]) });
    expect(absent.problems.map((problem) => problem.code)).toContain(ErrorCode.DOC_LINK_DANGLING);
    const gone = check({ [ARTICLE]: article({ links: "[positioning, kb-gone]" }) });
    expect(reasons(gone)).toContain("content_base_link");
  });

  it("refuses a missing or misplaced type, a wrong id and a missing channel", () => {
    const noBlock = article().replace(/content:\n[\s\S]*?(?=---\n# Content)/, "");
    expect(reasons(check({ [ARTICLE]: noBlock }))).toEqual(["content_type"]);
    // A campaign plan in the folder of the articles, and an article in the campaigns.
    const plan = campaign({ id: "content-first", body: ARTICLE_BODY });
    expect(reasons(check({ [ARTICLE]: plan }))).toEqual(["content_type"]);
    const post = article({ id: "campaign-launch", body: CAMPAIGN_BODY });
    expect(reasons(check({ [CAMPAIGN]: post }))).toEqual(["content_type"]);
    expect(reasons(check({ [ARTICLE]: article({ id: "article-first" }) }))).toEqual(["content_id"]);
    expect(reasons(check({ [ARTICLE]: article({ id: "content-" }) }))).toEqual(["content_id"]);
    const noChannel = article({ block: `  type: article\n  positioning_blob: ${BLOB}\n${GOAL}` });
    expect(reasons(check({ [ARTICLE]: noChannel }))).toEqual(["content_channel"]);
    expect(launchProblems(check({ [ARTICLE]: noChannel }))[0]?.message_key).toBe(
      "error.launch_document_invalid.content_channel",
    );
  });

  it("requires a measurable goal: metric, target above zero, real date and way to observe", () => {
    const goals = [
      ["metric", GOAL.replace('metric: "visits from a query"', 'metric: ""')],
      ["target", GOAL.replace("target: 500", "target: 0")],
      ["target", GOAL.replace("target: 500", 'target: "many"')],
      ["by", GOAL.replace("by: 2026-12-31", "by: 2026-02-30")],
      ["observed_with", GOAL.replace(/ {4}observed_with:.*\n/, "")],
    ] as const;
    for (const [field, goal] of goals) {
      const block = `  type: article\n  channel: "blog"\n  positioning_blob: ${BLOB}\n${goal}`;
      const result = check({ [ARTICLE]: article({ block }) });
      expect(
        launchProblems(result).map((problem) => problem.details.field),
        field,
      ).toEqual([`content.goal.${field}`]);
    }
    const none = `  type: article\n  channel: "blog"\n  positioning_blob: ${BLOB}\n`;
    expect(reasons(check({ [ARTICLE]: article({ block: none }) }))).toEqual(["content_goal"]);
  });

  it("refuses a missing language and a positioning blob that is not a blob", () => {
    expect(reasons(check({ [ARTICLE]: article({ language: null }) }))).toEqual(["language"]);
    const block = `  type: article\n  channel: "blog"\n  positioning_blob: not-a-blob\n${GOAL}`;
    expect(reasons(check({ [ARTICLE]: article({ block }) }))).toEqual(["content_positioning_blob"]);
  });

  it("refuses a missing, empty or doubled section, in an article and in a plan", () => {
    const noSources = article({ body: "## Text\n\nA text.\n" });
    expect(
      launchProblems(check({ [ARTICLE]: noSources })).map((p) => [
        p.details.reason,
        p.details.section,
      ]),
    ).toEqual([["content_section_missing", "sources"]]);
    const empty = article({ body: "## Text\n\n<!-- later -->\n\n## Sources\n\nNone.\n" });
    expect(reasons(check({ [ARTICLE]: empty }))).toEqual(["content_section_empty"]);
    const doubled = article({ body: `${ARTICLE_BODY}\n## Text\n\nAgain.\n` });
    expect(reasons(check({ [ARTICLE]: doubled }))).toEqual(["content_section_duplicate"]);
    const noCalendar = campaign({
      body: CAMPAIGN_BODY.replace(/## Calendar[\s\S]*?(?=## Budget)/, ""),
    });
    expect(
      launchProblems(check({ [CAMPAIGN]: noCalendar })).map((p) => [
        p.details.reason,
        p.details.section,
      ]),
    ).toEqual([["content_section_missing", "calendar"]]);
    const noBudget = campaign({
      body: CAMPAIGN_BODY.replace(/## Budget\n\nSomething true about it\.\n/, "## Budget\n\n-\n"),
    });
    expect(reasons(check({ [CAMPAIGN]: noBudget }))).toEqual(["content_section_empty"]);
  });

  it("refuses a template marker left in the header or in the body", () => {
    const block = `  type: article\n  channel: "<where it is published>"\n  positioning_blob: ${BLOB}\n${GOAL}`;
    const result = check({ [ARTICLE]: article({ block }) });
    expect(result.problems.map((problem) => problem.code)).toEqual([
      ErrorCode.DOC_PLACEHOLDER_LEFT,
    ]);
    const body = article({ body: "## Text\n\n<what the reader does>\n\n## Sources\n\nNone.\n" });
    expect(check({ [ARTICLE]: body }).problems.map((problem) => problem.code)).toEqual([
      ErrorCode.DOC_PLACEHOLDER_LEFT,
    ]);
  });
});

describe("docs check: what a content cites", () => {
  const references = (entries: string) =>
    article({
      block: `  type: article\n  channel: "blog"\n  positioning_blob: ${BLOB}\n${GOAL}  references:\n${entries}`,
    });
  const untrusted = `    - claim: "Most people take 3 minutes"
      source: "https://example.org/report"
      as_of: 2026-10-01
      provenance: untrusted
`;

  it("accepts a figure cited with its source, its date and its provenance", () => {
    const base = `    - claim: "It syncs"
      source: kb-index
      provenance: knowledge_base
`;
    const result = check({ [ARTICLE]: references(untrusted + base) });
    expect(result.problems).toEqual([]);
  });

  it("accepts a figure stated by the creator, dated", () => {
    const stated = untrusted.replace("untrusted", "creator");
    expect(check({ [ARTICLE]: references(stated) }).problems).toEqual([]);
  });

  it("refuses a reference without its source, its provenance or its date", () => {
    const cases = [
      ["source", untrusted.replace(/ {6}source:.*\n/, "")],
      ["provenance", untrusted.replace("untrusted", "verified")],
      ["as_of", untrusted.replace(/ {6}as_of:.*\n/, "")],
      ["as_of", untrusted.replace("2026-10-01", "2026-12-24")],
      ["claim", untrusted.replace(/claim: ".*"/, 'claim: ""')],
    ] as const;
    for (const [field, entries] of cases) {
      const result = check({ [ARTICLE]: references(entries) }, []);
      expect(
        launchProblems(result).map((problem) => problem.details.field),
        field,
      ).toEqual([`content.references.0.${field}`]);
      expect(reasons(result)).toEqual(["content_reference"]);
    }
  });

  it("refuses a source of the base that is not a document the content links to", () => {
    const base = `    - claim: "It syncs"
      source: kb-other
      provenance: knowledge_base
`;
    expect(reasons(check({ [ARTICLE]: references(base) }))).toEqual(["content_reference"]);
  });

  it("refuses references that are not a list", () => {
    expect(reasons(check({ [ARTICLE]: references("    claim: x\n") }))).toEqual([
      "content_reference",
    ]);
  });

  const withText = (text: string, entries = "") =>
    entries === ""
      ? article({ body: `## Text\n\n${text}\n\n## Sources\n\nNone.\n` })
      : references(entries).replace(ARTICLE_BODY, `## Text\n\n${text}\n\n## Sources\n\nNone.\n`);

  it("warns about each figure of an article that no reference names", () => {
    const text = "Nine out of ten, 90% of users, save 20 € a month.";
    const result = check({ [ARTICLE]: withText(text) });
    expect(warningReasons(result)).toEqual(["launch_content_figure_unsourced"]);
    expect(result.warnings[0]?.details).toMatchObject({ count: 3 });
    // Cited by claims that name the same numbers and words: no warning.
    const claims = `    - claim: "90% of users, nine out of ten, save 20 € a month"
      source: "https://example.org/report"
      as_of: 2026-10-01
      provenance: untrusted
`;
    expect(warningReasons(check({ [ARTICLE]: withText(text, claims) }))).toEqual([]);
  });

  it("does not let an unrelated reference silence the warning", () => {
    expect(
      warningReasons(check({ [ARTICLE]: withText("90% of users love it.", untrusted) })),
    ).toEqual(["launch_content_figure_unsourced"]);
  });

  it("sees the figures written in words, in currency codes and as multipliers", () => {
    for (const text of [
      "It is 3x faster.",
      "Used by 2 000 teams.",
      "Only 5 euros.",
      "Priced at 5 dollars.",
      "USD 50 a month.",
      "Over 50 percent of them.",
      "50 pour cent des gens.",
      "Saved 10k hours.",
      "1,5 M€ raised.",
      "A 3,5 % rise.",
      "Nine sur dix l'adorent.",
    ]) {
      const warned = warningReasons(check({ [ARTICLE]: withText(text) }));
      expect(warned, text).toEqual(["launch_content_figure_unsourced"]);
    }
  });

  it("leaves years, dates and code alone", () => {
    for (const text of [
      "Since 2026, version 3.2 of the tool.",
      "On 12/10 we met.",
      "Run `echo $5` to see.",
      "```\nprice=$5\n```",
    ]) {
      expect(warningReasons(check({ [ARTICLE]: withText(text) })), text).toEqual([]);
    }
  });

  it("scans a long text of numbers without freezing", () => {
    const text = "1 ".repeat(40_000);
    const started = Date.now();
    check({ [ARTICLE]: withText(text) });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("does not warn about a campaign budget: it is the creator's figure", () => {
    const budget = CAMPAIGN_BODY.replace(
      /## Budget\n\nSomething true about it\./,
      "## Budget\n\n200 € for the whole campaign.",
    );
    expect(warningReasons(check({ [CAMPAIGN]: campaign({ body: budget }) }))).toEqual([]);
  });

  it("holds as verified only a page of the base: not the positioning, the content or a page of the site", () => {
    for (const source of ["positioning", "content-first"]) {
      const entry = `    - claim: "It syncs"
      source: ${source}
      provenance: knowledge_base
`;
      const links = `[positioning, kb-index, ${source}]`;
      const text = references(entry).replace("links: [positioning, kb-index]", `links: ${links}`);
      expect(reasons(check({ [ARTICLE]: text })), source).toEqual(["content_reference"]);
    }
  });

  it("refuses a reference with a template marker in its source, once as a reference", () => {
    const entry = untrusted.replace("https://example.org/report", "<the source of the report>");
    expect(reasons(check({ [ARTICLE]: references(entry) }))).toEqual(["content_reference"]);
  });

  it("accepts a reference dated today in a time zone ahead of UTC", () => {
    const entry = untrusted.replace("2026-10-01", "2026-10-05");
    expect(check({ [ARTICLE]: references(entry) }, []).problems).toEqual([]);
  });
});

describe("docs check: the header of a content carries no state", () => {
  it("refuses a status, a cost or any unknown key in the block, the goal and a reference", () => {
    const block = `  type: article\n  channel: "blog"\n  status: published\n  cost: 20\n  positioning_blob: ${BLOB}\n${GOAL}`;
    const result = check({ [ARTICLE]: article({ block }) });
    expect(launchProblems(result).map((problem) => problem.details.field)).toEqual([
      "content.status",
      "content.cost",
    ]);
    expect(reasons(result)).toEqual(["content_key", "content_key"]);
    const goal = GOAL.replace("target: 500", "target: 500\n    progress: 40");
    const withGoal = article({
      block: `  type: article\n  channel: "blog"\n  positioning_blob: ${BLOB}\n${goal}`,
    });
    expect(launchProblems(check({ [ARTICLE]: withGoal }))[0]?.details.field).toBe(
      "content.goal.progress",
    );
    const entry = `    - claim: "x"\n      source: "https://example.org"\n      as_of: 2026-10-01\n      provenance: untrusted\n      verified: true\n`;
    const withRef = article({
      block: `  type: article\n  channel: "blog"\n  positioning_blob: ${BLOB}\n${GOAL}  references:\n${entry}`,
    });
    expect(launchProblems(check({ [ARTICLE]: withRef }))[0]?.details.field).toBe(
      "content.references.0.verified",
    );
  });
});

describe("docs check: a section with nothing in it", () => {
  it("refuses a section of a heading alone, an empty table, an empty bullet or a dot", () => {
    for (const filler of [
      "### Headline\n",
      "| Date | Step |\n| --- | --- |\n| | |\n",
      "- [ ]\n1.\n",
      ".\n",
      "&nbsp;\n",
      "\u200E\u00AD\n",
      "```\n```\n",
    ]) {
      const body = `## Text\n\n${filler}\n## Sources\n\nNone.\n`;
      const emptied = launchProblems(check({ [ARTICLE]: article({ body }) }));
      // A code fence is text, the rest is nothing.
      if (filler.startsWith("```")) continue;
      expect(
        emptied.map((problem) => problem.details.reason),
        JSON.stringify(filler),
      ).toEqual(["content_section_empty"]);
    }
  });

  it("keeps a section that has a text under its heading or a filled table", () => {
    const body =
      "## Text\n\n### Headline\n\nA real sentence.\n\n## Sources\n\n| a | b |\n| - | - |\n| x | y |\n";
    expect(check({ [ARTICLE]: article({ body }) }).problems).toEqual([]);
  });
});

describe("docs check: contents and the validated positioning", () => {
  const approved = (blob: string) =>
    answered(
      "G-1",
      "approved",
      new Date(Date.UTC(2026, 9, 3, 2)).toISOString(),
      [[POSITIONING_PATH, blob]],
      {
        type: "publication",
        opened_by: "julien",
      },
    );

  it("warns that a content builds on a positioning that is a draft", () => {
    const result = check({ [ARTICLE]: article() }, []);
    expect(warningReasons(result)).toEqual(["launch_positioning_not_validated"]);
  });

  it("does not warn when the positioning is validated for the version it holds", () => {
    const result = checkDocumentsDetailed({
      current: [
        { path: ".agentplugged/docs/index.md", text: KB },
        { path: POSITIONING_PATH, text: POSITIONING },
        { path: ARTICLE, text: article() },
      ],
      owners: new Set(["julien", "zoe"]),
      validations: { checkpoints: [approved(BLOB)], now: NOW },
    });
    expect(result.warnings).toEqual([]);
    expect(result.problems).toEqual([]);
  });

  it("warns when the positioning changed since the content was written, and since the approval", () => {
    const edited = `${POSITIONING}\nA new sentence.\n`;
    const result = checkDocumentsDetailed({
      current: [
        { path: ".agentplugged/docs/index.md", text: KB },
        { path: POSITIONING_PATH, text: edited },
        { path: ARTICLE, text: article() },
      ],
      owners: new Set(["julien", "zoe"]),
      validations: { checkpoints: [approved(BLOB)], now: NOW },
    });
    expect(warningReasons(result).sort()).toEqual([
      "launch_content_positioning_outdated",
      "launch_positioning_not_validated",
    ]);
    expect(result.problems).toEqual([]);
  });

  it("warns that the content is outdated even where checkpoints are not read", () => {
    const edited = `${POSITIONING}\nA new sentence.\n`;
    const result = check({ [POSITIONING_PATH]: edited, [ARTICLE]: article() });
    expect(warningReasons(result)).toEqual(["launch_content_positioning_outdated"]);
  });

  it("leaves the visuals and the search plan alone", () => {
    const plain =
      "---\nid: visual-brief\nkind: note\nowner: julien\nlinks: []\n---\n# Brief\n\nText.\n";
    const search = plain.replace("visual-brief", "search-plan");
    const result = check({
      ".agentplugged/docs/launch/visuals/brief.md": plain,
      ".agentplugged/docs/launch/search/plan.md": search,
    });
    expect(result.problems).toEqual([]);
  });
});
