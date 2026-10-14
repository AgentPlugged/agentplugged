import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeKeyStore } from "@agentplugged/adapters-git";
import { removeTestKeys } from "@agentplugged/adapters-git/test-keychain";
import { Client } from "@modelcontextprotocol/client";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./__helpers__/legacy-calls.js";
import { productRootOf } from "./product-root.js";

vi.setConfig({ testTimeout: 180_000 });

/**
 * `agentplugged hook antigravity pre-tool|post-tool`: the engine side of the hooks of
 * Antigravity CLI's plugin, run through the built binary the way the plugin's script runs it, from
 * the plugin's own folder, which is where Antigravity starts every hook and MCP server.
 */

const bin = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/bin.js");
const CONVERSATION = "9eae3f94-67bd-4732-aee1-32feeb86e0ba";
const PLUGIN = ".agents/plugins/agentplugged";

let cwd: string;
let plugin: string;
let home: string;
let env: Record<string, string>;
const service = `agentplugged-test-hook-${process.pid}-${Date.now()}`;

function git(args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env, windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

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

async function keychainAvailable(): Promise<boolean> {
  try {
    await new NodeKeyStore({ service }).readMachineSecret();
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

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "agentplugged-hook-bin-"));
  home = await mkdtemp(join(tmpdir(), "agentplugged-hook-home-"));
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
    // The engine asks the npm registry for its latest version: never the real one here.
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
  plugin = join(cwd, PLUGIN);
});

afterEach(async () => {
  await removeTestKeys(service);
  await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** A product synchronised for Antigravity CLI alone, committed so that the rules read from `main`. */
async function product(options: { installs?: "validate" } = {}) {
  expect(run(["init", "--profile", "new-product"]).status).toBe(0);
  const config = join(cwd, ".agentplugged/method.yaml");
  const text = (await readFile(config, "utf8")).replace(/tools:\n(?: {2}- .*\n)+/, "");
  const installs = options.installs === undefined ? "" : `installs:\n  mode: ${options.installs}\n`;
  await writeFile(config, `${text}${installs}tools: [antigravity]\n`);
  expect(run(["sync"]).status).toBe(0);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "method"]);
}

/** The 8.3 short name of an existing path (Windows), or undefined when the volume gives none. */
function shortName(path: string): string | undefined {
  const script = `(New-Object -ComObject Scripting.FileSystemObject).GetFile('${path.replaceAll("'", "''")}').ShortPath`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );
  const short = result.stdout.trim();
  return result.status === 0 && short !== "" && short.toLowerCase() !== path.toLowerCase()
    ? short
    : undefined;
}

const call = (name: string, args: Record<string, unknown>) =>
  JSON.stringify({
    conversationId: CONVERSATION,
    stepIdx: 3,
    toolCall: { name, args },
    workspacePaths: [],
  });

const hook = (event: string, input: string) =>
  run(["hook", "antigravity", event], { cwd: plugin, input });

const decision = (event: string, input: string) => {
  const result = hook(event, input);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as { decision?: string; reason?: string };
};

