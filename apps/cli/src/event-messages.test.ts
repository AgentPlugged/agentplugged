import { AgentPluggedError } from "@agentplugged/core";
import { createTranslator, isMessageKey, type Locale } from "@agentplugged/i18n";
import {
  BLOCKABLE_ACTIONS,
  CHECKPOINT_RISKS,
  CHECKPOINT_STATUSES,
  CHECKPOINT_TYPES,
  CONFIRMATION_MODES,
  type CodedErrorPayload,
  CRITERION_OPERATORS,
  CRITERION_SEVERITIES,
  ErrorCode,
  EVENT_REASON,
  eventTypeUpgrade,
  parseEventEnvelope,
  RECIPIENT_ROLES,
  SIGNATURE_REASON,
  VERDICT_RESULTS,
} from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { errorMessage } from "./error-text.js";
import { formatJournalSync } from "./main.js";

function render(locale: Locale, payload: CodedErrorPayload): string {
  const error = new AgentPluggedError(payload.code, payload.message_key, payload.details);
  return errorMessage(createTranslator(locale), error);
}

function parseError(input: unknown): CodedErrorPayload {
  const result = parseEventEnvelope(input);
  if (result.success) throw new Error("expected a rejection");
  return result.error;
}

describe("event envelope and signature messages", () => {
  it("has a message for every error and reason", () => {
    for (const key of [
      "error.event_invalid",
      "error.signature_invalid",
      "error.event_upgrade_required",
      "error.event_type_upgrade_required",
      ...Object.values(EVENT_REASON),
      ...Object.values(SIGNATURE_REASON),
    ]) {
      expect(isMessageKey(key), key).toBe(true);
    }
  });

  it("renders EVENT_INVALID with its translated reason", () => {
    const payload = parseError({ v: 1, id: "nope" });
    expect(render("fr", payload)).toBe(
      "Événement invalide : champ « id » (un ULID est attendu (26 caractères, base32 de Crockford en majuscules)).",
    );
    expect(render("en", payload)).toBe(
      'Invalid event: field "id" (expected a ULID (26 characters, uppercase Crockford base32)).',
    );
  });

  it("renders SIGNATURE_INVALID with its translated reason", () => {
    const payload: CodedErrorPayload = {
      code: ErrorCode.SIGNATURE_INVALID,
      message_key: "error.signature_invalid",
      details: { field: "sig", reason_key: SIGNATURE_REASON.counterRegression },
    };
    expect(render("fr", payload)).toBe(
      "Signature de l'événement refusée : champ « sig » (le compteur de signatures WebAuthn n'a pas augmenté : l'identifiant a peut-être été copié ou l'assertion rejouée).",
    );
    expect(render("en", payload)).toBe(
      'Event signature rejected: field "sig" (the WebAuthn signature counter did not increase: the credential may be cloned or the assertion replayed).',
    );
  });

  it("renders UPGRADE_REQUIRED with the version and the supported one", () => {
    const payload = parseError({ v: 15 });
    expect(payload.code).toBe("UPGRADE_REQUIRED");
    expect(render("fr", payload)).toBe(
      "Cet événement utilise la version 15 de l'enveloppe, plus récente que celle que ce moteur connaît (version 14). Mets agentplugged à jour pour le lire.",
    );
    expect(render("en", payload)).toBe(
      "This event uses envelope version 15, newer than this engine knows (version 14). Update agentplugged to read it.",
    );
  });

  it("renders UPGRADE_REQUIRED for an unknown event type, with its type and version", () => {
    const payload = eventTypeUpgrade("story.teleported", 1) as CodedErrorPayload;
    expect(payload.message_key).toBe("error.event_type_upgrade_required");
    expect(render("fr", payload)).toBe(
      "Le journal contient un événement de type story.teleported en version 1, que ce moteur ne connaît pas : rien n'a été écrit. Mets à jour agentplugged (`npx agentplugged@latest`) pour le lire.",
    );
    expect(render("en", payload)).toBe(
      "The journal holds an event of type story.teleported in version 1, which this engine does not know: nothing was written. Update agentplugged (`npx agentplugged@latest`) to read it.",
    );
  });
});

