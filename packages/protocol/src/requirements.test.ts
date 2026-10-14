import { describe, expect, it } from "vitest";
import { EVENT_TYPE_REGISTRY } from "./event-types.js";
import {
  AUDIT_PILLARS,
  GAP_DECISIONS,
  PROOF_KINDS,
  REQUIREMENT_EVENT_TYPES,
  RecordProofInputSchema,
  RegisteredRequirementInputSchema,
  SettleGapInputSchema,
  SubmitAuditInputSchema,
} from "./requirements.js";

describe("the non-functional requirements", () => {
  it("registers its four event types at version 1, the proof at version 2", () => {
    for (const type of Object.values(REQUIREMENT_EVENT_TYPES)) {
      expect(EVENT_TYPE_REGISTRY[type]?.version, type).toBe(
        type === REQUIREMENT_EVENT_TYPES.proved ? 2 : 1,
      );
    }
  });

  it("names the pillars of the audit and the ways to settle a gap", () => {
    expect(AUDIT_PILLARS).toEqual([
      "quality",
      "architecture",
      "security",
      "dependencies",
      "performance",
      "tests",
      "interface",
      "accessibility",
    ]);
    expect(GAP_DECISIONS).toEqual(["fix", "accept", "defer"]);
    expect(PROOF_KINDS).toEqual(["test", "ci", "analysis", "measure", "review"]);
  });

  it("reads a requirement id as typed, ENF-n and AD-n only", () => {
    expect(RegisteredRequirementInputSchema.parse(" enf-3 ")).toBe("ENF-3");
    expect(RegisteredRequirementInputSchema.parse("ad-12")).toBe("AD-12");
    expect(RegisteredRequirementInputSchema.safeParse("EF-3").success).toBe(false);
    expect(RegisteredRequirementInputSchema.safeParse("ENF-0").success).toBe(false);
  });

  it("asks a proof for its result or its measure, one of them", () => {
    const base = { agent: "quentin", requirement: "enf-1", source: "pnpm bench" };
    expect(RecordProofInputSchema.parse({ ...base, passed: true }).requirement).toBe("ENF-1");
    expect(RecordProofInputSchema.safeParse({ ...base, measured: 120 }).success).toBe(true);
    expect(RecordProofInputSchema.safeParse(base).success).toBe(false);
    expect(RecordProofInputSchema.safeParse({ ...base, passed: true, measured: 1 }).success).toBe(
      false,
    );
    expect(RecordProofInputSchema.safeParse({ ...base, passed: true, kind: "test" }).success).toBe(
      false,
    );
  });

  it("settles a gap with one of three options, the creator's point and their reason", () => {
    const base = {
      agent: "omar",
      requirement: "ENF-1",
      option: "accept",
      checkpoint: "G-0123456789",
      reason: "For the beta.",
    };
    expect(SettleGapInputSchema.safeParse(base).success).toBe(true);
    expect(SettleGapInputSchema.safeParse({ ...base, option: "ignore" }).success).toBe(false);
    expect(SettleGapInputSchema.safeParse({ ...base, reason: "" }).success).toBe(false);
  });

  it("takes an audit report of one result per pillar, closed", () => {
    const report = {
      agent: "quentin",
      results: [
        { pillar: "tests", verdict: "pass", reads: ["src/a.test.ts"], summary: "Covered." },
      ],
      findings: [],
    };
    expect(SubmitAuditInputSchema.safeParse(report).success).toBe(true);
    expect(SubmitAuditInputSchema.safeParse({ ...report, results: [] }).success).toBe(false);
    expect(
      SubmitAuditInputSchema.safeParse({
        ...report,
        results: [{ ...report.results[0], pillar: "style" }],
      }).success,
    ).toBe(false);
    expect(
      SubmitAuditInputSchema.safeParse({
        ...report,
        findings: [{ pillar: "tests", severity: "minor", where: "x", what: "y", action: "fix" }],
      }).success,
    ).toBe(false);
    // An absolute path is not a read of the repository.
    expect(
      SubmitAuditInputSchema.safeParse({
        ...report,
        results: [{ ...report.results[0], reads: ["/etc/passwd"] }],
      }).success,
    ).toBe(false);
  });
});
