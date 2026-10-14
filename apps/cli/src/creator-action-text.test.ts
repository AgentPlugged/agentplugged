import type { CheckpointState, NextResult, ReviewResolved } from "@agentplugged/core";
import { createTranslator } from "@agentplugged/i18n";
import { describe, expect, it } from "vitest";
import { formatNext } from "./next-text.js";
import { creatorActionLabel, formatCard, formatResolved } from "./review-flow.js";

const fr = createTranslator("fr");
const en = createTranslator("en");

const REQUEST = {
  id: "G-7M2K9QX4TB",
  type: "creator_action",
  risk: "high",
  irreversible: true,
  recipient_role: "creator",
  confirmation: ["presence", "explicit"],
  title: "Accept story 4-3 without its CI",
  summary: "Reason: the runner is down",
  story: "4-3",
  documents: [],
  blocks: [],
  options: null,
  recommendation: null,
  criteria: null,
  source: null,
  status: "open",
  opened_by: "main",
  opened_at: "2026-10-03T08:00:00.000Z",
  opened_event: "01K6KXJ5G0ED25519PAY10AD01",
  measures: {},
  verdict: null,
  resolution: null,
  supersedes: null,
  phase: null,
  blocks_lifted: false,
  waived_ms: 0,
  request: null,
  untrusted: null,
  provenance: "trusted",
  creator_action: {
    kind: "ci_waive",
    story: "4-3",
    commit: "a".repeat(40),
    reason: "the runner is down",
  },
  executed: null,
} as CheckpointState;

describe("the creator's actions at the terminal", () => {
  it("names the action on the card, in the creator's language", () => {
    const card = formatCard(fr, REQUEST);
    expect(card).toContain("G-7M2K9QX4TB · action réservée · risque élevé · pour créateur");
    expect(card).toContain(
      "Action demandée depuis le chat : accepter une story sans sa CI. Si tu l'approuves, le moteur l'exécute aussitôt.",
    );
    expect(card).toContain("  reason: the runner is down");
    expect(card).toContain(`  commit: ${"a".repeat(40)}`);
    expect(creatorActionLabel(en, "agent_create")).toBe("create an agent or a skill");
    expect(creatorActionLabel(en, "unknown")).toBe("unknown");
  });

  it("shows the whole definition of an agent to create, section by section, before the approval", () => {
    const request = {
      ...REQUEST,
      risk: "medium",
      irreversible: false,
      title: "Create the agent rose",
      creator_action: {
        kind: "agent_create",
        id: "rose",
        title: "Recrutement local",
        description: "Recrute des voisins.",
        domain: "marketing",
        phase: "launch",
        reason: "voisins testeurs",
        content: {
          overview: "Rose recrute des voisins.\u001b[2J",
          produces: ["Une annonce", "Un suivi"],
          works: ["Une question à la fois"],
          never: ["Ne publie rien"],
          principles: ["Le créateur décide"],
          menu: [{ code: "AN", description: "Annonce", prompt: "Rédige l'annonce." }],
          persistent_facts: ["Des voisins, pas une audience."],
        },
      },
    } as unknown as CheckpointState;
    const card = formatCard(fr, request);
    expect(card).toContain("Définition qui sera écrite, exactement telle que tu la lis ici");
    expect(card).toContain("  Présentation :\n    Rose recrute des voisins. [2J");
    expect(card).toContain("  Ce qu'il produit :\n    Une annonce\n    Un suivi");
    expect(card).toContain("  Ce qu'il ne fait jamais :\n    Ne publie rien");
    expect(card).toContain("  Menu :\n    AN · Annonce — Rédige l'annonce.");
    expect(card).toContain("  Faits persistants :\n    Des voisins, pas une audience.");
    // The terminal never receives an escape sequence an agent wrote.
    expect(card).not.toContain(String.fromCharCode(0x1b));
    // The definition is not dumped as JSON in the plain fields.
    expect(card).not.toContain("content:");
    expect(formatCard(createTranslator("en"), request)).toContain(
      "  Never does:\n    Ne publie rien",
    );
  });

  it("says what the approval carried out, and a sync that failed", () => {
    const result: ReviewResolved = {
      action: "resolve",
      checkpoint: "G-7M2K9QX4TB",
      decision: "approved",
      event: { id: "01K6KXJ5G0ED25519PAY10AD02", at: "2026-10-03T08:01:00.000Z" },
      assurance: "presence",
      executed: {
        checkpoint: "G-7M2K9QX4TB",
        kind: "agent_create",
        files: {
          changed: true,
          paths: [".agentplugged/agents/scribe/SKILL.md"],
          sync: { code: "SETTINGS_INVALID" },
        },
      },
    };
    const text = formatResolved(fr, result, { risk: "medium" });
    expect(text).toContain("Action exécutée par le moteur : créer un agent ou une compétence.");
    expect(text).toContain("  .agentplugged/agents/scribe/SKILL.md");
    expect(text).toContain("sync a échoué (SETTINGS_INVALID)");
  });

  it("proposes the chat, with no terminal command to type", () => {
    const usage = fr("cli.usage");
    expect(usage.indexOf("Depuis le chat")).toBeLessThan(usage.indexOf("Commandes :"));
    expect(en("cli.usage")).toContain("From the chat: ask your agent");
    expect(fr("next.ci.waive")).toMatch(/chat/);
    expect(fr("next.ci.waive")).not.toMatch(/terminal/);
    const step = {
      step: "validation",
      you: true,
      agent: null,
      agent_name: null,
      tool: null,
      waiting: [],
      command: "npx agentplugged review G-7M2K9QX4TB",
      story: null,
      checkpoint: "G-7M2K9QX4TB",
      sync: null,
      missing_tools: [],
      pending_keys: [],
      phase: null,
      phases: [],
      stray: [],
      sprint: null,
      deferred: null,
      answer: "chat",
    } as unknown as NextResult;
    expect(formatNext(fr, step)).toContain(
      "Réponds dans le chat de ton outil IA : dans le formulaire du moteur quand il s'affiche, sinon par écrit ou en dictée (l'agent cite ta réponse).",
    );
  });
});
