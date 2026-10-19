import { describe, expect, it } from "vitest";
import { CostsDataSchema } from "./costs-read.js";
import { FilesRequestSchema, FilesResponseReader, FilesResponseSchema } from "./repo-files.js";

const ID = "01J9ZQ4V8E3M5N7P9R1S3T5V7X";
const PRODUCT = "01J9ZQ4V8E3M5N7P9R1S3T5V80";
const base = { v: 1, id: ID, product: PRODUCT } as const;

const figures = {
  usd: 1.25,
  nature: "real",
  tokens_in: 1000,
  tokens_out: 200,
  cache_read: 50,
  cache_write: 10,
  active_ms: 60_000,
  unpriced: [],
};

const data = {
  op: "costs",
  period: "all",
  table: { version: "2026-10-17", as_of: "2026-10-17" },
  measured: true,
  sessions: 2,
  total: figures,
  phases: [
    {
      phase: "framing",
      figures,
      works: [{ kind: "document", key: "prd", agent: "maya", figures }],
      truncated: false,
    },
  ],
  agents: [{ agent: "maya", figures }],
  stories: [{ story: "1-2", sprint: "S-0123456789", figures }],
  sprints: [
    {
      id: "S-0123456789",
      goal: "Premier jet",
      status: "in_force",
      stories: 1,
      budget_usd: 5,
      figures,
    },
  ],
  truncated: false,
};

describe("the costs request", () => {
  it("accepts a request with or without a period, and nothing else on it", () => {
    expect(FilesRequestSchema.safeParse({ ...base, op: "costs" }).success).toBe(true);
    expect(FilesRequestSchema.safeParse({ ...base, op: "costs", period: "week" }).success).toBe(
      true,
    );
    expect(FilesRequestSchema.safeParse({ ...base, op: "costs", period: "year" }).success).toBe(
      false,
    );
    expect(FilesRequestSchema.safeParse({ ...base, op: "costs", path: "x" }).success).toBe(false);
  });
});

describe("the costs answer", () => {
  it("accepts a report, and an unknown amount without dollars", () => {
    expect(CostsDataSchema.safeParse(data).success).toBe(true);
    const { usd: _usd, ...unknown } = figures;
    expect(
      CostsDataSchema.safeParse({ ...data, total: { ...unknown, nature: "unknown" } }).success,
    ).toBe(true);
  });

  it("refuses a negative amount and a figure with an extra field", () => {
    expect(CostsDataSchema.safeParse({ ...data, total: { ...figures, usd: -1 } }).success).toBe(
      false,
    );
    expect(CostsDataSchema.safeParse({ ...data, total: { ...figures, extra: 1 } }).success).toBe(
      false,
    );
  });

  it("travels in a response, and a device ignores a field it does not know", () => {
    const response = { ...base, ok: true, at: "worktree", read_at: 1, data };
    expect(FilesResponseSchema.safeParse(response).success).toBe(true);
    const newer = { ...response, data: { ...data, later: true } };
    const read = FilesResponseReader.safeParse(newer);
    expect(read.success).toBe(true);
    if (read.success && read.data.ok) expect(read.data.data.op).toBe("costs");
  });
});
