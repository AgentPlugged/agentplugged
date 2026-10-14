import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ForgeRepository, PullRequestDraft } from "@agentplugged/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cmdArgument,
  createdPullRequest,
  GitForge,
  resolveCommand,
  runTool,
  type ToolRun,
  type ToolRunner,
  toolEnv,
} from "./index.js";

// Real Git processes and pushes to a bare repository on disk: slower than vitest's 5 s default.
vi.setConfig({ testTimeout: 120_000 });

const BRANCH = "feat/1-1-sign-up";
const GITHUB: ForgeRepository = { forge: "github", host: "github.com", path: "ada/shop" };
const GITLAB: ForgeRepository = { forge: "gitlab", host: "gitlab.com", path: "team/sub/shop" };
const DRAFT: PullRequestDraft = {
  base: "main",
  branch: BRANCH,
  title: "Sign up (1-1)",
  body: "## Story\n\n**1-1 — Sign up**\n",
};

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
  base = await realpath(await mkdtemp(join(tmpdir(), "agentplugged-forge-")));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** A repository with its own identity (Ada), a bare `origin` on disk, and the story's branch. */
async function makeRepo(): Promise<{ root: string; remote: string }> {
  const remote = join(base, "origin.git");
  await mkdir(remote);
  gitOk(remote, ["init", "-q", "--bare", "-b", "main"]);
  const root = join(base, "shop");
  await mkdir(join(root, "app"), { recursive: true });
  gitOk(root, ["init", "-q", "-b", "main"]);
  gitOk(root, ["config", "user.name", "Ada"]);
  gitOk(root, ["config", "user.email", "ada@example.com"]);
  gitOk(root, ["config", "core.autocrlf", "false"]);
  await writeFile(join(root, "app", "README.md"), "shop\n");
  gitOk(root, ["add", "-A"]);
  gitOk(root, ["commit", "-q", "-m", "start"]);
  gitOk(root, ["remote", "add", "origin", remote]);
  gitOk(root, ["push", "-q", "origin", "main"]);
  gitOk(root, ["branch", BRANCH]);
  return { root, remote };
}

/** A fake `gh` or `glab`: answers from a table, records every call. Never the real tools. */
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

