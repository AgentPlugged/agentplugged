import { describe, expect, it } from "vitest";
import {
  CRITIQUE_DOCUMENT_KINDS,
  CRITIQUE_METHODS,
  CritiqueInputSchema,
  CritiqueReportedPayloadSchema,
  critiqueIdOf,
  critiqueOfHypothesis,
  critiquePathOf,
  critiqueStepOf,
  HypothesisIdInputSchema,
  hypothesisIdOf,
  MAX_OBJECTIONS,
} from "./critique.js";

const REPORT = {
  agent: "quentin",
  kind: "prd",
  lenses: ["pre_mortem"],
  summary: "Requirements fail by what they forgot.",
  findings: [{ severity: "blocking", claim: "No limit on exports." }],
};

describe("the input of the critique of a deliverable", () => {
  it("accepts the four calls, told apart by what they hold", () => {
    const report = CritiqueInputSchema.parse(REPORT);
    expect(critiqueStepOf(report)).toBe("report");
    const propose = CritiqueInputSchema.parse({ agent: "noah", kind: "architecture" });
    expect(critiqueStepOf(propose)).toBe("propose");
    // A critique alone is a look at what is left; with gestures or words it is a settling.
    const show = CritiqueInputSchema.parse({ agent: "quentin", item: "K-7M2K9QX4TB" });
    expect(critiqueStepOf(show)).toBe("show");
    expect(critiqueStepOf({ ...show, quote: "oui" })).toBe("settle");
    expect(critiqueStepOf({ ...show, items: [{ n: 1, gesture: "fix" }] })).toBe("settle");
    const settle = CritiqueInputSchema.parse({
      agent: "quentin",
      item: "k-7m2k9qx4tb",
      items: [{ n: 1, gesture: "discard", reason: "Out of scope for 1.0." }],
      quote: "écarte la 1, hors périmètre",
    });
    expect(critiqueStepOf(settle)).toBe("settle");
    expect(settle.item).toBe("K-7M2K9QX4TB");
    const close = CritiqueInputSchema.parse({
      agent: "quentin",
      item: "h-7m2k9qx4tb-2",
      items: [{ gesture: "proved", reason: "The benchmark passes." }],
      quote: "oui, prouvée",
    });
    expect(critiqueStepOf(close)).toBe("close");
    expect(close.item).toBe("H-7M2K9QX4TB-2");
  });

  it("refuses an unknown document, method, gesture or id, and a field it does not know", () => {
    const accepted = (input: Record<string, unknown>) =>
      CritiqueInputSchema.safeParse(input).success;
    expect(accepted({ ...REPORT, kind: "readme" })).toBe(false);
    expect(accepted({ ...REPORT, lenses: ["brainstorm"] })).toBe(false);
    // Two methods blend; three never do.
    expect(accepted({ ...REPORT, lenses: ["pre_mortem", "red_team"] })).toBe(true);
    expect(accepted({ ...REPORT, lenses: ["pre_mortem", "red_team", "socratic"] })).toBe(false);
    expect(
      accepted({ agent: "quentin", item: "K-7M2K9QX4TB", items: [{ gesture: "ignore" }] }),
    ).toBe(false);
    expect(accepted({ agent: "quentin", item: "X-7M2K9QX4TB" })).toBe(false);
    expect(accepted({ ...REPORT, verdict: "pass" })).toBe(false);
  });

  it("refuses a multi-line claim and an empty quote, and caps what a report may hold", () => {
    const claim = (text: string) => ({
      ...REPORT,
      findings: [{ severity: "minor", claim: text }],
    });
    expect(CritiqueInputSchema.safeParse(claim("one\ntwo")).success).toBe(false);
    expect(
      CritiqueInputSchema.safeParse({ agent: "quentin", item: "K-7M2K9QX4TB", quote: "   " })
        .success,
    ).toBe(false);
    const many = Array.from({ length: MAX_OBJECTIONS + 6 }, () => ({
      severity: "minor",
      claim: "x",
    }));
    expect(CritiqueInputSchema.safeParse({ ...REPORT, findings: many }).success).toBe(false);
  });

  it("reads a journal entry of a critique with or without a second method", () => {
    const entry = {
      document: ".agentplugged/docs/prd.md",
      versions: ["a".repeat(40)],
      method: "pre_mortem",
      reason: "Requirements fail by what they forgot.",
      objections: [],
    };
    expect(CritiqueReportedPayloadSchema.safeParse(entry).success).toBe(true);
    expect(CritiqueReportedPayloadSchema.safeParse({ ...entry, blend: "steelman" }).success).toBe(
      true,
    );
    expect(CritiqueReportedPayloadSchema.safeParse({ ...entry, blend: "magic" }).success).toBe(
      false,
    );
  });

  it("offers the methods and the seven kinds of target, each a stable identifier", () => {
    expect([...CRITIQUE_METHODS]).toEqual([
      "pre_mortem",
      "red_team",
      "socratic",
      "first_principles",
      "devils_advocate",
      "inversion",
      "personas",
      "divergence",
      "assumption_audit",
      "steelman",
      "failure_modes",
      "second_order",
      "domain_expert",
      "extreme_user",
      "compare_existing",
      "reframe",
      "subtraction",
      "judgment",
      "reconcile",
    ]);
    expect(CRITIQUE_DOCUMENT_KINDS.map(critiquePathOf)).toEqual([
      ".agentplugged/docs/brief.md",
      ".agentplugged/docs/prd.md",
      ".agentplugged/docs/ux.md",
      ".agentplugged/docs/architecture.md",
      ".agentplugged/docs/spec.md",
      ".agentplugged/docs/prfaq.md",
      // The idea is no file: its name stands in the registers.
      ".agentplugged/docs/idea",
    ]);
  });

  it("derives the ids of a critique and of its hypotheses from the event, once and for all", () => {
    const critique = critiqueIdOf("01J9ZABCDEFGHJKMNPQRSTVWXY");
    expect(critique).toBe("K-NPQRSTVWXY");
    const hypothesis = hypothesisIdOf(critique, 3);
    expect(HypothesisIdInputSchema.parse(hypothesis.toLowerCase())).toBe(hypothesis);
    expect(critiqueOfHypothesis(hypothesis)).toBe(critique);
  });

  it("takes a report on the idea with the personas, and an offer of the idea alone", () => {
    const report = { ...REPORT, kind: "idea", lenses: ["personas"] };
    expect(critiqueStepOf(CritiqueInputSchema.parse(report))).toBe("report");
    expect(critiqueStepOf(CritiqueInputSchema.parse({ agent: "iris", kind: "idea" }))).toBe(
      "propose",
    );
    expect(CritiqueInputSchema.safeParse({ ...report, kind: "readme" }).success).toBe(false);
  });
});
