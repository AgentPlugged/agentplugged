import { describe, expect, it, vi } from "vitest";
import { antigravityTranslator } from "./antigravity.js";
import { type RunEvent, type RunRequest, RunRequestInvalid } from "./contract.js";

const request = (overrides: Partial<RunRequest> = {}): RunRequest => ({
  cwd: "/work",
  prompt: "do it",
  permissions: { level: "edit" },
  ...overrides,
});

function read(lines: readonly unknown[]): RunEvent[] {
  const reader = antigravityTranslator.begin();
  return lines.flatMap((line) => [...reader.line(line)]);
}

const step = (fields: Record<string, unknown>) => ({
  event: "step_update",
  step_update: { conversation_id: "conv-1", step_index: 0, ...fields },
});

describe("Antigravity CLI launch plan", () => {
  it("reads framed lines on the input and answers with events, without -p, which would drop them", () => {
    const plan = antigravityTranslator.plan(request());
    expect(plan.input).toBe("framed");
    expect(plan.args).toEqual([
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--print-timeout",
      "30m",
    ]);
    expect(plan.args).not.toContain("-p");
    expect(plan.args).not.toContain("--dangerously-skip-permissions");
  });

  it("gives the program the time the run is allowed, not its 5 minutes", () => {
    const { args } = antigravityTranslator.plan(request({ maxDurationMs: 60 * 60_000 }));
    expect(args.at(args.indexOf("--print-timeout") + 1)).toBe("60m");
  });

  it("resumes a conversation by its identifier and names the model", () => {
    const { args } = antigravityTranslator.plan(request({ resume: "conv-1", model: "flash" }));
    expect(args.slice(-4)).toEqual(["--model", "flash", "--conversation", "conv-1"]);
  });

  it("frames a message as one line of the documented input", () => {
    expect(antigravityTranslator.frame?.("hi")).toBe(
      JSON.stringify({ event: "user", message: { content: "hi" } }),
    );
  });

  it("refuses a read-only level it cannot hold, and what it cannot do", () => {
    const refused: Partial<RunRequest>[] = [
      { permissions: { level: "read" } },
      { sessionId: "0b9f5c1e-7a2d-4f1c-9a53-1d2c3e4f5a6b" },
      { maxBudgetUsd: 1 },
      { persistSession: false },
      { permissions: { level: "edit", noTools: true } },
      { permissions: { level: "edit", denyCommands: ["git push"] } },
      { resume: "a b" },
    ];
    for (const overrides of refused) {
      expect(() => antigravityTranslator.plan(request(overrides))).toThrow(RunRequestInvalid);
    }
  });

  it("declares sub-agents and messages while it works, no cost in money", () => {
    expect(antigravityTranslator.capabilities).toMatchObject({
      reportsUsage: true,
      reportsCost: false,
      subAgents: true,
      liveInput: true,
    });
  });
});

