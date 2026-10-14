import { DOMAIN_IDS } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type CheckpointState,
  type KnowledgePage,
  knowledgePages,
  type NextConfig,
  type NextDocs,
  type NextState,
  nextStep,
  type StoryState,
  type SyncFreshness,
} from "../index.js";
import { answered, checkpointState } from "../testing/checkpoint-state.js";

/** The base is created before the first story and updated beside the stories. */

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const SYNCED: SyncFreshness = { manifest: true, missing: [], recorded: "a", current: "a" };
const hour = (n: number) => new Date(Date.UTC(2026, 9, 8, n)).toISOString();

const CONFIG: NextConfig = {
  domains: DOMAIN_IDS,
  phases: ["design", "build"],
  tools: ["claude-code"],
  preferred: {},
  agents: { alex: "Alex", izzy: "Izzy", sam: "Sam", zoe: "Zoé" },
};

const designed = answered("G-DESIGN", "approved", hour(1), [], {
  type: "phase_end",
  phase: "design",
  opened_by: "alex",
});

function state(
  checkpoints: readonly CheckpointState[] = [designed],
  stories: Record<string, StoryState> = {},
  extra: Record<string, unknown> = {},
): NextState {
  return {
    projection: {
      checkpoints: Object.fromEntries(checkpoints.map((c) => [c.id, c])),
      stories,
      ...extra,
    },
    now: NOW,
    sync: SYNCED,
  };
}

const docs = (extra: Partial<NextDocs> = {}): NextDocs => ({
  kinds: ["brief", "prd", "architecture"],
  stories: [],
  knowledge_base: false,
  ...extra,
});

const underWay = {
  "1-1": { status: "in_progress", status_by: { agent: "sam", at: hour(9) } } as StoryState,
};
const merged = (seq: number, files: string[]) =>
  ({ status: null, merged: { seq, files } }) as unknown as StoryState;

describe("next: the base of a new product, before the first story", () => {
  it("calls Zoé once the architecture is validated and the build begins, asking nothing", () => {
    expect(nextStep(state(), docs(), CONFIG)).toMatchObject({
      step: "knowledge_base",
      agent: "zoe",
      you: false,
      waiting: [],
    });
  });

  it("waits for the design to be validated: not while the design phase is under way", () => {
    expect(nextStep(state([]), docs(), CONFIG).step).not.toBe("knowledge_base");
  });

  it("is not asked twice: once the base exists, or while a story is under way", () => {
    expect(nextStep(state(), docs({ knowledge_base: true }), CONFIG).step).not.toBe(
      "knowledge_base",
    );
    expect(nextStep(state([designed], underWay), docs(), CONFIG).step).not.toBe("knowledge_base");
  });

  it("is not called without Zoé, or when the creator skipped the base", () => {
    const { zoe: _zoe, ...others } = CONFIG.agents;
    expect(nextStep(state(), docs(), { ...CONFIG, agents: others }).step).not.toBe(
      "knowledge_base",
    );
    const skipped = state(
      [designed],
      {},
      { skips: { knowledge_base: { step: "knowledge_base" } } },
    );
    expect(nextStep(skipped, docs(), CONFIG).step).not.toBe("knowledge_base");
  });

  it("keeps asking the creator for a review when Zoé's base waits", () => {
    const review = checkpointState("G-BASE", {
      opened_by: "zoe",
      documents: [
        { path: ".agentplugged/docs/index.md", branch: "main", blob_sha: "a".repeat(40) },
      ],
    });
    expect(nextStep(state([designed, review]), docs({ knowledge_base: true }), CONFIG).step).toBe(
      "knowledge_base_review",
    );
  });
});

