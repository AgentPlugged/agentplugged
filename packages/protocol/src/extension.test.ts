import { describe, expect, it } from "vitest";
import { ErrorCode } from "./error-payload.js";
import { EVENT_TYPE_PATTERN, parseEventEnvelope } from "./event-envelope.js";
import {
  currentEvent,
  eventTypeSpec,
  eventTypeUpgrade,
  isSensitiveEventType,
  KNOWN_EVENT_TYPES,
} from "./event-types.js";
import { extensionModuleOf, isExtensionEventType } from "./extension.js";

const SIGNATURE = "A".repeat(85) + "A";
const HASH = `sha256:${"A".repeat(43)}`;

const envelope = (over: Record<string, unknown> = {}) => ({
  v: 1,
  id: "01JZ0000000000000000000001",
  type: "x.module_a.opened",
  at: "2026-10-19T12:00:00.000Z",
  actor: { kind: "system", device: "machine:abc" },
  product: "01JZ0000000000000000000000",
  provenance: "trusted",
  prev: HASH,
  payload: { anything: ["goes", 1] },
  alg: "ed25519",
  sig: SIGNATURE,
  ...over,
});

describe("extension event types", () => {
  it("names the module of an extension type, and only of one", () => {
    expect(isExtensionEventType("x.module_a.opened")).toBe(true);
    expect(extensionModuleOf("x.module_a.opened")).toBe("module_a");
    expect(extensionModuleOf("agent.status_reported")).toBeUndefined();
    expect(extensionModuleOf("x.module_a")).toBeUndefined();
  });

  it("is a third segment only behind the reserved `x` domain", () => {
    expect(EVENT_TYPE_PATTERN.test("x.module_a.opened")).toBe(true);
    expect(EVENT_TYPE_PATTERN.test("agent.status.reported")).toBe(false);
    expect(EVENT_TYPE_PATTERN.test("agent.status_reported")).toBe(true);
  });

  it("never asks for an upgrade, whatever the module or the version", () => {
    expect(eventTypeUpgrade("x.module_never_seen.opened", 1)).toBeUndefined();
    expect(eventTypeUpgrade("x.module_never_seen.opened", 9)).toBeUndefined();
    // The types of the core still do.
    expect(eventTypeUpgrade("story.teleported", 1)?.code).toBe(ErrorCode.UPGRADE_REQUIRED);
  });

  it("is not in the registry of the core: the engine knows no module", () => {
    expect(eventTypeSpec("x.module_a.opened")).toBeUndefined();
    expect(KNOWN_EVENT_TYPES.some((type) => type.startsWith("x."))).toBe(false);
  });

  it("is always sensitive: its content is encrypted", () => {
    expect(isSensitiveEventType("x.module_never_seen.opened")).toBe(true);
  });

  it("parses as an envelope and is carried as written by currentEvent", () => {
    const parsed = parseEventEnvelope(envelope());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const current = currentEvent(parsed.data);
    expect(current).toEqual({ ok: true, event: parsed.data });
  });

  it("keeps an extension envelope of a future version in the chain, and still asks for the upgrade of a core type", () => {
    expect(parseEventEnvelope(envelope({ v: 99 })).success).toBe(true);
    const core = parseEventEnvelope(envelope({ v: 99, type: "agent.status_reported" }));
    expect(core.success).toBe(false);
    if (!core.success) expect(core.error.code).toBe(ErrorCode.UPGRADE_REQUIRED);
  });
});
