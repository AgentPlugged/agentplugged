import { describe, expect, it } from "vitest";
import {
  EXCHANGE_EVENT_TYPES,
  EXCHANGE_SUMMARY_MAX,
  ExchangeSummarizedPayloadSchema,
  KNOWN_EVENT_TYPES,
  SummarizeInputSchema,
} from "./index.js";

describe("the summary of an exchange", () => {
  it("is one additive fact of the journal", () => {
    expect(EXCHANGE_EVENT_TYPES).toEqual({ summarized: "exchange.summarized" });
    expect(KNOWN_EVENT_TYPES).toContain(EXCHANGE_EVENT_TYPES.summarized);
  });

  it("is one short line of what was asked, decided and promised", () => {
    const summary = "Asked: login page. Decided: email and password. Promised: the plan.";
    expect(ExchangeSummarizedPayloadSchema.safeParse({ summary }).success).toBe(true);
    expect(SummarizeInputSchema.safeParse({ agent: "noah", summary }).success).toBe(true);
  });

  it("refuses an empty note, a long one, a second line and an unknown field", () => {
    expect(SummarizeInputSchema.safeParse({ agent: "noah" }).success).toBe(false);
    expect(ExchangeSummarizedPayloadSchema.safeParse({ summary: "   " }).success).toBe(false);
    const limit = "x".repeat(EXCHANGE_SUMMARY_MAX);
    expect(ExchangeSummarizedPayloadSchema.safeParse({ summary: limit }).success).toBe(true);
    expect(ExchangeSummarizedPayloadSchema.safeParse({ summary: `${limit}x` }).success).toBe(false);
    expect(ExchangeSummarizedPayloadSchema.safeParse({ summary: "a\nb" }).success).toBe(false);
    for (const hidden of ["a b", "a b", "a‮b", "a⁦b"]) {
      expect(ExchangeSummarizedPayloadSchema.safeParse({ summary: hidden }).success).toBe(false);
    }
    expect(
      SummarizeInputSchema.safeParse({ agent: "noah", summary: "a", actor: "human" }).success,
    ).toBe(false);
  });
});
