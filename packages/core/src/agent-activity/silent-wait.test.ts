import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { silentWaitProblem } from "./silent-wait.js";

const NOW = Date.parse("2026-10-22T10:00:00Z");

/** A story Sam builds whose closed review pass left `findings` unsorted. */
function reviewed(untriaged: number, extra: Record<string, unknown> = {}) {
  const findings = Array.from({ length: untriaged }, (_, index) => ({
    id: `F-${index + 1}`,
    severity: "should_fix",
    title: `Finding ${index + 1}`,
    triage: null,
  }));
  return {
    stories: {
      "1-1": {
        status: "in_review",
        started: { agent: "sam" },
        review: { passes: [{ number: 1, complete: true, reviews: { qa: { findings } } }] },
        results: {},
        waiting_on: [],
      },
    },
    ...extra,
  };
}

function point(over: Record<string, unknown> = {}) {
  return {
    id: "C-1",
    story: "1-1",
    opened_by: "sam",
    status: "open",
    waiver_until: null,
    ...over,
  };
}

const partial = (over: Record<string, unknown> = {}) => ({
  agent: "sam",
  story: "1-1",
  status: "partial" as const,
  open_questions: [] as string[],
  ...over,
});

describe("a partial result never waits for the creator in silence", () => {
  it("refuses the developer's partial result while findings are unsorted and no point is open", () => {
    const refused = silentWaitProblem(partial(), reviewed(3), NOW);
    expect(refused?.code).toBe(ErrorCode.DECISION_NOT_OPEN);
    expect(refused?.message_key).toBe("error.decision_not_open.untriaged");
    expect(refused?.details).toEqual({ story: "1-1", reason: "untriaged", untriaged: 3 });
  });

  it("accepts it once a point of the story is open for the creator", () => {
    const state = reviewed(3, { checkpoints: { "C-1": point() } });
    expect(silentWaitProblem(partial(), state, NOW)).toBeUndefined();
    // An answered point is no longer open: the wait would be silent again.
    const answered = reviewed(3, { checkpoints: { "C-1": point({ status: "resolved" }) } });
    expect(silentWaitProblem(partial(), answered, NOW)?.details.reason).toBe("untriaged");
  });

  it("refuses open questions without a point, with or without a story", () => {
    const asked = partial({ open_questions: ["Which pricing?"] });
    expect(silentWaitProblem(asked, reviewed(0), NOW)?.details).toEqual({
      story: "1-1",
      reason: "waiting",
      untriaged: 0,
    });
    const free = { ...asked, story: undefined };
    expect(silentWaitProblem(free, {}, NOW)?.message_key).toBe("error.decision_not_open.waiting");
    // Without a story, a point this agent opened is the one the creator sees.
    const mine = { checkpoints: { "C-1": point({ story: null }) } };
    expect(silentWaitProblem(free, mine, NOW)).toBeUndefined();
    const another = { checkpoints: { "C-1": point({ story: null, opened_by: "iris" }) } };
    expect(silentWaitProblem(free, another, NOW)?.details.reason).toBe("waiting");
  });

  it("leaves alone what waits for nobody: no question, nothing unsorted, another status", () => {
    expect(silentWaitProblem(partial(), reviewed(0), NOW)).toBeUndefined();
    // The findings are the developer's to sort, not another agent's.
    expect(silentWaitProblem(partial({ agent: "quentin" }), reviewed(2), NOW)).toBeUndefined();
    // A blocked result opens its own point; a complete one waits for no one.
    for (const status of ["blocked", "complete"] as const) {
      expect(silentWaitProblem(partial({ status }), reviewed(2), NOW)).toBeUndefined();
    }
  });

  it("ignores unsorted findings once the creator skipped the story's review", () => {
    const skipped = reviewed(2, {
      skips: { "story_review@1-1": { step: "story_review", story: "1-1" } },
    });
    expect(silentWaitProblem(partial(), skipped, NOW)).toBeUndefined();
  });
});
