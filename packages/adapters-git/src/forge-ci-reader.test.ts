import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CiToolRun,
  type CiToolRunner,
  createCiToolRunner,
  ForgeCiReader,
  forgeOfRemote,
  resolveCiTool,
} from "./index.js";

// Real Git processes for the repository; the forge's tools are always simulated.
vi.setConfig({ testTimeout: 120_000 });

const WINDOWS = process.platform === "win32";

/** A simulated `gh` / `glab`: one answer per command line, recorded calls. Never the network. */
function tools(answers: Record<string, Partial<CiToolRun>>): {
  run: CiToolRunner;
  calls: string[];
} {
  const calls: string[] = [];
  const run: CiToolRunner = async (tool, args) => {
    const line = [tool, ...args].join(" ");
    calls.push(line);
    const answer = answers[line] ?? answers[tool];
    if (answer === undefined) throw new Error(`unexpected call: ${line}`);
    return { status: 0, stdout: "", stderr: "", ...answer };
  };
  return { run, calls };
}

const PR_VIEW =
  "gh pr view feat/1-1-work --json number,url,headRefOid,state,isCrossRepository,mergeable";
const PR_CHECKS = "gh pr checks 12 --json name,bucket,link";
const MR_VIEW = "glab mr view feat/1-1-work -F json";
const CI_GET_BRANCH = "glab ci get -b feat/1-1-work -F json";
const CI_GET_PIPELINE = "glab ci get -p 41 -F json";
const PR = {
  number: 12,
  url: "https://github.com/acme/shop/pull/12",
  headRefOid: "a".repeat(40),
  state: "OPEN",
  isCrossRepository: false,
};

const github = (answers: Record<string, Partial<CiToolRun>>) =>
  new ForgeCiReader({ cwd: tmpdir(), run: tools(answers).run }).read("feat/1-1-work", "github");
const gitlab = (answers: Record<string, Partial<CiToolRun>>) =>
  new ForgeCiReader({ cwd: tmpdir(), run: tools(answers).run }).read("feat/1-1-work", "gitlab");

describe("ForgeCiReader: GitHub", () => {
  it("reads the open pull request, then its checks, even when gh exits 1 or 8", async () => {
    const { run, calls } = tools({
      [PR_VIEW]: { stdout: JSON.stringify(PR) },
      [PR_CHECKS]: {
        status: 1,
        stdout: JSON.stringify([
          { name: "lint", bucket: "pass" },
          { name: "test", bucket: "fail" },
          { name: "build", bucket: "pending" },
          { name: "audit", bucket: "skipping" },
          { name: "deploy", bucket: "cancel" },
        ]),
      },
    });
    const reader = new ForgeCiReader({ cwd: tmpdir(), run });
    expect(await reader.read("feat/1-1-work", "github")).toEqual({
      ok: true,
      checks: [
        { name: "lint", state: "pass" },
        { name: "test", state: "fail" },
        { name: "build", state: "pending" },
        { name: "audit", state: "pass" },
        { name: "deploy", state: "fail" },
      ],
      pr: 12,
      url: "https://github.com/acme/shop/pull/12",
      commit: "a".repeat(40),
    });
    expect(calls).toEqual([PR_VIEW, PR_CHECKS]);
  });

  it("takes only an open pull request of this repository", async () => {
    for (const pr of [
      { ...PR, state: "MERGED" },
      { ...PR, state: "CLOSED" },
      { ...PR, isCrossRepository: true },
    ]) {
      expect(await github({ [PR_VIEW]: { stdout: JSON.stringify(pr) } })).toEqual({
        ok: false,
        reason: "no_pull_request",
        tool: "gh",
      });
    }
  });

  it("says why it cannot read: tool, sign-in, pull request, access, time, checks, else", async () => {
    expect(await github({ gh: { status: null, missing: true } })).toEqual({
      ok: false,
      reason: "forge_cli_missing",
      tool: "gh",
    });
    expect(
      await github({
        [PR_VIEW]: {
          status: 4,
          stderr: "To get started with GitHub CLI, please run:  gh auth login",
        },
      }),
    ).toMatchObject({ ok: false, reason: "not_authenticated" });
    expect(
      await github({
        [PR_VIEW]: { status: 1, stderr: 'no pull requests found for branch "feat/1-1-work"' },
      }),
    ).toMatchObject({ ok: false, reason: "no_pull_request" });
    // A 404 is the repository, or a permission: never "no pull request".
    for (const stderr of [
      "GraphQL: Could not resolve to a Repository with the name 'acme/shop'.",
      "HTTP 404: Not Found (https://api.github.com/repos/acme/shop)",
      "HTTP 403: Resource not accessible by integration",
    ]) {
      expect(await github({ [PR_VIEW]: { status: 1, stderr } }), stderr).toMatchObject({
        ok: false,
        reason: "forge_access",
        detail: stderr,
      });
    }
    expect(await github({ [PR_VIEW]: { status: null, timedOut: true } })).toEqual({
      ok: false,
      reason: "forge_timeout",
      tool: "gh",
    });
    expect(
      await github({
        [PR_VIEW]: { stdout: JSON.stringify(PR) },
        [PR_CHECKS]: { status: 1, stderr: "no checks reported on the 'feat/1-1-work' branch" },
      }),
    ).toEqual({
      ok: true,
      checks: [],
      pr: 12,
      url: "https://github.com/acme/shop/pull/12",
      commit: "a".repeat(40),
    });
    expect(
      await github({
        [PR_VIEW]: { stdout: JSON.stringify(PR) },
        [PR_CHECKS]: { status: 2, stderr: "boom\nmore" },
      }),
    ).toEqual({ ok: false, reason: "forge_failed", tool: "gh", detail: "boom" });
  });
});

