import { describe, expect, it } from "vitest";
import {
  DOCS_REQUIREMENT_MAX_CHARS,
  DOCS_REQUIREMENTS_MAX,
  DocsRequirementSchema,
} from "./docs-read.js";
import { FilesRequestSchema, FilesResponseReader, FilesResponseSchema } from "./repo-files.js";

const ID = "01J9ZQ4V8E3M5N7P9R1S3T5V7X";
const PRODUCT = "01J9ZQ4V8E3M5N7P9R1S3T5V80";
const AT = "2026-10-12T18:40:00.000Z";

const requirement = {
  id: "EF-12",
  text: "Send the reminders at 9 am, client time",
  path: ".agentplugged/docs/prd.md",
  retired: false,
  status: "deviation" as const,
  stories: ["2-3"],
  tests: 2,
  pull_requests: 1,
  deviations: 1,
};

const list = {
  op: "docs",
  documents: [
    {
      path: ".agentplugged/docs/prd.md",
      kind: "prd",
      id: "prd",
      title: "Requirements",
      owner: "maya",
      standing: "approved",
      requirements: 7,
    },
  ],
  truncated: false,
  requirements: [requirement],
  counts: { todo: 0, in_development: 0, in_review: 0, delivered: 0, deviation: 1 },
  tests: "read",
  deviations: [
    {
      id: "V-7M2K9QX4TB",
      story: "2-3",
      requirements: ["EF-12"],
      summary: "The code sends at 9 am UTC",
      reported_by: "dana",
      reported_at: AT,
    },
  ],
  epics: [
    {
      id: "epic-2",
      title: "Collect faster",
      out_of_scope: [],
      stories: [
        {
          id: "2-3",
          title: "Reminders",
          status: "in_review",
          depends_on: ["2-2"],
          requirements: ["EF-12"],
        },
      ],
    },
  ],
  coverage: { total: 7, covered: 6, out_of_scope: 0, uncovered: ["EF-99"] },
};

const ok = (data: unknown) => ({
  v: 1,
  id: ID,
  product: PRODUCT,
  ok: true,
  at: "worktree",
  read_at: 1,
  data,
});

describe("the requests to read the documents of a product", () => {
  const base = { v: 1, id: ID, product: PRODUCT };

  it("accepts each operation with its fields and nothing more", () => {
    for (const body of [{ op: "docs" }, { op: "trace", requirement: "EF-18" }, { op: "retros" }]) {
      expect(FilesRequestSchema.safeParse({ ...base, ...body }).success).toBe(true);
      expect(FilesRequestSchema.safeParse({ ...base, ...body, extra: 1 }).success).toBe(false);
    }
  });

  it("refuses anything but a traced requirement, and a path in a request", () => {
    for (const requirement of ["PU-1", "EF-0", "EF-1x", "ef-1", "../x", "EF-1 ", ""]) {
      expect(FilesRequestSchema.safeParse({ ...base, op: "trace", requirement }).success).toBe(
        false,
      );
    }
    expect(
      FilesRequestSchema.safeParse({ ...base, op: "docs", path: ".agentplugged" }).success,
    ).toBe(false);
    expect(FilesRequestSchema.safeParse({ ...base, op: "retros", scope: "epic" }).success).toBe(
      false,
    );
  });
});

describe("the answers about the documents", () => {
  it("reads the list, the trace of a requirement and the retrospectives", () => {
    const trace = {
      op: "trace",
      requirement: {
        id: "EF-12",
        text: "Send the reminders at 9 am",
        path: ".agentplugged/docs/prd.md",
        line: 14,
        retired: false,
        status: "deviation",
        stories: [{ id: "2-3", title: "Reminders", status: "in_review" }],
        tests: [{ path: "tests/reminders.test.ts", line: 12 }],
        pull_requests: [{ story: "2-3", number: 48 }],
        deviations: [
          {
            id: "V-7M2K9QX4TB",
            story: "2-3",
            requirements: ["EF-12"],
            summary: "The code sends at 9 am UTC",
            reported_by: "dana",
            reported_at: AT,
            status: "resolved",
            resolved: { reason: "Fixed in the last commit", by: "dana", at: AT },
          },
        ],
      },
      tests_state: "read",
    };
    const retros = {
      op: "retros",
      retrospectives: [
        {
          id: "R-7M2K9QX4TB",
          scope: { kind: "epic", id: "2" },
          at: AT,
          proposed_by: "izzy",
          status: "approved",
          summary: "What worked and what did not.",
          lessons: [
            {
              id: "L-7M2K9QX4TB-1",
              title: "Write the test first",
              text: "A failing test shows the gap early.",
              tags: ["tests"],
              agents: [],
              status: "active",
            },
          ],
          retire: [],
          actions: [{ id: "R-7M2K9QX4TB-A1", text: "Add a CI step", owner: "omar" }],
        },
      ],
      memory: [
        {
          id: "L-7M2K9QX4TB-1",
          title: "Write the test first",
          text: "A failing test shows the gap early.",
          tags: ["tests"],
          agents: [],
          at: AT,
          retro: "R-7M2K9QX4TB",
          promoted: false,
        },
      ],
      unreadable: 0,
    };
    for (const data of [list, trace, retros]) {
      const parsed = FilesResponseSchema.safeParse(ok(data));
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
  });

  it("bounds what a document can make large", () => {
    expect(
      DocsRequirementSchema.safeParse({
        ...requirement,
        text: "t".repeat(DOCS_REQUIREMENT_MAX_CHARS + 1),
      }).success,
    ).toBe(false);
    expect(
      FilesResponseSchema.safeParse(
        ok({ ...list, requirements: Array(DOCS_REQUIREMENTS_MAX + 1).fill(requirement) }),
      ).success,
    ).toBe(false);
    expect(DocsRequirementSchema.safeParse({ ...requirement, id: "AD-1" }).success).toBe(false);
    expect(DocsRequirementSchema.safeParse({ ...requirement, status: "done" }).success).toBe(false);
  });

  it("is read by a device while ignoring the fields it does not know, and still validating the ones it knows", () => {
    const withExtra = ok({
      ...list,
      generated_by: "later",
      documents: [{ ...list.documents[0], word_count: 900 }],
    });
    expect(FilesResponseSchema.safeParse(withExtra).success).toBe(false);
    const read = FilesResponseReader.safeParse(withExtra);
    expect(read.success).toBe(true);
    if (read.success && read.data.ok) {
      expect(JSON.stringify(read.data)).not.toContain("word_count");
      expect(JSON.stringify(read.data)).not.toContain("generated_by");
    }
    const broken = ok({ ...list, requirements: [{ ...requirement, status: "late" }] });
    expect(FilesResponseReader.safeParse(broken).success).toBe(false);
  });

  it("lets a newer bridge name a kind or a standing a device does not know", () => {
    const newer = ok({
      ...list,
      documents: [{ ...list.documents[0], kind: "roadmap", standing: "scheduled" }],
    });
    expect(FilesResponseReader.safeParse(newer).success).toBe(true);
  });
});
