import { describe, expect, it } from "vitest";
import { claudeCodeTranslator } from "./claude-code.js";
import { type RunEvent, type RunRequest, RunRequestInvalid } from "./contract.js";

const request = (overrides: Partial<RunRequest> = {}): RunRequest => ({
  cwd: "/work",
  prompt: "do it",
  permissions: { level: "read" },
  ...overrides,
});

function read(lines: readonly unknown[]): RunEvent[] {
  const reader = claudeCodeTranslator.begin();
  return lines.flatMap((line) => [...reader.line(line)]);
}

const after = (args: readonly string[], flag: string): string[] => {
  const at = args.indexOf(flag);
  if (at < 0) return [];
  const rest = args.slice(at + 1);
  const end = rest.findIndex((arg) => arg.startsWith("--"));
  return end < 0 ? rest : rest.slice(0, end);
};

describe("one shell for the agents", () => {
  const plan = (shell: RunRequest["shell"]) =>
    claudeCodeTranslator.plan(
      request({
        shell,
        permissions: {
          level: "edit",
          allowCommands: ["git status"],
          denyCommands: ["git push"],
          projectRules: {
            allow: ["Bash(pnpm test:*)", "PowerShell(pnpm test:*)"],
            deny: ["Bash(rm:*)", "PowerShell(rm:*)"],
          },
        },
      }),
    );

  it("cuts the PowerShell tool and writes the rules for the Unix-like shell only", () => {
    const { args, settings } = plan("bash");
    expect(after(args, "--allowedTools")).toEqual(["Bash(git status:*)"]);
    expect(after(args, "--disallowedTools")).toContain("PowerShell");
    expect(after(args, "--disallowedTools")).toContain("Bash(git push:*)");
    expect(after(args, "--disallowedTools")).not.toContain("PowerShell(git push:*)");
    const rules = JSON.parse(settings ?? "{}") as { permissions: { allow: string[] } };
    // A rule for the shell that is cut would never apply: it is not carried.
    expect(rules.permissions.allow).toEqual(["Bash(pnpm test:*)"]);
  });

  it("cuts the Unix-like shell and writes the rules for PowerShell only", () => {
    const { args, settings } = plan("powershell");
    expect(after(args, "--allowedTools")).toEqual(["PowerShell(git status:*)"]);
    expect(after(args, "--disallowedTools")).toContain("Bash");
    expect(after(args, "--disallowedTools")).toContain("PowerShell(git push:*)");
    const rules = JSON.parse(settings ?? "{}") as { permissions: { allow: string[] } };
    expect(rules.permissions.allow).toEqual(["PowerShell(pnpm test:*)"]);
  });

  it("keeps both tools and both syntaxes when no shell is chosen", () => {
    const { args } = plan(undefined);
    expect(after(args, "--allowedTools")).toEqual([
      "Bash(git status:*)",
      "PowerShell(git status:*)",
    ]);
    expect(after(args, "--disallowedTools")).not.toContain("PowerShell");
    expect(after(args, "--disallowedTools")).not.toContain("Bash");
  });

  it("refuses a shell it does not know", () => {
    expect(() => plan("zsh" as unknown as "bash")).toThrow(RunRequestInvalid);
  });
});

