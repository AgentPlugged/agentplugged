import { gitBlobId, toBase64url, utf8 } from "@agentplugged/crypto";
import { SoftwareAuthenticator } from "@agentplugged/crypto/webauthn-software";
import { ErrorCode, type PhaseId } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type AgentStateView,
  type CommandContext,
  computeProjection,
  createCommandRegistry,
  initCommand,
  MemoryKeyStore,
  MemoryStateStore,
  type NextResult,
  type RecordedEvent,
  resolveProfile,
  syncCommand,
  type ToolProbe,
} from "../index.js";
import {
  MemoryFiles,
  SHIPPED_IRIS,
  SHIPPED_IRIS_AGENT,
  shippedMethod,
} from "../testing/memory-files.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const SEED = toBase64url(new Uint8Array(32).fill(5));

/** A shipped agent built on the sample one. */
function shippedAgent(id: string, name: string, domain: string, phase: string) {
  return {
    [`agents/${id}/SKILL.md`]: SHIPPED_IRIS.replace("name: iris", `name: ${id}`)
      .replace("domain: product", `domain: ${domain}`)
      .replace("phase: framing", `phase: ${phase}`)
      .replace("# Iris", `# ${name}`),
    [`agents/${id}/agent.yaml`]: SHIPPED_IRIS_AGENT.replace("name: Iris", `name: ${name}`),
  };
}

/** A story `docs check` accepts: the contract and its four sections. */
function storyFile(id: string, owner: string, budget: number, dependsOn: string[] = []) {
  return [
    "---",
    `id: ${id}`,
    "kind: story",
    `owner: ${owner}`,
    `title: Story ${id}`,
    "epic: epic-1",
    "reviewer: quentin",
    "requirements: [EF-1]",
    `budget_usd: ${budget}`,
    `branch: feat/${id}-work`,
    `depends_on: [${dependsOn.join(", ")}]`,
    "---",
    `# Story ${id}`,
    "",
    "## Context",
    "",
    "Accounts.",
    "",
    "## Intent",
    "",
    `Ada can do ${id}.`,
    "",
    "## Acceptance criteria",
    "",
    "Given Ada, when she acts, then it works.",
    "",
    "## Out of scope",
    "",
    "Nothing else.",
    "",
  ].join("\n");
}

/** The stories of the product, by file name: id, owner, budget, dependencies. */
const STORIES: ReadonlyArray<readonly [string, string, string, number, string[]]> = [
  ["1-1-sign-up", "1-1", "sam", 3.5, []],
  ["1-2-sign-in", "1-2", "sam", 2, ["1-1"]],
  ["1-3-profile", "1-3", "ethan", 1, []],
  ["1-4-welcome", "1-4", "creator", 1, []],
];

