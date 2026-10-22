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

describe("MCP servers given on the launch", () => {
  const mcp = {
    servers: { agentplugged: { command: "node", args: ["C:\\engines\\bin.js", "mcp"] } },
    only: true,
    startupWaitMs: 60_000,
  };

  it("gives the product's server by its path and no other, and waits for it on the first turn", () => {
    const plan = claudeCodeTranslator.plan(request({ mcp }));
    const at = plan.args.indexOf("--mcp-config");
    expect(at).toBeGreaterThan(-1);
    expect(JSON.parse(plan.args[at + 1] as string)).toEqual({
      mcpServers: {
        agentplugged: { type: "stdio", command: "node", args: ["C:\\engines\\bin.js", "mcp"] },
      },
    });
    expect(plan.args).toContain("--strict-mcp-config");
    expect(plan.env).toEqual({
      CLAUDE_CODE_MCP_STARTUP_WAIT_MS: "60000",
      MCP_TIMEOUT: "60000",
    });
  });

  it("leaves the creator's other servers in when it is not asked to keep only these", () => {
    const plan = claudeCodeTranslator.plan(request({ mcp: { ...mcp, only: false } }));
    expect(plan.args).toContain("--mcp-config");
    expect(plan.args).not.toContain("--strict-mcp-config");
  });

  it("adds nothing without servers, and refuses a name that is not one", () => {
    expect(claudeCodeTranslator.plan(request()).args).not.toContain("--mcp-config");
    expect(claudeCodeTranslator.plan(request()).env).toBeUndefined();
    expect(() =>
      claudeCodeTranslator.plan(
        request({ mcp: { servers: { "bad name": { command: "x", args: [] } } } }),
      ),
    ).toThrow(RunRequestInvalid);
  });
});

describe("the lines of a sub-agent", () => {
  const sub = {
    type: "assistant",
    parent_tool_use_id: "toolu_launch",
    message: {
      id: "m-sub",
      content: [
        { type: "text", text: "Je commence par lire le diff" },
        { type: "tool_use", id: "t-sub", name: "Bash", input: { command: "git diff" } },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };

  it("are never told as the agent's own words or tool calls, only counted", () => {
    const events = read([
      sub,
      {
        type: "user",
        parent_tool_use_id: "toolu_launch",
        message: { content: [{ type: "tool_result", tool_use_id: "t-sub", is_error: false }] },
      },
    ]);
    expect(events.map((event) => event.type)).toEqual(["usage"]);
  });

  it("leave the agent's own lines as they were", () => {
    const events = read([
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: { id: "m-1", content: [{ type: "text", text: "Bonjour" }] },
      },
    ]);
    expect(events).toEqual([{ type: "message", text: "Bonjour" }]);
  });
});

describe("a refused command", () => {
  const result = (denials: unknown[]) => ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ok",
    permission_denials: denials,
  });

  it("carries the first words the creator may allow", () => {
    const events = read([
      result([
        { tool_name: "Bash", tool_input: { command: "pnpm test --filter x" } },
        { tool_name: "PowerShell", tool_input: { command: "git status" } },
      ]),
    ]);
    const denied = events.filter((event) => event.type === "permission.denied");
    expect(denied).toEqual([
      { type: "permission.denied", tool: "Bash", command: "pnpm test" },
      { type: "permission.denied", tool: "PowerShell", command: "git status" },
    ]);
  });

  it("says why nothing is offered: a program that runs anything, Git given a folder, a missing sub-command", () => {
    const events = read([
      result([
        { tool_name: "Bash", tool_input: { command: "npx vitest run src/a.test.ts" } },
        { tool_name: "Bash", tool_input: { command: "git -C C:workapp diff HEAD~1" } },
        { tool_name: "Bash", tool_input: { command: "pnpm --version" } },
        { tool_name: "Bash", tool_input: { command: "pnpm dlx evil" } },
      ]),
    ]);
    expect(events.filter((event) => event.type === "permission.denied")).toEqual([
      { type: "permission.denied", tool: "Bash", why: "runs_anything" },
      { type: "permission.denied", tool: "Bash", why: "git_folder" },
      { type: "permission.denied", tool: "Bash", why: "subcommand" },
      { type: "permission.denied", tool: "Bash", why: "runs_anything" },
    ]);
  });

  it("offers nothing to allow for a program that runs any code, or for a tool that is not a command", () => {
    const events = read([
      result([
        { tool_name: "Bash", tool_input: { command: "node script.js" } },
        { tool_name: "Bash", tool_input: { command: "rm -rf build" } },
        { tool_name: "Bash", tool_input: { command: "pnpm --version" } },
        { tool_name: "Bash", tool_input: { command: "pnpm dlx evil" } },
        { tool_name: "Bash", tool_input: { command: "npx evil" } },
        { tool_name: "Bash", tool_input: { command: "bash.exe -c x" } },
        { tool_name: "Write", tool_input: { file_path: "a.txt" } },
      ]),
    ]);
    const denied = events.filter((event) => event.type === "permission.denied");
    expect(
      denied.map((event) => (event.type === "permission.denied" ? event.command : "?")),
    ).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(denied[6]).toEqual({ type: "permission.denied", tool: "Write" });
  });
});
