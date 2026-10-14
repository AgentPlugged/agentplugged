import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  checkDocuments,
  checkDocumentsDetailed,
  knowledgePages,
  mergedStoriesOf,
  staleKnowledgeStories,
} from "../index.js";

/** A page of the knowledge base behind a merged story that changed its code. */

const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const PAGE = ".agentplugged/docs/reference/billing.md";
const OWNERS = new Set(["zoe", "maya"]);

const page = (header: string) => ({
  path: PAGE,
  text: `---\nid: kb-billing\nkind: note\nowner: zoe\n${header}---\n# Billing\n`,
});

const merges = [
  { story: "4-1", seq: 1, files: ["src/billing/invoice.ts", "README.md"] },
  { story: "4-2", seq: 2, files: ["src/profile.ts"] },
  { story: "4-3", seq: 3, files: ["SRC/Billing/tax.ts"] },
];

describe("knowledge base behind a merged story", () => {
  it("reads the merged stories of the projection, by rank", () => {
    expect(
      mergedStoriesOf({
        stories: {
          "4-2": { merged: { seq: 2, files: ["b"] } },
          "4-1": { merged: { seq: 1, files: ["a"] } },
          "4-5": { status: "in_progress" },
        },
      }),
    ).toEqual([
      { story: "4-1", seq: 1, files: ["a"] },
      { story: "4-2", seq: 2, files: ["b"] },
    ]);
  });

  it("finds the stories merged after the page's last one that changed its code", () => {
    const pages = knowledgePages([page("code: [src/billing/]\n")]);
    expect(pages[0]?.code).toEqual(["src/billing/"]);
    expect(staleKnowledgeStories(pages, merges)).toEqual([
      { page: PAGE, story: "4-1", files: ["src/billing/invoice.ts"] },
      { page: PAGE, story: "4-3", files: ["SRC/Billing/tax.ts"] },
    ]);
    const taken = knowledgePages([page("code: [src/billing/]\nlast_story: 4-1\n")]);
    expect(staleKnowledgeStories(taken, merges).map((entry) => entry.story)).toEqual(["4-3"]);
    const current = knowledgePages([page("code: [src/billing/]\nlast_story: 4-3\n")]);
    expect(staleKnowledgeStories(current, merges)).toEqual([]);
  });

  it("takes a merge with more files than recorded as touching every page with code", () => {
    const pages = knowledgePages([page("code: [docs/api/]\nlast_story: 4-3\n")]);
    const big = [...merges, { story: "4-4", seq: 4, files: ["a.ts"], truncated: true }];
    expect(staleKnowledgeStories(pages, big)).toEqual([{ page: PAGE, story: "4-4", files: [] }]);
  });

  it("matches a file exactly, a folder by its prefix, and never a page without code", () => {
    const file = knowledgePages([page("code: [README.md]\n")]);
    expect(staleKnowledgeStories(file, merges).map((entry) => entry.story)).toEqual(["4-1"]);
    const prefix = knowledgePages([page("code: [src/bill]\n")]);
    expect(staleKnowledgeStories(prefix, merges)).toEqual([]);
    expect(staleKnowledgeStories(knowledgePages([page("")]), merges)).toEqual([]);
  });

  it("warns in docs check, and refuses a malformed code or last story", () => {
    const checked = checkDocumentsDetailed({
      current: [page("code: [src/billing/]\nlast_story: 4-1\n")],
      owners: OWNERS,
      validations: { checkpoints: [], now: NOW, merges },
    });
    expect(checked.problems).toEqual([]);
    expect(checked.warnings).toEqual([
      {
        reason: "kb_story",
        message_key: "docs.check.warning.kb_story",
        details: { path: PAGE, story: "4-3", files: "SRC/Billing/tax.ts" },
      },
    ]);
    const refused = checkDocuments({
      current: [page("code: [../outside, ok/]\nlast_story: four\n")],
      owners: OWNERS,
    });
    expect(refused.map((problem) => [problem.code, problem.details.field])).toEqual([
      [ErrorCode.DOC_HEADER_INVALID, "code.0"],
      [ErrorCode.DOC_HEADER_INVALID, "last_story"],
    ]);
  });
});
