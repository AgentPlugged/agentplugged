import { gitBlobId, utf8 } from "@agentplugged/crypto";
import { DOMAIN_IDS, type EventEnvelope } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type CheckSprintInput,
  checkSprint,
  currentSprint,
  latestSprint,
  type NextConfig,
  type NextDocs,
  nextStep,
  reviewActions,
  type SprintState,
  type SprintStory,
  sprintBudget,
  sprintStatus,
  waiverRefusal,
} from "../index.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { emptyDraft } from "../projection/reducers.js";
import { SPRINT_REDUCERS } from "../projection/sprint-reducers.js";
import {
  firstSprintProblem,
  formatUsd,
  sprintGeneratedLines,
  validatedStories,
  validationOf,
} from "./sprint-rules.js";

const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);

function story(id: string, extra: Partial<SprintStory> = {}): SprintStory {
  return {
    id,
    path: `.agentplugged/stories/${id}.md`,
    state: "valid",
    faults: [],
    bytes: utf8(`story ${id}\n`),
    owner: "sam",
    budget_usd: 2.5,
    depends_on: [],
    ...extra,
  };
}

const DOCUMENTS = new Map<string, SprintStory>([
  ["1-1", story("1-1")],
  ["1-2", story("1-2", { depends_on: ["1-1"], budget_usd: 4 })],
  ["1-3", story("1-3", { owner: "ethan" })],
  ["1-4", story("1-4", { owner: "creator", depends_on: ["1-1", "1-3"] })],
  [
    "1-5",
    story("1-5", {
      state: "invalid",
      faults: ["STORY_DEPENDENCY_CYCLE"],
      owner: undefined,
      budget_usd: undefined,
    }),
  ],
  ["1-6", story("1-6", { state: "unreadable", owner: undefined, budget_usd: undefined })],
]);

const VALIDATED = new Map(
  ["1-1", "1-2", "1-3", "1-4", "1-5"].map((id) => [id, "validated" as const]),
);

function input(extra: Partial<CheckSprintInput> = {}): CheckSprintInput {
  return {
    stories: ["1-1", "1-2"],
    capacity: { agents: ["sam"], humans: 0 },
    summary: "Accounts first.",
    documents: DOCUMENTS,
    validation: VALIDATED,
    done: new Set(),
    agents: new Set(["izzy", "sam", "ethan"]),
    ...extra,
  };
}

const reasons = (value: CheckSprintInput) => checkSprint(value).problems;

