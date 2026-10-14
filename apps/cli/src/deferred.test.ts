import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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

const bin = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/bin.js");
/** A keychain service of this file only, deleted after each test: never the real entries. */
const service = `agentplugged-test-deferred-${process.pid}-${Date.now()}`;
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
  cwd = await mkdtemp(join(tmpdir(), "agentplugged-deferred-"));
  home = await mkdtemp(join(tmpdir(), "agentplugged-deferred-home-"));
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

/** The agents' side, in process: the main session defers a point that locks 2-6. */
async function deferWork(): Promise<string> {
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
    // Iris puts it off for the creator: while Noah is active, `main` is Noah.
    const result = await createCommandRegistry().run("defer_work", context, {
      agent: "iris",
      owner: "creator",
      title: "Rate-limit the sign-in form",
      origin: "deliberate",
      story: "2-5",
      locks: ["2-6"],
    });
    if (!result.ok) throw new Error(`defer_work: ${result.error.code}`);
    return (result.value as RecordedEvent).deferred as string;
  } finally {
    journal.close();
  }
}

describe("deferred: the creator's command", () => {
  it("lists, shows, refuses a closing without a terminal, and drops one at a terminal", async () => {
    expect((await cli(["init", "--profile", "new-product"])).status).toBe(0);
    const id = await deferWork();

    const listed = binary(["deferred"]);
    expect(listed.stderr).toBe("");
    expect(listed.status).toBe(0);
    expect(listed.stdout).toBe(
      `Open deferred items: 1\n${id}  Rate-limit the sign-in form\n    put off on purpose, from story 2-5 · owner: you · locks: 2-6\nDone: 0 · dropped: 0\nAn item you own, once treated, or an item to drop: say so in your AI tool's chat.\n`,
    );
    // `deferred <e-s>` is `deferred list <e-s>`.
    expect(binary(["deferred", "2-7"]).stdout).toBe(
      "No open deferred item locks story 2-7.\nDone: 0 · dropped: 0\n",
    );
    expect(binary(["deferred", "list", "02-06"]).stdout).toContain(
      "Open deferred items that lock story 2-6: 1\n",
    );
    const json = binary(["deferred", "show", id.toLowerCase(), "--json"]);
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      action: "show",
      item: { id, status: "open", locks: ["2-6"], owner: "creator" },
    });
    expect(binary(["deferred", "show", id]).stdout).toContain("Status: open\nRecorded on ");

    const head = git(["rev-parse", "agentplugged/journal"]);
    const outside = binary(["deferred", "drop", id, "Not needed"]);
    expect(outside.status).toBe(1);
    expect(outside.stderr).toContain("REVIEW_NOT_INTERACTIVE");
    expect(git(["rev-parse", "agentplugged/journal"])).toBe(head);

    const dropped = await cli(["deferred", "drop", id.toLowerCase(), "Not", "needed"], true);
    expect(dropped.stderr).toBe("");
    expect(dropped.status).toBe(0);
    expect(dropped.stdout).toBe(`${id} dropped: “Rate-limit the sign-in form”.\n`);
    expect(binary(["deferred", "list"], "fr").stdout).toBe(
      "Aucun point reporté ouvert.\nTraités : 0 · abandonnés : 1\n",
    );
    const all = binary(["deferred", "--all"]).stdout;
    expect(all).toContain(`Closed deferred items: 1\n${id}  Rate-limit the sign-in form\n`);
    expect(all).toMatch(/ {4}dropped on .+ by human:.+: Not needed\n/);
    const listedJson = JSON.parse(binary(["deferred", "list", "--all", "--json"]).stdout);
    expect(listedJson).toMatchObject({
      action: "list",
      open: [],
      closed: [{ id, status: "dropped", closed: { outcome: "dropped", reason: "Not needed" } }],
      dropped: 1,
    });
    const twice = await cli(["deferred", "resolve", id, "Again"], true);
    expect(twice.status).toBe(1);
    expect(twice.stderr).toContain("DEFERRED_NOT_OPEN");
    const missing = JSON.parse(binary(["deferred", "show", "D-0000000000", "--json"]).stdout);
    expect(missing).toMatchObject({ error: { code: "DEFERRED_NOT_FOUND" } });
  });

  it("refuses arguments it does not know, a malformed id before the terminal", async () => {
    expect((await cli(["init", "--profile", "new-product"])).status).toBe(0);
    for (const args of [
      ["deferred", "resolve", "D-0000000000"],
      ["deferred", "list", "2-6", "x"],
      ["deferred", "close", "D-0000000000", "why"],
      ["deferred", "show"],
      ["deferred", "show", "D-0000000000", "--all"],
      ["deferred", "drop", "D-0000000000", "why", "--json"],
    ]) {
      const result = await cli(args, true);
      expect(result.status, args.join(" ")).toBe(1);
      // With --json, the error is JSON on standard output.
      expect(result.stderr + result.stdout).toContain("INVALID_ARGUMENTS");
    }
    // No terminal, and a malformed id: the id is refused first.
    const typo = binary(["deferred", "drop", "D-1", "why"]);
    expect(typo.status).toBe(1);
    expect(typo.stderr).toContain("INVALID_ARGUMENTS");
    const story = await cli(["deferred", "list", "two"]);
    expect(story.status).toBe(1);
    expect(story.stderr).toContain("INVALID_ARGUMENTS");
  });
});
