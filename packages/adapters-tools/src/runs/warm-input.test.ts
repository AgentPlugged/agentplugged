import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClaudeCodeAdapter, createToolAdapter } from "./adapter.js";
import { claudeCodeTranslator } from "./claude-code.js";
import { codexTranslator } from "./codex.js";
import type { RunEvent, RunRequest, ToolRun } from "./contract.js";
import { RunRequestInvalid } from "./contract.js";

/**
 * A stand-in for the official program kept open: it reads one JSON message per line, writes the
 * pieces of its answer as partial messages (and one piece of a sub-agent, which must not count),
 * then the whole message and a result. It costs a little more with each answer, as the real one.
 */
const FAKE = String.raw`
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let buffer = "";
let count = 0;
const piece = (text, extra = {}) => out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, ...extra });
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
    out({ type: "system", subtype: "init", session_id: "sess-1", model: "fake", apiKeySource: "none" });
    out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } } });
    piece("echo:");
    piece("sub-agent words", { parent_tool_use_id: "toolu_1" });
    piece(text);
    out({ type: "assistant", message: { id: "m" + count, content: [{ type: "text", text: "echo:" + text }] } });
    out({ type: "result", subtype: "success", is_error: false, session_id: "sess-1", total_cost_usd: 0.1 * count, usage: { input_tokens: 1, output_tokens: 1 }, permission_denials: [], result: "echo:" + text });
  }
});
process.stdin.on("end", () => process.exit(0));
`;

let folder: string;
let script: string;

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "agentplugged-warm-"));
  script = join(folder, "fake-warm.cjs");
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
  keepWarmMs: 400,
  partialText: true,
  ...overrides,
});

function start(overrides: Partial<RunRequest> = {}) {
  const adapter = createClaudeCodeAdapter({
    launcher: { file: process.execPath, prefixArgs: [script] },
    env: process.env as Record<string, string>,
  });
  const run: ToolRun = adapter.start(request(overrides));
  const events: RunEvent[] = [];
  run.onEvent((event) => events.push(event));
  return { run, events };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const count = (events: readonly RunEvent[], type: RunEvent["type"]): number =>
  events.filter((event) => event.type === type).length;
async function until(check: () => boolean): Promise<void> {
  const limit = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > limit) throw new Error("timed out");
    await wait(10);
  }
}

describe("a run kept open between two messages", () => {
  it("asks the program for partial messages only when the text is wanted in pieces", () => {
    expect(claudeCodeTranslator.plan(request()).args).toContain("--include-partial-messages");
    expect(claudeCodeTranslator.plan(request({ partialText: undefined })).args).not.toContain(
      "--include-partial-messages",
    );
  });

  it("tells the agent's own text in pieces, never a sub-agent's nor its thinking", async () => {
    const { run, events } = start();
    await until(() => count(events, "idle") === 1);
    const pieces = events.flatMap((event) => (event.type === "message.delta" ? [event.text] : []));
    expect(pieces).toEqual(["echo:", "first"]);
    await run.stop();
  });

  it("waits for the next message after an answer, answers it in the same program, then ends by itself", async () => {
    const { run, events } = start();
    await until(() => count(events, "idle") === 1);
    expect(events.find((event) => event.type === "idle")).toMatchObject({
      ok: true,
      session: "sess-1",
      costUsd: 0.1,
    });
    // Still open: the program has not ended, and a message is taken.
    expect(run.send?.("second")).toBe(true);
    await until(() => count(events, "idle") === 2);
    expect(events.filter((event) => event.type === "idle")[1]).toMatchObject({ costUsd: 0.2 });
    const said = events.flatMap((event) => (event.type === "message" ? [event.text] : []));
    expect(said).toEqual(["echo:first", "echo:second"]);
    // Nothing more comes: the waiting ends the program by itself, as a normal end.
    const result = await run.done;
    expect(result.outcome).toBe("completed");
    expect(run.send?.("late")).toBe(false);
  });

  it("is stopped by its process id while it waits, and says it was stopped", async () => {
    const { run, events } = start({ keepWarmMs: 60_000 });
    await until(() => count(events, "idle") === 1);
    expect(run.pid).toBeTypeOf("number");
    await run.stop();
    const result = await run.done;
    expect(result.outcome).toBe("stopped");
    expect(run.send?.("late")).toBe(false);
  });

  it("counts the time it works against its duration, not the time it waits", async () => {
    const { run, events } = start({ maxDurationMs: 300, keepWarmMs: 700 });
    await until(() => count(events, "idle") === 1);
    // The wait is longer than the whole allowed duration, and the run is not timed out.
    const result = await run.done;
    expect(result.outcome).toBe("completed");
  });

  it("ends without waiting when no waiting was asked", async () => {
    const { run, events } = start({ keepWarmMs: undefined });
    const result = await run.done;
    expect(result.outcome).toBe("completed");
    expect(count(events, "idle")).toBe(0);
  });

  it("refuses to wait without a live input, with a nonsense duration, or for a tool that cannot", () => {
    expect(() => start({ liveInput: undefined })).toThrow(RunRequestInvalid);
    expect(() => start({ keepWarmMs: 0 })).toThrow(RunRequestInvalid);
    expect(() => start({ keepWarmMs: Number.NaN })).toThrow(RunRequestInvalid);
    const other = createToolAdapter({
      translator: codexTranslator,
      launcher: { file: process.execPath, prefixArgs: [script] },
      env: process.env as Record<string, string>,
    });
    expect(() => other.start(request())).toThrow(RunRequestInvalid);
  });
});
