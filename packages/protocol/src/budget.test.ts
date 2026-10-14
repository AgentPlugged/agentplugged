import { describe, expect, it } from "vitest";
import { CostReportedPayloadSchema, ReportCostInputSchema } from "./agent-activity.js";
import {
  BUDGET_EVENT_TYPES,
  BUDGET_OPTIONS,
  BUDGET_RECOMMENDATION,
  BudgetThresholdReachedPayloadSchema,
} from "./budget.js";
import { currentEvent, EVENT_TYPE_REGISTRY } from "./event-types.js";
import { BudgetSettingsSchema, MethodConfigSchema } from "./method-config.js";

const ok = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe("cost.reported version 2", () => {
  it("accepts billing, quota, run and cumulative reports", () => {
    expect(
      ok(CostReportedPayloadSchema, {
        usd: 1.5,
        estimated: false,
        billing: "usage",
        run: "task-1",
        cumulative: true,
      }),
    ).toBe(true);
    expect(ok(CostReportedPayloadSchema, { estimated: true, quota_percent: 12.5 })).toBe(true);
    expect(
      ok(ReportCostInputSchema, {
        agent: "sam",
        story: "1-1",
        usd: 2,
        estimated: true,
        billing: "subscription",
      }),
    ).toBe(true);
  });

  it("refuses a subscription not estimated, a cumulative report without run, and nothing measured", () => {
    expect(
      ok(CostReportedPayloadSchema, { usd: 1, estimated: false, billing: "subscription" }),
    ).toBe(false);
    expect(ok(CostReportedPayloadSchema, { usd: 1, estimated: false, cumulative: true })).toBe(
      false,
    );
    expect(ok(CostReportedPayloadSchema, { estimated: false, billing: "usage" })).toBe(false);
    expect(ok(CostReportedPayloadSchema, { usd: 1, estimated: false, quota_percent: 101 })).toBe(
      false,
    );
    expect(ok(CostReportedPayloadSchema, { usd: 1, estimated: false, run: "../x" })).toBe(false);
    // A leading dot, underscore or hyphen is allowed, as the spec says.
    expect(ok(CostReportedPayloadSchema, { usd: 1, estimated: false, run: "_task.1" })).toBe(true);
  });

  it("reads a version 1 cost as a version 2 delta", () => {
    const event = {
      v: 1,
      id: "01JZ00000000000000000000AB",
      type: "cost.reported",
      at: "2026-10-03T12:00:00.000Z",
      actor: { kind: "agent" as const, agent: "sam", device: "machine:abc" },
      product: "01JZ0000000000000000000000",
      story: "1-1",
      provenance: "trusted" as const,
      payload: { usd: 0.5, estimated: false },
      prev: null,
      alg: "ed25519" as const,
      sig: "x",
    };
    const current = currentEvent(event);
    expect(current.ok && current.event.v).toBe(2);
    expect(current.ok && current.event.payload).toEqual({ usd: 0.5, estimated: false });
  });
});

describe("budget.threshold_reached", () => {
  const alert = {
    level: "alert",
    budget_usd: 10,
    ceiling: "S-7M2K9QX4TB",
    alert_ratio: 0.8,
    on_exceed: "block",
  };

  it("is registered at version 1, in clear", () => {
    const spec = EVENT_TYPE_REGISTRY[BUDGET_EVENT_TYPES.thresholdReached];
    expect(spec?.version).toBe(1);
    expect(spec?.sensitive).toBeUndefined();
  });

  it("carries a checkpoint only with an exceeded level under block, and names its ceiling", () => {
    expect(ok(BudgetThresholdReachedPayloadSchema, alert)).toBe(true);
    expect(ok(BudgetThresholdReachedPayloadSchema, { ...alert, checkpoint: "G-7M2K9QX4TB" })).toBe(
      false,
    );
    const exceeded = { ...alert, level: "exceeded" };
    // Exceeded under block without a checkpoint: one is already open.
    expect(ok(BudgetThresholdReachedPayloadSchema, exceeded)).toBe(true);
    expect(
      ok(BudgetThresholdReachedPayloadSchema, { ...exceeded, checkpoint: "G-7M2K9QX4TB" }),
    ).toBe(true);
    expect(ok(BudgetThresholdReachedPayloadSchema, { ...exceeded, on_exceed: "flag" })).toBe(true);
    expect(ok(BudgetThresholdReachedPayloadSchema, { ...alert, usd: 9 })).toBe(false);
    expect(ok(BudgetThresholdReachedPayloadSchema, { ...alert, ceiling: "X-7M2K9QX4TB" })).toBe(
      false,
    );
    const { ceiling: _ceiling, ...anonymous } = alert;
    expect(ok(BudgetThresholdReachedPayloadSchema, anonymous)).toBe(false);
  });

  it("offers four options and recommends one of them", () => {
    expect(BUDGET_OPTIONS).toContain(BUDGET_RECOMMENDATION);
  });
});

describe("budgets of method.yaml", () => {
  it("accepts an alert ratio and an exceed mode, refuses the rest", () => {
    expect(ok(BudgetSettingsSchema, { alert_ratio: 0.9, on_exceed: "flag" })).toBe(true);
    expect(ok(BudgetSettingsSchema, {})).toBe(true);
    expect(ok(BudgetSettingsSchema, { alert_ratio: 0 })).toBe(false);
    expect(ok(BudgetSettingsSchema, { alert_ratio: 1.2 })).toBe(false);
    expect(ok(BudgetSettingsSchema, { on_exceed: "pause" })).toBe(false);
    expect(ok(BudgetSettingsSchema, { ratio: 0.8 })).toBe(false);
    expect(
      ok(MethodConfigSchema, {
        format_version: 2,
        engine_version: "1.0.0",
        budgets: { alert_ratio: 0.5 },
      }),
    ).toBe(true);
  });
});
