import { AgentPluggedError, type NextResult } from "@agentplugged/core";
import { createTranslator, isMessageKey, type Locale } from "@agentplugged/i18n";
import {
  CONFLICT_OPTIONS,
  ErrorCode,
  MERGE_CONFLICT_REASONS,
  MERGE_FAILURES,
} from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { errorMessage } from "./error-text.js";
import { formatNext } from "./next-text.js";

/** The texts of the order of the merges and of the conflicts, in both languages. */

const render = (
  locale: Locale,
  code: ErrorCode,
  key: string,
  details: Record<string, unknown>,
): string => errorMessage(createTranslator(locale), new AgentPluggedError(code, key, details));

const base: NextResult = {
  step: "merge_conflict",
  you: false,
  agent: "sam",
  agent_name: "Sam",
  tool: "claude-code",
  waiting: [],
  command: "npx agentplugged story start 4-3",
  story: "4-3",
  checkpoint: null,
  sync: null,
  missing_tools: [],
  pending_keys: [],
  phase: null,
  phases: [],
  stray: [],
  sprint: null,
  deferred: null,
};

describe("the order of the merges and the conflicts: texts", () => {
  it("has a text, in both languages, for every refusal, reason, option and step", () => {
    const keys = [
      ...MERGE_FAILURES.map((reason) => `error.merge_failed.${reason}`),
      ...MERGE_CONFLICT_REASONS.map((reason) => `error.merge_conflict.${reason}`),
      ...CONFLICT_OPTIONS.map((option) => `merge.option.${option}`),
      "merge.wait.dependency",
      "merge.wait.overlap",
      "merge.unverified.rebased",
      "merge.unverified.octopus",
      "merge.unverified.unreadable",
      "merge.unverified.undecided",
      "next.step.merge_conflict",
      "next.merge_queue",
    ];
    for (const key of keys) expect(isMessageKey(key), key).toBe(true);
    for (const locale of ["fr", "en"] as const) {
      const t = createTranslator(locale);
      for (const key of keys) {
        if (isMessageKey(key)) expect(t(key, {}).length, `${locale} ${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("says why a merge waits, in the creator's words", () => {
    const details = { story: "4-3", checkpoint: "G-0000000001", before: "4-1", why: "overlap" };
    expect(
      render("fr", ErrorCode.MERGE_FAILED, "error.merge_failed.out_of_order", details),
    ).toContain("ne fusionne pas avant la story 4-1 (elles changent les mêmes fichiers)");
    expect(
      render("en", ErrorCode.MERGE_FAILED, "error.merge_failed.out_of_order", details),
    ).toContain("does not merge before story 4-1 (they change the same files)");
    expect(
      render("fr", ErrorCode.MERGE_FAILED, "error.merge_failed.out_of_order", {
        ...details,
        why: "dependency",
      }),
    ).toContain("(elle en dépend)");
  });

  it("says what could not be verified, and names the files of a conflict without a control character", () => {
    const text = render("en", ErrorCode.MERGE_FAILED, "error.merge_failed.conflict_unverified", {
      story: "4-3",
      why: "rebased",
    });
    expect(text).toContain("was rebased");
    const conflict = render("fr", ErrorCode.MERGE_FAILED, "error.merge_failed.conflict", {
      story: "4-3",
      checkpoint: "G-0000000001",
      files: ["src/a.ts", "src/\u001b[31mb.ts"],
    });
    expect(conflict).toContain("src/a.ts");
    expect(conflict).not.toContain("\u001b");
  });

  it("tells the developer, tutoiement included, what the engine read of their conflict", () => {
    const forced = render(
      "fr",
      ErrorCode.MERGE_CONFLICT,
      "error.merge_conflict.forced_substantive",
      {
        story: "4-3",
        files: ["src/cart.ts (both_modified)"],
      },
    );
    expect(forced).toContain("Tu ne peux pas le qualifier « textuel »");
    expect(forced).toContain("src/cart.ts (both_modified)");
    expect(
      render("en", ErrorCode.MERGE_CONFLICT, "error.merge_conflict.not_developer", {
        story: "4-3",
        developer: "sam",
        agent: "izzy",
      }),
    ).toBe(
      "Only story 4-3's developer (sam) qualifies its conflicts, not izzy. Nothing was written.",
    );
  });

  it("shows the conflict to resolve and the creator's choice", () => {
    const fr = createTranslator("fr");
    const textual = formatNext(fr, {
      ...base,
      merge_conflict: {
        kind: "textual",
        phase: "to_resolve",
        checkpoint: null,
        option: null,
        note: null,
        files: ["src/index.ts"],
      },
    });
    expect(textual).toContain("Conflit textuel qualifié (src/index.ts)");
    const decided = formatNext(fr, {
      ...base,
      merge_conflict: {
        kind: "substantive",
        phase: "decided",
        checkpoint: "G-0000000001",
        option: "keep_main",
        note: null,
        files: ["src/cart.ts"],
      },
    });
    expect(decided).toContain("Tu as choisi « garder la version de la branche principale »");
    const en = formatNext(createTranslator("en"), {
      ...base,
      merge_conflict: {
        kind: "substantive",
        phase: "decided",
        checkpoint: "G-0000000001",
        option: "combine",
        note: null,
        files: [],
      },
    });
    expect(en).toContain('You chose "combine both versions"');
  });

  it("shows the queue of the merges in its order", () => {
    const queue = [
      { position: 1, story: "4-1", checkpoint: "G-0000000001" },
      { position: 2, story: "4-3", checkpoint: "G-0000000002" },
    ];
    expect(
      formatNext(createTranslator("fr"), { ...base, step: "validation", merge_queue: queue }),
    ).toContain("Fusions, dans l'ordre : 1. 4-1, 2. 4-3.");
    expect(
      formatNext(createTranslator("en"), { ...base, step: "validation", merge_queue: queue }),
    ).toContain("Merges, in order: 1. 4-1, 2. 4-3.");
  });
});