describe("ForgeCiReader: GitLab", () => {
  it("reads the merge request's own pipeline, its jobs and its commit", async () => {
    const { run, calls } = tools({
      [MR_VIEW]: {
        stdout: JSON.stringify({
          iid: 7,
          state: "opened",
          source_project_id: 3,
          target_project_id: 3,
          web_url: "https://gitlab.com/acme/shop/-/merge_requests/7",
          head_pipeline: { id: 41, sha: "e".repeat(40) },
        }),
      },
      [CI_GET_PIPELINE]: {
        stdout: JSON.stringify({
          status: "failed",
          sha: "f".repeat(40),
          jobs: [
            { name: "lint", status: "success" },
            { name: "test", status: "failed" },
            { name: "audit", status: "failed", allow_failure: true },
            { name: "build", status: "running" },
            { name: "deploy", status: "manual", allow_failure: false },
            { name: "docs", status: "manual", allow_failure: true },
          ],
        }),
      },
    });
    const reader = new ForgeCiReader({ cwd: tmpdir(), run });
    expect(await reader.read("feat/1-1-work", "gitlab")).toEqual({
      ok: true,
      checks: [
        { name: "lint", state: "pass" },
        { name: "test", state: "fail" },
        { name: "audit", state: "pass" },
        { name: "build", state: "pending" },
        { name: "deploy", state: "pending" },
        { name: "docs", state: "pass" },
      ],
      pr: 7,
      url: "https://gitlab.com/acme/shop/-/merge_requests/7",
      commit: "f".repeat(40),
    });
    expect(calls).toEqual([MR_VIEW, CI_GET_PIPELINE]);
  });

  it("falls back on the branch's pipeline, and refuses a closed or forked merge request", async () => {
    const mr = { iid: 7, state: "opened" };
    expect(
      await gitlab({
        [MR_VIEW]: { stdout: JSON.stringify(mr) },
        [CI_GET_BRANCH]: {
          status: 1,
          stderr: "no pipelines running or available on branch: feat/1-1-work",
        },
      }),
    ).toEqual({ ok: true, checks: [], pr: 7 });
    for (const other of [
      { ...mr, state: "merged" },
      { ...mr, source_project_id: 9, target_project_id: 3 },
    ]) {
      expect(await gitlab({ [MR_VIEW]: { stdout: JSON.stringify(other) } })).toEqual({
        ok: false,
        reason: "no_pull_request",
        tool: "glab",
      });
    }
    expect(
      await gitlab({
        [MR_VIEW]: { status: 1, stderr: "no merge requests available on feat/1-1-work" },
      }),
    ).toMatchObject({ ok: false, reason: "no_pull_request", tool: "glab" });
    expect(await gitlab({ glab: { status: 1, stderr: "401 Unauthorized" } })).toMatchObject({
      reason: "not_authenticated",
    });
    expect(await gitlab({ glab: { status: 1, stderr: "404 Project Not Found" } })).toMatchObject({
      reason: "forge_access",
    });
  });
});

describe("forgeOfRemote", () => {
  it("reads the exact host of HTTPS, SSH and scp-like addresses", () => {
    expect(forgeOfRemote("https://github.com/acme/shop.git")).toBe("github");
    expect(forgeOfRemote("git@github.com:acme/shop.git")).toBe("github");
    expect(forgeOfRemote("https://github.acme.example/shop.git")).toBe("github");
    expect(forgeOfRemote("ssh://git@gitlab.example.com:2222/acme/shop.git")).toBe("gitlab");
    expect(forgeOfRemote("https://ada@gitlab.com/acme/shop")).toBe("gitlab");
    expect(forgeOfRemote("https://notgithub.com/acme/shop.git")).toBeNull();
    expect(forgeOfRemote("https://code.example.com/gitlab/shop.git")).toBeNull();
    expect(forgeOfRemote("https://example.com/github/shop.git")).toBeNull();
    expect(forgeOfRemote("/srv/git/shop.git")).toBeNull();
  });
});

