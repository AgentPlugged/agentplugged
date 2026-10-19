import { describe, expect, it } from "vitest";
import { CheckpointOpenedPayloadSchema, OpenCheckpointInputSchema } from "./index.js";

const BASE = {
  agent: "iris",
  type: "document",
  risk: "low",
  title: "Brief",
  summary: "The brief, in full.",
};

const parse = (card: unknown) => OpenCheckpointInputSchema.safeParse({ ...BASE, card });

describe("the card of a checkpoint", () => {
  it("is optional, and holds an effect, up to 3 risks and up to 4 opinions", () => {
    expect(OpenCheckpointInputSchema.safeParse(BASE).success).toBe(true);
    const card = {
      effect: "Customers get a reminder three days before a bill is due.",
      risks: ["A wrong address would send the reminder to a stranger."],
      opinions: [{ agent: "chloe", view: "No personal data leaves the product." }],
    };
    expect(parse(card).success).toBe(true);
    expect(parse({ effect: "Faster." }).success).toBe(true);
  });

  it("refuses a card without an effect, an empty list, too many lines or too long a line", () => {
    expect(parse({ risks: ["Something."] }).success).toBe(false);
    expect(parse({ effect: "Ok.", risks: [] }).success).toBe(false);
    expect(parse({ effect: "Ok.", risks: ["a", "b", "c", "d"] }).success).toBe(false);
    expect(parse({ effect: "x".repeat(301) }).success).toBe(false);
    expect(parse({ effect: "Ok.", risks: ["x".repeat(201)] }).success).toBe(false);
    const opinion = { agent: "chloe", view: "Fine." };
    expect(parse({ effect: "Ok.", opinions: Array(5).fill(opinion) }).success).toBe(false);
    const badAgent = [{ agent: "Chloe", view: "Fine." }];
    expect(parse({ effect: "Ok.", opinions: badAgent }).success).toBe(false);
    expect(parse({ effect: "Ok.", extra: 1 }).success).toBe(false);
  });

  it("holds a why: a reason and, when one was weighed, the alternative set aside", () => {
    const why = {
      reason: "Late bills are the first cash loss.",
      rejected: "A reminder on the day.",
    };
    expect(parse({ effect: "Ok.", why }).success).toBe(true);
    expect(parse({ effect: "Ok.", why: { reason: "Because." } }).success).toBe(true);
    expect(parse({ effect: "Ok.", why: { rejected: "Nothing." } }).success).toBe(false);
    expect(parse({ effect: "Ok.", why: { reason: "x".repeat(201) } }).success).toBe(false);
    expect(parse({ effect: "Ok.", why: { reason: "Ok.", extra: 1 } }).success).toBe(false);
  });

  it("is carried by the payload of checkpoint.opened", () => {
    const payload = {
      type: "document",
      risk: "low",
      irreversible: false,
      recipient_role: "product",
      confirmation: ["gesture_undo_10s"],
      title: "Brief",
      summary: "Read it.",
      card: { effect: "Customers see their invoices." },
      documents: [],
      blocks: [],
    };
    expect(CheckpointOpenedPayloadSchema.safeParse(payload).success).toBe(true);
  });
});
