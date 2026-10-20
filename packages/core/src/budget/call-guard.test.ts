import { gitBlobId, toBase64url, utf8 } from "@agentplugged/crypto";
import { SoftwareAuthenticator } from "@agentplugged/crypto/webauthn-software";
import { describe, expect, it } from "vitest";
import {
  budgetSettings,
  type CommandContext,
  createCommandRegistry,
  DEFAULT_RULES,
  forgetCallCosts,
  initCommand,
  MemoryKeyStore,
  MemoryStateStore,
  MemoryUsageTraces,
  OWN_TOOL_PREFIX,
  type RecordedEvent,
  resolveProfile,
  syncCommand,
  type ToolProbe,
  type TraceFile,
  workingCopyProductRoot,
} from "../index.js";
import { CALL_HOOK_MATCHER, claudeTrustHooks, hookValue } from "../sync/trust-hooks.js";
import {
  MemoryFiles,
  SHIPPED_IRIS,
  SHIPPED_IRIS_AGENT,
  shippedMethod,
} from "../testing/memory-files.js";
import budgetRules from "./budget-rules.ts?raw";
import budgetSettingsSource from "./budget-settings.ts?raw";
import callCommand from "./call-command.ts?raw";
import callCost from "./call-cost.ts?raw";
import callRules from "./call-rules.ts?raw";

/**
 * The guard before every tool call, end to end: the hook `sync` writes for Claude Code, fed with
 * the input Claude Code gives a hook, reaches the engine's `check_call`, which reads what a story
 * has cost (the engine's own measure) and refuses the nearest call after its ceiling, or a call a
 * pause holds, and lets every other through. No AI is called: the traces are written here.
 */

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

// Core has no platform types: the timer the slow reading of a test needs is declared here.
declare function setTimeout(handler: () => void, ms: number): unknown;

const SEED = toBase64url(new Uint8Array(32).fill(7));
const ROOT = "/work/shop";
const WORKTREE = "/work/shop.worktrees/1-1";
const COMMIT = "c".repeat(40);
const START = Date.UTC(2026, 9, 4, 12, 0, 0);
const iso = (minutes: number) => new Date(START + minutes * 60_000).toISOString();

function shippedAgent(id: string, name: string, domain: string, phase: string) {
  return {
    [`agents/${id}/SKILL.md`]: SHIPPED_IRIS.replace("name: iris", `name: ${id}`)
      .replace("domain: product", `domain: ${domain}`)
      .replace("phase: framing", `phase: ${phase}`)
      .replace("# Iris", `# ${name}`),
    [`agents/${id}/agent.yaml`]: SHIPPED_IRIS_AGENT.replace("name: Iris", `name: ${name}`),
  };
}

