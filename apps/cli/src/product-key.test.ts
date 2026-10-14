import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { GitStateStore, NodeKeyStore, NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import { removeTestKeys } from "@agentplugged/adapters-git/test-keychain";
import { type CommandContext, createCommandRegistry } from "@agentplugged/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./main.js";

// Two clones of one remote, each with its own keychain service: the first holds the product key,
// the second does not until it imports it. Real repositories: slower than 5 s.
vi.setConfig({ testTimeout: 120_000 });

const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;
const PASSPHRASE = "une phrase de passe solide";
/** Keychain services of this file only, one per machine, deleted after each test. */
const SERVICES = {
  first: `agentplugged-test-product-key-a-${process.pid}-${Date.now()}`,
  second: `agentplugged-test-product-key-b-${process.pid}-${Date.now()}`,
} as const;
type MachineName = keyof typeof SERVICES;

let root: string;
let env: Record<string, string>;
const homes = {} as Record<MachineName, string>;
const clones = {} as Record<MachineName, string>;
let remote: string;

/** Runs git in a test folder only; never in this repository, never on the network. */
function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env,
    windowsHide: true,
    // The whole history of the remote holds every version of the installed method: well over 1 MiB.
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** True when this machine has a system keychain (a Linux server may have none). */
async function keychainAvailable(): Promise<boolean> {
  try {
    await new NodeKeyStore({ service: SERVICES.first }).readHumanSecret();
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
  root = await realpath(await mkdtemp(join(tmpdir(), "agentplugged-product-key-")));
  await writeFile(join(root, ".gitconfig"), "");
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(home|userprofile)$/i.test(key)) inherited[key] = value;
  }
  env = {
    ...inherited,
    AGENTPLUGGED_LANG: "en",
    AGENTPLUGGED_PRESENCE: "none",
    AGENTPLUGGED_ENVIRONMENT: "none",
    GIT_CEILING_DIRECTORIES: await realpath(tmpdir()),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(root, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
  };
  remote = join(root, "remote.git");
  git(root, ["init", "-q", "--bare", "-b", "main", remote]);
  for (const name of ["first", "second"] as const) {
    homes[name] = join(root, `home-${name}`);
    clones[name] = join(root, name);
    await mkdir(homes[name], { recursive: true });
  }
});