describe("journal messages", () => {
  it("renders JOURNAL_BUSY and NOT_A_GIT_REPO", () => {
    const busy: CodedErrorPayload = {
      code: ErrorCode.JOURNAL_BUSY,
      message_key: "error.journal_busy",
      details: {
        lock: ".git/agentplugged-journal.lock",
        waited_ms: 2_480,
        waited_s: 2.5,
        stale_s: 30,
      },
    };
    expect(render("fr", busy)).toBe(
      "Le journal est occupé : un autre processus a tenu son verrou (.git/agentplugged-journal.lock) pendant les 2.5 s d'attente de cette commande. Rien n'a été écrit. Réessaie dans un instant ; un verrou que son processus ne rafraîchit plus est repris au bout de 30 s.",
    );
    expect(render("en", busy)).toBe(
      "The journal is busy: another process held its lock (.git/agentplugged-journal.lock) for the 2.5 s this command waited. Nothing was written. Try again in a moment; a lock its process stopped refreshing is taken over after 30 s.",
    );
    const mismatch: CodedErrorPayload = {
      code: ErrorCode.PRODUCT_ID_MISMATCH,
      message_key: "error.product_id_mismatch",
      details: {
        product_id: "01JZBBBBBBBBBBBBBBBBBBBBBB",
        journal_product_id: "01JZAAAAAAAAAAAAAAAAAAAAAA",
      },
    };
    expect(render("fr", mismatch)).toBe(
      "L'identifiant de ce produit (01JZBBBBBBBBBBBBBBBBBBBBBB) n'est pas celui que tient son journal (01JZAAAAAAAAAAAAAAAAAAAAAA) : rien n'a été écrit. Mets `product_id: 01JZAAAAAAAAAAAAAAAAAAAAAA` dans .agentplugged/method.yaml.",
    );
    expect(render("en", mismatch)).toContain("its journal holds (01JZAAAAAAAAAAAAAAAAAAAAAA)");
    const notARepo: CodedErrorPayload = {
      code: ErrorCode.NOT_A_GIT_REPO,
      message_key: "error.not_a_git_repo",
      details: { path: "/tmp/product" },
    };
    expect(render("fr", notARepo)).toBe(
      "/tmp/product n'est pas dans un dépôt Git : le journal vit sur sa branche agentplugged/journal. Lance d'abord `git init`. Rien n'a été écrit.",
    );
    expect(render("en", notARepo)).toBe(
      "/tmp/product is not in a Git repository: the journal lives on its agentplugged/journal branch. Run `git init` first. Nothing was written.",
    );
  });
});

