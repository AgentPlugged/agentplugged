import { describe, expect, it } from "vitest";
import {
  AskCreatorInputSchema,
  CheckpointElicitedPayloadSchema,
  ElicitationChannelSchema,
} from "./elicitation.js";

const PAYLOAD = {
  checkpoint: "G-ABCDEFGHJK",
  decision: "option_chosen",
  option: "paddle",
  source: "elicitation",
  channel: "claude-code",
  form: "a".repeat(64),
};

describe("decisions asked by the engine", () => {
  it("takes only the agent and the checkpoint as the tool's input", () => {
    expect(AskCreatorInputSchema.parse({ agent: "iris", checkpoint: "g-abcdefghjk" })).toEqual({
      agent: "iris",
      checkpoint: "G-ABCDEFGHJK",
    });
    for (const extra of [{ decision: "approved" }, { option: "a" }, { channel: "x" }]) {
      expect(
        AskCreatorInputSchema.safeParse({ agent: "iris", checkpoint: "G-ABCDEFGHJK", ...extra })
          .success,
      ).toBe(false);
    }
  });

  it("records an answer without a quote, its channel and the digest of the form shown", () => {
    expect(CheckpointElicitedPayloadSchema.safeParse(PAYLOAD).success).toBe(true);
    expect(CheckpointElicitedPayloadSchema.safeParse({ ...PAYLOAD, quote: "ok" }).success).toBe(
      false,
    );
    expect(CheckpointElicitedPayloadSchema.safeParse({ ...PAYLOAD, source: "chat" }).success).toBe(
      false,
    );
    expect(
      CheckpointElicitedPayloadSchema.safeParse({ ...PAYLOAD, option: undefined }).success,
    ).toBe(false);
    expect(
      CheckpointElicitedPayloadSchema.safeParse({ ...PAYLOAD, decision: "approved" }).success,
    ).toBe(false);
    expect(
      CheckpointElicitedPayloadSchema.safeParse({ ...PAYLOAD, confirmed: false }).success,
    ).toBe(false);
    expect(
      CheckpointElicitedPayloadSchema.safeParse({ ...PAYLOAD, decision: "waived" }).success,
    ).toBe(false);
  });

  it("names the channel with printable characters only", () => {
    expect(ElicitationChannelSchema.safeParse("Visual Studio Code").success).toBe(true);
    expect(ElicitationChannelSchema.safeParse("claude\ncode").success).toBe(false);
    expect(ElicitationChannelSchema.safeParse("x".repeat(65)).success).toBe(false);
  });
});
