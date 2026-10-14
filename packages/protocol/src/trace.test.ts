import { describe, expect, it } from "vitest";
import {
  DEVIATION_EVENT_TYPES,
  DeviationIdInputSchema,
  DeviationReportedPayloadSchema,
  DeviationResolvedPayloadSchema,
  deviationIdOf,
  ErrorCode,
  EVENT_TYPE_REGISTRY,
  GetTraceInputSchema,
  HUMAN_ONLY_EVENT_TYPES,
  ReportDeviationInputSchema,
  ResolveDeviationInputSchema,
  TracedRequirementInputSchema,
} from "./index.js";

describe("deviations", () => {
  it("registers both types at version 1, never reserved to the creator", () => {
    for (const type of Object.values(DEVIATION_EVENT_TYPES)) {
      expect(EVENT_TYPE_REGISTRY[type]?.version, type).toBe(1);
      expect(HUMAN_ONLY_EVENT_TYPES.has(type), type).toBe(false);
    }
    expect(ErrorCode.DEVIATION_NOT_REPORTABLE).toBe("DEVIATION_NOT_REPORTABLE");
    expect(ErrorCode.REQUIREMENT_NOT_FOUND).toBe("REQUIREMENT_NOT_FOUND");
  });

  it("derives a stable id from the event's ULID, read without case nor spaces", () => {
    expect(deviationIdOf("01JZ00000000000000007M2K9QX4TB")).toBe("V-7M2K9QX4TB");
    expect(DeviationIdInputSchema.parse(" v-7m2k9qx4tb ")).toBe("V-7M2K9QX4TB");
    expect(DeviationIdInputSchema.safeParse("V-1").success).toBe(false);
    expect(DeviationIdInputSchema.safeParse("D-7M2K9QX4TB").success).toBe(false);
  });

  it("reads a traced requirement in upper case, EF-n or ENF-n only", () => {
    expect(TracedRequirementInputSchema.parse(" ef-18 ")).toBe("EF-18");
    expect(TracedRequirementInputSchema.parse("ENF-2")).toBe("ENF-2");
    for (const typed of ["AD-1", "EF-0", "EF-01", "EF18", "x"]) {
      expect(TracedRequirementInputSchema.safeParse(typed).success, typed).toBe(false);
    }
  });

  it("checks the payload of a report", () => {
    const payload = { requirements: ["EF-1", "AD-3"], summary: "Sign-in skips the lockout", pr: 7 };
    expect(DeviationReportedPayloadSchema.parse(payload)).toEqual(payload);
    for (const wrong of [
      { ...payload, requirements: [] },
      { ...payload, requirements: ["EF-1", "EF-1"] },
      { ...payload, requirements: ["ef-1"] },
      { ...payload, summary: "two\nlines" },
      { ...payload, summary: "\u001b[31mred" },
      { ...payload, detail: "bell \u0007" },
      { ...payload, pr: 0 },
      { ...payload, commit: "ABC" },
      { ...payload, story: "1-1" },
    ]) {
      expect(DeviationReportedPayloadSchema.safeParse(wrong).success, JSON.stringify(wrong)).toBe(
        false,
      );
    }
    expect(
      DeviationReportedPayloadSchema.safeParse({ ...payload, detail: "line 1\n\tline 2" }).success,
    ).toBe(true);
  });

  it("checks the payload of a resolution", () => {
    expect(
      DeviationResolvedPayloadSchema.safeParse({ deviation: "V-7M2K9QX4TB", reason: "fixed" })
        .success,
    ).toBe(true);
    expect(
      DeviationResolvedPayloadSchema.safeParse({ deviation: "v-7m2k9qx4tb", reason: "fixed" })
        .success,
    ).toBe(false);
  });

  it("brings the input of report_deviation to its canonical form", () => {
    const input = ReportDeviationInputSchema.parse({
      agent: "qa",
      story: "02-06",
      requirements: ["ef-1", " enf-2 "],
      summary: "drift",
    });
    expect(input.story).toBe("2-6");
    expect(input.requirements).toEqual(["EF-1", "ENF-2"]);
    expect(
      ReportDeviationInputSchema.safeParse({ ...input, pr: 3 }).success,
      "pr is set by the engine",
    ).toBe(false);
    expect(
      ResolveDeviationInputSchema.parse({ agent: "qa", deviation: "v-7m2k9qx4tb", reason: "ok" })
        .deviation,
    ).toBe("V-7M2K9QX4TB");
    expect(GetTraceInputSchema.safeParse({ requirement: "EF-1", extra: 1 }).success).toBe(false);
  });
});
