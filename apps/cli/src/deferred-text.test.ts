import { type DeferredItem, renderConstitutionReference } from "@agentplugged/core";
import { createTranslator } from "@agentplugged/i18n";
import { describe, expect, it } from "vitest";
import { formatDeferred } from "./deferred-text.js";
import { errorMessage } from "./error-text.js";

const item: DeferredItem = {
  id: "D-7M2K9QX4TB",
  title: "Rate-limit the sign-in form",
  detail: "Five tries a minute.\nThen a pause.",
  origin: "review",
  story: "2-5",
  owner: "sam",
  locks: ["2-6", "2-7"],
  phase: "build",
  status: "open",
  recorded_by: "quentin",
  recorded_at: "2026-10-05T09:00:00.000Z",
  event: "01JZ8Q3N4V7M2K9QX4TB",
  closed: null,
};

describe("deferred: text", () => {
  const t = createTranslator("fr");

  it("shows each item with its origin, owner, locks and phase, in French with « tu »", () => {
    expect(
      formatDeferred(t, {
        action: "list",
        story: null,
        open: [item],
        closed: null,
        done: 2,
        dropped: 1,
      }),
    ).toBe(
      "Points reportés ouverts : 1\nD-7M2K9QX4TB  Rate-limit the sign-in form\n    remarque de revue de la story 2-5 · responsable : sam · verrouille : 2-6, 2-7 · phase : Réalisation\nTraités : 2 · abandonnés : 1\nUn point dont tu es responsable, une fois traité, ou un point à abandonner : dis-le dans le chat de ton outil IA.\n",
    );
    expect(
      formatDeferred(t, {
        action: "resolve",
        item: item.id,
        title: item.title,
        outcome: "done",
        event: { id: item.event, at: item.recorded_at },
      }),
    ).toBe("D-7M2K9QX4TB marqué traité : « Rate-limit the sign-in form ».\n");
  });

  it("shows the closed items with when, by whom and why, and one item with its detail", () => {
    const done: DeferredItem = {
      ...item,
      title: "Red \u001b[31m",
      status: "done",
      closed: {
        outcome: "done",
        reason: "Added.",
        by: "sam",
        at: "2026-10-05T10:00:00.000Z",
        event: "E",
      },
    };
    const text = formatDeferred(t, {
      action: "list",
      story: null,
      open: [],
      closed: [done],
      done: 1,
      dropped: 0,
    });
    expect(text).toContain("Points reportés fermés : 1\nD-7M2K9QX4TB  Red  [31m\n");
    expect(text).toMatch(/ {4}traité le .+ par sam : Added\.\n/);
    expect(formatDeferred(t, { action: "show", item })).toContain("Statut : ouvert\nInscrit le ");
    expect(formatDeferred(t, { action: "show", item })).toContain(
      "Détail :\n    Five tries a minute.\n    Then a pause.\n",
    );
  });

  it("never lets an agent's title move the terminal in an error", () => {
    const message = errorMessage(t, {
      message_key: "error.story_locked.one",
      details: { story: "2-6", first: item.id, title: "x\u001b[2Jy" },
    });
    expect(message).not.toContain("\u001b");
    expect(message).toContain("« x [2Jy »");
  });
});

describe("deferred: the constitution", () => {
  it("tells every agent to record deferred work and never to start a locked story", () => {
    const constitution = renderConstitutionReference().replace(/\s+/g, " ");
    expect(constitution).toContain("Record with `plan.defer` anything you put off for later");
    expect(constitution).toContain("`plan.complete_deferred`");
    expect(constitution).toContain("`STORY_LOCKED`");
  });
});
