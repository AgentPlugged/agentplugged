import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CHAINED_HOOK_NAME, commitHookFiles } from "@agentplugged/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GitStoryWorkspace } from "./index.js";

// Real Git processes, worktrees and hooks: slower than vitest's 5 s default.
vi.setConfig({ testTimeout: 120_000 });

const STORY = ".agentplugged/stories/1-1-sign-up.md";
const TARGET = { id: "1-1", branch: "feat/1-1-sign-up", path: STORY };

/** Runs git in a test repository; never in this one, never on the network. */
function git(cwd: string, args: string[]) {
  return spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

function gitOk(cwd: string, args: string[]): string {
  const result = git(cwd, args);
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
    AGENTPLUGGED_LANG: "en",
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
  base = await realpath(await mkdtemp(join(tmpdir(), "agentplugged-story-")));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const STORY_TEXT = [
  "---",
  "id: 1-1",
  "kind: story",
  "owner: sam",
  "requirements:",
  "  - EF-1",
  "  - EF-2",
  "branch: feat/1-1-sign-up",
  "---",
  "# Sign up",
  "",
].join("\n");

/** A repository with its own identity (Ada), never the creator's, and a committed story. */
async function makeRepo(name = "shop", prefix = ""): Promise<string> {
  const root = join(base, name);
  await mkdir(root, { recursive: true });
  gitOk(root, ["init", "-q", "-b", "main"]);
  gitOk(root, ["config", "user.name", "Ada"]);
  gitOk(root, ["config", "user.email", "ada@example.com"]);
  gitOk(root, ["config", "core.autocrlf", "false"]);
  const story = join(root, prefix, STORY);
  await mkdir(dirname(story), { recursive: true });
  await writeFile(story, STORY_TEXT);
  gitOk(root, ["add", "-A"]);
  gitOk(root, ["commit", "-q", "-m", "stories"]);
  return root;
}

async function commitIn(cwd: string, file: string, message: string) {
  await writeFile(join(cwd, file), `${message}\n`);
  gitOk(cwd, ["add", "-A"]);
  return git(cwd, ["commit", "-q", "-m", message]);
}
const FILES = commitHookFiles({ id: "1-1", requirements: ["EF-1", "EF-2"] });

describe("GitStoryWorkspace", () => {
  it("finds no repository outside Git, and refuses a bare one", async () => {
    expect(await new GitStoryWorkspace({ cwd: base }).inspect(TARGET)).toEqual({
      repository: false,
    });
    const bare = join(base, "bare.git");
    await mkdir(bare);
    gitOk(bare, ["init", "-q", "--bare"]);
    expect(await new GitStoryWorkspace({ cwd: bare }).inspect(TARGET)).toEqual({
      repository: false,
      unsupported: "bare",
    });
  });

  it("creates the story's branch and its worktree next to the repository, idempotently", async () => {
    const root = await makeRepo();
    const workspace = new GitStoryWorkspace({ cwd: root });
    const before = await workspace.inspect(TARGET);
    if (!before.repository) throw new Error("no repository");
    const head = gitOk(root, ["rev-parse", "HEAD"]);
    const blob = gitOk(root, ["rev-parse", `HEAD:${STORY}`]);
    expect(before).toMatchObject({
      prefix: "",
      main: { ref: "main", commit: head },
      storyBlob: blob,
      branch: null,
      checkedOut: null,
      target: { relative: "../shop.worktrees/1-1", exists: false },
    });
    expect(before.target.path).toBe(join(base, "shop.worktrees", "1-1"));
    expect(await workspace.readBlob(blob)).toBe(STORY_TEXT);

    const created = await workspace.create(TARGET, head);
    expect(created).toEqual({
      worktree: before.target.path,
      createdBranch: true,
      createdWorktree: true,
    });
    const { worktree } = created;
    expect(existsSync(join(worktree, STORY))).toBe(true);
    expect(gitOk(worktree, ["symbolic-ref", "--short", "HEAD"])).toBe("feat/1-1-sign-up");
    // The main checkout stays on main.
    expect(gitOk(root, ["symbolic-ref", "--short", "HEAD"])).toBe("main");

    const after = await workspace.inspect(TARGET);
    expect(after).toMatchObject({
      branch: { commit: head, merged: true, storyBlob: blob },
      checkedOut: { atTarget: true },
      target: { exists: true },
    });
    expect(await workspace.create(TARGET, head)).toEqual({
      worktree,
      createdBranch: false,
      createdWorktree: false,
    });
  });

  it("carries the person's own layers of the skills' customisation into the new working copy", async () => {
    const root = await makeRepo();
    const folder = join(root, ".agentplugged/overrides/skills");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "write-prd.local.yaml"), "checks:\n  - Name the persona.\n");
    // The product's own layer is in Git, so the working copy has it already; only the personal ones are copied.
    await writeFile(join(folder, "write-prd.yaml"), "checks:\n  - Shared.\n");
    const workspace = new GitStoryWorkspace({ cwd: root });
    const head = gitOk(root, ["rev-parse", "HEAD"]);
    const { worktree } = await workspace.create(TARGET, head);
    expect(
      await readFile(join(worktree, ".agentplugged/overrides/skills/write-prd.local.yaml"), "utf8"),
    ).toBe("checks:\n  - Name the persona.\n");
    expect(existsSync(join(worktree, ".agentplugged/overrides/skills/write-prd.yaml"))).toBe(false);
  });

  it("adds the worktree again when its folder was deleted by hand", async () => {
    const root = await makeRepo();
    const workspace = new GitStoryWorkspace({ cwd: root });
    const head = gitOk(root, ["rev-parse", "HEAD"]);
    const { worktree } = await workspace.create(TARGET, head);
    await rm(worktree, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    expect(await workspace.inspect(TARGET)).toMatchObject({
      checkedOut: null,
      target: { exists: false },
    });
    expect(await workspace.create(TARGET, head)).toEqual({
      worktree,
      createdBranch: false,
      createdWorktree: true,
    });
    expect(existsSync(join(worktree, STORY))).toBe(true);
    expect(gitOk(worktree, ["symbolic-ref", "--short", "HEAD"])).toBe("feat/1-1-sign-up");
  });

  it("discards only what it created, and only without commits", async () => {
    const root = await makeRepo();
    const workspace = new GitStoryWorkspace({ cwd: root });
    const head = gitOk(root, ["rev-parse", "HEAD"]);
    const created = await workspace.create(TARGET, head);
    expect(await workspace.discard(TARGET, head, created)).toBe(true);
    expect(existsSync(created.worktree)).toBe(false);
    expect(
      git(root, ["rev-parse", "-q", "--verify", "refs/heads/feat/1-1-sign-up"]).status,
    ).not.toBe(0);
    const again = await workspace.create(TARGET, head);
    gitOk(again.worktree, ["commit", "-q", "--allow-empty", "--no-verify", "-m", "work"]);
    expect(await workspace.discard(TARGET, head, { ...again, createdWorktree: false })).toBe(false);
    expect(gitOk(root, ["rev-parse", "refs/heads/feat/1-1-sign-up"])).not.toBe(head);
  });

  it("sees a branch with commits of its own, and reads from a linked worktree too", async () => {
    const root = await makeRepo();
    const workspace = new GitStoryWorkspace({ cwd: root });
    const head = gitOk(root, ["rev-parse", "HEAD"]);
    const { worktree } = await workspace.create(TARGET, head);
    expect((await commitIn(worktree, "a.txt", "feat(1-1): form (EF-1)")).status).toBe(0);
    const inspected = await new GitStoryWorkspace({ cwd: worktree }).inspect(TARGET);
    expect(inspected).toMatchObject({
      branch: { merged: false },
      main: { ref: "main", commit: head },
      target: { relative: "../shop.worktrees/1-1" },
    });
  });

  it("checks story commits in a repository whose method sits in a subfolder", async () => {
    const root = await makeRepo("mono", "app/");
    const app = join(root, "app");
    const workspace = new GitStoryWorkspace({ cwd: app });
    const inspected = await workspace.inspect(TARGET);
    expect(inspected).toMatchObject({
      prefix: "app/",
      storyBlob: gitOk(root, ["rev-parse", `HEAD:app/${STORY}`]),
      target: { relative: "../mono.worktrees/1-1" },
    });
    const { worktree } = await workspace.create(TARGET, gitOk(root, ["rev-parse", "HEAD"]));
    expect(await workspace.installCommitHook(FILES)).toMatchObject({ status: "installed" });
    expect((await commitIn(worktree, "a.txt", "feat(1-1): form (EF-9)")).status).not.toBe(0);
    expect((await commitIn(worktree, "b.txt", "feat(1-1): form (EF-2)")).status).toBe(0);
  });

  it("installs the commit hook, which checks story commits only", async () => {
    const root = await makeRepo();
    const workspace = new GitStoryWorkspace({ cwd: root });
    const { worktree } = await workspace.create(TARGET, gitOk(root, ["rev-parse", "HEAD"]));
    expect(await workspace.installCommitHook(FILES)).toMatchObject({ status: "installed" });
    expect(await workspace.installCommitHook(FILES)).toMatchObject({ status: "unchanged" });
    expect(
      JSON.parse(await readFile(join(root, ".git", "agentplugged", "stories", "1-1.json"), "utf8")),
    ).toEqual({ id: "1-1", requirements: ["EF-1", "EF-2"] });

    const noStory = await commitIn(worktree, "a.txt", "feat: sign up form (EF-1)");
    expect(noStory.status).not.toBe(0);
    expect(noStory.stderr).toContain("1-1");
    expect(noStory.stderr).toContain("EF-1, EF-2");
    // The story file of the worktree is the agent's: editing it changes nothing.
    await writeFile(join(worktree, STORY), STORY_TEXT.replace("EF-2", "EF-9"));
    expect((await commitIn(worktree, "b.txt", "feat(1-1): sign up form (EF-9)")).status).not.toBe(
      0,
    );
    expect((await commitIn(worktree, "c.txt", "feat(1-12): sign up form (EF-1)")).status).not.toBe(
      0,
    );
    expect((await commitIn(worktree, "d.txt", "feat(1-1): sign up form (EF-2)")).status).toBe(0);
    // Elsewhere, any message.
    expect((await commitIn(root, "e.txt", "chore: tidy")).status).toBe(0);
    // A merge of main into the story's branch passes.
    expect(git(worktree, ["merge", "--no-ff", "-m", "Merge branch 'main'", "main"]).status).toBe(0);
    // The creator's escape hatch.
    await writeFile(join(worktree, "f.txt"), "f\n");
    gitOk(worktree, ["add", "-A"]);
    expect(git(worktree, ["commit", "-q", "--no-verify", "-m", "wip"]).status).toBe(0);
  });

  it("lets a story's commit cite the story alone once the creator skipped the traceability", async () => {
    const root = await makeRepo();
    const workspace = new GitStoryWorkspace({ cwd: root });
    const { worktree } = await workspace.create(TARGET, gitOk(root, ["rev-parse", "HEAD"]));
    await workspace.installCommitHook(FILES);
    expect((await commitIn(worktree, "a.txt", "feat(1-1): form")).status).not.toBe(0);
    // Skipped for another story: the check holds. Skipped for this one, or for every story: it
    // asks only for the story.
    await workspace.installCommitHook(commitHookFiles(undefined, ["1-2"]));
    expect((await commitIn(worktree, "b.txt", "feat(1-1): form")).status).not.toBe(0);
    await workspace.installCommitHook(commitHookFiles(undefined, ["1-1"]));
    expect(
      JSON.parse(await readFile(join(root, ".git", "agentplugged", "skips.json"), "utf8")),
    ).toEqual({ story_trace: ["1-1"] });
    expect((await commitIn(worktree, "c.txt", "feat: form")).status).not.toBe(0);
    expect((await commitIn(worktree, "d.txt", "feat(1-1): form")).status).toBe(0);
    // The story's own requirements are still read: refreshing the skips never rewrote them.
    expect(
      JSON.parse(await readFile(join(root, ".git", "agentplugged", "stories", "1-1.json"), "utf8")),
    ).toEqual({ id: "1-1", requirements: ["EF-1", "EF-2"] });
    await workspace.installCommitHook(commitHookFiles(undefined, []));
    expect((await commitIn(worktree, "e.txt", "feat(1-1): form")).status).not.toBe(0);
    await workspace.installCommitHook(commitHookFiles(undefined, true));
    expect((await commitIn(worktree, "f.txt", "feat(1-1): form")).status).toBe(0);
  });

  it("chains the creator's own hook instead of overwriting it", async () => {
    const root = await makeRepo();
    const hooks = join(root, ".git", "hooks");
    await mkdir(hooks, { recursive: true });
    const mine = '#!/bin/sh\necho ran >> "$(git rev-parse --git-common-dir)/mine.log"\n';
    await writeFile(join(hooks, "commit-msg"), mine, { mode: 0o755 });
    const workspace = new GitStoryWorkspace({ cwd: root });
    expect(await workspace.installCommitHook(FILES)).toMatchObject({ status: "chained" });
    expect(await readFile(join(hooks, CHAINED_HOOK_NAME), "utf8")).toBe(mine);
    expect(await workspace.installCommitHook(FILES)).toMatchObject({ status: "unchanged" });
    expect((await commitIn(root, "a.txt", "chore: tidy")).status).toBe(0);
    expect(await readFile(join(root, ".git", "mine.log"), "utf8")).toBe("ran\n");

    // Both names taken by the creator: nothing touched.
    await writeFile(join(hooks, "commit-msg"), mine, { mode: 0o755 });
    expect(await workspace.installCommitHook(FILES)).toMatchObject({
      status: "manual",
      reason: "taken",
    });
    expect(await readFile(join(hooks, "commit-msg"), "utf8")).toBe(mine);
  });

  it("never writes a hooks folder outside the Git folder", async () => {
    const root = await makeRepo();
    const shared = join(base, "shared-hooks");
    gitOk(root, ["config", "core.hooksPath", shared]);
    const installed = await new GitStoryWorkspace({ cwd: root }).installCommitHook(FILES);
    expect(installed).toMatchObject({ status: "manual", reason: "hooks_path" });
    expect(existsSync(join(shared, "commit-msg"))).toBe(false);
  });

  it("lists the story files at a branch's last commit, from the workspace root", async () => {
    const root = await makeRepo("shop", "app");
    gitOk(root, ["branch", "feat/1-1-sign-up"]);
    const worktree = join(base, "branch-copy");
    gitOk(root, ["worktree", "add", "-q", worktree, "feat/1-1-sign-up"]);
    const moved = join(worktree, "app", ".agentplugged", "stories", "nested", "sign up.md");
    await mkdir(dirname(moved), { recursive: true });
    gitOk(worktree, ["mv", join("app", STORY), moved]);
    await writeFile(join(worktree, "app", ".agentplugged", "stories", "notes.txt"), "x\n");
    gitOk(worktree, ["add", "-A"]);
    gitOk(worktree, ["commit", "-q", "-m", "move"]);
    const workspace = new GitStoryWorkspace({ cwd: join(root, "app") });
    const files = await workspace.storyFilesOn("feat/1-1-sign-up");
    expect(files?.map((file) => file.path)).toEqual([".agentplugged/stories/nested/sign up.md"]);
    const blob = files?.[0]?.blob ?? "";
    expect(await workspace.readBlob(blob)).toBe(STORY_TEXT);
    // No such branch, no repository: nothing to read.
    expect(await workspace.storyFilesOn("feat/9-9-none")).toBeUndefined();
    expect(await new GitStoryWorkspace({ cwd: base }).storyFilesOn("main")).toBeUndefined();
  });
});

describe("GitStoryWorkspace: the worktree of a merged story", () => {
  it("removes the story's own worktree, never forced, and keeps the branch", async () => {
    const root = await makeRepo();
    const workspace = new GitStoryWorkspace({ cwd: root });
    const head = gitOk(root, ["rev-parse", "HEAD"]);
    const { worktree } = await workspace.create(TARGET, head);
    await writeFile(join(worktree, "draft.txt"), "not committed\n");
    expect(await workspace.removeWorktree(TARGET)).toMatchObject({
      status: "kept",
      reason: "dirty",
      path: worktree,
    });
    expect(existsSync(worktree)).toBe(true);
    await rm(join(worktree, "draft.txt"));
    expect(await workspace.removeWorktree(TARGET)).toEqual({ status: "removed", path: worktree });
    expect(existsSync(worktree)).toBe(false);
    expect(gitOk(root, ["branch", "--list", TARGET.branch])).toContain(TARGET.branch);
    // Gone already: nothing to remove.
    expect((await workspace.removeWorktree(TARGET)).status).toBe("absent");
  });

  it("says a worktree deleted by hand is absent, and never touches another folder", async () => {
    const root = await makeRepo();
    const workspace = new GitStoryWorkspace({ cwd: root });
    const head = gitOk(root, ["rev-parse", "HEAD"]);
    const { worktree } = await workspace.create(TARGET, head);
    await rm(worktree, { recursive: true, force: true });
    expect((await workspace.removeWorktree(TARGET)).status).toBe("absent");
    gitOk(root, ["worktree", "prune"]);
    // The branch checked out in the main worktree (the creator's): kept.
    gitOk(root, ["checkout", "-q", TARGET.branch]);
    expect(await workspace.removeWorktree(TARGET)).toMatchObject({
      status: "kept",
      reason: "other_folder",
    });
  });

  it("keeps a folder whose branch is no longer checked out in it", async () => {
    const root = await makeRepo();
    const workspace = new GitStoryWorkspace({ cwd: root });
    const head = gitOk(root, ["rev-parse", "HEAD"]);
    const { worktree } = await workspace.create(TARGET, head);
    gitOk(worktree, ["checkout", "-q", "--detach"]);
    expect(await workspace.removeWorktree(TARGET)).toMatchObject({
      status: "kept",
      reason: "other_folder",
    });
    expect(existsSync(worktree)).toBe(true);
  });

  it("keeps the worktree the engine runs in", async () => {
    const root = await makeRepo();
    const head = gitOk(root, ["rev-parse", "HEAD"]);
    const { worktree } = await new GitStoryWorkspace({ cwd: root }).create(TARGET, head);
    expect(await new GitStoryWorkspace({ cwd: worktree }).removeWorktree(TARGET)).toMatchObject({
      status: "kept",
      reason: "in_use",
    });
  });

  it("follows the commits added on the forge: the remote branch strictly ahead only", async () => {
    const remote = join(base, "remote.git");
    const repo = join(base, "repo");
    const other = join(base, "other");
    await mkdir(repo, { recursive: true });
    gitOk(base, ["init", "-q", "--bare", "-b", "main", remote]);
    gitOk(repo, ["init", "-q", "-b", "main"]);
    for (const dir of [repo]) {
      gitOk(dir, ["config", "user.name", "Ada"]);
      gitOk(dir, ["config", "user.email", "ada@example.com"]);
    }
    await writeFile(join(repo, "a.txt"), "a\n");
    gitOk(repo, ["add", "-A"]);
    gitOk(repo, ["commit", "-q", "-m", "start"]);
    gitOk(repo, ["remote", "add", "origin", remote]);
    gitOk(repo, ["checkout", "-q", "-b", "feat/1-1-work"]);
    gitOk(repo, ["push", "-q", "origin", "main", "feat/1-1-work"]);
    const local = gitOk(repo, ["rev-parse", "HEAD"]);
    const workspace = new GitStoryWorkspace({ cwd: repo });
    // Nothing newer on the forge.
    expect(await workspace.remoteHead("feat/1-1-work", local, { fresh: true })).toBeUndefined();
    // The creator adds a commit on the forge (another clone stands for the web editor).
    gitOk(base, ["clone", "-q", remote, other]);
    gitOk(other, ["config", "user.name", "Ada"]);
    gitOk(other, ["config", "user.email", "ada@example.com"]);
    gitOk(other, ["checkout", "-q", "feat/1-1-work"]);
    await writeFile(join(other, "b.txt"), "b\n");
    gitOk(other, ["add", "-A"]);
    gitOk(other, ["commit", "-q", "-m", "on the forge"]);
    gitOk(other, ["push", "-q", "origin", "feat/1-1-work"]);
    const ahead = gitOk(other, ["rev-parse", "HEAD"]);
    expect(await workspace.remoteHead("feat/1-1-work", local, { fresh: true })).toBe(ahead);
    // Fetched into its remote-tracking reference only: the local branch did not move.
    expect(gitOk(repo, ["rev-parse", "feat/1-1-work"])).toBe(local);
    // Commits of its own that the forge lacks: diverged, the local head stands.
    await writeFile(join(repo, "c.txt"), "c\n");
    gitOk(repo, ["add", "-A"]);
    gitOk(repo, ["commit", "-q", "-m", "local"]);
    const diverged = gitOk(repo, ["rev-parse", "HEAD"]);
    expect(await workspace.remoteHead("feat/1-1-work", diverged, { fresh: true })).toBeUndefined();
    // No remote: nothing to follow, never an error.
    gitOk(repo, ["remote", "remove", "origin"]);
    expect(await workspace.remoteHead("feat/1-1-work", diverged, { fresh: true })).toBeUndefined();
  });
});

describe("the creator's Git workflow", () => {
  it("creates the integration branch from the main branch, never moves one that exists", async () => {
    const repo = await makeRepo();
    const workspace = new GitStoryWorkspace({ cwd: repo });
    const created = await workspace.ensureBranch?.("dev");
    expect(created?.status).toBe("created");
    expect(gitOk(repo, ["rev-parse", "dev"])).toBe(gitOk(repo, ["rev-parse", "main"]));
    expect((await workspace.ensureBranch?.("dev"))?.status).toBe("exists");
  });

  it("reads the stories' landing branch instead of the main branch", async () => {
    const repo = await makeRepo();
    gitOk(repo, ["branch", "dev"]);
    const workspace = new GitStoryWorkspace({ cwd: repo });
    const inspection = await workspace.inspect(TARGET, { base: "dev" });
    expect(inspection.repository && inspection.main?.ref).toBe("dev");
    const none = await workspace.inspect(TARGET, { base: "nowhere" });
    expect(none.repository && none.main).toBeNull();
  });

  it("detects a staging branch, story branches and merges of pull requests", async () => {
    const repo = await makeRepo();
    gitOk(repo, ["branch", "develop"]);
    gitOk(repo, ["branch", "feature/login"]);
    const detected = await new GitStoryWorkspace({ cwd: repo }).detectWorkflow?.();
    expect(detected).toMatchObject({ repository: true, main: "main", story_branches: 1 });
    expect(detected?.repository && detected.branches).toEqual(
      expect.arrayContaining(["develop", "feature/login", "main"]),
    );
  });

  it("merges a branch into another without a pull request, in a temporary folder when it is not checked out", async () => {
    const repo = await makeRepo();
    gitOk(repo, ["branch", "dev"]);
    gitOk(repo, ["checkout", "-b", "feat/x"]);
    await writeFile(join(repo, "x.txt"), "x\n");
    gitOk(repo, ["add", "."]);
    gitOk(repo, ["commit", "-m", "x"]);
    const head = gitOk(repo, ["rev-parse", "HEAD"]);
    gitOk(repo, ["checkout", "main"]);
    const workspace = new GitStoryWorkspace({ cwd: repo });
    const done = await workspace.mergeBranch?.({
      from: "feat/x",
      into: "dev",
      method: "merge",
      message: "Merge story 1-1",
      expect: head,
    });
    expect(done?.ok).toBe(true);
    expect(git(repo, ["merge-base", "--is-ancestor", head, "dev"]).status).toBe(0);
    // Main working folder untouched, no temporary folder left behind.
    expect(existsSync(join(repo, "x.txt"))).toBe(false);
    expect(gitOk(repo, ["worktree", "list"]).split("\n")).toHaveLength(1);
    // Again: dev already holds it.
    const again = await workspace.mergeBranch?.({
      from: "feat/x",
      into: "dev",
      method: "merge",
      message: "m",
    });
    expect(again).toMatchObject({ ok: true, merge_commit: null });
  });

  it("refuses a head that moved, a conflict and a dirty branch, changing nothing", async () => {
    const repo = await makeRepo();
    gitOk(repo, ["checkout", "-b", "feat/y"]);
    await writeFile(join(repo, "same.txt"), "story\n");
    gitOk(repo, ["add", "."]);
    gitOk(repo, ["commit", "-m", "y"]);
    gitOk(repo, ["checkout", "main"]);
    await writeFile(join(repo, "same.txt"), "main\n");
    gitOk(repo, ["add", "."]);
    gitOk(repo, ["commit", "-m", "main"]);
    const before = gitOk(repo, ["rev-parse", "main"]);
    const workspace = new GitStoryWorkspace({ cwd: repo });
    const moved = await workspace.mergeBranch?.({
      from: "feat/y",
      into: "main",
      method: "merge",
      message: "m",
      expect: "0".repeat(40),
    });
    expect(moved).toMatchObject({ ok: false, reason: "head_moved" });
    const conflict = await workspace.mergeBranch?.({
      from: "feat/y",
      into: "main",
      method: "merge",
      message: "m",
    });
    expect(conflict).toMatchObject({ ok: false, reason: "conflict" });
    expect(gitOk(repo, ["rev-parse", "main"])).toBe(before);
    expect(gitOk(repo, ["status", "--porcelain"])).toBe("");
    await writeFile(join(repo, "same.txt"), "dirty\n");
    const dirty = await workspace.mergeBranch?.({
      from: "feat/y",
      into: "main",
      method: "merge",
      message: "m",
    });
    expect(dirty).toMatchObject({ ok: false, reason: "base_dirty" });
  });

  it("commits the files it writes, only them, and leaves the working copy clean", async () => {
    const repo = await makeRepo();
    await mkdir(join(repo, "docs"), { recursive: true });
    await writeFile(join(repo, "docs/page.md"), "old\n");
    await writeFile(join(repo, "other.txt"), "other\n");
    gitOk(repo, ["add", "."]);
    gitOk(repo, ["commit", "-m", "pages"]);
    const workspace = new GitStoryWorkspace({ cwd: repo });
    // Something else is staged, and untracked files exist: neither goes into the commit.
    await writeFile(join(repo, "other.txt"), "other changed\n");
    gitOk(repo, ["add", "other.txt"]);
    await writeFile(join(repo, "untracked.txt"), "u\n");
    const before = gitOk(repo, ["rev-parse", "HEAD"]);
    const done = await workspace.commitFiles?.({
      branch: "main",
      files: [{ path: "docs/page.md", edit: (current) => `noticed\n${current}` }],
      message: "Documentation: late notices",
    });
    expect(done?.ok).toBe(true);
    expect(gitOk(repo, ["rev-parse", "HEAD"])).not.toBe(before);
    expect(gitOk(repo, ["show", "--name-only", "--format=%s", "HEAD"])).toBe(
      "Documentation: late notices\n\ndocs/page.md",
    );
    expect(await readFile(join(repo, "docs/page.md"), "utf8")).toBe("noticed\nold\n");
    // The file is clean; what was not ours is exactly as it was.
    expect(gitOk(repo, ["status", "--porcelain", "--", "docs/page.md"])).toBe("");
    expect(gitOk(repo, ["status", "--porcelain"])).toBe("M  other.txt\n?? untracked.txt");
  });

  it("commits in a story's worktree, on the story's branch, leaving both copies clean", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, "page.md"), "old\n");
    gitOk(repo, ["add", "."]);
    gitOk(repo, ["commit", "-m", "page"]);
    gitOk(repo, ["branch", "feat/1-1-work"]);
    const worktree = join(base, "shop.worktrees", "1-1");
    gitOk(repo, ["worktree", "add", worktree, "feat/1-1-work"]);
    const workspace = new GitStoryWorkspace({ cwd: repo });
    const mainHead = gitOk(repo, ["rev-parse", "main"]);
    const done = await workspace.commitFiles?.({
      branch: "feat/1-1-work",
      files: [{ path: "page.md", edit: (current) => `notice\n${current}` }],
      message: "Documentation: late notices",
    });
    expect(done?.ok).toBe(true);
    // The commit is on the story's branch only; the main branch and its copy are untouched.
    expect(gitOk(repo, ["rev-parse", "main"])).toBe(mainHead);
    expect(gitOk(repo, ["log", "-1", "--format=%s", "feat/1-1-work"])).toBe(
      "Documentation: late notices",
    );
    expect(await readFile(join(repo, "page.md"), "utf8")).toBe("old\n");
    expect(await readFile(join(worktree, "page.md"), "utf8")).toBe("notice\nold\n");
    expect(gitOk(repo, ["status", "--porcelain"])).toBe("");
    expect(gitOk(worktree, ["status", "--porcelain"])).toBe("");
  });

  it("commits the paths a sync wrote (changed, deleted, new), and the merge then finds the base clean", async () => {
    const repo = await makeRepo();
    await mkdir(join(repo, ".claude/skills/frame"), { recursive: true });
    await writeFile(join(repo, ".claude/skills/frame/SKILL.md"), "frame\n");
    await writeFile(join(repo, ".mcp.json"), "{}\n");
    await writeFile(join(repo, "mine.txt"), "mine\n");
    await writeFile(join(repo, ".gitignore"), "ignored.txt\n");
    gitOk(repo, ["add", "."]);
    gitOk(repo, ["commit", "-m", "installed"]);
    gitOk(repo, ["checkout", "-q", "-b", "feat/z"]);
    await writeFile(join(repo, "story.txt"), "story\n");
    gitOk(repo, ["add", "story.txt"]);
    gitOk(repo, ["commit", "-m", "story"]);
    gitOk(repo, ["checkout", "-q", "main"]);
    const workspace = new GitStoryWorkspace({ cwd: repo });
    // The phase changes: one file replaced, one removed, one added, one ignored; and a file of
    // the creator's own that the sync never wrote.
    await writeFile(join(repo, ".mcp.json"), '{"changed":true}\n');
    await rm(join(repo, ".claude/skills/frame"), { recursive: true });
    await mkdir(join(repo, ".claude/skills/build"), { recursive: true });
    await writeFile(join(repo, ".claude/skills/build/SKILL.md"), "build\n");
    await writeFile(join(repo, "ignored.txt"), "x\n");
    await writeFile(join(repo, "mine.txt"), "mine, edited\n");
    const paths = [
      ".mcp.json",
      ".claude/skills/frame/SKILL.md",
      ".claude/skills/build/SKILL.md",
      "ignored.txt",
    ];
    // Left as changes, they keep the base from taking the merge of a story.
    await writeFile(join(repo, "mine.txt"), "mine\n");
    const request = { from: "feat/z", into: "main", method: "merge" as const, message: "m" };
    expect(await workspace.mergeBranch?.(request)).toMatchObject({
      ok: false,
      reason: "base_dirty",
    });
    const done = await workspace.commitPaths?.({ branch: "main", paths, message: "Method: phase" });
    expect(done?.ok).toBe(true);
    expect(await workspace.mergeBranch?.(request)).toMatchObject({ ok: true });
    await writeFile(join(repo, "mine.txt"), "mine, edited\n");
    expect(
      gitOk(repo, ["show", "--name-status", "--format=%s", done?.ok ? done.commit : "x"]),
    ).toBe(
      "Method: phase\n\nA\t.claude/skills/build/SKILL.md\nD\t.claude/skills/frame/SKILL.md\nM\t.mcp.json",
    );
    // Only the sync's files: the creator's edit stays, the ignored file stays ignored.
    expect(gitOk(repo, ["status", "--porcelain"])).toBe("M mine.txt");
    // Nothing left to commit is a success and adds no commit.
    const head = gitOk(repo, ["rev-parse", "HEAD"]);
    expect((await workspace.commitPaths?.({ branch: "main", paths, message: "again" }))?.ok).toBe(
      true,
    );
    expect(gitOk(repo, ["rev-parse", "HEAD"])).toBe(head);
  });

  it("commits no path on another branch than the one checked out", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, "a.txt"), "a\n");
    gitOk(repo, ["add", "."]);
    gitOk(repo, ["commit", "-m", "a"]);
    await writeFile(join(repo, "a.txt"), "changed\n");
    const workspace = new GitStoryWorkspace({ cwd: repo });
    expect(
      await workspace.commitPaths?.({ branch: "dev", paths: ["a.txt"], message: "m" }),
    ).toMatchObject({ ok: false, reason: "not_current" });
    expect(gitOk(repo, ["status", "--porcelain"])).toBe("M a.txt");
    // No branch named: the main folder's own, and never from a story's worktree.
    gitOk(repo, ["branch", "feat/w"]);
    const worktree = join(base, "shop.worktrees", "w");
    gitOk(repo, ["worktree", "add", worktree, "feat/w"]);
    await writeFile(join(worktree, "a.txt"), "changed in the worktree\n");
    const inWorktree = new GitStoryWorkspace({ cwd: worktree });
    expect(await inWorktree.commitPaths?.({ paths: ["a.txt"], message: "m" })).toMatchObject({
      ok: false,
      reason: "not_current",
    });
    expect(await workspace.commitPaths?.({ paths: ["a.txt"], message: "m" })).toMatchObject({
      ok: true,
    });
    expect(gitOk(repo, ["status", "--porcelain"])).toBe("");
  });

  it("commits nothing on another branch, on a file with changes or not tracked", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, "page.md"), "old\n");
    gitOk(repo, ["add", "."]);
    gitOk(repo, ["commit", "-m", "page"]);
    const workspace = new GitStoryWorkspace({ cwd: repo });
    const head = gitOk(repo, ["rev-parse", "HEAD"]);
    const files = [{ path: "page.md", edit: () => "new\n" }];
    expect(await workspace.commitFiles?.({ branch: "dev", files, message: "m" })).toMatchObject({
      ok: false,
      reason: "not_current",
    });
    expect(
      await workspace.commitFiles?.({
        branch: "main",
        files: [{ path: "nope.md", edit: () => "x\n" }],
        message: "m",
      }),
    ).toMatchObject({ ok: false, reason: "dirty" });
    await writeFile(join(repo, "page.md"), "edited by hand\n");
    expect(await workspace.commitFiles?.({ branch: "main", files, message: "m" })).toMatchObject({
      ok: false,
      reason: "dirty",
    });
    expect(gitOk(repo, ["rev-parse", "HEAD"])).toBe(head);
    expect(await readFile(join(repo, "page.md"), "utf8")).toBe("edited by hand\n");
  });
});
