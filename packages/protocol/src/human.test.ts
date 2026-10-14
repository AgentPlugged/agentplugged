import { describe, expect, it } from "vitest";
import {
  CHECKPOINT_STATUSES,
  CheckpointResolvedPayloadSchema,
  currentEvent,
  ErrorCode,
  EVENT_REASON,
  type EventEnvelope,
  HUMAN_DEVICE_PATTERN,
  HUMAN_EVENT_TYPES,
  HUMAN_ONLY_EVENT_TYPES,
  HumanKeyRegisteredPayloadSchema,
  HumanPresenceLinkedPayloadSchema,
  IGNORED_REASONS,
  MAX_WAIVER_DAYS,
  ProjectionWarningSchema,
  RESOLUTION_DECISIONS,
} from "./index.js";

const KEY = `${"A".repeat(42)}E`;
const SIG = `${"A".repeat(85)}Q`;

describe("the creator's key", () => {
  it("names its event types and devices", () => {
    expect(HUMAN_EVENT_TYPES).toEqual({
      keyRegistered: "human.key_registered",
      presenceLinked: "human.presence_linked",
      keyEndorsed: "human.key_endorsed",
    });
    expect([...HUMAN_ONLY_EVENT_TYPES].sort()).toEqual([
      "checkpoint.resolved",
      "human.key_endorsed",
      "human.key_registered",
      "human.presence_linked",
      "story.ci_waived",
      "trust.dismissed",
    ]);
    expect(HUMAN_DEVICE_PATTERN.test("human:abcdefghijklmnop")).toBe(true);
    expect(HUMAN_DEVICE_PATTERN.test("machine:abcdefghijklmnop")).toBe(false);
  });

  it("publishes a 32-byte Ed25519 key", () => {
    expect(HumanKeyRegisteredPayloadSchema.safeParse({ public_key: KEY }).success).toBe(true);
    expect(HumanKeyRegisteredPayloadSchema.safeParse({ public_key: "AAAA" }).success).toBe(false);
    expect(HumanKeyRegisteredPayloadSchema.safeParse({ public_key: KEY, extra: 1 }).success).toBe(
      false,
    );
  });

  it("links a presence credential with the locale key's signature", () => {
    const link = {
      credential_id: "wMHCw8TFxsfIycrLzM3Ozw",
      cose_public_key: "pQECAyYgASFYIA",
      alg: "webauthn-es256",
      locale_signature: SIG,
    };
    expect(HumanPresenceLinkedPayloadSchema.safeParse(link).success).toBe(true);
    expect(HumanPresenceLinkedPayloadSchema.safeParse({ ...link, alg: "ed25519" }).success).toBe(
      false,
    );
    const { locale_signature: _signature, ...unsigned } = link;
    expect(HumanPresenceLinkedPayloadSchema.safeParse(unsigned).success).toBe(false);
  });
});

describe("checkpoint.resolved", () => {
  const base = { checkpoint: "G-7M2K9QX4TB", source: "terminal" };

  it("knows the decisions and the statuses", () => {
    expect(RESOLUTION_DECISIONS).toEqual([
      "approved",
      "approved_with_reservations",
      "rejected",
      "changes_requested",
      "option_chosen",
      "waived",
    ]);
    expect(CHECKPOINT_STATUSES).toEqual(["open", "resolved", "waived", "closed"]);
    expect(MAX_WAIVER_DAYS).toBe(30);
  });

  it.each([
    ["approved", {}],
    ["approved_with_reservations", { note: "coverage at 72" }],
    ["rejected", { note: "not this way" }],
    ["changes_requested", { note: "split the module" }],
    ["option_chosen", { option: "b" }],
    ["waived", { waiver_until: "2026-10-20T00:00:00.000Z" }],
  ])("accepts %s", (decision, fields) => {
    expect(
      CheckpointResolvedPayloadSchema.safeParse({ ...base, decision, ...fields }).success,
    ).toBe(true);
  });

  it.each([
    ["a note missing", { decision: "rejected" }, "note"],
    ["an option missing", { decision: "option_chosen" }, "option"],
    ["an option without option_chosen", { decision: "approved", option: "a" }, "option"],
    ["a deadline missing", { decision: "waived" }, "waiver_until"],
    [
      "a deadline without waived",
      { decision: "approved", waiver_until: "2026-10-20T00:00:00Z" },
      "waiver_until",
    ],
  ])("refuses %s", (_name, fields, path) => {
    const result = CheckpointResolvedPayloadSchema.safeParse({ ...base, ...fields });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual([path]);
  });

  it("refuses another source than the terminal", () => {
    expect(
      CheckpointResolvedPayloadSchema.safeParse({ ...base, decision: "approved", source: "mcp" })
        .success,
    ).toBe(false);
  });

  it("is a known type of the journal", () => {
    const event: EventEnvelope = {
      v: 1,
      id: "01J9ZQ4V8E3M5N7P9R1S3T5V7X",
      type: "checkpoint.resolved",
      at: "2026-10-03T08:00:00.000Z",
      actor: { kind: "human", device: "human:abcdefghijklmnop" },
      product: "01JZ0000000000000000000000",
      provenance: "trusted",
      prev: null,
      payload: { ...base, decision: "approved" },
      alg: "ed25519",
      sig: SIG,
      assurance: "locale",
    };
    expect(currentEvent(event).ok).toBe(true);
  });
});

describe("codes and reasons", () => {
  it("adds the review's code, the human-only reason and the projection's reasons", () => {
    expect(ErrorCode.REVIEW_NOT_INTERACTIVE).toBe("REVIEW_NOT_INTERACTIVE");
    expect(EVENT_REASON.humanOnly).toBe("reason.human_only");
    expect(IGNORED_REASONS).toContain("not_human");
    expect(IGNORED_REASONS).toContain("already_resolved");
    expect(
      ProjectionWarningSchema.safeParse({ code: "locale_on_high_risk", checkpoint: "G-1", id: "x" })
        .success,
    ).toBe(true);
    expect(IGNORED_REASONS).toContain("unendorsed_human");
    expect(IGNORED_REASONS).toContain("checkpoint_unknown");
    expect(ErrorCode.HUMAN_KEY_MISSING).toBe("HUMAN_KEY_MISSING");
    // Expiry is never decided by the projection: evaluated with the clock at read time.
    expect(
      ProjectionWarningSchema.safeParse({
        code: "waiver_expired",
        checkpoint: "G-1",
        waiver_until: "2026-10-20T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});
