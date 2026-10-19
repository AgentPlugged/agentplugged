import { describe, expect, it } from "vitest";
import {
  BRIEFING_ITEMS_MAX,
  BRIEFING_RECENT_MS,
  BRIEFING_TITLE_MAX_CHARS,
  BriefingDataSchema,
  composeBriefing,
} from "./briefing-read.js";
import { FilesRequestSchema, FilesResponseReader, FilesResponseSchema } from "./repo-files.js";

const ID = "01J9ZQ4V8E3M5N7P9R1S3T5V7X";
const PRODUCT = "01J9ZQ4V8E3M5N7P9R1S3T5V80";
const NOW = Date.parse("2026-10-19T08:00:00Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function point(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    status: "open",
    type: "decision",
    risk: "low",
    title: `Point ${id}`,
    opened_by: "maya",
    opened_at: iso(-3_600_000),
    ...extra,
  };
}

const stateOf = (
  points: Array<Record<string, unknown>>,
  stories: Record<string, unknown> = {},
) => ({
  checkpoints: Object.fromEntries(points.map((entry) => [String(entry.id), entry])),
  stories,
});

describe("the briefing request", () => {
  it("accepts the operation alone and nothing else on it", () => {
    const base = { v: 1, id: ID, product: PRODUCT, op: "briefing" };
    expect(FilesRequestSchema.safeParse(base).success).toBe(true);
    expect(FilesRequestSchema.safeParse({ ...base, scope: "all" }).success).toBe(false);
  });
});

describe("the briefing composed from a state", () => {
  it("lists the points that wait, the most pressing first, then by risk and age", () => {
    const data = composeBriefing(
      stateOf([
        point("G-LOW0000001", { risk: "low", opened_at: iso(-1000) }),
        point("G-HIGH000001", { risk: "high", opened_at: iso(-500) }),
        point("G-MED0000001", { risk: "medium", opened_at: iso(-9000) }),
        point("G-LOW0000002", { risk: "low", opened_at: iso(-9000) }),
        point("G-BLOCK00001", { risk: "low", blocks: [{ action: "release.deploy" }] }),
      ]),
      NOW,
    );
    expect(data.items.map((item) => item.id)).toEqual([
      "G-HIGH000001",
      "G-BLOCK00001",
      "G-MED0000001",
      "G-LOW0000002",
      "G-LOW0000001",
    ]);
    expect(data.waiting).toBe(5);
    expect(data.items[0]).toMatchObject({ urgent: true, risk: "high", answering: "full" });
  });

  it("leaves out the points that are not open and the answers held for their undo window", () => {
    const data = composeBriefing(
      stateOf([
        point("G-OPEN000001"),
        point("G-DONE000001", { status: "resolved", resolution: { at: iso(-1000) } }),
        point("G-HELD000001", {
          pending_answer: { decision: "approved", device: "phone:x", until: iso(5000) },
        }),
        // Held long ago and never carried out: the point is offered again.
        point("G-STALE00001", {
          pending_answer: { decision: "approved", device: "phone:x", until: iso(-60_000) },
        }),
      ]),
      NOW,
    );
    expect(data.items.map((item) => item.id).sort()).toEqual(["G-OPEN000001", "G-STALE00001"]);
    expect(data.progress.decided).toBe(1);
  });

  it("says what moved in the last 24 hours", () => {
    const data = composeBriefing(
      stateOf(
        [
          point("G-DONE000001", { status: "resolved", resolution: { at: iso(-1000) } }),
          point("G-DONE000002", {
            status: "resolved",
            resolution: { at: iso(-BRIEFING_RECENT_MS - 1000) },
          }),
        ],
        {
          "2-1": { merged: { at: iso(-2000) } },
          "2-2": { merged: { at: iso(-BRIEFING_RECENT_MS - 5000) } },
          "2-3": { started: {} },
        },
      ),
      NOW,
    );
    expect(data.progress).toEqual({ merged: 1, decided: 1 });
  });

  it("carries the options, the merge and what the phone can answer", () => {
    const data = composeBriefing(
      stateOf(
        [
          point("G-OPT0000001", {
            options: [
              { id: "a", label: "Aube", consequence: "Plus doux." },
              { id: "b", label: "Boréal", consequence: "Plus net." },
            ],
            recommendation: "a",
          }),
          point("G-MERGE00001", {
            type: "story",
            source: "merge",
            story: "2-3",
            irreversible: false,
          }),
          point("G-ACTION0001", { type: "creator_action", creator_action: { do: "x" } }),
          point("G-MEMORY0001", { type: "memory" }),
        ],
        { "2-3": { started: { base_ref: "origin/main" } } },
      ),
      NOW,
    );
    const byId = Object.fromEntries(data.items.map((item) => [item.id, item]));
    expect(byId["G-OPT0000001"]?.options).toEqual([
      { id: "a", label: "Aube", recommended: true },
      { id: "b", label: "Boréal", recommended: false },
    ]);
    expect(byId["G-MERGE00001"]?.merge).toEqual({ story: "2-3", base: "main" });
    expect(byId["G-ACTION0001"]?.answering).toBe("no_approval");
    expect(byId["G-MEMORY0001"]?.answering).toBe("elsewhere");
  });

  it("bounds the list and the texts, and the result fits its schema", () => {
    const many = Array.from({ length: BRIEFING_ITEMS_MAX + 5 }, (_, at) =>
      point(`G-MANY${String(at).padStart(6, "0")}`, { title: "T".repeat(500) }),
    );
    const data = composeBriefing(stateOf(many), NOW);
    expect(data.items).toHaveLength(BRIEFING_ITEMS_MAX);
    expect(data.waiting).toBe(BRIEFING_ITEMS_MAX + 5);
    expect([...(data.items[0]?.title ?? "")].length).toBeLessThanOrEqual(BRIEFING_TITLE_MAX_CHARS);
    expect(BriefingDataSchema.safeParse(data).success).toBe(true);
  });

  it("is empty and valid when nothing waits, and ignores a state that is not one", () => {
    expect(composeBriefing({}, NOW)).toEqual({
      op: "briefing",
      composed_at: NOW,
      progress: { merged: 0, decided: 0 },
      waiting: 0,
      items: [],
    });
    expect(composeBriefing({ checkpoints: [1, null, "x"] }, NOW).items).toEqual([]);
  });
});

