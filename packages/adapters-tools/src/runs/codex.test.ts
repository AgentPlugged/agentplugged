import { describe, expect, it } from "vitest";
import { codexTranslator } from "./codex.js";
import { type RunEvent, type RunRequest, RunRequestInvalid } from "./contract.js";

const request = (overrides: Partial<RunRequest> = {}): RunRequest => ({
  cwd: "/work",
  prompt: "do it",
  permissions: { level: "read" },
  ...overrides,
});

function read(lines: readonly unknown[]): RunEvent[] {
  const reader = codexTranslator.begin();
  return lines.flatMap((line) => [...reader.line(line)]);
}

describe("Codex launch plan", () => {
  it("runs `exec` with the JSON event stream, reads the instruction on the standard input and bypasses nothing", () => {
    const plan = codexTranslator.plan(request());
    expect(plan.args).toEqual(["exec", "--json", "--sandbox", "read-only", "-"]);
    expect(plan.input).toBe("prompt");
    for (const word of ["--dangerously-bypass-approvals-and-sandbox", "danger-full-access"]) {
      expect(plan.args).not.toContain(word);
    }
  });

  it("lets the agent edit its working folder at the edit level, in the sandbox", () => {
    expect(codexTranslator.plan(request({ permissions: { level: "edit" } })).args).toContain(
      "workspace-write",
    );
  });

  it("puts the options of `exec` before `resume`, which takes them as its own", () => {
    const { args } = codexTranslator.plan(
      request({ resume: "0b9f5c1e-7a2d-4f1c-9a53-1d2c3e4f5a6b", model: "gpt-x" }),
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "--model",
      "gpt-x",
      "resume",
      "0b9f5c1e-7a2d-4f1c-9a53-1d2c3e4f5a6b",
      "-",
    ]);
  });

  it("keeps no trace on the disk when asked", () => {
    expect(codexTranslator.plan(request({ persistSession: false })).args).toContain("--ephemeral");
  });

  it("accepts a run that launches sub-agents, under the same sandbox as the session", () => {
    const { args } = codexTranslator.plan(
      request({
        permissions: { level: "edit", subAgents: { mainSessionDeny: ["mcp__x__guard"] } },
      }),
    );
    expect(args).toContain("workspace-write");
  });

  it("refuses, before anything starts, what the program cannot do", () => {
    const refused: Partial<RunRequest>[] = [
      { liveInput: true },
      { sessionId: "0b9f5c1e-7a2d-4f1c-9a53-1d2c3e4f5a6b" },
      { maxBudgetUsd: 1 },
      { permissions: { level: "read", noTools: true } },
      { permissions: { level: "read", denyCommands: ["git push"] } },
      { model: "a b" },
      { resume: "a;b" },
    ];
    for (const overrides of refused) {
      expect(() => codexTranslator.plan(request(overrides))).toThrow(RunRequestInvalid);
    }
  });

  it("declares what it can and cannot do", () => {
    expect(codexTranslator.capabilities).toMatchObject({
      reportsUsage: true,
      reportsCost: false,
      canResume: true,
      subAgents: true,
    });
    expect(codexTranslator.capabilities.liveInput).toBeUndefined();
    expect(codexTranslator.capabilities.namedSessions).toBeUndefined();
    expect(codexTranslator.frame).toBeUndefined();
  });
});

