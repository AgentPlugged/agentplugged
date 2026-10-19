import { describe, expect, it } from "vitest";
import {
  type DocumentsInputs,
  documentStanding,
  documentsList,
  requirementTrace,
  retrospectivesView,
} from "../index.js";

const NOW = Date.parse("2026-10-17T12:00:00Z");

const PRD = [
  "---",
  "id: prd",
  "kind: prd",
  "owner: maya",
  "title: Requirements",
  "---",
  "# PRD",
  "",
  "- EF-1: The visitor signs in with an email and a password.",
  "- EF-2: (retired) The visitor signs in with a magic link.",
  "- EF-3: The visitor resets the password.",
  "- EF-4: The visitor deletes the account.",
  "- ENF-1: A page answers in less than 300 ms.",
  "- PU-1: A journey, never traced.",
  "",
].join("\n");

const BRIEF = ["---", "id: brief", "kind: brief", "owner: iris", "---", "# Kalo", "", "Text."].join(
  "\n",
);

const EPIC = [
  "---",
  "id: epic-1",
  "kind: epic",
  "owner: sam",
  "out_of_scope: [ENF-1]",
  "title: Sign in",
  "---",
  "# Epic 1",
  "",
].join("\n");

function story(id: string, requirements: readonly string[], dependsOn: readonly string[] = []) {
  return [
    "---",
    `id: ${id}`,
    `title: Story ${id}`,
    "kind: story",
    "owner: builder",
    `epic: epic-${id.split("-")[0]}`,
    "reviewer: checker",
    `requirements: [${requirements.join(", ")}]`,
    `depends_on: [${dependsOn.join(", ")}]`,
    "budget_usd: 5",
    `branch: story/${id}`,
    "---",
    `# Story ${id}`,
    "",
  ].join("\n");
}

const files = [
  { path: ".agentplugged/docs/prd.md", text: PRD },
  { path: ".agentplugged/docs/brief.md", text: BRIEF },
  { path: ".agentplugged/docs/notes.md", text: "# Loose notes\n\nNo header here." },
  { path: ".agentplugged/epics/epic-1.md", text: EPIC },
  { path: ".agentplugged/stories/1-1.md", text: story("1-1", ["EF-1"]) },
  { path: ".agentplugged/stories/1-2.md", text: story("1-2", ["EF-3"], ["1-1"]) },
  { path: ".agentplugged/stories/1-3.md", text: story("1-3", ["EF-3"]) },
];

function checkpoint(
  id: string,
  type: string,
  path: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    type,
    status: "open",
    documents: [{ path, branch: "main", blob_sha: "a".repeat(40) }],
    opened_event: id,
    resolution: null,
    waived_ms: 0,
    ...extra,
  };
}

/** A state where 1-1 is delivered, 1-2 in review, 1-3 never started, and EF-3 has an open deviation. */
function state(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stories: {
      "1-1": { started: { at: "2026-10-10T10:00:00Z" }, merged: { at: "2026-10-11T10:00:00Z" } },
      "1-2": { status: "in_review", started: { at: "2026-10-12T10:00:00Z" } },
    },
    checkpoints: {},
    deviations: {
      "V-7M2K9QX4TB": {
        id: "V-7M2K9QX4TB",
        story: "1-2",
        requirements: ["EF-3"],
        summary: "The reset link never expires",
        detail: null,
        pr: 12,
        commit: null,
        status: "open",
        reported_by: "checker",
        reported_at: "2026-10-13T10:00:00Z",
        event: "01J9ZQ4V8E3M5N7P9R1S3T5V7X",
        resolved: null,
      },
    },
    ...extra,
  };
}

function inputs(overrides: Partial<DocumentsInputs> = {}): DocumentsInputs {
  return {
    files,
    state: state(),
    references: [{ requirement: "EF-1", path: "tests/login.test.ts", line: 4 }],
    testsState: "read",
    now: NOW,
    ...overrides,
  };
}

