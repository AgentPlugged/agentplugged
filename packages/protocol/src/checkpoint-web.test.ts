import { describe, expect, it } from "vitest";
import {
  AnswerCheckpointParamsSchema,
  answerBasisFacts,
  answerSourceOf,
  CheckpointWebAnsweredPayloadSchema,
  CheckpointWebHoldCancelledPayloadSchema,
  CheckpointWebHoldFailedPayloadSchema,
  holdsAnswer,
  ORDER_TYPE_ANSWER_CHECKPOINT,
  ORDER_TYPE_UNDO_CHECKPOINT_ANSWER,
  UndoCheckpointAnswerParamsSchema,
} from "./checkpoint-web.js";
import { baseOrderTypes, orderTag } from "./orders.js";

const POINT = "G-7M2K9QX4TB";
const ORDER = "01J9ZQ4V8E3M5N7P9R1S3T5V80";
const DEVICE = "browser:abcdefghijklmnop";
const PHONE = "phone:abcdefghijklmnop";

describe("the answer a browser gives to a checkpoint", () => {
  it("is declared as a signed order for the main machine", () => {
    const declaration = baseOrderTypes().get(orderTag(ORDER_TYPE_ANSWER_CHECKPOINT));
    expect(declaration?.target).toBe("primary");
    expect(declaration?.params).toBe(AnswerCheckpointParamsSchema);
  });

  it("takes a decision, an option for a choice, a note for a refusal", () => {
    const parse = (value: unknown) => AnswerCheckpointParamsSchema.safeParse(value).success;
    expect(parse({ checkpoint: POINT, decision: "approved" })).toBe(true);
    expect(parse({ checkpoint: POINT, decision: "option_chosen", option: "a" })).toBe(true);
    expect(parse({ checkpoint: POINT, decision: "rejected", note: "Not now." })).toBe(true);
    expect(parse({ checkpoint: POINT, decision: "changes_requested", note: "Shorter." })).toBe(
      true,
    );
    // A refusal without a reason, an option without a choice, a waiver, an unknown field.
    expect(parse({ checkpoint: POINT, decision: "rejected" })).toBe(false);
    expect(parse({ checkpoint: POINT, decision: "approved", option: "a" })).toBe(false);
    expect(parse({ checkpoint: POINT, decision: "option_chosen" })).toBe(false);
    expect(parse({ checkpoint: POINT, decision: "waived", note: "x" })).toBe(false);
    expect(parse({ checkpoint: POINT, decision: "approved", extra: 1 })).toBe(false);
    expect(parse({ checkpoint: "G-short", decision: "approved" })).toBe(false);
  });

  it("is recorded with its source, its order and the device that signed it", () => {
    const parse = (value: unknown) => CheckpointWebAnsweredPayloadSchema.safeParse(value).success;
    const base = { checkpoint: POINT, decision: "approved", source: "web", order: ORDER };
    expect(parse({ ...base, device: DEVICE })).toBe(true);
    // Only a web or phone answer, only from a device a machine pairs (never the creator's own key).
    expect(parse({ ...base, device: DEVICE, source: "terminal" })).toBe(false);
    expect(parse({ ...base, device: "human:abcdefghijklmnop" })).toBe(false);
    expect(parse({ ...base })).toBe(false);
  });

  it("names the phone as the source of a phone's answer, and nothing else", () => {
    const parse = (value: unknown) => CheckpointWebAnsweredPayloadSchema.safeParse(value).success;
    const base = { checkpoint: POINT, decision: "approved", order: ORDER };
    expect(parse({ ...base, device: PHONE, source: "mobile" })).toBe(true);
    // The source is the one the device's kind gives: a phone cannot pass for a browser, a browser
    // cannot pass for a phone, a machine answers neither way.
    expect(parse({ ...base, device: PHONE, source: "web" })).toBe(false);
    expect(parse({ ...base, device: DEVICE, source: "mobile" })).toBe(false);
    expect(parse({ ...base, device: "machine:abcdefghijklmnop", source: "mobile" })).toBe(false);
    expect(parse({ ...base, device: "machine:abcdefghijklmnop", source: "web" })).toBe(false);
  });

  it("reads the source from the kind of the device", () => {
    expect(answerSourceOf(DEVICE)).toBe("web");
    expect(answerSourceOf(PHONE)).toBe("mobile");
    expect(answerSourceOf("machine:abcdefghijklmnop")).toBeUndefined();
    expect(answerSourceOf("human:abcdefghijklmnop")).toBeUndefined();
    expect(answerSourceOf("")).toBeUndefined();
  });
});