describe("the briefing answer", () => {
  it("travels in the answer of the file reading and is read by the tolerant reader", () => {
    const data = composeBriefing(stateOf([point("G-OPEN000001")]), NOW);
    const response = {
      v: 1,
      id: ID,
      product: PRODUCT,
      ok: true,
      at: "worktree",
      read_at: NOW,
      data,
    };
    expect(FilesResponseSchema.safeParse(response).success).toBe(true);
    const future = {
      ...response,
      data: { ...data, items: [{ ...data.items[0], future_field: 1 }] },
    };
    expect(FilesResponseSchema.safeParse(future).success).toBe(false);
    expect(FilesResponseReader.safeParse(future).success).toBe(true);
  });
});

describe("the fields the listening version is made from", () => {
  it("takes what the agent wrote on the card, the first risk only, and no summary when a card exists", () => {
    const data = composeBriefing(
      stateOf([
        point("G-CARD000001", {
          summary: "Un long résumé qui ne doit pas partir.",
          card: {
            effect: "Les clients voient le nouveau tarif.",
            risks: ["Un tarif mal arrondi.", "Un second risque."],
            why: { reason: "Le tarif était périmé.", rejected: "Attendre la fin du mois." },
          },
        }),
      ]),
      NOW,
    );
    expect(data.items[0]?.listen).toEqual({
      effect: "Les clients voient le nouveau tarif.",
      risk: "Un tarif mal arrondi.",
      reason: "Le tarif était périmé.",
      rejected: "Attendre la fin du mois.",
    });
  });

  it("falls back on the start of the summary when no card was written, bounded", () => {
    const data = composeBriefing(
      stateOf([point("G-NOCARD0001", { summary: `Début. ${"x".repeat(2000)}` })]),
      NOW,
    );
    const summary = data.items[0]?.listen?.summary ?? "";
    expect(summary.startsWith("Début.")).toBe(true);
    // Cut on a whole word, never inside one.
    const spaced = composeBriefing(
      stateOf([point("G-NOCARD0002", { summary: "mot ".repeat(400) })]),
      NOW,
    ).items[0]?.listen?.summary;
    expect(spaced?.endsWith("mot")).toBe(true);
    expect([...summary].length).toBeLessThanOrEqual(600);
    expect(data.items[0]?.listen?.effect).toBeUndefined();
  });

  it("carries a deliverable's short version, and only for a publication", () => {
    const data = composeBriefing(
      stateOf([
        point("G-PUB00000001", {
          type: "publication",
          publication: { angle: "a", audience: "b", short_version: "Le texte court du livrable." },
        }),
        point("G-DOC00000001", {
          type: "document",
          publication: { angle: "a", audience: "b", short_version: "Ne doit pas partir." },
        }),
      ]),
      NOW,
    );
    const byId = Object.fromEntries(data.items.map((item) => [item.id, item]));
    expect(byId["G-PUB00000001"]?.listen).toEqual({ short: "Le texte court du livrable." });
    expect(byId["G-DOC00000001"]?.listen).toBeUndefined();
  });

  it("has nothing for a point with no text, and the answer still fits the schema", () => {
    const data = composeBriefing(stateOf([point("G-EMPTY000001")]), NOW);
    expect(data.items[0]?.listen).toBeUndefined();
    expect(BriefingDataSchema.safeParse(data).success).toBe(true);
    const full = composeBriefing(
      stateOf([
        point("G-FULL00000001", {
          card: {
            effect: "e".repeat(300),
            risks: ["r".repeat(200)],
            why: { reason: "w".repeat(200), rejected: "j".repeat(200) },
          },
        }),
      ]),
      NOW,
    );
    expect(BriefingDataSchema.safeParse(full).success).toBe(true);
  });

  it("is refused when it holds a field the schema does not know", () => {
    const data = composeBriefing(stateOf([point("G-OPEN000001", { summary: "Un résumé." })]), NOW);
    const bad = { ...data, items: [{ ...data.items[0], listen: { effect: "x", extra: 1 } }] };
    expect(BriefingDataSchema.safeParse(bad).success).toBe(false);
  });
});
