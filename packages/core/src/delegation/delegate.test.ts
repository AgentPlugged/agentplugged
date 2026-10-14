import { toBase64url } from "@agentplugged/crypto";
import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type AgentStateView,
  agentCommand,
  type CommandContext,
  computeProjection,
  createCommandRegistry,
  currentDeveloper,
  type DecisionItem,
  decisionQueue,
  delegationsOf,
  initCommand,
  MemoryKeyStore,
  MemoryStateStore,
  type NextResult,
  NOAH_COMMANDS,
  type ProfileAdjustments,
  RETIRED_DEVELOPERS,
  resolveProfile,
  type ToolProbe,
} from "../index.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { ROSE_CONTENT } from "../testing/agent-content.js";
import { checkpointState } from "../testing/checkpoint-state.js";
import { fixtureAgent, fixtureSkill, MemoryFiles, shippedMethod } from "../testing/memory-files.js";

/** Iris, Noah, a few teammates and a skill: what the handovers of these tests need. */
const TEAM_METHOD = shippedMethod({
  ...fixtureAgent("noah"),
  ...fixtureAgent("maya"),
  ...fixtureAgent("izzy"),
  ...fixtureAgent("quentin", { domain: "quality" }),
  ...fixtureAgent("sam", { domain: "code", specialty: "backend", skills: ["develop-story"] }),
  ...fixtureAgent("ethan", { domain: "code", specialty: "backend", skills: ["develop-story"] }),
  ...fixtureAgent("hugo", { domain: "code", specialty: "frontend" }),
  ...fixtureAgent("jade", { domain: "code", specialty: "mobile" }),
  ...fixtureSkill("write-prd"),
  ...fixtureSkill("develop-story"),
});

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

const SEED = toBase64url(new Uint8Array(32).fill(9));

function clock() {
  let now = Date.UTC(2026, 9, 3, 12, 0, 0);
  return () => {
    now += 1000;
    return now;
  };
}

async function product(adjustments: ProfileAdjustments = {}) {
  const files = new MemoryFiles();
  const keys = new MemoryKeyStore(SEED);
  const journal = new MemoryStateStore({ keys, now: clock() });
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: TEAM_METHOD,
    actor: "human",
    engineVersion: "1.0.0",
    keys,
  };
  const init = await initCommand.run(human, {
    profile: resolveProfile("new-product", adjustments),
  });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const agent: CommandContext = { ...human, actor: "agent", journal };
  const registry = createCommandRegistry();
  const call = (name: string, input: Record<string, unknown> = {}) =>
    registry.run(name, agent, input);
  const code = async (name: string, input: Record<string, unknown> = {}) => {
    const result = await call(name, input);
    return result.ok ? "ok" : result.error.code;
  };
  const state = async () => {
    const result = await call("get_state", { full: true });
    if (!result.ok) throw new Error(`get_state failed: ${result.error.code}`);
    return result.value as AgentStateView;
  };
  /** A story started by a developer, as `start_story` records it. */
  const started = async (story: string, by: string) => {
    const config = files.files.get(".agentplugged/method.yaml") ?? "";
    const product_id = /product_id: "?([0-9A-Z]{26})/.exec(config)?.[1] ?? "";
    await journal.appendAll([
      {
        type: "story.started",
        actor: { kind: "agent", agent: by },
        product: product_id,
        story,
        provenance: "trusted",
        payload: {
          agent: by,
          branch: `feat/${story}-work`,
          base: "a".repeat(40),
          base_ref: "main",
          worktree: `../product.worktrees/${story}`,
        },
      },
    ]);
  };
  return { files, journal, human, agent, registry, call, code, state, started };
}

const HANDOVER = { agent: "noah", to: "iris", mode: "conversation", brief: "Frame Libère." };

