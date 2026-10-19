import { describe, expect, it } from "vitest";
import {
  AUTONOMY_DIALS,
  AUTONOMY_POINTS,
  AUTONOMY_PRESETS,
  AutonomyHintParamsSchema,
  type AutonomyReading,
  autonomyChanges,
  autonomyDialOf,
  autonomySuggestion,
  ProductAutonomySchema,
  RULE_LOCKS,
  ruleChoices,
  SetAutonomyParamsSchema,
  SetRuleParamsSchema,
} from "./autonomy.js";
import { baseOrderTypes } from "./orders.js";

const reading = (dial: (typeof AUTONOMY_DIALS)[number]): AutonomyReading => {
  const preset = AUTONOMY_PRESETS[dial];
  return {
    mode: preset.mode,
    installs: preset.installs,
    points: [...preset.kept, "merge", "release", "publication"],
    rules: preset.rules,
  };
};

describe("the autonomy presets", () => {
  it("only move the points and the two rules the dial owns", () => {
    for (const dial of AUTONOMY_DIALS) {
      const preset = AUTONOMY_PRESETS[dial];
      expect(preset.kept.every((point) => AUTONOMY_POINTS.includes(point))).toBe(true);
      expect(Object.keys(preset.rules).sort()).toEqual(["install_dependency", "internet"]);
    }
  });

  it("get freer notch by notch, never the other way", () => {
    expect(AUTONOMY_PRESETS.prudent.kept.length).toBeGreaterThan(
      AUTONOMY_PRESETS.balanced.kept.length,
    );
    expect(AUTONOMY_PRESETS.balanced.kept.length).toBeGreaterThan(
      AUTONOMY_PRESETS.wide.kept.length,
    );
    expect(AUTONOMY_PRESETS.prudent.mode).toBe("chat");
    expect(AUTONOMY_PRESETS.balanced.mode).toBe("auto");
  });

  it("never touch a locked rule or the commands that erase data", () => {
    for (const dial of AUTONOMY_DIALS) {
      for (const action of Object.keys(AUTONOMY_PRESETS[dial].rules)) {
        expect(RULE_LOCKS[action as keyof typeof RULE_LOCKS]).toBe("none");
      }
    }
  });
});

describe("autonomyDialOf", () => {
  it("recognises each notch", () => {
    for (const dial of AUTONOMY_DIALS) expect(autonomyDialOf(reading(dial))).toBe(dial);
  });

  it("calls custom what no notch matches, the strict level included", () => {
    expect(autonomyDialOf({ ...reading("balanced"), mode: "strict" })).toBe("custom");
    expect(autonomyDialOf({ ...reading("wide"), installs: "validate" })).toBe("custom");
    expect(
      autonomyDialOf({
        ...reading("prudent"),
        rules: { install_dependency: "deny", internet: "ask" },
      }),
    ).toBe("custom");
  });

  it("calls custom a product whose release or publications are handed to the agents", () => {
    expect(autonomyDialOf({ ...reading("wide"), points: [] })).toBe("custom");
    expect(autonomyDialOf({ ...reading("wide"), points: ["merge", "release"] })).toBe("custom");
    expect(autonomyDialOf({ ...reading("wide"), points: ["release", "publication"] })).toBe("wide");
  });

  it("reads « points not chosen yet » as every point kept", () => {
    expect(autonomyDialOf({ ...reading("prudent"), points: undefined })).toBe("prudent");
  });
});

describe("autonomyChanges", () => {
  it("says what a notch changes and whether it gives the agents more freedom", () => {
    const up = autonomyChanges(reading("prudent"), "balanced");
    expect(up.raises).toBe(true);
    expect(up.changes.map((change) => change.kind).sort()).toEqual(["mode", "point"].sort());
    const down = autonomyChanges(reading("wide"), "balanced");
    expect(down.raises).toBe(false);
  });

  it("changes nothing for the notch already set", () => {
    expect(autonomyChanges(reading("wide"), "wide")).toEqual({ changes: [], raises: false });
  });

  it("counts leaving the strict level for a notch as a loosening", () => {
    expect(autonomyChanges({ ...reading("prudent"), mode: "strict" }, "prudent").raises).toBe(true);
  });
});