const STORY = [
  "---",
  "id: 1-1",
  "kind: story",
  "owner: sam",
  "title: Story 1-1",
  "epic: epic-1",
  "reviewer: quentin",
  "requirements: [EF-1]",
  "budget_usd: 2",
  "branch: feat/1-1-work",
  "depends_on: []",
  "---",
  "# Story 1-1",
  "",
  "## Context",
  "",
  "Accounts.",
  "",
  "## Intent",
  "",
  "Ada can do 1-1.",
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

/** One answer of a model: its output size makes the cost (opus 5.5: $20 per million tokens out). */
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

/** The session of a story's agent: it ran in the story's working copy, and costs about `out` tokens out. */
const session = (out: number): TraceFile => ({
  source: "claude-code",
  id: "live-1",
  kind: "main",
  worktree: "../shop.worktrees/1-1",
  text: answer("a1", 1, out),
});

// The prices (opus 5.5, $20 per million tokens out): 5 000 out ≈ $0.18; 80 000 ≈ $1.67 (alert at 80 % of $2); 100 000 ≈ $2.07.
const LOW = 5_000;
const ALERT = 80_000;
const OVER = 100_000;

interface Options {
  readonly budgets?: string;
}

async function guarded(options: Options = {}) {
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
    projectRoot: ROOT,
  };
  const init = await initCommand.run(human, { profile: resolveProfile("new-product") });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const synced = await syncCommand.run(human, {});
  if (!synced.ok) throw new Error(`sync failed: ${synced.error.code}`);
  if (options.budgets !== undefined) {
    const config = await files.readText(".agentplugged/method.yaml");
    files.seed(".agentplugged/method.yaml", `${config.trimEnd()}\n${options.budgets}\n`);
  }
  const agent: CommandContext = {
    ...human,
    actor: "agent",
    human: undefined,
    usageTraces: traces,
  };
  const registry = createCommandRegistry();
  const run = async (name: string, input: Record<string, unknown>) => {
    const result = await registry.run(name, agent, input);
    if (!result.ok) throw new Error(`${name} failed: ${result.error.code}`);
    return result.value as RecordedEvent;
  };
  const answerPoint = async (checkpoint: string | undefined, decision: string, option?: string) => {
    const result = await registry.run("review", human, {
      action: "resolve",
      checkpoint,
      decision,
      ...(option === undefined ? {} : { option }),
    });
    if (!result.ok) throw new Error(`review failed: ${result.error.code}`);
  };
  files.seed(
    ".agentplugged/docs/prd.md",
    "---\nid: prd\nkind: prd\nowner: creator\n---\n# PRD\n\nEF-1 : Ada signs up and in.\n",
  );
  files.seed(
    ".agentplugged/epics/epic-1.md",
    "---\nid: epic-1\nkind: epic\nowner: izzy\n---\n# Epic 1\n",
  );
  const path = ".agentplugged/stories/1-1-work.md";
  files.seed(path, STORY);
  const validated = await run("open_checkpoint", {
    agent: "izzy",
    type: "document",
    risk: "medium",
    title: "Epic 1",
    summary: "The stories.",
    documents: [{ path, branch: "main", blob_sha: gitBlobId(utf8(STORY)) }],
  });
  await answerPoint(validated.checkpoint, "approved");
  const planned = await run("plan_sprint", {
    agent: "izzy",
    goal: "Accounts",
    stories: ["1-1"],
    capacity: { agents: ["sam"], humans: 0 },
    summary: "Accounts first.",
  });
  await answerPoint(planned.checkpoint, "approved");
  const productId = journal.events[0]?.product as string;
  await journal.appendAll([
    {
      type: "story.started",
      actor: { kind: "agent", agent: "sam" },
      product: productId,
      story: "1-1",
      provenance: "trusted",
      payload: {
        agent: "sam",
        branch: "feat/1-1-work",
        base: COMMIT,
        base_ref: "main",
        worktree: "../shop.worktrees/1-1",
      },
    },
  ]);
  forgetCallCosts(agent);
  const hook = claudeTrustHooks(DEFAULT_RULES).PreToolUse.find(
    (group) => group.matcher === CALL_HOOK_MATCHER,
  );
  const handler = hook?.hooks[0] as { tool: string; input: Record<string, unknown> };
  expect(handler.tool).toBe("guard");
  /** The hook run the way Claude Code runs it: its input filled from the hook's own input. */
  const check = async (
    tool: string,
    where: { cwd?: string; agent_type?: string } = {},
    context: CommandContext = agent,
  ): Promise<{
    hookSpecificOutput?: { permissionDecision: string; permissionDecisionReason: string };
  }> => {
    const given: Record<string, unknown> = {
      session_id: "live-1",
      cwd: where.cwd ?? WORKTREE,
      hook_event_name: "PreToolUse",
      tool_name: tool,
      ...(where.agent_type === undefined ? {} : { agent_type: where.agent_type }),
    };
    const filled = Object.fromEntries(
      Object.entries(handler.input).map(([key, value]) => [
        key,
        typeof value === "string"
          ? value.replace(/\$\{(\w+)\}/g, (_, name: string) => String(given[name] ?? ""))
          : value,
      ]),
    );
    expect(filled.action).toBe("call");
    const { action: _action, ...fields } = filled;
    const result = await registry.run("check_call", context, fields);
    if (!result.ok) throw new Error(`check_call failed: ${result.error.code}`);
    return result.value as never;
  };
  const events = (type: string) => journal.events.filter((event) => event.type === type);
  const bridgeWrites = async (type: string, payload: Record<string, unknown>) => {
    await journal.appendAll([
      { type, actor: { kind: "system" }, product: productId, provenance: "trusted", payload },
    ]);
  };
  return { journal, traces, agent, registry, answerPoint, check, events, bridgeWrites };
}

const denied = (answer: Awaited<ReturnType<Awaited<ReturnType<typeof guarded>>["check"]>>) =>
  answer.hookSpecificOutput?.permissionDecision === "deny";
const reasonOf = (answer: Awaited<ReturnType<Awaited<ReturnType<typeof guarded>>["check"]>>) =>
  answer.hookSpecificOutput?.permissionDecisionReason ?? "";

