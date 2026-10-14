import { describe, expect, it } from "vitest";
import { VALIDATION_ASSURANCES, VALIDATION_SOURCES } from "./chat.js";
import {
  CHECKPOINT_DECIDED_EVENT_TYPES,
  CheckpointDecidedPayloadSchema,
  DECIDE_CHOICES,
  DECIDED_DECISIONS,
  DecideCheckpointInputSchema,
} from "./checkpoint-decided.js";
import { CreatorActionSchema } from "./creator-action.js";
import { eventTypeSpec, KNOWN_EVENT_TYPES } from "./event-types.js";
import { MERGE_SOURCES } from "./merge.js";
import {
  DEFAULT_VALIDATION_POINTS,
  MethodConfigSchema,
  VALIDATION_POINTS,
  ValidationSettingsSchema,
} from "./method-config.js";

/** The points the creator keeps, and what an agent decides in their place. */

const BASE = { agent: "quentin", checkpoint: "G-7M2K9QX4TB", reason: "Review done, CI green." };

describe("a point decided by an agent", () => {
  it("is an event type, at version 1, that an agent writes with its reason", () => {
    expect(CHECKPOINT_DECIDED_EVENT_TYPES.decided).toBe("checkpoint.decided");
    expect(KNOWN_EVENT_TYPES).toContain("checkpoint.decided");
    expect(eventTypeSpec("checkpoint.decided")?.version).toBe(1);
    const payload = { checkpoint: "G-7M2K9QX4TB", decision: "approved", reason: "Fine." };
    expect(CheckpointDecidedPayloadSchema.safeParse(payload).success).toBe(true);
    // The reason is required, and a decision is one of the chat's, or an escalation.
    expect(CheckpointDecidedPayloadSchema.safeParse({ ...payload, reason: "  " }).success).toBe(
      false,
    );
    expect(
      CheckpointDecidedPayloadSchema.safeParse({ ...payload, decision: "waived" }).success,
    ).toBe(false);
    expect(DECIDED_DECISIONS).not.toContain("waived");
    expect(DECIDE_CHOICES).toContain("escalate");
    expect(
      CheckpointDecidedPayloadSchema.safeParse({ ...payload, decision: "escalate" }).success,
    ).toBe(true);
  });

  it("takes its option with option_chosen only", () => {
    expect(
      DecideCheckpointInputSchema.safeParse({ ...BASE, decision: "option_chosen", option: "a" })
        .success,
    ).toBe(true);
    expect(
      DecideCheckpointInputSchema.safeParse({ ...BASE, decision: "option_chosen" }).success,
    ).toBe(false);
    expect(
      DecideCheckpointInputSchema.safeParse({ ...BASE, decision: "approved", option: "a" }).success,
    ).toBe(false);
    expect(
      DecideCheckpointInputSchema.safeParse({ ...BASE, decision: "escalate", option: "a" }).success,
    ).toBe(false);
  });

  it("is given the agent and the point as typed, and nothing the agent could forge", () => {
    const parsed = DecideCheckpointInputSchema.parse({
      ...BASE,
      checkpoint: " g-7m2k9qx4tb ",
      decision: "approved",
    });
    expect(parsed.checkpoint).toBe("G-7M2K9QX4TB");
    for (const extra of [{ actor: "human" }, { source: "terminal" }, { quote: "ok" }]) {
      expect(
        DecideCheckpointInputSchema.safeParse({ ...BASE, decision: "approved", ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });

  it("is a source and an assurance of its own, never the creator's", () => {
    expect(VALIDATION_SOURCES).toContain("agent");
    expect(VALIDATION_ASSURANCES).toContain("agent");
    expect(MERGE_SOURCES).toContain("agent");
  });
});

describe("the points of validation", () => {
  it("are six kinds, with four proposed by default", () => {
    expect(VALIDATION_POINTS).toEqual([
      "framing",
      "architecture",
      "breakdown",
      "merge",
      "release",
      "publication",
    ]);
    expect(DEFAULT_VALIDATION_POINTS).toEqual([
      "framing",
      "architecture",
      "release",
      "publication",
    ]);
  });

  it("are recorded in the validation section of method.yaml, unique, possibly none", () => {
    for (const points of [[], ["merge"], [...VALIDATION_POINTS]]) {
      expect(ValidationSettingsSchema.safeParse({ points }).success, points.join()).toBe(true);
    }
    for (const points of [["merge", "merge"], ["everything"], "merge"]) {
      expect(ValidationSettingsSchema.safeParse({ points }).success, JSON.stringify(points)).toBe(
        false,
      );
    }
    const config = {
      format_version: 2,
      engine_version: "1.0.0",
      validation: { mode: "chat", points: ["framing"] },
    };
    expect(MethodConfigSchema.safeParse(config).success).toBe(true);
  });

  it("are a part of the profile action the creator asks for in the chat", () => {
    expect(
      CreatorActionSchema.safeParse({ kind: "profile", points: ["framing", "release"] }).success,
    ).toBe(true);
    expect(CreatorActionSchema.safeParse({ kind: "profile", points: [] }).success).toBe(true);
    expect(CreatorActionSchema.safeParse({ kind: "profile", points: ["x"] }).success).toBe(false);
    expect(CreatorActionSchema.safeParse({ kind: "profile" }).success).toBe(false);
  });
});
