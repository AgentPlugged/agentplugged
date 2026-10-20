import { describe, expect, it } from "vitest";
import {
  baseOrderTypes,
  LiveNoticesSchema,
  NOAH_NOTICE_CAUSES,
  NOAH_NOTICE_KINDS,
  NoahNoticeSchema,
  NoahWakeParamsSchema,
  ORDER_TYPE_NOAH_WAKE,
} from "./index.js";

const BASE = { id: "01J0000000000000000000000A", at: "2026-10-20T10:00:00.000Z" };

describe("the notices given to Noah", () => {
  it("tells a validation with the point, the decision and where it came from", () => {
    const notice = {
      ...BASE,
      kind: "checkpoint_validated",
      checkpoint: "G-0123456789",
      decision: "approved",
      source: "mobile",
    };
    expect(NoahNoticeSchema.safeParse(notice).success).toBe(true);
    expect(
      NoahNoticeSchema.safeParse({ ...notice, note: "Go, but keep the old API." }).success,
    ).toBe(true);
    // A decision no point can take, a source that is no device, a field nobody knows.
    expect(NoahNoticeSchema.safeParse({ ...notice, decision: "maybe" }).success).toBe(false);
    expect(NoahNoticeSchema.safeParse({ ...notice, source: "cli" }).success).toBe(false);
    expect(NoahNoticeSchema.safeParse({ ...notice, run: "now" }).success).toBe(false);
  });

  it("carries a trigger with two short texts, the same way", () => {
    for (const kind of NOAH_NOTICE_KINDS.filter(
      (one) => one !== "checkpoint_validated" && one !== "request",
    )) {
      expect(NoahNoticeSchema.safeParse({ ...BASE, kind, subject: "Weekly digest" }).success).toBe(
        true,
      );
    }
    expect(
      NoahNoticeSchema.safeParse({ ...BASE, kind: "ci", subject: "x".repeat(121) }).success,
    ).toBe(false);
    expect(
      NoahNoticeSchema.safeParse({ ...BASE, kind: "ci", subject: "CI", detail: "y".repeat(301) })
        .success,
    ).toBe(false);
    expect(NoahNoticeSchema.safeParse({ ...BASE, kind: "other", subject: "x" }).success).toBe(
      false,
    );
  });

  it("is read again by one order that takes no parameter", () => {
    expect(NoahWakeParamsSchema.safeParse({}).success).toBe(true);
    expect(NoahWakeParamsSchema.safeParse({ text: "go" }).success).toBe(false);
    expect(baseOrderTypes().get(`order.${ORDER_TYPE_NOAH_WAKE}/v1`)).toMatchObject({
      risk: "medium",
      target: "primary",
    });
  });

  it("keeps a message of the creator as a request, with its words and how it was given", () => {
    const request = { ...BASE, kind: "request", text: "Stop the pricing page for now." };
    expect(NoahNoticeSchema.safeParse(request).success).toBe(true);
    expect(NoahNoticeSchema.safeParse({ ...request, voice: true }).success).toBe(true);
    expect(NoahNoticeSchema.safeParse({ ...request, text: "" }).success).toBe(false);
    expect(NoahNoticeSchema.safeParse({ ...request, text: "x".repeat(4001) }).success).toBe(false);
    expect(NoahNoticeSchema.safeParse({ ...request, subject: "x" }).success).toBe(false);
  });

  it("says why notices wait in the live reading, among five causes", () => {
    expect([...NOAH_NOTICE_CAUSES]).toEqual(["busy", "held", "paused", "archived", "failed"]);
    expect(LiveNoticesSchema.safeParse({ cause: "paused", count: 2, requests: 1 }).success).toBe(
      true,
    );
    expect(LiveNoticesSchema.safeParse({ cause: "busy", count: 3, requests: 0 }).success).toBe(
      false,
    );
    expect(LiveNoticesSchema.safeParse({ cause: "held", count: 2 }).success).toBe(true);
    expect(LiveNoticesSchema.safeParse({ cause: "held", count: 0 }).success).toBe(false);
    expect(LiveNoticesSchema.safeParse({ cause: "off", count: 1 }).success).toBe(false);
  });
});
