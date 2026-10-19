import { describe, expect, it } from "vitest";
import { BriefingDataSchema, composeBriefing } from "./briefing-read.js";
import { FilesRequestSchema } from "./repo-files.js";

const ID = "01J9ZQ4V8E3M5N7P9R1S3T5V7X";
const PRODUCT = "01J9ZQ4V8E3M5N7P9R1S3T5V80";
const NOW = Date.parse("2026-10-19T18:00:00Z");
const MIDNIGHT = Date.parse("2026-10-19T00:00:00Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function point(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    status: "open",
    type: "decision",
    risk: "low",
    title: `Point ${id}`,
    opened_by: "maya",
    opened_at: iso(-3_600_000),
    ...extra,
  };
}

const stateOf = (
  points: Array<Record<string, unknown>>,
  stories: Record<string, unknown> = {},
) => ({
  checkpoints: Object.fromEntries(points.map((entry) => [String(entry.id), entry])),
  stories,
});

const evening = (state: ReturnType<typeof stateOf>) =>
  composeBriefing(state, NOW, { part: "evening", dayStart: MIDNIGHT });

describe("the evening briefing", () => {
  it("is asked with a part, and only with a known one", () => {
    const base = { v: 1, id: ID, product: PRODUCT, op: "briefing" };
    expect(FilesRequestSchema.safeParse({ ...base, part: "evening" }).success).toBe(true);
    expect(FilesRequestSchema.safeParse({ ...base, part: "night" }).success).toBe(false);
  });

  it("counts the day from midnight, not from the same hour yesterday", () => {
    const early = iso(-19 * 3_600_000);
    const data = evening(
      stateOf(
        [
          point("G-TODAY000001", { status: "resolved", resolution: { at: iso(-3_600_000) } }),
          point("G-YEST0000001", { status: "resolved", resolution: { at: early } }),
        ],
        {
          "2-1": { merged: { at: iso(-3_600_000) } },
          "2-2": { merged: { at: early } },
        },
      ),
    );
    expect(data.part).toBe("evening");
    expect(data.day).toMatchObject({ merged: 1, decided: 1, published: 0, urgent: 0 });
    // The morning briefing of the same state still looks back 24 hours.
    expect(
      composeBriefing(stateOf([], { "2-2": { merged: { at: early } } }), NOW).progress.merged,
    ).toBe(1);
  });

  it("counts the publications the creator validated today, and not a refusal", () => {
    const data = evening(
      stateOf([
        point("G-PUB00000001", {
          type: "publication",
          status: "resolved",
          resolution: { at: iso(-1000), decision: "approved" },
        }),
        point("G-PUB00000002", {
          type: "publication",
          status: "resolved",
          resolution: { at: iso(-1000), decision: "rejected" },
        }),
        point("G-DEC00000001", {
          status: "resolved",
          resolution: { at: iso(-1000), decision: "approved" },
        }),
      ]),
    );
    expect(data.day).toMatchObject({ published: 1, decided: 3 });
  });

  it("lists the calm points only and counts the urgent ones", () => {
    const data = evening(
      stateOf([
        point("G-CALM0000001"),
        point("G-HIGH000001", { risk: "high" }),
        point("G-BLOCK00001", { blocks: [{ action: "release.deploy" }] }),
      ]),
    );
    expect(data.items.map((item) => item.id)).toEqual(["G-CALM0000001"]);
    expect(data.waiting).toBe(1);
    expect(data.day?.urgent).toBe(2);
    expect(BriefingDataSchema.safeParse(data).success).toBe(true);
  });

  it("leaves the morning briefing exactly as it was", () => {
    const data = composeBriefing(stateOf([point("G-CALM0000001")]), NOW);
    expect(data.part).toBeUndefined();
    expect(data.day).toBeUndefined();
  });

  it("accepts the cost of the day and refuses one that does not fit", () => {
    const data = evening(stateOf([]));
    const costed = {
      ...data,
      day: { ...data.day, cost: { usd: 1.5, nature: "real", tokens: 10 } },
    };
    expect(BriefingDataSchema.safeParse(costed).success).toBe(true);
    const bad = { ...data, day: { ...data.day, cost: { usd: -1, nature: "real", tokens: 10 } } };
    expect(BriefingDataSchema.safeParse(bad).success).toBe(false);
  });
});
