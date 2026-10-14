import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import {
  AgentPluggedError,
  type Deviation,
  readDefinitions,
  renderConstitutionReference,
  type TraceDetail,
  type TraceOverview,
} from "@agentplugged/core";
import { createTranslator } from "@agentplugged/i18n";
import { ErrorCode, type SkillFrontmatter } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { errorMessage } from "./error-text.js";
import { formatTrace, traceJson } from "./trace-text.js";

const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);
const read = (path: string) => readFileSync(join(methodDir, path), "utf8").replace(/\r\n/g, "\n");
const flat = (text: string) => text.replace(/\s+/g, " ");

const deviation: Deviation = {
  id: "V-7M2K9QX4TB",
  story: "1-1",
  requirements: ["EF-1"],
  summary: "No lockout \u001b[31mafter five attempts",
  detail: null,
  pr: 7,
  commit: null,
  status: "open",
  reported_by: "checker",
  reported_at: "2026-10-06T09:00:00.000Z",
  event: "01JZ8Q3N4V7M2K9QX4TB",
  resolved: null,
};

const overview: TraceOverview = {
  action: "overview",
  requirements: [
    {
      id: "EF-1",
      text: "The visitor signs in.",
      status: "deviation",
      stories: ["1-1", "1-2"],
      tests: 2,
      pull_requests: 1,
      deviations: 1,
    },
    {
      id: "ENF-1",
      text: "Fast.",
      status: "todo",
      stories: [],
      tests: 0,
      pull_requests: 0,
      deviations: 0,
    },
  ],
  counts: { todo: 1, in_development: 0, in_review: 0, delivered: 0, deviation: 1 },
  deviations: [deviation],
  tests: { status: "read", references: 2 },
};

const detail: TraceDetail = {
  action: "requirement",
  requirement: {
    id: "EF-1",
    text: "The visitor signs in.",
    path: ".agentplugged/docs/prd.md",
    line: 8,
    retired: false,
    status: "deviation",
    stories: [
      { id: "1-1", title: "Sign in", path: ".agentplugged/stories/1-1.md", status: "in_progress" },
      { id: "1-2", title: null, path: ".agentplugged/stories/1-2.md", status: "todo" },
    ],
    tests: [{ path: "tests/login_test.py", line: 4 }],
    pull_requests: [
      { story: "1-1", forge: "github", number: 7, url: "https://github.com/acme/shop/pull/7" },
    ],
    deviations: [
      deviation,
      {
        ...deviation,
        id: "V-0000000001",
        pr: null,
        status: "resolved",
        resolved: {
          reason: "Fixed in abc.",
          by: "checker",
          at: "2026-10-06T10:00:00.000Z",
          event: "E",
        },
      },
    ],
  },
  tests: { status: "read", references: 1 },
};

