import { describe, expect, it } from "vitest";
import { type RunEvent, type RunRequest, RunRequestInvalid } from "./contract.js";
import { cursorTranslator } from "./cursor.js";

const request = (overrides: Partial<RunRequest> = {}): RunRequest => ({
  cwd: "/work",
  prompt: "do it",
  permissions: { level: "read" },
  ...overrides,
});

function read(lines: readonly unknown[]): RunEvent[] {
  const reader = cursorTranslator.begin();
  return lines.flatMap((line) => [...reader.line(line)]);
}

describe("Cursor launch plan", () => {
  it("prints in `-p` with the event stream, takes the instruction as the last argument and never forces", () => {
    const plan = cursorTranslator.plan(request());
    expect(plan.args.slice(0, 4)).toEqual(["-p", "--output-format", "stream-json", "--trust"]);
    expect(plan.args.at(-1)).toBe("do it");
    expect(plan.input).toBe("none");
    for (const word of ["--force", "--yolo", "-f", "--sandbox"]) {
      expect(plan.args).not.toContain(word);
    }
  });

  it("works in the folder the bridge serves and resumes a chat by its identifier", () => {
    const { args } = cursorTranslator.plan(request({ resume: "chat-1", model: "auto" }));
    expect(args).toContain("--workspace");
    expect(args[args.indexOf("--workspace") + 1]).toBe("/work");
    expect(args.slice(-5, -1)).toEqual(["--model", "auto", "--resume", "chat-1"]);
  });

  it("does not let an instruction that starts with a dash be read as an option", () => {
    expect(cursorTranslator.plan(request({ prompt: "--force x" })).args.at(-1)).toBe(" --force x");
  });

  it("refuses, before anything starts, writing, sub-agents and what the program cannot do", () => {
    const refused: Partial<RunRequest>[] = [
      { permissions: { level: "edit" } },
      { permissions: { level: "read", subAgents: {} } },
      { liveInput: true },
      { sessionId: "0b9f5c1e-7a2d-4f1c-9a53-1d2c3e4f5a6b" },
      { maxBudgetUsd: 1 },
      { persistSession: false },
      { permissions: { level: "read", noTools: true } },
      { permissions: { level: "read", denyCommands: ["git push"] } },
      { prompt: "x".repeat(30_000) },
      { resume: "a b" },
    ];
    for (const overrides of refused) {
      expect(() => cursorTranslator.plan(request(overrides))).toThrow(RunRequestInvalid);
    }
  });

  it("declares no sub-agent, no usage, no cost and no live input", () => {
    expect(cursorTranslator.capabilities).toMatchObject({
      reportsUsage: false,
      reportsCost: false,
      canResume: true,
    });
    expect(cursorTranslator.capabilities.subAgents).toBeUndefined();
    expect(cursorTranslator.capabilities.liveInput).toBeUndefined();
  });
});

describe("Cursor events", () => {
  it("reads a turn: init, answer, calls with their target, result", () => {
    const events = read([
      {
        type: "system",
        subtype: "init",
        session_id: "chat-1",
        model: "auto",
        cwd: "/work",
        apiKeySource: "login",
        permissionMode: "default",
      },
      { type: "user", message: { role: "user", content: [{ type: "text", text: "q" }] } },
      {
        type: "tool_call",
        subtype: "started",
        call_id: "c1",
        tool_call: { readToolCall: { args: { path: "a.txt" } } },
      },
      {
        type: "tool_call",
        subtype: "completed",
        call_id: "c1",
        tool_call: {
          readToolCall: {
            args: { path: "a.txt" },
            result: { success: { content: "hello", totalLines: 1 } },
          },
        },
      },
      {
        type: "tool_call",
        subtype: "started",
        call_id: "c2",
        tool_call: { shellToolCall: { args: { command: "ls" } } },
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1200,
        result: "hello",
        session_id: "chat-1",
      },
    ]);
    expect(events[0]).toEqual({ type: "session.started", session: "chat-1", model: "auto" });
    expect(events).toContainEqual({
      type: "tool.started",
      id: "c1",
      name: "read",
      action: { kind: "read", target: "a.txt" },
    });
    expect(events).toContainEqual({ type: "tool.completed", id: "c1", ok: true });
    expect(events).toContainEqual({
      type: "tool.started",
      id: "c2",
      name: "shell",
      action: { kind: "command", target: "ls" },
    });
    expect(events).toContainEqual({ type: "message", text: "hello" });
    expect(events.at(-1)).toEqual({
      type: "turn.completed",
      ok: true,
      session: "chat-1",
      text: "hello",
      durationMs: 1200,
    });
  });

  it("reads a write as an edit, and a call the tool rejected as a refusal", () => {
    const events = read([
      {
        type: "tool_call",
        subtype: "started",
        call_id: "w",
        tool_call: { writeToolCall: { args: { path: "b.ts", fileText: "x" } } },
      },
      {
        type: "tool_call",
        subtype: "completed",
        call_id: "w",
        tool_call: { writeToolCall: { result: { rejected: { reason: "no" } } } },
      },
    ]);
    expect(events[0]).toMatchObject({ action: { kind: "edit", target: "b.ts" } });
    expect(events).toContainEqual({ type: "permission.denied", tool: "write" });
    expect(events.at(-1)).toEqual({ type: "tool.completed", id: "w", ok: false });
  });

  it("names a call of another kind by its function", () => {
    const events = read([
      {
        type: "tool_call",
        subtype: "started",
        call_id: "f",
        tool_call: { function: { name: "mcp_state", arguments: "{}" } },
      },
    ]);
    expect(events).toEqual([{ type: "tool.started", id: "f", name: "mcp_state" }]);
  });

  it("tells a failed result by a code and never forwards the tool's sentence as the code", () => {
    const events = read([
      {
        type: "result",
        subtype: "success",
        is_error: true,
        result: "Not logged in. Run login",
        session_id: "s",
      },
    ]);
    expect(events.at(-1)).toMatchObject({ ok: false, failure: "not_signed_in" });
  });

  it("ignores lines it does not know", () => {
    expect(read([{ type: "future" }, "x", 3, null])).toEqual([]);
  });
});
