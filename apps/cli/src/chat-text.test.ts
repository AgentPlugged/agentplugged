import { Readable } from "node:stream";
import type {
  CheckpointState,
  CommandContext,
  CommandRegistry,
  HistoryEntry,
} from "@agentplugged/core";
import { createTranslator, isMessageKey } from "@agentplugged/i18n";
import {
  VALIDATION_ASSURANCES,
  VALIDATION_MODES,
  VALIDATION_SOURCES,
} from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { formatHistoryLine } from "./history-text.js";
import { createPrompter } from "./prompt.js";
import { runReview } from "./review-flow.js";

const en = createTranslator("en");
const fr = createTranslator("fr");

const ENTRY: HistoryEntry = {
  event: "01K00000000000000000000001",
  at: "2026-10-03T10:00:00.000Z",
  author: "machine:AAAAAAAAAAAAAAAA",
  author_trust: null,
  author_endorsed_at: null,
  source: "chat",
  decision: "approved",
  option: null,
  waiver_until: null,
  assurance: "chat",
  locale_on_high_risk: false,
  checkpoint: "G-AAAAAAAAAA",
  checkpoint_type: "story",
  checkpoint_risk: "low",
  checkpoint_title: "Story 2-6 done",
  story: "2-6",
  checkpoint_phase: null,
  quote: "Valide\u001b[2J !",
  relayed_by: "main",
  channel: null,
  stack: null,
  via: null,
};

describe("the chat's answers in the history", () => {
  it("says « via le chat », the assurance, the words quoted and who relayed them", () => {
    const line = formatHistoryLine(fr, ENTRY);
    expect(line).toContain(" · via le chat · validé · ");
    expect(line).toContain("vérifiée par la citation");
    expect(line).toContain("tes mots : « Valide [2J ! »");
    expect(line).toContain("relayé par main");
    const unverified = formatHistoryLine(fr, { ...ENTRY, assurance: "chat_unverified" });
    expect(unverified).toContain("non vérifiée");
    const auto = formatHistoryLine(fr, {
      ...ENTRY,
      source: "auto",
      assurance: "system",
      decision: "option_chosen",
      option: "b",
      quote: null,
      relayed_by: null,
    });
    expect(auto).toContain(" · appliqué automatiquement · option choisie (option b) · ");
    expect(formatHistoryLine(en, { ...ENTRY, decision: "reopened" })).toContain(" · reopened · ");
  });

  it("has a label for every source, assurance and level, in every language", () => {
    for (const key of [
      ...VALIDATION_SOURCES.map((source) => `history.source.${source}`),
      ...VALIDATION_ASSURANCES.map((assurance) => `assurance.${assurance}`),
      ...VALIDATION_MODES.map((mode) => `validation.mode.${mode}`),
      "review.decision.reopened",
    ]) {
      expect(isMessageKey(key), key).toBe(true);
    }
  });
});

describe("review: a checkpoint applied automatically", () => {
  const checkpoint = {
    id: "G-AAAAAAAAAA",
    type: "decision",
    risk: "low",
    irreversible: false,
    recipient_role: "product",
    confirmation: ["gesture_undo_10s"],
    title: "Pick a name",
    summary: "Which name?",
    story: null,
    documents: [],
    blocks: [],
    options: [
      { id: "a", label: "A", consequence: "a" },
      { id: "b", label: "B", consequence: "b" },
    ],
    recommendation: "b",
    criteria: null,
    source: null,
    status: "resolved",
    opened_by: "main",
    opened_at: "2026-10-03T10:00:00.000Z",
    opened_event: "01K00000000000000000000001",
    measures: {},
    verdict: null,
    resolution: {
      decision: "option_chosen",
      option: "b",
      note: null,
      waiver_until: null,
      by: "machine:AAAAAAAAAAAAAAAA",
      at: "2026-10-03T10:00:00.000Z",
      assurance: "system",
      source: "auto",
      event: "01K00000000000000000000002",
      quote: null,
      confirmation_quote: null,
      relayed_by: null,
      proof: null,
    },
    supersedes: null,
    phase: null,
    blocks_lifted: true,
    waived_ms: 0,
    request: null,
    untrusted: null,
    provenance: "trusted",
  } as unknown as CheckpointState;

  async function review(answers: string[]) {
    const calls: Record<string, unknown>[] = [];
    const registry = {
      run: async (_name: string, _context: CommandContext, input: Record<string, unknown>) => {
        calls.push(input);
        return input.action === "list"
          ? {
              ok: true,
              value: {
                action: "list",
                checkpoints: [checkpoint],
                device: "human:AAAAAAAAAAAAAAAA",
                presence: { status: "unavailable" },
                pending: [],
              },
            }
          : { ok: true, value: { action: "reopen", checkpoint: checkpoint.id } };
      },
    } as unknown as CommandRegistry;
    let said = "";
    const prompter = createPrompter(
      Readable.from([answers.map((a) => `${a}\n`).join("")]),
      (text) => {
        said += text;
      },
    );
    const text = await runReview(en, prompter, registry, {} as CommandContext, checkpoint.id, {
      undoMs: 0,
      now: () => Date.parse("2026-10-03T11:00:00.000Z"),
    });
    prompter.close();
    return { text, said, calls };
  }

  it("offers to reopen it, and quits by default", async () => {
    const quit = await review([""]);
    expect(quit.said).toContain("Applied automatically (auto level): option b");
    expect(quit.said).toContain("1. Reopen (cancel the automatic application)");
    expect(quit.calls.map((call) => call.action)).toEqual(["list"]);
    const reopened = await review(["1"]);
    expect(reopened.calls.at(-1)).toEqual({ action: "reopen", checkpoint: checkpoint.id });
    expect(reopened.text).toBe(
      "Reopened: G-AAAAAAAAAA is open again; answer it in the chat or here.\n",
    );
  });
});
