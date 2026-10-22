import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdapterFor } from "./adapter.js";
import type { RunEvent, RunRequest, RunToolId } from "./contract.js";

/**
 * A stand-in for the official programs: it records how it was started (arguments, what it read on
 * its input) and answers in the language of the tool named by FAKE_TOOL. No real program runs.
 */
const FAKE = String.raw`
const tool = process.env.FAKE_TOOL;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const args = process.argv.slice(2);
let input = "";
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (d) => {
  input += d;
  if (tool !== "antigravity") return;
  // One answer per line, as soon as the line arrives: the input stays open until the caller ends it.
  buffer += d;
  let at = buffer.indexOf("\n");
  while (at >= 0) {
    const l = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    at = buffer.indexOf("\n");
    out({ event: "step_update", step_update: { conversation_id: "conv-1", step_index: 1, state: "DONE", step_type: "agent_response", text_delta: JSON.stringify({ args, input }) } });
    out({ event: "result", result: { conversation_id: "conv-1", status: "SUCCESS", response: "r:" + l.message.content } });
  }
});
process.stdin.on("end", () => {
  const seen = JSON.stringify({ args, input });
  if (tool === "codex") {
    out({ type: "thread.started", thread_id: "thread-1" });
    out({ type: "item.completed", item: { id: "i", type: "agent_message", text: seen } });
    out({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 2 } });
  } else if (tool === "cursor") {
    out({ type: "system", subtype: "init", session_id: "chat-1", model: "auto" });
    out({ type: "result", subtype: "success", is_error: false, result: seen, session_id: "chat-1" });
  }
  process.exit(0);
});
`;

let folder: string;
let script: string;

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "agentplugged-headless-"));
  script = join(folder, "fake.cjs");
  await writeFile(script, FAKE);
});

afterAll(async () => {
  await rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

async function run(tool: RunToolId, request: Partial<RunRequest> = {}) {
  const adapter = createAdapterFor(tool, {
    launcher: { file: process.execPath, prefixArgs: [script] },
    env: { ...(process.env as Record<string, string>), FAKE_TOOL: tool },
  });
  const handle = adapter.start({
    cwd: folder,
    prompt: "the instruction",
    permissions: { level: tool === "antigravity" ? "edit" : "read" },
    ...request,
  });
  const events: RunEvent[] = [];
  handle.onEvent((event) => events.push(event));
  return { result: await handle.done, events };
}

const seenBy = (events: RunEvent[]): { args: string[]; input: string } => {
  const message = events.find((e) => e.type === "message");
  return JSON.parse(message?.type === "message" ? message.text : "{}");
};

describe("the process core with the other tools", () => {
  it("gives Codex the instruction on its input and ends a completed turn", async () => {
    const { result, events } = await run("codex");
    expect(result.outcome).toBe("completed");
    expect(result.session).toBe("thread-1");
    expect(result.usage).toEqual({ tokensIn: 5, tokensOut: 2 });
    expect(seenBy(events)).toMatchObject({ input: "the instruction" });
    expect(seenBy(events).args.at(-1)).toBe("-");
  });

  it("gives Antigravity CLI the instruction as one framed line, then closes the input", async () => {
    const { result, events } = await run("antigravity");
    expect(result.outcome).toBe("completed");
    expect(result.text).toBe("r:the instruction");
    expect(JSON.parse(seenBy(events).input)).toEqual({
      event: "user",
      message: { content: "the instruction" },
    });
  });

  it("keeps the input of Antigravity CLI open for a message while it works, and closes it when idle", async () => {
    const adapter = createAdapterFor("antigravity", {
      launcher: { file: process.execPath, prefixArgs: [script] },
      env: { ...(process.env as Record<string, string>), FAKE_TOOL: "antigravity" },
    });
    const handle = adapter.start({
      cwd: folder,
      prompt: "first",
      permissions: { level: "edit" },
      liveInput: true,
    });
    const answers: string[] = [];
    handle.onEvent((event) => {
      if (event.type === "turn.completed" && event.text !== undefined) answers.push(event.text);
    });
    expect(handle.send?.("second")).toBe(true);
    const result = await handle.done;
    expect(result.outcome).toBe("completed");
    expect(answers.sort()).toEqual(["r:first", "r:second"]);
  });

  it("gives Cursor the instruction as an argument and nothing on its input", async () => {
    const { result, events } = await run("cursor");
    expect(result.outcome).toBe("completed");
    expect(result.session).toBe("chat-1");
    const text = result.text ?? "";
    expect(JSON.parse(text)).toMatchObject({ input: "" });
    expect(JSON.parse(text).args.at(-1)).toBe("the instruction");
    expect(events.some((e) => e.type === "session.started")).toBe(true);
  });

  it("refuses a request the tool cannot honour before starting anything", () => {
    const adapter = createAdapterFor("cursor", {
      launcher: { file: process.execPath, prefixArgs: [script] },
      env: {},
    });
    expect(() =>
      adapter.start({ cwd: folder, prompt: "x", permissions: { level: "edit" } }),
    ).toThrow(/--force/);
  });
});