describe("temporary folders", () => {
  const saved: Record<string, string | undefined> = {};
  let config: string;
  let base: string;

  function git(cwd: string, args: string[]) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }

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
    base = await realpath(await mkdtemp(join(tmpdir(), "agentplugged-ci-")));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("gives the forge of origin, the folder, the main branch and the CI at the top", async () => {
    const unused = tools({}).run;
    expect(await new ForgeCiReader({ cwd: base, run: unused }).repository()).toBeNull();
    const repo = join(base, "shop");
    await mkdir(join(repo, "app"), { recursive: true });
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.name", "Ada"]);
    git(repo, ["config", "user.email", "ada@example.com"]);
    await writeFile(join(repo, "README.md"), "shop\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-q", "-m", "init"]);
    expect(await new ForgeCiReader({ cwd: repo, run: unused }).repository()).toEqual({
      forge: null,
      prefix: "",
      main: "main",
      ci: [],
    });
    git(repo, ["remote", "add", "origin", "git@github.com:acme/shop.git"]);
    // Workflows directly in their folder only; a file where a folder is expected is no CI.
    await mkdir(join(repo, ".github/workflows/nested"), { recursive: true });
    await writeFile(join(repo, ".github/workflows/ci.yml"), "on: push\n");
    await writeFile(join(repo, ".github/workflows/nested/x.yml"), "on: push\n");
    await writeFile(join(repo, ".github/workflows/notes.md"), "\n");
    await writeFile(join(repo, ".circleci"), "not a folder\n");
    expect(await new ForgeCiReader({ cwd: join(repo, "app"), run: unused }).repository()).toEqual({
      forge: "github",
      prefix: "app/",
      main: "main",
      ci: [".github/workflows/ci.yml"],
    });
  });

  it.runIf(WINDOWS)(
    "finds gh in its installer's folder when the PATH does not hold it",
    async () => {
      const programs = join(base, "Local", "Programs", "GitHub CLI");
      await mkdir(programs, { recursive: true });
      await writeFile(join(programs, "gh.exe"), "");
      const env = {
        PATH: join(base, "empty"),
        PATHEXT: ".EXE;.CMD",
        LOCALAPPDATA: join(base, "Local"),
        ProgramFiles: join(base, "none"),
        "ProgramFiles(x86)": join(base, "none"),
      };
      expect((await resolveCiTool("gh", env, "win32"))?.toLowerCase()).toBe(
        join(programs, "gh.exe").toLowerCase(),
      );
      expect(await resolveCiTool("hub", env, "win32")).toBeUndefined();
    },
  );

  it("runs a real tool found on the PATH, and stops it at its time limit", async () => {
    const bin = join(base, "bin");
    await mkdir(bin);
    if (WINDOWS) {
      await writeFile(join(bin, "fakegh.cmd"), "@echo fake %*\r\n");
      await writeFile(
        join(bin, "slowgh.cmd"),
        `@"${process.execPath}" -e "setTimeout(()=>{},5000)"\r\n`,
      );
    } else {
      await writeFile(join(bin, "fakegh"), '#!/bin/sh\necho "fake $*"\n');
      await writeFile(
        join(bin, "slowgh"),
        `#!/bin/sh\nexec "${process.execPath}" -e "setTimeout(()=>{},5000)"\n`,
      );
      await chmod(join(bin, "fakegh"), 0o755);
      await chmod(join(bin, "slowgh"), 0o755);
    }
    const env = { ...process.env, PATH: bin, Path: bin, PATHEXT: ".EXE;.CMD" };
    expect(await resolveCiTool("fakegh", env, process.platform)).toBe(
      join(bin, WINDOWS ? "fakegh.cmd" : "fakegh"),
    );
    const run = createCiToolRunner({ env, timeoutMs: 1000 });
    const done = await run("fakegh", ["pr", "view", "feat/1-1-work"], base);
    expect(done.status).toBe(0);
    expect(done.stdout).toMatch(/^fake /);
    expect(done.stdout).toContain("pr");
    expect(done.stdout).toContain("feat/1-1-work");
    expect(await run("nosuchtool", [], base)).toMatchObject({ missing: true, status: null });
    const slow = await run("slowgh", [], base);
    expect(slow).toMatchObject({ timedOut: true, status: null });
  });
});
