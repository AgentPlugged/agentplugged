import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitStoryDiff } from "./index.js";

vi.setConfig({ testTimeout: 60_000 });

function gitOk(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(cwd, ".no-config") },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agentplugged-diff-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("GitStoryDiff", () => {
  it("gives the branch's changes since its base, in the repository's paths", async () => {
    gitOk(root, ["init", "-q", "-b", "main"]);
    gitOk(root, ["config", "user.name", "Ada"]);
    gitOk(root, ["config", "user.email", "ada@example.com"]);
    await writeFile(join(root, "a.txt"), "one\ntwo\n");
    gitOk(root, ["add", "-A"]);
    gitOk(root, ["commit", "-q", "-m", "start"]);
    const base = gitOk(root, ["rev-parse", "HEAD"]);
    gitOk(root, ["checkout", "-q", "-b", "feat/1-1-work"]);
    await writeFile(join(root, "a.txt"), "one\nTWO\nthree\n");
    gitOk(root, ["commit", "-q", "-am", "change"]);
    const head = gitOk(root, ["rev-parse", "HEAD"]);
    // The main branch moves on: its changes are not the story's.
    gitOk(root, ["checkout", "-q", "main"]);
    await writeFile(join(root, "b.txt"), "main only\n");
    gitOk(root, ["add", "-A"]);
    gitOk(root, ["commit", "-q", "-m", "main"]);
    const main = gitOk(root, ["rev-parse", "HEAD"]);
    const diff = await new GitStoryDiff({ cwd: root }).diff(main, head);
    expect(diff).toContain("diff --git a/a.txt b/a.txt");
    expect(diff).toContain("+TWO");
    expect(diff).not.toContain("b.txt");
    expect(await new GitStoryDiff({ cwd: root }).diff(base, head)).toBe(diff);
    // The main branch merged into the story's branch: its work is not the story's.
    gitOk(root, ["checkout", "-q", "feat/1-1-work"]);
    gitOk(root, ["merge", "-q", "--no-edit", "main"]);
    const merged = gitOk(root, ["rev-parse", "HEAD"]);
    expect(await new GitStoryDiff({ cwd: root }).diff(base, merged)).toContain("b.txt");
    const own = await new GitStoryDiff({ cwd: root }).diff(base, merged, "main");
    expect(own).toContain("+TWO");
    expect(own).not.toContain("b.txt");
    // An attribute never hides a change.
    await writeFile(join(root, ".git", "info", "attributes"), "* -diff\n");
    expect(await new GitStoryDiff({ cwd: root }).diff(base, head)).toContain("+TWO");
  });

  it("starts at the merge base with the main branch brought up to date here, not a stale remote one", async () => {
    gitOk(root, ["init", "-q", "-b", "main"]);
    gitOk(root, ["config", "user.name", "Ada"]);
    gitOk(root, ["config", "user.email", "ada@example.com"]);
    await writeFile(join(root, "a.txt"), "one\n");
    gitOk(root, ["add", "-A"]);
    gitOk(root, ["commit", "-q", "-m", "start"]);
    const base = gitOk(root, ["rev-parse", "HEAD"]);
    // The remote-tracking branch stays where it was (never fetched since).
    gitOk(root, ["update-ref", "refs/remotes/origin/main", base]);
    gitOk(root, ["checkout", "-q", "-b", "feat/1-1-work"]);
    await writeFile(join(root, "a.txt"), "one\nmine\n");
    gitOk(root, ["commit", "-q", "-am", "change"]);
    gitOk(root, ["checkout", "-q", "main"]);
    await writeFile(join(root, "config.txt"), "the method's own files\n");
    gitOk(root, ["add", "-A"]);
    gitOk(root, ["commit", "-q", "-m", "main moves"]);
    gitOk(root, ["checkout", "-q", "feat/1-1-work"]);
    gitOk(root, ["merge", "-q", "--no-edit", "main"]);
    const head = gitOk(root, ["rev-parse", "HEAD"]);
    const diff = await new GitStoryDiff({ cwd: root }).diff(base, head, "origin/main");
    expect(diff).toContain("+mine");
    expect(diff).not.toContain("config.txt");
  });

  it("reads nothing for an unknown commit, an option, or outside a repository", async () => {
    const diff = new GitStoryDiff({ cwd: root });
    expect(await diff.diff("a".repeat(40), "b".repeat(40))).toBeUndefined();
    expect(await diff.diff("--output=x", "b".repeat(40))).toBeUndefined();
  });
});

