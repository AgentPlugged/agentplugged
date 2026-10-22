import { toBase64url } from "@agentplugged/crypto";
import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type AgentStateView,
  type CheckpointState,
  type CommandContext,
  createCommandRegistry,
  initCommand,
  MemoryKeyStore,
  MemoryStateStore,
  type RecordedEvent,
  resolveProfile,
  type StateDetail,
  type ToolProbe,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";
import { STATE_MAX_CHARS, stateSize } from "./state-view.js";

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

function clock() {
  let now = Date.UTC(2026, 9, 4, 12, 0, 0);
  return () => {
    now += 1000;
    return now;
  };
}

/** A product whose agents work through the registry, as the MCP server calls it. */
async function product() {
  const files = new MemoryFiles();
  const journal = new MemoryStateStore({
    keys: new MemoryKeyStore(toBase64url(new Uint8Array(32).fill(5))),
    now: clock(),
  });
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.0.0",
  };
  const init = await initCommand.run(human, { profile: resolveProfile("new-product") });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const agent: CommandContext = { ...human, actor: "agent", journal };
  const registry = createCommandRegistry();
  const call = (name: string, input: Record<string, unknown> = {}) =>
    registry.run(name, agent, input);
  const recorded = async (name: string, input: Record<string, unknown>) => {
    const result = await call(name, input);
    if (!result.ok) throw new Error(`${name} failed: ${result.error.code}`);
    return result.value as RecordedEvent;
  };
  const read = async <T>(input: Record<string, unknown> = { full: true }) => {
    const result = await call("get_state", input);
    if (!result.ok) throw new Error(`get_state failed: ${result.error.code}`);
    return result.value as T;
  };
  return { call, recorded, read };
}

const OPTIONS = [
  { id: "stripe", label: "Stripe", consequence: "Fast to ship." },
  { id: "paddle", label: "Paddle", consequence: "Handles VAT for us." },
];

const decision = (n: number, story?: string) => ({
  agent: "iris",
  type: "decision",
  risk: "medium",
  title: `Decision ${n}`,
  summary: `Which way for ${n}? ${"A long context of the question. ".repeat(20)}`,
  ...(story === undefined ? {} : { story, blocks: [{ action: "story.review", story }] }),
  options: OPTIONS,
  recommendation: "paddle",
});

