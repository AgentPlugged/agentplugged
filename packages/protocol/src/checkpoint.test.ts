import { describe, expect, it } from "vitest";
import {
  BranchNameSchema,
  CHECKPOINT_EVENT_TYPES,
  CheckpointIdSchema,
  CheckpointMeasuredPayloadSchema,
  CheckpointOpenedPayloadSchema,
  checkpointIdOf,
  currentEvent,
  ErrorCode,
  EVENT_TYPE_REGISTRY,
  MeasuresSchema,
  OpenCheckpointInputSchema,
  RelativePathSchema,
  ReportMeasuresInputSchema,
} from "./index.js";

const OPTIONS = [
  { id: "a", label: "Stripe", consequence: "Fast to ship." },
  { id: "b", label: "Paddle", consequence: "Handles VAT." },
  { id: "c", label: "Later", consequence: "No payments at launch." },
];

const DECISION = {
  agent: "iris",
  type: "decision",
  risk: "medium",
  title: "Payment provider",
  summary: "Which provider do we launch with?",
  story: "2-6",
  blocks: [{ action: "story.review", story: "2-6" }],
  options: OPTIONS,
  recommendation: "b",
};

function issuePath(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) {
  return result.error?.issues[0]?.path.map(String).join(".");
}

describe("checkpoints", () => {
  it("registers checkpoint.opened at version 16, measured and resolved at version 1", () => {
    for (const type of Object.values(CHECKPOINT_EVENT_TYPES)) {
      expect(EVENT_TYPE_REGISTRY[type]?.version, type).toBe(
        type === CHECKPOINT_EVENT_TYPES.opened ? 16 : 1,
      );
    }
  });

  it("reads a version 1 checkpoint.opened as is, and asks to upgrade for a newer one", () => {
    const payload = {
      type: "document",
      risk: "low",
      irreversible: false,
      recipient_role: "product",
      confirmation: ["gesture_undo_10s"],
      title: "Brief",
      summary: "Read it.",
      documents: [],
      blocks: [],
    };
    const event = {
      v: 1,
      id: "01JZ0000000000000000000001",
      type: CHECKPOINT_EVENT_TYPES.opened,
      at: "2026-10-03T12:00:00.000Z",
      actor: { kind: "agent", device: "machine:AAAAAAAAAAAAAAAA", agent: "iris" },
      product: "01JZ0000000000000000000000",
      provenance: "untrusted",
      prev: null,
      payload,
    } as unknown as Parameters<typeof currentEvent>[0];
    const read = currentEvent(event);
    expect(read.ok && read.event).toMatchObject({ v: 16, payload });
    // An engine that knows version 16 only meets a version 17 with UPGRADE_REQUIRED, as one that
    // knows version 1 only meets a phase_end (version 2): never a silent misreading.
    const newer = currentEvent({ ...event, v: 17 });
    expect(!newer.ok && newer.error.code).toBe(ErrorCode.UPGRADE_REQUIRED);
  });

  it("gives a phase to a phase_end checkpoint, and only to it, without story nor blocks", () => {
    const end = {
      agent: "iris",
      type: "phase_end",
      phase: "framing",
      risk: "low",
      title: "End of framing",
      summary: "The brief is ready.",
    };
    expect(OpenCheckpointInputSchema.safeParse(end).success).toBe(true);
    const { phase: _phase, ...withoutPhase } = end;
    expect(issuePath(OpenCheckpointInputSchema.safeParse(withoutPhase))).toBe("phase");
    expect(issuePath(OpenCheckpointInputSchema.safeParse({ ...end, phase: "later" }))).toBe(
      "phase",
    );
    expect(issuePath(OpenCheckpointInputSchema.safeParse({ ...end, type: "document" }))).toBe(
      "phase",
    );
    expect(issuePath(OpenCheckpointInputSchema.safeParse({ ...end, story: "2-1" }))).toBe("story");
    const blocks = [{ action: "story.review", story: "2-1" }];
    expect(issuePath(OpenCheckpointInputSchema.safeParse({ ...end, blocks }))).toBe("blocks");
    expect(ErrorCode.PHASE_NOT_CURRENT).toBe("PHASE_NOT_CURRENT");
  });

  it("has the CHECKPOINT_OPEN error code", () => {
    expect(ErrorCode.CHECKPOINT_OPEN).toBe("CHECKPOINT_OPEN");
  });

  it("has the FILE_EXISTS error code (history --export)", () => {
    expect(ErrorCode.FILE_EXISTS).toBe("FILE_EXISTS");
  });

  it("draws the id from the last 10 characters of the opening event's ULID", () => {
    const id = checkpointIdOf("01JZ8X4M7QK3V9T2N6R5W8Y0AB");
    expect(id).toBe("G-N6R5W8Y0AB");
    expect(CheckpointIdSchema.safeParse(id).success).toBe(true);
    expect(CheckpointIdSchema.safeParse("G-1").success).toBe(false);
    expect(CheckpointIdSchema.safeParse("G-n6r5w8y0ab").success).toBe(false);
  });

  it("accepts a decision with 2 to 4 options and a recommendation", () => {
    expect(OpenCheckpointInputSchema.safeParse(DECISION).success).toBe(true);
    expect(
      OpenCheckpointInputSchema.safeParse({ ...DECISION, options: OPTIONS.slice(0, 2) }).success,
    ).toBe(true);
  });

  it.each([
    ["one option", { options: OPTIONS.slice(0, 1), recommendation: "a" }, "options"],
    [
      "five options",
      {
        options: [
          ...OPTIONS,
          { id: "d", label: "D", consequence: "d" },
          { id: "e", label: "E", consequence: "e" },
        ],
      },
      "options",
    ],
    ["no options", { options: undefined, recommendation: undefined }, "options"],
    ["no recommendation", { recommendation: undefined }, "recommendation"],
    ["a recommendation outside the options", { recommendation: "z" }, "recommendation"],
    [
      "twice the same option id",
      { options: [OPTIONS[0], { ...OPTIONS[1], id: "a" }], recommendation: "a" },
      "options",
    ],
  ])("refuses a decision with %s", (_name, change, field) => {
    const result = OpenCheckpointInputSchema.safeParse({ ...DECISION, ...change });
    expect(result.success).toBe(false);
    expect(issuePath(result)).toBe(field);
  });

  it("refuses a recommendation without options, and lets other types go without options", () => {
    const story = { ...DECISION, type: "story", options: undefined, recommendation: undefined };
    expect(OpenCheckpointInputSchema.safeParse(story).success).toBe(true);
    const result = OpenCheckpointInputSchema.safeParse({ ...story, recommendation: "a" });
    expect(issuePath(result)).toBe("recommendation");
  });

  it("is strict: no id, actor, or confirmation from the agent", () => {
    for (const extra of ["id", "actor", "confirmation", "status"]) {
      const result = OpenCheckpointInputSchema.safeParse({ ...DECISION, [extra]: "x" });
      expect(result.success, extra).toBe(false);
    }
  });

  it("bounds the title and the summary", () => {
    expect(
      OpenCheckpointInputSchema.safeParse({ ...DECISION, title: "t".repeat(120) }).success,
    ).toBe(true);
    expect(
      OpenCheckpointInputSchema.safeParse({ ...DECISION, title: "t".repeat(121) }).success,
    ).toBe(false);
    expect(
      OpenCheckpointInputSchema.safeParse({ ...DECISION, summary: "s".repeat(2001) }).success,
    ).toBe(false);
  });

  it("checks documents: relative path without '..', branch, blob of 40 or 64 hex", () => {
    const document = { path: "docs/prd.md", branch: "main", blob_sha: "a".repeat(40) };
    const parse = (doc: Record<string, unknown>) =>
      OpenCheckpointInputSchema.safeParse({ ...DECISION, documents: [doc] }).success;
    expect(parse(document)).toBe(true);
    expect(parse({ ...document, blob_sha: "b".repeat(64) })).toBe(true);
    expect(parse({ ...document, blob_sha: "c".repeat(41) })).toBe(false);
    expect(parse({ ...document, blob_sha: "Z".repeat(40) })).toBe(false);
    expect(parse({ ...document, branch: "bad branch" })).toBe(false);
    for (const branch of ["feature/x", "release-1.0", "a.b"]) {
      expect(BranchNameSchema.safeParse(branch).success, branch).toBe(true);
    }
    for (const branch of [
      "-main",
      "a..b",
      "a@{1}",
      "a\\b",
      "a\tb",
      "a\u0001b",
      "a\u007fb",
      "topic.lock",
      "topic/",
    ]) {
      expect(BranchNameSchema.safeParse(branch).success, JSON.stringify(branch)).toBe(false);
    }
    for (const path of [
      "/etc/passwd",
      "\\share",
      "C:/x",
      "../x",
      "docs/../../x",
      "a//b",
      "",
      "./x",
      "docs/./x",
      "docs/.",
    ]) {
      expect(RelativePathSchema.safeParse(path).success, path).toBe(false);
    }
    expect(RelativePathSchema.safeParse("docs/..hidden/x.md").success).toBe(true);
  });

  it("checks blocks and criteria", () => {
    const parse = (change: Record<string, unknown>) =>
      OpenCheckpointInputSchema.safeParse({ ...DECISION, ...change }).success;
    expect(parse({ blocks: [{ action: "release.deploy" }] })).toBe(true);
    // No product-wide block: a block names a story, or the checkpoint has one.
    const storyless = { ...DECISION, story: undefined };
    const result = OpenCheckpointInputSchema.safeParse({
      ...storyless,
      blocks: [{ action: "story.review", story: "2-6" }, { action: "release.deploy" }],
    });
    expect(issuePath(result)).toBe("blocks.1.story");
    expect(
      OpenCheckpointInputSchema.safeParse({
        ...storyless,
        blocks: [{ action: "release.deploy", story: "2-6" }],
      }).success,
    ).toBe(true);
    expect(parse({ blocks: [{ action: "story.validate" }] })).toBe(false);
    expect(parse({ blocks: [{ action: "story.review", story: "2.6" }] })).toBe(false);
    const criterion = {
      id: "tests",
      metric: "tests_failed",
      op: "<=",
      threshold: 0,
      severity: "blocking",
    };
    expect(parse({ criteria: [criterion] })).toBe(true);
    expect(parse({ criteria: [{ ...criterion, op: "<" }] })).toBe(false);
    expect(parse({ criteria: [{ ...criterion, severity: "advisory" }] })).toBe(false);
    expect(parse({ criteria: [{ ...criterion, threshold: Number.NaN }] })).toBe(false);
    expect(parse({ criteria: [criterion, criterion] })).toBe(false);
  });

  it("requires the recorded fields in the payload of checkpoint.opened", () => {
    const { agent: _agent, story: _story, ...rest } = DECISION;
    const payload = {
      ...rest,
      documents: [],
      irreversible: false,
      recipient_role: "product",
      confirmation: ["gesture_undo_10s"],
    };
    expect(CheckpointOpenedPayloadSchema.safeParse(payload).success).toBe(true);
    const { confirmation: _c, ...withoutConfirmation } = payload;
    expect(CheckpointOpenedPayloadSchema.safeParse(withoutConfirmation).success).toBe(false);
    // The story is the envelope's, never the payload's.
    expect(CheckpointOpenedPayloadSchema.safeParse({ ...payload, story: "2-6" }).success).toBe(
      false,
    );
  });

  it("checks measures", () => {
    expect(MeasuresSchema.safeParse({ tests_failed: 0, coverage: 72.5 }).success).toBe(true);
    expect(MeasuresSchema.safeParse({}).success).toBe(false);
    expect(MeasuresSchema.safeParse({ Coverage: 1 }).success).toBe(false);
    expect(MeasuresSchema.safeParse({ coverage: "72" }).success).toBe(false);
    expect(MeasuresSchema.safeParse({ coverage: Number.POSITIVE_INFINITY }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`m${i}`, i]));
    expect(MeasuresSchema.safeParse(many).success).toBe(false);
    expect(
      ReportMeasuresInputSchema.safeParse({
        agent: "iris",
        checkpoint: "G-N6R5W8Y0AB",
        measures: { coverage: 72 },
      }).success,
    ).toBe(true);
    expect(
      CheckpointMeasuredPayloadSchema.safeParse({ checkpoint: "G-1", measures: { coverage: 72 } })
        .success,
    ).toBe(false);
  });

  it("checks a checkpoint.opened payload when the journal is read", () => {
    const event = {
      v: 1,
      id: "01JZ8X4M7QK3V9T2N6R5W8Y0AB",
      type: CHECKPOINT_EVENT_TYPES.opened,
      payload: { type: "decision" },
    } as unknown as Parameters<typeof currentEvent>[0];
    const result = currentEvent(event);
    expect(result.ok).toBe(false);
  });
});
