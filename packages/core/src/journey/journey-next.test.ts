import { DOMAIN_IDS, type JourneyStep, PHASE_IDS, type PhaseId } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { settledPoints } from "../checkpoints/settled-rules.js";
import {
  type CheckpointState,
  decisionQueue,
  mergeGate,
  type NextConfig,
  type NextDocs,
  type NextState,
  nextStep,
  type SyncFreshness,
} from "../index.js";
import { skipKey } from "./journey-rules.js";
import { dueMergePoints, skippedMergeCheckpoint } from "./merge-point.js";

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const SYNCED: SyncFreshness = { manifest: true, missing: [], recorded: "a", current: "a" };
const AGENTS = {
  iris: "Iris",
  maya: "Maya",
  stella: "Stella",
  alex: "Alex",
  chloe: "Chloé",
  izzy: "Izzy",
  quentin: "Quentin",
  sam: "Sam",
  omar: "Omar",
  zoe: "Zoé",
  julien: "Julien",
};
const CONFIG: NextConfig = {
  domains: DOMAIN_IDS,
  phases: PHASE_IDS,
  tools: ["claude-code"],
  preferred: {},
  agents: AGENTS,
};
const BUILD: NextConfig = { ...CONFIG, phases: ["build"] };
const NO_DOCS: NextDocs = { kinds: [], stories: [] };
/** The epics are written: the stories alone decide in the build phase. */
const EPIC: NextDocs = { kinds: ["epic"], stories: [] };

/** The steps skipped, as the projection keeps them (`state.skips`). */
function skips(...entries: Array<readonly [JourneyStep, string?]>): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  entries.forEach(([step, story], index) => {
    record[skipKey(step, story)] = {
      step,
      story: story ?? null,
      reason: "my choice",
      by: "creator",
      source: "chat",
      at: `2026-10-06T09:0${index}:00.000Z`,
      event: `01JZ0000000000000000000${index}`,
      checkpoint: `G-000000000${index}`,
    };
  });
  return record;
}

function state(projection: Record<string, unknown> = {}): NextState {
  return { projection, now: NOW, sync: SYNCED };
}

function checkpoint(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: "story",
    risk: "low",
    title: `Title of ${id}`,
    summary: `Summary of ${id}`,
    status: "open",
    story: null,
    blocks: [],
    documents: [],
    options: null,
    recommendation: null,
    source: null,
    opened_by: "iris",
    opened_at: "2026-10-05T10:00:00.000Z",
    opened_event: `01JZ00000000000000000${id.slice(-5)}`,
    resolution: null,
    blocks_lifted: false,
    phase: null,
    ...extra,
  };
}

function phaseEnd(phase: PhaseId, id: string, extra: Record<string, unknown> = {}) {
  return checkpoint(id, { type: "phase_end", phase, ...extra });
}

const STARTED = {
  agent: "sam",
  branch: "feat/2-6-work",
  base: "c".repeat(40),
  base_ref: "main",
  worktree: "../shop.worktrees/2-6",
};
const HEAD = "a".repeat(40);

/** A started story the developer sent to review at 10:00. */
function reviewing(extra: Record<string, unknown> = {}) {
  return {
    status: "in_review",
    status_by: { agent: "sam", at: "2026-10-06T10:00:00.000Z" },
    started: STARTED,
    ...extra,
  };
}

const CI_PASS = {
  status: "pass",
  commit: HEAD,
  at: "2026-10-06T11:00:00.000Z",
  checks: 3,
  failed: [],
  event: "E1",
  by: "sam",
};

function mergePoint(story = "2-6", extra: Record<string, unknown> = {}) {
  return checkpoint("G-MERGE", { story, source: "merge", opened_by: "quentin", ...extra });
}