describe("GitStoryDiff, the change that belongs to no story", () => {
  async function repository() {
    gitOk(root, ["init", "-q", "-b", "main"]);
    gitOk(root, ["config", "user.name", "Ada"]);
    gitOk(root, ["config", "user.email", "ada@example.com"]);
    await writeFile(join(root, "a.txt"), "one\ntwo\n");
    gitOk(root, ["add", "-A"]);
    gitOk(root, ["commit", "-q", "-m", "start"]);
  }

  it("gives the messages of a story's commits, newest first", async () => {
    await repository();
    const base = gitOk(root, ["rev-parse", "HEAD"]);
    await writeFile(join(root, "a.txt"), "one\ntwo\nthree\n");
    gitOk(root, ["commit", "-q", "-am", "Add the third line\n\nIt is the one Ada asked for."]);
    await writeFile(join(root, "a.txt"), "one\ntwo\nthree\nfour\n");
    gitOk(root, ["commit", "-q", "-am", "Add the fourth line"]);
    const head = gitOk(root, ["rev-parse", "HEAD"]);
    const messages = (await new GitStoryDiff({ cwd: root }).messages(base, head)) ?? "";
    expect(messages).toContain("Add the fourth line");
    expect(messages).toContain("It is the one Ada asked for.");
    expect(messages).not.toContain("start");
    expect(messages.indexOf("fourth")).toBeLessThan(messages.indexOf("third"));
    expect(await new GitStoryDiff({ cwd: root }).messages("--all", head)).toBeUndefined();
  });

  it("reads the work not committed yet, new files included", async () => {
    await repository();
    await writeFile(join(root, "a.txt"), "one\nTWO\n");
    await writeFile(join(root, "new.txt"), "brand new\n");
    const read = await new GitStoryDiff({ cwd: root }).free({ kind: "uncommitted" });
    expect(read?.diff).toContain("diff --git a/a.txt b/a.txt");
    expect(read?.diff).toContain("+TWO");
    expect(read?.diff).toContain("diff --git a/new.txt b/new.txt");
    expect(read?.diff).toContain("+brand new");
    expect(read?.messages).toBe("");
  });

  it("leaves the method's own folder out of the work not committed", async () => {
    await repository();
    await mkdir(join(root, ".agentplugged", "memory"), { recursive: true });
    await writeFile(join(root, ".agentplugged", "kept.md"), "tracked\n");
    gitOk(root, ["add", "-A"]);
    gitOk(root, ["commit", "-q", "-m", "method files"]);
    await writeFile(join(root, ".agentplugged", "kept.md"), "tracked and changed\n");
    await writeFile(join(root, ".agentplugged", "memory", "lesson.md"), "private\n");
    await writeFile(join(root, "a.txt"), "one\nchanged\n");
    const read = await new GitStoryDiff({ cwd: root }).free({ kind: "uncommitted" });
    expect(read?.diff).toContain("+changed");
    expect(read?.diff).not.toContain(".agentplugged");
    expect(read?.diff).not.toContain("private");
  });

  it("reads a range of commits with their messages, and a branch against the main branch", async () => {
    await repository();
    gitOk(root, ["checkout", "-q", "-b", "feat/x"]);
    await writeFile(join(root, "a.txt"), "one\ntwo\nthree\n");
    gitOk(root, ["commit", "-q", "-am", "Add three"]);
    gitOk(root, ["checkout", "-q", "main"]);
    await writeFile(join(root, "b.txt"), "main only\n");
    gitOk(root, ["add", "-A"]);
    gitOk(root, ["commit", "-q", "-m", "main moves"]);
    const diff = new GitStoryDiff({ cwd: root });
    const range = await diff.free({ kind: "range", from: "main~1", to: "feat/x", dots: ".." });
    expect(range?.diff).toContain("+three");
    expect(range?.messages).toContain("Add three");
    // A branch is read since its merge base with the main branch: the main branch's own work is not its.
    const branch = await diff.free({ kind: "branch", name: "feat/x" });
    expect(branch?.diff).toContain("+three");
    expect(branch?.diff).not.toContain("b.txt");
    expect(branch?.messages).toContain("Add three");
    const triple = await diff.free({ kind: "range", from: "main", to: "feat/x", dots: "..." });
    expect(triple?.diff).not.toContain("b.txt");
  });

  it("reads nothing for an option, an unknown ref, or outside a repository", async () => {
    const diff = new GitStoryDiff({ cwd: root });
    expect(await diff.free({ kind: "uncommitted" })).toBeUndefined();
    await repository();
    for (const request of [
      { kind: "range", from: "--output=x", to: "HEAD", dots: ".." },
      { kind: "range", from: "HEAD", to: "--upload-pack=x", dots: ".." },
      { kind: "range", from: "nope", to: "HEAD", dots: ".." },
      { kind: "branch", name: "--all" },
      { kind: "branch", name: "no-such-branch" },
    ] as const) {
      expect(await diff.free(request), JSON.stringify(request)).toBeUndefined();
    }
  });
});
