import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdapterFor } from "./adapter.js";
import { type RunEvent, type RunRequest, RunRequestInvalid } from "./contract.js";
import { kimiExitFailure, kimiTranslator } from "./kimi.js";

const request = (overrides: Partial<RunRequest> = {}): RunRequest => ({
  cwd: "/work",
  prompt: "do it",
  permissions: { level: "read" },
  ...overrides,
});

function read(lines: readonly unknown[]): RunEvent[] {
  const reader = kimiTranslator.begin();
  return lines.flatMap((line) => [...reader.line(line)]);
}

describe("Kimi launch plan", () => {
  it("prints the stream with `-p`, takes the instruction as an argument and never asks for a bypass", () => {
    const plan = kimiTranslator.plan(request());
    expect(plan.args.slice(0, 4)).toEqual(["-p", "do it", "--output-format", "stream-json"]);
    expect(plan.input).toBe("none");
    for (const word of ["--yolo", "-y", "--auto", "--plan", "--dangerously-skip-permissions"]) {
      expect(plan.args).not.toContain(word);
    }
  });

  it("gives the session of a new run an agent file with only the reading tools and the engine's server", () => {
    const plan = kimiTranslator.plan(
      request({ permissions: { level: "read", allowMcpServers: ["agentplugged"] } }),
    );
    expect(plan.agentFile?.flag).toBe("--agent-file");
    const text = plan.agentFile?.text ?? "";
    expect(text).toContain('  - "Read"\n  - "Glob"\n  - "Grep"\n  - "mcp__agentplugged__*"');
    for (const tool of ["Bash", "Edit", "Write", "Agent", "FetchURL"]) {
      expect(text).not.toContain(`- ${tool}`);
    }
    expect(text).toContain("$" + "{base_prompt}");
  });

  it("adds the editing tools at the edit level, never the shell", () => {
    const text =
      kimiTranslator.plan(request({ permissions: { level: "edit" } })).agentFile?.text ?? "";
    expect(text).toContain('  - "Edit"\n  - "Write"');
    expect(text).not.toContain("Bash");
  });

  it("gives the agent tool, the product's agents only, and the refusals of the main session only when sub-agents are asked", () => {
    const text =
      kimiTranslator.plan(
        request({
          permissions: {
            level: "edit",
            allowMcpServers: ["agentplugged"],
            subAgents: {
              mainSessionDeny: ["mcp__agentplugged__guard", "mcp__agentplugged__story"],
            },
          },
        }),
      ).agentFile?.text ?? "";
    expect(text).toContain('  - "Agent"');
    expect(text).toContain("subagents: []");
    expect(text).toContain(
      'disallowedTools:\n  - "mcp__agentplugged__guard"\n  - "mcp__agentplugged__story"',
    );
  });

  it("starts a run without any tool when it asks for none", () => {
    const text =
      kimiTranslator.plan(
        request({
          permissions: { level: "read", noTools: true, allowMcpServers: ["agentplugged"] },
        }),
      ).agentFile?.text ?? "";
    expect(text).toContain("tools: []");
    expect(text).not.toContain("mcp__");
  });

  it("resumes a session by its identifier and passes no agent file with it", () => {
    const plan = kimiTranslator.plan(request({ resume: "sess-1", model: "kimi-k2" }));
    expect(plan.args.slice(-4)).toEqual(["--model", "kimi-k2", "--session", "sess-1"]);
    expect(plan.agentFile).toBeUndefined();
  });

  it("trusts the folder for this run only, and only when the bridge says it is the creator's product", () => {
    expect(kimiTranslator.plan(request({ trustFolder: true })).env).toEqual({
      KIMI_CODE_TRUST_WORKSPACE: "1",
    });
    expect(kimiTranslator.plan(request()).env).toBeUndefined();
    expect(kimiTranslator.plan(request({ trustFolder: true, resume: "s" })).env).toEqual({
      KIMI_CODE_TRUST_WORKSPACE: "1",
    });
  });

  it("does not let an instruction that starts with a dash or a slash be read as an option or a command", () => {
    expect(kimiTranslator.plan(request({ prompt: "--yolo x" })).args[1]).toBe(" --yolo x");
    expect(kimiTranslator.plan(request({ prompt: "/goal x" })).args[1]).toBe(" /goal x");
  });

  it("refuses, before anything starts, what the program cannot do", () => {
    const refused: Partial<RunRequest>[] = [
      { liveInput: true },
      { sessionId: "0b9f5c1e-7a2d-4f1c-9a53-1d2c3e4f5a6b" },
      { maxBudgetUsd: 1 },
      { persistSession: false },
      { permissions: { level: "read", denyCommands: ["git push"] } },
      { permissions: { level: "read", allowCommands: ["git status"] } },
      { permissions: { level: "read", projectRules: { allow: [], deny: ["Bash(rm:*)"] } } },
      { permissions: { level: "read", allowMcpServers: ["a b"] } },
      { permissions: { level: "read", subAgents: { mainSessionDeny: ["x\ninjected: 1"] } } },
      { prompt: "x".repeat(30_000) },
      { resume: "a b" },
      { model: "bad model" },
    ];
    for (const overrides of refused) {
      expect(() => kimiTranslator.plan(request(overrides))).toThrow(RunRequestInvalid);
    }
  });

  it("declares sub-agents and resume, and no usage, no cost, no live input, no named session", () => {
    expect(kimiTranslator.capabilities).toMatchObject({
      reportsUsage: false,
      reportsCost: false,
      canResume: true,
      subAgents: true,
    });
    expect(kimiTranslator.capabilities.liveInput).toBeUndefined();
    expect(kimiTranslator.capabilities.namedSessions).toBeUndefined();
  });
});