describe("ruleChoices", () => {
  it("lets a locked action only be denied and an erasing one never be allowed", () => {
    expect(ruleChoices("locked")).toEqual(["deny"]);
    expect(ruleChoices("never_allow")).toEqual(["ask", "deny"]);
    expect(ruleChoices("none")).toEqual(["allow", "ask", "deny"]);
  });
});

describe("the orders and the report", () => {
  it("declares three order types, the two settings ones on the main machine", () => {
    const types = baseOrderTypes();
    expect(types.get("order.product.set_autonomy/v1")?.target).toBe("primary");
    expect(types.get("order.product.set_rule/v1")?.target).toBe("primary");
    expect(types.get("order.product.autonomy_hint/v1")?.target).toBe("bridge");
  });

  it("checks the parameters strictly", () => {
    expect(SetAutonomyParamsSchema.safeParse({ dial: "wide" }).success).toBe(true);
    expect(SetAutonomyParamsSchema.safeParse({ dial: "custom" }).success).toBe(false);
    expect(SetAutonomyParamsSchema.safeParse({ dial: "wide", extra: 1 }).success).toBe(false);
    expect(SetRuleParamsSchema.safeParse({ action: "internet", value: "ask" }).success).toBe(true);
    expect(SetRuleParamsSchema.safeParse({ action: "format_disk", value: "ask" }).success).toBe(
      false,
    );
    expect(AutonomyHintParamsSchema.safeParse({}).success).toBe(false);
    expect(AutonomyHintParamsSchema.safeParse({ threshold: 2 }).success).toBe(false);
    expect(AutonomyHintParamsSchema.safeParse({ threshold: 51 }).success).toBe(false);
    expect(AutonomyHintParamsSchema.safeParse({ threshold: 10 }).success).toBe(true);
    expect(AutonomyHintParamsSchema.safeParse({ snooze: "merge" }).success).toBe(false);
    expect(AutonomyHintParamsSchema.safeParse({ snooze: "breakdown" }).success).toBe(true);
  });

  it("reads a report", () => {
    const rules = {
      read_files: "allow",
      edit_code: "allow",
      run_checks: "allow",
      install_dependency: "ask",
      internet: "ask",
      destructive_command: "deny",
      push_main: "deny",
      force_push: "deny",
      read_secrets: "deny",
    };
    const report = {
      dial: "prudent",
      mode: "chat",
      installs: "validate",
      kept: ["framing", "architecture", "breakdown", "merge"],
      rules,
      threshold: 10,
    };
    expect(ProductAutonomySchema.safeParse(report).success).toBe(true);
    expect(ProductAutonomySchema.safeParse({ ...report, threshold: 1 }).success).toBe(false);
    expect(ProductAutonomySchema.safeParse({ ...report, secret: "x" }).success).toBe(false);
  });
});

/** A resolved breakdown checkpoint (a document written by izzy). */
function answered(
  index: number,
  over: { decision?: string; note?: string | null; source?: string; opened_by?: string } = {},
) {
  return {
    id: `G-${index}`,
    type: "document",
    risk: "low",
    opened_by: over.opened_by ?? "izzy",
    documents: [{ path: ".agentplugged/epics/epics.md" }],
    source: null,
    resolution: {
      decision: over.decision ?? "approved",
      note: over.note ?? null,
      source: over.source ?? "terminal",
      at: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
    },
  };
}

const checkpointsOf = (list: readonly object[]) =>
  Object.fromEntries(list.map((item, index) => [`G-${index}`, item]));

