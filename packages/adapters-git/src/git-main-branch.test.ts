import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GitMainBranchReader } from "./index.js";

// Real Git processes: slower than vitest's 5 s default under a full test run.
vi.setConfig({ testTimeout: 120_000 });

const PATH = ".agentplugged/method.yaml";

/** Runs git in a test repository; never in this one, never on the network. */
function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
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
  base = await mkdtemp(join(tmpdir(), "agentplugged-main-branch-"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** A repository with its own identity (Ada), never the creator's. */
function makeRepo(path: string, branch = "main"): string {
  git(path, ["init", "-q", "-b", branch]);
  git(path, ["config", "user.name", "Ada"]);
  git(path, ["config", "user.email", "ada@example.com"]);
  git(path, ["config", "core.autocrlf", "false"]);
  return path;
}

async function commit(root: string, text: string, message = "rules") {
  await mkdir(dirname(join(root, PATH)), { recursive: true });
  await writeFile(join(root, PATH), text);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", message]);
}

describe("GitMainBranchReader", () => {
  it("says there is no repository outside Git", async () => {
    expect(await new GitMainBranchReader({ cwd: base }).read(PATH)).toEqual({
      found: false,
      reason: "no_repository",
    });
  });

  it("reads main, not the working branch nor the working copy", async () => {
    const repo = makeRepo(base);
    await commit(repo, "rules:\n  internet: ask\n");
    git(repo, ["switch", "-q", "-c", "feature/x"]);
    await commit(repo, "rules:\n  internet: allow\n");
    await writeFile(join(repo, PATH), "rules:\n  internet: deny\n");
    expect(await new GitMainBranchReader({ cwd: repo }).read(PATH)).toEqual({
      found: true,
      branch: "main",
      text: "rules:\n  internet: ask\n",
    });
  });

  it("follows the remote's default branch first", async () => {
    const repo = makeRepo(base, "trunk");
    await commit(repo, "rules:\n  internet: deny\n");
    git(repo, ["switch", "-q", "-c", "main"]);
    await commit(repo, "rules:\n  internet: allow\n");
    // A remote-tracking default branch, set by hand: nothing is fetched.
    const trunk = git(repo, ["rev-parse", "trunk"]);
    git(repo, ["update-ref", "refs/remotes/origin/trunk", trunk]);
    git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"]);
    const read = await new GitMainBranchReader({ cwd: repo }).read(PATH);
    expect(read).toEqual({
      found: true,
      branch: "origin/trunk",
      text: "rules:\n  internet: deny\n",
    });
  });

  it("falls back to master, and says when the main branch has no such file", async () => {
    const repo = makeRepo(base, "master");
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "src", "a.ts"), "export {};\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "code"]);
    expect(await new GitMainBranchReader({ cwd: repo }).read(PATH)).toEqual({
      found: true,
      branch: "master",
      text: undefined,
    });
  });

  it("names the current branch when there is no main branch", async () => {
    const repo = makeRepo(base, "feature/y");
    expect(await new GitMainBranchReader({ cwd: repo }).read(PATH)).toEqual({
      found: false,
      reason: "no_main_branch",
      current: "feature/y",
    });
    await commit(repo, "rules: {}\n");
    expect(await new GitMainBranchReader({ cwd: repo }).read(PATH)).toEqual({
      found: false,
      reason: "no_main_branch",
      current: "feature/y",
    });
  });

  it("reads the product's file from a subfolder of the repository", async () => {
    const repo = makeRepo(base);
    const product = join(repo, "apps", "shop");
    await mkdir(join(product, ".agentplugged"), { recursive: true });
    await writeFile(join(product, PATH), "rules:\n  internet: deny\n");
    // A file of the same name at the top must not be taken for the product's.
    await mkdir(join(repo, ".agentplugged"), { recursive: true });
    await writeFile(join(repo, PATH), "rules:\n  internet: allow\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "products"]);
    expect(await new GitMainBranchReader({ cwd: product }).read(PATH)).toEqual({
      found: true,
      branch: "main",
      text: "rules:\n  internet: deny\n",
    });
  });

  it("reads the local main when it only goes on from origin/main, and says how many commits are not published", async () => {
    const repo = makeRepo(base);
    await commit(repo, "rules:\n  internet: ask\n");
    git(repo, ["update-ref", "refs/remotes/origin/main", git(repo, ["rev-parse", "main"])]);
    // A commit on the local main (the creator's settings, recorded by the engine)
    // applies at once, without waiting for a push the agents cannot do.
    await commit(repo, "rules:\n  internet: allow\n", "settings");
    expect(await new GitMainBranchReader({ cwd: repo }).read(PATH)).toEqual({
      found: true,
      branch: "main",
      text: "rules:\n  internet: allow\n",
      unpublished: { remote: "origin/main", ahead: 1 },
    });
  });

  it("prefers origin/main when the local main diverged from it, and says so", async () => {
    const repo = makeRepo(base);
    await commit(repo, "rules:\n  internet: ask\n");
    const shared = git(repo, ["rev-parse", "main"]);
    await commit(repo, "rules:\n  internet: allow\n", "local");
    const local = git(repo, ["rev-parse", "main"]);
    git(repo, ["checkout", "-q", "-b", "other", shared]);
    await commit(repo, "rules:\n  internet: deny\n", "remote");
    git(repo, ["update-ref", "refs/remotes/origin/main", git(repo, ["rev-parse", "HEAD"])]);
    git(repo, ["checkout", "-q", "main"]);
    expect(git(repo, ["rev-parse", "main"])).toBe(local);
    expect(await new GitMainBranchReader({ cwd: repo }).read(PATH)).toEqual({
      found: true,
      branch: "origin/main",
      text: "rules:\n  internet: deny\n",
      local: { branch: "main", ahead: 1, behind: 1 },
    });
  });

  it("reads origin/main when there is no local main", async () => {
    const repo = makeRepo(base, "feature/z");
    await commit(repo, "rules:\n  internet: deny\n");
    git(repo, ["update-ref", "refs/remotes/origin/main", git(repo, ["rev-parse", "HEAD"])]);
    await commit(repo, "rules:\n  internet: allow\n", "feature");
    expect(await new GitMainBranchReader({ cwd: repo }).read(PATH)).toEqual({
      found: true,
      branch: "origin/main",
      text: "rules:\n  internet: deny\n",
    });
  });

  it("treats Git missing or refusing the folder as no repository, and throws on a timeout", async () => {
    const missing = new GitMainBranchReader({
      cwd: base,
      run: async () => {
        throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
      },
    });
    expect(await missing.read(PATH)).toEqual({ found: false, reason: "no_repository" });
    const dubious = new GitMainBranchReader({
      cwd: base,
      run: async () => ({
        status: 128,
        stdout: Buffer.alloc(0),
        stderr: "fatal: detected dubious ownership in repository at '/x'\nTo add an exception…",
      }),
    });
    expect(await dubious.read(PATH)).toEqual({
      found: false,
      reason: "no_repository",
      refused: "fatal: detected dubious ownership in repository at '/x'",
    });
    const slow = new GitMainBranchReader({
      cwd: base,
      run: async (_cwd, args) => ({
        status: null,
        stdout: Buffer.alloc(0),
        stderr: `fatal: git ${args[0]} took more than 15 s`,
        timedOut: true,
      }),
    });
    await expect(slow.read(PATH)).rejects.toThrow(/took more than 15 s/);
    // The whole read is capped too.
    let clock = 0;
    const capped = new GitMainBranchReader({
      cwd: base,
      now: () => clock,
      run: async () => {
        clock += 31_000;
        return { status: 0, stdout: Buffer.from(""), stderr: "" };
      },
    });
    await expect(capped.read(PATH)).rejects.toThrow(/within 30 s/);
  });
});
