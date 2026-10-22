import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTestKeys } from "@agentplugged/adapters-git/test-keychain";
import { KIMI_HOOKS_BEGIN } from "@agentplugged/core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./__helpers__/legacy-calls.js";

vi.setConfig({ testTimeout: 180_000 });

/**
 * `agentplugged kimi-hooks install|remove|status` (the only command that writes the user's own Kimi
 * settings) and `agentplugged hook kimi pre-tool` (what the installed hook runs), through the built
 * binary. The settings folder is always a temporary one (`KIMI_CODE_HOME`): never the real one.
 */

const bin = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/bin.js");
const BEGIN = KIMI_HOOKS_BEGIN;
const END = "# agentplugged:end hooks";
const MINE = 'default_model = "k2"\n\n[[hooks]]\nevent = "Stop"\ncommand = "echo mine"\n';

let cwd: string;
let home: string;
let kimi: string;
let env: Record<string, string>;
const service = `agentplugged-test-kimi-hooks-${process.pid}-${Date.now()}`;

function run(args: string[], options: { cwd?: string; input?: string } = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: options.cwd ?? cwd,
    encoding: "utf8",
    env,
    timeout: 120_000,
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function git(args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env, windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

beforeAll(() => {
  if (!existsSync(bin)) throw new Error(`Build the CLI first: ${bin} is missing`);
});

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "agentplugged-kimi-bin-"));
  home = await mkdtemp(join(tmpdir(), "agentplugged-kimi-home-"));
  kimi = join(home, "kimi-settings");
  await writeFile(join(home, ".gitconfig"), "");
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(home|userprofile|kimi_code_home)$/i.test(key)) {
      inherited[key] = value;
    }
  }
  env = {
    ...inherited,
    HOME: home,
    USERPROFILE: home,
    KIMI_CODE_HOME: kimi,
    AGENTPLUGGED_LANG: "en",
    npm_config_registry: "http://127.0.0.1:9/",
    AGENTPLUGGED_KEYCHAIN_SERVICE: service,
    GIT_CEILING_DIRECTORIES: await realpath(tmpdir()),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
  };
  delete env.CLAUDECODE;
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Ada"]);
  git(["config", "user.email", "ada@example.com"]);
});

