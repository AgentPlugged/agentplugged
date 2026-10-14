import { describe, expect, it } from "vitest";
import {
  currentEvent,
  EVENT_CONVERSIONS,
  EVENT_TYPE_REGISTRY,
  type EventEnvelope,
  eventConversion,
  eventTypeUpgrade,
  isTestEventType,
  JOURNAL_PROJECTED_REF,
  KNOWN_EVENT_TYPES,
  ProjectionStateSchema,
  parseEventEnvelope,
  TEST_EVENT_TYPE,
} from "./index.js";

const event: EventEnvelope = {
  v: 1,
  id: "01J9ZQ4V8E3M5N7P9R1S3T5V7X",
  type: TEST_EVENT_TYPE,
  at: "2026-10-03T08:00:00.000Z",
  actor: { kind: "system", device: "machine:AAAAAAAAAAAAAAAA" },
  product: "01JZ0000000000000000000000",
  provenance: "trusted",
  prev: null,
  payload: { n: 1 },
  alg: "ed25519",
  sig: `${"A".repeat(85)}Q`,
};

describe("event type registry", () => {
  it("knows the engine's types and the test type, at version 1 but checkpoint.opened (10)", () => {
    expect(KNOWN_EVENT_TYPES).toEqual([
      "agent.delegated",
      "agent.progress_reported",
      "agent.result_recorded",
      "agent.status_reported",
      "audit.reported",
      "budget.threshold_reached",
      "checkpoint.answered",
      "checkpoint.auto_applied",
      "checkpoint.closed",
      "checkpoint.decided",
      "checkpoint.elicited",
      "checkpoint.measured",
      "checkpoint.opened",
      "checkpoint.reopened",
      "checkpoint.resolved",
      "cost.reported",
      "course.closed",
      "course.decided",
      "course.opened",
      "creator_action.executed",
      "critique.proposed",
      "critique.reported",
      "critique.settled",
      "deferred.closed",
      "deferred.recorded",
      "deviation.reported",
      "deviation.resolved",
      "device.confirmed",
      "device.paired",
      "device.registered",
      "device.revoked",
      "device.root_certified",
      "git.released",
      "git.workflow_set",
      "human.key_endorsed",
      "human.key_registered",
      "human.presence_linked",
      "hypothesis.closed",
      "install.recorded",
      "lessons.promoted",
      "lessons.recorded",
      "loop.resumed",
      "loop.stopped",
      "memory.retrospective_proposed",
      "method.migrated",
      "product.created",
      "product.key_created",
      "readiness.reported",
      "readiness.settled",
      "requirement.gap_settled",
      "requirement.proved",
      "requirements.registered",
      "review.free_reviewed",
      "session.external_read",
      "sprint.planned",
      "stack.answered",
      "stack.opened",
      "story.attempt_recorded",
      "story.ci_reported",
      "story.ci_waived",
      "story.conflict_qualified",
      "story.criterion_recorded",
      "story.fast_track_checked",
      "story.fast_track_entered",
      "story.fast_track_left",
      "story.merge_refreshed",
      "story.merged",
      "story.pr_opened",
      "story.qa_reported",
      "story.review_published",
      "story.review_triaged",
      "story.reviewed",
      "story.started",
      "story.status_changed",
      "table.closed",
      "table.proposed",
      TEST_EVENT_TYPE,
      "tests.reviewed",
      "trust.dismissed",
      "usage.measured",
      "write.doubted",
      "write.refused",
    ]);
    for (const type of KNOWN_EVENT_TYPES) {
      // `creator_action.executed` is at version 12 (customised skills), `checkpoint.opened` at 14,
      // `requirement.proved` at 2.
      // `checkpoint.elicited` and `stack.answered` are at version 2 (the question tool).
      expect(EVENT_TYPE_REGISTRY[type]?.version, type).toBe(
        type === "checkpoint.opened"
          ? 14
          : type === "creator_action.executed"
            ? 12
            : type === "story.merged"
              ? 3
              : type === "cost.reported" ||
                  type === "checkpoint.closed" ||
                  type === "checkpoint.answered" ||
                  type === "checkpoint.elicited" ||
                  type === "stack.answered" ||
                  type === "usage.measured" ||
                  type === "agent.status_reported" ||
                  type === "requirement.proved"
                ? 2
                : 1,
      );
    }
    expect(JOURNAL_PROJECTED_REF).toBe("refs/agentplugged/projected");
  });

  it("reserves test.* types to tests", () => {
    expect(isTestEventType(TEST_EVENT_TYPE)).toBe(true);
    expect(isTestEventType("device.registered")).toBe(false);
  });

  it("asks for an upgrade on an unknown type or a newer version", () => {
    expect(eventTypeUpgrade(TEST_EVENT_TYPE, 1)).toBeUndefined();
    expect(eventTypeUpgrade(TEST_EVENT_TYPE, 0)).toBeUndefined();
    expect(eventTypeUpgrade("story.teleported", 1)).toEqual({
      code: "UPGRADE_REQUIRED",
      message_key: "error.event_type_upgrade_required",
      details: { type: "story.teleported", version: 1, supported: null },
    });
    expect(eventTypeUpgrade("toString", 1)?.code).toBe("UPGRADE_REQUIRED");
    expect(eventTypeUpgrade(TEST_EVENT_TYPE, 2)?.details).toEqual({
      type: TEST_EVENT_TYPE,
      version: 2,
      supported: 1,
    });
  });

  it("converts the test type from version 0 when reading", () => {
    expect(EVENT_CONVERSIONS.map(({ type, from }) => [type, from])).toEqual([
      [TEST_EVENT_TYPE, 0],
      ["checkpoint.opened", 1],
      ["checkpoint.opened", 2],
      ["checkpoint.opened", 3],
      ["checkpoint.opened", 4],
      ["creator_action.executed", 1],
      ["creator_action.executed", 2],
      ["checkpoint.opened", 5],
      ["creator_action.executed", 3],
      ["checkpoint.opened", 6],
      ["creator_action.executed", 4],
      ["checkpoint.opened", 7],
      ["creator_action.executed", 5],
      ["checkpoint.opened", 8],
      ["creator_action.executed", 6],
      ["checkpoint.opened", 9],
      ["creator_action.executed", 7],
      ["checkpoint.opened", 10],
      ["creator_action.executed", 8],
      ["checkpoint.opened", 11],
      ["creator_action.executed", 9],
      ["checkpoint.opened", 12],
      ["creator_action.executed", 10],
      ["checkpoint.opened", 13],
      ["creator_action.executed", 11],
      ["requirement.proved", 1],
      ["story.merged", 1],
      ["story.merged", 2],
      ["checkpoint.closed", 1],
      ["checkpoint.answered", 1],
      ["checkpoint.elicited", 1],
      ["stack.answered", 1],
      ["cost.reported", 1],
      ["usage.measured", 1],
      ["agent.status_reported", 1],
    ]);
    expect(eventConversion("device.registered", 0)).toBeUndefined();
    const old = { ...event, v: 0, payload: { number: 7, label: "x" } };
    expect(parseEventEnvelope(old).success).toBe(true);
    expect(currentEvent(old)).toEqual({
      ok: true,
      event: { ...event, payload: { label: "x", n: 7 } },
    });
    expect(old.payload).toEqual({ number: 7, label: "x" });
  });

  it("refuses version 0 of a type without a conversion, and names the type of a newer one", () => {
    const registered = { ...event, v: 0, type: "device.registered" };
    expect(parseEventEnvelope(registered)).toMatchObject({
      success: false,
      error: { code: "EVENT_INVALID", details: { field: "v" } },
    });
    expect(parseEventEnvelope({ ...event, v: 15 })).toMatchObject({
      success: false,
      error: { code: "UPGRADE_REQUIRED", details: { type: TEST_EVENT_TYPE, version: 15 } },
    });
    // Version 2 exists for another type: the registry asks for the upgrade.
    expect(currentEvent({ ...event, v: 2 })).toMatchObject({
      ok: false,
      error: { code: "UPGRADE_REQUIRED", details: { type: TEST_EVENT_TYPE, version: 2 } },
    });
  });

  it("checks the payload against its type's schema", () => {
    const registered = { ...event, type: "device.registered", payload: { public_key: "nope" } };
    expect(currentEvent(registered)).toMatchObject({
      ok: false,
      error: { code: "EVENT_INVALID", details: { field: "payload.public_key" } },
    });
    expect(currentEvent({ ...event, type: "story.teleported" })).toMatchObject({
      ok: false,
      error: { code: "UPGRADE_REQUIRED" },
    });
  });
});

describe("state.json format", () => {
  it("accepts a projection and refuses anything else", () => {
    const state = {
      format: 1,
      journal_head: "abc",
      computed_at: "2026-10-03T08:00:00.000Z",
      product: "01JZ0000000000000000000000",
      devices: [{ device: "machine:AAAAAAAAAAAAAAAA", public_key: "k" }],
      applied: 2,
      ignored: [{ id: "01J9ZQ4V8E3M5N7P9R1S3T5V7X", reason: "bad_signature" }],
      warnings: [
        { code: "chain_fork", device: "machine:AAAAAAAAAAAAAAAA", prev: null, ids: ["a", "b"] },
      ],
      state: {},
    };
    expect(ProjectionStateSchema.safeParse(state).success).toBe(true);
    expect(ProjectionStateSchema.safeParse({ ...state, format: 2 }).success).toBe(false);
    const reason = { ...state, ignored: [{ id: "x", reason: "teleported" }] };
    expect(ProjectionStateSchema.safeParse(reason).success).toBe(false);
    // A machine-local warning never goes into state.json.
    const local = { ...state, warnings: [{ code: "history_rewritten", missing: 3 }] };
    expect(ProjectionStateSchema.safeParse(local).success).toBe(false);
  });
});
