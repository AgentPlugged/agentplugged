import { describe, expect, it } from "vitest";
import {
  DOCUMENT_STATE_KEYS,
  DocumentHeaderSchema,
  EPIC_DOCUMENT_ID_PATTERN,
  EpicHeaderSchema,
  ErrorCode,
  ErrorPayloadSchema,
  epicIdOf,
  ISSUE,
  REQUIREMENT_ID_PATTERN,
  STORY_DOCUMENT_ID_PATTERN,
  STORY_SECTIONS,
  StoryHeaderSchema,
} from "./index.js";

const header = { id: "prd", kind: "prd", owner: "iris", links: ["brief", "EF-1"] };

function issues(value: unknown) {
  const result = DocumentHeaderSchema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => [issue.path.join("."), issue.message]);
}

describe("DocumentHeaderSchema", () => {
  it("accepts a complete header, and other keys", () => {
    expect(DocumentHeaderSchema.parse({ ...header, title: "PRD", contract: { a: 1 } })).toEqual({
      ...header,
      title: "PRD",
      contract: { a: 1 },
    });
  });

  it("defaults links to an empty list", () => {
    expect(DocumentHeaderSchema.parse({ id: "n-1", kind: "note", owner: "creator" }).links).toEqual(
      [],
    );
  });

  it.each(DOCUMENT_STATE_KEYS)("refuses the state key %s, whatever its value", (key) => {
    expect(issues({ ...header, [key]: "done" })).toEqual([[key, ISSUE.docStateKey]]);
    expect(issues({ ...header, [key]: null })).toEqual([[key, ISSUE.docStateKey]]);
  });

  it("reports every field at fault", () => {
    expect(
      issues({ id: "PRD", kind: "plan", owner: "Iris", links: ["ef-1x", "x y"], status: 1 }),
    ).toEqual([
      ["id", ISSUE.docId],
      ["kind", ISSUE.docKind],
      ["owner", ISSUE.idFormat],
      ["links.1", ISSUE.docLink],
      ["status", ISSUE.docStateKey],
    ]);
  });

  it("requires id, kind and owner", () => {
    expect(issues({}).map(([path]) => path)).toEqual(["id", "kind", "owner"]);
  });
});

describe("REQUIREMENT_ID_PATTERN", () => {
  it.each(["EF-1", "ENF-12", "PU-3", "MS-40", "AD-7"])("accepts %s", (id) => {
    expect(REQUIREMENT_ID_PATTERN.test(id)).toBe(true);
  });

  it.each(["EF-0", "EF-01", "ef-1", "XX-1", "EF-1a", "EF1"])("refuses %s", (id) => {
    expect(REQUIREMENT_ID_PATTERN.test(id)).toBe(false);
  });
});

describe("docs check error codes", () => {
  it("are valid error payload codes", () => {
    for (const code of [
      ErrorCode.DOC_HEADER_INVALID,
      ErrorCode.DOC_ID_DUPLICATE,
      ErrorCode.REQ_ID_DUPLICATE,
      ErrorCode.REQ_ID_REMOVED,
      ErrorCode.REQ_ID_REUSED,
      ErrorCode.REQ_ID_RENUMBERED,
      ErrorCode.REQ_NOT_COVERED,
      ErrorCode.STORY_SECTION_INVALID,
      ErrorCode.STORY_DEPENDENCY_FORWARD,
      ErrorCode.STORY_DEPENDENCY_CYCLE,
      ErrorCode.STORY_INTENT_CHANGED,
      ErrorCode.DOC_PLACEHOLDER_LEFT,
    ]) {
      expect(ErrorPayloadSchema.parse({ code, message_key: "k", details: {} }).code).toBe(code);
    }
  });
});

describe("StoryHeaderSchema", () => {
  const story = {
    id: "2-6",
    kind: "story",
    owner: "sam",
    title: "Sign in with a passkey",
    epic: "epic-2",
    reviewer: "quentin",
    requirements: ["EF-1"],
    budget_usd: 12.5,
    branch: "feat/2-6-passkey",
  };

  function storyIssues(value: unknown) {
    const result = StoryHeaderSchema.safeParse(value);
    if (result.success) return [];
    return result.error.issues.map((issue) => [issue.path.join("."), issue.message]);
  }

  it("accepts the contract, depends_on empty by default", () => {
    expect(StoryHeaderSchema.parse(story)).toEqual({ ...story, links: [], depends_on: [] });
  });

  it("refuses a status like any document", () => {
    expect(storyIssues({ ...story, status: "done" })).toEqual([["status", ISSUE.docStateKey]]);
  });

  it.each([
    ["id", "2-06", ISSUE.storyId],
    ["id", "1-0", ISSUE.storyId],
    ["id", "0-1", ISSUE.storyId],
    ["id", "story-1", ISSUE.storyId],
    ["epic", "epic-1", ISSUE.storyEpic],
    ["requirements", [], ISSUE.storyRequirements],
    ["budget_usd", 0, ISSUE.budget],
    ["budget_usd", "12", ISSUE.budget],
    ["branch", "feat/a..b", ISSUE.branchName],
    ["title", "two\nlines", ISSUE.oneLine],
  ])("refuses %s: %j", (field, value, message) => {
    expect(storyIssues({ ...story, [field]: value })).toContainEqual([field, message]);
  });

  it("names every missing field", () => {
    expect(storyIssues({ id: "1-1", kind: "story", owner: "sam" }).map(([field]) => field)).toEqual(
      ["title", "epic", "reviewer", "requirements", "budget_usd", "branch"],
    );
  });

  it("refuses a requirement or a dependency of the wrong form", () => {
    expect(storyIssues({ ...story, requirements: ["EF-01"], depends_on: ["x"] })).toEqual([
      ["requirements.0", ISSUE.requirementId],
      ["depends_on.0", ISSUE.storyId],
    ]);
  });

  it("gives the epic of a story id", () => {
    expect(epicIdOf("12-3")).toBe("epic-12");
    expect(EPIC_DOCUMENT_ID_PATTERN.test("epic-12")).toBe(true);
    expect(STORY_DOCUMENT_ID_PATTERN.test("12-3")).toBe(true);
    expect(EPIC_DOCUMENT_ID_PATTERN.test("epic-0")).toBe(false);
  });
});

describe("EpicHeaderSchema", () => {
  it("defaults out_of_scope to an empty list, and takes requirement ids", () => {
    const epic = { id: "epic-1", kind: "epic", owner: "izzy" };
    expect(EpicHeaderSchema.parse(epic).out_of_scope).toEqual([]);
    for (const id of ["e-1", "epic-0", "epic-01"]) {
      expect(EpicHeaderSchema.safeParse({ ...epic, id }).error?.issues[0]?.message).toBe(
        ISSUE.epicId,
      );
    }
    expect(EpicHeaderSchema.safeParse({ ...epic, out_of_scope: ["EF-2"] }).success).toBe(true);
    expect(EpicHeaderSchema.safeParse({ ...epic, out_of_scope: ["two"] }).success).toBe(false);
  });

  it("names the four story sections", () => {
    expect(Object.keys(STORY_SECTIONS)).toEqual([
      "context",
      "intent",
      "acceptance_criteria",
      "out_of_scope",
    ]);
  });
});
