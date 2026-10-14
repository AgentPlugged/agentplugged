import { DOMAIN_IDS } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type CheckpointState,
  creatorLastAnswer,
  decisionQueue,
  type NextConfig,
  type NextDocs,
  type NextState,
  nextStep,
  type SyncFreshness,
} from "../index.js";
import { answer, checkpointState } from "../testing/checkpoint-state.js";
import { morningSummary } from "./morning.js";
import { pileOf } from "./next.js";

/**
 * The creator chooses the points that wait for them. `next` gives the point they did
 * not keep to the agent responsible, goes on with the independent work while the points they kept
 * wait, and says where it stops; the queue, the pile and the morning summary follow.
 */

const NOW = Date.UTC(2026, 9, 5, 7, 0, 0);
const SYNCED: SyncFreshness = { manifest: true, missing: [], recorded: "a", current: "a" };

const AGENTS = {
  maya: "Maya",
  alex: "Alex",
  chloe: "Chloé",
  quentin: "Quentin",
  sam: "Sam",
  ethan: "Ethan",
  omar: "Omar",
  noah: "Noah",
};

/** Only the build phase is active: the stories decide. */
const BUILD: NextConfig = {
  domains: DOMAIN_IDS,
  phases: ["build"],
  tools: ["claude-code"],
  preferred: {},
  agents: AGENTS,
};

/** The creator keeps the framing and the releases: everything else is for the agents. */
const KEEPS = { fixed: ["framing", "release"], strict: false } as const;

const DOCS: NextDocs = { kinds: ["epic"], stories: [] };

function state(
  checkpoints: readonly CheckpointState[],
  stories: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): NextState {
  return {
    projection: {
      checkpoints: Object.fromEntries(checkpoints.map((entry) => [entry.id, entry])),
      stories,
      ...extra,
    },
    now: NOW,
    sync: SYNCED,
  };
}

const working = (agent: string) => ({
  status: "in_progress",
  status_by: { agent, at: "2026-10-04T10:00:00.000Z" },
});

/** A release the creator keeps, blocking the story 2-1. */
const release = checkpointState("G-RELEASE1", {
  type: "release",
  risk: "high",
  title: "Release 1.0",
  summary: "Put the product online.",
  story: "2-1",
  blocks: [{ action: "release.deploy", story: "2-1" }],
  opened_by: "omar",
});

/** An architecture document the creator did not keep: Alex wrote it. */
const architecture = checkpointState("G-ARCHIT1", {
  type: "document",
  title: "Architecture",
  opened_by: "alex",
});

describe("next: a point the creator did not keep", () => {
  it("gives it to the agent responsible, never its author nor Noah", () => {
    const step = nextStep(state([architecture]), DOCS, { ...BUILD, delegation: KEEPS });
    expect(step).toMatchObject({
      step: "point_decision",
      you: false,
      agent: "chloe",
      checkpoint: "G-ARCHIT1",
      point: { kind: "architecture", opened_by: "alex" },
    });
  });

  it("comes before everything else, even a point the creator keeps", () => {
    const step = nextStep(state([release, architecture]), DOCS, { ...BUILD, delegation: KEEPS });
    expect(step.step).toBe("point_decision");
  });

  it("leaves every point to the creator until they chose", () => {
    const step = nextStep(state([architecture]), DOCS, BUILD);
    expect(step.step).not.toBe("point_decision");
  });

  it("does not ask the agents about a point the creator reopened, nor one an agent handed back", () => {
    const reopened = checkpointState("G-ARCHIT1", {
      type: "document",
      opened_by: "alex",
      reopened_at: "2026-10-05T06:00:00.000Z",
    });
    const handedBack = checkpointState("G-ARCHIT2", {
      type: "document",
      opened_by: "alex",
      escalated: {
        by: "chloe",
        reason: "Beyond my remit.",
        at: "2026-10-05T06:00:00.000Z",
        event: "E",
      },
    });
    for (const checkpoint of [reopened, handedBack]) {
      const step = nextStep(state([checkpoint]), DOCS, { ...BUILD, delegation: KEEPS });
      expect(step.step, checkpoint.id).not.toBe("point_decision");
    }
  });

  it("goes to the creator when no agent but Noah can decide it", () => {
    const step = nextStep(state([architecture]), DOCS, {
      ...BUILD,
      agents: { noah: "Noah" },
      delegation: KEEPS,
    });
    expect(step.step).not.toBe("point_decision");
  });
});

