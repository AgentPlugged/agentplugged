import { describe, expect, it } from "vitest";
import {
  CheckCiInputSchema,
  CI_EVENT_TYPES,
  CI_UNAVAILABLE_REASONS,
  CiReportedPayloadSchema,
  CiWaivedPayloadSchema,
  ErrorCode,
  EVENT_TYPE_REGISTRY,
  HUMAN_ONLY_EVENT_TYPES,
  MethodConfigSchema,
} from "./index.js";

const PAYLOAD = {
  forge: "github",
  status: "fail",
  checks: 4,
  failed: ["test"],
  pr: 12,
  url: "https://github.com/acme/shop/pull/12",
  commit: "a".repeat(40),
  read_at: "2026-10-04T12:00:00.000Z",
};

describe("story CI", () => {
  it("registers its event types at version 1, the waiver the creator's alone", () => {
    expect(EVENT_TYPE_REGISTRY[CI_EVENT_TYPES.reported]?.version).toBe(1);
    expect(EVENT_TYPE_REGISTRY[CI_EVENT_TYPES.waived]?.version).toBe(1);
    expect(HUMAN_ONLY_EVENT_TYPES.has(CI_EVENT_TYPES.waived)).toBe(true);
    expect(HUMAN_ONLY_EVENT_TYPES.has(CI_EVENT_TYPES.reported)).toBe(false);
    expect(ErrorCode.CI_UNAVAILABLE).toBe("CI_UNAVAILABLE");
    expect(ErrorCode.MERGE_NOT_READY).toBe("MERGE_NOT_READY");
    expect(CI_UNAVAILABLE_REASONS).toContain("head_mismatch");
  });

  it("accepts a report, with or without its pull request, always with its commit", () => {
    expect(CiReportedPayloadSchema.safeParse(PAYLOAD).success).toBe(true);
    const { pr: _pr, url: _url, ...bare } = PAYLOAD;
    expect(
      CiReportedPayloadSchema.safeParse({ ...bare, forge: "gitlab", status: "pass", failed: [] })
        .success,
    ).toBe(true);
    const { commit: _commit, ...noCommit } = PAYLOAD;
    expect(CiReportedPayloadSchema.safeParse(noCommit).success).toBe(false);
  });

  it("refuses failed checks outside a failure, bad addresses, names and extra fields", () => {
    const refused = [
      { ...PAYLOAD, status: "pass" },
      { ...PAYLOAD, url: "http://github.com/acme/shop/pull/12" },
      { ...PAYLOAD, url: "https://github.com/a b" },
      { ...PAYLOAD, failed: ["te\u0007st"] },
      { ...PAYLOAD, failed: [""] },
      { ...PAYLOAD, failed: Array.from({ length: 51 }, (_, index) => `check ${index}`) },
      { ...PAYLOAD, checks: 0 },
      { ...PAYLOAD, commit: "A".repeat(40) },
      { ...PAYLOAD, read_at: "yesterday" },
      { ...PAYLOAD, forge: "bitbucket" },
      { ...PAYLOAD, token: "secret" },
    ];
    for (const payload of refused) {
      expect(CiReportedPayloadSchema.safeParse(payload).success, JSON.stringify(payload)).toBe(
        false,
      );
    }
  });

  it("reads a CI that has not started on the commit as pending, never as a pass", () => {
    const starting = { ...PAYLOAD, status: "pending", checks: 0, failed: [] };
    expect(CiReportedPayloadSchema.safeParse(starting).success).toBe(true);
    for (const wrong of [
      { ...starting, status: "pass" },
      { ...starting, status: "fail" },
    ]) {
      expect(CiReportedPayloadSchema.safeParse(wrong).success).toBe(false);
    }
  });

  it("takes a reason and a commit for a waiver", () => {
    const waiver = { reason: "No CI on this self-hosted forge.", commit: "b".repeat(40) };
    expect(CiWaivedPayloadSchema.safeParse(waiver).success).toBe(true);
    expect(CiWaivedPayloadSchema.safeParse({ ...waiver, reason: " " }).success).toBe(false);
    expect(CiWaivedPayloadSchema.safeParse({ ...waiver, reason: "a".repeat(501) }).success).toBe(
      false,
    );
    expect(CiWaivedPayloadSchema.safeParse({ reason: "x" }).success).toBe(false);
  });

  it("takes an agent, a story and a forced forge as the input of check_ci", () => {
    expect(CheckCiInputSchema.safeParse({ agent: "sam", story: "1-2" }).success).toBe(true);
    expect(
      CheckCiInputSchema.safeParse({ agent: "sam", story: "1-2", forge: "gitlab" }).success,
    ).toBe(true);
    expect(CheckCiInputSchema.safeParse({ agent: "sam", story: "1" }).success).toBe(false);
    expect(CheckCiInputSchema.safeParse({ agent: "sam", story: "1-2", x: 1 }).success).toBe(false);
  });

  it("forces the forge in method.yaml", () => {
    const base = { format_version: 2, engine_version: "1.0.0" };
    expect(MethodConfigSchema.safeParse({ ...base, ci: { forge: "gitlab" } }).success).toBe(true);
    expect(MethodConfigSchema.safeParse({ ...base, ci: { forge: "gitea" } }).success).toBe(false);
  });
});
