import { DOMAIN_IDS, PHASE_IDS } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type CheckpointState,
  type KnowledgePage,
  NEXT_STEPS,
  type NextConfig,
  type NextDocs,
  type NextState,
  nextStep,
  type StoryState,
  type SyncFreshness,
} from "../index.js";
import { answer, answered, checkpointState } from "../testing/checkpoint-state.js";

/** `next` calls Zoé to update the pages behind a document the creator validated. */

const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const A = "a".repeat(40);
const B = "b".repeat(40);
const PRD = ".agentplugged/docs/prd.md";
const PAGE = ".agentplugged/docs/reference/requirements.md";
const SYNCED: SyncFreshness = { manifest: true, missing: [], recorded: "a", current: "a" };

const CONFIG: NextConfig = {
  domains: DOMAIN_IDS,
  phases: PHASE_IDS,
  tools: ["claude-code"],
  preferred: {},
  agents: { iris: "Iris", maya: "Maya", alex: "Alex", izzy: "Izzy", zoe: "Zoé" },
};

/** The requirements page, built from the PRD at `blob`; this branch holds the PRD at B. */
const pageOn = (blob: string | undefined): KnowledgePage => ({
  path: PAGE,
  tracked: [{ path: PRD, blob, held: [B] }],
});

const docs = (blob: string | undefined, kinds: NextDocs["kinds"] = []): NextDocs => ({
  kinds,
  stories: [],
  knowledge_base: true,
  knowledge_pages: [pageOn(blob)],
});

const hour = (n: number) => new Date(Date.UTC(2026, 9, 3, n)).toISOString();
const prdValidated = answered("G-00001", "approved", hour(10), [[PRD, B]]);

function state(
  checkpoints: readonly CheckpointState[] = [prdValidated],
  stories: Record<string, StoryState> = {},
): NextState {
  return {
    projection: {
      checkpoints: Object.fromEntries(checkpoints.map((entry) => [entry.id, entry])),
      stories,
    },
    now: NOW,
    sync: SYNCED,
  };
}

/** Zoé's review of the updated page, answered `decision` (or still open). */
const clioReview = (
  id: string,
  decision: "open" | "rejected" | "changes_requested" | "approved",
) =>
  decision === "open"
    ? checkpointState(id, {
        opened_by: "zoe",
        documents: [{ path: PAGE, branch: "main", blob_sha: A }],
      })
    : answered(id, decision, hour(11), [[PAGE, A]], { opened_by: "zoe" });

describe("next: the knowledge base behind a validated document", () => {
  it("adds its step to the list", () => {
    expect(NEXT_STEPS).toContain("knowledge_base_update");
  });

  it("calls Zoé while a page is behind, on a new product as on an existing one", () => {
    for (const config of [CONFIG, { ...CONFIG, existing: true }]) {
      expect(nextStep(state(), docs(A), config)).toMatchObject({
        step: "knowledge_base_update",
        agent: "zoe",
        agent_name: "Zoé",
        you: false,
      });
      expect(nextStep(state(), docs(undefined), config).step).toBe("knowledge_base_update");
    }
  });

  it("goes on with the phase once the page records the validated version", () => {
    expect(nextStep(state(), docs(B), CONFIG)).toMatchObject({ step: "framing", agent: "iris" });
    // Never validated: nothing to update.
    expect(nextStep(state([]), docs(A), CONFIG).step).toBe("framing");
    // Without pages: nothing to update.
    expect(nextStep(state(), { kinds: [], stories: [] }, CONFIG).step).toBe("framing");
    // Validated on a branch this one does not hold yet.
    const elsewhere: NextDocs = {
      ...docs(A),
      knowledge_pages: [{ path: PAGE, tracked: [{ path: PRD, blob: A, held: [A] }] }],
    };
    expect(nextStep(state(), elsewhere, CONFIG).step).toBe("framing");
  });

  it("is never proposed without the docs domain or Zoé", () => {
    const noDocs = DOMAIN_IDS.filter((domain) => domain !== "docs");
    expect(nextStep(state(), docs(A), { ...CONFIG, domains: noDocs }).step).not.toBe(
      "knowledge_base_update",
    );
    const { zoe: _clio, ...others } = CONFIG.agents;
    expect(nextStep(state(), docs(A), { ...CONFIG, agents: others }).step).toBe("framing");
  });

  it("comes after what waits for the creator, a refused end, a story under way and the delivery", () => {
    const blocking = checkpointState("G-00002", {
      type: "story",
      story: "2-6",
      blocks: [{ action: "story.review", story: "2-6" }],
    });
    expect(nextStep(state([prdValidated, blocking]), docs(A), CONFIG).step).toBe("validation");
    const stale = { ...state(), sync: { ...SYNCED, current: "b" } };
    expect(nextStep(stale, docs(A), CONFIG).step).toBe("sync");
    const refusedEnd = answered("G-00003", "changes_requested", hour(11), [], {
      type: "phase_end",
      phase: "framing",
      opened_by: "iris",
    });
    expect(nextStep(state([prdValidated, refusedEnd]), docs(A, ["brief"]), CONFIG).step).toBe(
      "changes_requested",
    );
    const building = state([prdValidated], {
      "2-6": { status: "in_progress", status_by: { agent: "izzy", at: hour(9) } } as StoryState,
    });
    const build = { ...CONFIG, phases: ["build"] as const };
    expect(nextStep(building, docs(A, ["epic"]), build).step).toBe("build");
    const delivery = { ...CONFIG, phases: ["delivery"] as const };
    expect(nextStep(state(), docs(A), delivery).step).not.toBe("knowledge_base_update");
  });

  it("lets a missing base of an existing product come first", () => {
    const missing = { ...docs(A), knowledge_base: false };
    expect(nextStep(state(), missing, { ...CONFIG, existing: true }).step).toBe("knowledge_base");
  });
});