describe("the documents of a product", () => {
  it("lists the documents in the method's order, the stories apart", () => {
    const view = documentsList(inputs());
    expect(view.documents.map((document) => document.path)).toEqual([
      ".agentplugged/docs/brief.md",
      ".agentplugged/docs/prd.md",
      ".agentplugged/docs/notes.md",
      ".agentplugged/epics/epic-1.md",
    ]);
    const prd = view.documents.find((document) => document.kind === "prd");
    expect(prd).toMatchObject({ title: "Requirements", owner: "maya", requirements: 5 });
  });

  it("takes the title of a document without a header from its first heading, and lists it unknown", () => {
    const notes = documentsList(inputs()).documents.find((d) => d.path.endsWith("notes.md"));
    expect(notes).toMatchObject({ kind: "unknown", title: "Loose notes", standing: "none" });
    expect(notes?.owner).toBeUndefined();
  });

  it("computes the status of each requirement from the stories and the deviations", () => {
    const view = documentsList(inputs());
    const byId = Object.fromEntries(view.requirements.map((entry) => [entry.id, entry]));
    expect(byId["EF-1"]).toMatchObject({ status: "delivered", stories: ["1-1"], tests: 1 });
    // A story in review and one never started: not delivered, not yet in review as a whole; and an
    // open deviation wins over everything.
    expect(byId["EF-3"]).toMatchObject({
      status: "deviation",
      stories: ["1-2", "1-3"],
      deviations: 1,
    });
    expect(byId["EF-4"]).toMatchObject({ status: "todo", stories: [] });
    expect(byId["EF-2"]).toMatchObject({ retired: true });
    expect(byId["PU-1"]).toBeUndefined();
    expect(view.counts).toEqual({
      todo: 2,
      in_development: 0,
      in_review: 0,
      delivered: 1,
      deviation: 1,
    });
  });

  it("does not count the tests when they could not be read", () => {
    const view = documentsList(inputs({ references: null, testsState: "unavailable" }));
    expect(view.tests).toBe("unavailable");
    expect(view.requirements.every((entry) => entry.tests === null)).toBe(true);
  });

  it("lists the open deviations with their cause", () => {
    const view = documentsList(inputs());
    expect(view.deviations).toEqual([
      expect.objectContaining({
        id: "V-7M2K9QX4TB",
        story: "1-2",
        summary: "The reset link never expires",
        reported_by: "checker",
      }),
    ]);
  });

  it("builds the breakdown and its coverage", () => {
    const view = documentsList(inputs());
    expect(view.epics).toHaveLength(1);
    expect(view.epics[0]).toMatchObject({
      id: "epic-1",
      title: "Sign in",
      out_of_scope: ["ENF-1"],
    });
    expect(
      view.epics[0]?.stories.map((entry) => [entry.id, entry.status, entry.depends_on]),
    ).toEqual([
      ["1-1", "done", []],
      ["1-2", "in_review", ["1-1"]],
      ["1-3", "todo", []],
    ]);
    // EF-1 and EF-3 are carried by a story, ENF-1 is left aside, EF-4 is nobody's.
    expect(view.coverage).toEqual({ total: 4, covered: 2, out_of_scope: 1, uncovered: ["EF-4"] });
  });

  it("tells no coverage while no story exists", () => {
    const view = documentsList(
      inputs({ files: files.filter((file) => !file.path.includes("stories")) }),
    );
    expect(view.coverage).toBeUndefined();
    expect(view.epics.map((epic) => epic.id)).toEqual(["epic-1"]);
  });

  it("traces one requirement from the stories to the pull requests and the deviations", () => {
    const trace = requirementTrace(
      inputs({
        state: state({
          stories: {
            "1-2": {
              status: "in_review",
              started: { at: "2026-10-12T10:00:00Z" },
              pull_request: { forge: "github", number: 12, url: "https://example.test/pull/12" },
            },
          },
        }),
      }),
      "EF-3",
    );
    expect(trace?.requirement).toMatchObject({
      id: "EF-3",
      status: "deviation",
      line: 11,
      stories: [
        { id: "1-2", title: "Story 1-2", status: "in_review" },
        { id: "1-3", title: "Story 1-3", status: "todo" },
      ],
      pull_requests: [{ story: "1-2", number: 12 }],
      deviations: [{ id: "V-7M2K9QX4TB", status: "open", reported_by: "checker" }],
    });
    // The address an agent wrote is never passed on.
    expect(JSON.stringify(trace)).not.toContain("example.test");
  });

  it("knows no requirement that no document defines", () => {
    expect(requirementTrace(inputs(), "EF-99")).toBeUndefined();
    expect(requirementTrace(inputs(), "PU-1")).toBeUndefined();
  });
});

describe("how a document stands with the creator's approval", () => {
  const path = ".agentplugged/docs/prd.md";
  const standing = (checkpoints: Record<string, unknown>) =>
    documentStanding(path, state({ checkpoints }), NOW);

  it("is none until a checkpoint lists it", () => {
    expect(standing({})).toBe("none");
    expect(standing({ "G-A": checkpoint("G-A", "document", ".agentplugged/docs/other.md") })).toBe(
      "none",
    );
  });

  it("follows the latest checkpoint that lists it", () => {
    expect(standing({ "G-A": checkpoint("G-A", "document", path) })).toBe("to_approve");
    const answered = (decision: string) =>
      checkpoint("G-B", "document", path, {
        status: "resolved",
        resolution: { decision, at: "2026-10-14T10:00:00Z", event: "E1" },
      });
    expect(standing({ "G-B": answered("approved") })).toBe("approved");
    expect(standing({ "G-B": answered("approved_with_reservations") })).toBe("approved");
    expect(standing({ "G-B": answered("changes_requested") })).toBe("changes_requested");
    expect(standing({ "G-B": answered("rejected") })).toBe("rejected");
    // A newer submission is judged on its own.
    expect(
      standing({ "G-B": answered("approved"), "G-C": checkpoint("G-C", "document", path) }),
    ).toBe("to_approve");
  });

  it("reads a path given with a folder before the method's, or with back slashes", () => {
    const listed = checkpoint("G-A", "document", "kalo\\.agentplugged\\docs\\prd.md");
    expect(standing({ "G-A": listed })).toBe("to_approve");
  });

  it("does not count a checkpoint of another type", () => {
    expect(standing({ "G-A": checkpoint("G-A", "story", path) })).toBe("none");
  });
});

