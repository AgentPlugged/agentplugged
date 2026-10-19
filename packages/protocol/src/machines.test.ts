import { describe, expect, it } from "vitest";
import { eventTypeSpec } from "./event-types.js";
import {
  bridgeNeedsUpgrade,
  MACHINE_EVENT_TYPES,
  MachineReportSchema,
  MachineRoleOrderSchema,
  PrimaryChangedPayloadSchema,
} from "./machines.js";

const BRIDGE = "machine:AAAAAAAAAAAAAAAA";

describe("the main bridge event", () => {
  it("is a registered event type at version 1", () => {
    expect(eventTypeSpec(MACHINE_EVENT_TYPES.primaryChanged)?.version).toBe(1);
  });

  it("names the new bridge and the previous one, or none", () => {
    expect(PrimaryChangedPayloadSchema.safeParse({ bridge: BRIDGE, previous: null }).success).toBe(
      true,
    );
    expect(
      PrimaryChangedPayloadSchema.safeParse({ bridge: "phone:AAAAAAAAAAAAAAAA", previous: null })
        .success,
    ).toBe(false);
    expect(
      PrimaryChangedPayloadSchema.safeParse({ bridge: BRIDGE, previous: null, extra: 1 }).success,
    ).toBe(false);
  });
});

describe("what a machine reports", () => {
  const report = {
    name: "Laptop",
    bridge_version: "1.4.2",
    protocol_version: 3,
    products: [{ id: "p-kalo", name: "Kalo" }],
    agents: 5,
    tools: [{ tool: "Claude Code", mode: "hooks", active: true }],
  };

  it("accepts a complete report and a role", () => {
    expect(MachineReportSchema.safeParse(report).success).toBe(true);
    expect(MachineReportSchema.safeParse({ ...report, role: "Build server" }).success).toBe(true);
  });

  it("says where the keys are kept: the system keychain or the fallback store, nothing else", () => {
    for (const key_store of ["system", "fallback"]) {
      expect(MachineReportSchema.safeParse({ ...report, key_store }).success).toBe(true);
    }
    expect(MachineReportSchema.safeParse({ ...report, key_store: "file" }).success).toBe(false);
  });

  it("carries the creator's rank of a product, an older report without it staying valid", () => {
    const ranked = { ...report, products: [{ id: "p-kalo", name: "Kalo", rank: 2 }] };
    expect(MachineReportSchema.safeParse(ranked).success).toBe(true);
    expect(MachineReportSchema.safeParse(report).success).toBe(true);
    for (const rank of [0, 10_000, 1.5]) {
      const bad = { ...report, products: [{ id: "p-kalo", name: "Kalo", rank }] };
      expect(MachineReportSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("refuses a negative agent count, a long role and unknown fields", () => {
    expect(MachineReportSchema.safeParse({ ...report, agents: -1 }).success).toBe(false);
    expect(MachineReportSchema.safeParse({ ...report, role: "x".repeat(121) }).success).toBe(false);
    expect(MachineReportSchema.safeParse({ ...report, path: "/home" }).success).toBe(false);
  });

  it("carries a role order for one bridge", () => {
    expect(MachineRoleOrderSchema.safeParse({ bridge: BRIDGE, role: "" }).success).toBe(true);
    expect(MachineRoleOrderSchema.safeParse({ bridge: "x", role: "" }).success).toBe(false);
  });
});

describe("the protocol window", () => {
  it("serves the current protocol version and the previous one", () => {
    expect(bridgeNeedsUpgrade(3, 3)).toBe(false);
    expect(bridgeNeedsUpgrade(2, 3)).toBe(false);
    expect(bridgeNeedsUpgrade(1, 3)).toBe(true);
  });
});