describe("the budget at the nearest tool call", () => {
  it("lets every call through while the story is under its alert, and writes nothing", async () => {
    const g = await guarded();
    g.traces.set([session(LOW)]);
    const before = g.journal.events.length;
    expect(await g.check("Bash")).toEqual({});
    expect(await g.check("Read")).toEqual({});
    expect(g.journal.events.length).toBe(before);
  });

  it("writes the alert once, from the engine's own measure, and lets the call through", async () => {
    const g = await guarded();
    g.traces.set([session(ALERT)]);
    expect(await g.check("Bash")).toEqual({});
    expect(await g.check("Bash")).toEqual({});
    const thresholds = g.events("budget.threshold_reached");
    expect(thresholds).toHaveLength(1);
    expect(thresholds[0]?.payload).toMatchObject({ level: "alert", budget_usd: 2 });
    expect(g.events("checkpoint.opened").filter((e) => e.story === "1-1")).toHaveLength(0);
  });

  it("refuses the nearest call after the ceiling, opens the budget checkpoint, and refuses the next ones without writing again", async () => {
    const g = await guarded();
    g.traces.set([session(OVER)]);
    const answer = await g.check("Edit");
    expect(denied(answer)).toBe(true);
    const reason = reasonOf(answer);
    expect(reason).toContain("story 1-1 reached its budget of $2.00");
    expect(reason).toContain("in one gesture");
    // One line, the cause in plain words, and never a command for the creator to type.
    expect(reason).not.toContain("\n");
    expect(reason).not.toMatch(/npx|agentplugged \w+ --/);
    // The journal holds the cost, the checkpoint and the threshold, in that order.
    const written = g.journal.events.slice(-3).map((event) => event.type);
    expect(written).toEqual(["cost.reported", "checkpoint.opened", "budget.threshold_reached"]);
    expect(g.events("budget.threshold_reached").at(-1)?.payload).toMatchObject({
      level: "exceeded",
      on_exceed: "block",
    });
    const count = g.journal.events.length;
    expect(denied(await g.check("Bash"))).toBe(true);
    expect(denied(await g.check("Read"))).toBe(true);
    expect(g.journal.events.length).toBe(count);
    // The engine's own tools pass: an agent held can still conclude.
    expect(await g.check(`${OWN_TOOL_PREFIX}story`)).toEqual({});
    // A call outside the story's working copy, and outside the product, is nobody's business.
    expect(await g.check("Bash", { cwd: ROOT })).toEqual({});
    expect(await g.check("Bash", { cwd: "/tmp/elsewhere" })).toEqual({});
  });

  it("lets the calls through again when the creator raises the ceiling, and holds them when the creator stops the story", async () => {
    const g = await guarded();
    g.traces.set([session(OVER)]);
    expect(denied(await g.check("Edit"))).toBe(true);
    const point = g.events("checkpoint.opened").at(-1)?.id;
    expect(point).toBeDefined();
    await g.answerPoint(`G-${point?.slice(-10)}`, "option_chosen", "raise-100");
    expect(await g.check("Edit")).toEqual({});
  });

  it("holds the story once the creator stopped it at its budget", async () => {
    const g = await guarded();
    g.traces.set([session(OVER)]);
    expect(denied(await g.check("Edit"))).toBe(true);
    const point = g.events("checkpoint.opened").at(-1)?.id;
    await g.answerPoint(`G-${point?.slice(-10)}`, "option_chosen", "stop");
    const answer = await g.check("Edit");
    expect(denied(answer)).toBe(true);
    expect(reasonOf(answer)).toContain("the creator stopped story 1-1 at its budget");
  });

  it("only flags the ceiling under on_exceed flag: the threshold is written, nothing is refused", async () => {
    const g = await guarded({ budgets: "budgets:\n  on_exceed: flag" });
    g.traces.set([session(OVER)]);
    expect(await g.check("Edit")).toEqual({});
    expect(g.events("budget.threshold_reached").at(-1)?.payload).toMatchObject({
      level: "exceeded",
      on_exceed: "flag",
    });
    expect(g.events("checkpoint.opened").filter((e) => e.story === "1-1")).toHaveLength(0);
    expect(await g.check("Bash")).toEqual({});
  });

  it("lets the call through in doubt: a trace that cannot be read, an input it cannot place", async () => {
    const g = await guarded();
    g.traces.set([{ ...session(OVER), text: "not json at all" }]);
    expect(await g.check("Edit")).toEqual({});
    const unreadable = await g.registry.run("check_call", g.agent, { nope: true });
    expect(unreadable.ok && unreadable.value).toEqual({});
    const empty = await g.registry.run("check_call", g.agent, { tool: "" });
    expect(empty.ok && empty.value).toEqual({});
  });

  it("lets the call through when the traces are slow to read, and refuses the next one once they were", async () => {
    const g = await guarded();
    const slow = {
      read: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 350));
        return [session(OVER)];
      },
    };
    const context = { ...g.agent, usageTraces: slow, callGuardBudgetMs: 400 };
    expect(await g.check("Edit", {}, context)).toEqual({});
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
    expect(denied(await g.check("Edit", {}, context))).toBe(true);
  });

  it("leaves a folder that is no story's working copy alone", async () => {
    const g = await guarded();
    g.traces.set([session(OVER)]);
    expect(await g.check("Edit", { cwd: "/work/shop.worktrees/9-9" })).toEqual({});
  });
});

