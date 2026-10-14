import { describe, expect, it } from "vitest";
import { CHECKPOINT_SOURCES } from "./checkpoint.js";
import { ErrorCode } from "./error-payload.js";
import { eventTypeSpec } from "./event-types.js";
import { MERGE_FAILURES } from "./merge.js";
import {
  CONFLICT_CLASSES,
  CONFLICT_OPTIONS,
  GetMergeOrderInputSchema,
  MERGE_CONFLICT_REASONS,
  MERGE_ORDER_EVENT_TYPES,
  QualifyMergeConflictInputSchema,
  StoryConflictQualifiedPayloadSchema,
  StoryMergeRefreshedPayloadSchema,
  SUBSTANTIVE_CLASSES,
} from "./merge-order.js";

const COMMIT = "a".repeat(40);

const textual = {
  main: COMMIT,
  head: "b".repeat(40),
  base_ref: "main",
  kind: "textual",
  files: [{ path: "src/index.ts", class: "additions" }],
  rationale: "Two imports added at the same place.",
};

const substantive = {
  ...textual,
  kind: "substantive",
  files: [{ path: "src/index.ts", class: "both_modified" }],
  recommendation: "keep_story",
  checkpoint: "G-0000000001",
};

describe("The order of the merges and the conflicts", () => {
  it("registers its two events at version 1", () => {
    expect(eventTypeSpec(MERGE_ORDER_EVENT_TYPES.conflictQualified)?.version).toBe(1);
    expect(eventTypeSpec(MERGE_ORDER_EVENT_TYPES.mergeRefreshed)?.version).toBe(1);
  });

  it("adds its error code last, its reasons and its checkpoint source at the end of the lists", () => {
    expect(Object.values(ErrorCode).at(-9)).toBe("MERGE_CONFLICT");
    expect(MERGE_FAILURES.at(-1)).toBe("base_changed");
    expect(MERGE_FAILURES).toContain("conflict_unverified");
    expect(MERGE_FAILURES).toContain("out_of_order");
    expect(CHECKPOINT_SOURCES.at(-2)).toBe("merge_conflict");
    expect(MERGE_CONFLICT_REASONS).toContain("forced_substantive");
  });

  it("accepts a textual and a substantive qualification", () => {
    expect(StoryConflictQualifiedPayloadSchema.safeParse(textual).success).toBe(true);
    expect(StoryConflictQualifiedPayloadSchema.safeParse(substantive).success).toBe(true);
  });

  it("never lets a conflict that is more than text be called textual", () => {
    for (const heavy of CONFLICT_CLASSES.filter((name) => SUBSTANTIVE_CLASSES.has(name))) {
      const wrong = { ...textual, files: [{ path: "src/index.ts", class: heavy }] };
      expect(StoryConflictQualifiedPayloadSchema.safeParse(wrong).success, heavy).toBe(false);
    }
    expect(StoryConflictQualifiedPayloadSchema.safeParse({ ...textual, files: [] }).success).toBe(
      false,
    );
  });

  it("ties the recommendation and the decision checkpoint to a conflict of substance", () => {
    for (const wrong of [
      { ...textual, recommendation: "keep_story" },
      { ...textual, checkpoint: "G-0000000001" },
      { ...substantive, recommendation: undefined },
      { ...substantive, checkpoint: undefined },
      { ...substantive, recommendation: "keep_everything" },
      { ...textual, files: [textual.files[0], textual.files[0]] },
      { ...textual, files: [{ path: "../x", class: "additions" }] },
      { ...textual, rationale: "" },
      { ...textual, rationale: "x".repeat(601) },
      { ...textual, extra: 1 },
    ]) {
      expect(StoryConflictQualifiedPayloadSchema.safeParse(wrong).success).toBe(false);
    }
    expect(CONFLICT_OPTIONS).toEqual(["keep_story", "keep_main", "combine"]);
  });

  it("accepts a refreshed merge point and refuses what it is not", () => {
    const refreshed = { checkpoint: "G-0000000001", pass: 2, commit: COMMIT, summary: "New text." };
    expect(StoryMergeRefreshedPayloadSchema.safeParse(refreshed).success).toBe(true);
    for (const wrong of [
      { ...refreshed, pass: 0 },
      { ...refreshed, commit: "HEAD" },
      { ...refreshed, summary: "" },
      { ...refreshed, summary: "x".repeat(2001) },
      // The walk through the change is one short line of the engine's text.
      { ...refreshed, walkthrough: "" },
      { ...refreshed, walkthrough: "x".repeat(901) },
      { ...refreshed, walkthrough: "a\nb" },
    ]) {
      expect(StoryMergeRefreshedPayloadSchema.safeParse(wrong).success).toBe(false);
    }
    expect(
      StoryMergeRefreshedPayloadSchema.safeParse({
        ...refreshed,
        walkthrough: "Read first: 1) a.ts",
      }).success,
    ).toBe(true);
  });

  it("checks the inputs of its two tools", () => {
    const input = { agent: "sam", story: "4-3", kind: "textual", rationale: "Imports." };
    expect(QualifyMergeConflictInputSchema.safeParse(input).success).toBe(true);
    expect(
      QualifyMergeConflictInputSchema.safeParse({
        ...input,
        kind: "substantive",
        recommendation: "combine",
      }).success,
    ).toBe(true);
    expect(
      QualifyMergeConflictInputSchema.safeParse({ ...input, kind: "substantive" }).success,
    ).toBe(false);
    expect(
      QualifyMergeConflictInputSchema.safeParse({ ...input, recommendation: "combine" }).success,
    ).toBe(false);
    expect(GetMergeOrderInputSchema.safeParse({ agent: "izzy" }).success).toBe(true);
    expect(GetMergeOrderInputSchema.safeParse({ agent: "izzy", story: "4-3" }).success).toBe(true);
    expect(GetMergeOrderInputSchema.safeParse({ agent: "izzy", story: "x" }).success).toBe(false);
  });
});
