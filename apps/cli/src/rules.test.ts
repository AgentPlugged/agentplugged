import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./main.js";

// Each test spawns the binary several times, Git included.
vi.setConfig({ testTimeout: 120_000 });

const bin = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/bin.js");
/** The built binary's version: the engine `init` pins. */
const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;
const CONFIG = ".agentplugged/method.yaml";
const SETTINGS = ".claude/settings.json";

let cwd: string;
let home: string;
/** The environment of every run: no tool of this machine, Git isolated from its configuration. */
let env: Record<string, string>;
const GIT_KEYS = [
  "GIT_CEILING_DIRECTORIES",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_GLOBAL",
  "GIT_TERMINAL_PROMPT",
] as const;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  if (!existsSync(bin)) throw new Error(`Build the CLI first: ${bin} is missing`);
});

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "agentplugged-rules-"));
  home = await mkdtemp(join(tmpdir(), "agentplugged-rules-home-"));
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
    AGENTPLUGGED_PRESENCE: "none",
    AGENTPLUGGED_ENVIRONMENT: "none",
    // Git finds no repository above the temporary folders, and no configuration of this machine.
    GIT_CEILING_DIRECTORIES: await realpath(tmpdir()),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
  };
  // The in-process runs start Git with this process's environment: isolated the same way.
  for (const key of GIT_KEYS) {
    saved[key] = process.env[key];
    process.env[key] = env[key];
  }
});

