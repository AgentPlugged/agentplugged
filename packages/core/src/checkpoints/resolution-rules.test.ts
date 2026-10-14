import { describe, expect, it } from "vitest";
import { withTimeZone } from "../testing/time-zone.js";
import {
  explicitConfirmed,
  parseWaiverAnswer,
  type ResolvableCheckpoint,
  reviewActions,
  waiverDeadlineProblem,
  waiverRefusal,
} from "./resolution-rules.js";

const base: ResolvableCheckpoint = {
  id: "G-7M2K9QX4TB",
  type: "story",
  risk: "low",
  recipient_role: "tech_lead",
  confirmation: ["gesture_undo_10s"],
  options: null,
  verdict: null,
  status: "open",
};
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

describe("reviewActions", () => {
  it("offers approve, reservations, reject, changes and quit", () => {
    expect(reviewActions(base).map((action) => action.kind)).toEqual([
      "approve",
      "approve_with_reservations",
      "reject",
      "request_changes",
      "quit",
    ]);
  });

  it("adds one action per option, and a waiver on a failed verdict", () => {
    const decision: ResolvableCheckpoint = {
      ...base,
      type: "decision",
      options: [
        { id: "a", label: "A", consequence: "x" },
        { id: "b", label: "B", consequence: "y" },
      ],
      verdict: { result: "fail" },
    };
    expect(reviewActions(decision).map((action) => action.kind)).toEqual([
      "approve",
      "approve_with_reservations",
      "reject",
      "request_changes",
      "choose",
      "choose",
      "waive",
      "quit",
    ]);
  });

  it("never offers a waiver on a permission", () => {
    const permission = {
      ...base,
      type: "permission" as const,
      verdict: { result: "fail" as const },
    };
    expect(reviewActions(permission).some((action) => action.kind === "waive")).toBe(false);
    expect(waiverRefusal(permission)).toBe("permission");
  });

  it("refuses a waiver on a security checkpoint, and without a failed verdict", () => {
    expect(
      waiverRefusal({ ...base, recipient_role: "security", verdict: { result: "fail" } }),
    ).toBe("security");
    expect(waiverRefusal({ ...base, verdict: { result: "pass_with_reservations" } })).toBe(
      "no_failed_verdict",
    );
    expect(waiverRefusal({ ...base, verdict: { result: "fail" } })).toBeUndefined();
  });

  it("never waives the end of a phase, even on a failed verdict", () => {
    const end = { ...base, type: "phase_end" as const, verdict: { result: "fail" as const } };
    expect(waiverRefusal(end)).toBe("phase_end");
    expect(reviewActions(end).some((action) => action.kind === "waive")).toBe(false);
  });
});

describe("waiver deadlines", () => {
  it("reads days or a date", () => {
    expect(parseWaiverAnswer("7", NOW)).toBe(new Date(NOW + 7 * DAY).toISOString());
    expect(parseWaiverAnswer("0", NOW)).toBeUndefined();
    expect(parseWaiverAnswer("2026-02-30", NOW)).toBeUndefined();
    expect(parseWaiverAnswer("soon", NOW)).toBeUndefined();
  });

  it("reads a date as the end of that day in local time, whatever the zone", () => {
    const cases: Array<[string, string, string]> = [
      ["America/New_York", "2026-10-20", "2026-10-21T03:59:59.999Z"],
      ["Asia/Kolkata", "2026-10-20", "2026-10-20T18:29:59.999Z"],
      ["Europe/Paris", "2026-10-20", "2026-10-20T21:59:59.999Z"],
      // Around the change of hour: Paris leaves summer time on 25 October, New York on 1 November.
      ["Europe/Paris", "2026-10-24", "2026-10-24T21:59:59.999Z"],
      ["Europe/Paris", "2026-10-25", "2026-10-25T22:59:59.999Z"],
      ["America/New_York", "2026-10-31", "2026-11-01T03:59:59.999Z"],
      ["America/New_York", "2026-11-01", "2026-11-02T04:59:59.999Z"],
      ["UTC", "2026-10-20", "2026-10-20T23:59:59.999Z"],
    ];
    for (const [zone, day, expected] of cases) {
      expect(
        withTimeZone(zone, () => parseWaiverAnswer(day, NOW)),
        `${zone} ${day}`,
      ).toBe(expected);
    }
    // An impossible local date is refused whatever the zone.
    expect(
      withTimeZone("Asia/Kolkata", () => parseWaiverAnswer("2026-02-30", NOW)),
    ).toBeUndefined();
  });

  it("allows 30 days at most, in the future", () => {
    expect(waiverDeadlineProblem(new Date(NOW + 30 * DAY).toISOString(), NOW)).toBeUndefined();
    expect(waiverDeadlineProblem(new Date(NOW + 31 * DAY).toISOString(), NOW)).toBe("too_far");
    expect(waiverDeadlineProblem(new Date(NOW - DAY).toISOString(), NOW)).toBe("past");
    expect(waiverDeadlineProblem("x", NOW)).toBe("invalid");
  });
});

describe("explicitConfirmed", () => {
  it("accepts the checkpoint's id or « je confirme »", () => {
    expect(explicitConfirmed("G-7M2K9QX4TB", base.id)).toBe(true);
    expect(explicitConfirmed(" g-7m2k9qx4tb ", base.id)).toBe(true);
    expect(explicitConfirmed("je  confirme", base.id)).toBe(true);
    expect(explicitConfirmed("I confirm", base.id)).toBe(true);
    expect(explicitConfirmed("oui", base.id)).toBe(false);
    expect(explicitConfirmed("G-7M2K9QX4TC", base.id)).toBe(false);
  });
});