describe("Antigravity CLI events", () => {
  it("tells the session at the first step, with the model of the init event", () => {
    const events = read([
      {
        event: "init",
        init: { cwd: "/work", tools: [], permission_mode: "request-review", model: "m1" },
      },
      step({ state: "DONE", step_type: "user_input" }),
    ]);
    expect(events).toEqual([{ type: "session.started", session: "conv-1", model: "m1" }]);
  });

  it("joins the streamed pieces of an answer and tells the message when its step is done", () => {
    const events = read([
      step({ step_index: 2, state: "ACTIVE", step_type: "agent_response", text_delta: "Hel" }),
      step({ step_index: 2, state: "ACTIVE", step_type: "agent_response", text_delta: "lo" }),
      step({ step_index: 2, state: "DONE", step_type: "agent_response" }),
    ]);
    expect(events.filter((e) => e.type === "message")).toEqual([
      { type: "message", text: "Hello" },
    ]);
  });

  it("does not say the same words twice when the ended step repeats the whole text", () => {
    const events = read([
      step({ step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Hi " }),
      step({ step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "Hi there" }),
    ]);
    expect(events.filter((e) => e.type === "message")).toEqual([
      { type: "message", text: "Hi there" },
    ]);
  });

  it("keeps the words of a sub-agent out of what Noah says", () => {
    const events = read([
      step({ step_index: 0, state: "DONE", step_type: "user_input" }),
      {
        event: "step_update",
        step_update: {
          conversation_id: "conv-sub",
          step_index: 0,
          state: "DONE",
          step_type: "agent_response",
          text_delta: "inner",
        },
      },
    ]);
    expect(events.filter((e) => e.type === "message")).toEqual([]);
  });

  it("reads a tool step, and a tool that failed", () => {
    const events = read([
      step({ step_index: 3, state: "ACTIVE", step_type: "tool", tool_name: "run_command" }),
      step({
        step_index: 3,
        state: "DONE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { name: "run_command", error: { type: "permission_denied", message: "x" } },
      }),
    ]);
    expect(events).toContainEqual({ type: "tool.started", id: "conv-1:3", name: "run_command" });
    expect(events).toContainEqual({ type: "permission.denied", tool: "run_command" });
    expect(events.at(-1)).toEqual({ type: "tool.completed", id: "conv-1:3", ok: false });
  });

  it("ends a turn with the answer, the tokens and the duration", () => {
    const events = read([
      {
        event: "result",
        result: {
          conversation_id: "conv-1",
          status: "SUCCESS",
          response: "done",
          duration_seconds: 2.5,
          num_turns: 1,
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            thinking_tokens: 6,
            cache_read_tokens: 3,
            total_tokens: 20,
          },
        },
      },
    ]);
    expect(events.at(-1)).toEqual({
      type: "turn.completed",
      ok: true,
      session: "conv-1",
      text: "done",
      usage: { tokensIn: 10, tokensOut: 10, cacheRead: 3 },
      durationMs: 2500,
    });
  });

  it("tells a failed status by a code, without the tool's sentence", () => {
    const events = read([
      {
        event: "result",
        result: { conversation_id: "c", status: "ERROR", error: "authentication required" },
      },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "turn.completed",
      ok: false,
      failure: "not_signed_in",
    });
    const interrupted = read([
      { event: "result", result: { conversation_id: "c", status: "INTERRUPTED" } },
    ]);
    expect(interrupted.at(-1)).toMatchObject({ ok: false, failure: "interrupted" });
  });

  it("is idle only when no sub-agent is at work, so that the input stays open for its report", () => {
    const reader = antigravityTranslator.begin();
    expect(reader.idle?.()).toBe(true);
    reader.line(
      step({
        state: "ACTIVE",
        step_type: "tool",
        subagent_info: { subagents: [{ conversation_id: "sub-1" }] },
      }),
    );
    expect(reader.idle?.()).toBe(false);
    reader.line(
      step({
        state: "DONE",
        step_type: "tool",
        subagent_info: { subagents: [{ conversation_id: "sub-1" }] },
      }),
    );
    expect(reader.idle?.()).toBe(true);
  });

  it("tells a sub-agent when it first appears and when its step is done, once each and with no measure", () => {
    const reader = antigravityTranslator.begin();
    const named = (state: string) =>
      step({
        state,
        step_type: "tool",
        subagent_info: { subagents: [{ conversation_id: "sub-1" }] },
      });
    const first = [...reader.line(named("ACTIVE"))].filter((e) => e.type === "subagent.updated");
    const again = [...reader.line(named("ACTIVE"))].filter((e) => e.type === "subagent.updated");
    const end = [...reader.line(named("DONE"))].filter((e) => e.type === "subagent.updated");
    expect(first).toEqual([{ type: "subagent.updated", id: "sub-1", state: "working" }]);
    expect(again).toEqual([]);
    expect(end).toEqual([{ type: "subagent.updated", id: "sub-1", state: "done" }]);
    expect(antigravityTranslator.capabilities.subAgentUsage).toBeUndefined();
  });

  it("lets go of a sub-agent the tool has not mentioned for ten minutes, so that the input is not held open for ever", () => {
    vi.useFakeTimers();
    try {
      const reader = antigravityTranslator.begin();
      reader.line(
        step({
          state: "ACTIVE",
          step_type: "tool",
          subagent_info: { subagents: [{ conversation_id: "sub-1" }] },
        }),
      );
      vi.advanceTimersByTime(9 * 60_000);
      expect(reader.idle?.()).toBe(false);
      vi.advanceTimersByTime(2 * 60_000);
      expect(reader.idle?.()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets go of sub-agents a failed turn leaves behind, so that the input is closed", () => {
    const reader = antigravityTranslator.begin();
    reader.line(
      step({
        state: "ACTIVE",
        step_type: "tool",
        subagent_info: { subagents: [{ conversation_id: "sub-1" }] },
      }),
    );
    reader.line({ event: "result", result: { status: "ERROR" } });
    expect(reader.idle?.()).toBe(true);
  });
});
