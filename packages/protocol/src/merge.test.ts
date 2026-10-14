import { describe, expect, it } from "vitest";
import { CheckpointClosedPayloadSchema } from "./checkpoint-closed.js";
import { ErrorCode } from "./error-payload.js";
import { eventTypeSpec } from "./event-types.js";
import {
  KnowledgeCodeSchema,
  KnowledgeStorySchema,
  MERGE_EVENT_TYPES,
  MERGE_METHODS,
  StoryMergedPayloadSchema,
} from "./merge.js";
import { MethodConfigSchema, PullRequestSettingsSchema } from "./method-config.js";

const COMMIT = "a".repeat(40);

const payload = {
  checkpoint: "G-0000000001",
  forge: "github",
  pr: 7,
  url: "https://github.com/ada/shop/pull/7",
  commit: COMMIT,
  merge_commit: "b".repeat(40),
  method: "merge",
  files: ["src/a.ts", "README.md"],
  source: "chat",
};

describe("The merge of a story", () => {
  it("registers story.merged at version 3 (the weight of the code; 3.36: a merge without a pull request)", () => {
    expect(eventTypeSpec(MERGE_EVENT_TYPES.merged)?.version).toBe(3);
  });

  it("keeps the weight of the story's code and refuses a malformed one", () => {
    const weight = { added: 120, removed: 30, duplicates: 2 };
    expect(StoryMergedPayloadSchema.safeParse({ ...payload, weight }).success).toBe(true);
    expect(
      StoryMergedPayloadSchema.safeParse({ ...payload, weight: { added: 1, removed: 0 } }).success,
    ).toBe(true);
    for (const wrong of [
      { added: -1, removed: 0 },
      { added: 1.5, removed: 0 },
      { added: 1 },
      { added: 1, removed: 0, files: 3 },
    ]) {
      expect(StoryMergedPayloadSchema.safeParse({ ...payload, weight: wrong }).success).toBe(false);
    }
  });

  it("accepts a merge and refuses what it is not", () => {
    expect(StoryMergedPayloadSchema.safeParse(payload).success).toBe(true);
    expect(StoryMergedPayloadSchema.safeParse({ ...payload, already: true }).success).toBe(true);
    for (const wrong of [
      { ...payload, source: "mobile" },
      { ...payload, method: "fast-forward" },
      { ...payload, commit: "HEAD" },
      { ...payload, files: ["src/a.ts", "src/a.ts"] },
      { ...payload, files: ["../outside"] },
      { ...payload, files: ["/abs"] },
      { ...payload, files: ["a\\b"] },
      { ...payload, already: false },
      { ...payload, url: "https://user:pass@github.com/x" },
      { ...payload, extra: 1 },
    ]) {
      expect(StoryMergedPayloadSchema.safeParse(wrong).success).toBe(false);
    }
  });

  it("records a merge the creator did on the forge, with who and when", () => {
    const { checkpoint: _checkpoint, ...bare } = payload;
    const forge = {
      ...bare,
      source: "forge",
      already: true,
      merged_by: "ada",
      merged_at: "2026-10-05T14:20:00.000Z",
    };
    expect(StoryMergedPayloadSchema.safeParse(forge).success).toBe(true);
    // The merge checkpoint that was open may be named.
    expect(
      StoryMergedPayloadSchema.safeParse({ ...forge, checkpoint: "G-0000000001" }).success,
    ).toBe(true);
    for (const wrong of [
      { ...forge, merged_by: undefined },
      { ...forge, merged_at: undefined },
      { ...forge, merged_at: "yesterday" },
      // An approved merge names its checkpoint, and says nothing of a forge account.
      { ...payload, checkpoint: undefined },
      { ...payload, merged_by: "ada", merged_at: "2026-10-05T14:20:00.000Z" },
    ]) {
      expect(StoryMergedPayloadSchema.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false);
    }
  });

  it("closes a point with its reason: replaced names the newer one, no other does", () => {
    expect(
      CheckpointClosedPayloadSchema.safeParse({
        checkpoint: "G-0000000001",
        reason: "story_merged",
      }).success,
    ).toBe(true);
    expect(
      CheckpointClosedPayloadSchema.safeParse({
        checkpoint: "G-0000000001",
        reason: "replaced",
        ref: "G-0000000002",
      }).success,
    ).toBe(true);
    // A working copy gone, a permission lapsed, a block lifted: no newer point.
    for (const reason of ["block_lifted", "worktree_gone", "lapsed"]) {
      expect(
        CheckpointClosedPayloadSchema.safeParse({ checkpoint: "G-0000000001", reason }).success,
      ).toBe(true);
    }
    for (const wrong of [
      { checkpoint: "G-0000000001", reason: "replaced" },
      { checkpoint: "G-0000000001", reason: "review_redone", ref: "G-0000000002" },
      { checkpoint: "G-0000000001", reason: "because" },
      { checkpoint: "G-0000000001", reason: "story_merged", note: "x" },
    ]) {
      expect(CheckpointClosedPayloadSchema.safeParse(wrong).success).toBe(false);
    }
  });

  it("adds MERGE_FAILED to the shared list (MERGE_CONFLICT follows it)", () => {
    const codes = Object.values(ErrorCode);
    expect(codes.indexOf("MERGE_FAILED")).toBeGreaterThan(-1);
    expect(codes.at(-9)).toBe("MERGE_CONFLICT");
  });

  it("reads pr.merge_method, the same methods as the merge", () => {
    for (const method of MERGE_METHODS) {
      expect(PullRequestSettingsSchema.safeParse({ merge_method: method }).success).toBe(true);
    }
    expect(PullRequestSettingsSchema.safeParse({ merge_method: "octopus" }).success).toBe(false);
    expect(MethodConfigSchema.shape.pr).toBeDefined();
  });

  it("checks the knowledge base's code paths and last story", () => {
    expect(KnowledgeCodeSchema.safeParse("src/billing/").success).toBe(true);
    expect(KnowledgeCodeSchema.safeParse("../x").success).toBe(false);
    expect(KnowledgeStorySchema.safeParse("4-9").success).toBe(true);
    expect(KnowledgeStorySchema.safeParse("story").success).toBe(false);
  });
});