describe("next: Zoé's reviews of the base, on any product", () => {
  it("waits for the creator while her review is open", () => {
    const review = clioReview("G-00004", "open");
    expect(nextStep(state([prdValidated, review]), docs(B), CONFIG)).toMatchObject({
      step: "knowledge_base_review",
      you: true,
      checkpoint: "G-00004",
      command: "npx agentplugged review G-00004",
    });
  });

  it("sends a refused review back to Zoé until one supersedes it", () => {
    for (const decision of ["rejected", "changes_requested"] as const) {
      const refused = clioReview("G-00005", decision);
      expect(nextStep(state([prdValidated, refused]), docs(B), CONFIG)).toMatchObject({
        step: "changes_requested",
        agent: "zoe",
        checkpoint: "G-00005",
      });
    }
    const refused = clioReview("G-00005", "rejected");
    const again = checkpointState("G-00006", {
      opened_by: "zoe",
      supersedes: "G-00005",
      opened_event: "01JZ0000000000000000ZZZZZZ",
      documents: [{ path: PAGE, branch: "main", blob_sha: B }],
    });
    expect(nextStep(state([prdValidated, refused, again]), docs(B), CONFIG)).toMatchObject({
      step: "knowledge_base_review",
      checkpoint: "G-00006",
    });
    const approvedAgain = {
      ...again,
      status: "resolved" as const,
      resolution: answer("approved", hour(12)),
    };
    expect(nextStep(state([prdValidated, refused, approvedAgain]), docs(B), CONFIG).step).toBe(
      "framing",
    );
  });

  it("waits for the creator's answer to Zoé's question, on a new product too", () => {
    const question = checkpointState("G-00007", { type: "decision", opened_by: "zoe" });
    expect(nextStep(state([prdValidated, question]), docs(A), CONFIG)).toMatchObject({
      step: "knowledge_base_decision",
      you: true,
      checkpoint: "G-00007",
    });
  });
});

describe("next: the knowledge base behind a merged story", () => {
  const BILLING = ".agentplugged/docs/reference/billing.md";
  const billing = (lastStory?: string): KnowledgePage => ({
    path: BILLING,
    tracked: [],
    code: ["src/billing/"],
    ...(lastStory === undefined ? {} : { last_story: lastStory }),
  });
  const merged = (seq: number, files: string[]) =>
    ({ status: null, merged: { seq, files } }) as unknown as StoryState;
  const docsWith = (page: KnowledgePage): NextDocs => ({
    kinds: [],
    stories: [],
    knowledge_base: true,
    knowledge_pages: [page],
  });

  it("calls Zoé once a merged story changed the code a page describes", () => {
    const stories = { "4-3": merged(1, ["src/billing/tax.ts"]) };
    expect(nextStep(state([], stories), docsWith(billing()), CONFIG)).toMatchObject({
      step: "knowledge_base_update",
      agent: "zoe",
    });
    expect(nextStep(state([], stories), docsWith(billing("4-3")), CONFIG).step).not.toBe(
      "knowledge_base_update",
    );
    const elsewhere = { "4-4": merged(1, ["src/profile.ts"]) };
    expect(nextStep(state([], elsewhere), docsWith(billing()), CONFIG).step).not.toBe(
      "knowledge_base_update",
    );
  });
});