describe("the creator's own context stays out of the product's agents", () => {
  it("reads the settings of the project only and turns the tool's memory of the folder off", () => {
    const plan = claudeCodeTranslator.plan(request({ isolated: true }));
    expect(after(plan.args, "--setting-sources")).toEqual(["project,local"]);
    expect(plan.env).toMatchObject({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
  });

  it("changes nothing without the request", () => {
    const plan = claudeCodeTranslator.plan(request());
    expect(plan.args).not.toContain("--setting-sources");
    expect(plan.env).toBeUndefined();
  });

  it("keeps the rules and the servers the product gives", () => {
    const plan = claudeCodeTranslator.plan(
      request({
        isolated: true,
        permissions: { level: "edit", allowMcpServers: ["agentplugged"] },
        mcp: { servers: { agentplugged: { command: "node", args: ["e.js", "mcp"] } }, only: true },
      }),
    );
    expect(after(plan.args, "--allowedTools")).toContain("mcp__agentplugged");
    expect(plan.args).toContain("--strict-mcp-config");
    expect(plan.args).toContain("--mcp-config");
  });
});

describe("ceilings the program enforces", () => {
  it("passes the turns on the command line and the sub-agent ceilings in the environment", () => {
    const plan = claudeCodeTranslator.plan(
      request({ limits: { maxTurns: 40, maxConcurrentSubAgents: 2, maxSubAgentDepth: 2 } }),
    );
    expect(after(plan.args, "--max-turns")).toEqual(["40"]);
    expect(plan.env).toMatchObject({
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "2",
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "2",
    });
  });

  it("sets nothing when no ceiling is asked for", () => {
    const plan = claudeCodeTranslator.plan(request({ limits: {} }));
    expect(plan.args).not.toContain("--max-turns");
    expect(plan.env).toBeUndefined();
  });

  it.each([0, -1, 1.5, Number.NaN, 100_000])("refuses %s as a number of turns", (maxTurns) => {
    expect(() => claudeCodeTranslator.plan(request({ limits: { maxTurns } }))).toThrow(
      RunRequestInvalid,
    );
  });

  it("refuses a sub-agent ceiling out of range", () => {
    expect(() =>
      claudeCodeTranslator.plan(request({ limits: { maxConcurrentSubAgents: 0 } })),
    ).toThrow(RunRequestInvalid);
    expect(() => claudeCodeTranslator.plan(request({ limits: { maxSubAgentDepth: 99 } }))).toThrow(
      RunRequestInvalid,
    );
  });

  it("reports a run that reached its turns as the tool's own named failure", () => {
    const events = read([
      {
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        result: "",
        session_id: "s",
      },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "error", code: "error_max_turns" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn.completed", ok: false, failure: "error_max_turns" }),
    );
  });
});

describe("the servers the agent needs from its first turn", () => {
  const servers = {
    agentplugged: { command: "node", args: ["e.js", "mcp"] },
    other: { command: "node", args: ["o.js"] },
  };
  const config = (args: readonly string[]): Record<string, Record<string, unknown>> =>
    (
      JSON.parse(after(args, "--mcp-config")[0] ?? "{}") as {
        mcpServers: Record<string, Record<string, unknown>>;
      }
    ).mcpServers;

  it("loads their tools at once, waits for them and bounds their answers", () => {
    const plan = claudeCodeTranslator.plan(
      request({
        mcp: {
          servers,
          only: true,
          startupWaitMs: 60_000,
          eager: ["agentplugged"],
          serverTimeoutMs: 45_000,
        },
      }),
    );
    const found = config(plan.args);
    expect(found.agentplugged).toMatchObject({ alwaysLoad: true, timeout: 45_000 });
    expect(found.other).not.toHaveProperty("alwaysLoad");
    expect(plan.env).toMatchObject({
      CLAUDE_CODE_MCP_STARTUP_WAIT_MS: "60000",
      CLAUDE_CODE_MCP_PREWAIT_SERVERS: "agentplugged",
      CLAUDE_CODE_MCP_PREWAIT_SERVERS_MS: "60000",
    });
  });

  it("keeps the earlier launch as it was when nothing is asked", () => {
    const plan = claudeCodeTranslator.plan(request({ mcp: { servers, startupWaitMs: 1000 } }));
    expect(config(plan.args).agentplugged).toEqual({
      type: "stdio",
      command: "node",
      args: ["e.js", "mcp"],
    });
    expect(plan.env).toEqual({ CLAUDE_CODE_MCP_STARTUP_WAIT_MS: "1000", MCP_TIMEOUT: "1000" });
  });

  it("refuses an eager server that is not given and a timeout that is not a duration", () => {
    expect(() => claudeCodeTranslator.plan(request({ mcp: { servers, eager: ["nope"] } }))).toThrow(
      RunRequestInvalid,
    );
    expect(() =>
      claudeCodeTranslator.plan(request({ mcp: { servers, serverTimeoutMs: -5 } })),
    ).toThrow(RunRequestInvalid);
  });
});

describe("a refusal told while the turn goes on", () => {
  const call = (id: string, name: string, input: unknown, extra: Record<string, unknown> = {}) => ({
    type: "assistant",
    message: { id: `m-${id}`, content: [{ type: "tool_use", id, name, input }] },
    ...extra,
  });
  const refusal = (id: string, tool: string) => ({
    type: "system",
    subtype: "permission_denied",
    tool_name: tool,
    tool_use_id: id,
    decision_reason_type: "mode",
    message: "Permission to use PowerShell has been denied",
  });

  it("tells the tool and the command when the agent's own call is refused", () => {
    const events = read([
      call("t1", "Bash", { command: "git status --short" }),
      refusal("t1", "Bash"),
    ]);
    expect(events).toContainEqual({
      type: "permission.denied",
      tool: "Bash",
      command: "git status",
    });
  });

  it("names the sub-agent's real kind when one of its calls is refused", () => {
    const events = read([
      call(
        "t2",
        "PowerShell",
        { command: "npx agentplugged next" },
        {
          parent_tool_use_id: "p1",
          agent_id: "a1",
          subagent_type: "sam",
        },
      ),
      refusal("t2", "PowerShell"),
    ]);
    const denied = events.find((event) => event.type === "permission.denied");
    expect(denied).toMatchObject({ tool: "PowerShell", agent: "sam" });
  });

  it("does not name a generic sub-agent as a member of the team", () => {
    const events = read([
      call(
        "t3",
        "Bash",
        { command: "ls" },
        {
          parent_tool_use_id: "p1",
          agent_id: "a2",
          subagent_type: "general-purpose",
        },
      ),
      refusal("t3", "Bash"),
    ]);
    expect(events.find((event) => event.type === "permission.denied")).not.toHaveProperty("agent");
  });

  it("tells a refusal whose call it did not see, with the tool alone", () => {
    expect(read([refusal("t9", "Bash")])).toEqual([{ type: "permission.denied", tool: "Bash" }]);
  });

  it("does not tell the same refusal again in the final message", () => {
    const events = read([
      call("t1", "Bash", { command: "git push origin" }),
      refusal("t1", "Bash"),
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        permission_denials: [
          { tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "git push origin" } },
          { tool_name: "Bash", tool_use_id: "t4", tool_input: { command: "git commit" } },
        ],
      },
    ]);
    const denied = events.filter((event) => event.type === "permission.denied");
    expect(denied).toHaveLength(2);
    expect(denied.map((event) => ("command" in event ? event.command : undefined))).toEqual([
      "git push",
      "git commit",
    ]);
  });

  it("still tells every refusal of the final message from a tool that told none", () => {
    const events = read([
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        permission_denials: [{ tool_name: "Edit", tool_input: { file_path: "a" } }],
      },
    ]);
    expect(events).toContainEqual({ type: "permission.denied", tool: "Edit" });
  });
});