describe("a skipped document is never asked for", () => {
  it("asks for the brief, then goes on to the end of the phase once the creator skips it", () => {
    expect(nextStep(state(), NO_DOCS, CONFIG)).toMatchObject({ step: "framing", agent: "iris" });
    const step = nextStep(state({ skips: skips(["brief"]) }), NO_DOCS, CONFIG);
    expect(step).toMatchObject({ step: "phase_end", agent: "iris", phase: "framing" });
  });

  it("does not wait for a skipped document's point either", () => {
    const open = checkpoint("G-DOC01", {
      type: "document",
      story: null,
      documents: [{ path: ".agentplugged/docs/brief.md", blob_sha: "b".repeat(40) }],
    });
    const projection = { checkpoints: { [open.id]: open } };
    expect(nextStep(state(projection), NO_DOCS, CONFIG)).toMatchObject({
      step: "validation",
      you: true,
      checkpoint: "G-DOC01",
    });
    const skipped = nextStep(state({ ...projection, skips: skips(["brief"]) }), NO_DOCS, CONFIG);
    expect(skipped.step).toBe("phase_end");
    expect(skipped.waiting).toEqual([]);
    // The engine closes it, with the reason.
    expect(settledPoints({ ...projection, skips: skips(["brief"]) })).toEqual([
      { checkpoint: "G-DOC01", reason: "step_skipped" },
    ]);
    // Not while the document is asked for.
    expect(settledPoints(projection)).toEqual([]);
  });

  it("passes a skipped phase: its documents, its security review and its end are left out", () => {
    const framing = nextStep(state({ skips: skips(["phase_framing"]) }), NO_DOCS, CONFIG);
    expect(framing).toMatchObject({ step: "planning", phase: "planning", agent: "maya" });
    expect(framing.phases[0]).toEqual({ id: "framing", status: "skipped" });
  });

  it("closes the point of the end of a skipped phase, and shows it to nobody", () => {
    const end = phaseEnd("framing", "G-END01");
    const projection = { checkpoints: { [end.id]: end }, skips: skips(["phase_framing"]) };
    const step = nextStep(state(projection), NO_DOCS, CONFIG);
    expect(step.step).toBe("planning");
    expect(step.waiting).toEqual([]);
    expect(step.stray).toEqual([]);
    expect(settledPoints(projection)).toEqual([{ checkpoint: "G-END01", reason: "step_skipped" }]);
    expect(decisionQueue(projection, NOW)).toEqual([]);
    // The end of a phase that is not skipped keeps waiting.
    expect(decisionQueue({ checkpoints: { [end.id]: end } }, NOW).map((item) => item.id)).toEqual([
      "G-END01",
    ]);
  });

  it("goes to the end of the design without the architecture nor its security review", () => {
    const projection = {
      checkpoints: Object.fromEntries(
        PHASE_IDS.slice(0, 2).map((phase, index) => [
          `G-E${index}XXX`,
          phaseEnd(phase, `G-E${index}XXX`, {
            status: "resolved",
            opened_event: `01JZ000000000000000000E${index}`,
            resolution: {
              decision: "approved",
              waiver_until: null,
              at: `2026-10-05T0${index + 1}:00:00.000Z`,
              event: `E${index}`,
            },
          }),
        ]),
      ),
    };
    expect(nextStep(state(projection), NO_DOCS, CONFIG)).toMatchObject({
      step: "design",
      agent: "alex",
    });
    const skipped = nextStep(
      state({ ...projection, skips: skips(["architecture"]) }),
      NO_DOCS,
      CONFIG,
    );
    expect(skipped).toMatchObject({ step: "phase_end", agent: "alex", phase: "design" });
    const kinds: NextDocs = { kinds: ["architecture"], stories: [] };
    expect(nextStep(state(projection), kinds, CONFIG)).toMatchObject({
      step: "security_review",
      agent: "chloe",
    });
    expect(
      nextStep(state({ ...projection, skips: skips(["architecture_security"]) }), kinds, CONFIG),
    ).toMatchObject({ step: "phase_end", agent: "alex" });
  });
});

describe("the gate of a merge, with what the creator skipped", () => {
  const base = {
    stories: { "2-6": reviewing({ ci: CI_PASS }) },
    checkpoints: { "G-MERGE": mergePoint() },
  };

  it("is closed before the review, and says what holds it", () => {
    expect(mergeGate(base, "2-6")).toMatchObject({
      ready: false,
      review: false,
      ci: "pass",
      skipped: [],
    });
  });

  it("is open once the creator skipped the review, and lists it", () => {
    const gate = mergeGate({ ...base, skips: skips(["story_review", "2-6"]) }, "2-6");
    expect(gate).toMatchObject({ ready: true, review: true, untriaged: 0, skipped: ["review"] });
    // Another story keeps its review.
    expect(mergeGate({ ...base, skips: skips(["story_review", "2-7"]) }, "2-6").ready).toBe(false);
  });

  it("is open without a CI read once the creator skipped the CI, for every commit", () => {
    const noCi = {
      stories: { "2-6": reviewing() },
      checkpoints: { "G-MERGE": mergePoint() },
      skips: skips(["story_review"], ["story_ci"]),
    };
    expect(mergeGate(noCi, "2-6")).toMatchObject({
      ready: true,
      ci: "skipped",
      skipped: ["ci", "review"],
    });
    // A failing CI no longer holds it either: the creator said no CI.
    const failing = {
      ...noCi,
      stories: { "2-6": reviewing({ ci: { ...CI_PASS, status: "fail", failed: ["lint"] } }) },
    };
    expect(mergeGate(failing, "2-6").ready).toBe(true);
  });

  it("is open past an open deviation once the creator skipped the traceability", () => {
    const withDeviation = {
      ...base,
      skips: skips(["story_review"]),
      deviations: {
        "V-0000000001": {
          id: "V-0000000001",
          story: "2-6",
          requirements: ["EF-1"],
          summary: "drifts",
          detail: null,
          pr: null,
          commit: null,
          status: "open",
          reported_by: "quentin",
          reported_at: "2026-10-06T10:30:00.000Z",
          event: "01JZ0000000000000000000001",
          resolved: null,
        },
      },
    };
    expect(mergeGate(withDeviation, "2-6")).toMatchObject({ ready: false, deviations: 1 });
    expect(
      mergeGate(
        { ...withDeviation, skips: skips(["story_review"], ["story_trace", "2-6"]) },
        "2-6",
      ),
    ).toMatchObject({ ready: true, deviations: 0, skipped: ["review", "trace"] });
  });
});