describe("autonomySuggestion", () => {
  const ten = Array.from({ length: 10 }, (_, index) => answered(index));

  it("proposes the next notch after ten validations without a change", () => {
    expect(
      autonomySuggestion({ checkpoints: checkpointsOf(ten), dial: "prudent", threshold: 10 }),
    ).toEqual({ point: "breakdown", count: 10, to: "balanced" });
  });

  it("proposes nothing for nine, for the widest notch, or for a hand-made setting", () => {
    const nine = ten.slice(0, 9);
    expect(
      autonomySuggestion({ checkpoints: checkpointsOf(nine), dial: "prudent", threshold: 10 }),
    ).toBeUndefined();
    expect(
      autonomySuggestion({ checkpoints: checkpointsOf(ten), dial: "wide", threshold: 10 }),
    ).toBeUndefined();
    expect(
      autonomySuggestion({ checkpoints: checkpointsOf(ten), dial: "custom", threshold: 10 }),
    ).toBeUndefined();
  });

  it("breaks the run at a note, a change asked or a reservation", () => {
    for (const odd of [
      answered(5, { decision: "changes_requested", note: "rework" }),
      answered(5, { decision: "approved_with_reservations", note: "careful" }),
      answered(5, { note: "nice" }),
    ]) {
      const list = ten.map((item, index) => (index === 9 ? odd : item));
      // The odd answer is the latest: the run is empty.
      expect(
        autonomySuggestion({ checkpoints: checkpointsOf(list), dial: "prudent", threshold: 10 }),
      ).toBeUndefined();
    }
  });

  it("counts the validations made at the web view and on the phone as the creator's own", () => {
    for (const source of ["web", "mobile"]) {
      const list = ten.map((item, index) => (index === 9 ? answered(10, { source }) : item));
      expect(
        autonomySuggestion({ checkpoints: checkpointsOf(list), dial: "prudent", threshold: 10 }),
      ).toBeDefined();
    }
  });

  it("does not count what an agent decided or the engine applied", () => {
    const list = [
      ...ten.slice(0, 9),
      answered(9, { source: "agent" }),
      answered(10, { source: "auto" }),
    ];
    expect(
      autonomySuggestion({ checkpoints: checkpointsOf(list), dial: "prudent", threshold: 10 }),
    ).toBeUndefined();
  });

  it("starts again after « not now »: ten new validations are needed", () => {
    const snoozed = { breakdown: new Date(Date.UTC(2026, 9, 1, 0, 9, 30)).toISOString() };
    expect(
      autonomySuggestion({
        checkpoints: checkpointsOf(ten),
        dial: "prudent",
        threshold: 10,
        snoozed,
      }),
    ).toBeUndefined();
    const later = Array.from({ length: 10 }, (_, index) => answered(20 + index));
    expect(
      autonomySuggestion({
        checkpoints: checkpointsOf([...ten, ...later]),
        dial: "prudent",
        threshold: 10,
        snoozed,
      })?.count,
    ).toBe(10);
  });

  it("follows the threshold the creator set", () => {
    expect(
      autonomySuggestion({
        checkpoints: checkpointsOf(ten.slice(0, 3)),
        dial: "prudent",
        threshold: 3,
      })?.count,
    ).toBe(3);
  });

  it("proposes the points the next notch hands over, not the merge", () => {
    const merges = Array.from({ length: 10 }, (_, index) => ({
      ...answered(index),
      type: "story",
      source: "merge",
    }));
    expect(
      autonomySuggestion({ checkpoints: checkpointsOf(merges), dial: "prudent", threshold: 10 }),
    ).toBeUndefined();
    const framing = Array.from({ length: 10 }, (_, index) => ({
      ...answered(index, { opened_by: "iris" }),
      documents: [{ path: ".agentplugged/docs/prd.md" }],
    }));
    expect(
      autonomySuggestion({ checkpoints: checkpointsOf(framing), dial: "balanced", threshold: 10 }),
    ).toEqual({ point: "framing", count: 10, to: "wide" });
  });

  it("reads what a machine published without trusting it", () => {
    expect(
      autonomySuggestion({ checkpoints: "nothing", dial: "prudent", threshold: 10 }),
    ).toBeUndefined();
    expect(
      autonomySuggestion({
        checkpoints: { a: null, b: 3, c: { resolution: "x" }, d: { type: 1, resolution: {} } },
        dial: "prudent",
        threshold: 1,
      }),
    ).toBeUndefined();
  });
});