describe("Codex events", () => {
  it("reads a turn that read a file: thread, command, answer, tokens", () => {
    const events = read([
      { type: "thread.started", thread_id: "thread-1" },
      { type: "turn.started" },
      {
        type: "item.started",
        item: {
          id: "item_0",
          type: "command_execution",
          command: "powershell.exe -Command \"Get-Content -Raw -LiteralPath 'a.txt'\"",
          aggregated_output: "",
          exit_code: null,
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "item_0",
          type: "command_execution",
          command: "x",
          aggregated_output: "hello",
          exit_code: 0,
          status: "completed",
        },
      },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "hello" } },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 27418,
          cached_input_tokens: 11264,
          cache_write_input_tokens: 0,
          output_tokens: 112,
          reasoning_output_tokens: 0,
        },
      },
    ]);
    expect(events[0]).toEqual({ type: "session.started", session: "thread-1" });
    expect(events[1]).toMatchObject({
      type: "tool.started",
      id: "item_0",
      name: "shell",
      action: { kind: "command" },
    });
    expect(events[2]).toEqual({ type: "tool.completed", id: "item_0", ok: true });
    expect(events[3]).toEqual({ type: "message", text: "hello" });
    expect(events.at(-1)).toEqual({
      type: "turn.completed",
      ok: true,
      session: "thread-1",
      text: "hello",
      usage: { tokensIn: 27418, tokensOut: 112, cacheRead: 11264 },
    });
  });

  it("tells a usage limit as a limit and a stable code, never the tool's sentence", () => {
    // The stream a real run gave when the account had reached its limit.
    const events = read([
      { type: "thread.started", thread_id: "thread-2" },
      { type: "turn.started" },
      {
        type: "error",
        message:
          "You’ve hit your usage limit. Upgrade to Plus to continue using Codex, or try again at Nov 16th, 2026 4:11 PM.",
      },
      {
        type: "turn.failed",
        error: { message: "You’ve hit your usage limit. Upgrade to Plus to continue using Codex." },
      },
    ]);
    expect(events).toContainEqual({ type: "limit", status: "exceeded" });
    const last = events.at(-1);
    expect(last).toMatchObject({ type: "turn.completed", ok: false, failure: "usage_limit" });
    expect(JSON.stringify(last)).not.toContain("Upgrade");
  });

  it("names the cause of a model the tool does not know and of a missing sign-in", () => {
    const failure = (message: string) =>
      read([
        { type: "error", message },
        { type: "turn.failed", error: { message } },
      ]).at(-1);
    expect(failure("The model `nope` does not exist")).toMatchObject({ failure: "model_unknown" });
    expect(failure("Not logged in. Please login")).toMatchObject({ failure: "not_signed_in" });
    expect(failure("something else")).toMatchObject({ failure: "turn_failed" });
  });

  it("reads a refused command as a refusal and a failed one as a failure", () => {
    const events = read([
      {
        type: "item.started",
        item: { id: "c", type: "command_execution", command: "rm x", status: "in_progress" },
      },
      {
        type: "item.completed",
        item: {
          id: "c",
          type: "command_execution",
          command: "rm x",
          exit_code: null,
          status: "declined",
        },
      },
    ]);
    expect(events).toContainEqual({ type: "permission.denied", tool: "shell" });
    expect(events.at(-1)).toEqual({ type: "tool.completed", id: "c", ok: false });
  });

  it("tells each file a change touched, once the change ended", () => {
    const events = read([
      {
        type: "item.completed",
        item: {
          id: "f",
          type: "file_change",
          changes: [
            { path: "a.ts", kind: "update" },
            { path: "b.ts", kind: "add" },
          ],
          status: "completed",
        },
      },
    ]);
    expect(
      events
        .filter((e) => e.type === "tool.started")
        .map((e) => (e as { action?: unknown }).action),
    ).toEqual([
      { kind: "edit", target: "a.ts" },
      { kind: "edit", target: "b.ts" },
    ]);
    expect(events.filter((e) => e.type === "tool.completed")).toHaveLength(2);
  });

  it("tells the calls of the engine's server and the launch of a sub-agent as calls with a name", () => {
    const events = read([
      {
        type: "item.started",
        item: {
          id: "m",
          type: "mcp_tool_call",
          server: "agentplugged",
          tool: "state",
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "m",
          type: "mcp_tool_call",
          server: "agentplugged",
          tool: "state",
          status: "completed",
        },
      },
      {
        type: "item.started",
        item: {
          id: "s",
          type: "collab_tool_call",
          tool: "spawn_agent",
          sender_thread_id: "t",
          receiver_thread_ids: [],
          status: "in_progress",
          agents_states: {},
        },
      },
      {
        type: "item.completed",
        item: { id: "s", type: "collab_tool_call", tool: "spawn_agent", status: "failed" },
      },
    ]);
    expect(events).toEqual([
      { type: "tool.started", id: "m", name: "mcp__agentplugged__state" },
      { type: "tool.completed", id: "m", ok: true },
      { type: "tool.started", id: "s", name: "agent.spawn_agent" },
      { type: "tool.completed", id: "s", ok: false },
    ]);
  });

  it("ignores reasoning, to-do lists and lines it does not know", () => {
    expect(
      read([
        { type: "item.completed", item: { id: "r", type: "reasoning", text: "thinking" } },
        { type: "item.completed", item: { id: "t", type: "todo_list", items: [] } },
        { type: "something.new" },
        "text",
        null,
      ]),
    ).toEqual([]);
  });
});