describe("checkSprint", () => {
  it("accepts stories in an order the graph allows, and adds up their budgets", () => {
    expect(checkSprint(input())).toEqual({ problems: [], budget_usd: 6.5 });
  });

  it("refuses a dependency later in the sprint, or neither done nor in it", () => {
    expect(reasons(input({ stories: ["1-2", "1-1"] }))).toEqual([
      { reason: "dependency_later", story: "1-2", dependency: "1-1" },
    ]);
    expect(reasons(input({ stories: ["1-2"] }))).toEqual([
      { reason: "dependency_missing", story: "1-2", dependency: "1-1" },
    ]);
    // A dependency already done needs no place in the sprint.
    expect(reasons(input({ stories: ["1-2"], done: new Set(["1-1"]) }))).toEqual([]);
  });

  it("refuses an unknown, unreadable, invalid, unvalidated or done story, and one twice", () => {
    expect(reasons(input({ stories: ["9-9"] }))).toEqual([
      { reason: "unknown_story", story: "9-9" },
    ]);
    expect(reasons(input({ stories: ["1-6"] }))).toEqual([{ reason: "unreadable", story: "1-6" }]);
    expect(reasons(input({ stories: ["1-1", "1-1"] }))).toEqual([
      { reason: "duplicate_story", story: "1-1" },
    ]);
    expect(reasons(input({ stories: ["1-5"] }))).toEqual([
      { reason: "invalid_story", story: "1-5", why: "STORY_DEPENDENCY_CYCLE" },
    ]);
    expect(reasons(input({ stories: ["1-1"], validation: new Map() }))).toEqual([
      { reason: "not_validated", story: "1-1", why: "never" },
    ]);
    expect(reasons(input({ stories: ["1-1"], validation: new Map([["1-1", "changed"]]) }))).toEqual(
      [{ reason: "not_validated", story: "1-1", why: "changed" }],
    );
    expect(reasons(input({ stories: ["1-1"], done: new Set(["1-1"]) }))).toEqual([
      { reason: "done", story: "1-1" },
    ]);
  });

  it("checks the capacity: active agents, not empty, covering each owner", () => {
    expect(reasons(input({ stories: ["1-3"] }))).toEqual([
      { reason: "owner_unavailable", story: "1-3", agent: "ethan" },
    ]);
    expect(
      reasons(input({ stories: ["1-1"], capacity: { agents: ["sam", "ghost"], humans: 0 } })),
    ).toEqual([{ reason: "agent_inactive", agent: "ghost" }]);
    expect(reasons(input({ stories: ["1-1"], capacity: { agents: [], humans: 0 } }))).toEqual(
      expect.arrayContaining([{ reason: "no_capacity" }]),
    );
    // A story the creator builds needs a human.
    const creator = input({
      stories: ["1-1", "1-3", "1-4"],
      capacity: { agents: ["sam", "ethan"], humans: 0 },
    });
    expect(reasons(creator)).toEqual([
      { reason: "owner_unavailable", story: "1-4", agent: "creator" },
    ]);
    expect(reasons({ ...creator, capacity: { agents: ["sam", "ethan"], humans: 1 } })).toEqual([]);
  });

  it("refuses a total above the ceiling, or above what a sprint records, and an open proposal", () => {
    expect(reasons(input({ budget_limit_usd: 6 }))).toEqual([
      { reason: "over_budget", budget_usd: 6.5, limit: 6 },
    ]);
    expect(reasons(input({ budget_limit_usd: 6.5 }))).toEqual([]);
    const huge = new Map([["1-1", story("1-1", { budget_usd: 2_000_000 })]]);
    expect(reasons(input({ stories: ["1-1"], documents: huge }))).toEqual([
      { reason: "over_budget", budget_usd: 2_000_000, limit: 1_000_000 },
    ]);
    expect(reasons(input({ openProposal: "G-OPEN000001" }))).toEqual([
      { reason: "proposal_open", checkpoint: "G-OPEN000001" },
    ]);
  });

  it("never cuts the checkpoint: the summary gets the room the generated lines leave", () => {
    const many = new Map<string, SprintStory>();
    const ids: string[] = [];
    for (let index = 1; index <= 100; index++) {
      const id = `${index}-${index}`;
      ids.push(id);
      many.set(id, story(id, { owner: "sam-2", budget_usd: 123456.78 }));
    }
    const validation = new Map(ids.map((id) => [id, "validated" as const]));
    // 100 stories alone do not fit in 2000 characters: refused, never cut.
    expect(
      reasons(input({ stories: ids, documents: many, validation })).filter(
        (problem) => problem.reason === "too_long",
      ),
    ).toEqual([{ reason: "too_long", field: "stories", max: 0 }]);
    // A few stories leave room; a summary longer than that room is refused with the room.
    const few = ids.slice(0, 30);
    const capacity = { agents: ["sam", "sam-2"], humans: 0 };
    const generated = sprintGeneratedLines({
      stories: few,
      documents: many,
      capacity,
      budget_usd: sprintBudget(few, many),
    });
    const room = 2000 - generated.length - 2;
    const agents = new Set(["sam", "sam-2"]);
    const fits = input({
      stories: few,
      documents: many,
      validation,
      capacity,
      agents,
      summary: "x".repeat(room),
    });
    expect(reasons(fits).filter((problem) => problem.reason === "too_long")).toEqual([]);
    const over = { ...fits, summary: "x".repeat(room + 1) };
    expect(reasons(over).filter((problem) => problem.reason === "too_long")).toEqual([
      { reason: "too_long", field: "summary", max: room },
    ]);
  });

  it("counts each story once in the budget, and formats amounts with two decimals", () => {
    expect(sprintBudget(["1-1", "1-1", "1-5", "9-9"], DOCUMENTS)).toBe(2.5);
    expect(sprintBudget(["1-1", "1-2", "1-3"], DOCUMENTS)).toBe(9);
    expect(formatUsd(4)).toBe("$4.00");
    expect(formatUsd(0.000001)).toBe("$0.00");
    expect(formatUsd(1e21)).toBe("$1000000000000000000000.00");
  });

  it("names first a problem with a story, and explains the budget and the capacity", () => {
    expect(
      firstSprintProblem([
        { reason: "no_capacity" },
        { reason: "dependency_later", story: "1-2", dependency: "1-1" },
      ]),
    ).toBe("dependency_later 1-2 1-1");
    expect(firstSprintProblem([{ reason: "over_budget", budget_usd: 12.5, limit: 10 }])).toBe(
      "over_budget: total $12.50 above $10.00",
    );
    expect(firstSprintProblem([{ reason: "no_capacity" }])).toBe(
      "no_capacity: the capacity names no agent and no human",
    );
    expect(firstSprintProblem([{ reason: "not_validated", story: "1-1", why: "changed" }])).toBe(
      "not_validated 1-1 (changed)",
    );
  });
});

