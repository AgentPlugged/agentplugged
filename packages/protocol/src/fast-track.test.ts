import { describe, expect, it } from "vitest";
import { CHECKPOINT_SOURCES } from "./checkpoint.js";
import { ErrorCode } from "./error-payload.js";
import { eventTypeSpec } from "./event-types.js";
import {
  FAST_TRACK_AGENT_REASONS,
  FAST_TRACK_ENGINE_REASONS,
  FAST_TRACK_EVENT_TYPES,
  FAST_TRACK_MAX_FILES,
  FastTrackCheckedPayloadSchema,
  FastTrackEnteredPayloadSchema,
  FastTrackEntrySchema,
  FastTrackLeftPayloadSchema,
  LeaveFastTrackInputSchema,
  missingDeclarations,
  StartStoryFastTrackInputSchema,
} from "./fast-track.js";

const COMMIT = "a".repeat(40);
const DECLARED = { single_reading: true, reversible: true, no_public_interface: true };

describe("The fast track", () => {
  it("registers its three events at version 1", () => {
    for (const type of Object.values(FAST_TRACK_EVENT_TYPES)) {
      expect(eventTypeSpec(type)?.version, type).toBe(1);
    }
  });

  it("fixes the threshold at fewer than 5 files", () => {
    expect(FAST_TRACK_MAX_FILES).toBe(5);
  });

  it("adds its error code and its checkpoint source to the shared lists", () => {
    expect(Object.values(ErrorCode).at(-10)).toBe("FAST_TRACK_NOT_POSSIBLE");
    expect(CHECKPOINT_SOURCES.at(-3)).toBe("fast_track");
  });

  it("names the declaration a developer could not make, and records only a complete one", () => {
    expect(missingDeclarations(DECLARED)).toEqual([]);
    expect(missingDeclarations({ ...DECLARED, reversible: false })).toEqual(["reversible"]);
    expect(
      missingDeclarations({ single_reading: false, reversible: true, no_public_interface: false }),
    ).toEqual(["single_reading", "no_public_interface"]);
    for (const incomplete of [
      { ...DECLARED, single_reading: false },
      { ...DECLARED, reversible: false },
      { ...DECLARED, no_public_interface: false },
    ]) {
      expect(
        FastTrackEnteredPayloadSchema.safeParse({
          agent: "sam",
          summary: "Empty name refused",
          declared: incomplete,
        }).success,
      ).toBe(false);
    }
  });

  it("enters through an input that carries the change and its declaration", () => {
    const entry = { summary: "Empty name refused", declared: DECLARED };
    expect(FastTrackEntrySchema.safeParse(entry).success).toBe(true);
    for (const wrong of [
      { ...entry, declared: { single_reading: true, reversible: true } },
      { ...entry, declared: { ...DECLARED, reversible: "yes" } },
      { ...entry, summary: "" },
      { ...entry, summary: "x".repeat(301) },
      { ...entry, extra: 1 },
    ]) {
      expect(FastTrackEntrySchema.safeParse(wrong).success).toBe(false);
    }
    const input = { agent: "sam", story: "2-3" };
    expect(StartStoryFastTrackInputSchema.safeParse(input).success).toBe(true);
    expect(StartStoryFastTrackInputSchema.safeParse({ ...input, fast_track: entry }).success).toBe(
      true,
    );
    expect(StartStoryFastTrackInputSchema.safeParse({ ...input, fast_track: true }).success).toBe(
      false,
    );
  });

  it("records the entry, the verification and the exit", () => {
    expect(
      FastTrackEnteredPayloadSchema.safeParse({
        agent: "sam",
        summary: "Empty name refused",
        declared: DECLARED,
      }).success,
    ).toBe(true);
    const checked = { commit: COMMIT, count: 2, files: ["a.ts", "b.ts"], ok: true, reasons: [] };
    expect(FastTrackCheckedPayloadSchema.safeParse(checked).success).toBe(true);
    expect(
      FastTrackCheckedPayloadSchema.safeParse({
        ...checked,
        count: 5,
        ok: false,
        reasons: ["too_many_files"],
      }).success,
    ).toBe(true);
    // ok if and only if there is no reason; each reason once; the engine's reasons only.
    for (const wrong of [
      { ...checked, ok: false },
      { ...checked, reasons: ["migration"] },
      { ...checked, ok: false, reasons: ["migration", "migration"] },
      { ...checked, ok: false, reasons: ["growing_scope"] },
      { ...checked, commit: "HEAD" },
      { ...checked, files: ["../x"] },
    ]) {
      expect(FastTrackCheckedPayloadSchema.safeParse(wrong).success).toBe(false);
    }
  });

  it("keeps each side to its own reasons when leaving", () => {
    expect(
      FastTrackLeftPayloadSchema.safeParse({ by: "engine", reasons: FAST_TRACK_ENGINE_REASONS })
        .success,
    ).toBe(true);
    expect(
      FastTrackLeftPayloadSchema.safeParse({
        by: "agent",
        reasons: FAST_TRACK_AGENT_REASONS,
        detail: "The scope grew",
      }).success,
    ).toBe(true);
    for (const wrong of [
      { by: "engine", reasons: ["growing_scope"] },
      { by: "agent", reasons: ["too_many_files"] },
      { by: "agent", reasons: [] },
      { by: "agent", reasons: ["growing_scope", "growing_scope"] },
      { by: "robot", reasons: ["growing_scope"] },
    ]) {
      expect(FastTrackLeftPayloadSchema.safeParse(wrong).success).toBe(false);
    }
  });

  it("gives the developer one tool to leave, with a reason and what they found", () => {
    const input = {
      agent: "sam",
      story: "2-3",
      reasons: ["growing_scope", "new_dependency"],
      detail: "The fix needs a new library",
    };
    expect(LeaveFastTrackInputSchema.safeParse(input).success).toBe(true);
    for (const wrong of [
      { ...input, reasons: [] },
      { ...input, reasons: ["too_many_files"] },
      { ...input, reasons: ["growing_scope", "growing_scope"] },
      { ...input, detail: "" },
      { agent: "sam", story: "2-3", reasons: ["growing_scope"] },
    ]) {
      expect(LeaveFastTrackInputSchema.safeParse(wrong).success).toBe(false);
    }
  });
});
