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

/** The built binary, run as `npx agentplugged docs check` would run it. */
const bin = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/bin.js");
/** A keychain service of this file only, deleted after each test: never the real entries. */
const service = `agentplugged-test-breakdown-${process.pid}-${Date.now()}`;
const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

const PRD = ".agentplugged/docs/prd.md";
const EPIC = ".agentplugged/epics/epic-1.md";
const STORY = ".agentplugged/stories/1-1.md";

let cwd: string;
let home: string;
let env: Record<string, string>;

/** Runs git in the test repository only; never in this one, never on the network. */
function git(args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env, windowsHide: true });
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
  cwd = await realpath(await mkdtemp(join(tmpdir(), "agentplugged-breakdown-")));
  home = await mkdtemp(join(tmpdir(), "agentplugged-breakdown-home-"));
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
    // Git finds no repository above the temporary folders, and no configuration of this machine.
    GIT_CEILING_DIRECTORIES: await realpath(tmpdir()),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
  };
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Ada"]);
  git(["config", "user.email", "ada@example.com"]);
  git(["config", "core.autocrlf", "false"]);
});

afterEach(async () => {
  await removeTestKeys(service);
  for (const folder of [cwd, home]) {
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

/** The built binary, as the creator (or an agent's shell) runs it: no terminal. */
function binary(args: string[], lang = "en") {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    env: { ...env, AGENTPLUGGED_LANG: lang },
    encoding: "utf8",
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Izzy's side, in process: opens a `document` checkpoint on the breakdown. */
async function openBreakdownCheckpoint(blob: string): Promise<string> {
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
      documents: [
        { path: EPIC, branch: "main", blob_sha: git(["rev-parse", `HEAD:${EPIC}`]) },
        { path: STORY, branch: "main", blob_sha: blob },
      ],
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
  "EF-1, the passkey flow of the UX specification.",
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

describe("docs check: the breakdown", () => {
  it("fails on a requirement no story covers, then freezes an approved intent", async () => {
    // A first commit before the breakdown: the state of an older branch.
    git(["commit", "-q", "--allow-empty", "-m", "start"]);
    const start = git(["rev-parse", "HEAD"]);
    const init = await cli(["init", "--profile", "new-product"]);
    expect(init.status).toBe(0);
    await put(
      PRD,
      "---\nid: prd\nkind: prd\nowner: maya\n---\n# PRD\n\nEF-1 : Ada signs in with a passkey.\nEF-2 : Ada exports her data as CSV.\n",
    );
    await put(EPIC, "---\nid: epic-1\nkind: epic\nowner: izzy\n---\n# Epic 1: sign in\n");
    await put(STORY, STORY_TEXT);

    const uncovered = binary(["docs", "check"]);
    expect(uncovered.status).toBe(1);
    expect(uncovered.stderr).toContain(
      `${PRD}:9: REQ_NOT_COVERED: EF-2 is covered by no story: add it to the \`requirements\` of a story, or to the \`out_of_scope\` of an epic.`,
    );

    // EF-2 left aside by the epic: the breakdown is complete; Izzy commits it.
    await put(
      EPIC,
      "---\nid: epic-1\nkind: epic\nowner: izzy\nout_of_scope: [EF-2]\n---\n# Epic 1: sign in\n",
    );
    git(["add", "."]);
    git(["commit", "-q", "-m", "breakdown"]);
    expect(binary(["docs", "check"]).status).toBe(0);

    // Izzy opens the checkpoint; the creator approves it: « Approve », then Enter.
    const checkpoint = await openBreakdownCheckpoint(git(["rev-parse", `HEAD:${STORY}`]));
    const review = await cli(["review", checkpoint], ["1", ""]);
    expect(review.stderr).toBe("");
    expect(review.status).toBe(0);
    // The card shows the creator the intent they freeze.
    expect(review.stdout).toContain(
      "Intents you freeze by approving:\n  1-1 (new)\n    │ Ada signs in without a password.\n",
    );
    const approved = binary(["docs", "check"]);
    expect(approved.stderr).toBe("");
    expect(approved.status).toBe(0);
    expect(approved.stdout).toContain("Approved story intents compared: 1.\n");

    // An agent rewrites the intent: the check fails, naming the checkpoint.
    await put(STORY, STORY_TEXT.replace("without a password", "with a password"));
    const changed = binary(["docs", "check"]);
    expect(changed.status).toBe(1);
    expect(changed.stderr).toContain(`${STORY}:19: STORY_INTENT_CHANGED: `);
    expect(changed.stderr).toContain(`(${checkpoint})`);
    const french = binary(["docs", "check"], "fr");
    expect(french.stderr).toContain(
      `L'intention de la story 1-1 diffère de celle que tu as validée (${checkpoint}).`,
    );

    // The story deleted on this branch, which held it: removed.
    await put(STORY, STORY_TEXT);
    git(["rm", "-q", STORY]);
    git(["commit", "-q", "-m", "drop the story"]);
    const removed = binary(["docs", "check"]);
    expect(removed.status).toBe(1);
    expect(removed.stderr).toContain(`${STORY}:1: STORY_INTENT_CHANGED: Story 1-1, whose intent`);

    // An older branch that never had the breakdown: a warning, never a failure.
    git(["checkout", "-q", "-b", "older", start]);
    const older = binary(["docs", "check"]);
    expect(older.stderr).toBe("");
    expect(older.status).toBe(0);
    expect(older.stdout).toContain(
      `Warning: story 1-1, approved in ${checkpoint}, is not on this branch: not verified here.\n`,
    );
  });
});
