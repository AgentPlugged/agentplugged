import type { CheckpointBlock, CheckpointCriterion, EventEnvelope } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { CHECKPOINT_REDUCERS, type CheckpointState } from "../projection/checkpoint-reducers.js";
import { emptyDraft } from "../projection/reducers.js";
import {
  type BlockingCheckpoint,
  blockedResultCheckpoint,
  blockingCheckpoint,
  checkpointPayload,
  confirmationFor,
  recipientFor,
  satisfies,
  verdictOf,
} from "./checkpoint-rules.js";

const TESTS: CheckpointCriterion = {
  id: "tests",
  metric: "tests_failed",
  op: "<=",
  threshold: 0,
  severity: "blocking",
};
const COVERAGE: CheckpointCriterion = {
  id: "coverage",
  metric: "coverage",
  op: ">=",
  threshold: 80,
  severity: "reservation",
};

describe("recipientFor", () => {
  it.each([
    ["decision", "product"],
    ["document", "product"],
    ["story", "tech_lead"],
    ["release", "tech_lead"],
    ["permission", "security"],
    ["publication", "product"],
    ["phase_end", "product"],
  ] as const)("sends a %s to %s by default", (type, role) => {
    expect(recipientFor(type, "low")).toBe(role);
  });

  it("sends the end of the design phase to tech_lead (the architecture)", () => {
    expect(recipientFor("phase_end", "low", undefined, "design")).toBe("tech_lead");
    expect(recipientFor("phase_end", "low", undefined, "planning")).toBe("product");
  });

  it("writes the end of design for tech_lead, which the projection keeps without a warning", () => {
    const payload = checkpointPayload({
      type: "phase_end",
      phase: "design",
      risk: "low",
      title: "End of design",
      summary: "The architecture is ready.",
    });
    expect(payload).toMatchObject({ recipient_role: "tech_lead", phase: "design", blocks: [] });
    const draft = emptyDraft();
    CHECKPOINT_REDUCERS["checkpoint.opened"]?.(draft, {
      v: 2,
      id: "01JZ0000000000000000000001",
      type: "checkpoint.opened",
      at: "2026-10-03T12:00:00.000Z",
      actor: { kind: "agent", device: "machine:AAAAAAAAAAAAAAAA", agent: "alex" },
      product: "01JZ0000000000000000000000",
      provenance: "untrusted",
      prev: null,
      payload,
    } as unknown as EventEnvelope);
    expect(draft.warnings).toEqual([]);
    const checkpoints = draft.state.checkpoints as Record<string, CheckpointState>;
    expect(Object.values(checkpoints)[0]).toMatchObject({
      type: "phase_end",
      phase: "design",
      recipient_role: "tech_lead",
    });
  });

  it("keeps a role asked only when it is more demanding", () => {
    expect(recipientFor("decision", "low", "creator")).toBe("product");
    expect(recipientFor("decision", "low", "product")).toBe("product");
    expect(recipientFor("decision", "low", "security")).toBe("security");
    expect(recipientFor("story", "medium", "product")).toBe("tech_lead");
  });

  it("raises a high risk to tech_lead at least, security for a permission", () => {
    expect(recipientFor("decision", "high", "creator")).toBe("tech_lead");
    expect(recipientFor("publication", "high")).toBe("tech_lead");
    expect(recipientFor("release", "high", "security")).toBe("security");
    expect(recipientFor("permission", "high", "tech_lead")).toBe("security");
  });
});

describe("confirmationFor", () => {
  it("asks an undoable gesture at low or medium risk, presence at high, never a second confirmation", () => {
    expect(confirmationFor("low")).toEqual(["gesture_undo_10s"]);
    expect(confirmationFor("medium")).toEqual(["gesture_undo_10s"]);
    expect(confirmationFor("high")).toEqual(["presence"]);
  });
});

describe("checkpointPayload", () => {
  it("fills the defaults", () => {
    expect(
      checkpointPayload({
        type: "release",
        risk: "high",
        irreversible: true,
        title: "t",
        summary: "s",
      }),
    ).toEqual({
      type: "release",
      risk: "high",
      irreversible: true,
      recipient_role: "tech_lead",
      confirmation: ["presence"],
      title: "t",
      summary: "s",
      documents: [],
      blocks: [],
    });
  });
});

describe("blockedResultCheckpoint", () => {
  it("opens a medium story checkpoint that blocks completing and reviewing the story", () => {
    const payload = blockedResultCheckpoint("iris", "2-6", {
      summary: "Cannot reach the API.",
      open_questions: ["Which key?", "Which region?"],
    });
    expect(payload).toEqual({
      type: "story",
      risk: "medium",
      irreversible: false,
      recipient_role: "tech_lead",
      confirmation: ["gesture_undo_10s"],
      title: "Blocked: 2-6",
      summary: "Cannot reach the API.\n\nOpen questions:\n- Which key?\n- Which region?",
      documents: [],
      blocks: [
        { action: "story.complete", story: "2-6" },
        { action: "story.review", story: "2-6" },
      ],
      source: "blocked_result",
    });
  });

  it("never cuts a surrogate pair in two", () => {
    const payload = blockedResultCheckpoint("iris", "2-6", {
      summary: `${"x".repeat(1998)}😀tail`,
      open_questions: [],
    });
    expect(payload.summary.isWellFormed()).toBe(true);
    expect(payload.summary.endsWith("…")).toBe(true);
    expect(payload.summary).toBe(`${"x".repeat(1998)}…`);
  });

  it("names the agent without a story, blocks nothing, and cuts a long summary", () => {
    const payload = blockedResultCheckpoint("iris", undefined, {
      summary: "x".repeat(4000),
      open_questions: [],
    });
    expect(payload.title).toBe("Blocked: iris");
    expect(payload.blocks).toEqual([]);
    expect(payload.summary).toHaveLength(2000);
    expect(payload.summary.endsWith("…")).toBe(true);
  });
});