describe("get_state options through the commands", () => {
  it("answers whole on a small state: nothing cut, the open checkpoint in full", async () => {
    const { recorded, read } = await product();
    const opened = await recorded("open_checkpoint", decision(1, "2-6"));
    const view = await read<AgentStateView>();
    expect(view.truncated.map((entry) => entry.section)).toEqual([]);
    expect(view.checkpoint_counts).toEqual({
      open: 1,
      resolved: 0,
      waived: 0,
      closed: 0,
      total: 1,
    });
    const checkpoint = view.checkpoints[opened.checkpoint as string] as CheckpointState;
    expect(checkpoint.options).toEqual(OPTIONS);
    expect(checkpoint.summary.endsWith("…")).toBe(false);
  });

  it("shows at most 20 open checkpoints in full, counts the others, and reads them by page", async () => {
    const { recorded, read } = await product();
    const ids: string[] = [];
    for (let n = 1; n <= 25; n++) {
      ids.push((await recorded("open_checkpoint", decision(n))).checkpoint as string);
    }
    const view = await read<AgentStateView>();
    const open = Object.values(view.checkpoints).filter((entry) => entry.status === "open");
    expect(open).toHaveLength(20);
    // Whole: the options are there.
    expect((open[0] as CheckpointState).options).toEqual(OPTIONS);
    expect(view.truncated.find((entry) => entry.section === "checkpoints.open")).toMatchObject({
      shown: 20,
      total: 25,
      omitted: 5,
      read: { checkpoints: { status: "open" } },
    });
    expect(view.checkpoint_counts.open).toBe(25);
    expect(stateSize(view)).toBeLessThan(STATE_MAX_CHARS);

    // The newest ones are the ones the state leaves out: the page lists them, newest first.
    const page = await read<Extract<StateDetail, { detail: "checkpoints" }>>({
      checkpoints: { status: "open", limit: 10 },
    });
    expect(page.checkpoints.map((entry) => entry.id)).toEqual(ids.slice(-10).reverse());
    expect(page.total).toBe(25);
    expect(page.next_before).toBe(ids[15]);
    const last = await read<Extract<StateDetail, { detail: "checkpoints" }>>({
      checkpoints: { status: "open", limit: 30, before: ids[4] as string },
    });
    expect(last.checkpoints.map((entry) => entry.id)).toEqual(ids.slice(0, 4).reverse());
    expect(last.next_before).toBeNull();

    // One in full: the options, the summary whole.
    const whole = await read<Extract<StateDetail, { detail: "checkpoint" }>>({
      checkpoint: ids[24] as string,
    });
    expect(whole.checkpoint.options).toEqual(OPTIONS);
    expect(whole.checkpoint.summary).toBe(decision(25).summary.trim());
  });

  it("reads an agent's whole last result, which the state cuts", async () => {
    const { recorded, read } = await product();
    const summary = `Résultat ${"très long ".repeat(70)}`.trim();
    // The question waits for the creator on a point of its own.
    await recorded("open_checkpoint", decision(1));
    await recorded("submit_result", {
      agent: "iris",
      status: "partial",
      summary,
      assumptions: ["Une hypothèse"],
      open_questions: ["Quel prix ?"],
      conflicts: ["Deux cibles"],
    });
    const view = await read<AgentStateView>();
    const digest = view.agents.iris?.last_result;
    expect(digest?.summary.length).toBeLessThan(summary.length);
    expect(digest?.summary.endsWith("…")).toBe(true);
    expect(digest).toMatchObject({
      status: "partial",
      open_questions_count: 1,
      conflicts_count: 1,
    });
    expect(view.truncated.map((entry) => entry.section)).toContain("texts");
    // The open question and the conflict are in full in `open_points`.
    expect(view.open_points).toEqual([
      { kind: "question", text: "Quel prix ?", agent: "iris", story: null },
      { kind: "conflict", text: "Deux cibles", agent: "iris", story: null },
    ]);

    const detail = await read<Extract<StateDetail, { detail: "agent" }>>({ agent: "iris" });
    expect(detail.state.last_result?.summary).toBe(summary);
    expect(detail.state.last_result?.assumptions).toEqual(["Une hypothèse"]);
    expect(detail.open_points).toHaveLength(2);
  });

  it("reads a story whole, with its checkpoints", async () => {
    const { call, recorded, read } = await product();
    await recorded("report_progress", {
      agent: "iris",
      story: "2-6",
      percent: 40,
      note: "Halfway",
    });
    const opened = await recorded("open_checkpoint", decision(1, "2-6"));
    await recorded("open_checkpoint", decision(2, "3-1"));
    const detail = await read<Extract<StateDetail, { detail: "story" }>>({ story: "2-6" });
    expect(detail.state?.progress).toMatchObject({ percent: 40, note: "Halfway" });
    expect(Object.keys(detail.checkpoints)).toEqual([opened.checkpoint]);
    expect(detail.checkpoints_total).toBe(1);
    expect(detail.state?.waiting_on).toEqual([opened.checkpoint]);
    // A story the product never heard of.
    const unknown = await call("get_state", { story: "9-9" });
    expect(unknown.ok).toBe(false);
  });

  it("refuses an unknown id, two options and out-of-range pages, writing nothing", async () => {
    const { call, recorded } = await product();
    const opened = await recorded("open_checkpoint", decision(1));
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ checkpoint: "G-0000000000" }, "checkpoint"],
      [{ agent: "nobody" }, "agent"],
      [{ story: "9-9" }, "story"],
      [{ checkpoints: { before: "G-0000000000" } }, "checkpoints.before"],
      [{ delegations: { before: "01M43XAJ69T2M7V14JYQRXKY7H" } }, "delegations.before"],
      [{ checkpoint: opened.checkpoint as string, story: "2-6" }, "story"],
      [{ checkpoints: { limit: 31 } }, "checkpoints.limit"],
      [{ checkpoints: { limit: 0 } }, "checkpoints.limit"],
      [{ checkpoint: "oops" }, "checkpoint"],
    ];
    for (const [input, field] of bad) {
      const result = await call("get_state", input);
      expect(result.ok, JSON.stringify(input)).toBe(false);
      if (result.ok) continue;
      expect(result.error.code, JSON.stringify(input)).toBe(ErrorCode.INVALID_ARGUMENTS);
      expect(result.error.details.field, JSON.stringify(input)).toBe(field);
    }
  });
});
