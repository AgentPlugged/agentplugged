import { describe, expect, it } from "vitest";
import {
  CHAIN_EVENT_TYPES,
  CHAIN_INSTRUCTION_MAX_CHARS,
  CHAIN_ORDER_CODES,
  ChainControlParamsSchema,
  ChainPauseParamsSchema,
  ChainResumeParamsSchema,
  InstructionGivenPayloadSchema,
  NoahSayParamsSchema,
  ORDER_TYPE_CHAIN_INSTRUCT,
  ORDER_TYPE_CHAIN_SAY,
  ORDER_TYPE_CHAIN_START,
  ORDER_TYPE_NOAH_SAY,
  RetiredChainOrderParamsSchema,
} from "./chain.js";
import { eventTypeSpec } from "./event-types.js";
import { baseOrderTypes } from "./orders.js";

describe("the orders that hold the team", () => {
  it("take an agent by its name, or none for the whole team", () => {
    expect(ChainPauseParamsSchema.safeParse({}).success).toBe(true);
    expect(ChainPauseParamsSchema.safeParse({ agent: "iris" }).success).toBe(true);
    expect(ChainPauseParamsSchema.safeParse({ agent: "Iris" }).success).toBe(false);
    expect(ChainResumeParamsSchema.safeParse({ agent: "iris" }).success).toBe(true);
    expect(ChainControlParamsSchema.safeParse({ agent: "noah" }).success).toBe(true);
    expect(ChainControlParamsSchema.safeParse({ extra: 1 }).success).toBe(false);
  });

  it("read, and ignore, the fields an older device still sends with a pause or a resumption", () => {
    expect(ChainPauseParamsSchema.safeParse({ agent: "iris", when: "after_step" }).success).toBe(
      true,
    );
    expect(ChainPauseParamsSchema.safeParse({ hand: "terminal" }).success).toBe(true);
    expect(ChainResumeParamsSchema.safeParse({ close_session: true }).success).toBe(true);
    expect(ChainPauseParamsSchema.safeParse({ when: "later" }).success).toBe(false);
    expect(ChainPauseParamsSchema.safeParse({ hand: "shell" }).success).toBe(false);
    expect(ChainResumeParamsSchema.safeParse({ close_session: "yes" }).success).toBe(false);
    // The stop never had such a field.
    expect(ChainControlParamsSchema.safeParse({ when: "now" }).success).toBe(false);
  });

  it("have a stable code for every refusal the machine can give", () => {
    expect(Object.values(CHAIN_ORDER_CODES).sort()).toEqual([
      "CHAIN_CONVERSATION_UNAVAILABLE",
      "CHAIN_ENGINE_TOO_OLD",
      "CHAIN_ORDER_RETIRED",
      "CHAIN_PRODUCT_PAUSED",
      "CHAIN_REQUESTS_FULL",
      "CHAIN_TEAM_PAUSED",
      "CHAIN_UNAVAILABLE",
    ]);
  });
});

describe("the orders that were retired", () => {
  it("stay declared, take any parameters and read none of them", () => {
    for (const type of [ORDER_TYPE_CHAIN_START, ORDER_TYPE_CHAIN_INSTRUCT, ORDER_TYPE_CHAIN_SAY]) {
      const spec = baseOrderTypes().get(`order.${type}/v1`);
      expect(spec, type).toBeDefined();
      expect(spec?.target).toBe("primary");
    }
    expect(RetiredChainOrderParamsSchema.safeParse({}).success).toBe(true);
    expect(
      RetiredChainOrderParamsSchema.safeParse({ agent: "iris", text: "x", budget_usd: 3 }).success,
    ).toBe(true);
    expect(RetiredChainOrderParamsSchema.safeParse("text").success).toBe(false);
  });

  it("keep the words of an old instruction out of the order the journal keeps", () => {
    for (const type of [ORDER_TYPE_CHAIN_INSTRUCT, ORDER_TYPE_CHAIN_SAY]) {
      expect(baseOrderTypes().get(`order.${type}/v1`)?.sealedParams, type).toEqual(["text"]);
    }
  });
});

