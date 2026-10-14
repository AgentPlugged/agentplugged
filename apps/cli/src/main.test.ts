import { createTranslator } from "@agentplugged/i18n";
import { describe, expect, it } from "vitest";
import { commandLine, formatJournalStatus, localeOf } from "./main.js";

describe("localeOf", () => {
  it.each([
    [
      "AGENTPLUGGED_LANG wins",
      { AGENTPLUGGED_LANG: "fr", LC_ALL: "en_US", LANG: "en_US" },
      "en-US",
      "fr",
    ],
    [
      "AGENTPLUGGED_LANG wins over a French system",
      { AGENTPLUGGED_LANG: "en", LANG: "fr_FR" },
      "fr-FR",
      "en",
    ],
    ["LC_ALL beats LANG", { LC_ALL: "fr_FR.UTF-8", LANG: "en_US.UTF-8" }, undefined, "fr"],
    ["LC_ALL beats LANG (English)", { LC_ALL: "en_US", LANG: "fr_FR" }, undefined, "en"],
    ["LANG with an encoding", { LANG: "fr_FR.UTF-8" }, undefined, "fr"],
    ["all unset: system locale", {}, "fr-FR", "fr"],
    ["all unset, no system locale: English", {}, undefined, "en"],
    ["C is skipped", { LC_ALL: "C", LANG: "fr_FR.UTF-8" }, undefined, "fr"],
    ["POSIX is skipped", { LANG: "POSIX" }, "fr-FR", "fr"],
    ["C.UTF-8 is skipped", { LC_ALL: "C.UTF-8" }, "fr-CA", "fr"],
  ] as const)("%s", (_name, env, systemLocale, expected) => {
    expect(localeOf(env, systemLocale)).toBe(expected);
  });
});

describe("commandLine", () => {
  it("leaves out --engine-any and --upgrade-engine", () => {
    expect(commandLine(["sync", "--engine-any"])).toBe("sync");
    expect(commandLine(["--upgrade-engine", "init", "--profile", "prototype"])).toBe(
      "init --profile prototype",
    );
  });

  it("single-quotes an argument with a space", () => {
    expect(commandLine(["agent", "create", "scout", "--title", "Market Scout"])).toBe(
      "agent create scout --title 'Market Scout'",
    );
  });

  it("single-quotes an argument with $ or a backtick, so no shell expands it", () => {
    expect(commandLine(["agent", "create", "x", "--description", "costs $HOME `id`"])).toBe(
      "agent create x --description 'costs $HOME `id`'",
    );
  });

  it("escapes a single quote inside a quoted argument", () => {
    expect(commandLine(["--title", "Ada's agent"])).toBe("--title 'Ada'\\''s agent'");
  });
});

