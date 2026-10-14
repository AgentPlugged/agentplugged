import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitMergeProbe } from "./index.js";

vi.setConfig({ testTimeout: 60_000 });

function git(cwd: string, args: string[], allowFailure = false): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(cwd, ".no-config") },
  });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agentplugged-merge-probe-")));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "Ada"]);
  git(root, ["config", "user.email", "ada@example.com"]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const write = (name: string, text: string) => writeFile(join(root, name), text);
const commit = (message: string) => {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
};

/** The base, the main branch's tip, the story's head: both sides add an import after `a`. */
async function diverged(base: string, main: string, story: string, file = "src.txt") {
  await write(file, base);
  const start = commit("start");
  git(root, ["checkout", "-q", "-b", "feat/1-1-work"]);
  await write(file, story);
  const head = commit("story");
  git(root, ["checkout", "-q", "main"]);
  await write(file, main);
  const tip = commit("main");
  return { start, head, tip };
}

describe("GitMergeProbe", () => {
  it("resolves a branch name to its commit, and nothing else", async () => {
    await write("a.txt", "a\n");
    const start = commit("start");
    const probe = new GitMergeProbe({ cwd: root });
    expect(await probe.resolve("main")).toBe(start);
    expect(await probe.resolve("nope")).toBeUndefined();
    expect(await probe.resolve("--all")).toBeUndefined();
    expect(await probe.resolve("a b")).toBeUndefined();
  });

  it("says a merge is clean when both sides touch other lines", async () => {
    const { head, tip } = await diverged("a\nb\nc\n", "a\nb\nc\nmain\n", "story\na\nb\nc\n");
    expect(await new GitMergeProbe({ cwd: root }).probe(tip, head)).toEqual({
      status: "clean",
      main: tip,
    });
  });

  it("reads the blocks of a conflict: two additions at the same place", async () => {
    const { head, tip } = await diverged("a\nz\n", "a\nimport main\nz\n", "a\nimport story\nz\n");
    const read = await new GitMergeProbe({ cwd: root }).probe(tip, head);
    expect(read).toMatchObject({ status: "conflict", main: tip, files_truncated: false });
    if (read.status !== "conflict") return;
    expect(read.files).toEqual([
      {
        path: "src.txt",
        structural: false,
        hunks_truncated: false,
        hunks: [{ main: ["import main"], base: [], story: ["import story"] }],
      },
    ]);
  });

  it("reads the base too when both sides change the same line", async () => {
    const { head, tip } = await diverged("total = 0\n", "total = a\n", "total = b\n");
    const read = await new GitMergeProbe({ cwd: root }).probe(tip, head);
    expect(read.status).toBe("conflict");
    if (read.status !== "conflict") return;
    expect(read.files[0]?.hunks).toEqual([
      { main: ["total = a"], base: ["total = 0"], story: ["total = b"] },
    ]);
  });

  it("calls structural a file deleted on one side and a binary file", async () => {
    await write("gone.txt", "one\n");
    await writeFile(join(root, "img.bin"), Buffer.from([0, 1, 2, 3]));
    const start = commit("start");
    git(root, ["checkout", "-q", "-b", "feat/1-1-work"]);
    await write("gone.txt", "story change\n");
    await writeFile(join(root, "img.bin"), Buffer.from([0, 9, 9, 9]));
    const head = commit("story");
    git(root, ["checkout", "-q", "main"]);
    git(root, ["rm", "-q", "gone.txt"]);
    await writeFile(join(root, "img.bin"), Buffer.from([0, 7, 7, 7]));
    const tip = commit("main");
    expect(start).toBeDefined();
    const read = await new GitMergeProbe({ cwd: root }).probe(tip, head);
    expect(read.status).toBe("conflict");
    if (read.status !== "conflict") return;
    const byPath = Object.fromEntries(read.files.map((file) => [file.path, file]));
    expect(byPath["gone.txt"]).toMatchObject({ structural: true, hunks: [] });
    expect(byPath["img.bin"]).toMatchObject({ structural: true, hunks: [] });
  });

  it("writes no reference and touches no working file", async () => {
    const { head, tip } = await diverged("a\nz\n", "a\nm\nz\n", "a\ns\nz\n");
    const refs = git(root, ["for-each-ref"]);
    const status = git(root, ["status", "--porcelain"]);
    const probe = new GitMergeProbe({ cwd: root });
    await probe.probe(tip, head);
    expect(git(root, ["for-each-ref"])).toBe(refs);
    expect(git(root, ["status", "--porcelain"])).toBe(status);
  });

  it("is unavailable for what is not a commit, or a commit Git does not hold", async () => {
    const probe = new GitMergeProbe({ cwd: root });
    expect(await probe.probe("HEAD", "main")).toEqual({ status: "unavailable" });
    expect(await probe.probe("1".repeat(40), "2".repeat(40))).toEqual({ status: "unavailable" });
    expect(await probe.show("HEAD", "a.txt")).toBeUndefined();
    expect(await probe.isAncestor("1".repeat(40), "2".repeat(40))).toBeUndefined();
    expect(await probe.merges("1".repeat(40), "2".repeat(40))).toBeUndefined();
    expect(await probe.merges("x", "y")).toBeUndefined();
  });

  it("shows a text file at a commit, never a binary one nor an option", async () => {
    await write("a.txt", "hello\n");
    await writeFile(join(root, "b.bin"), Buffer.from([0, 1]));
    const start = commit("start");
    const probe = new GitMergeProbe({ cwd: root });
    expect(await probe.show(start, "a.txt")).toBe("hello\n");
    expect(await probe.show(start, "b.bin")).toBeUndefined();
    expect(await probe.show(start, "missing.txt")).toBeUndefined();
    expect(await probe.show(start, "--help")).toBeUndefined();
  });

  it("tells ancestors from others", async () => {
    const { start, head, tip } = await diverged("a\n", "a\nm\n", "a\ns\n");
    const probe = new GitMergeProbe({ cwd: root });
    expect(await probe.isAncestor(start, head)).toBe(true);
    expect(await probe.isAncestor(head, start)).toBe(false);
    expect(await probe.isAncestor(tip, head)).toBe(false);
  });

  it("lists the merges of the branch's own line, not those of the main branch it took in", async () => {
    await write("a.txt", "a\nz\n");
    const start = commit("start");
    // The main branch has a merge of its own: a side branch merged with a merge commit.
    git(root, ["checkout", "-q", "-b", "side"]);
    await write("side.txt", "side\n");
    commit("side");
    git(root, ["checkout", "-q", "main"]);
    await write("main.txt", "main\n");
    commit("main work");
    git(root, ["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    // The story's branch started before and takes the main branch in with a merge commit.
    git(root, ["checkout", "-q", "-b", "feat/1-1-work", start]);
    await write("story.txt", "story\n");
    const own = commit("story work");
    git(root, ["merge", "-q", "--no-ff", "-m", "merge main", "main"]);
    const merged = git(root, ["rev-parse", "HEAD"]);
    const tip = git(root, ["rev-parse", "main"]);
    const probe = new GitMergeProbe({ cwd: root });
    expect(await probe.merges(start, merged)).toEqual([{ commit: merged, parents: [own, tip] }]);
    // No merge on a line with none.
    expect(await probe.merges(start, own)).toEqual([]);
  });

  it("tells a merge that settled nothing from one that holds changes of its own", async () => {
    const { head, tip } = await diverged("a\nb\n", "a\nb\nmain\n", "story\na\nb\n");
    const probe = new GitMergeProbe({ cwd: root });
    const expected = await probe.mergedTree(tip, head);
    expect(expected).toBeDefined();
    git(root, ["checkout", "-q", "feat/1-1-work"]);
    git(root, ["merge", "-q", "--no-ff", "-m", "clean merge", "main"]);
    const clean = git(root, ["rev-parse", "HEAD"]);
    expect(await probe.treeOf(clean)).toBe(expected);
    // `-s ours` takes the main branch in and drops its work: another tree.
    git(root, ["reset", "-q", "--hard", head]);
    git(root, ["merge", "-q", "--no-ff", "-s", "ours", "-m", "ours", "main"]);
    const ours = git(root, ["rev-parse", "HEAD"]);
    expect(await probe.treeOf(ours)).not.toBe(expected);
    // A conflict has no tree of its own; an unknown commit has none.
    const conflict = await diverged2();
    expect(await probe.mergedTree(conflict.tip, conflict.head)).toBeUndefined();
    expect(await probe.treeOf("1".repeat(40))).toBeUndefined();
    expect(await probe.treeOf("HEAD")).toBeUndefined();
  });

  async function diverged2() {
    git(root, ["checkout", "-q", "main"]);
    await write("c.txt", "z\n");
    const base = commit("c base");
    git(root, ["checkout", "-q", "-b", "other", base]);
    await write("c.txt", "story\n");
    const head = commit("c story");
    git(root, ["checkout", "-q", "main"]);
    await write("c.txt", "main\n");
    const tip = commit("c main");
    return { head, tip };
  }

  it("finds the conflict a merge commit resolved, from its two parents", async () => {
    const { start, head, tip } = await diverged("a\nz\n", "a\nimport m\nz\n", "a\nimport s\nz\n");
    git(root, ["checkout", "-q", "feat/1-1-work"]);
    git(root, ["merge", "-q", "--no-commit", "main"], true);
    await write("src.txt", "a\nimport m\nimport s\nz\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "merge main, both kept"]);
    const resolution = git(root, ["rev-parse", "HEAD"]);
    const probe = new GitMergeProbe({ cwd: root });
    const [merge] = (await probe.merges(start, resolution)) ?? [];
    expect(merge).toEqual({ commit: resolution, parents: [head, tip] });
    // Merging the parents again conflicts: it was a resolution; its text keeps both sides.
    expect((await probe.probe(tip, head)).status).toBe("conflict");
    expect(await probe.show(resolution, "src.txt")).toBe("a\nimport m\nimport s\nz\n");
    // The branch now merges cleanly into the main branch.
    expect((await probe.probe(tip, resolution)).status).toBe("clean");
  });

  it("tells a commit made on the forge or by another identity from one made here", async () => {
    await write("a.txt", "a\n");
    const mine = commit("mine");
    const probe = new GitMergeProbe({ cwd: root });
    expect(await probe.madeOnForge(mine)).toBe(false);
    // GitHub's web editor, `resolve conflicts` and `update branch` commit as GitHub itself.
    await write("a.txt", "b\n");
    git(root, ["add", "-A"]);
    git(root, ["-c", "user.email=noreply@github.com", "commit", "-q", "-m", "web"]);
    expect(await probe.madeOnForge(git(root, ["rev-parse", "HEAD"]))).toBe(true);
    // Another identity than this repository's own.
    await write("a.txt", "c\n");
    git(root, ["add", "-A"]);
    git(root, ["-c", "user.email=other@example.com", "commit", "-q", "-m", "elsewhere"]);
    expect(await probe.madeOnForge(git(root, ["rev-parse", "HEAD"]))).toBe(true);
    expect(await probe.madeOnForge("not-a-commit")).toBeUndefined();
  });
});
