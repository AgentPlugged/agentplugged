import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeKeyStore } from "@agentplugged/adapters-git";
import { removeTestKeys } from "@agentplugged/adapters-git/test-keychain";
import { Client } from "@modelcontextprotocol/client";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "./__helpers__/legacy-calls.js";

vi.setConfig({ testTimeout: 120_000 });

/** The built binary, run as `npx agentplugged mcp` would run it. */
const bin = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/bin.js");
const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

let cwd: string;
let home: string;
let env: Record<string, string>;
/** A keychain service of this run only: the machine's real entry is never touched. */
const service = `agentplugged-test-mcp-${process.pid}-${Date.now()}`;

/** Runs git in the test repository; never in this one, never on the network. */
function git(args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env, windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function run(args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: "utf8",
    env,
    timeout: 90_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** True when this machine has a system keychain (a Linux server may have none). */
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
  cwd = await mkdtemp(join(tmpdir(), "agentplugged-mcp-bin-"));
  home = await mkdtemp(join(tmpdir(), "agentplugged-mcp-home-"));
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
  await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** The server as an AI tool starts it, and an MCP client on its stdio. */
async function connect(
  options: { lang?: string; args?: string[]; env?: Record<string, string> } = {},
): Promise<{ child: ChildProcess; client: Client; stderr: string[] }> {
  const child = spawn(process.execPath, [bin, "mcp", ...(options.args ?? [])], {
    cwd,
    env: { ...env, AGENTPLUGGED_LANG: options.lang ?? "en", ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stderr: string[] = [];
  child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  const client = new Client({ name: "test-client", version: "1.0.0" });
  // Newline-delimited JSON over the child's pipes: the stdio transport, seen from the client.
  if (child.stdout === null || child.stdin === null) throw new Error("no pipes");
  await client.connect(new StdioServerTransport(child.stdout, child.stdin));
  return { child, client, stderr };
}

/** Closes stdin, as a tool does when it stops the server, and waits for the process to end. */
function stop(child: ChildProcess): Promise<number | null> {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error("mcp did not exit after stdin closed")), 20_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      done(code);
    });
    child.stdin?.end();
  });
}