describe("GitForge", () => {
  it("reads the workspace's place, the address Git pushes to, the branch and its own commits", async () => {
    const { root, remote } = await makeRepo();
    gitOk(root, ["remote", "add", "fork", "https://ada:s3cret@github.com/ada-fork/shop.git"]);
    // Fetches from GitHub, pushes to a mirror: the push address is the one read.
    gitOk(root, ["remote", "add", "mirror", "https://github.com/ada/shop.git"]);
    gitOk(root, ["config", "remote.mirror.pushurl", "https://git.example.org/ada/shop.git"]);
    gitOk(root, ["config", "url.https://gitlab.com/.pushInsteadOf", "https://redirect.example/"]);
    gitOk(root, ["remote", "add", "moved", "https://redirect.example/team/shop.git"]);
    const forge = new GitForge({ cwd: join(root, "app") });
    const main = gitOk(root, ["rev-parse", "main"]);
    const inspection = await forge.inspect(BRANCH, main);
    if (!inspection.repository) throw new Error("no repository");
    expect(inspection.prefix).toBe("app/");
    expect(inspection.head).toBe(main);
    expect(inspection.commits).toBe(0);
    expect(inspection.remotes).toEqual(
      expect.arrayContaining([
        { name: "origin", url: remote },
        { name: "fork", url: "https://ada:s3cret@github.com/ada-fork/shop.git" },
        { name: "mirror", url: "https://git.example.org/ada/shop.git" },
        { name: "moved", url: "https://gitlab.com/team/shop.git" },
      ]),
    );
    gitOk(root, ["checkout", "-q", BRANCH]);
    await writeFile(join(root, "a.txt"), "a\n");
    gitOk(root, ["add", "-A"]);
    gitOk(root, ["commit", "-q", "-m", "feat(1-1): a (EF-1)"]);
    expect(await forge.inspect(BRANCH, main)).toMatchObject({ commits: 1 });
    // A base this clone does not hold: the commits cannot be counted.
    expect(await forge.inspect(BRANCH, "f".repeat(40))).toMatchObject({ commits: null });
    expect(await forge.inspect("feat/9-9-none", main)).toMatchObject({
      repository: true,
      head: null,
      commits: null,
    });
    const outside = join(base, "outside");
    await mkdir(outside);
    expect(await new GitForge({ cwd: outside }).inspect(BRANCH, main)).toEqual({
      repository: false,
    });
  });

  it("pushes the story's branch under its own name, never forced, never the target branch", async () => {
    const { root, remote } = await makeRepo();
    const forge = new GitForge({ cwd: root });
    gitOk(root, ["checkout", "-q", BRANCH]);
    await writeFile(join(root, "a.txt"), "a\n");
    gitOk(root, ["add", "-A"]);
    gitOk(root, ["commit", "-q", "-m", "feat(1-1): a (EF-1)"]);
    expect(await forge.push("origin", BRANCH, "main")).toEqual({ ok: true });
    expect(gitOk(remote, ["rev-parse", BRANCH])).toBe(gitOk(root, ["rev-parse", BRANCH]));
    expect(gitOk(remote, ["rev-parse", "main"])).toBe(gitOk(root, ["rev-parse", "main"]));

    // The remote moved on: refused, never forced.
    const other = join(base, "other");
    gitOk(base, ["clone", "-q", remote, other]);
    gitOk(other, ["config", "user.name", "Ada"]);
    gitOk(other, ["config", "user.email", "ada@example.com"]);
    gitOk(other, ["checkout", "-q", BRANCH]);
    await writeFile(join(other, "b.txt"), "b\n");
    gitOk(other, ["add", "-A"]);
    gitOk(other, ["commit", "-q", "-m", "feat(1-1): b (EF-1)"]);
    gitOk(other, ["push", "-q", "origin", BRANCH]);
    await writeFile(join(root, "c.txt"), "c\n");
    gitOk(root, ["add", "-A"]);
    gitOk(root, ["commit", "-q", "-m", "feat(1-1): c (EF-1)"]);
    expect(await forge.push("origin", BRANCH, "main")).toMatchObject({
      ok: false,
      reason: "push_rejected",
    });

    // The remote's own hook refuses: not a matter of fetching first.
    await writeFile(
      join(remote, "hooks", "pre-receive"),
      "#!/bin/sh\necho protected >&2\nexit 1\n",
      {
        mode: 0o755,
      },
    );
    gitOk(root, ["branch", "feat/1-2-other"]);
    expect(await forge.push("origin", "feat/1-2-other", "main")).toMatchObject({
      ok: false,
      reason: "push_failed",
    });

    expect(await forge.push("nowhere", BRANCH, "main")).toMatchObject({
      ok: false,
      reason: "push_failed",
    });
    for (const [branch, target] of [
      ["main", "main"],
      ["master", "main"],
      ["HEAD", "main"],
      ["--force", "main"],
      ["trunk", "trunk"],
    ] as const) {
      expect(await forge.push("origin", branch, target), branch).toMatchObject({
        ok: false,
        reason: "push_failed",
        message: `refused to push ${branch}`,
      });
    }
    expect(gitOk(remote, ["rev-parse", "main"])).toBe(gitOk(root, ["rev-parse", "main"]));
  });

  it("knows whether the forge's tool is installed and logged in, and says when it does not answer", async () => {
    const { root } = await makeRepo();
    const ready = fakeTool({});
    expect(await new GitForge({ cwd: root, tool: ready.tool }).cli(GITHUB)).toBe("ready");
    expect(ready.calls.map((call) => [call.command, ...call.args])).toEqual([
      ["gh", "--version"],
      ["gh", "auth", "status", "--hostname", "github.com"],
    ]);
    const missing = fakeTool({ glab: { status: null, missing: true } });
    expect(await new GitForge({ cwd: root, tool: missing.tool }).cli(GITLAB)).toBe("missing");
    const out = fakeTool({ "gh auth status": { status: 1, stderr: "You are not logged in" } });
    expect(await new GitForge({ cwd: root, tool: out.tool }).cli(GITHUB)).toBe("logged_out");
    const slow = fakeTool({ "gh auth status": { status: null, timedOut: true } });
    await expect(new GitForge({ cwd: root, tool: slow.tool }).cli(GITHUB)).rejects.toThrow(
      "gh auth status: timed out after 120 s",
    );
    const stuck = fakeTool({ "gh pr list": { status: null, timedOut: true } });
    await expect(
      new GitForge({ cwd: root, tool: stuck.tool }).pullRequests(GITHUB, BRANCH),
    ).rejects.toThrow("gh pr list: timed out");
  });

  it("lists, creates and updates a GitHub pull request with gh, the text on standard input, never a fork's", async () => {
    const { root } = await makeRepo();
    const own = { headRepositoryOwner: { login: "Ada" }, isCrossRepository: false };
    const { tool, calls } = fakeTool({
      "gh pr list": {
        stdout: JSON.stringify([
          {
            number: 3,
            url: "https://github.com/ada/shop/pull/3",
            state: "MERGED",
            title: "t",
            body: "b",
            ...own,
          },
          {
            number: 4,
            url: "https://github.com/ada/shop/pull/4",
            state: "OPEN",
            title: "t",
            body: "b",
            ...own,
          },
          {
            number: 6,
            url: "https://github.com/ada/shop/pull/6",
            state: "OPEN",
            title: "fork",
            body: "",
            headRepositoryOwner: { login: "mallory" },
            isCrossRepository: true,
          },
          { number: "x", url: 1, state: "OPEN", ...own },
        ]),
      },
      "gh pr create": { stdout: "Creating pull request\nhttps://github.com/ada/shop/pull/5\n" },
    });
    const forge = new GitForge({ cwd: root, tool });
    expect(await forge.pullRequests(GITHUB, BRANCH)).toEqual([
      {
        number: 3,
        url: "https://github.com/ada/shop/pull/3",
        state: "merged",
        title: "t",
        body: "b",
      },
      {
        number: 4,
        url: "https://github.com/ada/shop/pull/4",
        state: "open",
        title: "t",
        body: "b",
      },
    ]);
    expect(await forge.create(GITHUB, DRAFT)).toEqual({
      number: 5,
      url: "https://github.com/ada/shop/pull/5",
    });
    await forge.update(GITHUB, 5, DRAFT);
    expect(calls.map((call) => [call.command, ...call.args])).toEqual([
      [
        "gh",
        "pr",
        "list",
        "--repo",
        "github.com/ada/shop",
        "--head",
        BRANCH,
        "--state",
        "all",
        "--json",
        "number,url,state,title,body,headRepositoryOwner,isCrossRepository",
        "--limit",
        "50",
      ],
      [
        "gh",
        "pr",
        "create",
        "--repo",
        "github.com/ada/shop",
        "--base",
        "main",
        "--head",
        BRANCH,
        "--title",
        "Sign up (1-1)",
        "--body-file",
        "-",
      ],
      [
        "gh",
        "pr",
        "edit",
        "5",
        "--repo",
        "github.com/ada/shop",
        "--title",
        "Sign up (1-1)",
        "--base",
        "main",
        "--body-file",
        "-",
      ],
    ]);
    expect(calls[1]?.input).toBe(DRAFT.body);
    expect(calls[2]?.input).toBe(DRAFT.body);
    for (const call of calls) {
      expect(call.args[0]).not.toBe("api");
      expect(call.args.join(" ")).not.toMatch(/merge|token/);
    }
  });

  it("lists GitLab merge requests with glab, and creates or updates one with the text on standard input", async () => {
    const { root } = await makeRepo();
    const project = { source_project_id: 7, target_project_id: 7 };
    const { tool, calls } = fakeTool({
      "glab mr list": {
        stdout: JSON.stringify([
          {
            iid: 8,
            web_url: "https://gitlab.com/team/sub/shop/-/merge_requests/8",
            state: "opened",
            title: "t",
            description: "d",
            ...project,
          },
          {
            iid: 2,
            web_url: "https://gitlab.com/team/sub/shop/-/merge_requests/2",
            state: "closed",
            title: "t",
            description: null,
            ...project,
          },
          {
            iid: 4,
            web_url: "https://gitlab.com/team/sub/shop/-/merge_requests/4",
            state: "opened",
            title: "fork",
            source_project_id: 99,
            target_project_id: 7,
          },
        ]),
      },
      "glab api --hostname": {
        stdout: JSON.stringify({
          iid: 9,
          web_url: "https://gitlab.com/team/sub/shop/-/merge_requests/9",
        }),
      },
    });
    const forge = new GitForge({ cwd: root, tool });
    expect(await forge.pullRequests(GITLAB, BRANCH)).toEqual([
      {
        number: 8,
        url: "https://gitlab.com/team/sub/shop/-/merge_requests/8",
        state: "open",
        title: "t",
        body: "d",
      },
      {
        number: 2,
        url: "https://gitlab.com/team/sub/shop/-/merge_requests/2",
        state: "closed",
        title: "t",
        body: "",
      },
    ]);
    // A text far beyond Windows' 32 767-character command line: on standard input only.
    const long = { ...DRAFT, body: `${"x".repeat(100_000)}\n` };
    expect(await forge.create(GITLAB, long)).toEqual({
      number: 9,
      url: "https://gitlab.com/team/sub/shop/-/merge_requests/9",
    });
    await forge.update(GITLAB, 9, long);
    expect(calls.map((call) => [call.command, ...call.args])).toEqual([
      [
        "glab",
        "mr",
        "list",
        "--repo",
        "https://gitlab.com/team/sub/shop",
        "--source-branch",
        BRANCH,
        "--all",
        "--output",
        "json",
      ],
      [
        "glab",
        "api",
        "--hostname",
        "gitlab.com",
        "--method",
        "POST",
        "--header",
        "Content-Type: application/json",
        "--input",
        "-",
        "projects/team%2Fsub%2Fshop/merge_requests",
      ],
      [
        "glab",
        "api",
        "--hostname",
        "gitlab.com",
        "--method",
        "PUT",
        "--header",
        "Content-Type: application/json",
        "--input",
        "-",
        "projects/team%2Fsub%2Fshop/merge_requests/9",
      ],
    ]);
    expect(JSON.parse(calls[1]?.input ?? "{}")).toEqual({
      source_branch: BRANCH,
      target_branch: "main",
      title: "Sign up (1-1)",
      description: long.body,
    });
    expect(JSON.parse(calls[2]?.input ?? "{}")).toEqual({
      title: "Sign up (1-1)",
      description: long.body,
      target_branch: "main",
    });
    for (const call of calls) expect(call.args.join(" ").length).toBeLessThan(1000);
  });

  it("reports a failing tool by its last line, and output without an address", async () => {
    const { root } = await makeRepo();
    const failing = fakeTool({
      "gh pr list": { status: 1, stderr: "HTTP 401\nauthentication required" },
      "gh pr create": { stdout: "done\n" },
    });
    const forge = new GitForge({ cwd: root, tool: failing.tool });
    await expect(forge.pullRequests(GITHUB, BRANCH)).rejects.toThrow(
      "gh pr list: authentication required",
    );
    await expect(forge.create(GITHUB, DRAFT)).rejects.toThrow("no pull request address");
    const garbled = fakeTool({
      "gh pr list": { stdout: "not json" },
      "glab api --hostname": { stdout: "{}" },
    });
    await expect(
      new GitForge({ cwd: root, tool: garbled.tool }).pullRequests(GITHUB, BRANCH),
    ).rejects.toThrow("no JSON list");
    await expect(
      new GitForge({ cwd: root, tool: garbled.tool }).create(GITLAB, DRAFT),
    ).rejects.toThrow("no merge request");
    expect(createdPullRequest("https://x@github.com/a/b/pull/1", GITHUB)).toBeUndefined();
  });
});

