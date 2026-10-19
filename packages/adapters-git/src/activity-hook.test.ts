import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTIVITY_FILE_MAX_BYTES, renderActivityHookScript } from "@agentplugged/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** A fake token of the shape the exit guard refuses (assembled, so no real one sits in the source). */
const FAKE_TOKEN = `ghp_${"a1B2".repeat(10)}`;

let home: string;
let script: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-activity-"));
  script = join(home, "hook.mjs");
  writeFileSync(script, renderActivityHookScript());
});
afterEach(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

function run(
  input: unknown,
  env: Record<string, string> = {},
  overrideHome: string = home,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: overrideHome,
      USERPROFILE: overrideHome,
      CLAUDE_PROJECT_DIR: "/work/shop",
      ...env,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const spool = () => join(home, ".agentplugged", "activity");
const raw = () =>
  existsSync(spool())
    ? readdirSync(spool())
        .map((name) => readFileSync(join(spool(), name), "utf8"))
        .join("")
    : "";
function lines(): Array<Record<string, unknown>> {
  return raw()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const base = { session_id: "sess-1", tool_use_id: "toolu_1" };

describe("the activity hook script", () => {
  it("records a read, a change and a command, then the command's end, and never answers", () => {
    const calls = [
      {
        ...base,
        tool_use_id: "t1",
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: "/work/shop/a.txt" },
      },
      {
        ...base,
        tool_use_id: "t2",
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: "src/b.ts", old_string: "x", new_string: "NEWTEXT" },
      },
      {
        ...base,
        tool_use_id: "t3",
        hook_event_name: "PreToolUse",
        tool_name: "NotebookEdit",
        tool_input: { notebook_path: "n.ipynb" },
      },
      {
        ...base,
        tool_use_id: "t4",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git status" },
      },
      {
        ...base,
        tool_use_id: "t4",
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "git status" },
        tool_response: { stdout: "RESULT" },
      },
      {
        ...base,
        tool_use_id: "t5",
        hook_event_name: "PostToolUseFailure",
        tool_name: "PowerShell",
        tool_input: { command: "x" },
      },
    ];
    for (const call of calls) {
      const result = run(call);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    }
    const written = lines();
    expect(written.map((line) => [line.kind, line.id, line.target ?? line.ok])).toEqual([
      ["read", "t1", "/work/shop/a.txt"],
      ["edit", "t2", "src/b.ts"],
      ["edit", "t3", "n.ipynb"],
      ["command", "t4", "git status"],
      ["result", "t4", true],
      ["result", "t5", false],
    ]);
    expect(written[0]).toMatchObject({ v: 1, project: "/work/shop", session: "sess-1" });
    // Nothing of a result or of what an edit writes is kept.
    expect(raw()).not.toContain("RESULT");
    expect(raw()).not.toContain("NEWTEXT");
  });

  it("replaces a line that looks like a secret as a whole, before writing it", () => {
    const command = [
      "echo hello",
      `curl -H "Authorization: ${FAKE_TOKEN}" x`,
      `-----BEGIN RSA ${"PRIVATE"} KEY-----`,
      "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu",
      `-----END RSA ${"PRIVATE"} KEY-----`,
      "last",
    ].join("\n");
    run({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
    const [line] = lines();
    expect(line?.target).toBe(
      "echo hello\nredacted:secret\nredacted:secret\nredacted:secret\nredacted:secret\nlast",
    );
    expect(raw()).not.toContain(FAKE_TOKEN);
    expect(raw()).not.toContain("MIIBOgIBAAJBAKj34");
  });

  it("records nothing for a session started without a terminal", () => {
    const result = run(
      { ...base, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "a" } },
      { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" },
    );
    expect(result.status).toBe(0);
    expect(lines()).toEqual([]);
  });

  it("records nothing for tools it does not follow, or a session without a clean identifier", () => {
    run({
      ...base,
      hook_event_name: "PreToolUse",
      tool_name: "Grep",
      tool_input: { pattern: "x" },
    });
    run({
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: "a" },
    });
    run({
      session_id: "bad id",
      tool_use_id: "t",
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "a" },
    });
    expect(lines()).toEqual([]);
  });

  it("never fails: garbage input, empty input, an unwritable home", () => {
    expect(run("not json").status).toBe(0);
    expect(run("").status).toBe(0);
    const file = join(home, "not-a-folder");
    writeFileSync(file, "x");
    const result = run(
      { ...base, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "a" } },
      {},
      file,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("stops writing in a session's file past its size, and deletes old files when a session starts", () => {
    const dir = spool();
    mkdirSync(dir, { recursive: true });
    const old = join(dir, "old.jsonl");
    writeFileSync(old, "{}\n");
    const longAgo = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(old, longAgo, longAgo);
    run({
      ...base,
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "first" },
    });
    expect(existsSync(old)).toBe(false);
    const [name] = readdirSync(dir);
    writeFileSync(join(dir, name as string), "x".repeat(ACTIVITY_FILE_MAX_BYTES));
    run({
      ...base,
      tool_use_id: "late",
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "late" },
    });
    expect(readFileSync(join(dir, name as string), "utf8")).not.toContain("late");
  });
});