/** A checkpoint as the projection keeps it: only what the rules read. */
function checkpoint(id: string, extra: Partial<CheckpointState> = {}): CheckpointState {
  return {
    id,
    type: "document",
    risk: "medium",
    title: `Sprint ${id}`,
    status: "open",
    story: null,
    documents: [],
    blocks: [],
    opened_by: "izzy",
    opened_event: `01JZ00000000000000000${id.slice(-5)}`,
    resolution: null,
    blocks_lifted: false,
    phase: null,
    ...extra,
  } as CheckpointState;
}

const answered = (decision: string, at: string) => ({
  status: (decision === "waived" ? "waived" : "resolved") as CheckpointState["status"],
  blocks_lifted: decision !== "changes_requested",
  resolution: {
    decision,
    waiver_until: decision === "waived" ? "2026-12-01T00:00:00Z" : null,
    at,
    event: `E${at}`,
  } as unknown as CheckpointState["resolution"],
});

const entry = (id: string, owner = "sam") => ({ id, owner, budget_usd: 2 });

function sprint(id: string, stories: string[], extra: Partial<SprintState> = {}): SprintState {
  return {
    id,
    goal: `Goal of ${id}`,
    stories: stories.map((story) => entry(story)),
    capacity: { agents: ["sam"], humans: 0 },
    budget_usd: 5,
    budget_limit_usd: null,
    checkpoint: `G-${id.slice(2)}`,
    planned_by: "izzy",
    at: "2026-10-04T09:00:00.000Z",
    event: `01JZ0000000000000000${id.slice(2, 8)}`,
    ...extra,
  };
}

describe("the sprint in force", () => {
  const first = sprint("S-AAAAAAAAA1", ["1-1", "1-2"]);
  const second = sprint("S-AAAAAAAAA2", ["1-3"]);
  const sprints = { [first.id]: first, [second.id]: second };

  it("is the approved one answered last; open or refused ones are never in force", () => {
    const open = {
      [first.checkpoint]: checkpoint(first.checkpoint),
      [second.checkpoint]: checkpoint(second.checkpoint),
    };
    expect(currentSprint(sprints, open, NOW)).toBeUndefined();
    expect(sprintStatus(first, sprints, open, NOW)).toBe("proposed");
    const approved = {
      [first.checkpoint]: checkpoint(
        first.checkpoint,
        answered("approved", "2026-10-04T10:00:00Z"),
      ),
      [second.checkpoint]: checkpoint(
        second.checkpoint,
        answered("changes_requested", "2026-10-04T11:00:00Z"),
      ),
    };
    expect(currentSprint(sprints, approved, NOW)?.id).toBe(first.id);
    expect(sprintStatus(second, sprints, approved, NOW)).toBe("refused");
    expect(latestSprint(sprints)?.id).toBe(second.id);
    // A sprint approved later replaces the first one.
    const both = {
      ...approved,
      [second.checkpoint]: checkpoint(
        second.checkpoint,
        answered("approved_with_reservations", "2026-10-04T11:00:00Z"),
      ),
    };
    expect(currentSprint(sprints, both, NOW)?.id).toBe(second.id);
    expect(sprintStatus(first, sprints, both, NOW)).toBe("superseded");
    expect(sprintStatus(second, sprints, both, NOW)).toBe("in_force");
  });

  it("is never a waived one, which is never shown as refused either", () => {
    const waived = {
      [first.checkpoint]: checkpoint(first.checkpoint, answered("waived", "2026-10-04T10:00:00Z")),
    };
    expect(currentSprint({ [first.id]: first }, waived, NOW)).toBeUndefined();
    expect(sprintStatus(first, { [first.id]: first }, waived, NOW)).toBe("waived");
  });

  it("refuses a waiver on a sprint checkpoint, as on the end of a phase", () => {
    const failed = {
      ...checkpoint(first.checkpoint),
      verdict: { result: "fail" },
    } as unknown as CheckpointState;
    expect(waiverRefusal({ ...failed, sprint: true })).toBe("sprint");
    expect(reviewActions({ ...failed, sprint: true }).map((action) => action.kind)).not.toContain(
      "waive",
    );
    expect(reviewActions(failed).map((action) => action.kind)).toContain("waive");
  });

  it("ignores a checkpoint its planner did not open", () => {
    const foreign = {
      [first.checkpoint]: checkpoint(first.checkpoint, {
        ...answered("approved", "2026-10-04T10:00:00Z"),
        opened_by: "iris",
      }),
    };
    expect(currentSprint({ [first.id]: first }, foreign, NOW)).toBeUndefined();
    expect(sprintStatus(first, { [first.id]: first }, foreign, NOW)).toBe("refused");
  });
});