/** A product in the build phase: framing, planning and design closed by the creator. */
async function product() {
  const files = new MemoryFiles();
  let clock = Date.UTC(2026, 9, 4, 12, 0, 0);
  const now = () => {
    clock += 1000;
    return clock;
  };
  const keys = new MemoryKeyStore(SEED);
  const journal = new MemoryStateStore({ keys, now });
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod({
      ...shippedAgent("stella", "Stella", "ux", "planning"),
      ...shippedAgent("izzy", "Izzy", "product", "build"),
      ...shippedAgent("sam", "Sam", "code", "build"),
      ...shippedAgent("ethan", "Ethan", "code", "build"),
      ...shippedAgent("quentin", "Quentin", "quality", "build"),
    }),
    actor: "human",
    engineVersion: "1.0.0",
    journal,
    now,
    interactive: true,
    human: { keys, presence: new SoftwareAuthenticator({ available: false }) },
  };
  const init = await initCommand.run(human, { profile: resolveProfile("new-product") });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const synced = await syncCommand.run(human, {});
  if (!synced.ok) throw new Error(`sync failed: ${synced.error.code}`);
  const agent: CommandContext = { ...human, actor: "agent", human: undefined };
  const registry = createCommandRegistry();
  const call = (name: string, input: Record<string, unknown>) => registry.run(name, agent, input);
  const run = async (name: string, input: Record<string, unknown>) => {
    const result = await call(name, input);
    if (!result.ok) throw new Error(`${name} failed: ${result.error.code}`);
    return result.value as RecordedEvent;
  };
  const answer = async (checkpoint: string | undefined, decision = "approved", note?: string) => {
    const answered = await registry.run("review", human, {
      action: "resolve",
      checkpoint,
      decision,
      ...(note === undefined ? {} : { note }),
    });
    if (!answered.ok) throw new Error(`review failed: ${answered.error.code}`);
  };
  const closers: Partial<Record<PhaseId, string>> = {
    framing: "iris",
    planning: "stella",
    design: "main",
  };
  for (const phase of ["framing", "planning", "design"] as const) {
    const opened = await run("open_checkpoint", {
      agent: closers[phase],
      type: "phase_end",
      phase,
      risk: "low",
      title: `End of ${phase}`,
      summary: "Ready.",
    });
    await answer(opened.checkpoint);
  }
  const reader: CommandContext = { ...human, human: undefined };
  const next = async () => {
    const result = await registry.run("next", reader, {});
    if (!result.ok) throw new Error(`next failed: ${result.error.code}`);
    return result.value as NextResult;
  };
  const state = async () => {
    const result = await call("get_state", { full: true });
    if (!result.ok) throw new Error(`get_state failed: ${result.error.code}`);
    return result.value as AgentStateView;
  };
  files.seed(
    ".agentplugged/docs/prd.md",
    "---\nid: prd\nkind: prd\nowner: maya\n---\n# PRD\n\nEF-1 : Ada signs up and in.\n",
  );
  files.seed(
    ".agentplugged/epics/epic-1.md",
    "---\nid: epic-1\nkind: epic\nowner: izzy\n---\n# Epic 1\n",
  );
  const path = (name: string) => `.agentplugged/stories/${name}.md`;
  for (const [name, id, owner, budget, dependsOn] of STORIES) {
    files.seed(path(name), storyFile(id, owner, budget, dependsOn));
  }
  /** The breakdown approved: a `document` checkpoint listing every story at its blob. */
  const validate = async () => {
    const opened = await run("open_checkpoint", {
      agent: "izzy",
      type: "document",
      risk: "medium",
      title: "Epic 1",
      summary: "The stories.",
      documents: await Promise.all(
        STORIES.map(async ([name]) => ({
          path: path(name),
          branch: "main",
          blob_sha: gitBlobId(utf8(await files.readText(path(name)))),
        })),
      ),
    });
    await answer(opened.checkpoint);
  };
  /** The creator accepts a story: an approved `story` checkpoint makes it done. */
  const finish = async (story: string, by = "sam") => {
    const opened = await run("open_checkpoint", {
      agent: by,
      type: "story",
      risk: "low",
      title: `Story ${story}`,
      summary: "Done.",
      story,
    });
    await answer(opened.checkpoint);
  };
  return { files, journal, call, run, answer, next, state, validate, finish, path };
}

const SPRINT = {
  agent: "izzy",
  goal: "Sign up and sign in",
  stories: ["1-1", "1-2"],
  capacity: { agents: ["sam"], humans: 0 },
  summary: "Accounts first.",
};

const problemsOf = (result: { ok: boolean; error?: { details: Record<string, unknown> } }) =>
  result.ok ? undefined : result.error?.details.problems;

describe("a draft naming the checkpoint of the same write", () => {
  const draft = {
    type: "sprint.planned",
    actor: { kind: "agent" as const, agent: "izzy" },
    product: "01JZ0000000000000000000000",
    provenance: "trusted" as const,
    payload: {
      goal: "Sign up",
      stories: [{ id: "1-1", owner: "sam", budget_usd: 1 }],
      capacity: { agents: ["sam"], humans: 0 },
      budget_usd: 1,
    },
    checkpointField: "checkpoint",
  };

  it("is refused unless a checkpoint.opened comes right before it", async () => {
    const journal = new MemoryStateStore({ keys: new MemoryKeyStore(SEED) });
    await expect(journal.appendAll([draft])).rejects.toMatchObject({
      code: ErrorCode.EVENT_INVALID,
      details: { field: "checkpointField" },
    });
    expect(journal.events).toEqual([]);
  });

  it("is limited to the checkpoint field of a sprint", async () => {
    const journal = new MemoryStateStore({ keys: new MemoryKeyStore(SEED) });
    const opened = {
      type: "checkpoint.opened",
      actor: { kind: "agent" as const, agent: "izzy" },
      product: draft.product,
      provenance: "trusted" as const,
      payload: {
        type: "document",
        risk: "low",
        irreversible: false,
        recipient_role: "product",
        confirmation: ["gesture_undo_10s"],
        title: "Sprint",
        summary: "Read it.",
        documents: [],
        blocks: [],
      },
    };
    await expect(
      journal.appendAll([opened, { ...draft, checkpointField: "goal" }]),
    ).rejects.toMatchObject({ code: ErrorCode.EVENT_INVALID });
    await expect(
      journal.appendAll([
        opened,
        {
          ...opened,
          type: "agent.status_reported",
          payload: { status: "working" },
          checkpointField: "checkpoint",
        },
      ]),
    ).rejects.toMatchObject({ code: ErrorCode.EVENT_INVALID });
    expect(journal.events).toEqual([]);
    const written = await journal.appendAll([opened, draft]);
    expect(written[1]?.payload?.checkpoint).toBe(`G-${written[0]?.id.slice(-10)}`);
  });
});