describe("delegate", () => {
  it("Noah waits while the work is out and works again when he reports it", async () => {
    const { call, state } = await product();
    expect((await call("report_status", { agent: "noah", status: "working" })).ok).toBe(true);
    expect((await state()).agents.noah?.status).toBe("working");
    expect((await call("delegate", HANDOVER)).ok).toBe(true);
    expect((await state()).agents.noah?.status).toBe("waiting");
    // A refused handover changes nothing.
    expect((await call("report_status", { agent: "noah", status: "working" })).ok).toBe(true);
    expect((await call("delegate", { ...HANDOVER, to: "zorro" })).ok).toBe(false);
    expect((await state()).agents.noah?.status).toBe("working");
    // A blocked Noah stays blocked, and the old task does not outlive the handover.
    expect(
      (await call("report_status", { agent: "noah", status: "blocked", task: "old" })).ok,
    ).toBe(true);
    expect((await call("delegate", HANDOVER)).ok).toBe(true);
    expect((await state()).agents.noah).toMatchObject({ status: "blocked", task: null });
    expect((await call("report_status", { agent: "noah", status: "working" })).ok).toBe(true);
    expect((await call("delegate", HANDOVER)).ok).toBe(true);
    // Another agent's own status never moves Noah's.
    expect((await call("delegate", HANDOVER)).ok).toBe(true);
    expect((await call("report_status", { agent: "iris", status: "working" })).ok).toBe(true);
    expect((await state()).agents.noah?.status).toBe("waiting");
  });

  it("records Noah's handover, shown by get_state", async () => {
    const { call, journal, state } = await product();
    // The journal needs its product first: Noah reports, then hands over.
    expect((await call("report_status", { agent: "noah", status: "working" })).ok).toBe(true);
    const result = await call("delegate", HANDOVER);
    expect(result.ok).toBe(true);
    const event = journal.events.at(-1);
    expect(event?.type).toBe("agent.delegated");
    expect(event?.actor).toMatchObject({ kind: "agent", agent: "noah" });
    expect(event?.payload).toEqual({
      to: "iris",
      kind: "agent",
      mode: "conversation",
      brief: "Frame Libère.",
    });
    const projection = await computeProjection(journal.events);
    expect(projection.ignored).toEqual([]);
    expect((await state()).delegations).toEqual([
      expect.objectContaining({ from: "noah", to: "iris", mode: "conversation", story: null }),
    ]);
  });

  it("hands work to a skill no agent owns, in the conversation, and a story to a developer", async () => {
    const { call, journal, state } = await product();
    const skill = await call("delegate", { ...HANDOVER, to: "write-prd" });
    expect(skill.ok).toBe(true);
    expect(journal.events.at(-1)?.payload).toMatchObject({ to: "write-prd", kind: "skill" });
    // A skill has no sub-agent; one an agent owns goes to that agent (a developer's, with its story).
    const alone = await call("delegate", { ...HANDOVER, to: "write-prd", mode: "autonomous" });
    expect(alone.ok ? undefined : alone.error.details.reason).toBe("skill_autonomous");
    const owned = await call("delegate", { ...HANDOVER, to: "develop-story", story: "4-2" });
    expect(owned.ok ? undefined : owned.error.details).toMatchObject({
      reason: "skill_has_owner",
      owner: expect.stringMatching(/^(sam|ethan)$/),
    });
    // The handovers keep where their session stood.
    expect((await state()).delegations[0]?.provenance).toBe("untrusted");
    const story = await call("delegate", {
      ...HANDOVER,
      to: "sam",
      mode: "autonomous",
      story: "4-2",
    });
    expect(story.ok).toBe(true);
    expect(journal.events.at(-1)?.story).toBe("4-2");
    // Two stories may go to the same developer: one instance per story.
    const second = await call("delegate", {
      ...HANDOVER,
      to: "sam",
      mode: "autonomous",
      story: "4-5",
    });
    expect(second.ok).toBe(true);
  });

  it("is Noah's only: another agent or the main session is refused, nothing written", async () => {
    const { call, journal } = await product();
    for (const agent of ["iris", "izzy", "main"]) {
      const result = await call("delegate", { ...HANDOVER, agent, to: "maya" });
      expect(result.ok ? undefined : result.error.code, agent).toBe(ErrorCode.ROLE_FORBIDDEN);
    }
    expect(journal.events).toEqual([]);
  });

  it.each([
    ["zorro", "unknown_target"],
    ["main", "unknown_target"],
    ["noah", "self"],
    // Jade's specialty (mobile) is off in the new-product profile.
    ["jade", "inactive_target"],
  ])("refuses a handover to %s (%s)", async (to, reason) => {
    const { call, journal } = await product();
    const result = await call("delegate", { ...HANDOVER, to, story: "4-1" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.DELEGATION_INVALID);
    expect(result.error.details).toMatchObject({ to, reason });
    expect(journal.events).toEqual([]);
  });

  it("sends a developer with its story only", async () => {
    const { call } = await product();
    const result = await call("delegate", { ...HANDOVER, to: "hugo", mode: "autonomous" });
    expect(result.ok ? undefined : result.error.details.reason).toBe("story_required");
  });

  it("never gives a story to a second developer", async () => {
    const { call, started } = await product();
    await started("4-2", "ethan");
    const taken = await call("delegate", { ...HANDOVER, to: "sam", story: "4-2" });
    expect(taken.ok ? undefined : taken.error.details).toMatchObject({
      reason: "story_taken",
      agent: "ethan",
    });
    // Its own developer takes it up again.
    expect((await call("delegate", { ...HANDOVER, to: "ethan", story: "4-2" })).ok).toBe(true);
    // A reviewer is no developer: the story may go to Quentin.
    expect((await call("delegate", { ...HANDOVER, to: "quentin", story: "4-2" })).ok).toBe(true);
  });

  it("names the developer who builds a story now, a retired one's successor", async () => {
    const { call, started } = await product();
    // The retired developer Ethan took over, read from the alias table.
    const retired = RETIRED_DEVELOPERS.find((id) => currentDeveloper(id) === "ethan") as string;
    await started("4-4", retired);
    const taken = await call("delegate", { ...HANDOVER, to: "sam", story: "4-4" });
    expect(taken.ok ? undefined : taken.error.details).toMatchObject({
      reason: "story_taken",
      agent: "ethan",
    });
    expect((await call("delegate", { ...HANDOVER, to: "ethan", story: "4-4" })).ok).toBe(true);
  });

  it("keeps to the profile's ceiling of stories built at once", async () => {
    const { call, started } = await product({ max_parallel_stories: 1 });
    await started("4-1", "ethan");
    const full = await call("delegate", { ...HANDOVER, to: "hugo", story: "4-3" });
    expect(full.ok ? undefined : full.error.details).toMatchObject({
      reason: "parallel_limit",
      limit: 1,
      building: "4-1",
    });
  });

  it("refuses an invalid input", async () => {
    const { call } = await product();
    for (const input of [
      { ...HANDOVER, mode: "background" },
      { ...HANDOVER, brief: "" },
      { ...HANDOVER, brief: "   " },
      { ...HANDOVER, brief: "Frame it\u001b[2J" },
      { ...HANDOVER, story: "4.2" },
      { ...HANDOVER, actor: "human" },
    ]) {
      const result = await call("delegate", input);
      expect(result.ok ? undefined : result.error.code).toBe(ErrorCode.INVALID_ARGUMENTS);
    }
    // Line breaks and tabs are a brief's own.
    expect((await call("delegate", { ...HANDOVER, brief: "Frame it:\n\t- the problem" })).ok).toBe(
      true,
    );
  });

  it("projects Noah's handovers only, the latest ones", async () => {
    const { call, journal, files } = await product();
    expect((await call("delegate", HANDOVER)).ok).toBe(true);
    const config = files.files.get(".agentplugged/method.yaml") ?? "";
    const product_id = /product_id: "?([0-9A-Z]{26})/.exec(config)?.[1] ?? "";
    await journal.appendAll([
      {
        type: "agent.delegated",
        actor: { kind: "agent", agent: "iris" },
        product: product_id,
        provenance: "trusted",
        payload: { to: "maya", kind: "agent", mode: "conversation", brief: "Take it." },
      },
    ]);
    const projection = await computeProjection(journal.events);
    expect(projection.ignored).toEqual([{ id: journal.events.at(-1)?.id, reason: "invalid" }]);
    expect(delegationsOf(projection.state).map((entry) => entry.from)).toEqual(["noah"]);
  });
});

describe("Noah's contract with the engine", () => {
  it("lets Noah read, report his status, hand over and answer, nothing else", async () => {
    const { call, code, journal, registry } = await product();
    expect(await code("report_status", { agent: "noah", status: "working" })).toBe("ok");
    expect(await code("get_state")).toBe("ok");
    expect(await code("next")).toBe("ok");
    const before = journal.events.length;
    const attempts: Record<string, Record<string, unknown>> = {
      open_checkpoint: {
        agent: "noah",
        type: "phase_end",
        phase: "framing",
        risk: "medium",
        title: "End of framing",
        summary: "Approve the brief.",
        blocks: [],
      },
      submit_result: {
        agent: "noah",
        status: "complete",
        summary: "Done.",
        assumptions: [],
        open_questions: [],
        conflicts: [],
      },
      report_progress: { agent: "noah", story: "4-1", note: "Half way." },
      report_cost: { agent: "noah", usd: 1, estimated: true },
      update_story: { agent: "noah", story: "4-1", status: "in_progress" },
      start_story: { agent: "noah", story: "4-1" },
      plan_sprint: { agent: "noah" },
      defer_work: { agent: "noah" },
      write_sensitive: { agent: "noah", area: "memory", path: "x.md", content: "x" },
      report_deviation: { agent: "noah" },
      open_pull_request: { agent: "noah", story: "4-1" },
      request_action: { agent: "noah" },
    };
    for (const [name, input] of Object.entries(attempts)) {
      const result = await call(name, input);
      expect(result.ok ? undefined : result.error.code, name).toBe(ErrorCode.ROLE_FORBIDDEN);
      expect(result.ok ? undefined : result.error.details, name).toEqual({
        agent: "noah",
        command: name,
      });
      // Whatever the spelling of his id.
      const spelled = await call(name, { ...input, agent: " NOAH " });
      expect(spelled.ok ? undefined : spelled.error.code, name).toBe(ErrorCode.ROLE_FORBIDDEN);
    }
    // Every agent tool outside his contract is refused to him, before its input is even read.
    for (const command of registry.agentCommands()) {
      if (NOAH_COMMANDS.has(command.name)) continue;
      const result = await call(command.name, { agent: "noah" });
      expect(result.ok ? undefined : result.error.code, command.name).toBe(
        ErrorCode.ROLE_FORBIDDEN,
      );
    }
    expect(journal.events.length).toBe(before);
  });

  it("lets Noah ask the creator to create a specialised agent, never create it himself", async () => {
    const { call, code, state } = await product();
    const asked = await call("request_creator_action", {
      agent: "noah",
      action: {
        kind: "agent_create",
        id: "seo-scout",
        name: "Scout",
        title: "SEO Scout",
        description: "Audits the search ranking of the product's pages.",
        domain: "marketing",
        phase: "launch",
        content: ROSE_CONTENT,
      },
      reason: "The creator agreed to the job description.",
    });
    expect(asked.ok ? undefined : asked.error.code).toBeUndefined();
    const opened = Object.values((await state()).checkpoints);
    expect(opened).toEqual([expect.objectContaining({ type: "creator_action", status: "open" })]);
    // The terminal command stays the creator's: refused to Noah's shell by `sync`, and the
    // engine never runs `agent` for an agent.
    expect(await code("agent", { action: "create", id: "seo-scout" })).toBe(
      ErrorCode.UNKNOWN_COMMAND,
    );
  });

  it("holds the main session to Noah's contract under `main` while Noah is active", async () => {
    const { call, code, journal } = await product();
    const before = journal.events.length;
    const opened = await call("open_checkpoint", {
      agent: "main",
      type: "phase_end",
      phase: "framing",
      risk: "medium",
      title: "End of framing",
      summary: "Approve the brief.",
      blocks: [],
    });
    expect(opened.ok ? undefined : opened.error).toMatchObject({
      code: ErrorCode.ROLE_FORBIDDEN,
      message_key: "error.role_forbidden.main_session",
      details: { agent: "main", command: "open_checkpoint" },
    });
    expect(await code("start_story", { agent: " Main ", story: "4-1" })).toBe(
      ErrorCode.ROLE_FORBIDDEN,
    );
    expect(journal.events.length).toBe(before);
    // His own tools stay open to `main`.
    expect(await code("report_status", { agent: "main", status: "working" })).toBe("ok");
  });

  it("refuses Noah once the creator disabled him, and frees `main` again", async () => {
    const { human, code } = await product();
    const disabled = await agentCommand.run(human, { action: "disable", id: "noah" });
    expect(disabled.ok).toBe(true);
    expect(await code("report_status", { agent: "noah", status: "working" })).toBe(
      ErrorCode.AGENT_NOT_FOUND,
    );
    expect(await code("delegate", HANDOVER)).toBe(ErrorCode.AGENT_NOT_FOUND);
    // Without Noah, the main session works under `main` as before.
    const opened = await code("open_checkpoint", {
      agent: "main",
      type: "decision",
      risk: "low",
      title: "Pick a name",
      summary: "Which name?",
      blocks: [],
      options: [
        { id: "a", label: "A", consequence: "First." },
        { id: "b", label: "B", consequence: "Second." },
      ],
      recommendation: "a",
    });
    expect(opened).toBe("ok");
  });
});

describe("next for the agents", () => {
  it("exists for the creator and for the agents, each run by its own actor", async () => {
    const { registry, human } = await product();
    expect(registry.names()).toContain("next");
    expect(registry.agentCommands().map((command) => command.name)).toContain("next");
    const byHuman = await registry.run("next", human, {});
    expect(byHuman.ok).toBe(true);
  });

  it("refuses an input, and lists the decisions by risk, blocks, then age", async () => {
    const { call, code } = await product();
    expect(await code("next", { verbose: true })).toBe(ErrorCode.INVALID_ARGUMENTS);
    const open = async (risk: string, title: string, blocks: unknown[] = []) => {
      const result = await call("open_checkpoint", {
        agent: "iris",
        type: "decision",
        risk,
        title,
        summary: `${title}?`,
        blocks,
        options: [
          { id: "a", label: "A", consequence: "First." },
          { id: "b", label: "B", consequence: "Second." },
        ],
        recommendation: "a",
      });
      if (!result.ok) throw new Error(`${title}: ${result.error.code}`);
    };
    await open("low", "Old low");
    await open("medium", "Medium free");
    await open("high", "High");
    await open("medium", "Medium blocking", [{ action: "story.review", story: "2-1" }]);
    await open("low", "New low");
    const result = await call("next");
    expect(result.ok).toBe(true);
    const decisions = (result as { value: NextResult }).value.decisions as DecisionItem[];
    expect(decisions.map((decision) => decision.title)).toEqual([
      "High",
      "Medium blocking",
      "Medium free",
      "Old low",
      "New low",
    ]);
    expect(decisions[0]).toMatchObject({
      type: "decision",
      risk: "high",
      recommendation: "a",
      answer: "chat",
    });
    expect(decisions[1]?.blocks).toBe(1);
  });
});

describe("decisionQueue", () => {
  const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
  const projection = (checkpoints: CheckpointState[]) => ({
    checkpoints: Object.fromEntries(checkpoints.map((checkpoint) => [checkpoint.id, checkpoint])),
  });

  it("leaves out what the creator answered, and says where a decision is answered", () => {
    const queue = decisionQueue(
      projection([
        checkpointState("G-0000000001", { risk: "high" }),
        checkpointState("G-0000000002", { status: "resolved" }),
        checkpointState("G-0000000003", { source: "untrusted_action", risk: "medium" }),
        checkpointState("G-0000000004", { risk: "low" }),
      ]),
      NOW,
      "strict",
    );
    // Only a high risk at the strict level goes to the terminal.
    expect(queue.map((item) => [item.id, item.answer])).toEqual([
      ["G-0000000001", "terminal"],
      ["G-0000000003", "chat"],
      ["G-0000000004", "chat"],
    ]);
    expect(
      decisionQueue(projection([checkpointState("G-0000000001", { risk: "high" })]), NOW),
    ).toMatchObject([{ answer: "chat", recommendation: null, blocks: 0 }]);
  });

  it("keeps the opening order between two decisions alike", () => {
    const queue = decisionQueue(
      projection([checkpointState("G-0000000009"), checkpointState("G-0000000005")]),
      NOW,
    );
    expect(queue.map((item) => item.id)).toEqual(["G-0000000005", "G-0000000009"]);
  });
});
