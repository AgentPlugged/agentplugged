import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import {
  type GitRunner,
  GitStateStore,
  NodeKeyStore,
  NodeWorkspaceFiles,
  runGit,
  type ToolRun,
  type ToolRunner,
} from "@agentplugged/adapters-git";
import { removeTestKeys } from "@agentplugged/adapters-git/test-keychain";
import { type CommandContext, createCommandRegistry, type RecordedEvent } from "@agentplugged/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./main.js";

vi.setConfig({ testTimeout: 120_000 });

/** A keychain service of this file only, deleted after each test: never the real entries. */
const service = `agentplugged-test-story-pr-${process.pid}-${Date.now()}`;
const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

const PRD = ".agentplugged/docs/prd.md";
const EPIC = ".agentplugged/epics/epic-1.md";
const STORY = ".agentplugged/stories/1-1-passkey.md";
const BRANCH = "feat/1-1-passkey";
/** The address the remote shows; Git sends it to a bare repository on disk (`insteadOf`). */
const ADDRESS = "https://github.com/ada/shop.git";

let parent: string;
let cwd: string;
let home: string;
let origin: string;
let env: Record<string, string>;

/** Runs git in the test repository only; never in this one, never on the network. */
function git(args: string[], folder = cwd) {
  return spawnSync("git", args, { cwd: folder, encoding: "utf8", env, windowsHide: true });
}

function gitOk(args: string[], folder = cwd): string {
  const result = git(args, folder);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** True when this machine has a system keychain (a Linux server may have none). */
async function keychainAvailable(): Promise<boolean> {
  try {
    await new NodeKeyStore({ service }).readHumanSecret();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/platform secure storage|no storage access|secret service|dbus|keyutils/i.test(message)) {
      return false;
    }
    throw error;
  }
}

beforeEach(async (context) => {
  if (!(await keychainAvailable())) context.skip("no system keychain on this machine");
  parent = await realpath(await mkdtemp(join(tmpdir(), "agentplugged-story-pr-")));
  cwd = join(parent, "shop");
  origin = join(parent, "origin.git");
  await mkdir(cwd);
  await mkdir(origin);
  home = await mkdtemp(join(tmpdir(), "agentplugged-story-pr-home-"));
  await writeFile(join(home, ".gitconfig"), "");
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(home|userprofile)$/i.test(key)) inherited[key] = value;
  }
  env = {
    ...inherited,
    HOME: home,
    USERPROFILE: home,
    AGENTPLUGGED_LANG: "en",
    AGENTPLUGGED_KEYCHAIN_SERVICE: service,
    AGENTPLUGGED_PRESENCE: "none",
    AGENTPLUGGED_ENVIRONMENT: "none",
    GIT_CEILING_DIRECTORIES: await realpath(tmpdir()),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
  };
  gitOk(["init", "-q", "--bare", "-b", "main"], origin);
  gitOk(["init", "-q", "-b", "main"]);
  gitOk(["config", "user.name", "Ada"]);
  gitOk(["config", "user.email", "ada@example.com"]);
  gitOk(["config", "core.autocrlf", "false"]);
  gitOk(["remote", "add", "origin", ADDRESS]);
  gitOk(["config", `url.${origin.replaceAll("\\", "/")}.insteadOf`, ADDRESS]);
});

