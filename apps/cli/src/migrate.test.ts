import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { GitStateStore, NodeKeyStore } from "@agentplugged/adapters-git";
import { removeTestKeys } from "@agentplugged/adapters-git/test-keychain";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./main.js";

vi.setConfig({ testTimeout: 120_000 });

const bin = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/bin.js");
/** A keychain service of this file only, deleted after each test: never the real entries. */
const service = `agentplugged-test-migrate-${process.pid}-${Date.now()}`;
const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;
const CONFIG = ".agentplugged/method.yaml";
const JOURNAL = "refs/heads/agentplugged/journal";
const OLDER = "0.0.9";

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
  cwd = await mkdtemp(join(tmpdir(), "agentplugged-migrate-"));
  home = await mkdtemp(join(tmpdir(), "agentplugged-migrate-home-"));
  await writeFile(join(home, ".gitconfig"), "");
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(home|userprofile)$/i.test(key)) inherited[key] = value;
  }
  env = {
    ...inherited,
    HOME: home,
    USERPROFILE: home,
    AGENTPLUGGED_LANG: "fr",
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

/** The CLI in process: at a terminal (the creator) or not. */
async function cli(args: string[], options: { lang?: string; interactive?: boolean } = {}) {
  let stdout = "";
  let stderr = "";
  const status = await main({
    argv: args,
    cwd,
    env: { ...env, PATH: process.env.PATH ?? "", AGENTPLUGGED_LANG: options.lang ?? "fr" },
    engineVersion: VERSION,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    stdin: Readable.from([]),
    interactive: options.interactive ?? true,
  });
  return { status, stdout, stderr };
}

/** The built binary, as an agent's shell runs it: no terminal. */
function binary(args: string[], lang = "en") {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    env: { ...env, AGENTPLUGGED_LANG: lang },
    encoding: "utf8",
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function writeConfig(text: string): Promise<void> {
  await mkdir(join(cwd, ".agentplugged"), { recursive: true });
  await writeFile(join(cwd, CONFIG), text);
}

/**
 * A list of inactive agents at format 1: the step computes it again from the new profile, so
 * any list will do (no former name is written here).
 */
const INACTIVE_FORMAT_1 = "alex, chloe, julien, milo, omar, quentin, tess, zoe";

const config = (format: number, engine: string) =>
  `# Réglages d'Ada\nformat_version: ${format}\nengine_version: ${engine}\n`;

/** The journal's event files and their content, read with Git. */
function journalFiles(): Map<string, string> {
  const files = new Map<string, string>();
  if (spawnSync("git", ["rev-parse", "--verify", "-q", JOURNAL], { cwd, env }).status !== 0) {
    return files;
  }
  for (const path of git(["ls-tree", "-r", "--name-only", JOURNAL]).split("\n")) {
    if (path !== "") files.set(path, git(["show", `${JOURNAL}:${path}`]));
  }
  return files;
}

describe("npx agentplugged migrate", () => {
  it("pins this engine, records method.migrated, then says it is up to date", async () => {
    await writeConfig(config(2, OLDER));
    const check = await cli(["migrate", "--check"], { interactive: false });
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
    expect(check.stdout).toContain("rien n'a été écrit");
    expect(check.stdout).toContain(`Moteur épinglé : ${OLDER} → ${VERSION}`);
    expect(await readFile(join(cwd, CONFIG), "utf8")).toBe(config(2, OLDER));
    expect(journalFiles().size).toBe(0);

    const done = await cli(["migrate"]);
    expect(done.stderr).toBe("");
    expect(done.status).toBe(0);
    expect(done.stdout).toContain("Migration faite");
    expect(done.stdout).toContain("Étapes : aucune");
    expect(done.stdout).toContain("npx agentplugged sync");
    const text = await readFile(join(cwd, CONFIG), "utf8");
    expect(text).toContain("# Réglages d'Ada");
    expect(text).toContain(`engine_version: ${VERSION}`);
    expect(text).toMatch(/product_id: [0-9A-Z]{26}/);
    const events = [...journalFiles().values()].map((raw) => JSON.parse(raw) as { type: string });
    const migrated = events.find((event) => event.type === "method.migrated") as
      | { payload: unknown; actor: { kind: string } }
      | undefined;
    expect(migrated?.actor.kind).toBe("system");
    expect(migrated?.payload).toEqual({
      from_format: 2,
      to_format: 2,
      from_engine: OLDER,
      to_engine: VERSION,
      steps: [],
    });

    // Again: nothing to do, and no journal file rewritten.
    const before = journalFiles();
    const again = await cli(["migrate"], { lang: "en" });
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("Already up to date");
    expect(journalFiles()).toEqual(before);
  });

  it("brings a product of format 1 to the renamed team, then sync generates it", async () => {
    await writeConfig(
      `${config(1, OLDER)}tools: [claude-code]\nprofile:\n  preset: prototype\n  domains: [product, ux, code]\n  phases: [framing, build]\n  developers: 2\nagents:\n  inactive: [${INACTIVE_FORMAT_1}]\n`,
    );
    const done = await cli(["migrate"], { lang: "en" });
    expect(done.stderr).toBe("");
    expect(done.status).toBe(0);
    expect(done.stdout).toContain("Steps: rename-agents");
    expect(done.stdout).toContain(
      "profile.developers: 2 → the backend and frontend specialties (backend, frontend), ceiling of stories at once: 2",
    );
    expect(done.stdout).toContain("npx agentplugged profile");
    const text = await readFile(join(cwd, CONFIG), "utf8");
    expect(text).toContain("format_version: 2");
    expect(text).toContain(
      "  specialties:\n    - backend\n    - frontend\n  max_parallel_stories: 2\n",
    );
    const events = [...journalFiles().values()].map((raw) => JSON.parse(raw) as { type: string });
    expect(events.find((event) => event.type === "method.migrated")).toMatchObject({
      payload: { from_format: 1, to_format: 2, steps: ["rename-agents"] },
    });
    expect(binary(["init"]).status).toBe(0);
    const sync = binary(["sync"]);
    expect(sync.stderr).toBe("");
    expect(sync.status).toBe(0);
    for (const developer of ["sam", "ethan", "hugo", "lina"]) {
      const agent = await readFile(join(cwd, `.claude/agents/${developer}.md`), "utf8");
      expect(agent, developer).toContain("\nisolation: worktree\n");
    }
    expect(await readFile(join(cwd, ".claude/agents/maya.md"), "utf8")).toContain("model: opus");
  });

  it("is refused without a terminal, as agents run it", async () => {
    await writeConfig(config(1, OLDER));
    const refused = binary(["migrate"]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("REVIEW_NOT_INTERACTIVE");
    expect(await readFile(join(cwd, CONFIG), "utf8")).toBe(config(1, OLDER));
    const misplaced = binary(["sync", "--check"]);
    expect(misplaced.status).toBe(1);
    expect(misplaced.stderr).toContain("INVALID_ARGUMENTS");
    const extra = binary(["migrate", "--check", "now"]);
    expect(extra.status).toBe(1);
    expect(extra.stderr).toContain("INVALID_ARGUMENTS");
  });

  it("stops on a journal migrated to a newer format, naming the engine to install", async () => {
    await writeConfig(config(2, VERSION));
    const store = new GitStateStore({ cwd, keys: new NodeKeyStore({ service }) });
    try {
      await store.append({
        type: "method.migrated",
        actor: { kind: "system" },
        product: "01JZ4444444444444444444444",
        provenance: "trusted",
        payload: {
          from_format: 2,
          to_format: 3,
          from_engine: VERSION,
          to_engine: "9.1.0",
          steps: ["format-three"],
        },
      });
    } finally {
      store.close();
    }
    const before = journalFiles();
    const status = await cli(["journal", "status"], { lang: "en" });
    expect(status.status).toBe(1);
    expect(status.stderr).toContain("UPGRADE_REQUIRED");
    expect(status.stderr).toContain("npx agentplugged@9.1.0 journal status");
    const migrate = await cli(["migrate"], { lang: "en" });
    expect(migrate.status).toBe(1);
    expect(migrate.stderr).toContain("npx agentplugged@9.1.0 migrate");
    expect(await readFile(join(cwd, CONFIG), "utf8")).toBe(config(2, VERSION));
    expect(journalFiles()).toEqual(before);
  });

  it("migrates a folder outside any Git repository, with no event and no commit to make", async () => {
    const outside = await mkdtemp(join(tmpdir(), "agentplugged-migrate-norepo-"));
    const repository = cwd;
    cwd = outside;
    try {
      await writeConfig(config(1, OLDER));
      const check = await cli(["migrate", "--check"], { interactive: false });
      expect(check.status).toBe(0);
      expect(check.stdout).toContain("pas de dépôt Git");
      const done = await cli(["migrate"]);
      expect(done.stderr).toBe("");
      expect(done.status).toBe(0);
      expect(done.stdout).toContain("Pas de dépôt Git ici");
      expect(done.stdout).not.toContain("committe");
      expect(await readFile(join(cwd, CONFIG), "utf8")).toContain(`engine_version: ${VERSION}`);
    } finally {
      cwd = repository;
      await rm(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  it("stops on a newer format, naming the engine to install, and never migrates it down", async () => {
    await writeConfig(config(3, "9.0.0"));
    const result = await cli(["migrate"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("UPGRADE_REQUIRED");
    expect(result.stderr).toContain("npx agentplugged@9.0.0 migrate");
    expect(await readFile(join(cwd, CONFIG), "utf8")).toBe(config(3, "9.0.0"));
  });

  it("stops other commands on an older format, and says when no migration exists", async () => {
    await writeConfig(config(0, OLDER));
    const sync = binary(["sync"], "fr");
    expect(sync.status).toBe(1);
    expect(sync.stderr).toContain("MIGRATION_REQUIRED");
    expect(sync.stderr).toContain("npx agentplugged migrate");
    const migrate = await cli(["migrate"]);
    expect(migrate.status).toBe(1);
    expect(migrate.stderr).toContain("METHOD_CONFIG_INVALID");
    expect(await readFile(join(cwd, CONFIG), "utf8")).toBe(config(0, OLDER));
    expect(journalFiles().size).toBe(0);
  });
});