describe("validated stories", () => {
  const listing = (path: string, bytes: Uint8Array, extra: Partial<CheckpointState> = {}) =>
    checkpoint(`G-DOC${path.length.toString().padStart(7, "0")}`, {
      ...answered("approved", "2026-10-04T08:00:00Z"),
      documents: [{ path, branch: "main", blob_sha: gitBlobId(bytes) }],
      ...extra,
    });
  const one = story("1-1");

  it("are listed by an approved document checkpoint at their current content", () => {
    const documents = new Map([["1-1", one]]);
    expect([...validatedStories(documents, [listing(one.path, one.bytes)], NOW)]).toEqual(["1-1"]);
    // An open checkpoint validates nothing.
    const open = listing(one.path, one.bytes, { status: "open", resolution: null });
    expect([...validatedStories(documents, [open], NOW)]).toEqual([]);
    // `.MD`, `\` and a sub-folder are read as the same story file.
    const upper = listing(`product\\.agentplugged\\stories\\1-1.MD`, one.bytes);
    expect([...validatedStories(documents, [upper], NOW)]).toEqual(["1-1"]);
    // CRLF in the working copy, LF in the approved blob: the same content.
    const crlf = new Map([["1-1", story("1-1", { bytes: utf8("story 1-1\r\n") })]]);
    expect([...validatedStories(crlf, [listing(one.path, one.bytes)], NOW)]).toEqual(["1-1"]);
  });

  it("are not validated once their file changed since the approval", () => {
    const changed = new Map([["1-1", story("1-1", { bytes: utf8("story 1-1, owner changed\n") })]]);
    expect(validationOf(changed, [listing(one.path, one.bytes)], NOW).get("1-1")).toBe("changed");
    expect(validationOf(changed, [], NOW).get("1-1")).toBe("never");
  });
});

