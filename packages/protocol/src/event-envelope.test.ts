import { describe, expect, it } from "vitest";
import { EVENT_REASON, isCanonicalBase64url, jsonValueIssue, parseEventEnvelope } from "./index.js";

const ED25519_SIG = `${"A".repeat(85)}Q`;

const base = {
  v: 1,
  id: "01J9ZQ4V8E3M5N7P9R1S3T5V7X",
  type: "story.validated",
  at: "2026-10-03T08:00:00.000Z",
  actor: { kind: "human", device: "laptop-ada" },
  product: "demo",
  provenance: "trusted",
  prev: null,
  payload: { story: "2.2" },
  alg: "ed25519",
  sig: ED25519_SIG,
};

const webauthn = {
  ...base,
  alg: "webauthn-es256",
  sig: { authenticatorData: "AAAA", clientDataJSON: "e30", signature: "MEUCIQ" },
  assurance: "presence",
};

function rejected(input: unknown) {
  const result = parseEventEnvelope(input);
  if (result.success) throw new Error("expected a rejection");
  return result.error;
}

describe("parseEventEnvelope: accepted envelopes", () => {
  it.each([
    ["ed25519 with a payload", base],
    [
      "ed25519 with an encrypted payload",
      {
        ...base,
        payload: undefined,
        payload_enc: {
          alg: "xchacha20poly1305",
          key_id: "pk:AAAAAAAAAAAAAAAA",
          nonce: "bm9uY2U",
          ct: "Y3Q",
        },
      },
    ],
    ["webauthn with assurance", webauthn],
    [
      "an agent with its name, a story and a prev",
      {
        ...base,
        actor: { kind: "agent", device: "laptop-ada", agent: "iris" },
        story: "2.2",
        prev: `sha256:${"A".repeat(42)}E`,
        provenance: "untrusted",
      },
    ],
    ["a date without milliseconds", { ...base, at: "2026-10-03T08:00:00Z" }],
  ])("accepts %s", (_name, input) => {
    const clean = JSON.parse(JSON.stringify(input));
    const result = parseEventEnvelope(clean);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(clean);
  });
});

describe("parseEventEnvelope: EVENT_INVALID", () => {
  it.each([
    [
      "payload and payload_enc together",
      {
        ...base,
        payload_enc: { alg: "x", key_id: "pk:AAAAAAAAAAAAAAAA", nonce: "AA", ct: "AA" },
      },
      "payload_enc",
      EVENT_REASON.payloadExclusive,
    ],
    [
      "neither payload nor payload_enc",
      { ...base, payload: undefined },
      "payload",
      EVENT_REASON.payloadExclusive,
    ],
    [
      "an agent without its name",
      {
        ...base,
        actor: { kind: "agent", device: "d" },
      },
      "actor.agent",
      EVENT_REASON.agentRequired,
    ],
    [
      "a human with an agent name",
      {
        ...base,
        actor: { kind: "human", device: "d", agent: "iris" },
      },
      "actor.agent",
      EVENT_REASON.agentForbidden,
    ],
    [
      "assurance for an agent",
      {
        ...base,
        actor: { kind: "agent", device: "d", agent: "iris" },
        assurance: "locale",
      },
      "assurance",
      EVENT_REASON.assuranceHumanOnly,
    ],
    ["an unknown key", { ...base, extra: 1 }, "extra", EVENT_REASON.unknownField],
    [
      "an unknown actor key",
      {
        ...base,
        actor: { ...base.actor, role: "x" },
      },
      "actor.role",
      EVENT_REASON.unknownField,
    ],
    ["a missing id", { ...base, id: undefined }, "id", EVENT_REASON.required],
    ["a lowercase id", { ...base, id: base.id.toLowerCase() }, "id", EVENT_REASON.ulid],
    ["an id with I", { ...base, id: "01J9ZQ4V8E3M5N7P9R1S3T5V7I" }, "id", EVENT_REASON.ulid],
    ["an uppercase type", { ...base, type: "Story.validated" }, "type", EVENT_REASON.eventType],
    ["a type without action", { ...base, type: "story" }, "type", EVENT_REASON.eventType],
    [
      "a date with an offset",
      { ...base, at: "2026-10-03T10:00:00+02:00" },
      "at",
      EVENT_REASON.utcDatetime,
    ],
    ["a date only", { ...base, at: "2026-10-03" }, "at", EVENT_REASON.utcDatetime],
    [
      "an unknown provenance",
      { ...base, provenance: "maybe" },
      "provenance",
      EVENT_REASON.invalidValue,
    ],
    ["a missing prev", { ...base, prev: undefined }, "prev", EVENT_REASON.required],
    [
      "a prev in hex",
      { ...base, prev: `sha256:${"a".repeat(64)}` },
      "prev",
      EVENT_REASON.eventHash,
    ],
    ["an unknown alg", { ...base, alg: "rsa" }, "alg", EVENT_REASON.invalidValue],
    ["a short ed25519 signature", { ...base, sig: "AAAA" }, "sig", EVENT_REASON.ed25519Signature],
    ["an assertion for ed25519", { ...base, sig: webauthn.sig }, "sig", EVENT_REASON.sigShape],
    ["a string for webauthn", { ...webauthn, sig: ED25519_SIG }, "sig", EVENT_REASON.sigShape],
    [
      "an assertion without signature",
      {
        ...webauthn,
        sig: { authenticatorData: "AA", clientDataJSON: "AA" },
      },
      "sig.signature",
      EVENT_REASON.required,
    ],
    [
      "an assertion with padding",
      {
        ...webauthn,
        sig: { ...webauthn.sig, signature: "AA==" },
      },
      "sig.signature",
      EVENT_REASON.base64url,
    ],
    [
      "an assertion with an extra key",
      {
        ...webauthn,
        sig: { ...webauthn.sig, userHandle: "AA" },
      },
      "sig.userHandle",
      EVENT_REASON.unknownField,
    ],
    [
      "an encrypted payload with an extra key",
      {
        ...base,
        payload: undefined,
        payload_enc: { alg: "x", key_id: "pk:AAAAAAAAAAAAAAAA", nonce: "AA", ct: "AA", key: "AA" },
      },
      "payload_enc.key",
      EVENT_REASON.unknownField,
    ],
    [
      "an unknown assurance",
      { ...base, assurance: "strong" },
      "assurance",
      EVENT_REASON.invalidValue,
    ],
    ["v: 0", { ...base, v: 0 }, "v", EVENT_REASON.invalidValue],
    ['v: "1"', { ...base, v: "1" }, "v", EVENT_REASON.invalidValue],
  ])("rejects %s", (_name, input, field, reasonKey) => {
    expect(rejected(JSON.parse(JSON.stringify(input)))).toEqual({
      code: "EVENT_INVALID",
      message_key: "error.event_invalid",
      details: { field, reason_key: reasonKey },
    });
  });

  it.each([null, [], "event", 1])("rejects %j", (input) => {
    expect(rejected(input).code).toBe("EVENT_INVALID");
  });
});

