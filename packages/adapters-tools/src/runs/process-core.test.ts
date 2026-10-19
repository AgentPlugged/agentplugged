import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClaudeCodeAdapter } from "./adapter.js";
import type { RunEvent, RunRequest, ToolRun } from "./contract.js";
import { RunRequestInvalid } from "./contract.js";

/**
 * A stand-in for the official program: a Node script that behaves as `FAKE_MODE` says, so that the
 * real process machinery (pipes, lines, kills) is exercised without calling a model.
 */
const FAKE = String.raw`
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const mode = process.env.FAKE_MODE;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const init = { type: "system", subtype: "init", session_id: "sess-1", model: "fake", apiKeySource: "none" };
const result = (extra) => ({ type: "result", subtype: "success", is_error: false, session_id: "sess-1", total_cost_usd: 0.25, usage: { input_tokens: 3, output_tokens: 2 }, permission_denials: [], ...extra });
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  if (mode === "ok") {
    out(init);
    out({ type: "assistant", message: { id: "m", content: [{ type: "text", text: "hi" }] } });
    out(result({ result: "echo:" + prompt + "|args:" + process.argv.slice(2).join(" ") }));
  } else if (mode === "env") {
    out(init);
    out(result({ result: JSON.stringify(Object.keys(process.env).sort()) }));
  } else if (mode === "chunks") {
    const line = JSON.stringify(result({ result: "é€é" })) + "\r\n";
    const buf = Buffer.from(line);
    out(init);
    let i = 0;
    const step = () => {
      if (i >= buf.length) return process.exit(0);
      process.stdout.write(buf.subarray(i, i + 7));
      i += 7;
      setTimeout(step, 2);
    };
    step();
  } else if (mode === "disguised") {
    out(init);
    out(result({ is_error: true, subtype: "success", result: "login required" }));
    process.exit(0);
  } else if (mode === "silent") {
    out(init);
    process.exit(0);
  } else if (mode === "crash") {
    process.stderr.write("boom\n");
    process.exit(3);
  } else if (mode === "denied") {
    out(init);
    out(result({ result: "cannot", permission_denials: [{ tool_name: "Write" }] }));
  } else if (mode === "noise") {
    process.stdout.write("not json at all\n");
    out(init);
    out(result({ result: "fine" }));
  }
});
if (mode === "hang") {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  writeFileSync(process.env.FAKE_PID_FILE, String(child.pid));
  out(init);
  setInterval(() => {}, 1000);
}
`;

let folder: string;
let script: string;

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "agentplugged-run-"));
  script = join(folder, "fake-tool.cjs");
  await writeFile(script, FAKE);
});