describe("the retrospectives of a product", () => {
  const retro = (checkpointId: string, event: string) => ({
    id: `R-${event.slice(-10)}`,
    event,
    at: "2026-10-15T10:00:00Z",
    proposed_by: "izzy",
    checkpoint: checkpointId,
    scope: { kind: "epic", id: "1" },
    summary: "What worked.",
    lessons: [
      {
        id: `L-${event.slice(-10)}-1`,
        title: "Test first",
        text: "Write the test first.",
        tags: ["tests"],
        salt: "0".repeat(32),
      },
    ],
    retire: [],
    actions: [{ id: `R-${event.slice(-10)}-A1`, text: "Add a CI step", owner: "omar" }],
  });
  const memoryCheckpoint = (id: string, extra: Record<string, unknown> = {}) => ({
    ...checkpoint(id, "memory", ".agentplugged/docs/prd.md"),
    memory: { kind: "retrospective", scope: { kind: "epic", id: "1" } },
    documents: [],
    ...extra,
  });
  const EVENT = "01J9ZQ4V8E3M5N7P9R1S3T5V7X";
  const base = (checkpointExtra: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    checkpoints: { "G-RETRO": memoryCheckpoint("G-RETRO", checkpointExtra) },
    memory: { retros: { [`R-${EVENT.slice(-10)}`]: retro("G-RETRO", EVENT) } },
    ...extra,
  });

  it("tells a proposed retrospective, its lessons and its actions", () => {
    const view = retrospectivesView(base({}), NOW);
    expect(view.retrospectives).toHaveLength(1);
    expect(view.retrospectives[0]).toMatchObject({
      scope: { kind: "epic", id: "1" },
      status: "open",
      summary: "What worked.",
      lessons: [{ title: "Test first", status: "proposed", tags: ["tests"] }],
      actions: [{ text: "Add a CI step", owner: "omar" }],
    });
    expect(view.memory).toEqual([]);
  });

  it("puts the lessons of an approved and recorded retrospective in force", () => {
    const lessonId = `L-${EVENT.slice(-10)}-1`;
    const view = retrospectivesView(
      base(
        {
          status: "resolved",
          resolution: { decision: "approved", at: "2026-10-16T10:00:00Z", event: "E2" },
        },
        {
          lessons: {
            [lessonId]: {
              id: lessonId,
              retro: `R-${EVENT.slice(-10)}`,
              checkpoint: "G-RETRO",
              digest: "d".repeat(64),
              at: "2026-10-16T10:00:00Z",
              event: "E3",
              promoted: [{ common: "C-1", checkpoint: "G-2", at: "2026-10-17T10:00:00Z" }],
            },
          },
          lessons_log: [
            {
              event: "E3",
              at: "2026-10-16T10:00:00Z",
              checkpoint: "G-RETRO",
              retro: `R-${EVENT.slice(-10)}`,
              retired: [],
              excepted: [],
            },
          ],
        },
      ),
      NOW,
    );
    expect(view.retrospectives[0]).toMatchObject({
      status: "approved",
      lessons: [{ status: "active" }],
    });
    expect(view.memory).toEqual([
      expect.objectContaining({ title: "Test first", promoted: true, at: "2026-10-16T10:00:00Z" }),
    ]);
  });

  it("does not keep the lessons of a retrospective the creator did not approve", () => {
    const view = retrospectivesView(
      base({
        status: "resolved",
        resolution: { decision: "changes_requested", at: "2026-10-16T10:00:00Z", event: "E2" },
      }),
      NOW,
    );
    expect(view.retrospectives[0]).toMatchObject({
      status: "changes_requested",
      lessons: [{ status: "not_kept" }],
    });
  });

  it("counts the retrospectives it cannot read instead of guessing them", () => {
    const view = retrospectivesView(
      { checkpoints: { "G-RETRO": memoryCheckpoint("G-RETRO") } },
      NOW,
    );
    expect(view).toEqual({ retrospectives: [], memory: [], unreadable: 1 });
  });
});