describe("a story whose review the creator skipped", () => {
  const projection = {
    stories: { "2-6": reviewing({ ci: CI_PASS }) },
    checkpoints: { "G-MERGE": mergePoint() },
  };

  it("is reviewed by the independent reviewer, as usual, while nothing is skipped", () => {
    expect(nextStep(state(projection), EPIC, BUILD)).toMatchObject({
      step: "review",
      agent: "quentin",
      story: "2-6",
    });
  });

  it("goes straight to its merge point for the creator, no review proposed", () => {
    const step = nextStep(
      state({ ...projection, skips: skips(["story_review", "2-6"]) }),
      EPIC,
      BUILD,
    );
    expect(step).toMatchObject({ step: "validation", you: true, story: "2-6" });
    expect(step.checkpoint).toBe("G-MERGE");
  });

  it("is not sent back to its CI once the creator skipped the CI", () => {
    const noCi = { stories: { "2-6": reviewing() }, checkpoints: { "G-MERGE": mergePoint() } };
    expect(nextStep(state(noCi), EPIC, BUILD)).toMatchObject({ step: "ci_check", story: "2-6" });
    const skipped = nextStep(
      state({ ...noCi, skips: skips(["story_ci", "2-6"], ["story_review", "2-6"]) }),
      EPIC,
      BUILD,
    );
    expect(skipped).toMatchObject({ step: "validation", story: "2-6" });
  });

  it("does not send a developer to fix a CI the creator skipped", () => {
    const failing = {
      stories: {
        "2-6": {
          status: "in_progress",
          status_by: { agent: "sam", at: "2026-10-06T10:00:00.000Z" },
          started: STARTED,
          ci: { ...CI_PASS, status: "fail", failed: ["lint"] },
        },
      },
    };
    expect(nextStep(state(failing), EPIC, BUILD)).toMatchObject({ step: "ci_failed" });
    expect(nextStep(state({ ...failing, skips: skips(["story_ci"]) }), EPIC, BUILD)).toMatchObject({
      step: "build",
      story: "2-6",
    });
  });

  it("is given its merge point by the engine, once, since it went to review", () => {
    const noPoint = { stories: { "2-6": reviewing({ ci: CI_PASS }) }, checkpoints: {} };
    expect(dueMergePoints(noPoint)).toEqual([]);
    const skipped = { ...noPoint, skips: skips(["story_review", "2-6"], ["story_ci"]) };
    expect(dueMergePoints(skipped)).toEqual([{ story: "2-6", skipped: ["review", "ci"] }]);
    // Never again once a merge point was opened since: even one the creator refused.
    const refused = mergePoint("2-6", {
      status: "resolved",
      opened_at: "2026-10-06T10:30:00.000Z",
      resolution: { decision: "rejected", waiver_until: null, at: "2026-10-06T10:40:00.000Z" },
    });
    expect(dueMergePoints({ ...skipped, checkpoints: { [refused.id]: refused } })).toEqual([]);
    // A merge point opened before the story went to review again does not count.
    const old = mergePoint("2-6", { status: "resolved", opened_at: "2026-10-06T08:00:00.000Z" });
    expect(dueMergePoints({ ...skipped, checkpoints: { [old.id]: old } })).toHaveLength(1);
    // Not for a story that is not in review, nor merged.
    expect(
      dueMergePoints({
        ...skipped,
        stories: { "2-6": { ...reviewing({ ci: CI_PASS }), status: "in_progress" } },
      }),
    ).toEqual([]);
    expect(
      dueMergePoints({
        ...skipped,
        stories: { "2-6": reviewing({ merged: { at: "2026-10-06T12:00:00.000Z" } }) },
      }),
    ).toEqual([]);
  });

  it("opens a merge checkpoint that says what the creator skipped", () => {
    const payload = skippedMergeCheckpoint({ story: "2-6", skipped: ["review", "ci"] });
    expect(payload).toMatchObject({ type: "story", risk: "medium", source: "merge" });
    expect(payload.title).toBe("Merge story 2-6");
    expect(payload.summary).toContain("its independent review and its CI");
  });
});

