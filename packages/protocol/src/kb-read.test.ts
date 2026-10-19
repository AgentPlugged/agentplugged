import { describe, expect, it } from "vitest";
import { KB_QUESTION_MAX_CHARS, KbAskDataSchema, KbListDataSchema } from "./kb-read.js";
import { FilesRequestSchema, FilesResponseReader, FilesResponseSchema } from "./repo-files.js";

const ID = "01J9ZQ4V8E3M5N7P9R1S3T5V7X";
const PRODUCT = "01J9ZQ4V8E3M5N7P9R1S3T5V80";
const ASK = "01J9ZQ4V8E3M5N7P9R1S3T5V81";

const base = { v: 1, id: ID, product: PRODUCT } as const;

describe("the knowledge base requests", () => {
  it("accepts the list and a question, and nothing else on them", () => {
    expect(FilesRequestSchema.safeParse({ ...base, op: "kb" }).success).toBe(true);
    expect(
      FilesRequestSchema.safeParse({ ...base, op: "ask", ask: ASK, question: "Comment ?" }).success,
    ).toBe(true);
    expect(FilesRequestSchema.safeParse({ ...base, op: "kb", path: "x" }).success).toBe(false);
  });

  it("refuses an empty, an oversized or an unidentified question", () => {
    const ask = { ...base, op: "ask", ask: ASK };
    expect(FilesRequestSchema.safeParse({ ...ask, question: "" }).success).toBe(false);
    expect(
      FilesRequestSchema.safeParse({ ...ask, question: "a".repeat(KB_QUESTION_MAX_CHARS + 1) })
        .success,
    ).toBe(false);
    expect(
      FilesRequestSchema.safeParse({ ...base, op: "ask", ask: "x", question: "q" }).success,
    ).toBe(false);
  });
});

const citation = {
  path: ".agentplugged/docs/kb-vision.md",
  heading: "Vision",
  line: 12,
  quote: "Relancer les factures impayées",
};

describe("the knowledge base answers", () => {
  const list = {
    op: "kb",
    pages: [
      {
        path: ".agentplugged/docs/kb-vision.md",
        title: "Vision",
        summary: "Ce que fait le produit.",
        updated: "2026-10-01",
        story: "2-3",
      },
    ],
    truncated: false,
    askable: true,
  };
  const answered = {
    op: "ask",
    ask: ASK,
    state: "answered",
    answer: {
      claims: [{ text: "Il relance.", citations: [citation] }],
      no_source: false,
      dropped: 0,
    },
    passages: 3,
    cost: { usd: 0.004, basis: "reported", tokens_in: 900, tokens_out: 80 },
  };

  it("holds the list and an answer in a response", () => {
    for (const data of [list, answered]) {
      const response = { ...base, ok: true, at: "worktree", read_at: 1, data };
      expect(FilesResponseSchema.safeParse(response).success).toBe(true);
    }
  });

  it("refuses a statement without a citation", () => {
    const bad = {
      ...answered,
      answer: { claims: [{ text: "Il relance.", citations: [] }], no_source: false, dropped: 0 },
    };
    expect(KbAskDataSchema.safeParse(bad).success).toBe(false);
  });

  it("refuses a page whose update day is not a day", () => {
    const bad = { ...list, pages: [{ path: "p.md", title: "T", updated: "yesterday" }] };
    expect(KbListDataSchema.safeParse(bad).success).toBe(false);
  });

  it("lets a device read an answer with a field it does not know yet", () => {
    const response = {
      ...base,
      ok: true,
      at: "worktree",
      read_at: 1,
      data: { ...answered, answer: { ...answered.answer, confidence: 0.9 } },
    };
    expect(FilesResponseSchema.safeParse(response).success).toBe(false);
    const read = FilesResponseReader.safeParse(response);
    expect(read.success).toBe(true);
  });
});