describe("the creator's words in the journal", () => {
  it("are encrypted as an event of their own, and earlier events stay readable", () => {
    expect(eventTypeSpec(CHAIN_EVENT_TYPES.instructionGiven)?.sensitive).toBe(true);
    expect(
      InstructionGivenPayloadSchema.safeParse({
        to: "noah",
        routed_to: "iris",
        text: "Fais court.",
        delivery: "now",
      }).success,
    ).toBe(true);
    expect(
      InstructionGivenPayloadSchema.safeParse({ to: "iris", text: "x", delivery: "chat" }).success,
    ).toBe(true);
    expect(
      InstructionGivenPayloadSchema.safeParse({ to: "iris", text: "x", delivery: "soon" }).success,
    ).toBe(false);
  });
});

describe("the creator's talk with Noah", () => {
  it("takes a bounded message, typed or dictated, and nothing else", () => {
    expect(NoahSayParamsSchema.safeParse({ text: "Où en est-on ?" }).success).toBe(true);
    expect(NoahSayParamsSchema.safeParse({ text: "x", input: "voice" }).success).toBe(true);
    expect(NoahSayParamsSchema.safeParse({ text: "x", input: "text" }).success).toBe(true);
    expect(NoahSayParamsSchema.safeParse({ text: "x", input: "audio" }).success).toBe(false);
    expect(NoahSayParamsSchema.safeParse({ text: "  " }).success).toBe(false);
    expect(NoahSayParamsSchema.safeParse({ text: "" }).success).toBe(false);
    expect(
      NoahSayParamsSchema.safeParse({ text: "x".repeat(CHAIN_INSTRUCTION_MAX_CHARS + 1) }).success,
    ).toBe(false);
    // No audio, no recording, no agent to name: the device transcribes and Noah routes.
    expect(NoahSayParamsSchema.safeParse({ text: "x", audio: "AAAA" }).success).toBe(false);
    expect(NoahSayParamsSchema.safeParse({ text: "x", agent: "iris" }).success).toBe(false);
  });

  it("takes the page the creator looks at: a kind of page and what it singles out, bounded", () => {
    const view = { page: "sprint", item: { kind: "story", id: "4.3", title: "Webhooks" } };
    expect(NoahSayParamsSchema.safeParse({ text: "x", view }).success).toBe(true);
    expect(
      NoahSayParamsSchema.safeParse({ text: "x", view: { page: "docs", section: "retros" } })
        .success,
    ).toBe(true);
    // A page that does not exist, a part that is not a word, a stranger field, a long title: refused.
    expect(NoahSayParamsSchema.safeParse({ text: "x", view: { page: "nowhere" } }).success).toBe(
      false,
    );
    expect(
      NoahSayParamsSchema.safeParse({ text: "x", view: { page: "docs", section: "../x" } }).success,
    ).toBe(false);
    expect(
      NoahSayParamsSchema.safeParse({ text: "x", view: { page: "docs", content: "all of it" } })
        .success,
    ).toBe(false);
    expect(
      NoahSayParamsSchema.safeParse({
        text: "x",
        view: { page: "sprint", item: { kind: "story", id: "1", title: "t".repeat(121) } },
      }).success,
    ).toBe(false);
    expect(
      NoahSayParamsSchema.safeParse({
        text: "x",
        view: { page: "sprint", item: { kind: "story", id: "1", body: "the whole story" } },
      }).success,
    ).toBe(false);
  });

  it("keeps the message out of the order the journal keeps", () => {
    const spec = baseOrderTypes().get(`order.${ORDER_TYPE_NOAH_SAY}/v1`);
    expect(spec?.sealedParams).toEqual(["text", "view"]);
    expect(spec?.target).toBe("primary");
    expect(spec?.risk).toBe("medium");
  });
});
