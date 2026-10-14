import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  cursorDenyRules,
  denyRules,
  renderConstitutionReference,
  type StoryPullRequestResult,
} from "@agentplugged/core";
import { createTranslator } from "@agentplugged/i18n";
import { describe, expect, it } from "vitest";
import { errorMessage } from "./error-text.js";
import { formatStoryPullRequest } from "./story-text.js";

const fr = createTranslator("fr");
const en = createTranslator("en");
const flat = (text: string) => text.replace(/\s+/g, " ");
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);
const read = (path: string) => readFileSync(join(methodDir, path), "utf8").replace(/\r\n/g, "\n");

const OPENED: StoryPullRequestResult = {
  status: "opened",
  story: "1-1",
  forge: "github",
  number: 12,
  url: "https://github.com/ada/shop/pull/12",
  branch: "feat/1-1-sign-up",
  base: "main",
  head: "0123456789abcdef0123456789abcdef01234567",
  title: "Sign up (1-1)",
  criteria: { checked: 1, total: 2 },
  tests: "passed",
  event: { id: "01JZ0000000000000000000000", type: "story.pr_opened", at: "2026-10-03T12:00:00Z" },
};

describe("story pr's text", () => {
  it("says the pull request, the branch pushed, the criteria and the tests, never a cost", () => {
    expect(formatStoryPullRequest(fr, OPENED)).toBe(
      [
        "Pull request ouverte pour la story 1-1 : https://github.com/ada/shop/pull/12",
        "  Branche feat/1-1-sign-up poussée, vers main (0123456).",
        "  Critères d'acceptation cochés : 1 sur 2.",
        "  Tests : passés.",
        "",
      ].join("\n"),
    );
    const unchanged = formatStoryPullRequest(en, {
      ...OPENED,
      status: "unchanged",
      tests: "not_reported",
    });
    expect(unchanged).toContain("Pull request of story 1-1 already up to date");
    expect(unchanged).toContain("Tests: not reported by the agent.");
    expect(unchanged).not.toMatch(/cost|Cost|budget|Budget/);
  });

  it("says a pull request opened but not recorded exists, and to run it again", () => {
    expect(
      errorMessage(fr, {
        message_key: "error.pull_request_failed.not_recorded",
        details: {
          story: "1-1",
          reason: "not_recorded",
          url: "https://github.com/ada/shop/pull/12",
          message: "JOURNAL_BUSY",
        },
      }),
    ).toBe(
      "La pull request https://github.com/ada/shop/pull/12 existe, mais rien n'est inscrit (JOURNAL_BUSY) : relance la même commande.",
    );
  });

  it("explains how to link the forge, in the creator's words", () => {
    const error = {
      message_key: "error.forge_not_linked.not_logged_in",
      details: { story: "1-1", reason: "not_logged_in", cli: "glab", host: "gitlab.com" },
    };
    expect(errorMessage(fr, error)).toBe(
      "glab n'est pas connecté à gitlab.com : lance glab auth login --hostname gitlab.com dans ton terminal, puis relance. Rien n'a été poussé pour la story 1-1. `npx agentplugged doctor` montre la cause vérifiée par le moteur et la répare (un agent : state.environment, puis environment_fix).",
    );
    expect(
      errorMessage(en, {
        message_key: "error.pull_request_not_openable.criteria_count",
        details: { story: "1-1", reason: "criteria_count", expected: 2, given: 1 },
      }),
    ).toBe("Story 1-1 has 2 acceptance criteria: give one box for each (1 given).");
  });
});

describe("the method and the rules", () => {
  it("tells agents to deliver through story.pr, never gh or glab themselves", () => {
    const constitution = flat(renderConstitutionReference());
    expect(constitution).toContain("Deliver a story you built with `story.pr`");
    expect(constitution).toContain("`FORGE_NOT_LINKED`");
    expect(constitution).toContain("Never run `gh` or `glab` yourself");
    // The PR item of the developers' menu (their body no longer repeats it).
    for (const agent of ["sam", "ethan"]) {
      expect(flat(read(`agents/${agent}/agent.yaml`))).toContain("`story.pr`");
    }
    expect(flat(read("README.md"))).toContain("npx agentplugged story pr <id>");
  });

  it("denies the forge's token and the merge by hand; the rest is the constitution's", () => {
    const claude = denyRules({ rootAgentsGenerated: true, claudeMdGenerated: false });
    for (const rule of ["Bash(gh auth*)", "Bash(gh pr merge*)", "Bash(glab mr merge*)"]) {
      expect(claude).toContain(rule);
    }
    expect(claude).not.toContain("Bash(gh api*)");
    expect(cursorDenyRules({ rootAgentsGenerated: true, claudeMdGenerated: false })).toContain(
      "Shell(glab:auth*)",
    );
  });
});