describe("formatJournalStatus", () => {
  const state = {
    format: 1 as const,
    journal_head: "abc",
    computed_at: "2026-10-03T08:00:00.000Z",
    product: null,
    devices: [],
    applied: 0,
    ignored: [
      { id: "01JZ0000000000000000000001", reason: "bad_signature" as const },
      { id: "01JZ0000000000000000000002", reason: "broken_chain" as const },
    ],
    warnings: [],
    state: {},
  };
  const rewritten = (missing: number, unknown = false) => ({
    code: "history_rewritten" as const,
    missing,
    unknown,
  });

  it("lists the events ignored with their reason, the warnings and state.json, in French", () => {
    const t = createTranslator("fr");
    expect(formatJournalStatus(t, { state, file: "written", warnings: [rewritten(2)] })).toBe(
      [
        "État du produit",
        "  Produit : aucun pour l'instant",
        "  Appareils : 0",
        "  Clés de créateur : 0",
        "  Événements appliqués : 0",
        "",
        "Événements ignorés (2) :",
        "  01JZ0000000000000000000001 : sa signature est fausse",
        "  01JZ0000000000000000000002 : sa chaîne est rompue (l'événement précédent est absent, ignoré ou d'un autre appareil)",
        "",
        "Avertissements :",
        "  L'historique du journal a été réécrit depuis la dernière projection sur cette machine : 2 événements projetés alors ont disparu. L'état a été calculé à partir du journal tel qu'il est maintenant.",
        "",
        "État écrit dans .agentplugged/.cache/state.json.",
        "",
      ].join("\n"),
    );
  });

  it("uses singular, plural, or no count for a rewritten history, in both languages", () => {
    for (const locale of ["en", "fr"] as const) {
      const t = createTranslator(locale);
      const text = (warning: ReturnType<typeof rewritten>) =>
        formatJournalStatus(t, { state, file: "unchanged", warnings: [warning] });
      expect(text(rewritten(1))).toContain(
        locale === "en"
          ? ": 1 event projected then is gone."
          : " : 1 événement projeté alors a disparu.",
      );
      expect(text(rewritten(3))).toContain(
        locale === "en"
          ? ": 3 events projected then are gone."
          : " : 3 événements projetés alors ont disparu.",
      );
      for (const warning of [rewritten(0, true), rewritten(0)]) {
        expect(text(warning)).toContain(
          locale === "en"
            ? "since this machine's last projection. The state"
            : "sur cette machine. L'état",
        );
      }
    }
  });

  it("translates every reason and every state.json outcome in English", () => {
    const t = createTranslator("en");
    const reasons = [
      "unknown_signer",
      "bad_signature",
      "broken_chain",
      "wrong_product",
      "invalid",
      "key_conflict",
      "product_conflict",
      "test_type",
      "checkpoint_id_collision",
    ] as const;
    const ignored = reasons.map((reason) => ({ id: reason, reason }));
    const text = formatJournalStatus(t, {
      state: { ...state, ignored },
      file: "unchanged",
      warnings: [],
    });
    expect(text).toContain("  unknown_signer: no key is registered for its device\n");
    expect(text).toContain("  product_conflict: it creates another product than this one\n");
    expect(text).toContain("  test_type: its type is reserved to tests\n");
    expect(text).toContain(
      "  checkpoint_id_collision: its checkpoint id is already taken by a checkpoint opened before it\n",
    );
    expect(text).not.toContain("journal.ignored");
    expect(text).toContain("\n.agentplugged/.cache/state.json is already up to date.\n");
    const absent = formatJournalStatus(t, { state, file: "not_installed", warnings: [] });
    expect(absent).toContain(
      "\n.agentplugged/.cache/state.json was not written: the method is not installed here (run `npx agentplugged init`).\n",
    );
    const fr = formatJournalStatus(createTranslator("fr"), {
      state,
      file: "not_installed",
      warnings: [],
    });
    expect(fr).toContain(
      "n'a pas été écrit : la méthode n'est pas installée ici (lance `npx agentplugged init`).",
    );
  });

  it("lists the open checkpoints and the checkpoint warnings, in both languages", () => {
    const checkpoint = (id: string, opened_event: string, extra: Record<string, unknown>) => ({
      id,
      type: "decision",
      risk: "high",
      recipient_role: "tech_lead",
      title: `Title of ${id}`,
      story: null,
      status: "open",
      opened_event,
      verdict: null,
      ...extra,
    });
    const withCheckpoints = {
      ...state,
      ignored: [],
      warnings: [
        { code: "checkpoint_id_collision" as const, checkpoint: "G-B", ids: ["01A", "01B"] },
        {
          code: "checkpoint_weak_payload" as const,
          checkpoint: "G-A",
          id: "01C",
          fields: ["recipient_role" as const],
        },
      ],
      state: {
        checkpoints: {
          "G-A": checkpoint("G-A", "01JZ0000000000000000000009", {
            story: "2-6",
            verdict: { result: "pass_with_reservations", reasons: [], criteria: [] },
          }),
          "G-B": checkpoint("G-B", "01JZ0000000000000000000001", { type: "story", risk: "low" }),
        },
      },
    };
    const en = formatJournalStatus(createTranslator("en"), {
      state: withCheckpoints,
      file: "unchanged",
      warnings: [],
    });
    expect(en).toContain(
      [
        "Open checkpoints (2):",
        "  G-B: Title of G-B",
        "    story, low risk, for tech lead",
        "  G-A: Title of G-A",
        "    decision, high risk, story 2-6, for tech lead, verdict: pass with reservations",
      ].join("\n"),
    );
    expect(en).toContain("Checkpoint G-B: 01A, 01B give the same id; only the first is kept.");
    expect(en).toContain(
      "Checkpoint G-A (01C) asked less than the rules require (recipient_role): the rules apply.",
    );
    const fr = formatJournalStatus(createTranslator("fr"), {
      state: withCheckpoints,
      file: "unchanged",
      warnings: [],
    });
    expect(fr).toContain("Points de contrôle ouverts (2) :");
    expect(fr).toContain(
      "    décision, risque élevé, story 2-6, pour responsable technique, verdict : réussi avec réserves",
    );
  });
});