describe("next: the points the creator kept do not stop the agents", () => {
  const stories = { "2-1": working("sam"), "2-2": working("ethan") };

  it("stops at the point when the creator has not chosen, as before", () => {
    const step = nextStep(state([release], stories), DOCS, BUILD);
    expect(step).toMatchObject({ step: "validation", you: true, checkpoint: "G-RELEASE1" });
    expect(step.independent).toBeUndefined();
    expect(step.stop).toBeUndefined();
  });

  it("goes on with the work that does not depend on it, the point staying in waiting", () => {
    const step = nextStep(state([release], stories), DOCS, { ...BUILD, delegation: KEEPS });
    expect(step).toMatchObject({
      step: "build",
      you: false,
      agent: "ethan",
      story: "2-2",
      independent: true,
    });
    expect(step.waiting.map((entry) => entry.id)).toEqual(["G-RELEASE1"]);
  });

  it("stops, and says so, when nothing independent is left", () => {
    const step = nextStep(state([release], { "2-1": working("sam") }), DOCS, {
      ...BUILD,
      delegation: KEEPS,
    });
    expect(step).toMatchObject({ step: "validation", you: true, stop: true });
    expect(step.independent).toBeUndefined();
  });

  it("stops when only a point that blocks nothing waits and no work is left", () => {
    const lone = checkpointState("G-RELEASE2", { type: "release", opened_by: "omar" });
    const step = nextStep(state([lone]), DOCS, {
      ...BUILD,
      agents: { sam: "Sam" },
      delegation: KEEPS,
    });
    expect(step).toMatchObject({ step: "none", stop: true });
    expect(step.waiting.map((entry) => entry.id)).toEqual(["G-RELEASE2"]);
  });

  it("never calls the work after a phase's end independent", () => {
    const end = checkpointState("G-ENDFRAME", {
      type: "phase_end",
      phase: "framing",
      title: "End of framing",
      opened_by: "iris",
    });
    const config: NextConfig = {
      ...BUILD,
      phases: ["framing", "planning"],
      agents: { ...AGENTS, iris: "Iris", stella: "Stella" },
      delegation: KEEPS,
    };
    const step = nextStep(state([end]), { kinds: ["brief"], stories: [] }, config);
    expect(step).toMatchObject({ step: "phase_review", you: true, stop: true });
  });
});

