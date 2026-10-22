import { describe, expect, it } from "vitest";
import { claudeCodeTranslator } from "./claude-code.js";
import type { RunEvent } from "./contract.js";

function read(lines: readonly unknown[]): RunEvent[] {
  const reader = claudeCodeTranslator.begin();
  return lines.flatMap((line) => [...reader.line(line)]);
}

// The shapes below are the ones a real run wrote (Claude Code, a background sub-agent).
const started = {
  type: "system",
  subtype: "task_started",
  task_id: "abb36590",
  tool_use_id: "toolu_1",
  description: "Zoé writes docs/note.md",
  subagent_type: "zoe",
  is_backgrounded: true,
  task_type: "local_agent",
  prompt: "THE PRIVATE BRIEF",
};
const progress = {
  type: "system",
  subtype: "task_progress",
  task_id: "abb36590",
  description: "Reading README.md",
  subagent_type: "zoe",
  usage: { total_tokens: 34282, tool_uses: 2, duration_ms: 3019 },
  last_tool_name: "Read",
};
const notification = {
  type: "system",
  subtype: "task_notification",
  task_id: "abb36590",
  status: "completed",
  summary: "done",
  usage: { total_tokens: 44258, tool_uses: 7, duration_ms: 17783 },
};

describe("Claude Code sub-agents in the stream", () => {
  it("declares that the tool counts tokens for its sub-agents", () => {
    expect(claudeCodeTranslator.capabilities.subAgentUsage).toBe(true);
  });

  it("tells a task that starts, with its kind and description, and never its brief", () => {
    const events = read([started]);
    expect(events).toEqual([
      {
        type: "subagent.updated",
        id: "abb36590",
        state: "working",
        name: "zoe",
        task: "Zoé writes docs/note.md",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("PRIVATE BRIEF");
  });

  it("carries the tokens, the tool calls and the clock of each measure of progress", () => {
    expect(read([started, progress]).at(-1)).toEqual({
      type: "subagent.updated",
      id: "abb36590",
      state: "working",
      name: "zoe",
      tokens: 34282,
      toolUses: 2,
      durationMs: 3019,
    });
  });

  it("keeps the task's own description rather than what it does now", () => {
    const event = read([started, progress]).at(-1);
    expect(event).not.toHaveProperty("task");
  });

  it("tells how a task ended, with its last measure", () => {
    expect(read([started, notification]).slice(1)).toEqual([
      {
        type: "subagent.updated",
        id: "abb36590",
        state: "done",
        tokens: 44258,
        toolUses: 7,
        durationMs: 17783,
      },
    ]);
    for (const [status, state] of [
      ["failed", "failed"],
      ["stopped", "stopped"],
    ] as const) {
      expect(read([started, { ...notification, status }]).at(1)).toMatchObject({ state });
    }
    expect(read([started, { ...notification, status: "something-new" }]).slice(1)).toEqual([]);
  });

  it("invents no measure: a message without usage carries none", () => {
    const event = read([started, { ...progress, usage: undefined }]).at(-1);
    expect(event).toEqual({
      type: "subagent.updated",
      id: "abb36590",
      state: "working",
      name: "zoe",
    });
    const partial = read([started, { ...progress, usage: { tool_uses: 3 } }]).at(-1);
    expect(partial).not.toHaveProperty("tokens");
  });

  it("flags a generic sub-agent instead of naming it after the tool's word", () => {
    for (const type of ["claude", "general-purpose", "Explore"]) {
      const events = read([
        { ...started, subagent_type: type },
        { ...progress, subagent_type: type },
        notification,
      ]);
      expect(events[0]).toEqual({
        type: "subagent.updated",
        id: "abb36590",
        state: "working",
        generic: true,
        task: "Zoé writes docs/note.md",
      });
      expect(
        events.every((event) => event.type === "subagent.updated" && event.name === undefined),
      ).toBe(true);
    }
    // An agent of the team keeps its name and is never flagged.
    expect(read([{ ...started, subagent_type: "quentin" }])[0]).toMatchObject({ name: "quentin" });
    expect(read([{ ...started, subagent_type: "quentin" }])[0]).not.toHaveProperty("generic");
  });

  it("leaves out a task that is not a sub-agent and a name that is not an identifier", () => {
    expect(read([{ ...started, task_type: "local_bash" }])).toEqual([]);
    expect(read([{ ...started, task_id: undefined }])).toEqual([]);
    expect(read([{ ...started, subagent_type: "bad name; rm -rf" }])[0]).not.toHaveProperty("name");
  });

  it("tells the end of a task only when it started as a sub-agent", () => {
    // A command left running in the background ends in the same shape, without its kind.
    const bash = { ...notification, task_id: "bmxen9yko" };
    expect(read([{ ...started, task_id: "bmxen9yko", task_type: "local_bash" }, bash])).toEqual([]);
    expect(read([bash])).toEqual([]);
    expect(read([started, notification]).map((e) => e.type)).toEqual([
      "subagent.updated",
      "subagent.updated",
    ]);
  });

  it("cuts a long description", () => {
    const [event] = read([{ ...started, description: "x".repeat(500) }]);
    expect((event as { task: string }).task).toHaveLength(200);
  });
});