describe("journal sync messages", () => {
  const payload = (
    code: CodedErrorPayload["code"],
    key: string,
    details: Record<string, unknown>,
  ): CodedErrorPayload => ({ code, message_key: key, details });

  it("renders every sync error in French and English", () => {
    const cases = [
      payload(ErrorCode.JOURNAL_REWRITTEN, "error.journal_rewritten", {
        remote: "origin",
        missing: 2,
      }),
      payload(ErrorCode.JOURNAL_REMOTE_UNREACHABLE, "error.journal_remote_unreachable", {
        remote: "origin",
        reason: "fatal: repository not found",
      }),
      payload(ErrorCode.JOURNAL_CONFLICT, "error.journal_conflict.content", {
        remote: "origin",
        path: "journal/2026/10/01JZ0000000000000000000000.json",
      }),
      payload(ErrorCode.JOURNAL_CONFLICT, "error.journal_conflict.invalid", {
        remote: "origin",
        path: "journal/2026/10/01JZ0000000000000000000000.json",
      }),
      payload(ErrorCode.JOURNAL_CONFLICT, "error.journal_conflict.duplicate", {
        remote: "origin",
        path: "journal/2026/10/01JZ0000000000000000000000.json",
      }),
      payload(ErrorCode.JOURNAL_CONFLICT, "error.journal_conflict.outside", {
        remote: "origin",
        path: "README.md",
      }),
      payload(ErrorCode.JOURNAL_PUSH_REJECTED, "error.journal_push_rejected", {
        remote: "origin",
        attempts: 3,
      }),
      payload(ErrorCode.NO_REMOTE, "error.no_remote", {}),
      payload(ErrorCode.NO_REMOTE, "error.no_remote.named", { remote: "nope" }),
      payload(ErrorCode.PRODUCT_ID_MISMATCH, "error.product_id_mismatch.remote", {
        remote: "origin",
        product_id: "01JZBBBBBBBBBBBBBBBBBBBBBB",
        journal_product_id: "01JZAAAAAAAAAAAAAAAAAAAAAA",
      }),
    ];
    for (const error of cases) {
      expect(isMessageKey(error.message_key), error.message_key).toBe(true);
      for (const locale of ["fr", "en"] as const) {
        const text = render(locale, error);
        expect(text, `${locale} ${error.message_key}`).not.toMatch(/\{\w+\}/);
      }
    }
    expect(render("fr", cases[0] as CodedErrorPayload)).toContain(
      "puis lance `npx agentplugged journal sync --recreate-remote` depuis une machine qui a le journal complet.",
    );
    expect(render("en", cases[0] as CodedErrorPayload)).toContain(
      "Nothing was integrated or pushed. Delete the remote branch agentplugged/journal",
    );
    expect(render("fr", cases[1] as CodedErrorPayload)).toBe(
      "Git n'a pas pu joindre origin : fatal: repository not found. Rien n'a été intégré ni envoyé. Vérifie l'adresse du dépôt distant et ton accès (`git fetch origin`), puis relance `npx agentplugged journal sync`.",
    );
    expect(render("fr", cases.at(-1) as CodedErrorPayload)).toBe(
      "Le journal de origin appartient à un autre produit (01JZBBBBBBBBBBBBBBBBBBBBBB) que celui-ci (01JZAAAAAAAAAAAAAAAAAAAAAA) : les deux machines ont initialisé le produit chacune de son côté. Rien n'a été fusionné.",
    );
    expect(render("en", cases[6] as CodedErrorPayload)).toContain("the push was refused 3 times");
  });

  it("summarises a merge, a fast-forward and nothing to do", () => {
    const base = {
      remote: "origin",
      received: 0,
      sent: 0,
      created: false,
      pushes: 0,
      empty: false,
    } as const;
    const fr = createTranslator("fr");
    const en = createTranslator("en");
    expect(
      formatJournalSync(fr, { ...base, integration: "merge", received: 4, sent: 2, pushes: 1 }),
    ).toBe(
      "Journal synchronisé avec origin\n  reçus : 4 (fusion des deux journaux)\n  envoyés : 2\n",
    );
    expect(formatJournalSync(en, { ...base, integration: "fast_forward", received: 5 })).toBe(
      "Journal synchronized with origin\n  received: 5 (fast-forward)\n  sent: 0\n",
    );
    expect(formatJournalSync(en, { ...base, integration: "none" })).toBe(
      "Journal already up to date with origin.\n",
    );
    expect(formatJournalSync(fr, { ...base, integration: "none", empty: true })).toBe(
      "Rien à synchroniser avec origin : le journal est vide.\n",
    );
    expect(formatJournalSync(en, { ...base, integration: "none", empty: true })).toBe(
      "Nothing to sync with origin: the journal is empty.\n",
    );
  });
});

