import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitRun } from "./git-process.js";
import { GitDocsBase, type GitRunner, NodeWorkspaceFiles } from "./index.js";

// Real Git processes: slower than vitest's 5 s default under a full test run.
vi.setConfig({ testTimeout: 120_000 });

const DIRS = [".agentplugged/docs", ".agentplugged/epics", ".agentplugged/stories"];

/** Runs git in a test repository; never in this one, never on the network. */
function git(cwd: string, args: string[], input?: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, input });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const saved: Record<string, string | undefined> = {};
let config: string;
let base: string;

/** Git sees neither this repository, nor the creator's global or system configuration. */
beforeAll(async () => {
  config = await mkdtemp(join(tmpdir(), "agentplugged-gitconfig-"));
  const global = join(config, "gitconfig");
  await writeFile(global, "");
  const env = {
    GIT_CONFIG_GLOBAL: global,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: await realpath(tmpdir()),
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(config, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "agentplugged-docs-base-"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** A repository with its own identity (Ada), never the creator's. */
function makeRepo(path: string): string {
  git(path, ["init", "-q", "-b", "main"]);
  git(path, ["config", "user.name", "Ada"]);
  git(path, ["config", "user.email", "ada@example.com"]);
  git(path, ["config", "core.autocrlf", "false"]);
  return path;
}

async function put(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

describe("GitDocsBase", () => {
  it("says there is no repository outside Git", async () => {
    expect(await new GitDocsBase({ cwd: base }).read("HEAD", DIRS)).toEqual({
      found: false,
      reason: "no_repository",
    });
  });

  it("says there is no commit yet, whatever the reference", async () => {
    makeRepo(base);
    const reader = new GitDocsBase({ cwd: base });
    expect(await reader.read("HEAD", DIRS)).toEqual({ found: false, reason: "no_commit" });
    expect(await reader.read("main", DIRS)).toEqual({ found: false, reason: "no_commit" });
  });

  it("reads the committed files of the folders at the base, not the working copy", async () => {
    makeRepo(base);
    await put(base, {
      ".agentplugged/docs/prd.md": "EF-1 : é\n",
      ".agentplugged/docs/.gitkeep": "",
      ".agentplugged/stories/1-1.md": "story\n",
      ".agentplugged/salle/x.md": "elsewhere\n",
      "README.md": "readme\n",
    });
    git(base, ["add", "."]);
    git(base, ["commit", "-q", "-m", "first"]);
    const first = git(base, ["rev-parse", "HEAD"]);
    await put(base, {
      ".agentplugged/docs/prd.md": "changed\n",
      ".agentplugged/docs/new.md": "x",
      ".agentplugged/docs/diagram.png": "not read",
    });
    git(base, ["add", "."]);
    git(base, ["commit", "-q", "-m", "second"]);
    await put(base, { ".agentplugged/docs/prd.md": "uncommitted\n" });

    const reader = new GitDocsBase({ cwd: base });
    const head = await reader.read("HEAD", DIRS);
    expect(head).toEqual({
      found: true,
      commit: git(base, ["rev-parse", "HEAD"]),
      files: [
        { path: ".agentplugged/docs/new.md", text: "x" },
        { path: ".agentplugged/docs/prd.md", text: "changed\n" },
        { path: ".agentplugged/stories/1-1.md", text: "story\n" },
      ],
    });
    const older = await reader.read("HEAD~1", DIRS);
    expect(older).toMatchObject({ found: true, commit: first });
    expect(older.found && older.files.map((file) => [file.path, file.text])).toEqual([
      [".agentplugged/docs/prd.md", "EF-1 : é\n"],
      [".agentplugged/stories/1-1.md", "story\n"],
    ]);
    expect(await reader.read("no-such-branch", DIRS)).toEqual({
      found: false,
      reason: "unknown_ref",
    });
  });

  it("gives paths relative to a sub-folder of the repository", async () => {
    makeRepo(base);
    await put(base, {
      "product/.agentplugged/epics/e.md": "epic\n",
      ".agentplugged/docs/x.md": "",
    });
    git(base, ["add", "."]);
    git(base, ["commit", "-q", "-m", "first"]);
    const read = await new GitDocsBase({ cwd: join(base, "product") }).read("HEAD", DIRS);
    expect(read.found && read.files).toEqual([
      { path: ".agentplugged/epics/e.md", text: "epic\n" },
    ]);
  });

  it("finds nothing when the base has none of the folders", async () => {
    makeRepo(base);
    await put(base, { "README.md": "x\n" });
    git(base, ["add", "."]);
    git(base, ["commit", "-q", "-m", "first"]);
    const read = await new GitDocsBase({ cwd: base }).read("HEAD", DIRS);
    expect(read).toEqual({ found: true, commit: git(base, ["rev-parse", "HEAD"]), files: [] });
  });

  it("says unknown_ref for an unknown --base on an unborn branch when other refs exist", async () => {
    makeRepo(base);
    await put(base, { "README.md": "x\n" });
    git(base, ["add", "."]);
    git(base, ["commit", "-q", "-m", "first"]);
    git(base, ["checkout", "-q", "--orphan", "fresh"]);
    const reader = new GitDocsBase({ cwd: base });
    expect(await reader.read("HEAD", DIRS)).toEqual({ found: false, reason: "no_commit" });
    expect(await reader.read("nope", DIRS)).toEqual({ found: false, reason: "unknown_ref" });
    expect(await reader.read("main", DIRS)).toMatchObject({ found: true });
  });

  it("skips symbolic links of the base", async () => {
    makeRepo(base);
    await put(base, { ".agentplugged/docs/prd.md": "prd\n" });
    git(base, ["add", "."]);
    const oid = git(base, ["hash-object", "-w", "--stdin"], "prd.md");
    git(base, ["update-index", "--add", "--cacheinfo", `120000,${oid},.agentplugged/docs/link.md`]);
    git(base, ["commit", "-q", "-m", "first"]);
    expect(git(base, ["ls-tree", "-r", "HEAD", "--", ".agentplugged/docs"])).toContain("120000");
    const read = await new GitDocsBase({ cwd: base }).read("HEAD", DIRS);
    expect(read.found && read.files).toEqual([
      { path: ".agentplugged/docs/prd.md", text: "prd\n" },
    ]);
  });
});

describe("GitDocsBase failures", () => {
  type Answer = Partial<GitRun> | Error;

  /** A Git that answers each command from `answers`, by its first argument. */
  function fake(answers: Record<string, Answer>) {
    const ok = (stdout: string): GitRun => ({ status: 0, stdout: Buffer.from(stdout), stderr: "" });
    return new GitDocsBase({
      cwd: base,
      run: async (_cwd, args) => {
        const answer =
          answers[
            args[0] === "rev-parse" && args[1] === "--show-prefix" ? "prefix" : (args[0] ?? "")
          ];
        if (answer instanceof Error) throw answer;
        if (answer !== undefined) return { ...ok(""), ...answer };
        if (args[1] === "--show-prefix") return ok("\n");
        if (args[0] === "rev-parse") return ok("abc\n");
        return ok("");
      },
    });
  }

  const listing = Buffer.from("100644 blob 0123abcd\t.agentplugged/docs/a.md\0");

  it("throws when Git refuses the repository, or times out", async () => {
    const dubious = fake({ prefix: { status: 128, stderr: "fatal: detected dubious ownership" } });
    await expect(dubious.read("HEAD", DIRS)).rejects.toThrow(/dubious ownership/);
    const slow = fake({ prefix: { status: null, timedOut: true, stderr: "fatal: too slow" } });
    await expect(slow.read("HEAD", DIRS)).rejects.toThrow(/too slow/);
    const spawn = fake({ prefix: new Error("spawn EACCES") });
    await expect(spawn.read("HEAD", DIRS)).rejects.toThrow(/EACCES/);
    const missing = fake({
      prefix: Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }),
    });
    expect(await missing.read("HEAD", DIRS)).toEqual({ found: false, reason: "no_repository" });
  });

  it("throws when ls-tree or cat-file fails", async () => {
    const list = fake({ "ls-tree": { status: 128, stderr: "fatal: bad tree" } });
    await expect(list.read("HEAD", DIRS)).rejects.toThrow(/ls-tree .*bad tree/);
    const cat = fake({
      "ls-tree": { stdout: listing },
      "cat-file": { status: 1, stderr: "fatal: broken" },
    });
    await expect(cat.read("HEAD", DIRS)).rejects.toThrow(/cat-file --batch: fatal: broken/);
    const missing = fake({
      "ls-tree": { stdout: listing },
      "cat-file": { stdout: Buffer.from("0123abcd missing\n") },
    });
    await expect(missing.read("HEAD", DIRS)).rejects.toThrow(/missing/);
  });
});

describe("GitDocsBase.readBlobs", () => {
  it("reads committed blobs by id, and leaves out the unknown ones and other objects", async () => {
    makeRepo(base);
    await put(base, {
      ".agentplugged/stories/1-1.md": "story one\n",
      ".agentplugged/stories/1-2.md": "",
    });
    git(base, ["add", "-A"]);
    git(base, ["commit", "-q", "-m", "stories"]);
    const one = git(base, ["rev-parse", "HEAD:.agentplugged/stories/1-1.md"]);
    const empty = git(base, ["rev-parse", "HEAD:.agentplugged/stories/1-2.md"]);
    const tree = git(base, ["rev-parse", "HEAD^{tree}"]);
    const unknown = "0".repeat(40);
    const blobs = await new GitDocsBase({ cwd: base }).readBlobs([
      unknown,
      one,
      tree,
      empty,
      "not-an-id",
    ]);
    expect([...blobs.entries()]).toEqual([
      [one, "story one\n"],
      [empty, ""],
    ]);
  });

  it("gives nothing outside a repository, or for no id", async () => {
    const reader = new GitDocsBase({ cwd: base });
    expect((await reader.readBlobs(["a".repeat(40)])).size).toBe(0);
    expect((await reader.readBlobs([])).size).toBe(0);
    expect((await reader.blobsInHistory(["a".repeat(40)])).size).toBe(0);
  });

  it("gives nothing without a Git binary", async () => {
    const missing: GitRunner = async () => {
      throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    };
    const reader = new GitDocsBase({ cwd: base, run: missing });
    expect((await reader.readBlobs(["a".repeat(40)])).size).toBe(0);
    expect((await reader.blobsInHistory(["a".repeat(40)])).size).toBe(0);
  });

  it("tells the blobs this branch's history held, at any path, from the others", async () => {
    makeRepo(base);
    expect((await new GitDocsBase({ cwd: base }).blobsInHistory(["a".repeat(40)])).size).toBe(0);
    await put(base, { ".agentplugged/stories/1-1.md": "story one\n" });
    git(base, ["add", "-A"]);
    git(base, ["commit", "-q", "-m", "story"]);
    const one = git(base, ["rev-parse", "HEAD:.agentplugged/stories/1-1.md"]);
    // Removed afterwards: the history still held it.
    git(base, ["rm", "-q", ".agentplugged/stories/1-1.md"]);
    git(base, ["commit", "-q", "-m", "removed"]);
    // A blob of another branch only.
    git(base, ["checkout", "-q", "-b", "other"]);
    await put(base, { ".agentplugged/stories/1-2.md": "story two\n" });
    git(base, ["add", "-A"]);
    git(base, ["commit", "-q", "-m", "other"]);
    const two = git(base, ["rev-parse", "HEAD:.agentplugged/stories/1-2.md"]);
    git(base, ["checkout", "-q", "main"]);
    const held = await new GitDocsBase({ cwd: base }).blobsInHistory([one, two]);
    expect([...held]).toEqual([one]);
  });
});

describe("NodeWorkspaceFiles.isSymbolicLink", () => {
  it("tells a symbolic link from a file", async (context) => {
    await put(base, { "a.md": "a" });
    try {
      await symlink(join(base, "a.md"), join(base, "link.md"), "file");
    } catch (error) {
      // Windows without the right to create symbolic links.
      if ((error as NodeJS.ErrnoException).code === "EPERM") return context.skip();
      throw error;
    }
    const files = new NodeWorkspaceFiles(base);
    expect(await files.isSymbolicLink("link.md")).toBe(true);
    expect(await files.isSymbolicLink("a.md")).toBe(false);
    expect(await files.isSymbolicLink("none.md")).toBe(false);
  });
});
