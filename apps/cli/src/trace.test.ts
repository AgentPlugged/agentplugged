import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  GitStateStore,
  GitTestReferences,
  NodeKeyStore,
  NodeWorkspaceFiles,
} from "@agentplugged/adapters-git";
import { removeTestKeys } from "@agentplugged/adapters-git/test-keychain";
import { type CommandContext, createCommandRegistry, type RecordedEvent } from "@agentplugged/core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./main.js";

vi.setConfig({ testTimeout: 120_000 });

const bin = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/bin.js");
/** A keychain service of this file only, deleted after each test: never the real entries. */
const service = `agentplugged-test-trace-${process.pid}-${Date.now()}`;
const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

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
  cwd = await mkdtemp(join(tmpdir(), "agentplugged-trace-"));
  home = await mkdtemp(join(tmpdir(), "agentplugged-trace-home-"));
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
});

afterEach(async () => {
  await removeTestKeys(service);
  for (const folder of [cwd, home]) {
    if (folder !== undefined) {
      await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
});

/** Runs the CLI in process; `terminal` as if the creator typed at one. */
async function cli(args: string[], terminal = false) {
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
    stdin: Readable.from([]),
    interactive: terminal,
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

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(join(cwd, path)), { recursive: true });
  await writeFile(join(cwd, path), text);
}

/** The PRD, a story citing EF-1, and a Python test naming EF-1. */
async function seedProduct(): Promise<void> {
  await write(
    ".agentplugged/docs/prd.md",
    "---\nid: prd\nkind: prd\nowner: creator\n---\n# PRD\n\n- EF-1: The visitor signs in.\n- ENF-1: Fast pages.\n",
  );
  await write(
    ".agentplugged/stories/1-1-sign-in.md",
    "---\nid: 1-1\ntitle: Sign in\nkind: story\nowner: creator\nrequirements: [EF-1]\n---\n# Sign in\n",
  );
  await write("tests/login_test.py", "def test_EF_1_signs_in():\n    assert True\n");
}

/** The agents' side, in process: the engine starts 1-1, then the main session reports a gap. */
async function reportDeviation(): Promise<string> {
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
    testReferences: new GitTestReferences({ cwd }),
  };
  try {
    const product = (await journal.productId()) as string;
    await journal.appendAll([
      {
        type: "story.started",
        actor: { kind: "system" },
        product,
        story: "1-1",
        provenance: "trusted",
        payload: {
          agent: "main",
          branch: "feat/1-1-sign-in",
          base: "c".repeat(40),
          base_ref: "main",
          worktree: "../shop.worktrees/1-1",
        },
      },
    ]);
    const registry = createCommandRegistry();
    const result = await registry.run("report_deviation", context, {
      agent: "quentin",
      story: "1-1",
      requirements: ["EF-1"],
      summary: "No lockout after five attempts",
    });
    if (!result.ok) throw new Error(`report_deviation: ${result.error.code}`);
    const traced = await registry.run("get_trace", context, { requirement: "EF-1" });
    if (!traced.ok) throw new Error(`get_trace: ${traced.error.code}`);
    expect(traced.value).toMatchObject({
      requirement: { status: "deviation", tests: [{ path: "tests/login_test.py", line: 1 }] },
    });
    return (result.value as RecordedEvent).deviation as string;
  } finally {
    journal.close();
  }
}

describe("trace: the creator's command", () => {
  it("traces each requirement, then lifts a deviation at the terminal only", async () => {
    expect((await cli(["init", "--profile", "new-product"])).status).toBe(0);
    await seedProduct();

    const listed = binary(["trace"]);
    expect(listed.stderr).toBe("");
    expect(listed.status).toBe(0);
    expect(listed.stdout).toBe(
      "Requirements: 2\nEF-1  to do  The visitor signs in.\n    stories: 1-1 · tests: 1 · pull requests: 0 · open deviations: 0\nENF-1  to do  Fast pages.\n    stories: none · tests: 0 · pull requests: 0 · open deviations: 0\nTo do: 2 · in development: 0 · in review: 0 · delivered: 0 · deviation: 0\nOne requirement in detail: npx agentplugged trace <EF-n>\n",
    );
    const json = JSON.parse(binary(["trace", "ef-1", "--json"]).stdout);
    expect(json).toMatchObject({
      action: "requirement",
      requirement: {
        id: "EF-1",
        status: "todo",
        stories: [{ id: "1-1", title: "Sign in", status: "todo" }],
        tests: [{ path: "tests/login_test.py", line: 1 }],
      },
      tests: { status: "read", references: 1 },
    });

    const id = await reportDeviation();
    expect(binary(["trace", "EF-1"]).stdout).toContain(
      `EF-1 — deviation\n    The visitor signs in.\nDefined in .agentplugged/docs/prd.md:8\nStories: 1\n  1-1  in development  Sign in\n`,
    );
    const head = git(["rev-parse", "agentplugged/journal"]);
    const outside = binary(["trace", "resolve", id, "Accepted"]);
    expect(outside.status).toBe(1);
    expect(outside.stderr).toContain("REVIEW_NOT_INTERACTIVE");
    expect(git(["rev-parse", "agentplugged/journal"])).toBe(head);

    const lifted = await cli(
      ["trace", "resolve", id.toLowerCase(), "Accepted", "for", "now"],
      true,
    );
    expect(lifted.stderr).toBe("");
    expect(lifted.status).toBe(0);
    expect(lifted.stdout).toBe(`${id} lifted: “No lockout after five attempts” (story 1-1).\n`);
    expect(binary(["trace", "EF-1"], "fr").stdout).toContain("EF-1 — en développement\n");
    const twice = await cli(["trace", "resolve", id, "Again"], true);
    expect(twice.status).toBe(1);
    expect(twice.stderr).toContain("DEVIATION_NOT_OPEN");
  });

  it("refuses arguments it does not know, a malformed id before the terminal", async () => {
    expect((await cli(["init", "--profile", "new-product"])).status).toBe(0);
    await seedProduct();
    for (const args of [
      ["trace", "EF-1", "x"],
      ["trace", "AD-1"],
      ["trace", "resolve", "V-0000000000"],
      ["trace", "resolve", "V-0000000000", "why", "--json"],
      ["trace", "--all"],
      ["trace", "--profile", "new-product"],
    ]) {
      const result = await cli(args, true);
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stderr + result.stdout, args.join(" ")).toContain("INVALID_ARGUMENTS");
    }
    // The reason too is checked before the terminal.
    const blank = binary(["trace", "resolve", "V-0000000000", " "]);
    expect(blank.status).toBe(1);
    expect(blank.stderr).toContain("INVALID_ARGUMENTS");
    const jsonOption = JSON.parse(binary(["trace", "--json", "--all"]).stdout);
    expect(jsonOption).toMatchObject({ error: { code: "INVALID_ARGUMENTS" } });
    const typo = binary(["trace", "resolve", "V-1", "why"]);
    expect(typo.status).toBe(1);
    expect(typo.stderr).toContain("INVALID_ARGUMENTS");
    // With --json, the error is JSON on standard output.
    const missing = JSON.parse(binary(["trace", "EF-9", "--json"]).stdout);
    expect(missing).toMatchObject({ error: { code: "REQUIREMENT_NOT_FOUND" } });
  });
});