describe("runTool", () => {
  it("starts a tool without a shell, never prompting, and says when it is missing", async () => {
    const env = toolEnv();
    expect(env).toMatchObject({
      GH_PROMPT_DISABLED: "1",
      GIT_TERMINAL_PROMPT: "0",
      NO_PROMPT: "1",
    });
    const missing = await runTool("agentplugged-no-such-forge-tool", ["--version"], { cwd: base });
    expect(missing).toMatchObject({ missing: true, status: null });
    // A real program (node) with arguments a shell would interpret, passed as they are.
    const echoed = await runTool(
      process.execPath,
      ["-e", "process.stdin.pipe(process.stdout)", "$(x) & | ;"],
      { cwd: base, input: "body ✓" },
    );
    expect(echoed).toMatchObject({ status: 0, stdout: "body ✓" });
  });

  it("finds gh and glab in their installer's folder when PATH does not hold it yet (Windows)", () => {
    const files = new Set([
      "C:\\Program Files\\GitHub CLI\\gh.EXE",
      "C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\glab.EXE",
    ]);
    const exists = (path: string) => files.has(path);
    const env = {
      Path: "C:\\bin",
      ProgramFiles: "C:\\Program Files",
      LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
    };
    expect(resolveCommand("gh", env, "win32", exists)).toBe(
      "C:\\Program Files\\GitHub CLI\\gh.EXE",
    );
    expect(resolveCommand("glab", env, "win32", exists)).toBe(
      "C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\glab.EXE",
    );
    // PATH wins, and a tool the table does not know is never searched elsewhere.
    const onPath = { ...env, Path: "C:\\Program Files\\GitHub CLI" };
    expect(resolveCommand("gh", onPath, "win32", exists)).toBe(
      "C:\\Program Files\\GitHub CLI\\gh.EXE",
    );
    expect(resolveCommand("hub", env, "win32", exists)).toBeUndefined();
    expect(resolveCommand("gh", { Path: "C:\\bin" }, "win32", exists)).toBeUndefined();
  });

  it("finds a tool through PATH and PATHEXT on Windows, a .cmd shim included", () => {
    const files = new Set(["C:\\tools\\glab.CMD", "C:\\bin\\gh.EXE"]);
    const exists = (path: string) => files.has(path);
    const env = { Path: "C:\\bin;C:\\tools", PATHEXT: ".EXE;.CMD" };
    expect(resolveCommand("gh", env, "win32", exists)).toBe("C:\\bin\\gh.EXE");
    expect(resolveCommand("glab", env, "win32", exists)).toBe("C:\\tools\\glab.CMD");
    expect(resolveCommand("hub", env, "win32", exists)).toBeUndefined();
    expect(resolveCommand("gh", env, "linux", exists)).toBe("gh");
    expect(cmdArgument('a & b | "c" %PATH%')).toBe(
      '^^^"a^^^ ^^^&^^^ b^^^ ^^^|^^^ \\^^^"c\\^^^"^^^ ^^^%PATH^^^%^^^"',
    );
  });

  it.runIf(process.platform === "win32")(
    "runs a .cmd shim without letting cmd interpret its arguments",
    async () => {
      const shim = join(base, "echoargs.cmd");
      await writeFile(
        shim,
        `@"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))" %*\r\n`,
      );
      const marker = join(base, "pwned.txt");
      const args = ["a & echo x > pwned.txt", 'say "hi"', "100% | more", "(x)^y"];
      const run = await runTool(shim, args, { cwd: base });
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout.trim())).toEqual(args);
      expect(existsSync(marker)).toBe(false);
    },
  );
});