describe("who a sub-agent is, read from its own lines", () => {
  const line = (type: string, extra: Record<string, unknown>) => ({
    type,
    message: { id: "m", role: type, content: [{ type: "text", text: "hi" }] },
    parent_tool_use_id: "p1",
    agent_id: "a-77",
    subagent_type: "sam",
    task_description: "Sam builds story 2-1",
    ...extra,
  });

  it("tells a sub-agent whose start message did not come, from its first line", () => {
    const events = read([line("user", {}), line("assistant", {})]);
    expect(events.filter((event) => event.type === "subagent.updated")).toEqual([
      {
        type: "subagent.updated",
        id: "a-77",
        state: "working",
        name: "sam",
        task: "Sam builds story 2-1",
      },
    ]);
  });

  it("tells nothing more for a sub-agent whose start message came", () => {
    const events = read([
      {
        type: "system",
        subtype: "task_started",
        task_id: "a-77",
        task_type: "local_agent",
        subagent_type: "sam",
        description: "Sam builds",
      },
      line("assistant", {}),
    ]);
    expect(events.filter((event) => event.type === "subagent.updated")).toHaveLength(1);
  });

  it("says a generic kind is not one of the team", () => {
    const events = read([line("user", { subagent_type: "general-purpose" })]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "subagent.updated", generic: true }),
    );
    expect(events[0]).not.toHaveProperty("name");
  });

  it("never carries what the sub-agent says", () => {
    const events = read([line("assistant", {})]);
    expect(JSON.stringify(events)).not.toContain('"hi"');
    expect(events.some((event) => event.type === "message")).toBe(false);
  });
});

describe("an interruption on request", () => {
  const interrupted = {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    terminal_reason: "aborted_streaming",
    session_id: "s-1",
    result: "",
  };

  it("writes the request as the tool takes it, with an identifier of its own each time", () => {
    const first = JSON.parse(claudeCodeTranslator.interruptFrame?.() ?? "{}") as {
      type: string;
      request_id: string;
      request: { subtype: string };
    };
    const second = JSON.parse(claudeCodeTranslator.interruptFrame?.() ?? "{}") as {
      request_id: string;
    };
    expect(first).toMatchObject({ type: "control_request", request: { subtype: "interrupt" } });
    expect(first.request_id).not.toBe(second.request_id);
  });

  it("reads the end of an interrupted turn as a turn that ended, not as a failure", () => {
    const reader = claudeCodeTranslator.begin();
    const frame = JSON.parse(claudeCodeTranslator.interruptFrame?.() ?? "{}") as {
      request_id: string;
    };
    reader.line({
      type: "control_response",
      response: { subtype: "success", request_id: frame.request_id },
    });
    const events = [...reader.line(interrupted)];
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn.completed", ok: true, interrupted: true }),
    );
  });

  it("keeps the failure of a turn that was not interrupted on request", () => {
    const events = read([interrupted]);
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.completed", ok: false }));
  });

  it("forgets the request once the turn ended: the next failure is a failure", () => {
    const reader = claudeCodeTranslator.begin();
    reader.line({
      type: "control_response",
      response: { subtype: "success", request_id: "ap-interrupt-1" },
    });
    reader.line(interrupted);
    const events = [...reader.line(interrupted)];
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.completed", ok: false }));
  });

  it("ignores an answer to a request that is not ours", () => {
    const reader = claudeCodeTranslator.begin();
    reader.line({
      type: "control_response",
      response: { subtype: "success", request_id: "other-1" },
    });
    expect([...reader.line(interrupted)]).toContainEqual(
      expect.objectContaining({ type: "turn.completed", ok: false }),
    );
  });
});