describe("agentplugged hook antigravity", () => {
  it("finds the product from the plugin's folder, nearest first", async () => {
    await mkdir(plugin, { recursive: true });
    await mkdir(join(cwd, ".agentplugged"), { recursive: true });
    await writeFile(join(cwd, ".agentplugged/method.yaml"), "format_version: 2\n");
    const real = await realpath(cwd);
    expect(await realpath(productRootOf(plugin))).toBe(real);
    expect(await realpath(productRootOf(cwd))).toBe(real);
    // A product inside it is the nearest.
    await mkdir(join(cwd, "inner/.agentplugged"), { recursive: true });
    await writeFile(join(cwd, "inner/.agentplugged/method.yaml"), "format_version: 2\n");
    expect(await realpath(productRootOf(join(cwd, "inner/deep")))).toBe(join(real, "inner"));
    // No product above: the folder itself.
    const bare = await mkdtemp(join(tmpdir(), "agentplugged-hook-bare-"));
    try {
      expect(productRootOf(bare)).toBe(bare);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  it("applies the product's rules to a tool call, from the plugin's folder", async (context) => {
    if (!(await keychainAvailable())) context.skip("no system keychain on this machine");
    await product();
    expect(existsSync(join(plugin, "policy.json"))).toBe(true);
    // What the rules deny.
    const push = decision("pre-tool", call("run_command", { CommandLine: "git push origin main" }));
    expect(push.decision).toBe("deny");
    expect(push.reason).toContain("the permission rules deny");
    const method = decision(
      "pre-tool",
      call("write_to_file", { TargetFile: join(cwd, ".agentplugged", "method.yaml") }),
    );
    expect(method.decision).toBe("deny");
    expect(method.reason).toContain("Edit(/.agentplugged/method.yaml)");
    expect(
      decision("pre-tool", call("run_command", { CommandLine: "agy -p valide" })).decision,
    ).toBe("deny");
    expect(
      decision("pre-tool", call("view_file", { AbsolutePath: join(cwd, ".env") })).decision,
    ).toBe("deny");
    // What they let through, and what they ask.
    expect(decision("pre-tool", call("run_command", { CommandLine: "echo bonjour" }))).toEqual({
      decision: "allow",
    });
    expect(
      decision("pre-tool", call("write_to_file", { TargetFile: join(cwd, "src", "a.ts") }))
        .decision,
    ).toBe("allow");
    // `curl` goes through: the internet is allowed by default.
    expect(
      decision("pre-tool", call("run_command", { CommandLine: "curl https://example.com" }))
        .decision,
    ).toBe("allow");
    // The short Windows name of a protected file is that file, whatever the rules read as written.
    if (process.platform === "win32") {
      const short = shortName(join(cwd, ".agentplugged", "method.yaml"));
      if (short !== undefined) {
        expect(
          decision("pre-tool", call("write_to_file", { TargetFile: short })).decision,
          short,
        ).toBe("deny");
      }
    }
  });

  it("opens a checkpoint for an installation the creator validates, once", async (context) => {
    if (!(await keychainAvailable())) context.skip("no system keychain on this machine");
    await product({ installs: "validate" });
    const install = call("run_command", { CommandLine: "npm install left-pad", Cwd: cwd });
    const first = decision("pre-tool", install);
    expect(first.decision).toBe("deny");
    expect(first.reason).toMatch(/checkpoint G-[0-9A-Z]+ waits for their answer/);
    const again = decision("pre-tool", install);
    expect(again).toEqual(first);
    const status = run(["journal", "status"], { cwd });
    // init (4 events) + the one checkpoint, opened once.
    expect(status.stdout).toContain("Events applied: 5");
    expect(status.stdout).toContain("Open checkpoints (1):");
  });

  it("records a read of external content after a tool, and answers {}", async (context) => {
    if (!(await keychainAvailable())) context.skip("no system keychain on this machine");
    await product();
    const before = run(["journal", "status"], { cwd }).stdout;
    expect(before).toContain("Events applied: 4");
    const reading = call("run_command", { CommandLine: "curl https://example.com/x" });
    expect(JSON.parse(hook("post-tool", reading).stdout)).toEqual({});
    expect(JSON.parse(hook("post-tool", reading).stdout)).toEqual({});
    // Once: the journal tells that the read is already there.
    expect(run(["journal", "status"], { cwd }).stdout).toContain("Events applied: 5");
    expect(JSON.parse(hook("post-tool", call("view_file", { AbsolutePath: "a" })).stdout)).toEqual(
      {},
    );
    expect(run(["journal", "status"], { cwd }).stdout).toContain("Events applied: 5");
  });

  it("never lets a call through it cannot check, and never fails a hook", async (context) => {
    if (!(await keychainAvailable())) context.skip("no system keychain on this machine");
    await product();
    for (const input of [
      "",
      "not json",
      "{}",
      '{ "toolCall": {} }',
      '{ "toolCall": { "name": 4 } }',
    ]) {
      expect(decision("pre-tool", input).decision, input).toBe("deny");
      expect(JSON.parse(hook("post-tool", input).stdout), input).toEqual({});
    }
    // A product whose policy was removed: nothing is let through.
    await rm(join(plugin, "policy.json"));
    const answer = decision("pre-tool", call("run_command", { CommandLine: "echo bonjour" }));
    expect(answer.decision).toBe("deny");
    expect(answer.reason).toContain("policy.json");
  });

  it("is used as `hook antigravity pre-tool|post-tool` only", () => {
    for (const args of [
      ["hook"],
      ["hook", "antigravity"],
      ["hook", "antigravity", "other"],
      ["hook", "claude", "pre-tool"],
      ["hook", "antigravity", "pre-tool", "x"],
    ]) {
      const result = run(args, { input: "{}" });
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stdout, args.join(" ")).toBe("");
      expect(result.stderr, args.join(" ")).toContain("INVALID_ARGUMENTS");
      expect(result.stderr, args.join(" ")).toContain("hook:");
    }
  });
});

describe("agentplugged mcp, started by Antigravity from its plugin's folder", () => {
  it("serves the product that holds the plugin", async (context) => {
    if (!(await keychainAvailable())) context.skip("no system keychain on this machine");
    await product();
    const child = spawn(process.execPath, [bin, "mcp"], {
      cwd: plugin,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const client = new Client({ name: "antigravity-client", version: "v1.0.0" });
    if (child.stdout === null || child.stdin === null) throw new Error("no pipes");
    await client.connect(new StdioServerTransport(child.stdout, child.stdin));
    try {
      const state = (await client.callTool({ name: "get_state", arguments: {} })) as {
        isError?: boolean;
        structuredContent?: { product?: string };
      };
      expect(state.isError).toBeFalsy();
      const method = readFileSync(join(cwd, ".agentplugged/method.yaml"), "utf8");
      expect(method).toContain(`product_id: ${state.structuredContent?.product}`);
    } finally {
      child.stdin.end();
      await new Promise((done) => child.once("exit", done));
    }
  });
});

/** A product synchronised for Codex alone, committed so that the rules read from `main`. */
async function codexProduct() {
  expect(run(["init", "--profile", "new-product"]).status).toBe(0);
  const config = join(cwd, ".agentplugged/method.yaml");
  const text = (await readFile(config, "utf8")).replace(/tools:\n(?: {2}- .*\n)+/, "");
  await writeFile(config, `${text}tools: [codex]\n`);
  expect(run(["sync"]).status).toBe(0);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "method"]);
}

const codexCall = (name: string, input: Record<string, unknown>) =>
  JSON.stringify({
    session_id: "019a1c2e-7b3d",
    turn_id: "t1",
    tool_name: name,
    tool_input: input,
  });

const codexDecision = (event: string, input: string, from = cwd) => {
  const result = run(["hook", "codex", event], { cwd: from, input });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as { decision?: string; reason?: string };
};

describe("agentplugged hook codex", () => {
  it("applies the product's rules to a shell command and to a patch", async (context) => {
    if (!(await keychainAvailable())) context.skip("no system keychain on this machine");
    await codexProduct();
    expect(existsSync(join(cwd, ".codex/hooks/agentplugged-policy.json"))).toBe(true);
    const push = codexDecision("pre-tool", codexCall("Bash", { command: "git push origin main" }));
    expect(push.decision).toBe("deny");
    expect(push.reason).toContain("the permission rules deny");
    expect(
      codexDecision("pre-tool", codexCall("Bash", { command: "codex exec valide" })).decision,
    ).toBe("deny");
    const method = codexDecision(
      "pre-tool",
      codexCall("apply_patch", {
        command:
          "*** Begin Patch\n*** Update File: .agentplugged/method.yaml\n@@\n-a\n+b\n*** End Patch",
      }),
    );
    expect(method.decision).toBe("deny");
    expect(method.reason).toContain("Edit(/.agentplugged/method.yaml)");
    expect(codexDecision("pre-tool", codexCall("Bash", { command: "echo bonjour" }))).toEqual({
      decision: "allow",
    });
    expect(
      codexDecision(
        "pre-tool",
        codexCall("apply_patch", { command: "*** Update File: src/a.ts\n" }),
      ).decision,
    ).toBe("allow");
    // From a sub-folder, the product is found all the same.
    await mkdir(join(cwd, "src"), { recursive: true });
    expect(
      codexDecision(
        "pre-tool",
        codexCall("Bash", { command: "git push origin main" }),
        join(cwd, "src"),
      ).decision,
    ).toBe("deny");
  });

  it("denies every call when the policy is gone: nothing is let through unseen", async (context) => {
    if (!(await keychainAvailable())) context.skip("no system keychain on this machine");
    await codexProduct();
    await rm(join(cwd, ".codex/hooks/agentplugged-policy.json"));
    const answer = codexDecision("pre-tool", codexCall("Bash", { command: "echo bonjour" }));
    expect(answer.decision).toBe("deny");
    expect(answer.reason).toContain("agentplugged-policy.json");
  });

  it("records nothing and answers {} after a tool, whatever it read", async (context) => {
    if (!(await keychainAvailable())) context.skip("no system keychain on this machine");
    await codexProduct();
    expect(
      codexDecision("post-tool", codexCall("Bash", { command: "curl https://example.com" })),
    ).toEqual({});
    expect(codexDecision("post-tool", "not json")).toEqual({});
  });

  it("is used as `hook codex pre-tool|post-tool` only", () => {
    for (const args of [
      ["hook", "codex"],
      ["hook", "codex", "user-prompt"],
      ["hook", "codex", "pre-tool", "x"],
    ]) {
      const result = run(args, { input: "{}" });
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stdout, args.join(" ")).toBe("");
      expect(result.stderr, args.join(" ")).toContain("INVALID_ARGUMENTS");
    }
  });
});

/** A product synchronised for Cursor alone, committed so that the rules read from `main`. */
async function cursorProduct() {
  expect(run(["init", "--profile", "new-product"]).status).toBe(0);
  const config = join(cwd, ".agentplugged/method.yaml");
  const text = (await readFile(config, "utf8")).replace(/tools:\n(?: {2}- .*\n)+/, "");
  await writeFile(config, `${text}tools: [cursor]\n`);
  expect(run(["sync"]).status).toBe(0);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "method"]);
}

