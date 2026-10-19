import { describe, expect, it } from "vitest";
import {
  CHAIN_EVENT_TYPES,
  CHAIN_INSTRUCTION_MAX_CHARS,
  CHAIN_ORDER_CODES,
  ChainControlParamsSchema,
  ChainInstructParamsSchema,
  ChainPauseParamsSchema,
  ChainResumeParamsSchema,
  ChainSayParamsSchema,
  formatChainNote,
  formatNoahRoute,
  InstructionGivenPayloadSchema,
  NoahSayParamsSchema,
  ORDER_TYPE_CHAIN_SAY,
  ORDER_TYPE_NOAH_SAY,
  parseChainNote,
  parseNoahRoute,
} from "./chain.js";
import { eventTypeSpec } from "./event-types.js";
import { baseOrderTypes } from "./orders.js";

describe("the orders that keep the hand on the agents", () => {
  it("take an agent by its name, or none for the whole team, and a bounded instruction", () => {
    expect(ChainPauseParamsSchema.safeParse({}).success).toBe(true);
    expect(ChainPauseParamsSchema.safeParse({ agent: "iris", when: "after_step" }).success).toBe(
      true,
    );
    expect(ChainPauseParamsSchema.safeParse({ when: "later" }).success).toBe(false);
    expect(ChainPauseParamsSchema.safeParse({ agent: "Iris" }).success).toBe(false);
    expect(ChainControlParamsSchema.safeParse({ agent: "noah" }).success).toBe(true);
    expect(ChainControlParamsSchema.safeParse({ extra: 1 }).success).toBe(false);
    expect(
      ChainInstructParamsSchema.safeParse({ agent: "iris", text: "Fais court." }).success,
    ).toBe(true);
    expect(ChainInstructParamsSchema.safeParse({ agent: "iris", text: "   " }).success).toBe(false);
    expect(ChainInstructParamsSchema.safeParse({ agent: "iris", text: "" }).success).toBe(false);
    expect(
      ChainInstructParamsSchema.safeParse({
        agent: "iris",
        text: "x".repeat(CHAIN_INSTRUCTION_MAX_CHARS + 1),
      }).success,
    ).toBe(false);
    expect(ChainInstructParamsSchema.safeParse({ text: "Fais court." }).success).toBe(false);
  });

  it("keep the creator's words out of the order the journal keeps, and encrypt them as an event", () => {
    const declared = baseOrderTypes().get("order.chain.instruct/v1");
    expect(declared?.sealedParams).toEqual(["text"]);
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
      InstructionGivenPayloadSchema.safeParse({ to: "iris", text: "x", delivery: "soon" }).success,
    ).toBe(false);
  });

  it("tell a pause, a stop and a refusal by stable codes", () => {
    expect(formatChainNote("paused")).toBe("chain:paused");
    expect(parseChainNote("chain:pausing?agent=iris")).toEqual({
      code: "pausing",
      params: { agent: "iris" },
    });
    expect(parseChainNote("chain:halted")?.code).toBe("halted");
    expect(Object.values(CHAIN_ORDER_CODES)).toContain("CHAIN_ALREADY_PAUSED");
  });
});

describe("handing the session over to the creator's terminal", () => {
  it("is asked with the pause, at once and never after the step", () => {
    expect(ChainPauseParamsSchema.safeParse({ hand: "terminal" }).success).toBe(true);
    expect(ChainPauseParamsSchema.safeParse({ hand: "terminal", when: "now" }).success).toBe(true);
    expect(ChainPauseParamsSchema.safeParse({ hand: "terminal", when: "after_step" }).success).toBe(
      false,
    );
    expect(ChainPauseParamsSchema.safeParse({ hand: "shell" }).success).toBe(false);
  });

  it("has its own note and refusals, as stable codes", () => {
    expect(parseChainNote(formatChainNote("handed_over", { agent: "iris" }))).toEqual({
      code: "handed_over",
      params: { agent: "iris" },
    });
    expect(Object.values(CHAIN_ORDER_CODES)).toEqual(
      expect.arrayContaining(["CHAIN_NO_SESSION", "CHAIN_TERMINAL_UNAVAILABLE"]),
    );
  });
});