afterAll(async () => {
  await rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const request = (overrides: Partial<RunRequest> = {}): RunRequest => ({
  cwd: folder,
  prompt: "do it",
  permissions: { level: "read" },
  ...overrides,
});

function start(
  mode: string,
  overrides: Partial<RunRequest> = {},
  env: Record<string, string> = {},
) {
  const adapter = createClaudeCodeAdapter({
    launcher: { file: process.execPath, prefixArgs: [script] },
    env: { ...(process.env as Record<string, string>), FAKE_MODE: mode, ...env },
  });
  const run = adapter.start(request(overrides));
  const events: RunEvent[] = [];
  run.onEvent((event) => events.push(event));
  return { run, events };
}

async function alive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (!(await alive(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

describe("the process core, with a stand-in program", () => {
  it("passes the instruction on the standard input and reads the stream into events", async () => {
    const { run, events } = start("ok");
    const result = await run.done;
    expect(result.outcome).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.session).toBe("sess-1");
    expect(result.billing).toBe("subscription");
    expect(result.costUsd).toBe(0.25);
    expect(result.usage).toMatchObject({ tokensIn: 3, tokensOut: 2 });
    expect(result.denied).toBe(0);
    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "message",
      "turn.completed",
    ]);
    // The instruction came on the standard input, and not in the arguments.
    expect(result.text).toMatch(/^echo:do it\|args:/);
    expect(result.text).not.toMatch(/args:.*do it/);
  });

  it("starts the program with exactly the environment it is given", async () => {
    const adapter = createClaudeCodeAdapter({
      launcher: { file: process.execPath, prefixArgs: [script] },
      env: { FAKE_MODE: "env", SystemRoot: process.env.SystemRoot ?? "", ONLY_ONE: "1" },
    });
    process.env.AGENTPLUGGED_TEST_LEAK = "1";
    const result = await adapter.start(request()).done;
    delete process.env.AGENTPLUGGED_TEST_LEAK;
    const names = (JSON.parse(result.text ?? "[]") as string[]).map((name) => name.toUpperCase());
    expect(names).toContain("ONLY_ONE");
    // The bridge's own environment is not inherited.
    expect(names).not.toContain("AGENTPLUGGED_TEST_LEAK");
  });

  it("reads lines cut in the middle of a character and ended by a carriage return", async () => {
    const { run } = start("chunks");
    const result = await run.done;
    expect(result.outcome).toBe("completed");
    expect(result.text).toBe("é€é");
  });

  it("ignores a line that is not JSON", async () => {
    const result = await start("noise").run.done;
    expect(result.outcome).toBe("completed");
    expect(result.text).toBe("fine");
  });

  it("does not take an error told with an exit code of 0 for a success", async () => {
    const { run, events } = start("disguised");
    const result = await run.done;
    expect(result.exitCode).toBe(0);
    expect(result.outcome).toBe("failed");
    expect(result.failure).toBe("tool_error");
    expect(events.some((event) => event.type === "error")).toBe(true);
  });

  it("does not take an exit of 0 without any end of turn for a success", async () => {
    const result = await start("silent").run.done;
    expect(result.exitCode).toBe(0);
    expect(result.outcome).toBe("failed");
    expect(result.failure).toBe("no_result");
  });

  it("tells a crash by its exit code", async () => {
    const result = await start("crash").run.done;
    expect(result.outcome).toBe("failed");
    expect(result.failure).toBe("exit_3");
    expect(result.exitCode).toBe(3);
  });

  it("counts the actions the tool refused, so that a refusal is not read as a plain success", async () => {
    const { run, events } = start("denied");
    const result = await run.done;
    expect(result.outcome).toBe("completed");
    expect(result.denied).toBe(1);
    expect(events).toContainEqual({ type: "permission.denied", tool: "Write" });
  });

  it("stops the program and everything it started, leaving no orphan", async () => {
    const pidFile = join(folder, "child.pid");
    const { run } = start("hang", {}, { FAKE_PID_FILE: pidFile });
    // Wait until the program announced itself and started its own child.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const text = await readFile(pidFile, "utf8").catch(() => "");
      if (text !== "") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const grandchild = Number(await readFile(pidFile, "utf8"));
    expect(grandchild).toBeGreaterThan(0);
    expect(await alive(grandchild)).toBe(true);
    const parent = run.pid;
    await run.stop();
    const result = await run.done;
    expect(result.outcome).toBe("stopped");
    expect(await waitDead(grandchild)).toBe(true);
    if (parent !== undefined) expect(await waitDead(parent)).toBe(true);
  });

  it("leaves a finished run as it was when it is stopped afterwards, twice", async () => {
    const { run } = start("ok");
    const result = await run.done;
    await run.stop();
    await run.stop();
    expect(result.outcome).toBe("completed");
    expect((await run.done).outcome).toBe("completed");
  });

  it("stops a run that outlasts its time", async () => {
    const pidFile = join(folder, "child-timeout.pid");
    const { run } = start("hang", { maxDurationMs: 600 }, { FAKE_PID_FILE: pidFile });
    const result = await run.done;
    expect(result.outcome).toBe("timeout");
    const grandchild = Number(await readFile(pidFile, "utf8"));
    expect(await waitDead(grandchild)).toBe(true);
  });

  it("tells a program that cannot be started, without throwing", async () => {
    const adapter = createClaudeCodeAdapter({
      launcher: { file: join(folder, "does-not-exist.exe"), prefixArgs: [] },
      env: {},
    });
    const run = adapter.start(request());
    const result = await run.done;
    expect(result.outcome).toBe("not_started");
    expect(result.failure).toBeDefined();
    await run.stop();
  });

  it("refuses an unacceptable request before starting anything", () => {
    const adapter = createClaudeCodeAdapter({
      launcher: { file: process.execPath, prefixArgs: [script] },
      env: {},
    });
    expect(() => adapter.start(request({ model: "a b" }))).toThrow(RunRequestInvalid);
  });

  it("lets a listener that throws, and one that leaves, change nothing for the run", async () => {
    const adapter = createClaudeCodeAdapter({
      launcher: { file: process.execPath, prefixArgs: [script] },
      env: { ...(process.env as Record<string, string>), FAKE_MODE: "ok" },
    });
    const run: ToolRun = adapter.start(request());
    run.onEvent(() => {
      throw new Error("listener");
    });
    const seen: string[] = [];
    const leave = run.onEvent((event) => seen.push(event.type));
    leave();
    expect((await run.done).outcome).toBe("completed");
    expect(seen).toEqual([]);
  });
});

describe("spawn of the stand-in", () => {
  it("is a real child process (guards the test itself)", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const code = await new Promise((resolve) => child.on("close", resolve));
    expect(code).toBe(0);
  });
});
