import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GitForge, type ToolRun, type ToolRunner } from "./index.js";

// Real Git processes and pushes to a bare repository on disk: slower than vitest's 5 s default.
vi.setConfig({ testTimeout: 120_000 });

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
  base = await realpath(await mkdtemp(join(tmpdir(), "agentplugged-gestures-")));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** A repository with its own identity and one commit on `main`; a bare remote beside it, empty. */
async function makeRepo(options: { remote?: boolean; branch?: string } = {}) {
  const remote = join(base, "origin.git");
  await mkdir(remote);
  gitOk(remote, ["init", "-q", "--bare", "-b", "main"]);
  const root = join(base, "shop");
  await mkdir(root, { recursive: true });
  gitOk(root, ["init", "-q", "-b", options.branch ?? "main"]);
  gitOk(root, ["config", "user.name", "Ada"]);
  gitOk(root, ["config", "user.email", "ada@example.com"]);
  gitOk(root, ["config", "core.autocrlf", "false"]);
  await writeFile(join(root, "README.md"), "shop\n");
  gitOk(root, ["add", "-A"]);
  gitOk(root, ["commit", "-q", "-m", "start"]);
  if (options.remote !== false) gitOk(root, ["remote", "add", "origin", remote]);
  return { root, remote, head: gitOk(root, ["rev-parse", "HEAD"]) };
}

/** Another clone of the remote, to move it ahead of the repository under test. */
async function clone(remote: string): Promise<string> {
  const other = join(base, "other");
  gitOk(base, ["clone", "-q", remote, "other"]);
  gitOk(other, ["config", "user.name", "Grace"]);
  gitOk(other, ["config", "user.email", "grace@example.com"]);
  gitOk(other, ["config", "core.autocrlf", "false"]);
  return other;
}

function fakeTool(answers: Record<string, Partial<ToolRun>>) {
  const calls: Array<{ command: string; args: readonly string[]; input?: string }> = [];
  const tool: ToolRunner = async (command, args, options) => {
    calls.push({ command, args, ...(options.input === undefined ? {} : { input: options.input }) });
    const key = `${command} ${args.slice(0, 2).join(" ")}`;
    const answer = answers[key] ?? answers[command] ?? { status: 0, stdout: "" };
    return { status: 0, stdout: "", stderr: "", ...answer };
  };
  return { tool, calls };
}

describe("GitForge.inspectMain", () => {
  it("reads the main branch and its commit, the remotes and the place of the folder", async () => {
    const { root, remote, head } = await makeRepo();
    const inspected = await new GitForge({ cwd: root }).inspectMain();
    expect(inspected).toMatchObject({ repository: true, prefix: "", branch: "main", head });
    expect(inspected.remotes).toEqual([{ name: "origin", url: remote }]);
  });

  it("reads master when there is no main, and nothing before the first commit", async () => {
    const { root, head } = await makeRepo({ branch: "master" });
    expect(await new GitForge({ cwd: root }).inspectMain()).toMatchObject({
      branch: "master",
      head,
    });
    const empty = join(base, "empty");
    await mkdir(empty);
    gitOk(empty, ["init", "-q", "-b", "main"]);
    expect(await new GitForge({ cwd: empty }).inspectMain()).toMatchObject({
      repository: true,
      branch: null,
      head: null,
    });
  });

  it("says when the folder is no repository", async () => {
    const folder = join(base, "plain");
    await mkdir(folder);
    expect(await new GitForge({ cwd: folder }).inspectMain()).toEqual({ repository: false });
  });
});

