import { DOMAIN_IDS } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type CheckpointState,
  NEXT_STEPS,
  type NextConfig,
  type NextDocs,
  type NextState,
  nextStep,
  type SyncFreshness,
} from "../index.js";
import { answered, checkpointState } from "../testing/checkpoint-state.js";

/** At the start of the launch, `next` gives Julien the positioning first. */

const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const SYNCED: SyncFreshness = { manifest: true, missing: [], recorded: "a", current: "a" };
const POSITIONING = ".agentplugged/docs/launch/positioning.md";
const BLOB = "a".repeat(40);

const CONFIG: NextConfig = {
  domains: DOMAIN_IDS,
  phases: ["framing", "launch"],
  tools: ["claude-code"],
  preferred: {},
  agents: { iris: "Iris", julien: "Julien", milo: "Milo" },
};

const docs = (positioning: boolean | undefined, knowledgeBase?: boolean): NextDocs => ({
  kinds: ["brief"],
  stories: [],
  ...(knowledgeBase === undefined ? {} : { knowledge_base: knowledgeBase }),
  ...(positioning === undefined ? {} : { positioning }),
});

const hour = (n: number) => new Date(Date.UTC(2026, 9, 3, n)).toISOString();

/** The end of framing, approved at hour 1: the launch began after it. */
const framed = answered("G-FRAME", "approved", hour(1), [], {
  type: "phase_end",
  phase: "framing",
});

function state(checkpoints: readonly CheckpointState[] = [framed]): NextState {
  return {
    projection: { checkpoints: Object.fromEntries(checkpoints.map((entry) => [entry.id, entry])) },
    now: NOW,
    sync: SYNCED,
  };
}

describe("next: the positioning opens the launch", () => {
  it("adds its step to the end of the list", () => {
    expect(NEXT_STEPS).toContain("positioning");
  });

  it("gives Julien the positioning while there is none", () => {
    expect(nextStep(state(), docs(false), CONFIG)).toMatchObject({
      step: "positioning",
      phase: "launch",
      agent: "julien",
      you: false,
    });
  });

  it("goes on with the launch once the positioning is there, or when it is not known", () => {
    expect(nextStep(state(), docs(true), CONFIG)).toMatchObject({
      step: "launch",
      agent: "julien",
    });
    expect(nextStep(state(), docs(undefined), CONFIG).step).toBe("launch");
  });

  it("asks Zoé for the knowledge base first when there is none, else leaves it to Julien", () => {
    const zoe = { ...CONFIG, agents: { ...CONFIG.agents, zoe: "Zoé" } };
    expect(nextStep(state(), docs(false, false), zoe)).toMatchObject({
      step: "knowledge_base",
      agent: "zoe",
    });
    expect(nextStep(state(), docs(false, true), zoe).step).toBe("positioning");
    // Zoé inactive, or no documentation domain (launch-only): the launch goes on, no loop.
    expect(nextStep(state(), docs(false, false), CONFIG).step).toBe("launch");
    const noDocs = DOMAIN_IDS.filter((domain) => domain !== "docs");
    expect(nextStep(state(), docs(false, false), { ...zoe, domains: noDocs }).step).toBe("launch");
  });

  it("does not ask again for a positioning already submitted on another branch", () => {
    const open = checkpointState("G-PUBLI", {
      type: "publication",
      opened_by: "julien",
      documents: [{ path: POSITIONING, branch: "work", blob_sha: BLOB }],
    });
    // An open publication waits for the creator first; the positioning is not asked
    // for again.
    const step = nextStep(state([framed, open]), docs(false, true), CONFIG);
    expect(step.step).not.toBe("positioning");
    expect(step).toMatchObject({ step: "validation", checkpoint: "G-PUBLI" });
  });

  it("proposes it only to an active Julien, in the marketing domain", () => {
    const { julien: _julien, ...others } = CONFIG.agents;
    expect(nextStep(state(), docs(false), { ...CONFIG, agents: others }).step).not.toBe(
      "positioning",
    );
    const noMarketing = DOMAIN_IDS.filter((domain) => domain !== "marketing");
    expect(nextStep(state(), docs(false), { ...CONFIG, domains: noMarketing })).toMatchObject({
      step: "launch",
      agent: "milo",
    });
  });

  it("stops proposing it once its publication waits for the creator, and leaves a closed launch alone", () => {
    const waiting = checkpointState("G-PUBLI", {
      type: "publication",
      opened_by: "julien",
      documents: [{ path: POSITIONING, branch: "main", blob_sha: BLOB }],
    });
    const open = nextStep(state([framed, waiting]), docs(true), CONFIG);
    expect(open.step).not.toBe("positioning");
    expect(open.waiting.map((entry) => entry.id)).toEqual(["G-PUBLI"]);
    const approved = answered("G-DONE", "approved", hour(5), [[POSITIONING, BLOB]], {
      type: "publication",
      opened_by: "julien",
    });
    expect(nextStep(state([framed, approved]), docs(false), CONFIG)).toMatchObject({
      step: "phase_end",
      phase: "launch",
    });
  });
});