describe("plan_sprint", () => {
  it("refuses stories never validated, then records a valid sprint with its checkpoint", async () => {
    const { journal, call, validate } = await product();
    const before = journal.events.length;
    const early = await call("plan_sprint", SPRINT);
    expect(early.ok ? undefined : early.error).toMatchObject({
      code: ErrorCode.SPRINT_INVALID,
      message_key: "error.sprint_invalid.other",
      details: { count: 2, first: "not_validated 1-1 (never)" },
    });
    expect(problemsOf(early)).toEqual([
      { reason: "not_validated", story: "1-1", why: "never" },
      { reason: "not_validated", story: "1-2", why: "never" },
    ]);
    expect(journal.events.length).toBe(before);

    await validate();
    const reversed = await call("plan_sprint", { ...SPRINT, stories: ["1-2", "1-1"] });
    expect(reversed.ok ? undefined : reversed.error).toMatchObject({
      message_key: "error.sprint_invalid.one",
      details: {
        count: 1,
        first: "dependency_later 1-2 1-1",
        problems: [{ reason: "dependency_later", story: "1-2", dependency: "1-1" }],
      },
    });
    const over = await call("plan_sprint", { ...SPRINT, budget_limit_usd: 5 });
    expect(over.ok ? undefined : over.error.details).toMatchObject({
      first: "over_budget: total $5.50 above $5.00",
      problems: [{ reason: "over_budget", budget_usd: 5.5, limit: 5 }],
    });

    const written = journal.events.length;
    const result = await call("plan_sprint", { ...SPRINT, budget_limit_usd: 10 });
    expect(result.ok).toBe(true);
    const recorded = (result as { value: RecordedEvent }).value;
    const [opening, planned] = journal.events.slice(written);
    expect(journal.events.length).toBe(written + 2);
    expect(opening?.type).toBe("checkpoint.opened");
    expect(planned?.type).toBe("sprint.planned");
    expect(recorded).toMatchObject({
      id: planned?.id,
      type: "sprint.planned",
      sprint: `S-${planned?.id.slice(-10)}`,
      checkpoint: `G-${opening?.id.slice(-10)}`,
    });
    // The sprint records each story's owner and budget, and the checkpoint of its own write.
    expect(planned?.payload).toEqual({
      goal: "Sign up and sign in",
      stories: [
        { id: "1-1", owner: "sam", budget_usd: 3.5 },
        { id: "1-2", owner: "sam", budget_usd: 2 },
      ],
      capacity: { agents: ["sam"], humans: 0 },
      budget_usd: 5.5,
      budget_limit_usd: 10,
      checkpoint: recorded.checkpoint,
    });
    expect(opening?.payload).toMatchObject({
      type: "document",
      risk: "medium",
      title: "Sprint: Sign up and sign in",
      documents: [],
      blocks: [],
    });
    expect(opening?.payload?.summary).toBe(
      [
        "Accounts first.",
        "",
        "Stories, in order:",
        "1. 1-1 (sam, $3.50)",
        "2. 1-2 (sam, $2.00)",
        "",
        "Total estimate: $5.50 (ceiling $10.00)",
        "These amounts are estimates (not costs) in US dollars at the API's public prices, from the product's finished stories or the method's reference.",
        "Capacity: agents sam; humans 0",
      ].join("\n"),
    );
    const projection = await computeProjection(journal.events);
    expect(projection.ignored).toEqual([]);
    expect(Object.keys(projection.state.sprints as object)).toEqual([recorded.sprint]);
  });

  it("refuses a story changed since its validation, or one docs check refuses", async () => {
    const { files, call, validate, path } = await product();
    await validate();
    files.seed(path("1-1-sign-up"), storyFile("1-1", "ethan", 3.5));
    expect(problemsOf(await call("plan_sprint", { ...SPRINT, stories: ["1-1"] }))).toEqual([
      { reason: "not_validated", story: "1-1", why: "changed" },
      { reason: "owner_unavailable", story: "1-1", agent: "ethan" },
    ]);
    // A dependency on itself: `docs check` refuses it, so does plan_sprint.
    files.seed(path("1-3-profile"), storyFile("1-3", "ethan", 1, ["1-3"]));
    expect(
      problemsOf(
        await call("plan_sprint", {
          ...SPRINT,
          stories: ["1-3"],
          capacity: { agents: ["ethan"], humans: 0 },
        }),
      ),
    ).toEqual([{ reason: "invalid_story", story: "1-3", why: "STORY_DEPENDENCY_CYCLE" }]);
  });

  it("accepts a story whose dependency is done, and refuses a done one", async () => {
    const { call, run, answer, validate, finish } = await product();
    await validate();
    await finish("1-1");
    expect(problemsOf(await call("plan_sprint", { ...SPRINT, stories: ["1-1"] }))).toEqual([
      { reason: "done", story: "1-1" },
    ]);
    const recorded = await run("plan_sprint", { ...SPRINT, stories: ["1-2"] });
    await answer(recorded.checkpoint);
  });

  it("is in force once the creator approves it: next follows its order, get_state shows it", async () => {
    const { run, call, answer, next, state, validate } = await product();
    await validate();
    expect(await next()).toMatchObject({ step: "sprint_planning", agent: "izzy", sprint: null });
    const recorded = await run("plan_sprint", SPRINT);
    expect(await next()).toMatchObject({
      step: "validation",
      you: true,
      checkpoint: recorded.checkpoint,
      command: `npx agentplugged review ${recorded.checkpoint}`,
    });
    expect((await state()).sprint.latest).toMatchObject({
      id: recorded.sprint,
      status: "proposed",
    });
    // One proposal at a time.
    const again = await call("plan_sprint", SPRINT);
    expect(problemsOf(again)).toEqual([
      { reason: "proposal_open", checkpoint: recorded.checkpoint },
    ]);

    await answer(recorded.checkpoint);
    expect(await next()).toMatchObject({
      step: "build",
      agent: "sam",
      story: "1-1",
      sprint: { id: recorded.sprint, goal: "Sign up and sign in", done: 0, total: 2 },
    });
    const view = await state();
    expect(view.sprint.current).toMatchObject({
      id: recorded.sprint,
      status: "in_force",
      checkpoint: recorded.checkpoint,
      planned_by: "izzy",
      budget_usd: 5.5,
      budget_limit_usd: null,
      stories: [
        { id: "1-1", owner: "sam", budget_usd: 3.5, status: "todo" },
        { id: "1-2", owner: "sam", budget_usd: 2, status: "todo" },
      ],
    });
  });

  it("gives each story to its recorded owner: an agent other than the first, or the creator", async () => {
    const { run, answer, next, validate, finish } = await product();
    await validate();
    const recorded = await run("plan_sprint", {
      ...SPRINT,
      stories: ["1-3", "1-4"],
      capacity: { agents: ["ethan"], humans: 1 },
    });
    await answer(recorded.checkpoint);
    expect(await next()).toMatchObject({ step: "build", agent: "ethan", story: "1-3" });
    await finish("1-3", "ethan");
    expect(await next()).toMatchObject({ step: "build", you: true, agent: null, story: "1-4" });
  });

  it("goes back to Izzy when the creator asks for changes, and takes a new proposal", async () => {
    const { run, answer, next, validate } = await product();
    await validate();
    const first = await run("plan_sprint", SPRINT);
    await answer(first.checkpoint, "changes_requested", "Sign in only.");
    expect(await next()).toMatchObject({
      step: "changes_requested",
      agent: "izzy",
      checkpoint: first.checkpoint,
    });
    const second = await run("plan_sprint", { ...SPRINT, stories: ["1-1"] });
    await answer(second.checkpoint);
    expect(await next()).toMatchObject({
      step: "build",
      story: "1-1",
      sprint: { id: second.sprint, total: 1 },
    });
  });

  it("refuses a waiver on a sprint checkpoint, naming why", async () => {
    const { run, answer, validate } = await product();
    await validate();
    const recorded = await run("plan_sprint", SPRINT);
    await expect(answer(recorded.checkpoint, "waived")).rejects.toThrow("INVALID_ARGUMENTS");
  });
});