describe("the sprint reducer", () => {
  const event = (id: string, extra: Partial<EventEnvelope> = {}): EventEnvelope =>
    ({
      v: 1,
      id,
      type: "sprint.planned",
      at: "2026-10-04T10:00:00.000Z",
      actor: { kind: "agent", device: "machine:AAAAAAAAAAAAAAAA", agent: "izzy" },
      product: "01JZ0000000000000000000000",
      provenance: "trusted",
      prev: null,
      payload: {
        goal: "Sign up",
        stories: [entry("1-1")],
        capacity: { agents: ["sam"], humans: 0 },
        budget_usd: 2,
        checkpoint: "G-CHECKPOIN1",
      },
      ...extra,
    }) as EventEnvelope;
  const reduce = (
    events: readonly EventEnvelope[],
    opened: Partial<CheckpointState> = {},
    parents: Record<string, string> = {},
  ) => {
    const draft = emptyDraft();
    draft.state.checkpoints = {
      "G-CHECKPOIN1": checkpoint("G-CHECKPOIN1", {
        opened_event: "01JZ000000000000CHECKPOIN1",
        ...opened,
      }),
    };
    for (const [child, parent] of Object.entries(parents)) draft.parents.set(child, parent);
    for (const item of events) SPRINT_REDUCERS["sprint.planned"]?.(draft, item);
    return draft;
  };
  const ID = "01JZ000000000000SPRINT0001";
  const chained = { [ID]: "01JZ000000000000CHECKPOIN1" };

  it("records a sprint whose checkpoint its own write opened", () => {
    const draft = reduce([event(ID)], {}, chained);
    expect(Object.keys(draft.state.sprints as object)).toEqual(["S-SPRINT0001"]);
    expect(draft.ignored).toEqual([]);
  });

  it("ignores another actor, a taken id, a foreign checkpoint and a claimed one", () => {
    const human = reduce(
      [event(ID, { actor: { kind: "system", device: "machine:AAAAAAAAAAAAAAAA" } })],
      {},
      chained,
    );
    expect(human.ignored).toEqual([{ id: ID, reason: "invalid" }]);
    // Not chained on its checkpoint: another write.
    expect(reduce([event(ID)]).ignored).toEqual([{ id: ID, reason: "invalid" }]);
    // Opened by another agent, or not a document checkpoint.
    expect(reduce([event(ID)], { opened_by: "iris" }, chained).ignored).toHaveLength(1);
    expect(reduce([event(ID)], { type: "decision" }, chained).ignored).toHaveLength(1);
    // A second sprint naming the same checkpoint, then the same id again.
    const other = "01JZ000000000000SPRINT0002";
    const claimed = reduce([event(ID), event(other)], {}, { ...chained, [other]: chained[ID] });
    expect(claimed.ignored).toEqual([{ id: other, reason: "invalid" }]);
    const taken = reduce([event(ID), event(ID)], {}, chained);
    expect(taken.ignored).toEqual([{ id: ID, reason: "invalid" }]);
  });
});

