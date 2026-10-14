import { describe, expect, it } from "vitest";
import {
  DeviceRegisteredPayloadSchema,
  ErrorCode,
  EVENT_TYPES,
  ISSUE,
  JOURNAL_REF,
  journalRemoteRef,
  journalSeenRef,
  MACHINE_DEVICE_PATTERN,
  MethodConfigSchema,
  UlidSchema,
} from "./index.js";

describe("journal", () => {
  it("names its branch, its engine event and its errors", () => {
    expect(JOURNAL_REF).toBe("refs/heads/agentplugged/journal");
    expect(EVENT_TYPES.deviceRegistered).toBe("device.registered");
    expect(ErrorCode.JOURNAL_BUSY).toBe("JOURNAL_BUSY");
    expect(ErrorCode.NOT_A_GIT_REPO).toBe("NOT_A_GIT_REPO");
    expect(ErrorCode.JOURNAL_REWRITTEN).toBe("JOURNAL_REWRITTEN");
    expect(ErrorCode.JOURNAL_CONFLICT).toBe("JOURNAL_CONFLICT");
    expect(ErrorCode.JOURNAL_PUSH_REJECTED).toBe("JOURNAL_PUSH_REJECTED");
    expect(ErrorCode.NO_REMOTE).toBe("NO_REMOTE");
    expect(ErrorCode.JOURNAL_REMOTE_UNREACHABLE).toBe("JOURNAL_REMOTE_UNREACHABLE");
    expect(journalRemoteRef("origin")).toBe("refs/agentplugged/remotes/origin/journal");
    expect(journalSeenRef("origin")).toBe("refs/agentplugged/seen/origin");
  });

  it("accepts a 32-byte public key in device.registered, and nothing else", () => {
    const key = "O2onvM62pC1io6jQKm8Nc2UyFXcd4kOmOsBIoYtZ2ik";
    expect(DeviceRegisteredPayloadSchema.parse({ public_key: key })).toEqual({ public_key: key });
    for (const payload of [
      {},
      { public_key: `${key}A` },
      { public_key: "O2onvM62pC1io6jQKm8Nc2UyFXcd4kOmOsBIoYtZ2iz" },
      { public_key: key, extra: 1 },
    ]) {
      expect(DeviceRegisteredPayloadSchema.safeParse(payload).success).toBe(false);
    }
  });

  it("describes a machine device", () => {
    expect(MACHINE_DEVICE_PATTERN.test("machine:gtodCucAWCrfTS_0")).toBe(true);
    expect(MACHINE_DEVICE_PATTERN.test("machine:short")).toBe(false);
  });

  it("validates ULIDs", () => {
    expect(UlidSchema.safeParse("01JZ0000000000000000000000").success).toBe(true);
    expect(UlidSchema.safeParse("81JZ0000000000000000000000").success).toBe(false);
    expect(UlidSchema.safeParse("01JZ000000000000000000000I").success).toBe(false);
  });
});

describe("method.yaml product_id", () => {
  const base = { format_version: 2, engine_version: "0.1.0" };

  it("is optional, and a ULID when present", () => {
    expect(MethodConfigSchema.safeParse(base).success).toBe(true);
    expect(
      MethodConfigSchema.safeParse({ ...base, product_id: "01JZ0000000000000000000000" }).success,
    ).toBe(true);
    const wrong = MethodConfigSchema.safeParse({ ...base, product_id: "my-product" });
    expect(wrong.success).toBe(false);
    expect(wrong.error?.issues[0]?.message).toBe(ISSUE.ulid);
  });
});
