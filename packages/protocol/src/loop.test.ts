import { describe, expect, it } from "vitest";
import {
  AttemptRecordedPayloadSchema,
  CHECKPOINT_SOURCES,
  LOOP_EVENT_TYPES,
  LOOP_MAX_ATTEMPTS,
  LOOP_STOP_REASONS,
  LoopInputSchema,
  LoopResumedPayloadSchema,
  LoopStoppedPayloadSchema,
} from "./index.js";

/** The bounded loop: what the journal holds of a stop and of an approach tried. */

describe("what the journal records of the loop", () => {
  it("names its three events and its limit of approaches", () => {
    expect(LOOP_EVENT_TYPES).toEqual({
      attempt: "story.attempt_recorded",
      stopped: "loop.stopped",
      resumed: "loop.resumed",
    });
    expect(LOOP_MAX_ATTEMPTS).toBe(3);
    expect(CHECKPOINT_SOURCES.at(-1)).toBe("attempt_limit");
  });

  it("records an approach as started, failed or green, with a plain line", () => {
    for (const result of ["started", "failed", "green"]) {
      expect(
        AttemptRecordedPayloadSchema.safeParse({ approach: "recompute the total", result }).success,
      ).toBe(true);
    }
    expect(AttemptRecordedPayloadSchema.safeParse({ approach: "x", result: "maybe" }).success).toBe(
      false,
    );
    expect(AttemptRecordedPayloadSchema.safeParse({ approach: "", result: "failed" }).success).toBe(
      false,
    );
    expect(
      AttemptRecordedPayloadSchema.safeParse({ approach: "a".repeat(301), result: "failed" })
        .success,
    ).toBe(false);
    // A hidden comment is no approach.
    expect(
      AttemptRecordedPayloadSchema.safeParse({ approach: "ok <!-- hidden -->", result: "failed" })
        .success,
    ).toBe(false);
    // Nothing else rides along.
    expect(
      AttemptRecordedPayloadSchema.safeParse({ approach: "x y", result: "failed", extra: 1 })
        .success,
    ).toBe(false);
  });

  it("records a stop with one of its reasons, and a resumption with the stop it follows", () => {
    for (const reason of LOOP_STOP_REASONS) {
      expect(LoopStoppedPayloadSchema.safeParse({ reason }).success, reason).toBe(true);
      expect(LoopResumedPayloadSchema.safeParse({ after: reason }).success, reason).toBe(true);
    }
    expect(LoopStoppedPayloadSchema.safeParse({ reason: "night" }).success).toBe(false);
    expect(LoopResumedPayloadSchema.safeParse({ after: "night" }).success).toBe(false);
    expect(
      LoopStoppedPayloadSchema.safeParse({ reason: "merge", subject: "G-7M2K9QX4TB" }).success,
    ).toBe(true);
    // The creator's reasons are all there: a stop never goes without its kind of point.
    for (const reason of [
      "validation",
      "decision",
      "merge",
      "spend",
      "irreversible",
      "command",
      "gap",
    ]) {
      expect(LOOP_STOP_REASONS, reason).toContain(reason);
    }
  });
});

describe("the input of the loop", () => {
  const agent = { agent: "sam" };

  it("is a turn with nothing else, an approach with a story and a note, a result with a story and seen", () => {
    expect(LoopInputSchema.safeParse({ agent: "noah" }).success).toBe(true);
    expect(
      LoopInputSchema.safeParse({ ...agent, story: "1-3", note: "try this way" }).success,
    ).toBe(true);
    expect(LoopInputSchema.safeParse({ ...agent, story: "1-3", seen: "green" }).success).toBe(true);
    expect(
      LoopInputSchema.safeParse({ ...agent, story: "1-3", seen: "failed", note: "stale" }).success,
    ).toBe(true);
  });

  it("says a hypothesis of a bug's cause with the same three fields", () => {
    for (const seen of ["hypothesis", "ruled_out", "confirmed"]) {
      expect(
        LoopInputSchema.safeParse({ ...agent, story: "1-3", seen, note: "7/10 stale cache" })
          .success,
        seen,
      ).toBe(true);
    }
    // A hypothesis is a record with its confidence, and a confidence is a hypothesis's.
    expect(
      AttemptRecordedPayloadSchema.safeParse({
        approach: "stale cache",
        result: "started",
        kind: "hypothesis",
        confidence: 7,
      }).success,
    ).toBe(true);
    for (const payload of [
      { approach: "x y", result: "started", kind: "hypothesis" },
      { approach: "x y", result: "started", confidence: 7 },
      { approach: "x y", result: "started", kind: "hypothesis", confidence: 0 },
      { approach: "x y", result: "started", kind: "hypothesis", confidence: 11 },
      { approach: "x y", result: "started", kind: "idea", confidence: 5 },
    ]) {
      expect(AttemptRecordedPayloadSchema.safeParse(payload).success, JSON.stringify(payload)).toBe(
        false,
      );
    }
  });

  it("refuses a story with nothing to say of it, and a note or a result with no story", () => {
    for (const input of [
      { ...agent, story: "1-3" },
      { ...agent, note: "a way" },
      { ...agent, seen: "green" },
      { ...agent, story: "1-3", seen: "maybe" },
      { ...agent, story: "one-three", note: "a way" },
      { ...agent, story: "1-3", note: "a way", approach: "another" },
    ]) {
      expect(LoopInputSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });
});