describe("next: the update beside the stories", () => {
  const PAGE = ".agentplugged/docs/reference/billing.md";
  const billing: KnowledgePage = { path: PAGE, tracked: [], code: ["src/billing/"] };
  const withPages = docs({ knowledge_base: true, knowledge_pages: [billing] });
  const late = (stories: Record<string, StoryState>) =>
    nextStep(state([designed], stories), withPages, CONFIG);

  it("goes beside a story under way, without taking the developer's place", () => {
    const step = late({ ...underWay, "0-9": merged(1, ["src/billing/tax.ts"]) });
    expect(step.step).not.toBe("knowledge_base_update");
    expect(step.you).toBe(false);
    expect(step.background).toMatchObject({
      step: "knowledge_base_update",
      agent: "zoe",
      agent_name: "Zoé",
      pages: [PAGE],
    });
  });

  it("is the step itself when no story is under way, with nothing beside it", () => {
    const step = late({ "0-9": merged(1, ["src/billing/tax.ts"]) });
    expect(step).toMatchObject({ step: "knowledge_base_update", agent: "zoe" });
    expect(step.background).toBeUndefined();
  });

  it("is absent when no page is behind, when Zoé is missing or already has a point open", () => {
    expect(late({ ...underWay, "0-9": merged(1, ["src/other.ts"]) }).background).toBeUndefined();
    const stories = { ...underWay, "0-9": merged(1, ["src/billing/tax.ts"]) };
    const { zoe: _zoe, ...others } = CONFIG.agents;
    expect(
      nextStep(state([designed], stories), withPages, { ...CONFIG, agents: others }).background,
    ).toBeUndefined();
    const open = checkpointState("G-OPEN", { opened_by: "zoe", type: "decision" });
    expect(
      nextStep(state([designed, open], stories), withPages, CONFIG).background,
    ).toBeUndefined();
  });
});

describe("next: the notes of a released version", () => {
  const NOTES = ".agentplugged/docs/release-notes/1-0-0.md";
  const mergedAt = (seq: number, at: string) =>
    ({ status: null, merged: { seq, files: [], at } }) as unknown as StoryState;
  const released = answered("G-REL", "approved", hour(12), [], {
    type: "release",
    opened_by: "omar",
  });
  const withNotes = (last?: string): NextDocs =>
    docs({
      knowledge_base: true,
      knowledge_pages: [
        { path: NOTES, tracked: [], ...(last === undefined ? {} : { last_story: last }) },
      ],
    });
  const stories = { "4-1": mergedAt(1, hour(10)), "4-2": mergedAt(2, hour(11)) };

  it("calls Zoé once a release is approved and stories it carries are not in the notes", () => {
    expect(nextStep(state([designed, released], stories), withNotes(), CONFIG)).toMatchObject({
      step: "release_notes",
      agent: "zoe",
      you: false,
    });
    expect(nextStep(state([designed, released], stories), withNotes("4-1"), CONFIG).step).toBe(
      "release_notes",
    );
  });

  it("is quiet once the notes cover the last story, before any release, or for later merges", () => {
    expect(nextStep(state([designed, released], stories), withNotes("4-2"), CONFIG).step).not.toBe(
      "release_notes",
    );
    expect(nextStep(state([designed], stories), withNotes(), CONFIG).step).not.toBe(
      "release_notes",
    );
    const later = { ...stories, "4-3": mergedAt(3, hour(14)) };
    expect(nextStep(state([designed, released], later), withNotes("4-2"), CONFIG).step).not.toBe(
      "release_notes",
    );
  });

  it("converges with the real parser: once the notes name the last story, Zoé is not called again", () => {
    const page = (last: string) =>
      `---\nid: kb-release-1-0-0\nkind: note\nowner: zoe\nlinks: []\nlast_story: ${last}\n---\n# 1.0.0\n`;
    const parsed = (last: string): NextDocs =>
      docs({
        knowledge_base: true,
        knowledge_pages: knowledgePages([{ path: NOTES, text: page(last) }]),
      });
    expect(nextStep(state([designed, released], stories), parsed("4-1"), CONFIG).step).toBe(
      "release_notes",
    );
    expect(nextStep(state([designed, released], stories), parsed("4-2"), CONFIG).step).not.toBe(
      "release_notes",
    );
  });

  it("waits for Zoé's open review, and for a refused end", () => {
    const review = checkpointState("G-NOTES", {
      opened_by: "zoe",
      documents: [{ path: NOTES, branch: "main", blob_sha: "a".repeat(40) }],
    });
    expect(
      nextStep(state([designed, released, review], stories), withNotes(), CONFIG).step,
    ).not.toBe("release_notes");
  });

  it("never holds a story under way", () => {
    const busy = { ...stories, ...underWay };
    expect(nextStep(state([designed, released], busy), withNotes(), CONFIG).step).not.toBe(
      "release_notes",
    );
  });
});
