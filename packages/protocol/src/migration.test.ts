import { describe, expect, it } from "vitest";
import {
  ErrorCode,
  EVENT_TYPE_REGISTRY,
  eventTypeUpgrade,
  isSensitiveEventType,
  METHOD_EVENT_TYPES,
  MethodMigratedPayloadSchema,
} from "./index.js";

const payload = {
  from_format: 0,
  to_format: 1,
  from_engine: "1.0.0",
  to_engine: "1.1.0",
  steps: ["test-targets-to-tools"],
};

describe("method.migrated", () => {
  it("is a known type at version 1, never sensitive", () => {
    expect(METHOD_EVENT_TYPES.migrated).toBe("method.migrated");
    expect(EVENT_TYPE_REGISTRY["method.migrated"]?.version).toBe(1);
    expect(eventTypeUpgrade("method.migrated", 1)).toBeUndefined();
    expect(eventTypeUpgrade("method.migrated", 2)?.code).toBe(ErrorCode.UPGRADE_REQUIRED);
    expect(isSensitiveEventType("method.migrated")).toBe(false);
  });

  it("accepts the formats, the engines and the steps", () => {
    expect(MethodMigratedPayloadSchema.safeParse(payload).success).toBe(true);
    const engineOnly = { ...payload, from_format: 1, from_engine: null, steps: [] };
    expect(MethodMigratedPayloadSchema.safeParse(engineOnly).success).toBe(true);
  });

  it("refuses a format going down, a bad version, a bad step id or an unknown field", () => {
    const refused = [
      { ...payload, to_format: 0, from_format: 1 },
      { ...payload, to_engine: "v1.1.0" },
      { ...payload, from_format: -1 },
      { ...payload, from_format: 0.5 },
      { ...payload, steps: ["Not_Kebab"] },
      { ...payload, extra: true },
      { ...payload, steps: [] },
      { ...payload, to_format: 2, steps: ["test-targets-to-tools"] },
      { ...payload, from_format: 1, from_engine: "1.1.0", steps: [] },
    ];
    for (const value of refused) {
      expect(MethodMigratedPayloadSchema.safeParse(value).success).toBe(false);
    }
  });

  it("has the MIGRATION_REQUIRED error code", () => {
    expect(ErrorCode.MIGRATION_REQUIRED).toBe("MIGRATION_REQUIRED");
  });
});
