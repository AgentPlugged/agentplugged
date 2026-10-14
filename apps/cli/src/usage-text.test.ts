import { REPORT_AXES, type ReportRow, type UsageReport } from "@agentplugged/core";
import { createTranslator } from "@agentplugged/i18n";
import { describe, expect, it } from "vitest";
import { formatUsage, usageJson } from "./usage-text.js";

const en = createTranslator("en");
const fr = createTranslator("fr");

const row = (key: string | null, origin: ReportRow["origin"], total: number): ReportRow => ({
  key,
  origin,
  tokens_in: 0,
  tokens_out: total,
  cache_read: 0,
  cache_write: 0,
  total,
  share: total / 1000,
});

const report = (over: Partial<UsageReport> = {}): UsageReport => ({
  usage: "report",
  axis: "skill",
  story: null,
  since: null,
  until: null,
  measured: true,
  sessions: 3,
  sessions_without_parts: 1,
  tokens_origin: { "claude-code": 1000 },
  total: { tokens_in: 0, tokens_out: 1000, cache_read: 0, cache_write: 0, total: 1000 },
  rows: [
    row("develop-story", "tool", 400),
    row("write-prd", "interval", 100),
    row(null, "unknown", 500),
  ],
  unattributed_share: 0.5,
  tools: { unmeasurable: ["cursor"], unread: ["codex"] },
  unreadable: false,
  estimates: {
    standard: { low: 2, expected: 6, high: 14, basis: "reference", stories: 0 },
    fast: { low: 0.3, expected: 1, high: 4, basis: "reference", stories: 0 },
  },
  ...over,
});

describe("what usage shows", () => {
  it("says the origin of every figure, the share nothing attributed and the tools it cannot measure", () => {
    const text = formatUsage(en, report());
    expect(text).toContain("develop-story  40 %  400 tokens  (named by the tool)");
    expect(text).toContain(
      "write-prd  10 %  100 tokens  (deduced from an interval of the journal)",
    );
    expect(text).toContain("(unattributed)  50 %  500 tokens  (origin unknown)");
    expect(text).toContain("Share nothing could attribute: 50 %");
    expect(text).toContain("Cannot be measured: cursor");
    expect(text).toContain("Not read yet: codex");
  });

  it("says nothing was measured, never a zero, and the same in French", () => {
    const none = report({
      measured: false,
      sessions: 0,
      rows: [],
      tools: { unmeasurable: [], unread: [] },
    });
    expect(formatUsage(en, none)).toContain("That is not zero; it is unknown.");
    expect(formatUsage(fr, none)).toContain("Ce n'est pas zéro, c'est inconnu.");
    expect(formatUsage(en, none)).not.toMatch(/\b0 tokens\b/);
    expect(formatUsage(fr, report())).toContain("nommé par l'outil");
  });

  it("has a text for every axis and every origin, in both languages", () => {
    for (const axis of REPORT_AXES) {
      for (const origin of ["tool", "interval", "unknown"] as const) {
        const one = report({ axis, rows: [row(null, origin, 1000)] });
        for (const t of [en, fr]) expect(formatUsage(t, one)).not.toMatch(/usage\.[a-z_.]+/);
      }
    }
  });

  it("shows no amount of money but a story's estimate, said to be an estimate", () => {
    for (const t of [en, fr]) {
      const text = formatUsage(t, report());
      expect(text).not.toMatch(/\$|€|usd|real cost|coût réel/i);
    }
    expect(formatUsage(en, report())).toContain(
      "Estimated cost of a story, not a measured cost: 2 to 14 dollars, about 6 (the method's reference).",
    );
    expect(formatUsage(fr, report())).toContain("Coût estimatif d'une story, pas un coût mesuré");
  });

  it("bounds the text to ten rows and leaves the others to --json", () => {
    const many = Array.from({ length: 14 }, (_, index) => row(`skill-${index}`, "tool", 70));
    const text = formatUsage(en, report({ rows: many }));
    expect(text.match(/skill-\d+/g)).toHaveLength(10);
    expect(text).toContain("4 more rows (--json gives them all)");
    expect(JSON.parse(usageJson(report({ rows: many }))).rows).toHaveLength(14);
  });

  it("never prints nor gives in JSON what an optional source provided", () => {
    const withSource = report({
      provided: { low: 11.11, expected: 22.22, high: 33.33, source: "extension" },
    });
    expect(formatUsage(en, withSource)).not.toContain("22.22");
    expect(usageJson(withSource)).not.toContain("22.22");
    expect(usageJson(withSource)).not.toContain("provided");
  });

  it("cleans what a trace wrote before showing it, and names the habits of a session", () => {
    const text = formatUsage(
      en,
      report({
        axis: "session",
        rows: [row("claude-code:\u001b[31ms1", "tool", 1000)],
        habits: {
          session: "claude-code:s1",
          found: {
            skills_reloaded: [{ skill: "write-prd", calls: 2 }],
            files_reread: [{ path: "src/a.ts\u001b[2J", reads: 4, chars: 12000 }],
            tools_failing: [{ tool: "mcp__x__fetch", calls: 5, errors: 3 }],
          },
        },
      }),
    );
    expect(text).not.toContain("\u001b");
    expect(text).toContain("skill write-prd loaded 2 times");
    expect(text).toContain("file src/a.ts");
    expect(text).toContain("failed 3 times out of 5");
    const unavailable = formatUsage(en, report({ habits: { session: "codex:s2", found: null } }));
    expect(unavailable).toContain("cannot be read here");
  });
});