describe("parseEventEnvelope: UPGRADE_REQUIRED", () => {
  it("rejects a newer version, whatever the other fields", () => {
    // Version 14 exists (`checkpoint.opened`): 15 is beyond this engine.
    expect(rejected({ v: 15, anything: true })).toEqual({
      code: "UPGRADE_REQUIRED",
      message_key: "error.event_upgrade_required",
      details: { field: "v", version: 15, supported: 14 },
    });
  });
});

describe("parseEventEnvelope: wrong types are not missing fields", () => {
  it.each([
    ["id", { ...base, id: 123 }],
    ["prev", { ...base, prev: 1 }],
    ["actor.device", { ...base, actor: { kind: "human", device: false } }],
  ])("reports %s as an invalid value", (field, input) => {
    expect(rejected(input).details).toEqual({ field, reason_key: EVENT_REASON.invalidValue });
  });
});

describe("canonical base64url", () => {
  it.each(["", "AA", "AAA", "AAAA", "AQ", "AAE", "_-8"])("accepts %j", (text) => {
    expect(isCanonicalBase64url(text)).toBe(true);
  });

  it.each(["A", "AAAAA", "AB", "AAF", "AA==", "A+/A", "A A"])("rejects %j", (text) => {
    expect(isCanonicalBase64url(text)).toBe(false);
  });

  it("rejects a non-canonical value in sig and payload_enc", () => {
    expect(
      rejected({ ...webauthn, sig: { ...webauthn.sig, signature: "MEUCIR" } }).details,
    ).toEqual({ field: "sig.signature", reason_key: EVENT_REASON.base64url });
    const enc = {
      ...base,
      payload: undefined,
      payload_enc: { alg: "x", key_id: "pk:AAAAAAAAAAAAAAAA", nonce: "A", ct: "AA" },
    };
    expect(rejected(enc).details).toEqual({
      field: "payload_enc.nonce",
      reason_key: EVENT_REASON.base64url,
    });
  });
});

describe("parseEventEnvelope: JSON values only", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  it.each([
    ["NaN", { ...base, payload: { n: Number.NaN } }, "payload.n"],
    ["Infinity", { ...base, payload: { list: [1, Number.POSITIVE_INFINITY] } }, "payload.list.1"],
    ["a BigInt", { ...base, payload: { n: 1n } }, "payload.n"],
    ["a nested undefined", { ...base, payload: { n: undefined } }, "payload.n"],
    ["a cycle", { ...base, payload: cycle }, "payload.self"],
    ["a Date", { ...base, payload: { at: new Date(0) } }, "payload.at"],
    ["a lone surrogate", { ...base, product: "demo\ud800" }, "product"],
    ["a lone surrogate in a key", { ...base, payload: { "\udc00": 1 } }, "payload.\udc00"],
  ])("rejects %s without throwing", (_name, input, field) => {
    expect(rejected(input)).toEqual({
      code: "EVENT_INVALID",
      message_key: "error.event_invalid",
      details: { field, reason_key: EVENT_REASON.jsonValue },
    });
  });

  it("treats a top-level undefined as absent", () => {
    expect(parseEventEnvelope({ ...base, story: undefined }).success).toBe(true);
    expect(jsonValueIssue({ a: [1, "x", null, { b: true }] })).toBeUndefined();
  });
});
