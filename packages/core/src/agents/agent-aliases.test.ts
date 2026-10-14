import { toBase64url } from "@agentplugged/crypto";
import {
  AGENT_EVENT_TYPES,
  type EventEnvelope,
  METHOD_EVENT_TYPES,
  STORY_EVENT_TYPES,
} from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  computeProjection,
  type EventDraft,
  MemoryKeyStore,
  MemoryStateStore,
  resultMovesToReview,
  storyBuilder,
} from "../index.js";
import {
  aliasAgent,
  aliasEvent,
  currentDeveloper,
  documentOwner,
  isRetiredDeveloper,
} from "./agent-aliases.js";

/**
 * The alias table of the former agents: with the format step
 * `rename-agents`, the only place of the product that names them, and these are its tests.
 */

const PRODUCT_ID = "01JZ4444444444444444444444";
const SEED = toBase64url(new Uint8Array(32).fill(5));

const status = (agent: string, story?: string): EventDraft => ({
  type: AGENT_EVENT_TYPES.statusReported,
  actor: { kind: "agent", agent },
  product: PRODUCT_ID,
  provenance: "trusted",
  ...(story === undefined ? {} : { story }),
  payload: { status: "working", task: `${agent} at work` },
});

const migrated = (from: number, to: number): EventDraft => ({
  type: METHOD_EVENT_TYPES.migrated,
  actor: { kind: "system" },
  product: PRODUCT_ID,
  provenance: "trusted",
  payload: {
    from_format: from,
    to_format: to,
    from_engine: "1.0.0",
    to_engine: "1.1.0",
    steps: to > from ? ["rename-agents"] : [],
  },
});

async function project(drafts: readonly EventDraft[]) {
  let now = Date.UTC(2026, 9, 3, 12, 0, 0);
  const journal = new MemoryStateStore({
    keys: new MemoryKeyStore(SEED),
    now: () => (now += 1000),
  });
  for (const draft of drafts) await journal.append(draft);
  const projection = await computeProjection(journal.events, { product: PRODUCT_ID });
  return { state: projection.state, events: journal.events };
}

describe("the alias table", () => {
  it("reads a former id as its successor before format 2, as itself after", () => {
    expect(aliasAgent("marc", 1)).toBe("maya");
    expect(aliasAgent("sam", 1)).toBe("izzy");
    expect(aliasAgent("sam", 2)).toBe("sam");
    expect(aliasAgent("nova", 1)).toBe("nova");
    expect(aliasAgent("iris", 1)).toBe("iris");
    expect(isRetiredDeveloper("orion")).toBe(true);
    expect(isRetiredDeveloper("ethan")).toBe(false);
    expect(documentOwner("argus")).toBe("chloe");
    expect(documentOwner("sam")).toBe("sam");
  });

  it("never changes the event it reads: a copy, the same one when nothing changes", async () => {
    const { events } = await project([status("lyra"), status("iris")]);
    const [former, current] = events.filter(
      (event) => event.type === AGENT_EVENT_TYPES.statusReported,
    ) as [EventEnvelope, EventEnvelope];
    const before = JSON.stringify(former);
    expect(aliasEvent(former, 1).actor.agent).toBe("julien");
    expect(JSON.stringify(former)).toBe(before);
    expect(aliasEvent(current, 1)).toBe(current);
    expect(aliasEvent(current, 2)).toBe(current);
  });
});

describe("the projection of a journal written under the former names", () => {
  it("rattaches each former id to its agent, sam to izzy before the migration only", async () => {
    const { state } = await project([
      status("marc"),
      status("sam"),
      status("nova", "1-1"),
      migrated(1, 2),
      status("sam", "2-1"),
    ]);
    const agents = state.agents as Record<string, { task: string | null }>;
    expect(Object.keys(agents).sort()).toEqual(["izzy", "maya", "nova", "sam"]);
    expect(agents.izzy?.task).toBe("sam at work");
    expect(agents.maya?.task).toBe("marc at work");
    // The retired developer keeps its history, under its own id.
    expect(agents.nova?.task).toBe("nova at work");
  });

  it("reads an unambiguous former id as its successor even after the migration", async () => {
    // A machine still on the former engine wrote after another one migrated.
    const { state } = await project([migrated(1, 2), status("marc"), status("sam")]);
    expect(Object.keys(state.agents as object).sort()).toEqual(["maya", "sam"]);
  });

  it("reads a product born at format 2 as it is: sam is the backend developer", async () => {
    const { state } = await project([status("sam", "4-2"), migrated(2, 2)]);
    expect(Object.keys(state.agents as object)).toEqual(["sam"]);
  });

  it("keeps the engine-only migrations of format 1 under the former names", async () => {
    const { state } = await project([migrated(1, 1), status("sam"), migrated(1, 2)]);
    expect(Object.keys(state.agents as object)).toEqual(["izzy"]);
  });
});

const started = (agent: string, story: string): EventDraft => ({
  type: STORY_EVENT_TYPES.started,
  actor: { kind: "system" },
  product: PRODUCT_ID,
  provenance: "trusted",
  story,
  payload: {
    agent,
    branch: `feat/${story}-work`,
    base: "a".repeat(40),
    base_ref: "main",
    worktree: `../shop.worktrees/${story}`,
  },
});

describe("instances (agent, story)", () => {
  it("tells two stories of one developer apart, and counts only the builders", async () => {
    const { state } = await project([
      started("sam", "4-1"),
      started("sam", "4-2"),
      started("ethan", "4-3"),
      status("sam", "4-1"),
      // A reviewer's event on a story is no instance.
      status("quentin", "4-1"),
    ]);
    expect(Object.keys(state.instances as object).sort()).toEqual([
      "ethan/4-3",
      "sam/4-1",
      "sam/4-2",
    ]);
    expect(state.instances).toMatchObject({
      "sam/4-1": { agent: "sam", story: "4-1", status: "working" },
      "sam/4-2": { agent: "sam", story: "4-2", status: null },
    });
  });
});

describe("successors of the retired developers", () => {
  it("hands their stories to the backend developers", () => {
    expect(currentDeveloper("nova")).toBe("sam");
    expect(currentDeveloper("orion")).toBe("ethan");
    expect(currentDeveloper("rex")).toBe("sam");
    expect(currentDeveloper("jade")).toBe("jade");
  });

  it("lets the successor build, take up and deliver a story of a retired developer", () => {
    const active = new Set(["sam", "ethan"]);
    expect(storyBuilder("4-1", "nova", undefined, active)).toBe("sam");
    expect(storyBuilder("4-2", "orion", undefined, active)).toBe("ethan");
    const started = {
      agent: "nova",
      branch: "feat/4-1-work",
      base: "a".repeat(40),
      base_ref: "main",
      worktree: "../shop.worktrees/4-1",
      device: "machine:AAAAAAAAAAAAAAAA",
      at: "2026-10-03T12:00:00.000Z",
      event: "01JZ4444444444444444444445",
    };
    const story = {
      status: "in_progress" as const,
      status_by: null,
      progress: null,
      results: {},
      waiting_on: [],
      started,
    };
    expect(resultMovesToReview(story, "sam", "complete")).toBe(true);
    expect(resultMovesToReview(story, "ethan", "complete")).toBe(false);
  });
});
