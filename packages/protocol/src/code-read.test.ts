import { describe, expect, it } from "vitest";
import { CODE_PATCH_MAX_CHARS, CodePullSchema } from "./code-read.js";
import {
  FilesDataReader,
  FilesRequestSchema,
  FilesResponseReader,
  FilesResponseSchema,
} from "./repo-files.js";

const ID = "01J9ZQ4V8E3M5N7P9R1S3T5V7X";
const PRODUCT = "01J9ZQ4V8E3M5N7P9R1S3T5V80";
const AT = "2026-10-12T18:40:00.000Z";

const pull = {
  number: 48,
  title: "Add the weekly digest",
  state: "open" as const,
  author: "quentin",
  branch: "story/2-3",
  base: "main",
  url: "https://github.com/innovel/kalo/pull/48",
  created_at: AT,
  updated_at: AT,
  checks: { state: "passed" as const, passed: 5, failed: 0, total: 5 },
  review: "approved" as const,
};
const repository = { provider: "github" as const, host: "github.com", path: "innovel/kalo" };

describe("the requests to read the code of a product", () => {
  it("accepts each operation with its fields and nothing more", () => {
    const ok = [
      { op: "pulls" },
      { op: "pull", number: 48 },
      { op: "pull_diff", number: 48 },
      { op: "editor", ref: { kind: "worktree" } },
      { op: "editor", ref: { kind: "workspace", branch: "story/2-3" } },
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

  it("refuses a number that is not a positive whole number, and a path or a command in a request", () => {
    const base = { v: 1, id: ID, product: PRODUCT };
    for (const number of [0, -1, 1.5, "48", 1_000_000_001]) {
      expect(FilesRequestSchema.safeParse({ ...base, op: "pull", number }).success).toBe(false);
    }
    expect(
      FilesRequestSchema.safeParse({ ...base, op: "editor", ref: { kind: "path", path: "/" } })
        .success,
    ).toBe(false);
    expect(
      FilesRequestSchema.safeParse({ ...base, op: "editor", ref: { kind: "worktree" }, path: "/x" })
        .success,
    ).toBe(false);
    expect(FilesRequestSchema.safeParse({ ...base, op: "pulls", token: "x" }).success).toBe(false);
  });
});

describe("the answers about the code", () => {
  const ok = (data: unknown) => ({
    v: 1,
    id: ID,
    product: PRODUCT,
    ok: true,
    at: "api",
    read_at: 1,
    data,
  });

  it("reads a list, a pull request, a difference and an editor answer", () => {
    const answers = [
      { op: "pulls", repository, pulls: [pull], truncated: false },
      {
        op: "pull",
        repository,
        pull,
        checks: [{ name: "Tests (24)", state: "passed", seconds: 72 }],
        reviews: [{ author: "quentin", verdict: "approved", body: "Fine.", at: AT }],
        remarks: [
          {
            id: "9",
            author: "dana",
            path: "src/a.ts",
            line: 43,
            side: "new",
            body: "Why?",
            at: AT,
          },
        ],
      },
      {
        op: "pull_diff",
        repository,
        number: 48,
        files: [
          {
            path: "src/a.ts",
            status: "modified",
            additions: 1,
            deletions: 1,
            patch: "@@ -1 +1 @@\n-a\n+b",
          },
        ],
        truncated: false,
      },
      { op: "editor", folder: "/home/me/kalo", platform: "linux", detected: ["vscode", "zed"] },
    ];
    for (const data of answers) {
      expect(FilesResponseSchema.safeParse(ok(data)).success).toBe(true);
    }
  });

  it("bounds what a platform can make large: titles, patches, lists", () => {
    expect(CodePullSchema.safeParse({ ...pull, title: "t".repeat(201) }).success).toBe(false);
    const big = {
      op: "pull_diff",
      repository,
      number: 1,
      files: [
        {
          path: "a",
          status: "modified",
          additions: 0,
          deletions: 0,
          patch: "x".repeat(CODE_PATCH_MAX_CHARS + 1),
        },
      ],
      truncated: false,
    };
    expect(FilesResponseSchema.safeParse(ok(big)).success).toBe(false);
    const many = { op: "pulls", repository, pulls: Array(31).fill(pull), truncated: true };
    expect(FilesResponseSchema.safeParse(ok(many)).success).toBe(false);
  });

  it("is read by a device while ignoring the fields it does not know, and still validating the ones it knows", () => {
    const withExtra = ok({
      op: "pulls",
      repository: { ...repository, region: "eu" },
      pulls: [{ ...pull, labels: ["x"] }],
      truncated: false,
      cursor: "later",
    });
    expect(FilesResponseSchema.safeParse(withExtra).success).toBe(false);
    const read = FilesResponseReader.safeParse(withExtra);
    expect(read.success).toBe(true);
    if (read.success && read.data.ok) {
      expect(JSON.stringify(read.data)).not.toContain("labels");
      expect(JSON.stringify(read.data)).not.toContain("cursor");
    }
    const broken = ok({
      op: "pulls",
      repository,
      pulls: [{ ...pull, number: 0 }],
      truncated: false,
    });
    expect(FilesDataReader.safeParse(broken.data).success).toBe(false);
  });

  it("tells the platform codes, with the host to name", () => {
    for (const code of [
      "NOT_LINKED",
      "NO_REMOTE",
      "FORGE_REFUSED",
      "FORGE_UNREACHABLE",
      "FORGE_BUSY",
    ]) {
      expect(
        FilesResponseSchema.safeParse({
          v: 1,
          id: ID,
          product: PRODUCT,
          ok: false,
          code,
          host: "github.com",
        }).success,
      ).toBe(true);
    }
    expect(
      FilesResponseSchema.safeParse({
        v: 1,
        id: ID,
        product: PRODUCT,
        ok: false,
        code: "NOT_LINKED",
        host: "https://evil.example/x",
      }).success,
    ).toBe(false);
  });
});