describe("agentplugged mcp", () => {
  it("serves report_status then get_state after init and sync, and exits when stdin closes", async (context) => {
    if (!(await keychainAvailable())) context.skip("no system keychain on this machine");
    expect(run(["init", "--profile", "new-product"]).status).toBe(0);
    // The four tools, whatever this machine has installed.
    const config = join(cwd, ".agentplugged/method.yaml");
    const text = (await readFile(config, "utf8")).replace(/tools:\n(?: {2}- .*\n)+/, "");
    await writeFile(config, `${text}tools: [claude-code, codex, antigravity, cursor]\n`);
    expect(run(["sync"]).status).toBe(0);
    // sync declared the server with the pinned engine.
    const declared = JSON.parse(await readFile(join(cwd, ".mcp.json"), "utf8"));
    // On Windows, AI tools cannot start `npx` directly: sync declares `cmd /c npx`.
    const npx = ["-y", `agentplugged@${VERSION}`, "mcp"];
    expect(declared.mcpServers.agentplugged).toMatchObject(
      process.platform === "win32"
        ? { command: "cmd", args: ["/c", "npx", ...npx] }
        : { command: "npx", args: npx },
    );

    const { child, client, stderr } = await connect();
    const { tools } = await client.listTools();
    // Ten grouped tools, in place of the 46 one-action tools.
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "agent",
      "chat",
      "checkpoint",
      "guard",
      "measure",
      "memory",
      "plan",
      "review",
      "state",
      "story",
    ]);
    const reported = (await client.callTool({
      name: "report_status",
      arguments: { agent: "iris", status: "working", task: "brief" },
    })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
    expect(reported.isError).toBeFalsy();
    const state = (await client.callTool({ name: "get_state", arguments: { full: true } })) as {
      structuredContent?: Record<string, unknown>;
    };
    expect(state.structuredContent).toMatchObject({
      agents: { iris: { status: "working", task: "brief" } },
    });
    const ghost = (await client.callTool({
      name: "report_status",
      arguments: { agent: "ghost", status: "working" },
    })) as { isError?: boolean; content: Array<{ text?: string }> };
    expect(ghost.isError).toBe(true);
    expect(ghost.content[0]?.text).toBe(
      'Error AGENT_NOT_FOUND: No active agent named "ghost" in this product: give your own agent id, as listed in .agentplugged/agents/.',
    );

    // stdin closed: the process ends by itself, its git processes released.
    expect(await stop(child)).toBe(0);
    expect(stderr.join("")).toBe("");

    // The journal counts the machine's key, the product, the creator's key and the product key
    // (both published by init), and Iris's status.
    const status = run(["journal", "status"]);
    expect(status.stderr).toBe("");
    expect(status.stdout).toContain("  Devices: 1\n  Creators' keys: 1\n  Events applied: 5\n");
  });

  it("encrypts costs and memory files through the built binary", async (context) => {
    if (!(await keychainAvailable())) context.skip("no system keychain on this machine");
    expect(run(["init", "--profile", "new-product"]).status).toBe(0);
    const { child, client, stderr } = await connect();
    type Result = { isError?: boolean; structuredContent?: Record<string, unknown> };
    const call = async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as Result;
    expect(
      (await call("report_cost", { agent: "iris", usd: 9.87, estimated: false })).isError,
    ).toBeFalsy();
    const state = (await call("get_state", { full: true })).structuredContent;
    expect(state).toMatchObject({ warnings: [] });
    expect(state).not.toHaveProperty("costs");
    const written = await call("write_sensitive", {
      agent: "iris",
      area: "memory",
      path: "lessons.md",
      content: "Toujours relire le plan.",
    });
    expect(written.isError).toBeFalsy();
    const onDisk = await readFile(join(cwd, ".agentplugged/memory/lessons.md"), "utf8");
    expect(onDisk.startsWith("agentplugged-enc:1:pk:")).toBe(true);
    expect(onDisk).not.toContain("relire");
    const read = await call("read_sensitive", {
      agent: "iris",
      area: "memory",
      path: "lessons.md",
    });
    expect(read.structuredContent).toEqual({
      area: "memory",
      path: "lessons.md",
      content: "Toujours relire le plan.",
    });
    // The story tools reach Git and the forge through the server: a refusal, never UNEXPECTED
    //.
    type Refusal = { isError?: boolean; content: Array<{ text?: string }> };
    const start = (await client.callTool({
      name: "start_story",
      arguments: { agent: "sam", story: "9-9" },
    })) as Refusal;
    expect(start.isError).toBe(true);
    expect(start.content[0]?.text).toMatch(/^Error STORY_NOT_STARTABLE: No story 9-9/);
    const pr = (await client.callTool({
      name: "open_pull_request",
      arguments: {
        agent: "sam",
        story: "9-9",
        criteria: [],
        tests: { status: "passed", summary: "All green." },
      },
    })) as Refusal;
    expect(pr.isError).toBe(true);
    expect(pr.content[0]?.text).toMatch(/^Error PULL_REQUEST_NOT_OPENABLE: No story 9-9/);
    expect(await stop(child)).toBe(0);
    expect(stderr.join("")).toBe("");
    // Nothing of the amount in the journal's commits.
    const journal = spawnSync("git", ["log", "-p", "agentplugged/journal"], {
      cwd,
      env,
      encoding: "utf8",
      windowsHide: true,
    });
    expect(journal.stdout).toContain("payload_enc");
    expect(journal.stdout).not.toContain("9.87");
  });

  it("refuses update_story to review while a decision checkpoint blocks it", async (context) => {
    if (!(await keychainAvailable())) context.skip("no system keychain on this machine");
    expect(run(["init", "--profile", "new-product"]).status).toBe(0);
    const { child, client, stderr } = await connect();
    const options = [
      { id: "stripe", label: "Stripe", consequence: "Fast to ship." },
      { id: "paddle", label: "Paddle", consequence: "Handles VAT." },
    ];
    const opened = (await client.callTool({
      name: "open_checkpoint",
      arguments: {
        agent: "iris",
        type: "decision",
        risk: "medium",
        title: "Payment provider",
        summary: "Which provider do we launch with?",
        story: "2-6",
        blocks: [{ action: "story.review", story: "2-6" }],
        options,
        recommendation: "paddle",
      },
    })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
    expect(opened.isError).toBeFalsy();
    const id = opened.structuredContent?.checkpoint as string;

    const refused = (await client.callTool({
      name: "update_story",
      arguments: { agent: "iris", story: "2-6", status: "in_review" },
    })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toEqual({
      code: "CHECKPOINT_OPEN",
      details: { action: "story.review", do: expect.stringContaining("state.next") },
      message: expect.stringContaining(id),
    });

    const state = (await client.callTool({ name: "get_state", arguments: { full: true } })) as {
      structuredContent?: Record<string, unknown>;
    };
    expect(state.structuredContent).toMatchObject({
      checkpoints: {
        [id]: { status: "open", type: "decision", options, recommendation: "paddle" },
      },
      stories: { "2-6": { waiting_on: [id] } },
    });
    expect(await stop(child)).toBe(0);
    expect(stderr.join("")).toBe("");
  });

  it("marks a session by its reads only, and blocks nothing for them", async (context) => {
    if (!(await keychainAvailable())) context.skip("no system keychain on this machine");
    expect(run(["init", "--profile", "new-product"]).status).toBe(0);
    const { child, client, stderr } = await connect();
    type Result = { isError?: boolean; structuredContent?: Record<string, unknown> };
    const call = async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as Result;
    // The internet is allowed by default: a session starts trusted, and is marked by its reads.
    expect((await call("get_state", { full: true })).structuredContent?.session).toEqual({
      trusted: true,
      reads: [],
    });
    const install = {
      agent: "iris",
      action: "install_dependency",
      detail: "npm install left-pad",
    };
    expect((await call("request_action", install)).structuredContent).toEqual({
      decision: "proceed",
      reason: "allowed",
    });
    // A hook reports a web read: a trace, for the rest of the session's life.
    const read = await call("record_external_read", {
      tool: "WebFetch",
      source: "https://evil.example/page",
      session: "claude-session-1",
    });
    expect(read.isError).toBeFalsy();
    const state = (await call("get_state", { full: true })).structuredContent;
    expect(state?.session).toEqual({
      trusted: false,
      reads: [{ tool: "WebFetch", source: "evil.example" }],
    });
    expect(state?.external_reads).toMatchObject({
      total: 1,
      recent: [{ tool: "WebFetch", source: "evil.example", agent: "main" }],
    });
    // Nothing waits for it.
    expect((await call("request_action", install)).structuredContent).toEqual({
      decision: "proceed",
      reason: "allowed",
    });
    const hook = (await client.callTool({
      name: "check_action",
      arguments: { action: "install_dependency", command: "npm install x" },
    })) as { content: Array<{ text?: string }> };
    expect(JSON.parse(hook.content[0]?.text ?? "{}")).toEqual({});
    expect(await stop(child)).toBe(0);
    expect(stderr.join("")).toBe("");
  });

  it("answers agents in English whatever the creator's language", async (context) => {
    if (!(await keychainAvailable())) context.skip("no system keychain on this machine");
    expect(run(["init", "--profile", "new-product"]).status).toBe(0);
    const { child, client } = await connect({ lang: "fr" });
    const ghost = (await client.callTool({
      name: "report_status",
      arguments: { agent: "ghost", status: "working" },
    })) as { isError?: boolean; content: Array<{ text?: string }> };
    expect(ghost.content[0]?.text).toBe(
      'Error AGENT_NOT_FOUND: No active agent named "ghost" in this product: give your own agent id, as listed in .agentplugged/agents/.',
    );
    expect(await stop(child)).toBe(0);
  });

  it("lets an agent read the machine with check_environment, and refuses where the check is off", async (context) => {
    if (!(await keychainAvailable())) context.skip("no system keychain on this machine");
    expect(run(["init", "--profile", "new-product"]).status).toBe(0);
    // The real machine, one point that needs no network: Node.
    const real = await connect({ env: { AGENTPLUGGED_ENVIRONMENT: "" } });
    const read = (await real.client.callTool({
      name: "check_environment",
      arguments: { check: "node" },
    })) as { isError?: boolean; structuredContent?: { points?: { id: string; status: string }[] } };
    expect(read.isError).toBeFalsy();
    expect(read.structuredContent?.points).toEqual([
      expect.objectContaining({ id: "node", status: "ok" }),
    ]);
    expect(await stop(real.child)).toBe(0);
    // Turned off (as in every test): the server says it cannot look, never invents an answer.
    const off = await connect();
    const refused = (await off.client.callTool({
      name: "check_environment",
      arguments: {},
    })) as { isError?: boolean };
    expect(refused.isError).toBe(true);
    expect(await stop(off.child)).toBe(0);
  });

  it("serves with --engine-any despite another pinned engine, with the warning on stderr", async (context) => {
    if (!(await keychainAvailable())) context.skip("no system keychain on this machine");
    expect(run(["init", "--profile", "new-product"]).status).toBe(0);
    const path = join(cwd, ".agentplugged/method.yaml");
    const text = await readFile(path, "utf8");
    await writeFile(path, text.replace(`engine_version: ${VERSION}`, "engine_version: 0.0.9"));
    const { child, client, stderr } = await connect({ args: ["--engine-any"] });
    const { tools } = await client.listTools();
    // The 46 one-action tools the server used to publish are grouped in ten.
    expect(tools).toHaveLength(10);
    expect(await stop(child)).toBe(0);
    expect(stderr.join("")).toBe(
      `Warning: .agentplugged/method.yaml pins engine 0.0.9, but engine ${VERSION} runs anyway (--engine-any). Run \`npx agentplugged init --upgrade-engine\` to pin it.\n`,
    );
  });

  it("aucun outil ne relie, ne retire ni ne liste un appareil : l'appairage n'est pas à portée d'un agent", async (context) => {
    if (!(await keychainAvailable())) context.skip("no system keychain on this machine");
    expect(run(["init", "--profile", "new-product"]).status).toBe(0);
    const { child, client } = await connect();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(10);
    const names = tools.map((tool) => tool.name);
    // The commands of the pairing and of the devices are the creator's gesture, at their terminal.
    expect(names.filter((name) => /pair|device|trust|bridge|link|root/i.test(name))).toEqual([]);
    expect(await stop(child)).toBe(0);
  });

  it("refuses arguments and options", () => {
    for (const args of [
      ["mcp", "x"],
      ["mcp", "--profile", "new-product"],
      ["mcp", "--upgrade-engine"],
    ]) {
      const { status, stdout, stderr } = run(args);
      expect(status, args.join(" ")).toBe(1);
      expect(stdout, args.join(" ")).toBe("");
      expect(stderr, args.join(" ")).toContain("Error INVALID_ARGUMENTS:");
    }
  });

  it("stops before serving when method.yaml pins another engine", async (context) => {
    if (!(await keychainAvailable())) context.skip("no system keychain on this machine");
    expect(run(["init", "--profile", "new-product"]).status).toBe(0);
    const path = join(cwd, ".agentplugged/method.yaml");
    const text = await readFile(path, "utf8");
    await writeFile(path, text.replace(`engine_version: ${VERSION}`, "engine_version: 0.0.9"));
    const { status, stdout, stderr } = run(["mcp"]);
    expect(status).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("Error ENGINE_VERSION_MISMATCH:");
  });
});