describe("GitForge.remoteBranch and pushMain", () => {
  it("finds an empty remote, then pushes the commit to it, then finds it the same", async () => {
    const { root, head } = await makeRepo();
    const forge = new GitForge({ cwd: root });
    expect(await forge.remoteBranch("origin", "main", head)).toEqual({ state: "missing" });
    expect(await forge.pushMain("origin", "main", head)).toEqual({ ok: true });
    expect(gitOk(root, ["ls-remote", "origin", "refs/heads/main"])).toContain(head);
    expect(await forge.remoteBranch("origin", "main", head)).toEqual({ state: "same", head });
    // The branch now follows the remote's.
    expect(gitOk(root, ["rev-parse", "--abbrev-ref", "main@{upstream}"])).toBe("origin/main");
  });

  it("pushes the commit named, never the branch as it is now", async () => {
    const { root, head } = await makeRepo();
    await writeFile(join(root, "more.md"), "more\n");
    gitOk(root, ["add", "-A"]);
    gitOk(root, ["commit", "-q", "-m", "more"]);
    const forge = new GitForge({ cwd: root });
    expect(await forge.pushMain("origin", "main", head)).toEqual({ ok: true });
    expect(gitOk(root, ["ls-remote", "origin", "refs/heads/main"])).toContain(head);
  });

  it("finds a remote that is behind: a fast-forward", async () => {
    const { root, head } = await makeRepo();
    const forge = new GitForge({ cwd: root });
    await forge.pushMain("origin", "main", head);
    await writeFile(join(root, "more.md"), "more\n");
    gitOk(root, ["add", "-A"]);
    gitOk(root, ["commit", "-q", "-m", "more"]);
    const next = gitOk(root, ["rev-parse", "HEAD"]);
    expect(await forge.remoteBranch("origin", "main", next)).toEqual({ state: "behind", head });
    expect(await forge.pushMain("origin", "main", next)).toEqual({ ok: true });
  });

  it("finds a remote that is ahead, fetching what it holds, and never pushes over it", async () => {
    const { root, remote, head } = await makeRepo();
    const forge = new GitForge({ cwd: root });
    await forge.pushMain("origin", "main", head);
    const other = await clone(remote);
    await writeFile(join(other, "theirs.md"), "theirs\n");
    gitOk(other, ["add", "-A"]);
    gitOk(other, ["commit", "-q", "-m", "theirs"]);
    gitOk(other, ["push", "-q", "origin", "main"]);
    const theirs = gitOk(other, ["rev-parse", "HEAD"]);
    expect(await forge.remoteBranch("origin", "main", head)).toEqual({
      state: "ahead",
      head: theirs,
    });
    // Nothing moved here: the objects were fetched, no branch and no working tree changed.
    expect(gitOk(root, ["rev-parse", "HEAD"])).toBe(head);
    expect(gitOk(root, ["status", "--porcelain"])).toBe("");
    // A push of the older commit is refused by Git itself: never forced.
    const refused = await forge.pushMain("origin", "main", head);
    expect(refused).toMatchObject({ ok: false, reason: "push_rejected" });
    expect(gitOk(root, ["ls-remote", "origin", "refs/heads/main"])).toContain(theirs);
  });

  it("finds a remote that diverged", async () => {
    const { root, remote, head } = await makeRepo();
    const forge = new GitForge({ cwd: root });
    await forge.pushMain("origin", "main", head);
    const other = await clone(remote);
    await writeFile(join(other, "theirs.md"), "theirs\n");
    gitOk(other, ["add", "-A"]);
    gitOk(other, ["commit", "-q", "-m", "theirs"]);
    gitOk(other, ["push", "-q", "origin", "main"]);
    await writeFile(join(root, "mine.md"), "mine\n");
    gitOk(root, ["add", "-A"]);
    gitOk(root, ["commit", "-q", "-m", "mine"]);
    const mine = gitOk(root, ["rev-parse", "HEAD"]);
    expect(await forge.remoteBranch("origin", "main", mine)).toMatchObject({ state: "diverged" });
    expect(await forge.pushMain("origin", "main", mine)).toMatchObject({
      ok: false,
      reason: "push_rejected",
    });
  });

  it("says a remote it cannot reach, without throwing", async () => {
    const { root, head } = await makeRepo();
    gitOk(root, ["remote", "set-url", "origin", join(base, "nowhere.git")]);
    const forge = new GitForge({ cwd: root });
    expect(await forge.remoteBranch("origin", "main", head)).toMatchObject({ state: "unreadable" });
    expect(await forge.pushMain("origin", "main", head)).toMatchObject({ ok: false });
  });

  it("refuses a remote, a branch or a commit that Git could read as an option", async () => {
    const { root, head } = await makeRepo();
    const forge = new GitForge({ cwd: root });
    expect(await forge.pushMain("--mirror", "main", head)).toMatchObject({ ok: false });
    expect(await forge.pushMain("origin", "-f", head)).toMatchObject({ ok: false });
    expect(await forge.pushMain("origin", "HEAD", head)).toMatchObject({ ok: false });
    expect(await forge.pushMain("origin", "main", "--force")).toMatchObject({ ok: false });
    expect(await forge.pushMain("origin", "main;rm", head)).toMatchObject({ ok: false });
    expect(await forge.remoteBranch("-x", "main", head)).toMatchObject({ state: "unreadable" });
    expect(await forge.remoteBranch("origin", "--x", head)).toMatchObject({ state: "unreadable" });
    expect(gitOk(root, ["ls-remote", "origin"])).toBe("");
  });

  it("never passes a force option to git push", async () => {
    const { root, head } = await makeRepo();
    const seen: string[][] = [];
    const forge = new GitForge({
      cwd: root,
      run: async (cwd, args, input, env, timeout) => {
        seen.push([...args]);
        const { runGit } = await import("./git-process.js");
        return runGit(cwd, args, input, env, timeout);
      },
    });
    await forge.pushMain("origin", "main", head);
    const pushes = seen.filter((args) => args[0] === "push");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toEqual(["push", "--porcelain", "origin", `${head}:refs/heads/main`]);
    expect(pushes[0]?.join(" ")).not.toMatch(/force|-f\b|\+/);
  });
});