describe("talking to the agent from a device", () => {
  it("is asked with the pause (chat), then one message at a time, and closing a left-open session is a flag", () => {
    expect(ChainPauseParamsSchema.safeParse({ hand: "chat" }).success).toBe(true);
    expect(ChainPauseParamsSchema.safeParse({ hand: "chat", when: "after_step" }).success).toBe(
      false,
    );
    expect(ChainSayParamsSchema.safeParse({ text: "Montre le plan." }).success).toBe(true);
    expect(ChainSayParamsSchema.safeParse({ text: "x", close_session: true }).success).toBe(true);
    expect(ChainSayParamsSchema.safeParse({ text: "  " }).success).toBe(false);
    expect(ChainSayParamsSchema.safeParse({ text: "" }).success).toBe(false);
    expect(
      ChainSayParamsSchema.safeParse({ text: "x".repeat(CHAIN_INSTRUCTION_MAX_CHARS + 1) }).success,
    ).toBe(false);
    expect(ChainSayParamsSchema.safeParse({ text: "x", agent: "iris" }).success).toBe(false);
    expect(ChainResumeParamsSchema.safeParse({ close_session: true }).success).toBe(true);
    expect(ChainResumeParamsSchema.safeParse({ close_session: "yes" }).success).toBe(false);
  });

  it("keeps the creator's message out of the order the journal keeps", () => {
    const spec = baseOrderTypes().get("order.chain.say/v1");
    expect(spec?.sealedParams).toEqual(["text"]);
    expect(spec?.target).toBe("primary");
    expect(parseChainNote(formatChainNote("conversation", { agent: "iris" }))?.code).toBe(
      "conversation",
    );
    expect(Object.values(CHAIN_ORDER_CODES)).toEqual(
      expect.arrayContaining([
        "CHAIN_TERMINAL_STILL_OPEN",
        "CHAIN_NOT_IN_CONVERSATION",
        "CHAIN_REPLY_PENDING",
        "CHAIN_CONVERSATION_UNAVAILABLE",
        "CHAIN_BUDGET_PENDING",
        "CHAIN_BUDGET_STOPPED",
      ]),
    );
    expect(
      parseChainNote(formatChainNote("budget_paused", { agent: "lina", story: "3-1" })),
    ).toEqual({ code: "budget_paused", params: { agent: "lina", story: "3-1" } });
    expect(
      InstructionGivenPayloadSchema.safeParse({ to: "iris", text: "x", delivery: "chat" }).success,
    ).toBe(true);
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

  it("keeps the message out of the order the journal keeps, like an instruction", () => {
    const spec = baseOrderTypes().get(`order.${ORDER_TYPE_NOAH_SAY}/v1`);
    expect(spec?.sealedParams).toEqual(["text"]);
    expect(spec?.target).toBe("primary");
    expect(spec?.risk).toBe("medium");
  });

  it("tells what became of a handover as a code, never a sentence", () => {
    expect(formatNoahRoute("started", { agent: "iris" })).toBe("noah:started?agent=iris");
    expect(formatNoahRoute("paused")).toBe("noah:paused");
    expect(
      parseNoahRoute(formatNoahRoute("refused", { agent: "iris", code: "CHAIN_PAUSED" })),
    ).toEqual({
      code: "refused",
      params: { agent: "iris", code: "CHAIN_PAUSED" },
    });
    expect(parseNoahRoute("noah:unknown")).toBeUndefined();
    expect(parseNoahRoute("chain:paused")).toBeUndefined();
    expect(parseNoahRoute("Noah a mis l'équipe en pause")).toBeUndefined();
  });
});