describe("trace: text", () => {
  it("shows every requirement with its status and links, in French with « tu »", () => {
    const text = formatTrace(createTranslator("fr"), overview);
    expect(text).toMatch(
      /^Exigences : 2\nEF-1 {2}en écart {2}The visitor signs in\.\n {4}stories : 1-1, 1-2 · tests : 2 · pull requests : 1 · écarts ouverts : 1\nENF-1 {2}à faire {2}Fast\.\n {4}stories : aucune · tests : 0 · pull requests : 0 · écarts ouverts : 0\nÀ faire : 1 · en développement : 0 · en revue : 0 · livrées : 0 · en écart : 1\nÉcarts ouverts : 1\nV-7M2K9QX4TB {2}story 1-1, pull request #7 · EF-1 : No lockout \[31mafter five attempts\n {4}signalé le .+ par checker\n/,
    );
    expect(text).not.toContain("\u001b");
    // No command for the creator to type to lift a deviation.
    expect(text).not.toContain("npx agentplugged trace resolve");
    expect(text.endsWith("Le détail d'une exigence : npx agentplugged trace <EF-n>\n")).toBe(true);
    const english = formatTrace(createTranslator("en"), {
      ...overview,
      requirements: overview.requirements.map((requirement) => ({ ...requirement, tests: null })),
      deviations: [],
      tests: { status: "unavailable", references: 0 },
    });
    expect(english).toContain("EF-1  deviation  The visitor signs in.\n");
    expect(english).toContain("stories: 1-1, 1-2 · tests: ? · pull requests: 1");
    expect(english).toContain("Tests not read here (no Git repository, or Git failed)");
  });

  it("shows one requirement with its stories, tests, pull requests and deviations", () => {
    const text = formatTrace(createTranslator("en"), detail);
    expect(text).toContain(
      "EF-1 — deviation\n    The visitor signs in.\nDefined in .agentplugged/docs/prd.md:8\nStories: 2\n  1-1  in development  Sign in\n  1-2  not started\nTests: 1\n  tests/login_test.py:4\nPull requests: 1\n  #7  story 1-1  https://github.com/acme/shop/pull/7\nDeviations: 2\n",
    );
    expect(text).toContain("    open\n");
    expect(text).toMatch(/ {4}resolved on .+ by checker: Fixed in abc\.\n {4}resolved\n/);
    const empty = formatTrace(createTranslator("fr"), {
      ...detail,
      requirement: {
        ...detail.requirement,
        retired: true,
        status: "todo",
        stories: [],
        tests: [],
        pull_requests: [],
        deviations: [],
      },
    });
    expect(empty).toContain("EF-1 — à faire (retirée)\n");
    expect(empty).toContain("Stories : aucune ne la cite.\n");
    expect(empty).toContain("Tests : aucun ne la cite");
    expect(empty).toContain("Pull requests : aucune.\nÉcarts : aucun.\n");
    expect(
      formatTrace(createTranslator("en"), {
        action: "resolve",
        deviation: "V-7M2K9QX4TB",
        story: "1-1",
        summary: "Gap",
        event: { id: "E", at: "2026-10-06T10:00:00.000Z" },
      }),
    ).toBe("V-7M2K9QX4TB lifted: “Gap” (story 1-1).\n");
    expect(JSON.parse(traceJson(detail))).toEqual(detail);
  });

  it("renders the errors in both languages, without control characters", () => {
    const en = createTranslator("en");
    const notLinked = new AgentPluggedError(
      ErrorCode.DEVIATION_NOT_REPORTABLE,
      "error.deviation_not_reportable.not_linked",
      { story: "1-1", reason: "not_linked", requirement: "EF-9" },
    );
    expect(errorMessage(en, notLinked)).toBe(
      "Story 1-1 does not cite EF-9 in its requirements: report a deviation only from a requirement the story cites. Nothing was written.",
    );
    const allowed = new AgentPluggedError(
      ErrorCode.DEVIATION_NOT_ALLOWED,
      "error.deviation_not_allowed",
      { deviation: "V-1", agent: "x\u001b[2J", reported_by: "checker" },
    );
    expect(errorMessage(createTranslator("fr"), allowed)).not.toContain("\u001b");
    const merge = new AgentPluggedError(ErrorCode.MERGE_NOT_READY, "error.merge_not_ready", {
      checkpoint: "G-1",
      story: "1-1",
      ci: "pass",
      review: false,
      deviations: 2,
    });
    expect(errorMessage(en, merge)).toContain("no open deviation (now: 2)");
  });
});

describe("trace: method", () => {
  it("ships check-requirements, tied to the quality reviewer", async () => {
    const skills = await readDefinitions(new NodeWorkspaceFiles(methodDir), "skills", "skill");
    if (!Array.isArray(skills)) throw new Error("invalid shipped skills");
    const skill = skills.find((definition) => definition.name === "check-requirements");
    if (skill === undefined) throw new Error("check-requirements is not shipped");
    const metadata = (skill.frontmatter as SkillFrontmatter).metadata;
    expect(metadata).toEqual({ agent: "quentin", phase: "build" });
    const text = flat(read("skills/check-requirements/SKILL.md"));
    for (const expected of [
      "`story.deviation`",
      "`story.lift_deviation`",
      "`state.trace`",
      "`not_linked`",
      "at the latest before the merge",
      "`EF_18`",
    ]) {
      expect(text, expected).toContain(expected);
    }
    expect(flat(read("README.md"))).toContain("| `check-requirements` | Quentin (`DR`) | build |");
    expect(flat(read("README.md"))).toContain("npx agentplugged trace resolve <V-id>");
    expect(flat(read("skills/develop-story/SKILL.md"))).toContain(
      "cite the requirement it proves (`EF-18`",
    );
  });

  it("tells every agent the test convention and the deviations, and denies trace resolve", () => {
    const constitution = flat(renderConstitutionReference());
    for (const expected of [
      "15. Every requirement is traced",
      "`EF_18` where a name takes no dash",
      "`story.deviation`",
      "`story.lift_deviation`",
      "keeps its merge closed",
      "(`trace resolve`)",
    ]) {
      expect(constitution, expected).toContain(expected);
    }
  });
});