afterEach(async () => {
  for (const key of GIT_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** The built binary, without a terminal (as an agent would run it). */
function run(args: string[], options: { lang?: string; git?: boolean } = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: "utf8",
    // Without Git on the PATH unless asked: `init` then leaves the journal and the keychain alone.
    env: {
      ...env,
      PATH: options.git === true ? (process.env.PATH ?? "") : "",
      AGENTPLUGGED_LANG: options.lang ?? "en",
    },
    timeout: 90_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The CLI in process, as the creator at a terminal. */
async function atTerminal(args: string[]) {
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
    interactive: true,
  });
  return { status, stdout, stderr };
}

function git(args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env, windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const read = (path: string) => readFile(join(cwd, path), "utf8");

describe("agentplugged rules", () => {
  it("shows the table of a new product, in English and French", () => {
    expect(run(["init", "--profile", "new-product"]).status).toBe(0);
    const en = run(["rules"]);
    expect(en.status).toBe(0);
    expect(en.stdout).toContain("Permission rules (read from the working copy):");
    expect(en.stdout).toMatch(/action\s+rule\s+default\s+lock/);
    expect(en.stdout).toMatch(/internet \(access the internet\)\s+allow\s+allow\s+no/);
    expect(en.stdout).toMatch(/destructive_command \(.*\)\s+deny\s+deny\s+never allow/);
    expect(en.stdout).toMatch(/push_main \(push to the main branch\)\s+deny\s+deny\s+yes/);
    const fr = run(["rules"], { lang: "fr" });
    expect(fr.stdout).toContain("Règles de permission (lues dans la copie de travail) :");
    expect(fr.stdout).toMatch(
      /push_main \(pousser sur la branche principale\)\s+deny\s+deny\s+oui/,
    );
  });

  it("refuses set and reset to an agent (no terminal), and a locked rule to anyone", async () => {
    expect(run(["init", "--profile", "new-product"]).status).toBe(0);
    const before = await read(CONFIG);
    for (const args of [
      ["rules", "set", "internet", "allow"],
      ["rules", "reset"],
    ]) {
      const refused = run(args);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("REVIEW_NOT_INTERACTIVE");
    }
    const locked = run(["rules", "set", "push_main", "allow"]);
    expect(locked.status).toBe(1);
    expect(locked.stderr).toContain("RULE_LOCKED");
    const atKeyboard = await atTerminal(["rules", "set", "push_main", "allow"]);
    expect(atKeyboard.status).toBe(1);
    expect(atKeyboard.stderr).toContain("RULE_LOCKED");
    expect(await read(CONFIG)).toBe(before);
    const invalid = run(["rules", "set", "internet"]);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain(
      'Invalid arguments: "rules set internet" (rules [show] | rules set <action> <allow|ask|deny> | rules reset)',
    );
    const value = await atTerminal(["rules", "set", "internet", "maybe"]);
    expect(value.stderr).toContain(
      '"maybe" is not a valid value for rules set <action> <allow|ask|deny> (expected one of: allow, ask, deny).',
    );
    const french = run(["rules", "set", "teleport", "allow"], { lang: "fr" });
    expect(french.stderr).toContain(
      "« teleport » n'est pas une valeur valable pour rules set <action>",
    );
    expect(run(["rules", "show"]).status).toBe(0);
  });

  it("rules set internet ask then sync: Claude Code asks before the web", async () => {
    expect(run(["init", "--profile", "new-product"]).status).toBe(0);
    const set = await atTerminal(["rules", "set", "internet", "ask"]);
    expect(set.status).toBe(0);
    expect(set.stdout).toContain(`internet: ask recorded in ${CONFIG}.`);
    expect(await read(CONFIG)).toContain("rules:\n  internet: ask\n");
    const synced = run(["sync"]);
    expect(synced.status).toBe(0);
    expect(synced.stdout).toContain("Rules read from the working copy.");
    expect(synced.stdout).toMatch(/\d+ allow rules added to \.claude\/settings\.json/);
    expect(synced.stdout).toContain(
      "The Cursor CLI cannot ask first: the ask rules of internet are written as deny in .cursor/cli.json.",
    );
    expect(run(["sync"]).stdout).not.toContain("allow rules added");
    const settings = JSON.parse(await read(SETTINGS));
    expect(settings.permissions.ask).toEqual(expect.arrayContaining(["WebFetch", "WebSearch"]));
    const reset = await atTerminal(["rules", "reset"]);
    expect(reset.stdout).toContain(`Rules back to their defaults in ${CONFIG}.`);
    expect(await read(CONFIG)).not.toContain("rules:");
  });

  it("applies deny to push_main loosened by hand, and says RULE_LOCKED", async () => {
    expect(run(["init", "--profile", "new-product"]).status).toBe(0);
    await writeFile(join(cwd, CONFIG), `${await read(CONFIG)}rules:\n  push_main: allow\n`);
    const shown = run(["rules"]);
    expect(shown.stdout).toMatch(/push_main \(.*\)\s+deny\s+deny\s+yes/);
    expect(shown.stdout).toContain("[RULE_LOCKED]");
    const synced = run(["sync"]);
    expect(synced.status).toBe(0);
    expect(synced.stdout).toContain("push_main: allow in the working copy is ignored");
    const settings = JSON.parse(await read(SETTINGS));
    expect(settings.permissions.deny).toContain("Bash(git push * main)");
  });

  it("reads the rules from main, not from the working branch", async () => {
    expect(run(["init", "--profile", "new-product"]).status).toBe(0);
    // The main branch asks before the web: the creator's choice, recorded there.
    await writeFile(join(cwd, CONFIG), `${await read(CONFIG)}rules:\n  internet: ask\n`);
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.name", "Ada"]);
    git(["config", "user.email", "ada@example.com"]);
    git(["config", "core.autocrlf", "false"]);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "product"]);
    git(["switch", "-q", "-c", "feature/web"]);
    const set = await atTerminal(["rules", "set", "internet", "allow"]);
    expect(set.stdout).toContain("Permission rules (read from the branch main):");
    expect(set.stdout).toContain("Recorded here: allow · in force (from main): ask.");
    expect(set.stdout).toContain("Merge this change into main, then run `npx agentplugged sync`");
    const again = await atTerminal(["rules", "set", "internet", "allow"]);
    expect(again.stdout).toContain(`internet: allow already recorded in ${CONFIG}.`);
    expect(again.stdout).toContain("Merge this change into main");
    const synced = run(["sync"], { git: true });
    expect(synced.status).toBe(0);
    expect(synced.stdout).toContain("Rules read from the branch main.");
    expect(synced.stdout).toContain(
      "internet: the working copy says allow, looser than ask on the branch main: ask applies.",
    );
    const settings = JSON.parse(await read(SETTINGS));
    expect(settings.permissions.ask).toContain("WebFetch");
    expect(settings.permissions.allow).not.toContain("WebFetch");
  });
});
