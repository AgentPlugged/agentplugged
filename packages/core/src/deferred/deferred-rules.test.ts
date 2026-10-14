import { DOMAIN_IDS, type EventEnvelope } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type DeferredItem,
  deferredLocks,
  type NextConfig,
  type NextDocs,
  nextStep,
  type SprintState,
} from "../index.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { DEFERRED_REDUCERS } from "../projection/deferred-reducers.js";
import { emptyDraft } from "../projection/reducers.js";

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const RECORD = "01JZ0000000000000000REC001";
const ITEM = `D-${RECORD.slice(-10)}`;

/** An event as the reducers receive it: already checked, any actor. */
function event(
  id: string,
  type: string,
  actor: EventEnvelope["actor"],
  payload: Record<string, unknown>,
  story?: string,
): EventEnvelope {
  return {
    v: 1,
    id,
    type,
    at: "2026-10-05T10:00:00.000Z",
    actor,
    product: "01JZ0000000000000000PRODUC",
    provenance: "trusted",
    prev: null,
    payload,
    alg: "ed25519",
    sig: "x",
    ...(story === undefined ? {} : { story }),
  } as EventEnvelope;
}

const recorded = (
  actor: EventEnvelope["actor"] = { kind: "agent", agent: "quentin", device: "machine:a" },
) =>
  event(
    RECORD,
    "deferred.recorded",
    actor,
    { title: "Rate-limit", origin: "review", owner: "sam", locks: ["1-2"] },
    "1-1",
  );

const closed = (id: string, device: string) =>
  event(
    id,
    "deferred.closed",
    { kind: "human", device },
    { item: ITEM, outcome: "dropped", reason: "No." },
  );

/** Applies the events with the creators' keys given: `root` trusted, `pending` not yet. */
function reduce(events: readonly EventEnvelope[]) {
  const draft = emptyDraft();
  draft.state.humans = {
    "human:root": { device: "human:root", trust: "root", presence: [] },
    "human:pending": { device: "human:pending", trust: "pending", presence: [] },
  };
  for (const entry of events) DEFERRED_REDUCERS[entry.type]?.(draft, entry);
  return draft;
}

describe("the reducers of deferred work", () => {
  it("applies a trusted creator's closing only", () => {
    const pending = reduce([recorded(), closed("01JZ0000000000000000CLO001", "human:pending")]);
    expect(pending.ignored).toEqual([
      { id: "01JZ0000000000000000CLO001", reason: "unendorsed_human" },
    ]);
    expect(deferredLocks(pending.state, "1-2").map((item) => item.id)).toEqual([ITEM]);
    const unknown = reduce([recorded(), closed("01JZ0000000000000000CLO002", "human:nobody")]);
    expect(unknown.ignored).toEqual([
      { id: "01JZ0000000000000000CLO002", reason: "unknown_signer" },
    ]);
    const root = reduce([recorded(), closed("01JZ0000000000000000CLO003", "human:root")]);
    expect(root.ignored).toEqual([]);
    expect(deferredLocks(root.state, "1-2")).toEqual([]);
  });

  it("ignores an item recorded by the creator", () => {
    const draft = reduce([recorded({ kind: "human", device: "human:root" })]);
    expect(draft.ignored).toEqual([{ id: RECORD, reason: "invalid" }]);
  });

  it("hands out copies: changing one never changes the projection", () => {
    const draft = reduce([recorded()]);
    const [item] = deferredLocks(draft.state, "1-2");
    if (item === undefined) throw new Error("no item");
    (item.locks as string[]).push("9-9");

    expect(deferredLocks(draft.state, "9-9")).toEqual([]);
  });
});

describe("next, with a sprint whose next story is locked", () => {
  const AGENTS = { izzy: "Izzy", sam: "Sam", ethan: "Ethan", quentin: "Quentin" };
  const BUILD: NextConfig = {
    domains: DOMAIN_IDS,
    phases: ["build"],
    tools: ["claude-code"],
    preferred: {},
    agents: AGENTS,
  };
  const DOCS: NextDocs = { kinds: ["epic"], stories: ["1-1", "1-2"] };
  const SYNCED = { manifest: true, missing: [], recorded: "a", current: "a" };
  const sprint: SprintState = {
    id: "S-SPRINT0001",
    goal: "Accounts",
    stories: [
      { id: "1-2", owner: "ethan", budget_usd: 2 },
      { id: "1-1", owner: "sam", budget_usd: 2 },
    ],
    capacity: { agents: ["ethan", "sam"], humans: 0 },
    budget_usd: 4,
    budget_limit_usd: null,
    checkpoint: "G-SPRINT0001",
    planned_by: "izzy",
    at: "2026-10-05T09:00:00.000Z",
    event: "01JZ00000000000000SPRINT01",
  };
  const approved = {
    id: sprint.checkpoint,
    type: "document",
    risk: "medium",
    title: "Sprint",
    status: "resolved",
    story: null,
    documents: [],
    blocks: [],
    opened_by: "izzy",
    opened_event: "01JZ00000000000000SPRINT00",
    resolution: { decision: "approved", at: "2026-10-05T09:30:00Z", event: "E1" },
    blocks_lifted: true,
    phase: null,
  } as unknown as CheckpointState;
  const item = (owner: string, locks: string[]): DeferredItem => ({
    id: ITEM,
    title: "Rate-limit",
    detail: null,
    origin: "deliberate",
    story: null,
    owner,
    locks,
    phase: null,
    status: "open",
    recorded_by: "quentin",
    recorded_at: "2026-10-05T10:00:00.000Z",
    event: RECORD,
    closed: null,
  });
  const state = (deferred: DeferredItem) => ({
    projection: {
      sprints: { [sprint.id]: sprint },
      checkpoints: { [approved.id]: approved },
      stories: {},
      deferred: { [deferred.id]: deferred },
    },
    now: NOW,
    sync: SYNCED,
  });
  const lock = { item: ITEM, story: "1-2", command: "npx agentplugged deferred list 1-2" };

  it("goes on with the next free story of the sprint, the lock on a second line", () => {
    for (const owner of ["creator", "quentin"]) {
      expect(nextStep(state(item(owner, ["1-2"])), DOCS, BUILD), owner).toMatchObject({
        step: "build",
        agent: "sam",
        story: "1-1",
        deferred: lock,
      });
    }
  });

  it("gives the item to treat when every story left is locked: to you, or to its agent", () => {
    expect(nextStep(state(item("creator", ["1-1", "1-2"])), DOCS, BUILD)).toMatchObject({
      step: "deferred_work",
      you: true,
      story: "1-2",
      command: lock.command,
      deferred: lock,
    });
    expect(nextStep(state(item("quentin", ["1-1", "1-2"])), DOCS, BUILD)).toMatchObject({
      step: "deferred_work",
      agent: "quentin",
      story: "1-2",
      deferred: lock,
    });
  });
});