describe("GitForge, reviews and comments", () => {
  const REVIEW = {
    commit: "d".repeat(40),
    body: "## QA review, pass 1: fail",
    comments: [
      { path: "src/a.ts", old_path: "src/a.ts", line: 2, old_line: null, body: "**Blocking** — x" },
      { path: "src/b.ts", old_path: "src/old-b.ts", line: 7, old_line: 6, body: "**Minor** — y" },
    ],
  };

  it("posts one GitHub review, comments on the new side, the text on standard input", async () => {
    const { tool, calls } = fakeTool({});
    const forge = new GitForge({ cwd: base, tool });
    await forge.postReview(GITHUB, 41, REVIEW);
    expect(calls.map((call) => [call.command, ...call.args])).toEqual([
      [
        "gh",
        "api",
        "--hostname",
        "github.com",
        "--method",
        "POST",
        "--header",
        "Accept: application/vnd.github+json",
        "--input",
        "-",
        "repos/ada/shop/pulls/41/reviews",
      ],
    ]);
    expect(JSON.parse(calls[0]?.input ?? "{}")).toEqual({
      commit_id: REVIEW.commit,
      event: "COMMENT",
      body: REVIEW.body,
      comments: [
        { path: "src/a.ts", line: 2, side: "RIGHT", body: "**Blocking** — x" },
        { path: "src/b.ts", line: 7, side: "RIGHT", body: "**Minor** — y" },
      ],
    });
    await forge.comment(GITHUB, 41, "Deviation V-1");
    expect(calls[1]?.args).toEqual([
      "pr",
      "comment",
      "41",
      "--repo",
      "github.com/ada/shop",
      "--body-file",
      "-",
    ]);
    expect(calls[1]?.input).toBe("Deviation V-1");
  });

  it("posts on GitLab one positioned discussion per comment, then a note", async () => {
    let head = REVIEW.commit;
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    const tool: ToolRunner = async (_command, args, options) => {
      calls.push({ args, ...(options.input === undefined ? {} : { input: options.input }) });
      const stdout = args.includes("--method")
        ? "{}"
        : JSON.stringify({ diff_refs: { base_sha: "b1", start_sha: "s1", head_sha: head } });
      return { status: 0, stdout, stderr: "" };
    };
    const forge = new GitForge({ cwd: base, tool });
    await forge.postReview(GITLAB, 7, REVIEW);
    const project = "projects/team%2Fsub%2Fshop/merge_requests/7";
    expect(calls.map((call) => call.args.at(-1))).toEqual([
      project,
      `${project}/discussions`,
      `${project}/discussions`,
      `${project}/notes`,
    ]);
    expect(JSON.parse(calls[3]?.input ?? "{}")).toEqual({ body: REVIEW.body });
    expect(JSON.parse(calls[1]?.input ?? "{}").position).toEqual({
      position_type: "text",
      base_sha: "b1",
      start_sha: "s1",
      head_sha: REVIEW.commit,
      old_path: "src/a.ts",
      new_path: "src/a.ts",
      new_line: 2,
    });
    expect(JSON.parse(calls[2]?.input ?? "{}").position).toMatchObject({
      old_path: "src/old-b.ts",
      new_line: 7,
      old_line: 6,
    });
    // The merge request moved on: every finding in the note, no discussion.
    head = "f".repeat(40);
    calls.length = 0;
    await forge.postReview(GITLAB, 7, REVIEW);
    expect(calls.map((call) => call.args.at(-1))).toEqual([project, `${project}/notes`]);
    expect(JSON.parse(calls[1]?.input ?? "{}").body).toContain("`src/b.ts:7`");
    await forge.comment(GITLAB, 7, "Deviation V-1");
    expect(calls.at(-1)?.args.at(-1)).toBe(`${project}/notes`);
    expect(JSON.parse(calls.at(-1)?.input ?? "{}")).toEqual({ body: "Deviation V-1" });
  });

  it("fails when the forge refuses, with its line and never a token", async () => {
    const { tool } = fakeTool({
      gh: { status: 1, stderr: "HTTP 422: line must be part of the diff" },
    });
    const forge = new GitForge({ cwd: base, tool });
    await expect(forge.postReview(GITHUB, 41, REVIEW)).rejects.toThrow(/HTTP 422/);
  });
});

