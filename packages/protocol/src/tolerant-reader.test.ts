import { describe, expect, it } from "vitest";
import { MachineReportReader, MachineRoleOrderSchema } from "./machines.js";
import { SetPriorityParamsSchema } from "./orders.js";
import {
  applyFeedOps,
  FeedBeatReader,
  FeedBeatSchema,
  FeedChangeReader,
  FeedSnapshotReader,
  type PublishedState,
  PublishedStateReader,
} from "./published-state.js";

const PRODUCT = "01J9ZQ4V8E3M5N7P9R1S3T5V7X";
const BRIDGE = "machine:AAAAAAAAAAAAAAAA";
const CURSOR = { n: 3, heads: { w1: "abc" } };

/** A report as a bridge from the future would send it: unknown fields at every level. */
function futureReport(): Record<string, unknown> {
  return {
    name: "laptop",
    bridge_version: "9.0.0",
    protocol_version: 9,
    products: [{ id: PRODUCT, name: "Shop", rank: 1, colour: "red" }],
    agents: 2,
    tools: [{ tool: "claude", mode: "hooks", active: true, latency: 5 }],
    role: "build",
    forges: [
      {
        provider: "github",
        host: "github.com",
        state: "linked",
        quota: { left: 3 },
        repos: { kind: "all", extra: true },
      },
    ],
    key_store: "system",
    battery: { level: 0.5 },
  };
}

function futureBeat(): Record<string, unknown> {
  return {
    bridge: BRIDGE,
    at: 1_700_000_000,
    bridge_version: "9.0.0",
    protocol_version: 9,
    schema: 1,
    last_seq: 4,
    publishes: [{ product: PRODUCT, cursor: CURSOR, note: "later" }],
    report: futureReport(),
    future_top: { anything: [1, 2, 3] },
  };
}

function baseState(): PublishedState {
  return {
    projection: {
      format: 1,
      journal_head: null,
      computed_at: null,
      product: PRODUCT,
      devices: [],
      applied: 0,
      ignored: [],
      warnings: [],
      state: {},
    },
    trust: { blocked: false, devices: {}, revoked: [] },
    machines: { primary: null, automatic: false },
    import: { state: "none" },
  };
}

describe("a device reads a message from a newer machine", () => {
  it("reads a beat that carries unknown fields and drops them", () => {
    const read = FeedBeatReader.safeParse(futureBeat());
    expect(read.success).toBe(true);
    if (!read.success) return;
    expect(read.data).not.toHaveProperty("future_top");
    expect(read.data.publishes[0]).not.toHaveProperty("note");
    const report = read.data.report;
    expect(report).not.toHaveProperty("battery");
    expect(report?.products[0]).toEqual({ id: PRODUCT, name: "Shop", rank: 1 });
    expect(report?.tools[0]).not.toHaveProperty("latency");
    expect(report?.forges?.[0]).not.toHaveProperty("quota");
    expect(report?.forges?.[0]?.repos).toEqual({ kind: "all" });
  });

  it("reads a report alone, with the fields it knows intact", () => {
    const read = MachineReportReader.safeParse(futureReport());
    expect(read.success).toBe(true);
    expect(read.success && read.data.name).toBe("laptop");
    expect(read.success && read.data.key_store).toBe("system");
  });

  it("still refuses the strict schema, which is for the side that writes", () => {
    expect(FeedBeatSchema.safeParse(futureBeat()).success).toBe(false);
  });

  it("still validates every known field, with the bounds", () => {
    const withReport = (patch: Record<string, unknown>) => ({
      ...futureBeat(),
      report: { ...futureReport(), ...patch },
    });
    expect(FeedBeatReader.safeParse(withReport({ name: "x".repeat(61) })).success).toBe(false);
    expect(FeedBeatReader.safeParse(withReport({ agents: -1 })).success).toBe(false);
    expect(FeedBeatReader.safeParse(withReport({ key_store: "cloud" })).success).toBe(false);
    expect(
      FeedBeatReader.safeParse(withReport({ products: [{ id: "a", name: "b", rank: 0 }] })).success,
    ).toBe(false);
    expect(
      FeedBeatReader.safeParse(
        withReport({
          products: Array.from({ length: 65 }, (_, i) => ({ id: `p${i}`, name: "n" })),
        }),
      ).success,
    ).toBe(false);
    expect(FeedBeatReader.safeParse({ ...futureBeat(), bridge: "nope" }).success).toBe(false);
    const { bridge: _gone, ...missing } = futureBeat();
    expect(FeedBeatReader.safeParse(missing).success).toBe(false);
  });

  it("reads a snapshot and a change with unknown fields, and still applies the steps", () => {
    const state = { ...baseState(), future_part: { a: 1 } };
    const snapshot = FeedSnapshotReader.safeParse({
      kind: "snapshot",
      schema: 1,
      product: PRODUCT,
      cursor: CURSOR,
      state,
      more: 1,
    });
    expect(snapshot.success).toBe(true);
    expect(snapshot.success && snapshot.data.state).not.toHaveProperty("future_part");
    const change = FeedChangeReader.safeParse({
      kind: "change",
      schema: 1,
      product: PRODUCT,
      from_cursor: CURSOR,
      to_cursor: { n: 4, heads: CURSOR.heads },
      ops: [{ op: "set", path: ["machines", "automatic"], value: true, hint: "x" }],
      more: 1,
    });
    expect(change.success).toBe(true);
    if (!change.success || !snapshot.success) return;
    expect(applyFeedOps(snapshot.data.state, change.data.ops).machines.automatic).toBe(true);
  });

  it("keeps a step that makes the state invalid refused", () => {
    expect(() =>
      applyFeedOps(baseState(), [{ op: "set", path: ["trust", "blocked"], value: "yes" }]),
    ).toThrow();
    expect(PublishedStateReader.safeParse({ ...baseState(), trust: { blocked: 1 } }).success).toBe(
      false,
    );
  });
});

describe("a machine receiving an order stays strict", () => {
  it("refuses an order parameter it does not know", () => {
    expect(MachineRoleOrderSchema.safeParse({ bridge: BRIDGE, role: "x", future: 1 }).success).toBe(
      false,
    );
    expect(SetPriorityParamsSchema.safeParse({ ranks: {}, future: 1 }).success).toBe(false);
    expect(SetPriorityParamsSchema.safeParse({ ranks: {} }).success).toBe(true);
  });
});