describe("checkpoint messages", () => {
  it("has a label for every type, risk, role, confirmation, action, status and verdict", () => {
    const keys = [
      ...CHECKPOINT_TYPES.map((type) => `checkpoint.type.${type}`),
      ...CHECKPOINT_RISKS.map((risk) => `checkpoint.risk.${risk}`),
      ...RECIPIENT_ROLES.map((role) => `checkpoint.role.${role}`),
      ...CONFIRMATION_MODES.map((mode) => `checkpoint.confirmation.${mode}`),
      ...BLOCKABLE_ACTIONS.map((action) => `checkpoint.action.${action}`),
      ...CHECKPOINT_STATUSES.map((status) => `checkpoint.status.${status}`),
      ...VERDICT_RESULTS.map((result) => `checkpoint.verdict.${result}`),
      ...CRITERION_SEVERITIES.map((severity) => `checkpoint.severity.${severity}`),
      ...CRITERION_OPERATORS.map((op) => `checkpoint.op.${op}`),
      "checkpoint.verdict.missing",
    ];
    for (const key of keys) expect(isMessageKey(key), key).toBe(true);
  });

  it("renders CHECKPOINT_OPEN in English and in French", () => {
    const payload: CodedErrorPayload = {
      code: ErrorCode.CHECKPOINT_OPEN,
      message_key: "error.checkpoint_open",
      details: { checkpoint: "G-N6R5W8Y0AB", action: "story.review" },
    };
    expect(render("en", payload)).toBe(
      "Checkpoint G-N6R5W8Y0AB is open and blocks moving the story to review: nothing was written. Only the creator answers it; work on something else meanwhile, and never work around this refusal.",
    );
    expect(render("fr", payload)).toContain(
      "Le point de contrôle G-N6R5W8Y0AB est ouvert et bloque le passage de la story en revue",
    );
  });

  it("renders CHECKPOINT_NOT_FOUND and CHECKPOINT_NOT_OPEN", () => {
    const missing: CodedErrorPayload = {
      code: ErrorCode.CHECKPOINT_NOT_FOUND,
      message_key: "error.checkpoint_not_found",
      details: { checkpoint: "G-N6R5W8Y0AB" },
    };
    expect(render("en", missing)).toBe("No checkpoint G-N6R5W8Y0AB: nothing was written.");
    expect(render("fr", missing)).toBe(
      "Aucun point de contrôle G-N6R5W8Y0AB : rien n'a été écrit.",
    );
    const closed: CodedErrorPayload = {
      code: ErrorCode.CHECKPOINT_NOT_OPEN,
      message_key: "error.checkpoint_not_open",
      details: { checkpoint: "G-N6R5W8Y0AB", status: "resolved" },
    };
    expect(render("en", closed)).toBe(
      "Checkpoint G-N6R5W8Y0AB is no longer open (resolved): nothing was written.",
    );
  });
});

describe("phase messages", () => {
  it("names the phases, never prints null, and lists who closes a phase", () => {
    const notCurrent: CodedErrorPayload = {
      code: ErrorCode.PHASE_NOT_CURRENT,
      message_key: "error.phase_not_current",
      details: { phase: "design", current: "framing", reason: "not_current" },
    };
    expect(render("fr", notCurrent)).toContain(
      "La phase Conception n'est pas la phase en cours (Cadrage) : rien n'a été écrit.",
    );
    const none: CodedErrorPayload = {
      code: ErrorCode.PHASE_NOT_CURRENT,
      message_key: "error.phase_none_current",
      details: { phase: "build", current: null, reason: "none_current" },
    };
    expect(render("fr", none)).toContain("la fin de Réalisation ne peut pas s'ouvrir");
    expect(render("en", none)).not.toContain("null");
    const open: CodedErrorPayload = {
      code: ErrorCode.PHASE_NOT_CURRENT,
      message_key: "error.phase_end_already_open",
      details: {
        phase: "framing",
        current: "framing",
        checkpoint: "G-N6R5W8Y0AB",
        reason: "already_open",
      },
    };
    expect(render("en", open)).toBe(
      "The end of the Framing phase is already open (G-N6R5W8Y0AB): nothing was written. Wait for the creator's answer.",
    );
    const closer: CodedErrorPayload = {
      code: ErrorCode.AGENT_NOT_CLOSER,
      message_key: "error.agent_not_closer",
      details: { agent: "iris", phase: "build", closers: ["izzy", "sam"] },
    };
    expect(render("fr", closer)).toBe(
      "iris ne ferme pas la phase Réalisation : rien n'a été écrit. Elle est ouverte par izzy, sam.",
    );
  });
});