afterEach(async () => {
  await removeTestKeys(service);
  for (const folder of [parent, home]) {
    if (folder !== undefined) {
      await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
});

/** A fake `gh`: answers from a table, records every call. Never the real tool, never the network. */
function fakeGh(answers: Record<string, Partial<ToolRun>>) {
  const calls: Array<{ args: readonly string[]; input?: string }> = [];
  const tool: ToolRunner = async (command, args, options) => {
    calls.push({
      args: [command, ...args],
      ...(options.input === undefined ? {} : { input: options.input }),
    });
    const answer = answers[`${command} ${args.slice(0, 2).join(" ")}`] ?? {};
    return { status: 0, stdout: "", stderr: "", ...answer };
  };
  return { tool, calls };
}

/** Runs the CLI in process, as if the creator typed `answers` in a terminal. */
async function cli(
  args: string[],
  options: { answers?: string[]; tool?: ToolRunner; git?: GitRunner } = {},
) {
  const answers = options.answers ?? [];
  let stdout = "";
  let stderr = "";
  const status = await main({
    argv: args,
    cwd,
    env: { ...env, PATH: process.env.PATH ?? "" },
    engineVersion: VERSION,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    stdin: Readable.from(answers.length === 0 ? [] : [answers.map((a) => `${a}\n`).join("")]),
    interactive: answers.length > 0,
    undoMs: 200,
    ...(options.tool === undefined ? {} : { forgeTool: options.tool }),
    ...(options.git === undefined ? {} : { forgeGit: options.git }),
  });
  return { status, stdout, stderr };
}

/** Izzy's side, in process: opens the `document` checkpoint of the breakdown. */
async function openBreakdownCheckpoint(): Promise<string> {
  const journal = new GitStateStore({
    cwd,
    keys: new NodeKeyStore({ service }),
    machineLockPath: join(home, ".agentplugged", "machine-key.lock"),
  });
  const context: CommandContext = {
    files: new NodeWorkspaceFiles(cwd),
    tools: {
      which: async () => undefined,
      version: async () => undefined,
      extensions: async () => [],
    },
    method: {
      listFiles: () => Promise.reject(new Error("unused")),
      readText: () => Promise.reject(new Error("unused")),
      readBytes: () => Promise.reject(new Error("unused")),
    },
    actor: "agent",
    engineVersion: VERSION,
    journal,
  };
  try {
    const result = await createCommandRegistry().run("open_checkpoint", context, {
      agent: "izzy",
      type: "document",
      risk: "medium",
      title: "Validate the breakdown of epic 1",
      summary: "Epic 1 and its first story, ready to build.",
      documents: [{ path: STORY, branch: "main", blob_sha: gitOk(["rev-parse", `HEAD:${STORY}`]) }],
    });
    if (!result.ok) throw new Error(`open_checkpoint: ${result.error.code}`);
    return (result.value as RecordedEvent).checkpoint as string;
  } finally {
    journal.close();
  }
}

async function put(path: string, content: string) {
  await mkdir(dirname(join(cwd, path)), { recursive: true });
  await writeFile(join(cwd, path), content);
}

const STORY_TEXT = [
  "---",
  "id: 1-1",
  "kind: story",
  "owner: sam",
  "title: Sign in with a passkey",
  "epic: epic-1",
  "reviewer: quentin",
  "requirements: [EF-1]",
  "budget_usd: 6",
  `branch: ${BRANCH}`,
  "depends_on: []",
  "---",
  "# Sign in with a passkey",
  "",
  "## Context",
  "",
  "EF-1, the passkey flow.",
  "",
  "## Intent",
  "",
  "Ada signs in without a password.",
  "",
  "## Acceptance criteria",
  "",
  "- Given a passkey, when Ada signs in, then she lands on her home page.",
  "",
  "## Out of scope",
  "",
  "- Account recovery.",
  "",
].join("\n");

describe("npx agentplugged story pr", () => {
  it("pushes the story's branch and opens its pull request through gh, in a real repository", async () => {
    expect((await cli(["init", "--profile", "new-product"])).status).toBe(0);
    await put(PRD, "---\nid: prd\nkind: prd\nowner: maya\n---\n# PRD\n\nEF-1 : Ada signs in.\n");
    await put(EPIC, "---\nid: epic-1\nkind: epic\nowner: izzy\n---\n# Epic 1: sign in\n");
    await put(STORY, STORY_TEXT);
    gitOk(["add", "."]);
    gitOk(["commit", "-q", "-m", "breakdown"]);
    const checkpoint = await openBreakdownCheckpoint();
    expect((await cli(["review", checkpoint], { answers: ["1", ""] })).status).toBe(0);
    expect((await cli(["story", "start", "1-1"])).status).toBe(0);
    const worktree = join(parent, "shop.worktrees", "1-1");

    // No commit yet: nothing to deliver.
    const ready = fakeGh({
      "gh pr list": { stdout: "[]" },
      "gh pr create": { stdout: "https://github.com/ada/shop/pull/1\n" },
    });
    expect((await cli(["story", "pr", "1-1"], { tool: ready.tool })).stderr).toContain(
      "no commit since its base",
    );

    await writeFile(join(worktree, "a.txt"), "a\n");
    gitOk(["add", "-A"], worktree);
    gitOk(["commit", "-q", "-m", "feat(1-1): sign in (EF-1)"], worktree);

    // Git really pushes `origin` to a folder on disk (`insteadOf`): never taken for GitHub.
    const local = await cli(["story", "pr", "1-1"], { tool: ready.tool });
    expect(local.status).toBe(1);
    expect(local.stderr).toContain("Remote origin is on local, neither GitHub nor GitLab");
    expect(git(["rev-parse", "--verify", "-q", `refs/heads/${BRANCH}`], origin).status).not.toBe(0);

    // From here, `origin` reads as the GitHub repository it stands for (the push itself still
    // goes to the folder on disk): never the network.
    const asGitHub: GitRunner = async (folder, args, input, extra, timeout) => {
      if (args.join(" ") === "remote get-url --push origin") {
        return { status: 0, stdout: Buffer.from(`${ADDRESS}\n`), stderr: "" };
      }
      return runGit(folder, args, input, extra, timeout);
    };

    // Not linked: nothing pushed, the message says how to link it.
    const missing = fakeGh({ "gh --version": { status: null, missing: true } });
    const unlinked = await cli(["story", "pr", "1-1"], { tool: missing.tool, git: asGitHub });
    expect(unlinked.status).toBe(1);
    expect(unlinked.stderr).toContain("gh was not found");
    expect(unlinked.stderr).toContain("gh auth login --hostname github.com");
    expect(git(["rev-parse", "--verify", "-q", `refs/heads/${BRANCH}`], origin).status).not.toBe(0);

    const opened = await cli(["story", "pr", "1-1"], { tool: ready.tool, git: asGitHub });
    expect(opened.stderr).toBe("");
    expect(opened.status).toBe(0);
    expect(opened.stdout).toContain(
      "Pull request opened for story 1-1: https://github.com/ada/shop/pull/1",
    );
    expect(opened.stdout).toContain("Acceptance criteria checked: 0 of 1.");
    expect(opened.stdout).toContain("Tests: not reported by the agent.");
    expect(opened.stdout).not.toMatch(/Cost|Budget/);

    // The branch reached the remote under its own name; the main branch never did.
    expect(gitOk(["rev-parse", BRANCH], origin)).toBe(gitOk(["rev-parse", BRANCH], worktree));
    expect(git(["rev-parse", "--verify", "-q", "refs/heads/main"], origin).status).not.toBe(0);
    const create = ready.calls.find((call) => call.args[2] === "create");
    expect(create?.args).toEqual(
      expect.arrayContaining(["--repo", "github.com/ada/shop", "--base", "main", "--head", BRANCH]),
    );
    expect(create?.input).toContain(
      "- [ ] Given a passkey, when Ada signs in, then she lands on her home page.",
    );
    expect(create?.input).toContain("**Not reported by the agent**");
    expect(
      ready.calls.some(
        (call) => call.args[1] === "api" || (call.args[1] === "auth" && call.args[2] === "token"),
      ),
    ).toBe(false);
  });
});
