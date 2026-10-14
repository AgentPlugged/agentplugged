import { describe, expect, it } from "vitest";
import { ReportStatusInputSchema } from "./agent-activity.js";
import { EVENT_TYPE_REGISTRY, isSensitiveEventType } from "./event-types.js";
import { MethodConfigSchema } from "./method-config.js";
import {
  MeasureUsageInputSchema,
  USAGE_EVENT_TYPES,
  UsageMeasuredPayloadSchema,
  UsagePartSchema,
} from "./usage.js";

const ok = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

const MODEL = {
  model: "claude-opus-5-5",
  messages: 3,
  tokens_in: 10,
  tokens_out: 20,
  cache_read: 30,
  cache_write: 40,
  cache_write_1h: 5,
};

const MEASURED = {
  source: "claude-code",
  session: "agent-a68f663c0a14753da",
  agent: "hugo",
  basis: "journal",
  started_at: "2026-10-06T07:24:09.577Z",
  ended_at: "2026-10-06T11:37:05.923Z",
  active_ms: 1000,
  models: [MODEL],
};

describe("usage.measured", () => {
  it("is a known type, at version 1, and sensitive like a cost", () => {
    const spec = EVENT_TYPE_REGISTRY[USAGE_EVENT_TYPES.measured];
    // Version 2: the step and the skill of a part.
    expect(spec?.version).toBe(2);
    expect(isSensitiveEventType("usage.measured")).toBe(true);
  });

  it("accepts a measured session and holds no dollar amount", () => {
    expect(ok(UsageMeasuredPayloadSchema, MEASURED)).toBe(true);
    expect(ok(UsageMeasuredPayloadSchema, { ...MEASURED, usd: 3 })).toBe(false);
    expect(ok(UsageMeasuredPayloadSchema, { ...MEASURED, models: [{ ...MODEL, usd: 3 }] })).toBe(
      false,
    );
  });

  it("refuses an unknown tool or basis, a bad session id, a negative count", () => {
    expect(ok(UsageMeasuredPayloadSchema, { ...MEASURED, source: "cursor" })).toBe(false);
    expect(ok(UsageMeasuredPayloadSchema, { ...MEASURED, basis: "agent" })).toBe(false);
    expect(ok(UsageMeasuredPayloadSchema, { ...MEASURED, session: "../etc" })).toBe(false);
    expect(
      ok(UsageMeasuredPayloadSchema, { ...MEASURED, models: [{ ...MODEL, tokens_in: -1 }] }),
    ).toBe(false);
    expect(ok(UsageMeasuredPayloadSchema, { ...MEASURED, started_at: "yesterday" })).toBe(false);
  });

  it("takes an agent and nothing else as input of measure_usage: no figure comes from an agent", () => {
    expect(ok(MeasureUsageInputSchema, { agent: "noah" })).toBe(true);
    expect(ok(MeasureUsageInputSchema, { agent: "noah", story: "4-3" })).toBe(false);
    expect(ok(MeasureUsageInputSchema, { agent: "noah", tokens: 1 })).toBe(false);
  });
});

const PART = {
  agent: "maya",
  phase: "planning",
  work: { kind: "document", key: "prd" },
  started_at: "2026-10-06T07:24:09.577Z",
  ended_at: "2026-10-06T08:00:00.000Z",
  active_ms: 1000,
  models: [MODEL],
};

describe("the parts of a measured session", () => {
  it("ties a part to its agent, its phase and its work, and holds no dollar amount", () => {
    expect(ok(UsagePartSchema, PART)).toBe(true);
    expect(
      ok(UsagePartSchema, { ...PART, story: "4-3", work: { kind: "story", key: "4-3" } }),
    ).toBe(true);
    expect(ok(UsagePartSchema, { ...PART, phase: undefined })).toBe(true);
    expect(ok(UsagePartSchema, { ...PART, usd: 3 })).toBe(false);
  });

  it("refuses an unknown phase or kind of work, and a work without a key", () => {
    expect(ok(UsagePartSchema, { ...PART, phase: "dreaming" })).toBe(false);
    expect(ok(UsagePartSchema, { ...PART, work: { kind: "mood", key: "x" } })).toBe(false);
    expect(ok(UsagePartSchema, { ...PART, work: { kind: "document", key: "" } })).toBe(false);
  });

  it("is an optional part of the measure: an older measure without it is still read", () => {
    expect(ok(UsageMeasuredPayloadSchema, { ...MEASURED, parts: [PART] })).toBe(true);
    expect(ok(UsageMeasuredPayloadSchema, MEASURED)).toBe(true);
    expect(ok(UsageMeasuredPayloadSchema, { ...MEASURED, parts: [{ ...PART, usd: 1 }] })).toBe(
      false,
    );
  });
});

describe("the step and the skill of a part, with their origin", () => {
  it("accepts a step and a skill named by the tool or deduced from an interval", () => {
    const step = { name: "build", origin: "interval" };
    expect(
      ok(UsagePartSchema, { ...PART, step, skill: { name: "write-prd", origin: "tool" } }),
    ).toBe(true);
    // A plug-in's skill keeps its tool's name.
    expect(
      ok(UsagePartSchema, { ...PART, skill: { name: "brand-voice:writer", origin: "tool" } }),
    ).toBe(true);
  });

  it("refuses an origin that is not one, a step that is not one, and a guess without an origin", () => {
    expect(ok(UsagePartSchema, { ...PART, step: { name: "build", origin: "guess" } })).toBe(false);
    expect(ok(UsagePartSchema, { ...PART, step: { name: "dreaming", origin: "tool" } })).toBe(
      false,
    );
    expect(ok(UsagePartSchema, { ...PART, skill: { name: "write-prd" } })).toBe(false);
    expect(ok(UsagePartSchema, { ...PART, skill: { name: "has space", origin: "tool" } })).toBe(
      false,
    );
    expect(ok(UsagePartSchema, { ...PART, skill: { name: "x", origin: "tool", usd: 1 } })).toBe(
      false,
    );
  });

  it("is at version 2, and an agent may say which skill it starts", () => {
    expect(EVENT_TYPE_REGISTRY["agent.status_reported"]?.version).toBe(2);
    expect(
      ok(ReportStatusInputSchema, { agent: "lina", status: "working", skill: "develop-story" }),
    ).toBe(true);
    expect(
      ok(ReportStatusInputSchema, { agent: "lina", status: "working", skill: "No Skill" }),
    ).toBe(false);
  });
});

describe("method.yaml holds no usage section any more", () => {
  it("refuses a usage section: no way to declare a plan, a cost is the same for everyone", () => {
    const base = { format_version: 2, engine_version: "1.0.0" };
    expect(ok(MethodConfigSchema, base)).toBe(true);
    expect(ok(MethodConfigSchema, { ...base, usage: { billing: "api" } })).toBe(false);
  });
});
