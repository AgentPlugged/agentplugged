import type { NextResult } from "@agentplugged/core";
import { createTranslator } from "@agentplugged/i18n";
import { describe, expect, it } from "vitest";
import { formatNext, nextJson } from "./next-text.js";

/** The step of a team the creator holds, as the engine answers it. */
function held(reason: "creator" | "emergency_stop"): NextResult {
  return {
    step: "paused",
    you: true,
    agent: null,
    agent_name: null,
    tool: null,
    waiting: [],
    command: null,
    story: null,
    checkpoint: null,
    sync: null,
    missing_tools: [],
    pending_keys: [],
    phase: null,
    phases: [],
    stray: [],
    sprint: null,
    deferred: null,
    stop: true,
    paused: { since: "2026-10-20T09:00:00.000Z", reason },
  } as NextResult;
}

describe("next, while the creator holds the team", () => {
  it("tells the pause and what it means in both languages, instead of the generic stop", () => {
    const fr = formatNext(createTranslator("fr"), held("creator"));
    expect(fr).toContain("L'équipe est en pause depuis 2026-10-20T09:00:00.000Z");
    expect(fr).not.toContain("Rien d'indépendant ne reste");
    const en = formatNext(createTranslator("en"), held("creator"));
    expect(en).toContain("The team is paused since 2026-10-20T09:00:00.000Z");
    expect(en).toContain("starts nothing new");
  });

  it("tells an emergency stop, with the limit of what it cut", () => {
    const fr = formatNext(createTranslator("fr"), held("emergency_stop"));
    expect(fr).toContain("arrêtée en urgence");
    expect(fr).toContain("lancés par le pont");
    const en = formatNext(createTranslator("en"), held("emergency_stop"));
    expect(en).toContain("stopped in an emergency");
  });

  it("keeps the pause in the JSON an agent or a script reads", () => {
    const json = JSON.parse(nextJson(held("creator"))) as Record<string, unknown>;
    expect(json).toMatchObject({
      step: "paused",
      stop: true,
      paused: { since: "2026-10-20T09:00:00.000Z", reason: "creator" },
    });
  });
});
