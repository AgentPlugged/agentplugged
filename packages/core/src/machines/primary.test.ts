import { PRIMARY_ERROR_CODES } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { electPrimary, planPrimaryChange, publishesProjection, routeOrder } from "./primary.js";

const A = "machine:AAAAAAAAAAAAAAAA";
const B = "machine:BBBBBBBBBBBBBBBB";
const heads = { [A]: "sha256:one", [B]: "sha256:two" };

function candidate(over: Record<string, unknown> = {}) {
  return {
    bridge: B,
    trusted: true,
    online: true,
    serves: true,
    protocol: 3,
    known: new Set(["sha256:one", "sha256:two"]),
    ...over,
  };
}

describe("choosing the main bridge", () => {
  it("records the change with the bridge it replaces", () => {
    const plan = planPrimaryChange({ current: A, candidate: candidate(), heads, protocol: 3 });
    expect(plan).toEqual({ ok: true, payload: { bridge: B, previous: A } });
  });

  it("records a first choice with no previous bridge", () => {
    const plan = planPrimaryChange({ current: null, candidate: candidate(), heads, protocol: 3 });
    expect(plan).toEqual({ ok: true, payload: { bridge: B, previous: null } });
  });

  it("writes nothing when the bridge already is the main one", () => {
    const plan = planPrimaryChange({ current: B, candidate: candidate(), heads, protocol: 3 });
    expect(plan).toEqual({ ok: true, payload: null });
  });

  it("refuses a bridge that lacks events and names the chains to synchronise", () => {
    const plan = planPrimaryChange({
      current: A,
      candidate: candidate({ known: new Set(["sha256:one"]) }),
      heads,
      protocol: 3,
    });
    expect(plan).toEqual({
      ok: false,
      code: PRIMARY_ERROR_CODES.PRIMARY_BRIDGE_NOT_SYNCED,
      missing: [B],
    });
  });

  it("refuses a bridge that is not trusted, too old, or does not serve the product", () => {
    const code = (over: Record<string, unknown>) => {
      const plan = planPrimaryChange({
        current: A,
        candidate: candidate(over),
        heads,
        protocol: 3,
      });
      return plan.ok ? undefined : plan.code;
    };
    expect(code({ trusted: false })).toBe(PRIMARY_ERROR_CODES.PRIMARY_BRIDGE_NOT_TRUSTED);
    expect(code({ protocol: 1 })).toBe(PRIMARY_ERROR_CODES.PRIMARY_BRIDGE_UPGRADE_REQUIRED);
    expect(code({ online: false })).toBe(PRIMARY_ERROR_CODES.PRIMARY_BRIDGE_OFFLINE);
    expect(code({ serves: false })).toBe(PRIMARY_ERROR_CODES.PRIMARY_BRIDGE_NOT_SERVING);
    // The previous protocol version is still served.
    expect(code({ protocol: 2 })).toBeUndefined();
  });

  it("refuses a change when no head of the journal was given", () => {
    const plan = planPrimaryChange({ current: A, candidate: candidate(), heads: {}, protocol: 3 });
    expect(plan.ok).toBe(false);
  });

  it("lets only the main bridge publish the projection", () => {
    expect(publishesProjection(A, A)).toBe(true);
    expect(publishesProjection(B, A)).toBe(false);
    expect(publishesProjection(A, null)).toBe(false);
  });
});

describe("routing an order", () => {
  const owners = new Map([["4-2", B]]);

  it("addresses an order without a story to the main bridge", () => {
    expect(routeOrder({}, A, owners)).toBe(A);
  });

  it("addresses an order that names a story to the bridge that owns it", () => {
    expect(routeOrder({ story: "4-2" }, A, owners)).toBe(B);
  });

  it("addresses nobody when there is no main bridge or no owner", () => {
    expect(routeOrder({}, null, owners)).toBeUndefined();
    expect(routeOrder({ story: "9-9" }, A, owners)).toBeUndefined();
  });
});

describe("the main bridge elected when nobody chose one", () => {
  it("is the trusted machine that wrote last", () => {
    const writes = new Map([
      [A, "2026-10-15T08:00:00.000Z"],
      [B, "2026-10-15T09:00:00.000Z"],
    ]);
    expect(electPrimary([A, B], writes)).toBe(B);
    expect(electPrimary([A], writes)).toBe(A);
  });

  it("breaks a tie, and a machine that never wrote, by the smallest identifier", () => {
    const at = "2026-10-15T08:00:00.000Z";
    const tie = new Map([
      [A, at],
      [B, at],
    ]);
    expect(electPrimary([B, A], tie)).toBe(A);
    expect(electPrimary([B, A], new Map())).toBe(A);
  });

  it("gives the same answer whatever the order the machines are listed in", () => {
    const writes = new Map([[B, "2026-10-15T09:00:00.000Z"]]);
    expect(electPrimary([A, B], writes)).toBe(electPrimary([B, A], writes));
  });

  it("is nobody without a trusted machine", () => {
    expect(electPrimary([], new Map())).toBeNull();
  });
});
