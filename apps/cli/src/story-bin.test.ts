import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { GitStateStore, NodeKeyStore, NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import { removeTestKeys } from "@agentplugged/adapters-git/test-keychain";
import { type CommandContext, createCommandRegistry, type RecordedEvent } from "@agentplugged/core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./main.js";

vi.setConfig({ testTimeout: 120_000 });

/** The built binary, run as `npx agentplugged story start` would run it. */
const bin = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/bin.js");
/** A keychain service of this file only, deleted after each test: never the real entries. */
const service = `agentplugged-test-story-${process.pid}-${Date.now()}`;
const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

const PRD = ".agentplugged/docs/prd.md";
const EPIC = ".agentplugged/epics/epic-1.md";
const STORY = ".agentplugged/stories/1-1-passkey.md";

let parent: string;
let cwd: string;
let home: string;
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

beforeAll(() => {
  if (!existsSync(bin)) throw new Error(`Build the CLI first: ${bin} is missing`);
});

beforeEach(async (context) => {
  if (!(await keychainAvailable())) context.skip("no system keychain on this machine");
  parent = await realpath(await mkdtemp(join(tmpdir(), "agentplugged-story-bin-")));
  cwd = join(parent, "shop");
  await mkdir(cwd);
  home = await mkdtemp(join(tmpdir(), "agentplugged-story-bin-home-"));
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
  gitOk(["init", "-q", "-b", "main"]);
  gitOk(["config", "user.name", "Ada"]);
  gitOk(["config", "user.email", "ada@example.com"]);
  gitOk(["config", "core.autocrlf", "false"]);
});

afterEach(async () => {
  await removeTestKeys(service);
  for (const folder of [parent, home]) {
    if (folder !== undefined) {
      await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
});

/** Runs the CLI in process, as if the creator typed `answers` in a terminal. */
async function cli(args: string[], answers: string[] = []) {
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
  });
  return { status, stdout, stderr };
}

/** The built binary, as an agent's shell runs it: no terminal. */
function binary(args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
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
  "branch: feat/1-1-passkey",
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

describe("npx agentplugged story start", () => {
  it("creates the story's branch, worktree and hook in a real repository", async () => {
    expect((await cli(["init", "--profile", "new-product"])).status).toBe(0);
    await put(PRD, "---\nid: prd\nkind: prd\nowner: maya\n---\n# PRD\n\nEF-1 : Ada signs in.\n");
    await put(EPIC, "---\nid: epic-1\nkind: epic\nowner: izzy\n---\n# Epic 1: sign in\n");
    await put(STORY, STORY_TEXT);
    gitOk(["add", "."]);
    gitOk(["commit", "-q", "-m", "breakdown"]);
    const checkpoint = await openBreakdownCheckpoint();
    expect((await cli(["review", checkpoint], ["1", ""])).status).toBe(0);

    const started = binary(["story", "start", "1-1"]);
    expect(started.stderr).toBe("");
    expect(started.status).toBe(0);
    const worktree = join(parent, "shop.worktrees", "1-1");
    expect(started.stdout).toContain("Story 1-1 started: branch feat/1-1-passkey, from main");
    expect(started.stdout).toContain(`Working copy: ${worktree}`);
    expect(existsSync(join(worktree, STORY))).toBe(true);
    expect(gitOk(["symbolic-ref", "--short", "HEAD"], worktree)).toBe("feat/1-1-passkey");

    // The hook, with the story's requirements.
    await writeFile(join(worktree, "a.txt"), "a\n");
    gitOk(["add", "-A"], worktree);
    expect(git(["commit", "-q", "-m", "feat: sign in"], worktree).status).not.toBe(0);
    expect(git(["commit", "-q", "-m", "feat(1-1): sign in (EF-1)"], worktree).status).toBe(0);

    // Again: resumed, nothing recorded twice.
    const again = binary(["story", "start", "1-1"]);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("Story 1-1 resumed");
  });
});