describe("the queue, the stack and the morning", () => {
  const decision = checkpointState("G-DECISN1", {
    type: "decision",
    title: "Which database?",
    options: [
      { id: "a", label: "Postgres", consequence: "Solid." },
      { id: "b", label: "SQLite", consequence: "Simple." },
    ],
    recommendation: "a",
    opened_by: "alex",
  });

  it("shows the creator only the points they kept, with what approving does", () => {
    const projection = state([release, architecture, decision]).projection;
    const queue = decisionQueue(projection, NOW, "chat", KEEPS);
    expect(queue.map((item) => item.id)).toEqual(["G-RELEASE1"]);
    expect(queue[0]).toMatchObject({
      kind: "release",
      action: "release",
      story: "2-1",
      line: "Put the product online.",
    });
    // Without a choice, everything waits for them.
    expect(
      decisionQueue(projection, NOW, "chat")
        .map((item) => item.id)
        .sort(),
    ).toEqual(["G-ARCHIT1", "G-DECISN1", "G-RELEASE1"]);
  });

  it("puts a release in the stack outside strict, and keeps a high risk for the terminal at strict", () => {
    const projection = state([release, decision]).projection;
    const chat = decisionQueue(projection, NOW, "chat");
    expect(pileOf(projection, NOW, "chat", chat)).toEqual({
      stack: ["G-RELEASE1", "G-DECISN1"],
      apart: [],
      more: 0,
    });
    const strict = decisionQueue(projection, NOW, "strict");
    expect(pileOf(projection, NOW, "strict", strict)).toEqual({
      stack: ["G-DECISN1"],
      apart: ["G-RELEASE1"],
      more: 0,
    });
  });

  it("keeps what asks for the creator's own gesture apart from the stack", () => {
    const action = checkpointState("G-ACTION01", {
      type: "creator_action",
      risk: "medium",
      creator_action: { kind: "agent_enable", id: "sam", reason: "x" },
    });
    const projection = state([action, decision]).projection;
    const queue = decisionQueue(projection, NOW, "chat");
    const pile = pileOf(projection, NOW, "chat", queue);
    expect(pile.apart).toEqual(["G-ACTION01"]);
    expect(pile.stack).toEqual(["G-DECISN1"]);
  });

  it("sums up the night since the creator's last answer: done, decided, closed, handed back, waiting", () => {
    const decided = checkpointState("G-DECIDED1", {
      type: "document",
      title: "Stories of epic 2",
      opened_by: "izzy",
      status: "resolved",
      resolution: answer("approved", "2026-10-05T02:00:00.000Z", {
        source: "agent",
        assurance: "agent",
        by: "machine:AAAAAAAAAAAAAAAA",
        relayed_by: "maya",
        note: "Every story has its criteria.",
      }),
    });
    const before = checkpointState("G-BEFORE01", {
      type: "document",
      title: "Decided before the creator's last answer",
      status: "resolved",
      resolution: answer("approved", "2026-10-04T10:00:00.000Z", {
        source: "agent",
        assurance: "agent",
        relayed_by: "maya",
        note: "Old.",
      }),
    });
    const closed = checkpointState("G-CLOSED01", {
      type: "story",
      title: "Merge 1-9",
      status: "closed",
      closed: { reason: "story_merged", ref: null, at: "2026-10-05T03:00:00.000Z", event: "E" },
    });
    const handedBack = checkpointState("G-HANDED01", {
      type: "decision",
      title: "Forge refuses",
      escalated: {
        by: "quentin",
        reason: "The forge refuses the merge.",
        at: "2026-10-05T04:00:00.000Z",
        event: "E",
      },
    });
    const validations = [
      {
        checkpoint: "G-BEFORE01",
        decision: "approved",
        option: null,
        author: "machine:AAAAAAAAAAAAAAAA",
        at: "2026-10-04T18:00:00.000Z",
        source: "chat",
        assurance: "chat",
        event: "E1",
        quote: "ok",
        relayed_by: "main",
      },
      {
        checkpoint: "G-DECIDED1",
        decision: "approved",
        option: null,
        author: "machine:AAAAAAAAAAAAAAAA",
        at: "2026-10-05T02:00:00.000Z",
        source: "agent",
        assurance: "agent",
        event: "E2",
        quote: null,
        relayed_by: "maya",
      },
    ];
    const stories = {
      "2-1": {
        status: "done",
        merged: { source: "agent", at: "2026-10-05T01:00:00.000Z" },
      },
      "1-1": {
        status: "done",
        merged: { source: "chat", at: "2026-10-04T12:00:00.000Z" },
      },
    };
    const projection = state([decided, before, closed, handedBack, release], stories, {
      validations,
    }).projection;
    expect(creatorLastAnswer(projection)).toBe("2026-10-04T18:00:00.000Z");
    const queue = decisionQueue(projection, NOW, "chat", KEEPS);
    const morning = morningSummary(projection, queue);
    expect(morning.since).toBe("2026-10-04T18:00:00.000Z");
    expect(morning.done).toEqual([{ story: "2-1", at: "2026-10-05T01:00:00.000Z", by: "agent" }]);
    expect(morning.decided).toEqual([
      {
        checkpoint: "G-DECIDED1",
        title: "Stories of epic 2",
        kind: "breakdown",
        by: "maya",
        decision: "approved",
        option: null,
        reason: "Every story has its criteria.",
        at: "2026-10-05T02:00:00.000Z",
      },
    ]);
    expect(morning.closed).toEqual([
      {
        checkpoint: "G-CLOSED01",
        title: "Merge 1-9",
        reason: "story_merged",
        at: "2026-10-05T03:00:00.000Z",
      },
    ]);
    expect(morning.escalated).toMatchObject([
      { checkpoint: "G-HANDED01", by: "quentin", reason: "The forge refuses the merge." },
    ]);
    // The point an agent handed back waits for the creator now, after the release (high risk first).
    expect(morning.waiting).toEqual(["G-RELEASE1", "G-HANDED01"]);
    expect([morning.done_total, morning.decided_total, morning.closed_total]).toEqual([1, 1, 1]);
  });

  it("starts at the beginning when the creator never answered", () => {
    expect(creatorLastAnswer({})).toBeNull();
    expect(morningSummary({}, [])).toMatchObject({
      since: null,
      done: [],
      decided: [],
      waiting: [],
    });
  });
});