describe("next, with sprints", () => {
  const AGENTS = { izzy: "Izzy", sam: "Sam", ethan: "Ethan", quentin: "Quentin" };
  const BUILD: NextConfig = {
    domains: DOMAIN_IDS,
    phases: ["build"],
    tools: ["claude-code"],
    preferred: {},
    agents: AGENTS,
  };
  const DOCS: NextDocs = { kinds: ["epic"], stories: ["1-1", "1-2", "1-3"] };
  const SYNCED = { manifest: true, missing: [], recorded: "a", current: "a" };
  const planned = sprint("S-BBBBBBBBB1", ["1-2", "1-1"], {
    stories: [entry("1-2", "ethan"), entry("1-1", "sam")],
    capacity: { agents: ["ethan", "sam"], humans: 0 },
  });
  const approvedPlan = {
    [planned.checkpoint]: checkpoint(
      planned.checkpoint,
      answered("approved", "2026-10-04T10:00:00Z"),
    ),
  };
  const state = (
    checkpoints: Record<string, unknown>,
    stories: Record<string, unknown> = {},
    sprints: Record<string, SprintState> = { [planned.id]: planned },
  ) => ({
    projection: { sprints, checkpoints, stories },
    now: NOW,
    sync: SYNCED,
  });
  const doneStory = (id: string, hour: number) =>
    checkpoint(`G-STORY${id.replace("-", "")}0`, {
      type: "story",
      story: id,
      ...answered("approved", `2026-10-04T${hour}:00:00Z`),
    });

  it("asks the creator to answer a proposal when no sprint is in force", () => {
    const step = nextStep(
      state({ [planned.checkpoint]: checkpoint(planned.checkpoint) }),
      DOCS,
      BUILD,
    );
    expect(step).toMatchObject({
      step: "validation",
      you: true,
      checkpoint: planned.checkpoint,
      command: `npx agentplugged review ${planned.checkpoint}`,
      sprint: null,
    });
    expect(step.waiting[0]?.id).toBe(planned.checkpoint);
  });

  it("follows the order of the sprint in force, each story to its recorded owner", () => {
    expect(nextStep(state(approvedPlan), DOCS, BUILD)).toMatchObject({
      step: "build",
      agent: "ethan",
      story: "1-2",
      sprint: { id: planned.id, goal: planned.goal, done: 0, total: 2 },
    });
    // Once 1-2 is done, 1-1 goes to Sam.
    const stories = {
      "1-2": { status: "in_review", status_by: { agent: "ethan", at: "2026-10-04T10:30:00Z" } },
    };
    const done = { ...approvedPlan, a: doneStory("1-2", 11) };
    expect(nextStep(state(done, stories), DOCS, BUILD)).toMatchObject({
      step: "build",
      agent: "sam",
      story: "1-1",
      sprint: { done: 1, total: 2 },
    });
  });

  it("falls back on the capacity, then on the creator, when the owner is not active", () => {
    const { ethan: _orion, ...withoutOrion } = AGENTS;
    expect(nextStep(state(approvedPlan), DOCS, { ...BUILD, agents: withoutOrion })).toMatchObject({
      step: "build",
      agent: "sam",
      story: "1-2",
    });
    const { sam: _nova, ...onlySam } = withoutOrion;
    expect(nextStep(state(approvedPlan), DOCS, { ...BUILD, agents: onlySam })).toMatchObject({
      step: "build",
      you: true,
      story: "1-2",
    });
  });

  it("leaves aside a story whose file is gone", () => {
    expect(
      nextStep(state(approvedPlan), { ...DOCS, stories: ["1-1", "1-3"] }, BUILD),
    ).toMatchObject({ step: "build", agent: "sam", story: "1-1" });
  });

  it("keeps the sprint in force first while a new proposal waits, shown in waiting", () => {
    const next = sprint("S-BBBBBBBBB2", ["1-3"]);
    const step = nextStep(
      state(
        { ...approvedPlan, [next.checkpoint]: checkpoint(next.checkpoint) },
        {},
        { [planned.id]: planned, [next.id]: next },
      ),
      DOCS,
      BUILD,
    );
    expect(step).toMatchObject({ step: "build", agent: "ethan", story: "1-2" });
    expect(step.waiting.map((waiting) => waiting.id)).toContain(next.checkpoint);
  });

  /** The creator set the retrospective of the sprint aside: it is not due again. */
  const retroAside = checkpoint("G-RETRO00001", {
    type: "memory",
    memory: { kind: "retrospective", scope: { kind: "sprint", id: planned.id } },
    ...answered("rejected", "2026-10-04T11:30:00Z"),
  });

  it("calls Izzy for the retrospective of a finished sprint, then for the next sprint", () => {
    const done = { ...approvedPlan, a: doneStory("1-1", 11), b: doneStory("1-2", 11) };
    expect(nextStep(state(done), DOCS, BUILD)).toMatchObject({
      step: "retrospective",
      agent: "izzy",
      scope: { kind: "sprint", id: planned.id },
    });
    const all = { ...done, [retroAside.id]: retroAside };
    expect(nextStep(state(all), DOCS, BUILD)).toMatchObject({
      step: "sprint_planning",
      agent: "izzy",
      sprint: { done: 2, total: 2 },
    });
  });

  it("does not call Izzy when every story without a status is done", () => {
    const all = {
      ...approvedPlan,
      a: doneStory("1-1", 11),
      b: doneStory("1-2", 11),
      c: doneStory("1-3", 11),
    };
    expect(nextStep(state(all), DOCS, BUILD).step).not.toBe("sprint_planning");
  });

  it("points to the breakdown, or its review, when no story left can be planned", () => {
    const all = {
      ...approvedPlan,
      a: doneStory("1-1", 11),
      b: doneStory("1-2", 11),
      [retroAside.id]: retroAside,
    };
    expect(nextStep(state(all), { ...DOCS, plannable: [] }, BUILD)).toMatchObject({
      step: "breakdown",
      agent: "izzy",
    });
    const review = checkpoint("G-REVIEW0001", { opened_event: "01JZ0000000000000000REVIEW" });
    expect(
      nextStep(state({ ...all, [review.id]: review }), { ...DOCS, plannable: [] }, BUILD),
    ).toMatchObject({
      step: "validation",
      you: true,
      checkpoint: review.id,
      command: `npx agentplugged review ${review.id}`,
    });
    expect(nextStep(state(all), { ...DOCS, plannable: ["1-3"] }, BUILD)).toMatchObject({
      step: "sprint_planning",
    });
  });

  it("gives a refused proposal back to its planner", () => {
    const refused = {
      [planned.checkpoint]: checkpoint(
        planned.checkpoint,
        answered("changes_requested", "2026-10-04T10:00:00Z"),
      ),
    };
    expect(nextStep(state(refused), DOCS, BUILD)).toMatchObject({
      step: "changes_requested",
      agent: "izzy",
      checkpoint: planned.checkpoint,
      command: "npx agentplugged history",
      sprint: null,
    });
  });
});
