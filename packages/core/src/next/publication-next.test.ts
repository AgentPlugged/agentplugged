import { DOMAIN_IDS, PHASE_IDS } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type NextConfig,
  type NextDocs,
  type NextState,
  nextStep,
  type SyncFreshness,
} from "../index.js";

const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const SYNCED: SyncFreshness = { manifest: true, missing: [], recorded: "a", current: "a" };

const CONFIG: NextConfig = {
  domains: DOMAIN_IDS,
  phases: PHASE_IDS,
  tools: ["claude-code"],
  preferred: {},
  agents: { julien: "Julien", milo: "Milo", omar: "Omar" },
};
const DOCS: NextDocs = { kinds: [], stories: [] };

function state(checkpoints: Record<string, unknown>): NextState {
  return { projection: { checkpoints }, now: NOW, sync: SYNCED };
}

/** A publication checkpoint as the projection keeps it: only what `next` reads. */
function publication(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: "publication",
    risk: "medium",
    title: `Deliverable ${id}`,
    status: "open",
    story: null,
    blocks: [],
    opened_by: "julien",
    opened_event: `01JZ0000000000000000${id.slice(-6)}`,
    resolution: null,
    blocks_lifted: false,
    phase: null,
    supersedes: null,
    publication: { angle: "a", audience: "b", short_version: "c" },
    ...extra,
  };
}

const sentBack = (note: string | null = "Shorter, and no superlatives") => ({
  status: "resolved",
  resolution: {
    decision: "changes_requested",
    note,
    waiver_until: null,
    at: "2026-10-04T10:00:00.000Z",
    event: "E1",
  },
});

const refused = () => ({
  status: "resolved",
  resolution: {
    decision: "rejected",
    note: "No",
    waiver_until: null,
    at: "2026-10-04T10:00:00.000Z",
    event: "E1",
  },
});

const approved = () => ({
  status: "resolved",
  resolution: {
    decision: "approved",
    note: null,
    waiver_until: null,
    at: "2026-10-04T10:00:00.000Z",
    event: "E1",
  },
});

function step(checkpoints: Record<string, unknown>, config: NextConfig = CONFIG) {
  return nextStep(state(checkpoints), DOCS, config);
}

describe("next: a deliverable waits for the creator", () => {
  it("asks for the validation, with the review command", () => {
    const open = publication("G-AAAAAAAAA1");
    const result = step({ [open.id]: open });
    expect(result).toMatchObject({
      step: "validation",
      you: true,
      checkpoint: open.id,
      command: expect.stringContaining(`review ${open.id}`),
    });
    expect(result.waiting.map((entry) => entry.type)).toEqual(["publication"]);
  });
});

describe("next: a deliverable sent back", () => {
  it("hands the creator's instruction to the agent that produced it", () => {
    const back = publication("G-AAAAAAAAA2", sentBack());
    const result = step({ [back.id]: back });
    expect(result).toMatchObject({
      step: "changes_requested",
      you: false,
      agent: "julien",
      checkpoint: back.id,
      publication_feedback: {
        checkpoint: back.id,
        title: back.title,
        agent: "julien",
        note: "Shorter, and no superlatives",
        agent_inactive: false,
      },
    });
  });

  it("goes to Milo when Milo produced it", () => {
    const back = publication("G-AAAAAAAAA3", { ...sentBack(), opened_by: "milo" });
    expect(step({ [back.id]: back }).agent).toBe("milo");
  });

  it("follows the last one sent back, once, until a new point replaces it", () => {
    const first = publication("G-AAAAAAAAA4", sentBack("First note"));
    const second = publication("G-AAAAAAAAA5", {
      ...sentBack("Second note"),
      supersedes: first.id,
    });
    const result = step({ [first.id]: first, [second.id]: second });
    expect(result.checkpoint).toBe(second.id);
    expect(result.publication_feedback?.note).toBe("Second note");
    // The agent reopens a replacement: the creator validates it.
    const third = publication("G-AAAAAAAAA6", { supersedes: second.id });
    const waiting = step({ [first.id]: first, [second.id]: second, [third.id]: third });
    expect(waiting).toMatchObject({ step: "validation", checkpoint: third.id });
  });

  it("says when the agent is not active any more, and how to enable them", () => {
    const back = publication("G-AAAAAAAAA7", sentBack());
    const { julien: _julien, ...others } = CONFIG.agents;
    const result = step({ [back.id]: back }, { ...CONFIG, agents: others });
    expect(result).toMatchObject({
      step: "changes_requested",
      you: true,
      agent: null,
      command: expect.stringContaining("agent enable julien"),
      publication_feedback: { agent: "julien", agent_inactive: true },
    });
  });

  it("sends nothing back when the creator refused it, or approved it", () => {
    const no = publication("G-AAAAAAAAA8", refused());
    expect(step({ [no.id]: no }).step).not.toBe("changes_requested");
    const yes = publication("G-AAAAAAAAA9", approved());
    expect(step({ [yes.id]: yes }).step).not.toBe("changes_requested");
    expect(step({ [yes.id]: yes }).publication_feedback).toBeUndefined();
  });
});

describe("next: an old instruction", () => {
  it("is left behind once the phase it belongs to is closed", () => {
    const back = publication("G-AAAAAAAAB1", sentBack());
    // The instruction was given on 2026-10-04 10:00; a phase that began later no longer waits for it.
    const closed = {
      id: "G-PHASEEND01",
      type: "phase_end",
      phase: "framing",
      status: "resolved",
      risk: "medium",
      title: "End of framing",
      story: null,
      blocks: [],
      opened_by: "iris",
      opened_event: "01JZ0000000000000000PHASE1",
      resolution: {
        decision: "approved",
        note: null,
        waiver_until: null,
        at: "2026-10-04T11:00:00.000Z",
        event: "E9",
      },
      blocks_lifted: false,
      supersedes: null,
    };
    const result = step({ [back.id]: back, [closed.id]: closed });
    expect(result.publication_feedback).toBeUndefined();
  });
});