describe("the team's pause, held while an agent writes", () => {
  it("refuses the writing tools of a story's agent, and lets reads and the engine's tools through", async () => {
    const g = await guarded();
    g.traces.set([session(LOW)]);
    await g.bridgeWrites("team.paused", { reason: "creator" });
    for (const tool of ["Write", "Edit", "Bash", "Task"]) {
      const answer = await g.check(tool);
      expect(denied(answer), tool).toBe(true);
      expect(reasonOf(answer)).toContain("paused by the creator");
      expect(reasonOf(answer)).not.toContain("\n");
    }
    expect(await g.check("Read")).toEqual({});
    expect(await g.check("Grep")).toEqual({});
    expect(await g.check(`${OWN_TOOL_PREFIX}state`)).toEqual({});
    // A sub-agent in the product's own folder is held too.
    expect(denied(await g.check("Bash", { cwd: ROOT, agent_type: "sam" }))).toBe(true);
  });

  it("keeps the main session free, except to start an agent", async () => {
    const g = await guarded();
    await g.bridgeWrites("team.paused", { reason: "emergency_stop" });
    expect(await g.check("Bash", { cwd: ROOT })).toEqual({});
    expect(await g.check("Edit", { cwd: ROOT })).toEqual({});
    const launch = await g.check("Task", { cwd: ROOT });
    expect(denied(launch)).toBe(true);
    expect(reasonOf(launch)).toContain("emergency stop");
  });

  it("lets everything go on the resume", async () => {
    const g = await guarded();
    await g.bridgeWrites("team.paused", { reason: "creator" });
    expect(denied(await g.check("Write"))).toBe(true);
    await g.bridgeWrites("team.resumed", {});
    expect(await g.check("Write")).toEqual({});
  });
});

describe("the hook and the settings", () => {
  it("reads the traces from the product's folder when the server runs in a story's working copy", () => {
    expect(workingCopyProductRoot("/work/shop.worktrees/1-1")).toBe("/work/shop");
    expect(workingCopyProductRoot("/work/shop")).toBe("/work/shop");
  });

  it("is registered before every tool but the engine's own, with a fence around the engine's delay", () => {
    const group = claudeTrustHooks(DEFAULT_RULES).PreToolUse.find(
      (candidate) => candidate.matcher === CALL_HOOK_MATCHER,
    );
    expect(group?.hooks).toHaveLength(1);
    expect(group?.hooks[0]).toMatchObject({
      type: "mcp_tool",
      server: "agentplugged",
      tool: "guard",
      input: { action: "call", tool: hookValue("tool_name"), cwd: hookValue("cwd") },
    });
    const matcher = new RegExp(CALL_HOOK_MATCHER);
    expect(matcher.test("Bash")).toBe(true);
    expect(matcher.test("mcp__github__create_issue")).toBe(true);
    expect(matcher.test(`${OWN_TOOL_PREFIX}story`)).toBe(false);
  });

  it("reads the budget settings from one entry point only", () => {
    expect(budgetSettings({})).toEqual({ alert_ratio: 0.8, on_exceed: "block" });
    expect(budgetSettings({ budgets: { alert_ratio: 0.5, on_exceed: "flag" } })).toEqual({
      alert_ratio: 0.5,
      on_exceed: "flag",
    });
    // No other module of the budget reads the configuration: a later source changes one file.
    for (const [name, text] of Object.entries({ budgetRules, callCommand, callCost, callRules })) {
      expect(text, name).not.toMatch(/\.budgets\b|method\.yaml|loadMethodConfig/);
    }
    expect(budgetSettingsSource).toContain("config.budgets");
  });
});