describe("taking back a held answer", () => {
  it("is a signed order for the main machine that names only the point", () => {
    const declaration = baseOrderTypes().get(orderTag(ORDER_TYPE_UNDO_CHECKPOINT_ANSWER));
    expect(declaration?.target).toBe("primary");
    expect(UndoCheckpointAnswerParamsSchema.safeParse({ checkpoint: POINT }).success).toBe(true);
    expect(
      UndoCheckpointAnswerParamsSchema.safeParse({ checkpoint: POINT, extra: 1 }).success,
    ).toBe(false);
  });

  it("is recorded with the order that took it back and the answer it took back", () => {
    const parse = (value: unknown) =>
      CheckpointWebHoldCancelledPayloadSchema.safeParse(value).success;
    const base = { checkpoint: POINT, held: ORDER, order: ORDER, device: DEVICE };
    expect(parse(base)).toBe(true);
    expect(parse({ ...base, device: "human:abcdefghijklmnop" })).toBe(false);
    expect(parse({ checkpoint: POINT, order: ORDER, device: DEVICE })).toBe(false);
  });

  it("records a held answer the machine could not carry out with short tokens only", () => {
    const parse = (value: unknown) => CheckpointWebHoldFailedPayloadSchema.safeParse(value).success;
    const base = { checkpoint: POINT, held: ORDER, device: DEVICE, code: "MERGE_FAILED" };
    expect(parse(base)).toBe(true);
    expect(parse({ ...base, reason: "head_moved" })).toBe(true);
    // No sentence, no address, no unknown field, no device the creator's own key would give.
    expect(parse({ ...base, reason: "the forge said: https://x.example/y" })).toBe(false);
    expect(parse({ ...base, code: "a long sentence with spaces" })).toBe(false);
    expect(parse({ ...base, message: "x" })).toBe(false);
    expect(parse({ ...base, device: "human:abcdefghijklmnop" })).toBe(false);
  });

  it("holds the answer of a point that can be undone, and of no other", () => {
    expect(holdsAnswer({ risk: "low", irreversible: false })).toBe(true);
    expect(holdsAnswer({ risk: "medium", irreversible: false })).toBe(true);
    expect(holdsAnswer({ risk: "high", irreversible: false })).toBe(false);
    expect(holdsAnswer({ risk: "low", irreversible: true })).toBe(false);
  });

  it("reads the facts a creator judges, in a fixed order, and never a text", () => {
    const point = {
      id: POINT,
      type: "document",
      risk: "low",
      irreversible: false,
      opened_event: ORDER,
      story: null,
      title: "Brief",
      summary: "Le brief.",
    };
    const facts = answerBasisFacts({ checkpoints: { [POINT]: point } }, POINT);
    expect(facts).toBe(
      `{"t":"order.basis.answer/v1","id":"${POINT}","type":"document","risk":"low","irreversible":false,"opened_event":"${ORDER}","verdict":null,"reopened_at":null,"escalated_event":null,"story":null,"ci_commit":null,"ci_status":null}`,
    );
    // A text that was masked, or a point answered meanwhile, is the same point.
    expect(
      answerBasisFacts(
        { checkpoints: { [POINT]: { ...point, summary: "redacted:secret", status: "resolved" } } },
        POINT,
      ),
    ).toBe(facts);
    expect(answerBasisFacts({ checkpoints: {} }, POINT)).toBeUndefined();
    expect(answerBasisFacts(null, POINT)).toBeUndefined();
  });
});
