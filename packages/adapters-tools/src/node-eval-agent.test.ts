import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evalLineLoadsSkill } from "@agentplugged/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeEvalAgent } from "./node-eval-agent.js";

/**
 * The adapter that runs Claude Code for the behaviour evaluations, against a fake
 * program that reads its request on the standard input and writes the stream Claude Code writes.
 * Never the real tool: a real run costs tokens and is the creator's gesture.
 */
const FAKE = `
const fs = require("node:fs");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const out = (row) => process.stdout.write(JSON.stringify(row) + "\\n");
  out({ type: "system", subtype: "init" });
  if (prompt.includes("CRASH")) { process.stderr.write("boom: no credential"); process.exit(3); }
  if (prompt.includes("SKILL")) {
    out({ type: "assistant", message: { id: "m1", model: "m", content: [{ type: "tool_use", name: "Skill", input: { skill: "demo" } }] } });
    if (prompt.includes("SLOW")) { setInterval(() => {}, 1000); return; }
  }
  if (prompt.includes("WRITE")) fs.writeFileSync("out.md", "# made by the run\\n");
  if (prompt.includes("BIG")) fs.writeFileSync("big.txt", "x".repeat(100000));
  const report = { args: process.argv.slice(2), keys: Object.keys(process.env), cwd: process.cwd(), prompt, seen: fs.existsSync(".claude/skills/demo/SKILL.md") };
  out({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(report), usage: { input_tokens: 10, output_tokens: 5 } });
});
`;

describe("NodeEvalAgent", () => {
  let home: string;
  let script: string;
  const agent = (env: Record<string, string | undefined> = {}) =>
    new NodeEvalAgent({
      env: { PATH: process.env.PATH ?? "", ...env },
      temporary: home,
      launch: { file: process.execPath, args: [script] },
    });
  const base = { role: "work" as const, files: [], timeoutMs: 20_000 };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "agentplugged-evalagent-"));
    script = join(home, "fake-claude.cjs");
    await writeFile(script, FAKE, "utf8");
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const reportOf = (transcript: string) => {
    const last = transcript.trim().split("\n").at(-1) ?? "{}";
    return JSON.parse((JSON.parse(last) as { result: string }).result) as {
      args: string[];
      keys: string[];
      cwd: string;
      prompt: string;
      seen: boolean;
    };
  };

  it("runs in a clean folder with the files staged, the request on the standard input, and removes the folder", async () => {
    const outcome = await agent().run({
      ...base,
      prompt: 'WRITE — a request with "quotes", $VARS and a\nnew line',
      files: [
        { path: ".claude/skills/demo/SKILL.md", text: "---\nname: demo\n---\n" },
        { path: "notes/a.md", text: "fixture" },
      ],
    });
    expect(outcome.status).toBe("done");
    const report = reportOf(outcome.transcript);
    expect(report.prompt).toBe('WRITE — a request with "quotes", $VARS and a\nnew line');
    expect(report.args.join(" ")).not.toContain("quotes");
    expect(report.seen).toBe(true);
    // Only what the run wrote: neither the fixture nor the staged skill.
    expect(outcome.produced.map((file) => file.path)).toEqual(["out.md"]);
    expect(outcome.produced[0]?.text).toContain("made by the run");
    expect(existsSync(report.cwd)).toBe(false);
  });

  it("gives a working run a few tools and no shell, a judge none and no skill, the account's own settings left out", async () => {
    const work = reportOf((await agent().run({ ...base, prompt: "hello" })).transcript);
    expect(work.args).toEqual(
      expect.arrayContaining([
        "-p",
        "--output-format",
        "stream-json",
        "--no-session-persistence",
        "--strict-mcp-config",
      ]),
    );
    expect(work.args.join(" ")).toContain(
      "--permission-mode acceptEdits --tools Read,Write,Edit,Glob,Grep,Skill",
    );
    expect(work.args.join(" ")).toContain("--setting-sources project");
    expect(work.args.join(" ")).not.toContain("Bash");
    expect(work.args.join(" ")).not.toContain("dangerously");
    const judge = reportOf(
      (
        await agent().run({
          ...base,
          role: "judge",
          prompt: "hello",
          model: "some-model",
          maxUsd: 0.5,
        })
      ).transcript,
    );
    expect(judge.args).toEqual(
      expect.arrayContaining([
        "--tools",
        "",
        "--disable-slash-commands",
        "--model",
        "some-model",
        "--max-budget-usd",
        "0.5",
      ]),
    );
    expect(judge.args).not.toContain("acceptEdits");
  });

  it("gives the bare model no skill at all, not even one of the account's", async () => {
    const bare = reportOf((await agent().run({ ...base, prompt: "hello", bare: true })).transcript);
    expect(bare.args).toContain("--disable-slash-commands");
    const skilled = reportOf((await agent().run({ ...base, prompt: "hello" })).transcript);
    expect(skilled.args).not.toContain("--disable-slash-commands");
  });

  it("reports what the run wrote, a big file by its size, and never a staged file it left alone", async () => {
    const staged = { path: "notes/long.md", text: "y".repeat(30_000) };
    const outcome = await agent().run({ ...base, prompt: "WRITE BIG", files: [staged] });
    const byPath = new Map(outcome.produced.map((file) => [file.path, file.text]));
    expect([...byPath.keys()].sort()).toEqual(["big.txt", "out.md"]);
    expect(byPath.get("big.txt")).toBe("[too big to show: 100000 bytes]");
  });

  it("passes on the variables the tool needs and none else, an empty one never", async () => {
    const outcome = await agent({
      ANTHROPIC_API_KEY: "key",
      SECRET_TOKEN: "x",
      GITHUB_TOKEN: "y",
      HTTPS_PROXY: "",
    }).run({ ...base, prompt: "hello" });
    const keys = reportOf(outcome.transcript).keys;
    expect(keys).toContain("ANTHROPIC_API_KEY");
    expect(keys).not.toContain("SECRET_TOKEN");
    expect(keys).not.toContain("GITHUB_TOKEN");
    expect(keys).not.toContain("HTTPS_PROXY");
  });

  it("stops a run as soon as the line that settles it is written (a firing seen, no need to go on)", async () => {
    const started = Date.now();
    const outcome = await agent().run({
      ...base,
      prompt: "SKILL SLOW",
      stopWhen: (line) => evalLineLoadsSkill(line, "demo"),
    });
    expect(outcome.status).toBe("stopped");
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(outcome.transcript).toContain('"name":"Skill"');
  });

  it("gives up after the time it was given, and says so", async () => {
    const outcome = await agent().run({ ...base, prompt: "SKILL SLOW", timeoutMs: 1_500 });
    expect(outcome.status).toBe("timeout");
  });

  it("reports a program that fails without a result, with its message", async () => {
    const outcome = await agent().run({ ...base, prompt: "CRASH" });
    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toContain("no credential");
  });

  it("refuses a staged file that would lie outside the folder", async () => {
    const outcome = await agent().run({
      ...base,
      prompt: "hello",
      files: [{ path: "../escape.md", text: "x" }],
    });
    expect(outcome.status).toBe("failed");
    expect(existsSync(join(home, "escape.md"))).toBe(false);
  });
});
