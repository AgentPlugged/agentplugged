import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClaudeCodeAdapter, createToolAdapter } from "./adapter.js";
import { claudeCodeTranslator } from "./claude-code.js";
import type { RunEvent, RunRequest, ToolRun } from "./contract.js";
import { RunRequestInvalid } from "./contract.js";

/**
 * A stand-in for the official program in its live-input mode: it reads one JSON message per line
 * and answers each with a result. In `background` mode the first message launches a task that
 * ends 300 ms later and wakes the program for one more answer, as a sub-agent does.
 */
const FAKE = String.raw`
const mode = process.env.FAKE_MODE;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const result = (text) => ({ type: "result", subtype: "success", is_error: false, session_id: "sess-1", total_cost_usd: 0.1, usage: { input_tokens: 1, output_tokens: 1 }, permission_denials: [], result: text });
let buffer = "";
let count = 0;
let pending = 0;
const answer = (text) => {
  out({ type: "system", subtype: "init", session_id: "sess-1", model: "fake", apiKeySource: "none" });
  out({ type: "assistant", message: { id: "m" + count, content: [{ type: "text", text }] } });
  out(result(text));
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at = buffer.indexOf("\n");
  while (at >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    at = buffer.indexOf("\n");
    let text = line;
    try { text = JSON.parse(line).message.content; } catch {}
    count += 1;

    if (mode === "failing") {
      out({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "t1" }] });
      out({ ...result("boom"), is_error: true, subtype: "error_during_execution" });
    } else if (mode === "background" && count === 1) {
      pending += 1;
      out({ type: "system", subtype: "init", session_id: "sess-1", model: "fake", apiKeySource: "none" });
      out({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "t1" }] });
      out({ type: "assistant", message: { id: "m0", content: [{ type: "text", text: "launched:" + text }] } });
      out(result("launched:" + text));
      setTimeout(() => {
        out({ type: "system", subtype: "background_tasks_changed", tasks: [] });
        answer("report");
        pending -= 1;
      }, 300);
    } else {
      answer("echo:" + text);
    }
  }
});
process.stdin.on("end", () => {
  const leave = () => (pending > 0 ? setTimeout(leave, 20) : process.exit(0));
  leave();
});
`;

let folder: string;
let script: string;

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "agentplugged-live-"));
  script = join(folder, "fake-live.cjs");
  await writeFile(script, FAKE);
});

afterAll(async () => {
  await rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const request = (overrides: Partial<RunRequest> = {}): RunRequest => ({
  cwd: folder,
  prompt: "first",
  permissions: { level: "read" },
  liveInput: true,
  ...overrides,
});

function start(mode: string, overrides: Partial<RunRequest> = {}) {
  const adapter = createClaudeCodeAdapter({
    launcher: { file: process.execPath, prefixArgs: [script] },
    env: { ...(process.env as Record<string, string>), FAKE_MODE: mode },
  });
  const run: ToolRun = adapter.start(request(overrides));
  const events: RunEvent[] = [];
  run.onEvent((event) => events.push(event));
  return { run, events };
}

const texts = (events: readonly RunEvent[]): string[] =>
  events.flatMap((event) => (event.type === "message" ? [event.text] : []));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a run with a live input", () => {
  it("asks the program for a stream of messages and writes the prompt as the first one", () => {
    const plan = claudeCodeTranslator.plan(request());
    expect(plan.args).toContain("--input-format");
    expect(plan.args[plan.args.indexOf("--input-format") + 1]).toBe("stream-json");
    expect(claudeCodeTranslator.plan(request({ liveInput: undefined })).args).not.toContain(
      "--input-format",
    );
    expect(JSON.parse(claudeCodeTranslator.frame?.("hello") ?? "")).toEqual({
      type: "user",
      message: { role: "user", content: "hello" },
    });
  });

  it("ends by itself when the first answer leaves nothing running in the background", async () => {
    const { run, events } = start("plain");
    const result = await run.done;
    expect(result.outcome).toBe("completed");
    expect(texts(events)).toEqual(["echo:first"]);
    // The input is closed: a later message is refused, not lost in a pipe nobody reads.
    expect(run.send?.("late")).toBe(false);
  });

  it("takes a message while a task runs in the background and answers it", async () => {
    const { run, events } = start("background");
    while (!events.some((event) => event.type === "turn.completed")) await wait(10);
    expect(run.send?.("second")).toBe(true);
    const result = await run.done;
    expect(result.outcome).toBe("completed");
    // The answer to the second message comes while the task runs; the report ends the run.
    expect(texts(events)).toEqual(["launched:first", "echo:second", "report"]);
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(3);
  });

  it("keeps the input open until every message was answered", async () => {
    const { run, events } = start("background");
    while (!events.some((event) => event.type === "turn.completed")) await wait(10);
    expect(run.send?.("a")).toBe(true);
    expect(run.send?.("b")).toBe(true);
    await run.done;
    expect(texts(events)).toEqual(
      expect.arrayContaining(["launched:first", "echo:a", "echo:b", "report"]),
    );
    expect(texts(events).at(-1)).toBe("report");
  });

  it("closes the input after a turn that failed, even with a task still listed", async () => {
    const { run } = start("failing");
    const result = await run.done;
    expect(result.outcome).toBe("failed");
    expect(run.send?.("late")).toBe(false);
  });

  it("refuses a message once the run was stopped", async () => {
    const { run, events } = start("background");
    while (!events.some((event) => event.type === "turn.completed")) await wait(10);
    await run.stop();
    expect(run.send?.("after")).toBe(false);
    expect((await run.done).outcome).toBe("stopped");
  });

  it("refuses a live input for a tool that cannot take one", () => {
    const adapter = createToolAdapter({
      launcher: { file: process.execPath, prefixArgs: [script] },
      env: {},
      translator: {
        ...claudeCodeTranslator,
        capabilities: { ...claudeCodeTranslator.capabilities, liveInput: false },
      },
    });
    expect(() => adapter.start(request())).toThrow(RunRequestInvalid);
  });

  it("has no send for a run without a live input", async () => {
    const { run } = start("plain", { liveInput: false });
    expect(run.send?.("x")).toBe(false);
    await run.done;
  });
});
