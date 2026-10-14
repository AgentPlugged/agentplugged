import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { GitStateStore, NodeKeyStore, NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import { removeTestKeys } from "@agentplugged/adapters-git/test-keychain";
import {
  type CommandContext,
  createCommandRegistry,
  type HistoryEntry,
  type RecordedEvent,
} from "@agentplugged/core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_KEYCHAIN } from "./export-target.js";
import { localDateTime } from "./history-text.js";
import { main } from "./main.js";

vi.setConfig({ testTimeout: 120_000 });

const bin = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/bin.js");
/** A keychain service of this file only, deleted after each test: never the real entries. */
const service = `agentplugged-test-history-${process.pid}-${Date.now()}`;
/** The byte order mark the CSV export starts with. */
const BOM = String.fromCharCode(0xfeff);
const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

let cwd: string;
let home: string;
let outside: string;
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
  cwd = await mkdtemp(join(tmpdir(), "agentplugged-history-"));
  home = await mkdtemp(join(tmpdir(), "agentplugged-history-home-"));
  outside = await mkdtemp(join(tmpdir(), "agentplugged-history-out-"));
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
  for (const folder of [cwd, home, outside]) {
    if (folder !== undefined) {
      await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
});

/** Runs the CLI in process, as if the creator typed `answers` in a terminal. */
async function cli(args: string[], options: { answers?: string[]; lang?: string } = {}) {
  let stdout = "";
  let stderr = "";
  const answers = options.answers ?? [];
  const status = await main({
    argv: args,
    cwd,
    env: { ...env, PATH: process.env.PATH ?? "", AGENTPLUGGED_LANG: options.lang ?? "en" },
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

/** The agents' side, in process: opens a checkpoint as `iris`. */
async function openCheckpoint(input: Record<string, unknown>): Promise<string> {
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
      agent: "iris",
      ...input,
    });
    if (!result.ok) throw new Error(`open_checkpoint: ${result.error.code}`);
    return (result.value as RecordedEvent).checkpoint as string;
  } finally {
    journal.close();
  }
}

const STORY = {
  type: "story",
  risk: "high",
  title: 'Story 2-6 done, "really"',
  summary: "Review the work on 2-6.",
  story: "2-6",
  blocks: [{ action: "story.review", story: "2-6" }],
};

async function validated(): Promise<string> {
  const init = await cli(["init", "--profile", "new-product"]);
  expect(init.status).toBe(0);
  const id = await openCheckpoint(STORY);
  // The creator: « Approve », Enter, then the undo window runs out.
  const review = await cli(["review", id], { answers: ["1", ""] });
  expect(review.stderr).toBe("");
  expect(review.status).toBe(0);
  return id;
}

describe("history: acceptance", () => {
  it("a checkpoint answered by review is in history, and in the JSON export read back", async () => {
    const id = await validated();
    const head = git(["rev-parse", "agentplugged/journal"]);

    const exported = binary(["history", "--export", "h.json"]);
    expect(exported.stderr).toBe("");
    expect(exported.status).toBe(0);
    expect(exported.stdout).toBe("Validations exported to h.json (JSON): 1.\n");
    const entries = JSON.parse(readFileSync(join(cwd, "h.json"), "utf8")) as HistoryEntry[];
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry).toMatchObject({
      checkpoint: id,
      decision: "approved",
      source: "terminal",
      assurance: "locale",
      author_trust: "root",
      checkpoint_risk: "high",
      locale_on_high_risk: true,
      story: "2-6",
    });
    expect(entry?.author).toMatch(/^human:[\w-]{16}$/);
    expect(entry?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // A read command: nothing written to the journal.
    expect(git(["rev-parse", "agentplugged/journal"])).toBe(head);

    const listed = binary(["history"]);
    expect(listed.status).toBe(0);
    const at = entry?.at as string;
    expect(listed.stdout).toBe(
      [
        "Validations (1), most recent first:",
        `  ${localDateTime(at)} · ${entry?.author} (root key) · terminal · approved · assurance locale (the key in this machine's keychain) · ${id} (story, high risk): Story 2-6 done, "really" · story 2-6 · warning: locale assurance on a high-risk checkpoint`,
        "",
      ].join("\n"),
    );
    const french = binary(["history"], "fr");
    expect(french.stdout).toContain("(clé racine) · terminal · validé · assurance locale");
    expect(french.stdout).toContain("attention : assurance locale sur un point à risque élevé");
  });
});

describe("history", () => {
  it("without validation: « no validation », exit code 0", async () => {
    await cli(["init", "--profile", "new-product"]);
    const result = binary(["history"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("No validation.\n");
    expect(binary(["history"], "fr").stdout).toBe("Aucune validation.\n");
    const all = binary(["history", "--all"]);
    expect(all.stdout).toBe("No validation.\n\nNo ignored validation.\n");
    const exported = binary(["history", "--export", "empty.csv"]);
    expect(exported.status).toBe(0);
    const empty = readFileSync(join(cwd, "empty.csv"), "utf8");
    expect(empty.startsWith(`${BOM}at,author,`)).toBe(true);
    expect(
      empty.endsWith(
        ",event,checkpoint_phase,quote,relayed_by,channel,stack,via,ignored_reason\r\n",
      ),
    ).toBe(true);
    expect(empty.split("\r\n")).toHaveLength(2);
  });

  it("CSV export outside the repository; an existing file is kept without --force", async () => {
    const id = await validated();
    const target = join(relative(cwd, outside), "h.csv");
    const first = binary(["history", "--export", target]);
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    const csv = readFileSync(join(outside, "h.csv"), "utf8");
    const lines = csv.split("\r\n");
    expect(lines[0]?.startsWith(`${BOM}at,author,author_trust,`)).toBe(true);
    expect(lines[1]).toContain(`,${id},story,high,"Story 2-6 done, ""really""",2-6,`);

    await writeFile(join(outside, "h.csv"), "kept");
    const refused = binary(["history", "--export", target]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("Error FILE_EXISTS:");
    expect(refused.stderr).toContain("Add --force to replace it.");
    expect(readFileSync(join(outside, "h.csv"), "utf8")).toBe("kept");

    const forced = binary(["history", "--export", target, "--force"]);
    expect(forced.status).toBe(0);
    expect(forced.stdout).toContain("file replaced");
    expect(readFileSync(join(outside, "h.csv"), "utf8")).toBe(csv);
  });

  it("filters, and refuses an invalid value or export (INVALID_ARGUMENTS)", async () => {
    await validated();
    expect(binary(["history", "--story", "2-7"]).stdout).toBe("No validation.\n");
    expect(binary(["history", "--decision", "rejected"]).stdout).toBe("No validation.\n");
    expect(binary(["history", "--since", "2000-01-01", "--story", "2-6"]).stdout).toContain(
      "Validations (1)",
    );
    for (const args of [
      ["--since", "yesterday"],
      ["--story", "two"],
      ["--decision", "ok"],
      ["--export", "h.txt"],
      ["--force"],
      ["extra"],
    ]) {
      const result = binary(["history", ...args]);
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stderr, args.join(" ")).toContain("Error INVALID_ARGUMENTS:");
    }
    // The history options belong to history only, for every other command, known or not.
    for (const args of [
      ["journal", "status", "--story", "2-6"],
      ["init", "--force"],
      ["nope", "--all"],
      ["mcp", "--export", "h.json"],
    ]) {
      const other = binary(args);
      expect(other.status, args.join(" ")).toBe(1);
      expect(other.stderr, args.join(" ")).toContain("Error INVALID_ARGUMENTS:");
      expect(other.stderr, args.join(" ")).toContain("Usage: agentplugged");
    }
    const profile = binary(["history", "--profile", "prototype"]);
    expect(profile.status).toBe(1);
    expect(profile.stderr).toContain("Error INVALID_ARGUMENTS: Invalid arguments: --profile");
  });

  it("refuses an export into .agentplugged or .git, onto a folder, or without its folder", async () => {
    await validated();
    await mkdir(join(cwd, "folder.json"));
    const cases: string[][] = [
      [".agentplugged/h.json"],
      [".git/h.json"],
      [join(".git", "refs", "h.csv")],
      ["folder.json"],
      ["missing/h.json"],
    ];
    const dangling = join(cwd, "dangling.json");
    const linked = await symlink(join(cwd, "nowhere.json"), dangling).then(
      () => true,
      () => false, // No right to create links (Windows without developer mode): not tested.
    );
    if (linked) cases.push(["dangling.json"]);
    for (const [path] of cases) {
      const result = binary(["history", "--export", path as string]);
      expect(result.status, path).toBe(1);
      expect(result.stderr, path).toContain("Error INVALID_ARGUMENTS: Invalid arguments: --export");
    }
    expect(existsSync(join(cwd, ".agentplugged", "h.json"))).toBe(false);
    expect(existsSync(join(cwd, "missing"))).toBe(false);
    expect(existsSync(join(cwd, "nowhere.json"))).toBe(false);
  });

  it("--all --export writes the ignored answers too", async () => {
    await validated();
    const result = binary(["history", "--all", "--export", "all.json"]);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      "Validations exported to all.json (JSON): 1.\nIgnored answers exported too: 0.\n",
    );
    const read = JSON.parse(readFileSync(join(cwd, "all.json"), "utf8")) as {
      validations: HistoryEntry[];
      ignored: unknown[];
    };
    expect(read.validations).toHaveLength(1);
    expect(read.ignored).toEqual([]);
  });

  it("works in a Git folder without journal and without method.yaml", async () => {
    const result = binary(["history"]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("No validation.\n");
  });

  it("reads the journal without the keychain: the store it opens refuses every key access", async () => {
    const id = await validated();
    const journal = new GitStateStore({ cwd, keys: NO_KEYCHAIN });
    try {
      const result = await createCommandRegistry().run(
        "history",
        {
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
          actor: "human",
          engineVersion: VERSION,
          journal,
        },
        {},
      );
      expect(result.ok).toBe(true);
      const entries = (result as { value: { entries: HistoryEntry[] } }).value.entries;
      expect(entries.map((entry) => entry.checkpoint)).toEqual([id]);
    } finally {
      journal.close();
    }
    await expect(NO_KEYCHAIN.readMachineSecret()).rejects.toThrow();
  });
});