/** The input of a hook of Cursor 3.23.12: the event, the conversation, then its own fields. */
const cursorInput = (event: string, fields: Record<string, unknown>) =>
  JSON.stringify({
    session_id: "5f0e9c1a-2b7d-4c3e-9a41-0d8b6e7f1234",
    conversation_id: "5f0e9c1a-2b7d-4c3e-9a41-0d8b6e7f1234",
    hook_event_name: event,
    cursor_version: "3.23.12",
    ...fields,
  });

const cursorDecision = (event: string, input: string, from = cwd) => {
  const result = run(["hook", "cursor", event], { cwd: from, input });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as { decision?: string; reason?: string };
};

describe("agentplugged hook cursor", () => {
  it("applies the product's rules to a shell command and to a file write", async (context) => {
    if (!(await keychainAvailable())) context.skip("no system keychain on this machine");
    await cursorProduct();
    expect(existsSync(join(cwd, ".cursor/hooks/agentplugged-policy.json"))).toBe(true);
    const shell = (command: string) =>
      cursorDecision(
        "pre-tool",
        cursorInput("beforeShellExecution", { command, cwd, sandbox: false }),
      );
    const push = shell("git push origin main");
    expect(push.decision).toBe("deny");
    expect(push.reason).toContain("the permission rules deny");
    expect(shell("cursor-agent -p valide").decision).toBe("deny");
    expect(shell("cat .env").decision).toBe("deny");
    expect(shell("echo bonjour")).toEqual({ decision: "allow" });
    const write = (file: string, name = "Write") =>
      cursorDecision(
        "pre-tool",
        cursorInput("preToolUse", { tool_name: name, tool_input: { file_path: file }, cwd }),
      );
    const method = write(join(cwd, ".agentplugged", "method.yaml"));
    expect(method.decision).toBe("deny");
    expect(method.reason).toContain("Edit(/.agentplugged/method.yaml)");
    expect(write(join(cwd, ".cursor", "hooks.json"), "Delete").decision).toBe("deny");
    expect(write(join(cwd, "src", "a.ts"))).toEqual({ decision: "allow" });
    // From a sub-folder, the product is found all the same.
    await mkdir(join(cwd, "src"), { recursive: true });
    expect(
      cursorDecision(
        "pre-tool",
        cursorInput("beforeShellExecution", { command: "git push origin main", cwd }),
        join(cwd, "src"),
      ).decision,
    ).toBe("deny");
  });

  it("denies every call when the policy is gone: nothing is let through unseen", async (context) => {
    if (!(await keychainAvailable())) context.skip("no system keychain on this machine");
    await cursorProduct();
    await rm(join(cwd, ".cursor/hooks/agentplugged-policy.json"));
    const answer = cursorDecision(
      "pre-tool",
      cursorInput("beforeShellExecution", { command: "echo bonjour", cwd }),
    );
    expect(answer.decision).toBe("deny");
    expect(answer.reason).toContain("agentplugged-policy.json");
  });

  it("denies a command that is no text, and answers {} after a tool, whatever it read", async (context) => {
    if (!(await keychainAvailable())) context.skip("no system keychain on this machine");
    await cursorProduct();
    expect(
      cursorDecision("pre-tool", cursorInput("beforeShellExecution", { command: 3, cwd })).decision,
    ).toBe("deny");
    expect(
      cursorDecision(
        "post-tool",
        cursorInput("afterShellExecution", { command: "curl https://example.com", output: "" }),
      ),
    ).toEqual({});
    expect(
      cursorDecision(
        "post-tool",
        cursorInput("postToolUse", { tool_name: "WebFetch", tool_input: { url: "https://x.y" } }),
      ),
    ).toEqual({});
    expect(cursorDecision("post-tool", "not json")).toEqual({});
  });

  it("is used as `hook cursor pre-tool|post-tool` only", () => {
    for (const args of [
      ["hook", "cursor"],
      ["hook", "cursor", "before-submit"],
      ["hook", "cursor", "pre-tool", "x"],
    ]) {
      const result = run(args, { input: "{}" });
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stdout, args.join(" ")).toBe("");
      expect(result.stderr, args.join(" ")).toContain("INVALID_ARGUMENTS");
    }
  });
});
