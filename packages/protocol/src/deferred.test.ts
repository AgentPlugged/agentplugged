import { describe, expect, it } from "vitest";
import {
  CompleteDeferredInputSchema,
  DEFERRED_EVENT_TYPES,
  DeferredClosedPayloadSchema,
  DeferredIdInputSchema,
  DeferredIdSchema,
  DeferredReasonSchema,
  DeferredRecordedPayloadSchema,
  DeferWorkInputSchema,
  deferredIdOf,
  ErrorCode,
  EVENT_TYPE_REGISTRY,
  hasControlCharacter,
  MAX_DEFERRED_LOCKS,
} from "./index.js";

const RECORDED = {
  title: "Rate-limit the sign-in form",
  origin: "review",
  owner: "sam",
  locks: ["1-3"],
};

function issuePath(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) {
  return result.error?.issues[0]?.path.map(String).join(".");
}

describe("deferred work", () => {
  it("registers its two types at version 1, and its error codes", () => {
    expect(EVENT_TYPE_REGISTRY[DEFERRED_EVENT_TYPES.recorded]?.version).toBe(1);
    expect(EVENT_TYPE_REGISTRY[DEFERRED_EVENT_TYPES.closed]?.version).toBe(1);
    expect(ErrorCode.DEFERRED_NOT_FOUND).toBe("DEFERRED_NOT_FOUND");
    expect(ErrorCode.DEFERRED_NOT_OPEN).toBe("DEFERRED_NOT_OPEN");
    expect(ErrorCode.STORY_LOCKED).toBe("STORY_LOCKED");
  });

  it("draws a stable D- id from the event's ULID", () => {
    const id = deferredIdOf("01JZ8Q3N4V7M2K9QX4TB");
    expect(id).toBe("D-7M2K9QX4TB");
    expect(DeferredIdSchema.safeParse(id).success).toBe(true);
    expect(DeferredIdSchema.safeParse("d-7m2k9qx4tb").success).toBe(false);
    expect(DeferredIdSchema.safeParse("G-7M2K9QX4TB").success).toBe(false);
  });

  it("checks the recorded payload: strict, one-line title, distinct locks", () => {
    expect(DeferredRecordedPayloadSchema.safeParse(RECORDED).success).toBe(true);
    expect(
      DeferredRecordedPayloadSchema.safeParse({ ...RECORDED, phase: "build", detail: "Why." })
        .success,
    ).toBe(true);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...RECORDED, title: "two\nlines" }, "title"],
      [{ ...RECORDED, title: "x".repeat(201) }, "title"],
      [{ ...RECORDED, origin: "later" }, "origin"],
      [{ ...RECORDED, owner: "Sam" }, "owner"],
      [{ ...RECORDED, locks: ["1-3", "1-3"] }, "locks"],
      [
        { ...RECORDED, locks: Array.from({ length: MAX_DEFERRED_LOCKS + 1 }, (_, i) => `9-${i}`) },
        "locks",
      ],
      [{ ...RECORDED, phase: "someday" }, "phase"],
      [{ ...RECORDED, story: "1-2" }, ""],
    ];
    for (const [payload, path] of cases) {
      const result = DeferredRecordedPayloadSchema.safeParse(payload);
      expect(result.success, JSON.stringify(payload)).toBe(false);
      expect(issuePath(result)).toBe(path);
    }
  });

  it("brings typed ids to their canonical form, and records canonical story ids only", () => {
    const input = DeferWorkInputSchema.parse({
      agent: "quentin",
      title: "Rate-limit",
      origin: "review",
      story: "01-002",
      locks: ["02-06", "3-7"],
    });
    expect(input).toMatchObject({ story: "1-2", locks: ["2-6", "3-7"] });
    expect(
      DeferWorkInputSchema.safeParse({
        agent: "quentin",
        title: "Rate-limit",
        origin: "deliberate",
        locks: ["2-6", "02-06"],
      }).success,
    ).toBe(false);
    expect(DeferredRecordedPayloadSchema.safeParse({ ...RECORDED, locks: ["01-3"] }).success).toBe(
      false,
    );
    expect(DeferredIdInputSchema.parse(" d-7m2k9qx4tb ")).toBe("D-7M2K9QX4TB");
    expect(DeferredIdInputSchema.safeParse("D-1").success).toBe(false);
  });

  it("refuses control characters in titles, details and reasons", () => {
    for (const text of ["Red \u001b[31malert", "bell\u0007", "c1\u0085"]) {
      expect(hasControlCharacter(text, true), JSON.stringify(text)).toBe(true);
      expect(DeferredRecordedPayloadSchema.safeParse({ ...RECORDED, title: text }).success).toBe(
        false,
      );
      expect(DeferredRecordedPayloadSchema.safeParse({ ...RECORDED, detail: text }).success).toBe(
        false,
      );
      expect(DeferredReasonSchema.safeParse(text).success).toBe(false);
    }
    // Line breaks and tabs stay allowed in a detail or a reason, never in a title.
    expect(DeferredReasonSchema.safeParse("first\n\tsecond").success).toBe(true);
    expect(DeferredRecordedPayloadSchema.safeParse({ ...RECORDED, detail: "a\nb" }).success).toBe(
      true,
    );
    expect(DeferredRecordedPayloadSchema.safeParse({ ...RECORDED, title: "a\tb" }).success).toBe(
      false,
    );
  });

  it("checks the closing payload: an item, done or dropped, and a reason", () => {
    const closed = { item: "D-7M2K9QX4TB", outcome: "dropped", reason: "No longer needed." };
    expect(DeferredClosedPayloadSchema.safeParse(closed).success).toBe(true);
    expect(DeferredClosedPayloadSchema.safeParse({ ...closed, outcome: "later" }).success).toBe(
      false,
    );
    expect(DeferredClosedPayloadSchema.safeParse({ ...closed, reason: " " }).success).toBe(false);
  });

  it("asks a review finding for its story, and refuses an actor in the inputs", () => {
    const input = { agent: "quentin", title: "Rate-limit", origin: "review", story: "1-2" };
    expect(DeferWorkInputSchema.safeParse(input).success).toBe(true);
    const { story: _story, ...withoutStory } = input;
    expect(issuePath(DeferWorkInputSchema.safeParse(withoutStory))).toBe("story");
    expect(DeferWorkInputSchema.safeParse({ ...withoutStory, origin: "deliberate" }).success).toBe(
      true,
    );
    expect(DeferWorkInputSchema.safeParse({ ...input, actor: "human" }).success).toBe(false);
    const complete = { agent: "sam", item: "D-7M2K9QX4TB", reason: "Done in 1-3." };
    expect(CompleteDeferredInputSchema.safeParse(complete).success).toBe(true);
    expect(CompleteDeferredInputSchema.safeParse({ ...complete, outcome: "dropped" }).success).toBe(
      false,
    );
  });
});
