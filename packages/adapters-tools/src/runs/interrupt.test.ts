import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClaudeCodeAdapter } from "./adapter.js";
import type { RunEvent, RunRequest, ToolRun } from "./contract.js";

/**
 * A stand-in for the official program in its live-input mode. A message "long" starts a turn that
 * never ends by itself; the request to interrupt ends it the way the program does (an
 * acknowledgement, then the end of the turn flagged as aborted); any other message gets an answer.
 */
const FAKE = String.raw`
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const result = (extra) => ({ type: "result", subtype: "success", is_error: false, session_id: "sess-1", total_cost_usd: 0.1, usage: { input_tokens: 1, output_tokens: 1 }, permission_denials: [], result: "", ...extra });
let buffer = "";
let working = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at = buffer.indexOf("\n");
  while (at >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    at = buffer.indexOf("\n");
    const message = JSON.parse(line);
    if (message.type === "control_request" && message.request.subtype === "interrupt") {
      out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
      if (working) {
        working = false;
        out(result({ is_error: true, subtype: "error_during_execution", terminal_reason: "aborted_streaming" }));
      }
      continue;
    }
    out({ type: "system", subtype: "init", session_id: "sess-1", model: "fake", apiKeySource: "none" });
    if (message.message.content === "long") {
      working = true;
      out({ type: "assistant", message: { id: "m-long", content: [{ type: "text", text: "working" }] } });
    } else {
      out({ type: "assistant", message: { id: "m-" + Date.now(), content: [{ type: "text", text: "echo:" + message.message.content }] } });
      out(result({ result: "echo:" + message.message.content }));
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

let folder: string;
let script: string;

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "agentplugged-interrupt-"));
  script = join(folder, "fake-interrupt.cjs");
  await writeFile(script, FAKE);
});

afterAll(async () => {
  await rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function start(overrides: Partial<RunRequest> = {}) {
  const adapter = createClaudeCodeAdapter({
    launcher: { file: process.execPath, prefixArgs: [script] },
    env: { ...(process.env as Record<string, string>) },
  });
  const run: ToolRun = adapter.start({
    cwd: folder,
    prompt: "long",
    permissions: { level: "read" },
    liveInput: true,
    keepWarmMs: 5000,
    ...overrides,
  });
  const events: RunEvent[] = [];
  run.onEvent((event) => events.push(event));
  return { run, events };
}

async function until(events: readonly RunEvent[], test: (event: RunEvent) => boolean) {
  for (let i = 0; i < 500 && !events.some(test); i++) await wait(10);
}

describe("interrupting the turn in progress", () => {
  it("ends the turn without ending the program or the session, then takes the next message", async () => {
    const { run, events } = start();
    await until(events, (event) => event.type === "message");
    expect(run.interrupt?.()).toBe(true);
    await until(events, (event) => event.type === "idle");
    // The turn ended as a turn, not as a failure; the program waits for the creator.
    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn.completed", ok: true, interrupted: true }),
    );
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(run.send?.("after")).toBe(true);
    await until(events, (event) => event.type === "message" && event.text === "echo:after");
    expect(events).toContainEqual({ type: "message", text: "echo:after" });
    await run.stop();
    expect((await run.done).outcome).toBe("stopped");
  });

  it("has nothing to do for a program that waits for its next message", async () => {
    const { run, events } = start({ prompt: "quick" });
    await until(events, (event) => event.type === "idle");
    expect(run.interrupt?.()).toBe(true);
    await run.stop();
    await run.done;
  });

  it("completes a run that was not kept open once its turn is interrupted", async () => {
    const { run, events } = start({ keepWarmMs: undefined });
    await until(events, (event) => event.type === "message");
    expect(run.interrupt?.()).toBe(true);
    const result = await run.done;
    expect(result.outcome).toBe("completed");
    expect(result.failure).toBeUndefined();
  });

  it("is refused once the run was stopped or ended, and for a run without a live input", async () => {
    const { run, events } = start();
    await until(events, (event) => event.type === "message");
    await run.stop();
    expect(run.interrupt?.()).toBe(false);
    const quiet = start({ liveInput: false, keepWarmMs: undefined, prompt: "quick" });
    expect(quiet.run.interrupt?.()).toBe(false);
    await quiet.run.stop();
  });
});