afterEach(async () => {
  for (const service of Object.values(SERVICES)) {
    await removeTestKeys(service);
  }
  if (root !== undefined) {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

/** Identity of a test repository: Ada, never the creator's. */
function identify(cwd: string) {
  git(cwd, ["config", "user.name", "Ada"]);
  git(cwd, ["config", "user.email", "ada@example.com"]);
  git(cwd, ["config", "core.autocrlf", "false"]);
}

/** Runs the CLI in process on a machine, as if the creator typed `answers` in a terminal. */
async function cli(
  machine: MachineName,
  args: string[],
  options: { answers?: string[]; interactive?: boolean } = {},
) {
  let stdout = "";
  let stderr = "";
  const answers = options.answers ?? [];
  const status = await main({
    argv: args,
    cwd: clones[machine],
    env: {
      ...env,
      HOME: homes[machine],
      USERPROFILE: homes[machine],
      AGENTPLUGGED_KEYCHAIN_SERVICE: SERVICES[machine],
    },
    engineVersion: VERSION,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    stdin: Readable.from(answers.length === 0 ? [] : [answers.map((a) => `${a}\n`).join("")]),
    interactive: options.interactive ?? true,
    passphraseLimits: "min",
  });
  return { status, stdout, stderr };
}

/** An agent of the first machine reports a cost, as the MCP server would. */
async function reportCost(input: Record<string, unknown>) {
  const keys = new NodeKeyStore({ service: SERVICES.first });
  const journal = new GitStateStore({
    cwd: clones.first,
    keys,
    machineLockPath: join(homes.first, ".agentplugged", "machine-key.lock"),
  });
  const context: CommandContext = {
    files: new NodeWorkspaceFiles(clones.first),
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
    keys,
  };
  try {
    return await createCommandRegistry().run("report_cost", context, input);
  } finally {
    journal.close();
  }
}

/** The first clone, installed and pushed; the second, cloned from the remote. */
async function twoClones() {
  await mkdir(clones.first);
  git(clones.first, ["init", "-q", "-b", "main"]);
  identify(clones.first);
  const init = await cli("first", ["init", "--profile", "new-product"], { interactive: false });
  expect(init.status, init.stderr).toBe(0);
  expect(init.stdout).toContain("Product key created (pk:");
  git(clones.first, ["add", "."]);
  git(clones.first, ["commit", "-q", "-m", "method"]);
  git(clones.first, ["remote", "add", "origin", remote]);
  git(clones.first, ["push", "-q", "origin", "main"]);
  git(root, ["clone", "-q", remote, clones.second]);
  identify(clones.second);
}

/** Everything the remote holds, every version of every file. */
function remoteHistory(): string {
  return git(remote, ["log", "--all", "-p", "--format=%H"]);
}

describe("product key: two clones of one remote", () => {
  it("says sensitive_unreadable without the key, shows no cost, and no amount in clear", async () => {
    await twoClones();
    const reported = await reportCost({
      agent: "iris",
      story: "2-13",
      usd: 12.34,
      estimated: false,
    });
    expect(reported.ok).toBe(true);
    expect((await cli("first", ["journal", "sync"])).status).toBe(0);

    const synced = await cli("second", ["journal", "sync"]);
    expect(synced.status, synced.stderr).toBe(0);
    // The second machine's init creates no key: the journal names one to import.
    const second = await cli("second", ["init"], { interactive: false });
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("This product already has a product key (pk:");
    expect(second.stdout).not.toContain("Product key created");

    const withKey = await cli("first", ["journal", "status"]);
    expect(withKey.stdout).not.toContain("Costs:");
    expect(withKey.stdout).not.toContain("12.34");
    expect(withKey.stdout).not.toContain("cannot be read here");
    const withoutKey = await cli("second", ["journal", "status"]);
    expect(withoutKey.status).toBe(0);
    expect(withoutKey.stdout).not.toContain("Costs:");
    expect(withoutKey.stdout).toContain("1 encrypted events cannot be read here");
    // state.json never holds decrypted values nor this machine's warnings; .cache/ is ignored.
    for (const clone of Object.values(clones)) {
      const cache = readFileSync(join(clone, ".agentplugged/.cache/state.json"), "utf8");
      expect(cache).not.toContain("12.34");
      expect(cache).not.toContain("sensitive_unreadable");
      expect(cache).not.toContain('"costs"');
      expect(git(clone, ["check-ignore", ".agentplugged/.cache/state.json"])).toBe(
        ".agentplugged/.cache/state.json",
      );
    }

    // Nothing in the repository holds the amount in clear: not the remote, not the clones.
    expect(remoteHistory()).not.toContain("12.34");
    for (const clone of Object.values(clones)) {
      expect(git(clone, ["log", "--all", "-p"])).not.toContain("12.34");
    }
  });

  it("exports the key on the first machine and imports it on the second", async () => {
    await twoClones();
    expect(
      (await reportCost({ agent: "iris", usd: 7.5, estimated: true, tokens_in: 100 })).ok,
    ).toBe(true);
    expect((await cli("first", ["journal", "sync"])).status).toBe(0);
    expect((await cli("second", ["journal", "sync"])).status).toBe(0);

    // Not at a terminal: refused before anything.
    const agent = await cli("first", ["key", "export"], { interactive: false });
    expect(agent.status).toBe(1);
    expect(agent.stderr).toContain("REVIEW_NOT_INTERACTIVE");

    const file = join(root, "product.key");
    const exported = await cli("first", ["key", "export", "--out", file], {
      answers: [PASSPHRASE, PASSPHRASE],
    });
    expect(exported.status, exported.stderr).toBe(0);
    expect(exported.stdout).toContain(`Written to ${file}.`);
    const text = readFileSync(file, "utf8").trim();
    expect(text).toMatch(/^apk1:[A-Za-z0-9_-]+$/);
    expect(exported.stdout).not.toContain(text);
    expect(exported.stdout).not.toContain(PASSPHRASE);

    const wrong = await cli("second", ["key", "import", "--in", file], {
      answers: ["une autre phrase de passe"],
    });
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain("PASSPHRASE_INVALID");

    // The export never goes on the command line: typed (not shown) when there is no --in.
    const positional = await cli("second", ["key", "import", text], { answers: [PASSPHRASE] });
    expect(positional.status).toBe(1);
    expect(positional.stderr).toContain("never goes on the command line");
    const imported = await cli("second", ["key", "import"], { answers: [text, PASSPHRASE] });
    expect(imported.status, imported.stderr).toBe(0);
    expect(imported.stdout).toContain("imported into this machine's keychain");
    expect(imported.stdout).not.toContain(text);
    const status = await cli("second", ["journal", "status"]);
    expect(status.stdout).not.toContain("Costs:");
    expect(status.stdout).not.toContain("cannot be read here");
    expect(existsSync(file)).toBe(true);
  });

  it("prints the export without --out, never the passphrase; --out never replaces a file", async () => {
    await twoClones();
    const printed = await cli("first", ["key", "export"], { answers: [PASSPHRASE, PASSPHRASE] });
    expect(printed.status, printed.stderr).toBe(0);
    expect(printed.stdout).toMatch(/\napk1:[A-Za-z0-9_-]+\n/);
    expect(printed.stdout).not.toContain(PASSPHRASE);
    const existing = join(root, "taken.key");
    await writeFile(existing, "x");
    const taken = await cli("first", ["key", "export", "--out", existing], {
      answers: [PASSPHRASE, PASSPHRASE],
    });
    expect(taken.status).toBe(1);
    expect(taken.stderr).toContain("the file exists");
    expect(readFileSync(existing, "utf8")).toBe("x");
    const inRepo = await cli("first", ["key", "export", "--out", "product.key"], {
      answers: [PASSPHRASE, PASSPHRASE],
    });
    expect(inRepo.status).toBe(1);
    expect(inRepo.stderr).toContain("inside the repository");
    expect(existsSync(join(clones.first, "product.key"))).toBe(false);
  });

  it("creates no key in a fresh clone whose remote does not answer: sync first; once it answers, init receives the journal itself", async () => {
    await twoClones();
    expect((await cli("first", ["journal", "sync"])).status).toBe(0);
    // A remote that does not answer: no journal received, no key either.
    git(clones.second, ["remote", "set-url", "origin", join(root, "missing.git")]);
    const unreachable = await cli("second", ["init"], { interactive: false });
    expect(unreachable.status, unreachable.stderr).toBe(0);
    expect(unreachable.stdout).toContain("did not answer");
    const product = /product_id: (\S+)/.exec(
      readFileSync(join(clones.second, ".agentplugged/method.yaml"), "utf8"),
    )?.[1] as string;
    expect(
      await new NodeKeyStore({ service: SERVICES.second }).readProductSecret(product),
    ).toBeUndefined();
    // The remote is back: init itself receives the journal (nothing to sync by hand), so it
    // finds the key the journal announces, and creates none.
    git(clones.second, ["remote", "set-url", "origin", remote]);
    const received = await cli("second", ["init"], { interactive: false });
    expect(received.status, received.stderr).toBe(0);
    expect(received.stdout).toContain("This product already has a product key (pk:");
    expect(received.stdout).not.toContain("Product key created");
    expect(
      await new NodeKeyStore({ service: SERVICES.second }).readProductSecret(product),
    ).toBeUndefined();
  });

  it("refuses --out and --in outside key export and key import", async () => {
    await twoClones();
    for (const args of [
      ["journal", "status", "--out", "x"],
      ["nothing", "--in", "x"],
      ["key", "seal", "--in", "x"],
    ]) {
      const refused = await cli("first", args);
      expect(refused.status, args.join(" ")).not.toBe(0);
      expect(refused.stderr).toMatch(/--out|--in/);
    }
  });
});
