import { describe, expect, it } from "vitest";
import {
  AnswerCheckpointInputSchema,
  CHAT_EVENT_TYPES,
  CheckpointAnsweredPayloadSchema,
  CheckpointAutoAppliedPayloadSchema,
  CheckpointReopenedPayloadSchema,
  ErrorCode,
  EVENT_TYPE_REGISTRY,
  HUMAN_ONLY_EVENT_TYPES,
  IGNORED_REASONS,
  MethodConfigSchema,
} from "./index.js";

const digest = "a".repeat(64);
const at = "2026-10-03T10:00:00.000Z";

describe("validation level", () => {
  const base = { format_version: 2, engine_version: "1.0.0" };

  it("accepts chat, auto and strict, and nothing else", () => {
    for (const mode of ["chat", "auto", "strict"]) {
      expect(MethodConfigSchema.safeParse({ ...base, validation: { mode } }).success).toBe(true);
    }
    expect(MethodConfigSchema.safeParse({ ...base, validation: { mode: "fast" } }).success).toBe(
      false,
    );
    expect(MethodConfigSchema.safeParse({ ...base, validation: { other: 1 } }).success).toBe(false);
    expect(MethodConfigSchema.safeParse(base).success).toBe(true);
  });
});

describe("answer_checkpoint input", () => {
  const input = { agent: "main", checkpoint: " g-7m2k9qx4tb ", decision: "approved", quote: "ok" };

  it("reads the checkpoint id whatever its case", () => {
    const parsed = AnswerCheckpointInputSchema.parse(input);
    expect(parsed.checkpoint).toBe("G-7M2K9QX4TB");
  });

  it("needs an option with option_chosen only, and a quote", () => {
    expect(
      AnswerCheckpointInputSchema.safeParse({ ...input, decision: "option_chosen" }).success,
    ).toBe(false);
    expect(AnswerCheckpointInputSchema.safeParse({ ...input, option: "a" }).success).toBe(false);
    expect(AnswerCheckpointInputSchema.safeParse({ ...input, quote: "   " }).success).toBe(false);
    expect(
      AnswerCheckpointInputSchema.safeParse({ ...input, decision: "option_chosen", option: "b" })
        .success,
    ).toBe(true);
  });

  it("never takes a proof, an actor, a waiver or a source from the agent", () => {
    for (const extra of [
      { proof: { message: { digest, at } } },
      { actor: "human" },
      { source: "terminal" },
    ]) {
      expect(AnswerCheckpointInputSchema.safeParse({ ...input, ...extra }).success).toBe(false);
    }
    expect(AnswerCheckpointInputSchema.safeParse({ ...input, decision: "waived" }).success).toBe(
      false,
    );
  });

  it("takes an agreement given just before the point opened, as a flag the agent states", () => {
    expect(AnswerCheckpointInputSchema.safeParse({ ...input, anticipated: true }).success).toBe(
      true,
    );
    expect(AnswerCheckpointInputSchema.safeParse({ ...input, anticipated: false }).success).toBe(
      false,
    );
    expect(
      CheckpointAnsweredPayloadSchema.safeParse({
        checkpoint: "G-7M2K9QX4TB",
        decision: "approved",
        source: "chat",
        quote: "ok",
        anticipated: true,
      }).success,
    ).toBe(true);
  });

  it("refuses a session id with spaces or control characters", () => {
    expect(AnswerCheckpointInputSchema.safeParse({ ...input, session: "a b" }).success).toBe(false);
    expect(AnswerCheckpointInputSchema.safeParse({ ...input, session: "abc-123" }).success).toBe(
      true,
    );
  });
});

describe("chat events", () => {
  it("registers the chat types at version 1 (the answer at 2), none reserved to the creator", () => {
    for (const type of Object.values(CHAT_EVENT_TYPES)) {
      expect(EVENT_TYPE_REGISTRY[type]?.version).toBe(type === "checkpoint.answered" ? 2 : 1);
      expect(HUMAN_ONLY_EVENT_TYPES.has(type)).toBe(false);
    }
  });

  it("checks an answer: source chat, a quote, a proof that matches", () => {
    const answer = {
      checkpoint: "G-7M2K9QX4TB",
      decision: "approved",
      source: "chat",
      quote: "valide",
      proof: { message: { digest, at } },
    };
    expect(CheckpointAnsweredPayloadSchema.safeParse(answer).success).toBe(true);
    expect(
      CheckpointAnsweredPayloadSchema.safeParse({ ...answer, source: "terminal" }).success,
    ).toBe(false);
    expect(
      CheckpointAnsweredPayloadSchema.safeParse({
        ...answer,
        proof: { message: { digest, at }, confirmation: { digest, at } },
      }).success,
    ).toBe(false);
    expect(
      CheckpointAnsweredPayloadSchema.safeParse({
        ...answer,
        proof: { message: { digest: "x", at } },
      }).success,
    ).toBe(false);
  });

  it("checks an automatic application and a reopening", () => {
    expect(
      CheckpointAutoAppliedPayloadSchema.safeParse({
        checkpoint: "G-7M2K9QX4TB",
        decision: "option_chosen",
        option: "a",
      }).success,
    ).toBe(true);
    const reopened = { checkpoint: "G-7M2K9QX4TB", source: "chat", quote: "annule" };
    expect(CheckpointReopenedPayloadSchema.safeParse(reopened).success).toBe(true);
    expect(
      CheckpointReopenedPayloadSchema.safeParse({ ...reopened, quote: undefined }).success,
    ).toBe(false);
    expect(
      CheckpointReopenedPayloadSchema.safeParse({ checkpoint: "G-7M2K9QX4TB", source: "terminal" })
        .success,
    ).toBe(true);
    expect(
      CheckpointReopenedPayloadSchema.safeParse({
        checkpoint: "G-7M2K9QX4TB",
        source: "terminal",
        quote: "x",
      }).success,
    ).toBe(false);
  });

  it("adds its codes and its reason at the end of the shared lists", () => {
    // Then the codes of the delegation, of the creator's actions and of the review.
    // CONFIRMATION_REQUIRED is retired: one answer is the whole validation.
    expect(Object.values(ErrorCode).slice(-24, -20)).toEqual([
      "CHAT_QUOTE_NOT_FOUND",
      "CHAT_SESSION_REQUIRED",
      "REVIEW_REQUIRED",
      "CHECKPOINT_NOT_REOPENABLE",
    ]);
    expect(Object.values(ErrorCode)).not.toContain("CONFIRMATION_REQUIRED");
    expect(IGNORED_REASONS.at(-1)).toBe("not_reopenable");
  });
});
