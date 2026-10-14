import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeProjectFolder, NodeUsageTraces } from "./node-usage-traces.js";

describe("NodeUsageTraces", () => {
  let home: string;
  let root: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "agentplugged-traces-"));
    root = join(home, "product");
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const traces = () =>
    new NodeUsageTraces({
      root,
      claudeHome: join(home, ".claude"),
      codexHome: join(home, ".codex"),
      antigravityHome: join(home, ".antigravity"),
    });

  it("names a project's folder the way Claude Code does: no character but letters, digits and hyphens", () => {
    const folder = claudeProjectFolder(join(root, "site vitrine", "v1.2"));
    expect(folder).toMatch(/^[A-Za-z0-9-]+$/);
    expect(folder).toMatch(/-site-vitrine-v1-2$/);
  });

  it("reads the conversations and the sub-agents' sessions with their title", async () => {
    const folder = join(home, ".claude", "projects", claudeProjectFolder(root));
    await mkdir(join(folder, "conv-1", "subagents"), { recursive: true });
    await writeFile(join(folder, "conv-1.jsonl"), '{"type":"user"}\n');
    await writeFile(
      join(folder, "conv-1", "subagents", "agent-a1.jsonl"),
      '{"type":"assistant"}\n',
    );
    await writeFile(
      join(folder, "conv-1", "subagents", "agent-a1.meta.json"),
      JSON.stringify({ agentType: "Lina", description: "Lina · story 4-3" }),
    );
    await writeFile(join(folder, "conv-1", "subagents", "agent-a2.jsonl"), "{}\n");
    const read = await traces().read([]);
    expect(
      read.map((trace) => [trace.id, trace.kind, trace.agent_type, trace.description]),
    ).toEqual([
      ["agent-a1", "sub", "lina", "Lina · story 4-3"],
      ["agent-a2", "sub", undefined, undefined],
      ["conv-1", "main", undefined, undefined],
    ]);
    expect(read.every((trace) => trace.source === "claude-code")).toBe(true);
  });

  it("does not read again a session not modified since the engine measured it", async () => {
    const folder = join(home, ".claude", "projects", claudeProjectFolder(root));
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "done.jsonl"), '{"type":"user"}\n');
    await writeFile(join(folder, "running.jsonl"), '{"type":"user"}\n');
    // `done` was measured in the future of its last change; `running` was never measured.
    const since = (session: string) =>
      session === "claude-code:done" ? Date.now() + 60_000 : undefined;
    const read = await traces().read([], since);
    expect(read.map((trace) => [trace.id, trace.unchanged === true, trace.text === ""])).toEqual([
      ["done", true, true],
      ["running", false, false],
    ]);
    // Measured before the file's last change: read again.
    const before = await traces().read([], () => 1);
    expect(before.every((trace) => trace.unchanged !== true)).toBe(true);
  });

  it("reads the working copy of a story under its recorded path", async () => {
    const worktree = join(home, "product.worktrees", "4-2");
    const folder = join(home, ".claude", "projects", claudeProjectFolder(worktree));
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "s.jsonl"), "{}\n");
    const read = await traces().read(["../product.worktrees/4-2"]);
    expect(read).toHaveLength(1);
    expect(read[0]?.worktree).toBe("../product.worktrees/4-2");
  });

  it("reads Codex's rollouts that ran in the product's folder, and no other", async () => {
    const day = join(home, ".codex", "sessions", "2026", "10", "06");
    await mkdir(day, { recursive: true });
    const line = (cwd: string) => `${JSON.stringify({ type: "session_meta", payload: { cwd } })}\n`;
    await writeFile(join(day, "rollout-a.jsonl"), line(root));
    await writeFile(join(day, "rollout-b.jsonl"), line(join(home, "elsewhere")));
    await writeFile(join(day, "notes.txt"), "x");
    const read = await traces().read([]);
    expect(read.map((trace) => [trace.source, trace.id])).toEqual([["codex", "rollout-a"]]);
  });

  it("reads nothing, without failing, when no tool left anything", async () => {
    expect(await traces().read(["../gone"])).toEqual([]);
  });

  describe("Antigravity's conversations", () => {
    const line = (type: string, extra: Record<string, unknown>) =>
      JSON.stringify({ step_index: 0, type, created_at: "2026-10-05T10:00:00Z", ...extra });
    const conversation = async (id: string, lines: string[]) => {
      const folder = join(home, ".antigravity", "brain", id, ".system_generated", "logs");
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, "transcript.jsonl"), `${lines.join("\n")}\n`);
    };
    const opening = (path: string) =>
      line("USER_INPUT", {
        content: `Active Document: ${path} (X)\nchanged setting \`Model Selection\` from None to Gemini 3.1 Pro (Low). No need`,
      });
    const brief = (parent: string, text: string) =>
      line("SYSTEM_MESSAGE", {
        content: `[Message] timestamp=2026-10-05T10:05:00Z sender=${parent} priority=HIGH content=${text}\n</SYSTEM_MESSAGE>`,
      });
    const view = (path: string) =>
      line("PLANNER_RESPONSE", {
        input_tokens: 1,
        tool_calls: [{ name: "view_file", args: { AbsolutePath: JSON.stringify(path) } }],
      });

    it("reads the conversations that worked in the product, each tied to its folder", async () => {
      const worktree = join(home, "product.worktrees", "1-2");
      await conversation("main-1", [opening(join(root, "docs", "brief.md"))]);
      await conversation("other", [opening(join(home, "elsewhere", "a.md"))]);
      await conversation("sub-1", [
        brief("main-1", 'Ton agent id MCP est "hugo". Développe la story 1-2.'),
        view(join(worktree, "src", "a.ts")),
      ]);
      await conversation("sub-2", [brief("main-1", "Tu es Quentin. Revue de la story 1-2.")]);
      await conversation("sub-3", [
        brief("other", "Tu es Lina."),
        view(join(home, "elsewhere", "b.ts")),
      ]);
      const read = await traces().read(["../product.worktrees/1-2"]);
      expect(
        read.map((trace) => [trace.id, trace.kind, trace.agent_type, trace.worktree, trace.model]),
      ).toEqual([
        ["main-1", "main", undefined, undefined, undefined],
        ["sub-1", "sub", "hugo", "../product.worktrees/1-2", "gemini-3.1-pro"],
        ["sub-2", "sub", "quentin", undefined, "gemini-3.1-pro"],
      ]);
      expect(read.every((trace) => trace.source === "antigravity")).toBe(true);
    });

    it("gives the creator's own conversation to the product's folder, even with a working copy's file open", async () => {
      const worktree = join(home, "product.worktrees", "1-2");
      await conversation("main-1", [opening(join(worktree, "src", "a.ts"))]);
      const read = await traces().read(["../product.worktrees/1-2"]);
      expect(read.map((trace) => [trace.id, trace.worktree])).toEqual([["main-1", undefined]]);
    });

    it("gives a sub-agent the model of its grandparent, and none when a parent is missing or is a path", async () => {
      await conversation("main-1", [opening(join(root, "a.md"))]);
      await conversation("sub-1", [brief("main-1", "Tu es Hugo."), view(join(root, "a.ts"))]);
      await conversation("sub-2", [brief("sub-1", "Tu es Lina."), view(join(root, "b.ts"))]);
      await conversation("lost", [brief("gone", "Tu es Omar."), view(join(root, "c.ts"))]);
      await conversation("escape", [brief("..", "Tu es Iris."), view(join(root, "d.ts"))]);
      const read = await traces().read([]);
      expect(read.map((trace) => [trace.id, trace.model])).toEqual([
        ["escape", undefined],
        ["lost", undefined],
        ["main-1", undefined],
        ["sub-1", "gemini-3.1-pro"],
        ["sub-2", "gemini-3.1-pro"],
      ]);
    });

    it("leaves a sub-agent that names no file, and whose parent is unreadable, unattached", async () => {
      await conversation("lost", [brief("gone", "Tu es Omar.")]);
      expect(await traces().read([])).toEqual([]);
    });

    it("does not read again a conversation not modified since the engine measured it", async () => {
      await conversation("main-1", [opening(join(root, "a.md"))]);
      const read = await traces().read([], (session) =>
        session === "antigravity:main-1" ? Date.now() + 60_000 : undefined,
      );
      expect(read.map((trace) => [trace.id, trace.unchanged === true, trace.text])).toEqual([
        ["main-1", true, ""],
      ]);
    });
  });
});