describe("blockingCheckpoint", () => {
  const open = (
    id: string,
    story: string | null,
    blocks: readonly CheckpointBlock[],
    opened_event = `01JZ0000000000000000000${id.slice(-3)}`,
  ): BlockingCheckpoint => ({ id, status: "open", story, blocks, opened_event });

  it("blocks the action on the same story only", () => {
    const checkpoints = [open("G-0000000001", null, [{ action: "story.review", story: "2-6" }])];
    expect(blockingCheckpoint(checkpoints, "story.review", "2-6")?.id).toBe("G-0000000001");
    expect(blockingCheckpoint(checkpoints, "story.review", "2-7")).toBeUndefined();
    expect(blockingCheckpoint(checkpoints, "story.complete", "2-6")).toBeUndefined();
  });

  it("blocks an action without a story whenever any open checkpoint blocks the action", () => {
    const checkpoints = [open("G-0000000001", null, [{ action: "story.complete", story: "2-6" }])];
    expect(blockingCheckpoint(checkpoints, "story.complete", undefined)?.id).toBe("G-0000000001");
    expect(blockingCheckpoint(checkpoints, "story.review", undefined)).toBeUndefined();
  });

  it("takes the checkpoint's story for a block without one, and every story without either", () => {
    const own = [open("G-0000000001", "2-6", [{ action: "story.complete" }])];
    expect(blockingCheckpoint(own, "story.complete", "2-6")?.id).toBe("G-0000000001");
    expect(blockingCheckpoint(own, "story.complete", "2-7")).toBeUndefined();
    const everywhere = [open("G-0000000001", null, [{ action: "story.complete" }])];
    expect(blockingCheckpoint(everywhere, "story.complete", "2-7")?.id).toBe("G-0000000001");
    expect(blockingCheckpoint(everywhere, "story.complete", undefined)?.id).toBe("G-0000000001");
  });

  it("gives the first in opening order (full ULID), not in id order", () => {
    const block: CheckpointBlock[] = [{ action: "story.review", story: "2-6" }];
    const checkpoints = [
      open("G-ZZZZZZZZZ9", null, block, "01JZ00000000000000ZZZZZZZ9"),
      open("G-0000000002", null, block, "01JZ0000010000000000000002"),
    ];
    expect(blockingCheckpoint(checkpoints, "story.review", "2-6")?.id).toBe("G-ZZZZZZZZZ9");
  });
});

describe("verdictOf", () => {
  it("passes with reservations when only a reservation criterion is not met", () => {
    const verdict = verdictOf([TESTS, COVERAGE], { tests_failed: 0, coverage: 72 });
    expect(verdict).toEqual({
      result: "pass_with_reservations",
      reasons: [],
      criteria: [
        { ...TESTS, measure: 0, satisfied: true, reason: null },
        { ...COVERAGE, measure: 72, satisfied: false, reason: null },
      ],
    });
  });

  it("fails on a missing measure, naming it", () => {
    const verdict = verdictOf([TESTS, COVERAGE], { tests_failed: 0 });
    expect(verdict.result).toBe("fail");
    expect(verdict.reasons).toEqual(["missing:coverage"]);
    expect(verdict.criteria[1]).toMatchObject({
      measure: null,
      satisfied: false,
      reason: "missing:coverage",
    });
  });

  it("fails on a blocking criterion not met, and passes when all are met", () => {
    expect(verdictOf([TESTS, COVERAGE], { tests_failed: 2, coverage: 90 }).result).toBe("fail");
    expect(verdictOf([TESTS, COVERAGE], { tests_failed: 0, coverage: 80 }).result).toBe("pass");
  });

  it("compares with >=, <= and ==", () => {
    expect(satisfies(1, ">=", 1)).toBe(true);
    expect(satisfies(0.9, ">=", 1)).toBe(false);
    expect(satisfies(1, "<=", 1)).toBe(true);
    expect(satisfies(1.1, "<=", 1)).toBe(false);
    expect(satisfies(3, "==", 3)).toBe(true);
    expect(satisfies(3.0001, "==", 3)).toBe(false);
  });

  it("ignores measures inherited from Object.prototype", () => {
    const measures = Object.create({ coverage: 99 }) as Record<string, number>;
    expect(verdictOf([COVERAGE], measures).reasons).toEqual(["missing:coverage"]);
  });
});
