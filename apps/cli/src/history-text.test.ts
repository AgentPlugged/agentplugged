import type { HistoryEntry, IgnoredValidation } from "@agentplugged/core";
import { createTranslator, isMessageKey } from "@agentplugged/i18n";
import { RESOLUTION_SOURCES } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  displayText,
  formatHistoryLine,
  formatIgnoredLine,
  formatValidationHistory,
  localDateTime,
} from "./history-text.js";

const en = createTranslator("en");
const fr = createTranslator("fr");

const BASE: HistoryEntry = {
  event: "01K00000000000000000000001",
  at: "2026-10-03T10:00:00.000Z",
  author: "human:AAAAAAAAAAAAAAAA",
  author_trust: "root",
  author_endorsed_at: null,
  source: "terminal",
  decision: "approved",
  option: null,
  waiver_until: null,
  assurance: "locale",
  locale_on_high_risk: false,
  checkpoint: "G-AAAAAAAAAA",
  checkpoint_type: "story",
  checkpoint_risk: "low",
  checkpoint_title: "Story 2-6 done",
  story: "2-6",
  checkpoint_phase: null,
  quote: null,
  relayed_by: null,
  channel: null,
  stack: null,
  via: null,
};

/** Runs `run` in the time zone `zone`, then puts `TZ` back (the creator's zone is an input). */
function withTimeZone<T>(zone: string, run: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

const when = (iso: string) => localDateTime(iso);

describe("history lines", () => {
  it("shows the date in this machine's time zone, never in UTC", () => {
    const zones: Array<[string, string]> = [
      ["America/New_York", "2026-10-03 06:00:00 -04:00"],
      ["Asia/Kolkata", "2026-10-03 15:30:00 +05:30"],
      ["Europe/Paris", "2026-10-03 12:00:00 +02:00"],
    ];
    for (const [zone, local] of zones) {
      withTimeZone(zone, () => {
        for (const t of [en, fr]) {
          const line = formatHistoryLine(t, BASE);
          expect(line, zone).toContain(local);
          expect(line, zone).not.toContain("UTC");
          expect(line, zone).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
        }
      });
    }
    // Around the change of hour: Paris leaves summer time on 25 October 2026 at 01:00 UTC.
    withTimeZone("Europe/Paris", () => {
      expect(localDateTime("2026-10-25T00:30:00.000Z")).toBe("2026-10-25 02:30:00 +02:00");
      expect(localDateTime("2026-10-25T01:30:00.000Z")).toBe("2026-10-25 02:30:00 +01:00");
    });
  });

  it("an endorsed author with the date of the endorsement, and an option chosen", () => {
    const line = formatHistoryLine(en, {
      ...BASE,
      author: "human:BBBBBBBBBBBBBBBB",
      author_trust: "endorsed",
      author_endorsed_at: "2026-10-02T08:30:00.000Z",
      decision: "option_chosen",
      option: "postgres",
      assurance: "presence",
      checkpoint_type: "decision",
      checkpoint_risk: "medium",
      checkpoint_title: "Pick a database",
      story: null,
    });
    expect(line).toBe(
      `${when(BASE.at)} · human:BBBBBBBBBBBBBBBB (endorsed on ${localDateTime("2026-10-02T08:30:00.000Z")}) · terminal · option chosen (option postgres) · assurance presence (Windows Hello) · G-AAAAAAAAAA (decision, medium risk): Pick a database · no story`,
    );
  });

  it("an answer clicked in the AI tool: the form, or the question window", () => {
    const form: HistoryEntry = {
      ...BASE,
      source: "elicitation",
      assurance: "elicitation",
      channel: "claude-code",
      relayed_by: "noah",
    };
    expect(formatHistoryLine(fr, form)).toContain("choisie dans l'outil (claude-code)");
    expect(formatHistoryLine(en, form)).toContain("chosen in the tool (claude-code)");
    const window: HistoryEntry = { ...form, via: "question_tool" };
    expect(formatHistoryLine(fr, window)).toContain(
      "choisie dans la fenêtre de questions (claude-code)",
    );
    expect(formatHistoryLine(en, window)).toContain("chosen in the question window (claude-code)");
    // Who asked is still said, and nothing the creator did not write is quoted.
    expect(formatHistoryLine(fr, window)).toContain("demandée par noah");
  });

  it("a waiver with its deadline, in French", () => {
    const line = formatHistoryLine(fr, {
      ...BASE,
      decision: "waived",
      waiver_until: "2026-10-05T10:00:00.000Z",
    });
    expect(line).toBe(
      `${when(BASE.at)} · human:AAAAAAAAAAAAAAAA (clé racine) · terminal · dérogé (jusqu'au ${localDateTime("2026-10-05T10:00:00.000Z")}) · assurance locale (la clé du trousseau de cette machine) · G-AAAAAAAAAA (story, risque faible) : Story 2-6 done · story 2-6`,
    );
  });

  it("names the phase an end of phase closes", () => {
    const end = {
      ...BASE,
      checkpoint_type: "phase_end" as const,
      checkpoint_phase: "design" as const,
    };
    expect(formatHistoryLine(fr, end)).toContain(
      " · G-AAAAAAAAAA (fin de phase (Conception), risque faible) : ",
    );
    expect(formatHistoryLine(en, end)).toContain(
      " · G-AAAAAAAAAA (end of phase (Design), low risk)",
    );
  });

  it("a missing title or an unknown checkpoint: no dangling colon", () => {
    expect(formatHistoryLine(en, { ...BASE, checkpoint_title: null })).toContain(
      " · G-AAAAAAAAAA (story, low risk) · story 2-6",
    );
    expect(formatHistoryLine(en, { ...BASE, checkpoint_title: "  " })).toContain(
      " · G-AAAAAAAAAA (story, low risk) · ",
    );
    expect(
      formatHistoryLine(en, { ...BASE, checkpoint_type: null, checkpoint_risk: null }),
    ).toContain(" · G-AAAAAAAAAA (checkpoint not found) · ");
  });

  it("control characters, ANSI escapes and bidi overrides never reach the terminal", () => {
    const line = formatHistoryLine(en, {
      ...BASE,
      checkpoint_title: "Done\n  2026-01-01 fake line\u001b[2K\u001b[1A‮evil⁦x\u007f\u0085",
      option: "a\rb",
      decision: "option_chosen",
    });
    expect(displayText(line)).toBe(line);
    expect(line).toContain("(option a b)");
    expect(line).toContain("Done   2026-01-01 fake line [2K [1A evil x · ");
    expect(displayText("\u001b[31mred")).toBe(" [31mred");
  });

  it("an ignored answer: its exact line, and its reason in French", () => {
    const item: IgnoredValidation = {
      event: "01K00000000000000000000009",
      at: "2026-10-04T12:00:00.000Z",
      author: "machine:XXXXXXXXXXXXXXXX",
      actor_kind: "agent",
      checkpoint: "G-AAAAAAAAAA",
      decision: "approved",
      story: "2-6",
      reason: "not_human",
    };
    expect(formatIgnoredLine(en, item)).toBe(
      `01K00000000000000000000009 · ${localDateTime(item.at)} · machine:XXXXXXXXXXXXXXXX · G-AAAAAAAAAA · approved: it answers in the creator's name without a creator's key`,
    );
    expect(formatIgnoredLine(fr, item)).toBe(
      `01K00000000000000000000009 · ${localDateTime(item.at)} · machine:XXXXXXXXXXXXXXXX · G-AAAAAAAAAA · validé : il répond au nom du créateur sans clé de créateur`,
    );
    const text = formatValidationHistory(en, { entries: [], ignored: [item], export: null });
    expect(text).toBe(
      `No validation.\n\nIgnored validations (1):\n  ${formatIgnoredLine(en, item)}\n`,
    );
  });

  it("the export's confirmation, with the ignored answers written", () => {
    const text = formatValidationHistory(en, {
      entries: [],
      ignored: [],
      export: { path: "h.json", format: "json", count: 0, ignored: 2, replaced: false },
    });
    expect(text).toBe(
      "Validations exported to h.json (JSON): 0.\nNo validation.\nIgnored answers exported too: 2.\n",
    );
  });

  it("has a label for every source of a validation, in every language", () => {
    for (const source of RESOLUTION_SOURCES) {
      expect(isMessageKey(`history.source.${source}`), source).toBe(true);
      expect(fr(`history.source.${source}` as "history.source.terminal")).not.toBe("");
    }
  });
});