describe("GitForge.createRepository", () => {
  it("creates a private GitHub repository with gh, adding origin, and pushes nothing", async () => {
    const { root } = await makeRepo({ remote: false });
    const { tool, calls } = fakeTool({});
    const forge = new GitForge({
      cwd: root,
      tool: async (command, args, options) => {
        const answer = await tool(command, args, options);
        // gh adds the remote itself (`--remote=origin`): the fake does what the real one does.
        if (command === "gh" && args[0] === "repo") {
          gitOk(root, ["remote", "add", "origin", "https://github.com/ada/shop.git"]);
        }
        return answer;
      },
    });
    const created = await forge.createRepository({
      forge: "github",
      host: "github.com",
      name: "shop",
      visibility: "private",
    });
    expect(created).toEqual({
      ok: true,
      remote: { name: "origin", url: "https://github.com/ada/shop.git" },
    });
    expect(calls).toEqual([
      {
        command: "gh",
        args: ["repo", "create", "shop", "--private", "--source=.", "--remote=origin"],
      },
    ]);
    expect(calls[0]?.args.join(" ")).not.toContain("--push");
  });

  it("creates a public repository only when asked, under the owner given", async () => {
    const { root } = await makeRepo({ remote: false });
    const { tool, calls } = fakeTool({});
    await new GitForge({ cwd: root, tool }).createRepository({
      forge: "github",
      host: "github.com",
      owner: "acme",
      name: "shop",
      visibility: "public",
    });
    expect(calls[0]?.args).toEqual([
      "repo",
      "create",
      "acme/shop",
      "--public",
      "--source=.",
      "--remote=origin",
    ]);
  });

  it("says a name already taken, and any other refusal, with the tool's line", async () => {
    const { root } = await makeRepo({ remote: false });
    const taken = fakeTool({
      gh: { status: 1, stderr: "GraphQL: Name already exists on this account (createRepository)" },
    });
    expect(
      await new GitForge({ cwd: root, tool: taken.tool }).createRepository({
        forge: "github",
        host: "github.com",
        name: "shop",
        visibility: "private",
      }),
    ).toMatchObject({ ok: false, reason: "exists" });
    const refused = fakeTool({ gh: { status: 1, stderr: "HTTP 403: forbidden" } });
    expect(
      await new GitForge({ cwd: root, tool: refused.tool }).createRepository({
        forge: "github",
        host: "github.com",
        name: "shop",
        visibility: "private",
      }),
    ).toMatchObject({ ok: false, reason: "failed", message: "HTTP 403: forbidden" });
  });

  it("creates a GitLab repository through the API, in the group asked, then adds origin", async () => {
    const { root } = await makeRepo({ remote: false });
    const { tool, calls } = fakeTool({
      "glab api --hostname": { status: 0, stdout: '{"id": 42}' },
    });
    const forge = new GitForge({
      cwd: root,
      tool: async (command, args, options) => {
        if (args.includes("projects")) {
          calls.push({
            command,
            args,
            ...(options.input === undefined ? {} : { input: options.input }),
          });
          return {
            status: 0,
            stdout: JSON.stringify({ http_url_to_repo: "https://gitlab.com/team/shop.git" }),
            stderr: "",
          };
        }
        return tool(command, args, options);
      },
    });
    const created = await forge.createRepository({
      forge: "gitlab",
      host: "gitlab.com",
      owner: "team",
      name: "shop",
      visibility: "private",
    });
    expect(created).toEqual({
      ok: true,
      remote: { name: "origin", url: "https://gitlab.com/team/shop.git" },
    });
    const post = calls.find((call) => call.args.includes("projects"));
    expect(JSON.parse(post?.input ?? "{}")).toEqual({
      name: "shop",
      path: "shop",
      visibility: "private",
      namespace_id: 42,
    });
    expect(gitOk(root, ["remote", "get-url", "origin"])).toBe("https://gitlab.com/team/shop.git");
  });

  it("throws when the forge's tool is not installed", async () => {
    const { root } = await makeRepo({ remote: false });
    const { tool } = fakeTool({ gh: { status: null, missing: true, stderr: "gh: not found" } });
    await expect(
      new GitForge({ cwd: root, tool }).createRepository({
        forge: "github",
        host: "github.com",
        name: "shop",
        visibility: "private",
      }),
    ).rejects.toThrow(/not installed/);
  });
});