describe("Kimi events", () => {
  it("reads a turn: text, calls with their target, results, then the session at the end", () => {
    const events = read([
      { role: "meta", type: "system.version", version: "2.2.0" },
      {
        role: "assistant",
        content: "Let me look.",
        tool_calls: [
          { type: "function", id: "c1", function: { name: "Read", arguments: '{"path":"a.txt"}' } },
          { type: "function", id: "c2", function: { name: "Bash", arguments: '{"command":"ls"}' } },
          {
            type: "function",
            id: "c3",
            function: { name: "mcp__agentplugged__state", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "hello" },
      { role: "tool", tool_call_id: "c2", content: "a.txt" },
      { role: "tool", tool_call_id: "c3", content: "{}" },
      { role: "assistant", content: "All good." },
      {
        role: "meta",
        type: "session.resume_hint",
        session_id: "sess-1",
        command: "x",
        content: "y",
      },
    ]);
    expect(events[0]).toEqual({ type: "message", text: "Let me look." });
    expect(events).toContainEqual({
      type: "tool.started",
      id: "c1",
      name: "Read",
      action: { kind: "read", target: "a.txt" },
    });
    expect(events).toContainEqual({
      type: "tool.started",
      id: "c2",
      name: "Bash",
      action: { kind: "command", target: "ls" },
    });
    expect(events).toContainEqual({
      type: "tool.started",
      id: "c3",
      name: "mcp__agentplugged__state",
    });
    expect(events).toContainEqual({ type: "tool.completed", id: "c1", ok: true });
    expect(events).toContainEqual({ type: "session.started", session: "sess-1" });
    expect(events.at(-1)).toEqual({
      type: "turn.completed",
      ok: true,
      session: "sess-1",
      text: "All good.",
    });
  });

  it("reads an edit and a sub-agent launch", () => {
    const events = read([
      {
        role: "assistant",
        tool_calls: [
          { id: "w", function: { name: "Write", arguments: '{"path":"b.ts","content":"x"}' } },
          {
            id: "a",
            function: {
              name: "Agent",
              arguments:
                '{"prompt":"p","description":"d","subagent_type":"dev","run_in_background":true}',
            },
          },
        ],
      },
    ]);
    expect(events[0]).toMatchObject({ name: "Write", action: { kind: "edit", target: "b.ts" } });
    expect(events[1]).toEqual({ type: "tool.started", id: "a", name: "Agent" });
    // The tool writes no token count: the sub-agent is told without one.
    expect(events[2]).toEqual({
      type: "subagent.updated",
      id: "a",
      state: "working",
      name: "dev",
      task: "d",
    });
  });

  it("tells no sub-agent whose call identifier is too long for a view to read", () => {
    const events = read([
      {
        role: "assistant",
        tool_calls: [{ id: "x".repeat(200), function: { name: "Agent", arguments: "{}" } }],
      },
    ]);
    expect(events.some((e) => e.type === "subagent.updated")).toBe(false);
  });

  it("ends a foreground sub-agent with its call, and leaves a background one to the end of the run", () => {
    const call = (id: string, background: boolean) => ({
      id,
      function: {
        name: "Agent",
        arguments: JSON.stringify({
          description: "d",
          subagent_type: "dev",
          run_in_background: background,
        }),
      },
    });
    const events = read([
      { role: "assistant", tool_calls: [call("f", false), call("b", true)] },
      { role: "tool", tool_call_id: "f", content: "done" },
      { role: "tool", tool_call_id: "b", content: "launched" },
    ]);
    expect(events).toContainEqual({ type: "subagent.updated", id: "f", state: "done" });
    expect(events.filter((e) => e.type === "subagent.updated" && e.id === "b")).toHaveLength(1);
    expect(kimiTranslator.capabilities.subAgentUsage).toBeUndefined();
  });

  it("tells a call the permission rules refused, and one that could not run", () => {
    const events = read([
      { role: "assistant", tool_calls: [{ id: "d", function: { name: "Bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "d", content: 'Tool "Bash" was denied by permission rule.' },
      { role: "assistant", tool_calls: [{ id: "n", function: { name: "Nope", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "n", content: 'Tool "Nope" not found' },
    ]);
    expect(events).toContainEqual({ type: "permission.denied", tool: "Bash" });
    expect(events).toContainEqual({ type: "tool.completed", id: "d", ok: false });
    expect(events).toContainEqual({ type: "tool.completed", id: "n", ok: false });
    expect(events.filter((e) => e.type === "permission.denied")).toHaveLength(1);
  });

  it("tells a hook that blocked as a refusal and keeps its words out of the messages", () => {
    const events = read([
      { role: "assistant", content: "PreToolUse hook blocked\n\nsecret reason" },
      { role: "assistant", content: "Stop hook\n\nfine" },
    ]);
    expect(events).toEqual([{ type: "permission.denied", tool: "hook" }]);
  });

  it("tells a provider retry without ending the turn, with a cause when the words give one", () => {
    const events = read([
      {
        role: "meta",
        type: "turn.step.retrying",
        error_name: "RateLimit",
        error_message: "Too many requests",
        status_code: 429,
      },
      { role: "meta", type: "turn.step.retrying", error_name: "Boom", error_message: "oops" },
    ]);
    expect(events.map((e) => (e.type === "error" ? e.code : e.type))).toEqual([
      "usage_limit",
      "retrying",
    ]);
  });

  it("reads the error line of a session another client holds", () => {
    expect(read([{ type: "error", code: "session.occupied", message: "busy" }])).toEqual([
      { type: "error", code: "session.occupied", message: "busy" },
    ]);
  });

  it("ignores lines it does not know", () => {
    expect(
      read([{ type: "future" }, "x", 3, null, { role: "meta", type: "later" }, { role: "tool" }]),
    ).toEqual([]);
  });
});

describe("the cause of a run that ended with no turn", () => {
  it("is read from the end of the error output, never forwarded as text", () => {
    const cases: Array<[string, number, string | undefined]> = [
      [
        "error: failed to run prompt: No model configured. Run `kimi` and use /login to sign in, then retry",
        1,
        "not_signed_in",
      ],
      ["error: failed to run prompt: auth.login_required: sign in", 1, "not_signed_in"],
      ["error: failed to run prompt: provider.rate_limit: slow down", 1, "usage_limit"],
      ["error: failed to run prompt: provider.not_found: no such model", 1, "model_unknown"],
      ['error: failed to run prompt: Session "abc" not found.', 1, "session_not_found"],
      ["", 4, "session_busy"],
      [
        "Warning: MCP unauthorized, api key quota\nerror: failed to run prompt: other",
        1,
        undefined,
      ],
      ["error: failed to run prompt: something else", 1, undefined],
    ];
    for (const [text, code, expected] of cases) {
      expect(kimiExitFailure(text, code), text).toBe(expected);
    }
  });
});

/** A stand-in for the program: it records how it was started and writes a stream of its kind. */
const FAKE = String.raw`
const fs = require("node:fs");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const args = process.argv.slice(2);
const at = args.indexOf("--agent-file");
const agentFile = at >= 0 ? args[at + 1] : undefined;
const seen = {
  args,
  trust: process.env.KIMI_CODE_TRUST_WORKSPACE ?? null,
  agentFileText: agentFile === undefined ? null : fs.readFileSync(agentFile, "utf8"),
  agentFile: agentFile ?? null,
};
out({ role: "meta", type: "system.version", version: "2.2.0" });
if (process.env.FAKE_MODE === "fail") {
  process.stderr.write("error: failed to run prompt: provider.rate_limit: quota\n");
  process.exit(1);
}
if (process.env.FAKE_MODE === "busy") {
  out({ type: "error", code: "session.occupied", message: "busy" });
  process.exit(4);
}
out({ role: "assistant", content: JSON.stringify(seen) });
out({ role: "meta", type: "session.resume_hint", session_id: "sess-9", command: "kimi", content: "x" });
`;

let folder: string;
let script: string;

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "agentplugged-kimi-"));
  script = join(folder, "fake.cjs");
  await writeFile(script, FAKE);
});

afterAll(async () => {
  await rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

async function run(mode: string, overrides: Partial<RunRequest> = {}) {
  const adapter = createAdapterFor("kimi", {
    launcher: { file: process.execPath, prefixArgs: [script] },
    env: { ...(process.env as Record<string, string>), FAKE_MODE: mode },
  });
  const handle = adapter.start({
    cwd: folder,
    prompt: "the instruction",
    permissions: { level: "read", allowMcpServers: ["agentplugged"] },
    ...overrides,
  });
  const events: RunEvent[] = [];
  handle.onEvent((event) => events.push(event));
  return { result: await handle.done, events };
}

describe("the process core with Kimi", () => {
  it("writes the agent file for the launch, passes the trust to this process only and removes the file", async () => {
    const { result, events } = await run("ok", { trustFolder: true });
    expect(result.outcome).toBe("completed");
    expect(result.session).toBe("sess-9");
    const message = events.find((e) => e.type === "message");
    const seen = JSON.parse(message?.type === "message" ? message.text : "{}");
    expect(seen.args.slice(0, 4)).toEqual([
      "-p",
      "the instruction",
      "--output-format",
      "stream-json",
    ]);
    expect(seen.trust).toBe("1");
    expect(seen.agentFileText).toContain("mcp__agentplugged__*");
    expect(existsSync(seen.agentFile)).toBe(false);
    expect(process.env.KIMI_CODE_TRUST_WORKSPACE).toBeUndefined();
  });

  it("starts without the trust variable unless asked", async () => {
    const { events } = await run("ok");
    const message = events.find((e) => e.type === "message");
    expect(JSON.parse(message?.type === "message" ? message.text : "{}").trust).toBeNull();
  });

  it("passes no agent file to a resumed session", async () => {
    const { events } = await run("ok", { resume: "sess-1" });
    const message = events.find((e) => e.type === "message");
    const seen = JSON.parse(message?.type === "message" ? message.text : "{}");
    expect(seen.agentFile).toBeNull();
    expect(seen.args).toContain("--session");
  });

  it("tells a usage limit that only the error output carried, as a limit and a code", async () => {
    const { result, events } = await run("fail");
    expect(result.outcome).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.failure).toBe("usage_limit");
    expect(events).toContainEqual({ type: "limit", status: "exceeded" });
    expect(events.some((e) => e.type === "error" && e.code === "usage_limit")).toBe(true);
  });

  it("tells a session another client holds", async () => {
    const { result } = await run("busy");
    expect(result.outcome).toBe("failed");
    expect(result.failure).toBe("session_busy");
  });
});