describe("the sprint and the breakdown the creator skipped", () => {
  const docs: NextDocs = {
    kinds: ["epic"],
    stories: ["2-1", "2-2"],
    plannable: ["2-1", "2-2"],
  };

  it("proposes the sprint planning to Izzy, then the stories as they come once it is skipped", () => {
    expect(nextStep(state(), docs, BUILD)).toMatchObject({
      step: "sprint_planning",
      agent: "izzy",
    });
    expect(nextStep(state({ skips: skips(["sprint_planning"]) }), docs, BUILD)).toMatchObject({
      step: "build",
      story: "2-1",
      agent: "sam",
    });
  });

  it("never proposes the epics once the creator skipped the breakdown", () => {
    expect(nextStep(state(), NO_DOCS, BUILD)).toMatchObject({ step: "breakdown", agent: "izzy" });
    expect(nextStep(state({ skips: skips(["breakdown"]) }), NO_DOCS, BUILD).step).toBe("none");
  });

  it("does not propose the retrospective of a finished epic once skipped", () => {
    const finished = {
      stories: { "2-1": { status: "done", status_by: null } },
      checkpoints: {},
    };
    const done: NextDocs = { kinds: ["epic"], stories: ["2-1"] };
    // Whatever the retrospective is due or not, the skip leaves it out.
    const step = nextStep(state({ ...finished, skips: skips(["retrospective"]) }), done, BUILD);
    expect(step.step).not.toBe("retrospective");
  });

  it("never proposes the CI's base workflows once skipped", () => {
    const noCi: NextDocs = { ...EPIC, ci: false };
    expect(nextStep(state(), noCi, BUILD)).toMatchObject({ step: "setup_ci", agent: "omar" });
    expect(nextStep(state({ skips: skips(["ci_setup"]) }), noCi, BUILD).step).not.toBe("setup_ci");
  });

  it("does not hold a story back for the deferred work that locks it once skipped", () => {
    const locked = {
      deferred: {
        "D-0000000001": {
          id: "D-0000000001",
          title: "Do it later",
          status: "open",
          locks: ["2-6"],
          owner: "sam",
          recorded_by: "sam",
          event: "01JZ0000000000000000000001",
        },
      },
      stories: { "2-6": reviewing({ ci: CI_PASS }) },
    };
    const step = nextStep(state(locked), EPIC, BUILD);
    expect(step.step).toBe("deferred_work");
    const skipped = nextStep(
      state({ ...locked, skips: skips(["story_deferred", "2-6"]) }),
      EPIC,
      BUILD,
    );
    expect(skipped.step).not.toBe("deferred_work");
  });
});

describe("the points of a skipped step in the decisions of the creator", () => {
  it("leaves out the review of a document, and the proposal of a sprint, of skipped steps", () => {
    const sprint = checkpoint("G-SPRNT", { type: "document", story: null });
    const projection = {
      checkpoints: { [sprint.id]: sprint },
      sprints: { "S-000000001": { checkpoint: "G-SPRNT", stories: [] } },
    };
    const open = (state_: Record<string, unknown>) =>
      decisionQueue(state_, NOW).map((item) => item.id);
    expect(open(projection)).toEqual(["G-SPRNT"]);
    expect(open({ ...projection, skips: skips(["sprint_planning"]) })).toEqual([]);
  });

  it("takes a retrospective's proposal for the creator's no more once skipped", () => {
    const retro = checkpoint("G-RETRO", {
      type: "memory",
      memory: { kind: "retrospective", scope: { kind: "epic", id: "2" } },
    }) as unknown as CheckpointState;
    const projection = { checkpoints: { [retro.id]: retro } };
    expect(decisionQueue(projection, NOW).map((item) => item.id)).toEqual(["G-RETRO"]);
    expect(decisionQueue({ ...projection, skips: skips(["retrospective"]) }, NOW)).toEqual([]);
  });
});