describe("GitForge: the merge of a story", () => {
  const HEAD = "d".repeat(40);
  const MERGED = "f".repeat(40);
  /** A fake tool that answers by the API path (the last argument), and records every call. */
  function apiTool(answers: Record<string, Partial<ToolRun>>) {
    const calls: Array<{ command: string; args: readonly string[]; input?: string }> = [];
    const tool: ToolRunner = async (command, args, options) => {
      calls.push({
        command,
        args,
        ...(options.input === undefined ? {} : { input: options.input }),
      });
      const answer = answers[args.at(-1) ?? ""] ?? { status: 0, stdout: "{}" };
      return { status: 0, stdout: "", stderr: "", ...answer };
    };
    return { tool, calls };
  }

  it("merges on GitHub the commit given only, through the API, never deleting the branch", async () => {
    const { tool, calls } = apiTool({
      "repos/ada/shop/pulls/41/merge": {
        stdout: JSON.stringify({ sha: MERGED, merged: true, message: "merged" }),
      },
    });
    const forge = new GitForge({ cwd: process.cwd(), tool });
    expect(await forge.merge(GITHUB, 41, { commit: HEAD, method: "squash" })).toEqual({
      ok: true,
      merge_commit: MERGED,
    });
    expect(calls).toEqual([
      {
        command: "gh",
        args: [
          "api",
          "--hostname",
          "github.com",
          "--method",
          "PUT",
          "--header",
          "Content-Type: application/json",
          "--input",
          "-",
          "repos/ada/shop/pulls/41/merge",
        ],
        input: JSON.stringify({ sha: HEAD, merge_method: "squash" }),
      },
    ]);
  });

  it("merges on GitLab with the head checked, the source branch kept, no pipeline wait", async () => {
    const path = "projects/team%2Fsub%2Fshop/merge_requests/7/merge";
    const { tool, calls } = apiTool({
      [path]: { stdout: JSON.stringify({ state: "merged", merge_commit_sha: MERGED }) },
    });
    const forge = new GitForge({ cwd: process.cwd(), tool });
    expect(await forge.merge(GITLAB, 7, { commit: HEAD, method: "merge" })).toEqual({
      ok: true,
      merge_commit: MERGED,
    });
    expect(calls[0]?.command).toBe("glab");
    expect(JSON.parse(calls[0]?.input ?? "{}")).toEqual({
      sha: HEAD,
      squash: false,
      should_remove_source_branch: false,
      merge_when_pipeline_succeeds: false,
    });
  });

  it("tells the forge's refusals apart: another head, not mergeable, another failure", async () => {
    const refusal = (stderr: string) =>
      new GitForge({
        cwd: process.cwd(),
        tool: apiTool({ "repos/ada/shop/pulls/41/merge": { status: 1, stderr } }).tool,
      }).merge(GITHUB, 41, { commit: HEAD, method: "merge" });
    expect(await refusal("gh: Head branch was modified. (HTTP 409)")).toMatchObject({
      ok: false,
      reason: "head_moved",
    });
    expect(await refusal("gh: Pull Request is not mergeable (HTTP 405)")).toMatchObject({
      ok: false,
      reason: "not_mergeable",
      message: "gh: Pull Request is not mergeable (HTTP 405)",
    });
    expect(await refusal("gh: Bad credentials (HTTP 401)")).toMatchObject({
      ok: false,
      reason: "failed",
    });
    const opened = new GitForge({
      cwd: process.cwd(),
      tool: apiTool({
        "projects/team%2Fsub%2Fshop/merge_requests/7/merge": {
          stdout: JSON.stringify({ state: "opened" }),
        },
      }).tool,
    });
    expect(await opened.merge(GITLAB, 7, { commit: HEAD, method: "merge" })).toMatchObject({
      ok: false,
      reason: "not_mergeable",
    });
    const github = (stdout: string) =>
      new GitForge({
        cwd: process.cwd(),
        tool: apiTool({ "repos/ada/shop/pulls/41/merge": { stdout } }).tool,
      }).merge(GITHUB, 41, { commit: HEAD, method: "merge" });
    // Only `merged: true` is a merge; an answer without it is not.
    expect(await github(JSON.stringify({ message: "?" }))).toMatchObject({ ok: false });
    const locked = new GitForge({
      cwd: process.cwd(),
      tool: apiTool({
        "projects/team%2Fsub%2Fshop/merge_requests/7/merge": {
          stdout: JSON.stringify({ state: "locked" }),
        },
      }).tool,
    });
    expect(await locked.merge(GITLAB, 7, { commit: HEAD, method: "squash" })).toMatchObject({
      ok: false,
      reason: "failed",
    });
  });

  it("reads a pull request's state, head and merge commit on GitHub and GitLab", async () => {
    const { tool } = apiTool({
      "repos/ada/shop/pulls/41": {
        stdout: JSON.stringify({
          state: "closed",
          merged: true,
          head: { sha: HEAD },
          base: { ref: "main" },
          merge_commit_sha: MERGED,
          merged_by: { login: "ada" },
          merged_at: "2026-10-05T14:20:00Z",
        }),
      },
      "projects/team%2Fsub%2Fshop/merge_requests/7": {
        stdout: JSON.stringify({
          state: "locked",
          sha: HEAD,
          target_branch: "release/1.0",
          merge_commit_sha: null,
        }),
      },
    });
    const forge = new GitForge({ cwd: process.cwd(), tool });
    expect(await forge.pullRequest(GITHUB, 41)).toEqual({
      state: "merged",
      head: HEAD,
      merge_commit: MERGED,
      base: "main",
      // Who merged it and when, as the forge says it.
      merged_by: "ada",
      merged_at: "2026-10-05T14:20:00.000Z",
    });
    // The branch it merges into, as the forge says it.
    expect(await forge.pullRequest(GITLAB, 7)).toEqual({
      state: "open",
      head: HEAD,
      merge_commit: null,
      base: "release/1.0",
      merged_by: null,
      merged_at: null,
    });
  });

  it("reads the diff of a pull request with the forge's tool, read only", async () => {
    const DIFF = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n x\n+y\n";
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const tool: ToolRunner = async (command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: DIFF, stderr: "" };
    };
    const forge = new GitForge({ cwd: process.cwd(), tool });
    expect(await forge.pullRequestDiff(GITHUB, 41)).toBe(DIFF);
    expect(await forge.pullRequestDiff(GITLAB, 7)).toBe(DIFF);
    expect(calls).toEqual([
      {
        command: "gh",
        args: ["pr", "diff", "41", "--repo", "github.com/ada/shop", "--color", "never"],
      },
      {
        command: "glab",
        args: [
          "api",
          "--hostname",
          "gitlab.com",
          "projects/team%2Fsub%2Fshop/merge_requests/7/raw_diffs",
        ],
      },
    ]);
    // A number only: never an option, never a failure taken for an empty diff.
    await expect(forge.pullRequestDiff(GITHUB, Number.NaN)).rejects.toThrow("pull request number");
    const failing = new GitForge({
      cwd: process.cwd(),
      tool: async () => ({
        status: 1,
        stdout: "",
        stderr: "gh: Could not resolve to a PullRequest",
      }),
    });
    await expect(failing.pullRequestDiff(GITHUB, 9)).rejects.toThrow("Could not resolve");
  });
});
