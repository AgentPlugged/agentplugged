import { describe, expect, it } from "vitest";
import { FIND_HITS_MAX, FIND_QUERY_MAX_CHARS, FindDataSchema } from "./find-read.js";
import { FilesRequestSchema, FilesResponseReader, FilesResponseSchema } from "./repo-files.js";

const ID = "01J9ZQ4V8E3M5N7P9R1S3T5V7X";
const PRODUCT = "01J9ZQ4V8E3M5N7P9R1S3T5V80";
const base = { v: 1, id: ID, product: PRODUCT } as const;

const hit = {
  path: ".agentplugged/docs/prd.md",
  title: "Product requirements",
  heading: "Reminders",
  line: 14,
  snippet: "Remind the customers who have not paid",
};

describe("the search request", () => {
  it("accepts words and nothing else on it", () => {
    expect(FilesRequestSchema.safeParse({ ...base, op: "find", query: "relances" }).success).toBe(
      true,
    );
    expect(
      FilesRequestSchema.safeParse({ ...base, op: "find", query: "a", path: "x" }).success,
    ).toBe(false);
  });

  it("refuses an empty or an oversized search", () => {
    expect(FilesRequestSchema.safeParse({ ...base, op: "find", query: "" }).success).toBe(false);
    expect(
      FilesRequestSchema.safeParse({
        ...base,
        op: "find",
        query: "a".repeat(FIND_QUERY_MAX_CHARS + 1),
      }).success,
    ).toBe(false);
  });
});

describe("the search answer", () => {
  it("carries places, one per document, within a limit", () => {
    expect(FindDataSchema.safeParse({ op: "find", hits: [hit], truncated: false }).success).toBe(
      true,
    );
    const many = Array.from({ length: FIND_HITS_MAX + 1 }, () => hit);
    expect(FindDataSchema.safeParse({ op: "find", hits: many, truncated: true }).success).toBe(
      false,
    );
    expect(
      FindDataSchema.safeParse({ op: "find", hits: [{ ...hit, line: 0 }], truncated: false })
        .success,
    ).toBe(false);
  });

  it("is read by a device that ignores what a newer machine adds", () => {
    const response = {
      ...base,
      ok: true,
      at: "worktree",
      read_at: 1,
      data: { op: "find", hits: [{ ...hit, extra: 1 }], truncated: false, more: "x" },
    };
    expect(FilesResponseSchema.safeParse(response).success).toBe(false);
    const read = FilesResponseReader.safeParse(response);
    expect(read.success).toBe(true);
  });
});
