import { describe, expect, it } from "vitest";
import {
  AGENT_EVENT_TYPES,
  AgentResultSchema,
  CostReportedPayloadSchema,
  EVENT_TYPE_REGISTRY,
  formatRunNote,
  GetStateInputSchema,
  parseRunNote,
  RESULT_ITEM_MAX,
  RESULT_ITEMS_MAX,
  RESULT_SUMMARY_MAX,
  ReportCostInputSchema,
  ReportProgressInputSchema,
  ReportStatusInputSchema,
  RUN_NOTE_CODES,
  StoryIdSchema,
  SubmitResultInputSchema,
  UpdateStoryInputSchema,
} from "./index.js";

const RESULT = {
  status: "complete",
  summary: "Brief written.",
  assumptions: ["The market is B2B."],
  open_questions: ["Which pricing?"],
  conflicts: [],
} as const;

describe("agent activity", () => {
  it("registers the five agent event types at version 1, cost.reported and agent.status_reported at 2", () => {
    for (const type of Object.values(AGENT_EVENT_TYPES)) {
      expect(EVENT_TYPE_REGISTRY[type]?.version, type).toBe(
        type === AGENT_EVENT_TYPES.costReported || type === AGENT_EVENT_TYPES.statusReported
          ? 2
          : 1,
      );
    }
  });

  it("accepts the documented inputs", () => {
    expect(
      ReportStatusInputSchema.safeParse({ agent: "iris", status: "working", task: "brief" })
        .success,
    ).toBe(true);
    expect(
      ReportProgressInputSchema.safeParse({ agent: "iris", story: "2-6", percent: 40, note: "ok" })
        .success,
    ).toBe(true);
    expect(
      ReportCostInputSchema.safeParse({ agent: "iris", usd: 0.12, estimated: true }).success,
    ).toBe(true);
    expect(
      UpdateStoryInputSchema.safeParse({ agent: "iris", story: "2-6", status: "in_review" })
        .success,
    ).toBe(true);
    expect(SubmitResultInputSchema.safeParse({ agent: "iris", ...RESULT }).success).toBe(true);
    expect(GetStateInputSchema.safeParse({}).success).toBe(true);
  });

  it("asks for a short summary the creator can read, and says where the long account goes", () => {
    const ok = SubmitResultInputSchema.safeParse({
      agent: "iris",
      ...RESULT,
      summary: "x".repeat(RESULT_SUMMARY_MAX),
    });
    expect(ok.success).toBe(true);
    const long = SubmitResultInputSchema.safeParse({
      agent: "iris",
      ...RESULT,
      summary: "x".repeat(RESULT_SUMMARY_MAX + 1),
    });
    expect(long.success).toBe(false);
    expect(long.error?.issues[0]?.message).toContain("at most 800 characters");
    expect(long.error?.issues[0]?.message).toContain("story.progress notes");
    // The lists are short too: ten items of a sentence or two.
    expect(
      SubmitResultInputSchema.safeParse({
        agent: "iris",
        ...RESULT,
        open_questions: Array.from({ length: RESULT_ITEMS_MAX + 1 }, () => "Which?"),
      }).success,
    ).toBe(false);
    expect(
      SubmitResultInputSchema.safeParse({
        agent: "iris",
        ...RESULT,
        conflicts: ["y".repeat(RESULT_ITEM_MAX + 1)],
      }).success,
    ).toBe(false);
    // A result already in the journal keeps its old bounds: it still reads.
    expect(AgentResultSchema.safeParse({ ...RESULT, summary: "z".repeat(3000) }).success).toBe(
      true,
    );
  });

  it("refuses an actor or kind given in the input (strict schemas)", () => {
    for (const extra of [{ actor: { kind: "human" } }, { kind: "human" }]) {
      const result = ReportStatusInputSchema.safeParse({
        agent: "iris",
        status: "working",
        ...extra,
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.code).toBe("unrecognized_keys");
    }
    expect(GetStateInputSchema.safeParse({ actor: "iris" }).success).toBe(false);
  });

  it("refuses statuses reserved to the creator and out-of-range values", () => {
    expect(
      UpdateStoryInputSchema.safeParse({ agent: "iris", story: "2-6", status: "done" }).success,
    ).toBe(false);
    expect(
      ReportProgressInputSchema.safeParse({ agent: "iris", story: "2-6", percent: 101, note: "x" })
        .success,
    ).toBe(false);
    expect(ReportStatusInputSchema.safeParse({ agent: "Iris", status: "working" }).success).toBe(
      false,
    );
    expect(ReportCostInputSchema.safeParse({ agent: "iris", estimated: false }).success).toBe(
      false,
    );
    expect(CostReportedPayloadSchema.safeParse({ usd: -1, estimated: false }).success).toBe(false);
    expect(
      ReportCostInputSchema.safeParse({ agent: "iris", estimated: true, tokens_in: 1_000_000_000 })
        .success,
    ).toBe(true);
    expect(
      ReportCostInputSchema.safeParse({ agent: "iris", estimated: true, tokens_out: 1_000_000_001 })
        .success,
    ).toBe(false);
  });

  it("checks the structured result", () => {
    expect(AgentResultSchema.safeParse(RESULT).success).toBe(true);
    expect(AgentResultSchema.safeParse({ ...RESULT, status: "done" }).success).toBe(false);
    expect(AgentResultSchema.safeParse({ ...RESULT, summary: "  " }).success).toBe(false);
    const { conflicts: _conflicts, ...missing } = RESULT;
    expect(AgentResultSchema.safeParse(missing).success).toBe(false);
  });

  it("takes only canonical story identifiers (<epic>-<story>)", () => {
    for (const id of ["2-6", "12-104"]) expect(StoryIdSchema.safeParse(id).success).toBe(true);
    for (const id of ["2.6", "story-2-6", "__proto__", "constructor", "", "2-", "-6", "2-6-1"]) {
      expect(StoryIdSchema.safeParse(id).success, id).toBe(false);
    }
  });

  it("tells the consumption and the budget of a run in codes, never in a sentence", () => {
    for (const code of [
      "cost_partial",
      "cost_unknown",
      "budget_exceeded",
      "budget_flagged",
      "activity",
    ] as const) {
      expect(RUN_NOTE_CODES).toContain(code);
      expect(parseRunNote(formatRunNote(code))).toEqual({ code, params: {} });
    }
    expect(parseRunNote(formatRunNote("budget_alert", { percent: 80 }))).toEqual({
      code: "budget_alert",
      params: { percent: "80" },
    });
  });
});
