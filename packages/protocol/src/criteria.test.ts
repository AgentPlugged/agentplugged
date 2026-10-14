import { describe, expect, it } from "vitest";
import {
  CRITERION_EVENT_TYPES,
  CriterionRecordedPayloadSchema,
  criteriaInLine,
  criterionId,
  RecordCriterionInputSchema,
} from "./index.js";

/** The criteria of a story proved by tests written first. */

const RUN = {
  command: "criteria",
  fingerprint: "a".repeat(24),
  ended: "exit",
  exit: 1,
  ms: 120,
  summary: "1 failed",
} as const;

describe("what the journal records of a criterion", () => {
  it("is a run the engine made, with the command the creator accepted", () => {
    expect(CRITERION_EVENT_TYPES.recorded).toBe("story.criterion_recorded");
    const red = {
      criterion: 2,
      result: "red",
      origin: "engine",
      commit: "c".repeat(40),
      clean: true,
      run: RUN,
    };
    expect(CriterionRecordedPayloadSchema.safeParse(red).success).toBe(true);
    // The engine's mark needs its run, and a run is the engine's only.
    expect(CriterionRecordedPayloadSchema.safeParse({ ...red, run: undefined }).success).toBe(
      false,
    );
    expect(
      CriterionRecordedPayloadSchema.safeParse({ ...red, origin: "reported", test: "t" }).success,
    ).toBe(false);
  });

  it("is an agent's word, with the test it ran", () => {
    expect(
      CriterionRecordedPayloadSchema.safeParse({
        criterion: 1,
        result: "green",
        origin: "reported",
        test: "AC-1-1-1 signs in",
      }).success,
    ).toBe(true);
    expect(
      CriterionRecordedPayloadSchema.safeParse({
        criterion: 1,
        result: "green",
        origin: "reported",
      }).success,
    ).toBe(false);
  });

  it("is a declaration with its reason when nothing can be observed", () => {
    const untestable = {
      criterion: 3,
      result: "untestable",
      origin: "reported",
      reason: "the sound plays on the user's speaker",
    };
    expect(CriterionRecordedPayloadSchema.safeParse(untestable).success).toBe(true);
    expect(
      CriterionRecordedPayloadSchema.safeParse({ ...untestable, reason: undefined }).success,
    ).toBe(false);
    expect(
      CriterionRecordedPayloadSchema.safeParse({ ...untestable, origin: "engine", run: RUN })
        .success,
    ).toBe(false);
    expect(CriterionRecordedPayloadSchema.safeParse({ ...untestable, criterion: 0 }).success).toBe(
      false,
    );
    expect(CriterionRecordedPayloadSchema.safeParse({ ...untestable, extra: true }).success).toBe(
      false,
    );
  });
});

describe("what an agent gives to record a criterion", () => {
  const base = { agent: "sam", story: "17-3", criterion: 2 };

  it("gives nothing else when the engine runs the command", () => {
    expect(RecordCriterionInputSchema.safeParse(base).success).toBe(true);
  });

  it("says what it saw otherwise, published as a plain string and checked here", () => {
    expect(RecordCriterionInputSchema.safeParse({ ...base, seen: "red", note: "t" }).success).toBe(
      true,
    );
    expect(RecordCriterionInputSchema.safeParse({ ...base, seen: "blue" }).success).toBe(false);
    // The reason of an untestable criterion is not optional.
    expect(RecordCriterionInputSchema.safeParse({ ...base, seen: "untestable" }).success).toBe(
      false,
    );
    expect(
      RecordCriterionInputSchema.safeParse({ ...base, seen: "untestable", note: "no screen" })
        .success,
    ).toBe(true);
    expect(RecordCriterionInputSchema.safeParse({ ...base, story: "x" }).success).toBe(false);
    expect(RecordCriterionInputSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
});

describe("the id of a criterion", () => {
  it("is written with dashes, read with dashes or underscores, in any case", () => {
    expect(criterionId("17-3", 2)).toBe("AC-17-3-2");
    for (const text of ["AC-17-3-2", "AC_17_3_2", "ac_17_3_2", "TestAC_17_3_2", "x AC-17-3-2."]) {
      expect(criteriaInLine(text)).toEqual([{ story: "17-3", criterion: 2 }]);
    }
    for (const text of ["AC-17-3", "AC-17-3-123", "xAC-17-3-2", "EF-17"]) {
      expect(criteriaInLine(text).map((found) => found.criterion)).not.toContain(2);
    }
  });
});
