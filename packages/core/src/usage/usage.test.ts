import { gitBlobId, toBase64url, utf8 } from "@agentplugged/crypto";
import { SoftwareAuthenticator } from "@agentplugged/crypto/webauthn-software";
import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type AgentStateView,
  type CommandContext,
  createCommandRegistry,
  initCommand,
  MemoryKeyStore,
  MemoryStateStore,
  MemoryUsageTraces,
  type RecordedEvent,
  resolveProfile,
  syncCommand,
  type ToolProbe,
  type TraceFile,
} from "../index.js";
import { writeTools } from "../init/method-config.js";
import type { EventDraft } from "../journal/state-store.js";
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

const SEED = toBase64url(new Uint8Array(32).fill(9));

function shippedAgent(id: string, name: string, domain: string, phase: string) {
  return {
    [`agents/${id}/SKILL.md`]: SHIPPED_IRIS.replace("name: iris", `name: ${id}`)
      .replace("domain: product", `domain: ${domain}`)
      .replace("phase: framing", `phase: ${phase}`)
      .replace("# Iris", `# ${name}`),
    [`agents/${id}/agent.yaml`]: SHIPPED_IRIS_AGENT.replace("name: Iris", `name: ${name}`),
  };
}

function storyFile(id: string, owner: string, budget: number) {
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
    "depends_on: []",
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

type StorySpec = readonly [name: string, id: string, owner: string, budget: number];

/** The journal's clock starts here and moves one second per read. */
const START = Date.UTC(2026, 9, 4, 12, 0, 0);
const iso = (minutes: number) => new Date(START + minutes * 60_000).toISOString();

const answer = (id: string, minutes: number, out: number) =>
  JSON.stringify({
    type: "assistant",
    timestamp: iso(minutes),
    message: {
      id,
      model: "claude-opus-5-5",
      usage: {
        input_tokens: 1000,
        output_tokens: out,
        cache_read_input_tokens: 100_000,
        cache_creation_input_tokens: 10_000,
        cache_creation: { ephemeral_1h_input_tokens: 0 },
      },
    },
  });

/** A session of an agent: two answers from `from` to `to` minutes after the start. */
function subTrace(
  id: string,
  agent: string,
  description: string,
  from: number,
  to: number,
  out = 20_000,
): TraceFile {
  return {
    source: "claude-code",
    id,
    kind: "sub",
    agent_type: agent,
    description,
    text: [answer(`${id}1`, from, out), answer(`${id}2`, to, out)].join("\n"),
  };
}

async function product(stories: readonly StorySpec[] = [["1-1-sign-up", "1-1", "sam", 10]]) {
  const files = new MemoryFiles();
  let clock = START;
  const now = () => {
    clock += 1000;
    return clock;
  };
  const keys = new MemoryKeyStore(SEED);
  const journal = new MemoryStateStore({ keys, now });
  const traces = new MemoryUsageTraces();
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod({
      ...shippedAgent("izzy", "Izzy", "product", "build"),
      ...shippedAgent("sam", "Sam", "code", "build"),
    }),
    actor: "human",
    engineVersion: "1.0.0",
    journal,
    now,
    interactive: true,
    keys,
    human: { keys, presence: new SoftwareAuthenticator({ available: false }) },
  };
  const init = await initCommand.run(human, { profile: resolveProfile("new-product") });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const synced = await syncCommand.run(human, {});
  if (!synced.ok) throw new Error(`sync failed: ${synced.error.code}`);
  const config = await files.readText(".agentplugged/method.yaml");
  const agent: CommandContext = {
    ...human,
    actor: "agent",
    human: undefined,
    usageTraces: traces,
  };
  const registry = createCommandRegistry();
  const call = (name: string, input: Record<string, unknown>, context: CommandContext = agent) =>
    registry.run(name, context, input);
  const run = async (name: string, input: Record<string, unknown>) => {
    const result = await call(name, input);
    if (!result.ok) throw new Error(`${name} failed: ${result.error.code}`);
    return result.value as RecordedEvent;
  };
  const answerPoint = async (checkpoint: string | undefined, decision: string) => {
    const result = await registry.run("review", human, {
      action: "resolve",
      checkpoint,
      decision,
    });
    if (!result.ok) throw new Error(`review failed: ${result.error.code}`);
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
  for (const [name, id, owner, budget] of stories)
    files.seed(path(name), storyFile(id, owner, budget));
  const validated = await run("open_checkpoint", {
    agent: "izzy",
    type: "document",
    risk: "medium",
    title: "Epic 1",
    summary: "The stories.",
    documents: await Promise.all(
      stories.map(async ([name]) => ({
        path: path(name),
        branch: "main",
        blob_sha: gitBlobId(utf8(await files.readText(path(name)))),
      })),
    ),
  });
  await answerPoint(validated.checkpoint, "approved");
  const plan = (ids: readonly string[]) =>
    call("plan_sprint", {
      agent: "izzy",
      goal: "Accounts",
      stories: ids,
      capacity: { agents: ["sam"], humans: 0 },
      summary: "Accounts first.",
    });
  const state = async (context: CommandContext = agent) => {
    const result = await registry.run("get_state", context, { full: true });
    if (!result.ok) throw new Error(`get_state failed: ${result.error.code}`);
    return result.value as AgentStateView;
  };
  const measured = () => journal.events.filter((event) => event.type === "usage.measured");
  const productId = journal.events[0]?.product as string;
  return {
    files,
    journal,
    traces,
    agent,
    human,
    call,
    run,
    answerPoint,
    plan,
    state,
    measured,
    keys,
    setConfig: (extra: string) =>
      files.seed(".agentplugged/method.yaml", `${config.trimEnd()}\n${extra}\n`),
    draft: (
      type: string,
      who: string,
      story: string,
      payload: Record<string, unknown>,
    ): EventDraft => ({
      type,
      actor: { kind: "agent", agent: who },
      product: productId,
      story,
      provenance: "trusted",
      payload,
    }),
  };
}

const usageOf = (view: AgentStateView) => view.usage;

/** What the creator may see: no key of the state holds what a story, a sprint or the product cost. */
const NEVER_SHOWN = ["tokens_out", "cache_read", "outside_stories", "gap_usd"];

describe("measure_usage", () => {
  it("measures the sessions of the tool, ties them to their story and writes them encrypted", async () => {
    const { run, plan, answerPoint, traces, measured, state, call } = await product();
    const planned = await plan(["1-1"]);
    if (!planned.ok) throw new Error(`plan failed: ${planned.error.code}`);
    await answerPoint((planned.value as RecordedEvent).checkpoint, "approved");
    await run("report_status", { agent: "sam", status: "working", story: "1-1" });
    traces.set([
      subTrace("agent-sam1", "sam", "Sam · story 1-1", -3, 10),
      {
        source: "claude-code",
        id: "conversation",
        kind: "main",
        text: [answer("c1", -5, 5000), answer("c2", 5, 5000)].join("\n"),
      },
    ]);
    const result = await call("measure_usage", { agent: "sam" });
    if (!result.ok) throw new Error(`measure failed: ${result.error.code}`);
    expect(result.value).toMatchObject({
      available: true,
      readable: true,
      read: 2,
      written: 2,
      stories: ["1-1"],
    });
    // Encrypted like a cost: the journal holds no figure in clear.
    expect(measured()).toHaveLength(2);
    for (const event of measured()) {
      expect(event.payload).toBeUndefined();
      expect(event.payload_enc).toBeDefined();
      expect(event.actor.kind).toBe("system");
    }
    // Only the story's measure carries the story: the conversation's is tied to none.
    expect(measured().filter((event) => event.story === "1-1")).toHaveLength(1);
    // The creator is shown estimates only: the measure stays in the journal.
    const usage = usageOf(await state());
    expect(Object.keys(usage).sort()).toEqual(["estimates", "table"]);
    expect(usage.table.version).toBe("2026-10-07");
    const shown = JSON.stringify(await state());
    for (const word of NEVER_SHOWN) expect(shown).not.toContain(word);
  });

  it("shows nothing of what a story really cost, not even in the story's whole detail", async () => {
    const { run, plan, answerPoint, traces, call } = await product();
    const planned = await plan(["1-1"]);
    if (!planned.ok) throw new Error("plan");
    await answerPoint((planned.value as RecordedEvent).checkpoint, "approved");
    await run("update_story", { agent: "sam", story: "1-1", status: "in_progress" });
    traces.set([subTrace("agent-sam1", "sam", "Sam · story 1-1", -3, 10)]);
    await call("measure_usage", { agent: "sam" });
    const detail = (await call("get_state", { story: "1-1" })) as {
      ok: true;
      value: Record<string, unknown>;
    };
    const text = JSON.stringify(detail);
    expect(text).not.toContain("0.948");
    expect(text).not.toContain("tokens_out");
    expect(detail.value.cost).toBeUndefined();
    expect(detail.value.budget).toBeUndefined();
    expect(detail.value.usage).toBeUndefined();
  });

  it("replaces a session measured again, never counting it twice, and writes nothing when nothing changed", async () => {
    const { run, plan, answerPoint, traces, measured, call } = await product();
    const planned = await plan(["1-1"]);
    if (!planned.ok) throw new Error("plan");
    await answerPoint((planned.value as RecordedEvent).checkpoint, "approved");
    await run("report_status", { agent: "sam", status: "working", story: "1-1" });
    traces.set([subTrace("agent-sam1", "sam", "Sam · story 1-1", -3, 10)]);
    await call("measure_usage", { agent: "sam" });
    const again = await call("measure_usage", { agent: "sam" });
    expect(again.ok && again.value).toMatchObject({ read: 1, written: 0 });
    expect(measured()).toHaveLength(1);
    // The session grows: one more measure replaces the first.
    traces.set([subTrace("agent-sam1", "sam", "Sam · story 1-1", -3, 10, 40_000)]);
    await call("measure_usage", { agent: "sam" });
    expect(measured()).toHaveLength(2);
  });

  it("measures at the end of an agent's run, without being asked", async () => {
    const { run, plan, answerPoint, traces, measured } = await product();
    const planned = await plan(["1-1"]);
    if (!planned.ok) throw new Error("plan");
    await answerPoint((planned.value as RecordedEvent).checkpoint, "approved");
    await run("report_status", { agent: "sam", status: "working", story: "1-1" });
    traces.set([subTrace("agent-sam1", "sam", "Sam · story 1-1", -3, 10)]);
    expect(measured()).toHaveLength(0);
    await run("submit_result", {
      agent: "sam",
      story: "1-1",
      status: "partial",
      summary: "Halfway.",
      assumptions: [],
      open_questions: [],
      conflicts: [],
    });
    expect(measured()).toHaveLength(1);
  });

  it("cannot be written by an agent: a forged measure is ignored", async () => {
    const { journal, draft, state } = await product();
    await journal.appendAll([
      draft("usage.measured", "sam", "1-1", {
        source: "claude-code",
        session: "forged",
        agent: "sam",
        basis: "journal",
        started_at: iso(0),
        ended_at: iso(1),
        active_ms: 1,
        models: [
          {
            model: "claude-opus-5-5",
            messages: 1,
            tokens_in: 1,
            tokens_out: 1,
            cache_read: 0,
            cache_write: 0,
            cache_write_1h: 0,
          },
        ],
      }),
    ]);
    // Nothing of it feeds the history the estimates rest on: still the method's reference.
    expect(usageOf(await state()).estimates.standard.basis).toBe("reference");
  });

  it("writes nothing and says so on a machine without the product key", async () => {
    const { traces, measured, agent, call } = await product();
    traces.set([subTrace("agent-sam1", "sam", "Sam · story 1-1", -3, 10)]);
    const result = await call("measure_usage", { agent: "sam" }, { ...agent, keys: undefined });
    expect(result.ok && result.value).toMatchObject({
      available: true,
      readable: false,
      written: 0,
    });
    expect(measured()).toHaveLength(0);
  });

  it("says when this machine has no trace to read", async () => {
    const { agent, call } = await product();
    const result = await call(
      "measure_usage",
      { agent: "sam" },
      { ...agent, usageTraces: undefined },
    );
    expect(result.ok && result.value).toMatchObject({ available: false, written: 0 });
  });

  it("keeps the larger measure when a trace comes back smaller, never lowering a measure", async () => {
    const { run, plan, answerPoint, traces, call, measured } = await product();
    const planned = await plan(["1-1"]);
    if (!planned.ok) throw new Error("plan");
    await answerPoint((planned.value as RecordedEvent).checkpoint, "approved");
    await run("report_status", { agent: "sam", status: "working", story: "1-1" });
    traces.set([subTrace("agent-sam1", "sam", "Sam · story 1-1", -3, 10, 40_000)]);
    await call("measure_usage", { agent: "sam" });
    // The same session, cut: it holds fewer tokens than what was measured.
    traces.set([subTrace("agent-sam1", "sam", "Sam · story 1-1", -3, 10, 1_000)]);
    const result = await call("measure_usage", { agent: "sam" });
    expect(result.ok && result.value).toMatchObject({ read: 1, written: 0 });
    expect(measured()).toHaveLength(1);
  });

  it("refuses an unknown agent, and counts the traces it could not read", async () => {
    const { traces, call } = await product();
    traces.set([
      subTrace("fine", "sam", "Sam", -3, 10),
      { source: "claude-code", id: "bad", kind: "sub", text: undefined as unknown as string },
    ]);
    const result = await call("measure_usage", { agent: "sam" });
    expect(result.ok && result.value).toMatchObject({ read: 1, skipped: 1, written: 1 });
    const refused = await call("measure_usage", { agent: "nobody" });
    expect(refused.ok).toBe(false);
  });

  it("refuses what its input does not allow", async () => {
    const { call } = await product();
    const result = await call("measure_usage", { agent: "sam", extra: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
  });
});

describe("no budget pauses a story any more", () => {
  it("answers a declared cost with the event only, whatever the story's estimate", async () => {
    const { run, plan, answerPoint, call } = await product();
    const planned = await plan(["1-1"]);
    if (!planned.ok) throw new Error("plan");
    await answerPoint((planned.value as RecordedEvent).checkpoint, "approved");
    await run("report_status", { agent: "sam", status: "working", story: "1-1" });
    const result = await call("report_cost", {
      agent: "sam",
      story: "1-1",
      usd: 500,
      estimated: false,
    });
    expect(result.ok).toBe(true);
    expect((result as { value?: Record<string, unknown> }).value).not.toHaveProperty("budget");
    const progress = await call("report_progress", {
      agent: "sam",
      story: "1-1",
      note: "Going on.",
    });
    expect(progress.ok).toBe(true);
  });
});

describe("the order-of-magnitude guard of plan_sprint", () => {
  const STORIES: readonly StorySpec[] = [
    ["1-1-sign-up", "1-1", "sam", 400],
    ["1-2-sign-in", "1-2", "sam", 6],
  ];

  it("refuses a story budgeted three times off the reference, naming the range", async () => {
    const { plan } = await product(STORIES);
    const result = await plan(["1-1", "1-2"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.SPRINT_INVALID);
    const problems = (
      result.error.details as {
        problems: { reason: string; story?: string; low?: number; high?: number }[];
      }
    ).problems;
    expect(problems).toEqual([
      expect.objectContaining({
        reason: "budget_out_of_range",
        story: "1-1",
        budget_usd: 400,
        low: 0.1,
        high: 42,
      }),
    ]);
  });

  it("accepts a budget within the range", async () => {
    const { plan } = await product(STORIES);
    expect((await plan(["1-2"])).ok).toBe(true);
  });

  it("rests the guard on the reference until the product has measured stories", async () => {
    const { state } = await product(STORIES);
    const estimates = usageOf(await state()).estimates;
    expect(estimates.standard.basis).toBe("reference");
    expect(estimates.guard).toEqual({ low: 0.1, high: 42, factor: 3 });
  });
});

describe("the report of what was consumed, by step and by skill", () => {
  type Report = import("./usage-report.js").UsageReport;
  const skillAnswer = (id: string, minutes: number, out: number, skill?: string) =>
    JSON.stringify({
      type: "assistant",
      timestamp: iso(minutes),
      message: {
        id,
        model: "claude-opus-5-5",
        content:
          skill === undefined
            ? []
            : [{ type: "tool_use", id: `tool-${id}`, name: "Skill", input: { skill } }],
        usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: 100 },
      },
    });

  async function reporting(measure = true) {
    const built = await product();
    if (measure) {
      const planned = await built.plan(["1-1"]);
      if (!planned.ok) throw new Error(`plan failed: ${planned.error.code}`);
      await built.answerPoint((planned.value as RecordedEvent).checkpoint, "approved");
      await built.run("report_status", { agent: "sam", status: "working", story: "1-1" });
      built.traces.set([
        {
          source: "claude-code",
          id: "agent-sam1",
          kind: "sub",
          agent_type: "sam",
          description: "Sam · story 1-1",
          text: [
            skillAnswer("x1", -3, 100),
            skillAnswer("x2", 1, 200, "develop-story"),
            skillAnswer("x3", 5, 300),
          ].join("\n"),
        },
        {
          source: "claude-code",
          id: "conversation",
          kind: "main",
          text: [skillAnswer("c1", -5, 5000), skillAnswer("c2", 5, 5000)].join("\n"),
        },
      ]);
      const done = await built.call("measure_usage", { agent: "sam" });
      if (!done.ok) throw new Error(`measure failed: ${done.error.code}`);
    }
    const registry = createCommandRegistry();
    const report = async (
      input: Record<string, unknown> = {},
      extra: Partial<CommandContext> = {},
    ) => registry.run("usage", { ...built.human, usageTraces: built.traces, ...extra }, input);
    const value = async (input: Record<string, unknown> = {}) => {
      const result = await report(input);
      if (!result.ok) throw new Error(result.error.code);
      return result.value as Report;
    };
    return { ...built, report, value };
  }

  it("says nothing was measured when nothing was, never zero", async () => {
    const { value } = await reporting(false);
    expect(await value({ axis: "skill" })).toMatchObject({
      measured: false,
      sessions: 0,
      rows: [],
    });
  });

  it("attributes tokens to the skill the tool named and to the step, and keeps the rest unattributed", async () => {
    const { value } = await reporting();
    const skills = await value({ axis: "skill" });
    expect(skills.measured).toBe(true);
    expect(skills.rows.find((row) => row.key === "develop-story")).toMatchObject({
      origin: "tool",
      tokens_out: 500,
    });
    expect(skills.rows.find((row) => row.key === null)).toMatchObject({
      origin: "unknown",
      tokens_out: 100 + 10_000,
    });
    expect(skills.rows.reduce((sum, row) => sum + row.total, 0)).toBe(skills.total.total);
    expect(skills.unattributed_share).toBeGreaterThan(0.9);
    const steps = await value({ axis: "step" });
    expect(steps.rows.find((row) => row.key === "build")).toMatchObject({ origin: "interval" });
  });

  it("filters by story and by period, and refuses what it cannot read", async () => {
    const { value, report } = await reporting();
    const story = await value({ axis: "agent", story: "1-1" });
    expect(story.rows.map((row) => row.key)).toEqual(["sam"]);
    expect(await value({ since: "2030-01-01" })).toMatchObject({ measured: false, rows: [] });
    for (const bad of [
      { axis: "money" },
      { story: "x" },
      { since: "10/10/2026" },
      { since: "2026-02-31" },
      { session: "x" },
    ]) {
      const refused = await report(bad);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
    }
  });

  it("shows no amount of money: tokens, and a story's estimate said to be one", async () => {
    const { value } = await reporting();
    const report = await value({ axis: "story" });
    expect(JSON.stringify(report)).not.toMatch(/"(usd|cost|price|real|actual|dollars?)[a-z_]*"/i);
    expect(Object.keys(report)).toContain("estimates");
  });

  it("hands an optional source what it needs", async () => {
    const asked: unknown[] = [];
    const { report } = await reporting();
    const result = await report(
      { axis: "story" },
      {
        costSource: {
          provide: (scope) => {
            asked.push(scope);
            return { low: 1, expected: 2, high: 3, source: "extension" };
          },
        },
      },
    );
    if (!result.ok) throw new Error(result.error.code);
    expect(asked).toEqual([{ stories: 1 }]);
    expect(result.value).toHaveProperty("provided");
  });

  it("names the tools it cannot measure and the ones it has not read yet", async () => {
    const { value, files } = await reporting();
    const config = writeTools(await files.readText(".agentplugged/method.yaml"), [
      "claude-code",
      "codex",
      "cursor",
    ]);
    if (typeof config !== "string") throw new Error("tools");
    files.seed(".agentplugged/method.yaml", config);
    expect((await value({ axis: "agent" })).tools).toEqual({
      unmeasurable: ["cursor"],
      unread: ["codex"],
    });
  });

  it("writes the start of a skill in the journal with the agent's status, and refuses a name that is not a skill's", async () => {
    const { run, call, journal } = await reporting(false);
    await run("report_status", { agent: "sam", status: "working", skill: "develop-story" });
    await run("report_status", { agent: "sam", status: "idle" });
    const written = journal.events.filter((item) => item.type === "agent.status_reported");
    expect(written.map((item) => (item.payload as { skill?: string }).skill)).toEqual([
      "develop-story",
      undefined,
    ]);
    const refused = await call("report_status", {
      agent: "sam",
      status: "working",
      skill: "Not A Skill!",
    });
    expect(refused.ok).toBe(false);
  });

  it("reads one session's habits in its trace, without the agent reading the conversation", async () => {
    const { value } = await reporting();
    expect(await value({ axis: "session", session: "claude-code:agent-sam1" })).toMatchObject({
      habits: {
        session: "claude-code:agent-sam1",
        found: { skills_reloaded: [], files_reread: [], tools_failing: [] },
      },
    });
  });
});
