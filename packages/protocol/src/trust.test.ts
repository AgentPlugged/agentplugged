import { describe, expect, it } from "vitest";
import {
  CheckActionInputSchema,
  CheckpointOpenedPayloadSchema,
  currentEvent,
  EVENT_TYPE_REGISTRY,
  type EventEnvelope,
  ExternalReadPayloadSchema,
  HIGH_RISK_ACTIONS,
  MAX_EVENT_VERSION,
  OpenCheckpointInputSchema,
  parseEventEnvelope,
  RecordExternalReadInputSchema,
  RequestActionInputSchema,
  SESSION_EVENT_TYPES,
} from "./index.js";

const PERMISSION = {
  type: "permission",
  risk: "high",
  irreversible: false,
  recipient_role: "security",
  confirmation: ["presence"],
  title: "Install a dependency: npm install left-pad",
  summary: "Requested: npm install left-pad",
  documents: [],
  blocks: [],
};

describe("untrusted content", () => {
  it("names the high-risk actions in a stable order", () => {
    expect(HIGH_RISK_ACTIONS).toEqual([
      "install_dependency",
      "destructive_command",
      "push_main",
      "force_push",
      "read_secrets",
      "deploy",
      "publish",
      "other",
    ]);
    expect(EVENT_TYPE_REGISTRY[SESSION_EVENT_TYPES.externalRead]?.version).toBe(1);
  });

  it("records why a checkpoint's session was untrusted, which no agent can give", () => {
    const payload = {
      ...PERMISSION,
      source: "untrusted_action",
      request: {
        action: "install_dependency",
        detail: "npm install left-pad",
        digest: "a".repeat(64),
        sessions: ["server:01JZ0000000000000000000000"],
      },
      untrusted: { internet: "ask", reads: [{ tool: "WebFetch", source: "evil.example" }] },
    };
    expect(CheckpointOpenedPayloadSchema.parse(payload)).toEqual(payload);
    expect(
      CheckpointOpenedPayloadSchema.safeParse({
        ...payload,
        untrusted: { internet: "deny", reads: [] },
      }).success,
    ).toBe(false);
    const input = {
      agent: "iris",
      type: "permission",
      risk: "high",
      title: "Install",
      summary: "Install it.",
    };
    expect(OpenCheckpointInputSchema.safeParse(input).success).toBe(true);
    for (const key of ["untrusted", "request", "source"]) {
      expect(OpenCheckpointInputSchema.safeParse({ ...input, [key]: {} }).success, key).toBe(false);
    }
  });

  it("checks the tools' inputs and the read's payload", () => {
    expect(RecordExternalReadInputSchema.safeParse({ tool: "WebFetch", source: "" }).success).toBe(
      true,
    );
    expect(RecordExternalReadInputSchema.safeParse({ source: "x" }).success).toBe(false);
    expect(
      RequestActionInputSchema.safeParse({ agent: "iris", action: "dance", detail: "x" }).success,
    ).toBe(false);
    expect(
      CheckActionInputSchema.safeParse({ action: "install_dependency", command: "npm i x" })
        .success,
    ).toBe(true);
    expect(ExternalReadPayloadSchema.safeParse({ tool: "WebFetch", source: "" }).success).toBe(
      false,
    );
  });
});

describe("checkpoint.opened at version 2", () => {
  const envelope = (v: number, type = "checkpoint.opened", payload: object = PERMISSION) =>
    ({
      v,
      id: "01J9ZQ4V8E3M5N7P9R1S3T5V7X",
      type,
      at: "2026-10-03T08:00:00.000Z",
      actor: { kind: "agent", device: "machine:AAAAAAAAAAAAAAAA", agent: "iris" },
      product: "01JZ0000000000000000000000",
      provenance: "untrusted",
      prev: null,
      payload,
      alg: "ed25519",
      sig: `${"A".repeat(85)}Q`,
    }) as EventEnvelope;

  it("is the current version, and a version 1 one is read as is", () => {
    expect(EVENT_TYPE_REGISTRY["checkpoint.opened"]?.version).toBe(16);
    expect(MAX_EVENT_VERSION).toBe(16);
    expect(parseEventEnvelope(envelope(1)).success).toBe(true);
    const read = currentEvent(envelope(1));
    expect(read.ok && read.event.v).toBe(16);
    expect(read.ok && read.event.payload).toEqual(PERMISSION);
  });

  it("asks for an upgrade beyond what this engine knows, instead of an invalid event", () => {
    const newer = parseEventEnvelope(envelope(17));
    expect(newer.success ? undefined : newer.error.code).toBe("UPGRADE_REQUIRED");
    // A version 2 of a type still at 1 here.
    const status = envelope(2, "agent.progress_reported", { note: "ok" });
    expect(parseEventEnvelope(status).success).toBe(true);
    const upgrade = currentEvent(status);
    expect(upgrade.ok ? undefined : upgrade.error.code).toBe("UPGRADE_REQUIRED");
  });
});
