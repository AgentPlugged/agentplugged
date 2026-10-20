import { describe, expect, it } from "vitest";
import {
  CheckpointOpenedPayloadSchema,
  CREATOR_ACTION_KINDS,
  CreatorActionExecutedPayloadSchema,
  CreatorActionRecordSchema,
  CreatorActionSchema,
  ErrorCode,
  engineUpdateRisk,
  OpenCheckpointInputSchema,
  RequestCreatorActionInputSchema,
} from "./index.js";

const RECORD = {
  kind: "ci_waive",
  story: "4-3",
  commit: "a".repeat(40),
  reason: "the runner is down",
} as const;

describe("creator's actions", () => {
  it("knows the actions reserved to the creator, each with its own strict schema", () => {
    expect(CREATOR_ACTION_KINDS).toEqual([
      "ci_waive",
      "deferred_resolve",
      "deferred_drop",
      "trace_resolve",
      "profile",
      "agent_create",
      "agent_edit",
      "agent_enable",
      "agent_disable",
      "forge_repo_create",
      "forge_push_main",
      "forge_merge_ci",
      "step_skip",
      "step_resume",
      "engine_update",
      "release",
      "environment_fix",
      "proof_commands",
      "scope_widen",
    ]);
    expect(CreatorActionSchema.parse({ kind: "ci_waive", story: "04-3" })).toEqual({
      kind: "ci_waive",
      story: "4-3",
    });
    expect(CreatorActionSchema.parse({ kind: "deferred_drop", item: "d-7m2k9qx4tb" })).toEqual({
      kind: "deferred_drop",
      item: "D-7M2K9QX4TB",
    });
    for (const refused of [
      { kind: "ci_waive", story: "4-3", commit: "a".repeat(40) },
      { kind: "rules_set" },
      { kind: "profile" },
      { kind: "agent_edit", id: "helper" },
      { kind: "agent_edit", id: "helper", tier: "huge" },
      { kind: "agent_create", id: "Bad Id" },
      { kind: "trace_resolve", deviation: "D-7M2K9QX4TB" },
    ]) {
      expect(CreatorActionSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(false);
    }
    expect(
      CreatorActionSchema.safeParse({ kind: "agent_edit", id: "helper", tool: "none" }).success,
    ).toBe(true);
  });

  it("asks for an action with a one-line reason, never a risk nor a title", () => {
    const input = { agent: "main", action: { kind: "agent_enable", id: "x" }, reason: "why" };
    expect(RequestCreatorActionInputSchema.safeParse(input).success).toBe(true);
    for (const extra of [{ risk: "low" }, { title: "Waive" }, { reason: "two\nlines" }]) {
      expect(RequestCreatorActionInputSchema.safeParse({ ...input, ...extra }).success).toBe(false);
    }
  });

  it("records the action on a creator_action checkpoint only, which open_checkpoint refuses", () => {
    const opened = {
      type: "creator_action",
      risk: "high",
      irreversible: true,
      recipient_role: "creator",
      confirmation: ["presence", "explicit"],
      title: "Accept story 4-3 without its CI",
      summary: "Reason: the runner is down",
      documents: [],
      blocks: [],
      creator_action: RECORD,
    };
    expect(CheckpointOpenedPayloadSchema.safeParse(opened).success).toBe(true);
    const { creator_action: _, ...bare } = opened;
    expect(CheckpointOpenedPayloadSchema.safeParse(bare).success).toBe(false);
    expect(CheckpointOpenedPayloadSchema.safeParse({ ...opened, type: "permission" }).success).toBe(
      false,
    );
    expect(
      CheckpointOpenedPayloadSchema.safeParse({
        ...opened,
        blocks: [{ action: "story.review", story: "4-3" }],
      }).success,
    ).toBe(false);
    expect(
      OpenCheckpointInputSchema.safeParse({
        agent: "main",
        type: "creator_action",
        risk: "low",
        title: "x",
        summary: "y",
      }).success,
    ).toBe(false);
    expect(CreatorActionRecordSchema.safeParse({ ...RECORD, commit: undefined }).success).toBe(
      false,
    );
  });

  it("carries the action out with its source, a quote going with the chat only", () => {
    const executed = { checkpoint: "G-7M2K9QX4TB", action: RECORD, source: "chat", quote: "oui" };
    expect(CreatorActionExecutedPayloadSchema.safeParse(executed).success).toBe(true);
    const { quote: _, ...terminal } = executed;
    expect(
      CreatorActionExecutedPayloadSchema.safeParse({ ...terminal, source: "terminal" }).success,
    ).toBe(true);
    expect(CreatorActionExecutedPayloadSchema.safeParse(terminal).success).toBe(false);
    expect(
      CreatorActionExecutedPayloadSchema.safeParse({ ...executed, source: "terminal" }).success,
    ).toBe(false);
  });

  it("adds its codes at the end of the shared list", () => {
    // Then the two codes of the delegation (`ROLE_FORBIDDEN`, `DELEGATION_INVALID`) and one of the review.
    expect(Object.values(ErrorCode).slice(-19, -15)).toEqual([
      "CREATOR_ACTION_NOT_RESERVED",
      "CREATOR_ACTION_UNCHANGED",
      "CREATOR_ACTION_STALE",
      "CREATOR_ACTION_FAILED",
    ]);
  });
});

describe("the engine's update", () => {
  it("asks for an installation and the two settings, never for a version", () => {
    expect(CreatorActionSchema.parse({ kind: "engine_update", install: true })).toEqual({
      kind: "engine_update",
      install: true,
    });
    expect(CreatorActionSchema.parse({ kind: "engine_update", check: false, auto: true })).toEqual({
      kind: "engine_update",
      check: false,
      auto: true,
    });
    for (const refused of [
      { kind: "engine_update" },
      { kind: "engine_update", install: false },
      // The version is the engine's reading, never the agent's.
      { kind: "engine_update", install: true, version: "9.9.9" },
      { kind: "engine_update", install: true, registry: "https://example.com" },
      { kind: "engine_update", auto: "yes" },
    ]) {
      expect(CreatorActionSchema.safeParse(refused).success, JSON.stringify(refused)).toBe(false);
    }
  });

  it("records the version the engine read with an installation, and with nothing else", () => {
    const record = { kind: "engine_update", install: true, version: "0.2.0", reason: "yes" };
    expect(CreatorActionRecordSchema.safeParse(record).success).toBe(true);
    expect(CreatorActionRecordSchema.safeParse({ ...record, version: "latest" }).success).toBe(
      false,
    );
    expect(
      CreatorActionRecordSchema.safeParse({ kind: "engine_update", auto: true, reason: "yes" })
        .success,
    ).toBe(true);
    expect(
      CreatorActionRecordSchema.safeParse({
        kind: "engine_update",
        auto: true,
        version: "0.2.0",
        reason: "yes",
      }).success,
    ).toBe(false);
  });

  it("fixes the risk: an installation or the automatic updates change what runs", () => {
    expect(engineUpdateRisk({ install: true })).toBe("medium");
    expect(engineUpdateRisk({ auto: true })).toBe("medium");
    expect(engineUpdateRisk({ auto: false })).toBe("low");
    expect(engineUpdateRisk({})).toBe("low");
  });
});
