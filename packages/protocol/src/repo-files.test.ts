import { describe, expect, it } from "vitest";
import {
  FILES_PATH_MAX,
  FilesRefSchema,
  FilesRequestSchema,
  FilesResponseSchema,
  LIVE_LINE_MAX_CHARS,
  LIVE_LINES_PER_ANSWER,
  LiveLineSchema,
} from "./repo-files.js";

const ID = "01J9ZQ4V8E3M5N7P9R1S3T5V7X";
const PRODUCT = "01J9ZQ4V8E3M5N7P9R1S3T5V80";
const SHA = "a".repeat(40);

describe("the requests to read the files of a product", () => {
  it("accepts each operation with its fields and nothing more", () => {
    const ok = [
      { op: "tree", ref: { kind: "worktree" }, path: "" },
      { op: "file", ref: { kind: "branch", name: "story/one" }, path: "src/a.ts" },
      { op: "download", ref: { kind: "commit", sha: SHA }, path: "logo.png" },
      { op: "refs" },
      {
        op: "changes",
        base: { kind: "branch", name: "main" },
        head: { kind: "workspace", branch: "x" },
      },
    ];
    for (const body of ok) {
      expect(
        FilesRequestSchema.safeParse({ v: 1, id: ID, product: PRODUCT, ...body }).success,
      ).toBe(true);
      expect(
        FilesRequestSchema.safeParse({ v: 1, id: ID, product: PRODUCT, ...body, extra: 1 }).success,
      ).toBe(false);
    }
  });

  it("refuses a request without an identifier, of another version, of an unknown kind or with a long path", () => {
    const base = {
      v: 1,
      id: ID,
      product: PRODUCT,
      op: "file",
      ref: { kind: "worktree" },
      path: "a",
    };
    expect(FilesRequestSchema.safeParse(base).success).toBe(true);
    expect(FilesRequestSchema.safeParse({ ...base, id: "x" }).success).toBe(false);
    expect(FilesRequestSchema.safeParse({ ...base, v: 2 }).success).toBe(false);
    expect(FilesRequestSchema.safeParse({ ...base, op: "write" }).success).toBe(false);
    expect(
      FilesRequestSchema.safeParse({ ...base, path: "a".repeat(FILES_PATH_MAX + 1) }).success,
    ).toBe(false);
    expect(FilesRequestSchema.safeParse({ ...base, path: "" }).success).toBe(false);
  });

  it("takes a commit only as a full hexadecimal id", () => {
    expect(FilesRefSchema.safeParse({ kind: "commit", sha: SHA }).success).toBe(true);
    for (const sha of ["HEAD", "main~1", "--all", "abc", `${SHA}x`, "A".repeat(40)]) {
      expect(FilesRefSchema.safeParse({ kind: "commit", sha }).success).toBe(false);
    }
  });
});

describe("the answers", () => {
  it("accepts data and refusals, and a refusal carries no data", () => {
    const good = {
      v: 1,
      id: ID,
      product: PRODUCT,
      ok: true,
      at: "worktree",
      read_at: 1,
      data: {
        op: "tree",
        path: "",
        entries: [{ name: "a", kind: "file", size: 1 }],
        truncated: false,
      },
    };
    expect(FilesResponseSchema.safeParse(good).success).toBe(true);
    const refused = {
      v: 1,
      id: ID,
      product: PRODUCT,
      ok: false,
      code: "TOO_LARGE",
      size: 9,
      max: 1,
    };
    expect(FilesResponseSchema.safeParse(refused).success).toBe(true);
    expect(FilesResponseSchema.safeParse({ ...refused, data: good.data }).success).toBe(false);
    expect(FilesResponseSchema.safeParse({ ...refused, code: "WHATEVER" }).success).toBe(false);
  });
});

describe("watching what the agents do", () => {
  it("is a read-only request with an optional cursor and nothing more", () => {
    for (const body of [{}, { after: 0 }, { after: 12, epoch: "abc" }]) {
      expect(
        FilesRequestSchema.safeParse({ v: 1, id: ID, product: PRODUCT, op: "live", ...body })
          .success,
      ).toBe(true);
    }
    for (const body of [{ after: -1 }, { after: 1.5 }, { epoch: "" }, { path: "x" }]) {
      expect(
        FilesRequestSchema.safeParse({ v: 1, id: ID, product: PRODUCT, op: "live", ...body })
          .success,
      ).toBe(false);
    }
  });

  it("answers with lines of a stable kind and a bounded plain text", () => {
    const line = { seq: 1, at: 1, agent: "lina", kind: "say", text: "hello" };
    expect(LiveLineSchema.safeParse(line).success).toBe(true);
    expect(LiveLineSchema.safeParse({ ...line, kind: "shell" }).success).toBe(false);
    expect(
      LiveLineSchema.safeParse({ ...line, text: "x".repeat(LIVE_LINE_MAX_CHARS + 1) }).success,
    ).toBe(false);
    expect(LiveLineSchema.safeParse({ ...line, command: "ls" }).success).toBe(false);
  });

  it("tells the files read and changed, the commands and their issue, in stable fields", () => {
    const base = { seq: 3, at: 1, agent: "lina" };
    for (const line of [
      { ...base, kind: "read", text: "src/a.ts" },
      { ...base, kind: "read", outside: true },
      { ...base, kind: "edit", text: ".env", protected: true },
      {
        ...base,
        kind: "edit",
        text: "src/a.ts",
        link: { ref: { kind: "workspace", branch: "story/3-1" }, path: "src/a.ts" },
      },
      { ...base, kind: "command", text: "git status" },
      { ...base, kind: "command_ok", of: 2 },
      { ...base, kind: "command_failed", of: 2 },
      { ...base, agent: "terminal", kind: "command", text: "ls", terminal: true },
    ]) {
      expect(LiveLineSchema.safeParse(line).success, JSON.stringify(line)).toBe(true);
    }
    for (const line of [
      { ...base, kind: "read", outside: false },
      { ...base, kind: "edit", link: { ref: { kind: "worktree" } } },
      { ...base, kind: "edit", link: { ref: { kind: "disk" }, path: "x" } },
      { ...base, kind: "command_ok", of: 0 },
      { ...base, kind: "command", result: "output" },
      { ...base, kind: "read", cwd: "/work" },
      { ...base, kind: "read", terminal: false },
    ]) {
      expect(LiveLineSchema.safeParse(line).success, JSON.stringify(line)).toBe(false);
    }
  });

  it("bounds the lines of an answer", () => {
    const line = { seq: 1, at: 1, agent: "lina", kind: "say", text: "hello" };
    const answer = {
      v: 1,
      id: ID,
      product: PRODUCT,
      ok: true,
      at: "live",
      read_at: 1,
      data: {
        op: "live",
        epoch: "e",
        reset: false,
        dropped: 0,
        next: 1,
        more: false,
        chain: "handed_over",
        working: null,
        lines: [line],
        handover: { tool: "claude-code", cwd: "/work", command: "claude --resume abc" },
      },
    };
    expect(FilesResponseSchema.safeParse(answer).success).toBe(true);
    const many = Array.from({ length: LIVE_LINES_PER_ANSWER + 1 }, (_, n) => ({
      ...line,
      seq: n + 1,
    }));
    expect(
      FilesResponseSchema.safeParse({ ...answer, data: { ...answer.data, lines: many } }).success,
    ).toBe(false);
  });
});