afterEach(async () => {
  await removeTestKeys(service);
  await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const config = () => join(kimi, "config.toml");
const read = () => readFile(config(), "utf8");
const backups = async () => (await readdir(kimi)).filter((name) => name.includes("backup"));

async function seed(text: string) {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(kimi, { recursive: true });
  await writeFile(config(), text);
}

describe("agentplugged kimi-hooks", () => {
  it("shows that the hooks are missing, and writes nothing", async () => {
    const result = run(["kimi-hooks", "status"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("not installed");
    expect(result.stdout).toContain(config());
    expect(existsSync(kimi)).toBe(false);
  });

  it("installs the hooks in a file that does not exist yet, with no copy to make", async () => {
    const result = run(["kimi-hooks", "install"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("none (the file did not exist)");
    const text = await read();
    expect(text).toContain(BEGIN);
    expect(text).toContain(END);
    // The engine that installs is started directly, with `npx` behind it.
    expect(text).toMatch(
      /command = "node \\"[^"]+bin\.js\\" hook kimi pre-tool \|\| npx -y agentplugged@\S+ hook kimi pre-tool"/,
    );
    expect(text).toContain('event = "PreToolUse"');
    expect(run(["kimi-hooks", "status"]).stdout).toContain("are installed");
    // Only the temporary settings folder was touched, never the real home.
    expect(existsSync(join(home, ".kimi-code"))).toBe(false);
  });

  it("copies the file before writing, keeps the creator's entries, and is idempotent", async () => {
    await seed(MINE);
    const first = run(["kimi-hooks", "install"]);
    expect(first.status, first.stderr).toBe(0);
    const [copy] = await backups();
    expect(copy).toBeDefined();
    expect(await readFile(join(kimi, copy as string), "utf8")).toBe(MINE);
    const installed = await read();
    expect(installed.startsWith(MINE)).toBe(true);

    const second = run(["kimi-hooks", "install"]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("already installed");
    expect(await read()).toBe(installed);
    expect(await backups()).toHaveLength(1);
  });

  it("takes the hooks away cleanly and leaves the creator's file as it was", async () => {
    await seed(MINE);
    run(["kimi-hooks", "install"]);
    const removed = run(["kimi-hooks", "remove"]);
    expect(removed.status, removed.stderr).toBe(0);
    expect(await read()).toBe(MINE);
    // Two copies now: before the install, and before the removal.
    expect((await backups()).length).toBeGreaterThanOrEqual(1);
    const again = run(["kimi-hooks", "remove"]);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("holds no hook of agentplugged");
    expect(await read()).toBe(MINE);
  });

  it("removes the file it created when nothing else was in it", async () => {
    run(["kimi-hooks", "install"]);
    expect(existsSync(config())).toBe(true);
    // The settings were only ours: nothing to keep.
    const { rm: remove } = await import("node:fs/promises");
    expect(run(["kimi-hooks", "remove"]).status).toBe(0);
    expect(existsSync(config())).toBe(false);
    await remove(kimi, { recursive: true, force: true });
  });

  it("refuses a file it cannot change safely, and writes nothing", async () => {
    await seed(`${BEGIN}\nx = 1\n`);
    const unbalanced = run(["kimi-hooks", "install"]);
    expect(unbalanced.status).toBe(1);
    expect(unbalanced.stderr).toContain("marker");
    expect(await read()).toBe(`${BEGIN}\nx = 1\n`);
    await seed('hooks = [{ event = "Stop", command = "x" }]\n');
    const inline = run(["kimi-hooks", "install"]);
    expect(inline.status).toBe(1);
    expect(inline.stderr).toContain("[[hooks]]");
    expect(await read()).toBe('hooks = [{ event = "Stop", command = "x" }]\n');
    expect(await backups()).toEqual([]);
  });

  it("is used as `install`, `remove` or `status` alone", () => {
    for (const args of [["kimi-hooks"], ["kimi-hooks", "enable"], ["kimi-hooks", "install", "x"]]) {
      const result = run(args);
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stderr).toContain("kimi-hooks install|remove|status");
    }
    expect(existsSync(kimi)).toBe(false);
  });

  it("speaks French when asked", async () => {
    const result = spawnSync(process.execPath, [bin, "kimi-hooks", "status"], {
      cwd,
      encoding: "utf8",
      env: { ...env, AGENTPLUGGED_LANG: "fr" },
    });
    expect(result.stdout).toContain("ne sont pas installés");
  });
});

/** A product synchronised for Kimi alone, committed so that the rules read from `main`. */
async function product() {
  if (!existsSync(join(cwd, ".agentplugged/method.yaml"))) {
    expect(run(["init", "--profile", "new-product"]).status).toBe(0);
  }
  const path = join(cwd, ".agentplugged/method.yaml");
  const text = (await readFile(path, "utf8")).replace(/tools:\n(?: {2}- .*\n)+/, "");
  await writeFile(path, `${text}tools: [kimi]\n`);
  return run(["sync"]);
}

describe("agentplugged sync, with Kimi", () => {
  it("proposes the hooks while they are missing, and stops once they are installed", async () => {
    const synced = await product();
    expect(synced.status, synced.stderr).toBe(0);
    expect(synced.stdout).toContain("npx agentplugged kimi-hooks install");
    expect(synced.stdout).toContain(config());
    // `sync` itself wrote nothing outside the project.
    expect(existsSync(kimi)).toBe(false);

    expect(run(["kimi-hooks", "install"]).status).toBe(0);
    const again = run(["sync"]);
    expect(again.stdout).not.toContain("kimi-hooks install");
    expect(again.stdout).not.toContain("Kimi Code CLI, permissions:");
    expect(again.stdout).toContain("Kimi Code CLI, proof of the chat");
  });
});

describe("agentplugged hook kimi pre-tool", () => {
  const payload = (tool_input: Record<string, unknown>, at = cwd) =>
    JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "kimi-session-1",
      session_title: "t",
      client_type: "tui",
      cwd: at,
      tool_input,
    });
  const hook = (input: string, at = cwd) => run(["hook", "kimi", "pre-tool"], { cwd: at, input });

  async function committed() {
    const synced = await product();
    expect(synced.status, synced.stderr).toBe(0);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "method"]);
  }

  it("lets a harmless command through with no output", async () => {
    await committed();
    const result = hook(payload({ command: "git status" }));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("denies, in Kimi's own words, what the product denies", async () => {
    await committed();
    const result = hook(payload({ command: "git push origin main" }));
    expect(result.status, result.stderr).toBe(0);
    const answer = JSON.parse(result.stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(answer.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(answer.hookSpecificOutput.permissionDecisionReason).toMatch(/AgentPlugged|main/);
  });

  it("denies a write of a protected file, whatever the tool is called", async () => {
    await committed();
    const result = hook(payload({ file_path: join(cwd, ".agentplugged", "method.yaml") }));
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    const ok = hook(payload({ file_path: join(cwd, "src", "a.ts") }));
    expect(ok.stdout).toBe("");
  });

  it("turns a rule that asks into a denial that sends the agent to the chat", async () => {
    expect(run(["init", "--profile", "new-product"]).status).toBe(0);
    // The creator's own choice, in the product's configuration: the internet asks first.
    const path = join(cwd, ".agentplugged/method.yaml");
    await writeFile(
      path,
      `${await readFile(path, "utf8")}rules:
  internet: ask
`,
    );
    await committed();
    const result = hook(payload({ command: "curl https://example.com/data.json" }));
    expect(result.status, result.stderr).toBe(0);
    const answer = JSON.parse(result.stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(answer.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(answer.hookSpecificOutput.permissionDecisionReason).toContain("ask the creator");
  });

  it("does nothing outside a product served by Kimi, whatever the command", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "agentplugged-kimi-else-"));
    try {
      const result = hook(payload({ command: "git push origin main" }, elsewhere), elsewhere);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    } finally {
      await rm(elsewhere, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  it("does nothing in a product that does not target Kimi", async () => {
    expect(run(["init", "--profile", "new-product"]).status).toBe(0);
    const path = join(cwd, ".agentplugged/method.yaml");
    const text = (await readFile(path, "utf8")).replace(/tools:\n(?: {2}- .*\n)+/, "");
    await writeFile(path, `${text}tools: [claude-code]\n`);
    expect(run(["sync"]).status).toBe(0);
    const result = hook(payload({ command: "git push origin main" }));
    expect(result.stdout).toBe("");
  });

  it("reads the product from a subfolder, and ignores an input without a tool", async () => {
    await committed();
    const sub = join(cwd, "src");
    await (await import("node:fs/promises")).mkdir(sub, { recursive: true });
    const denied = hook(payload({ command: "git push origin main" }, sub), sub);
    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    const bare = hook(JSON.stringify({ hook_event_name: "PreToolUse", cwd }));
    expect(bare.status).toBe(0);
    expect(bare.stdout).toBe("");
  });

  it("is used as `hook kimi pre-tool` only", () => {
    const result = run(["hook", "kimi", "post-tool"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("INVALID_ARGUMENTS");
  });
});
