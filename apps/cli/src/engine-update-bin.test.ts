import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeKeyStore } from "@agentplugged/adapters-git";
import { removeTestKeys } from "@agentplugged/adapters-git/test-keychain";
import { NodeEngineUpdates } from "@agentplugged/adapters-tools";
import { toolInputOf } from "@agentplugged/core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./main.js";

vi.setConfig({ testTimeout: 180_000 });

/**
 * The engine's update through the built binary: a real server started as an AI tool
 * starts it, a second version installed in a folder of its own, the next call answered by the new
 * version; and `agentplugged update` against a registry on this machine. Nothing touches the real
 * registry, the machine's keychain entries or its `~/.agentplugged`.
 */

const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(cliDir, "dist/bin.js");
const VERSION = (
  JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8")) as { version: string }
).version;

/** The next patch and minor versions: what the product moves to, and what the registry announces. */
const bump = (version: string, part: "patch" | "minor"): string => {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  return part === "patch" ? `${major}.${minor}.${patch + 1}` : `${major}.${minor + 1}.0`;
};
const MOVED_TO = bump(VERSION, "patch");
const ANNOUNCED = bump(VERSION, "minor");

const service = `agentplugged-test-update-${process.pid}-${Date.now()}`;
let root: string;
let cwd: string;
let home: string;
let env: Record<string, string>;
const servers: Server[] = [];

beforeAll(() => {
  if (!existsSync(bin)) throw new Error(`Build the CLI first: ${bin} is missing`);
});

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "agentplugged-update-"));
  cwd = join(root, "product");
  home = join(root, "home");
  mkdirSync(cwd);
  mkdirSync(home);
  writeFileSync(join(home, ".gitconfig"), "");
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(home|userprofile|npm_config_registry)$/i.test(key)) {
      inherited[key] = value;
    }
  }
  env = {
    ...inherited,
    HOME: home,
    USERPROFILE: home,
    AGENTPLUGGED_LANG: "en",
    AGENTPLUGGED_KEYCHAIN_SERVICE: service,
    AGENTPLUGGED_PRESENCE: "none",
    AGENTPLUGGED_ENVIRONMENT: "none",
    GIT_CEILING_DIRECTORIES: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
    // Never the real registry: each test gives its own, on this machine.
    npm_config_registry: "http://127.0.0.1:9/",
  };
});

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((done) => server.close(done));
  await removeTestKeys(service);
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** Runs the binary and waits for it: never blocks this process, whose registry answers it. */
function run(args: string[], extra: Record<string, string> = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      env: { ...env, ...extra },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
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

/** A registry on this machine: the latest version it announces, and the packages it serves. */
async function registry(latest: string, packages: Record<string, Buffer> = {}) {
  let origin = "";
  const hits: string[] = [];
  const server = createServer((request, response) => {
    const url = request.url ?? "";
    hits.push(url);
    response.setHeader("content-type", "application/json");
    if (url === "/agentplugged/latest") {
      response.end(
        JSON.stringify({ name: "agentplugged", version: latest, releaseSummary: "Test release." }),
      );
    } else if (url === "/agentplugged") {
      const versions = Object.fromEntries(
        Object.keys(packages).map((version) => [
          version,
          {
            name: "agentplugged",
            version,
            dist: {
              tarball: `${origin}/agentplugged/-/agentplugged-${version}.tgz`,
            },
          },
        ]),
      );
      response.end(JSON.stringify({ name: "agentplugged", "dist-tags": {}, versions }));
    } else {
      const match = /^\/agentplugged\/-\/agentplugged-(.+)\.tgz$/.exec(url);
      const body = match === null ? undefined : packages[match[1] as string];
      if (body === undefined) {
        response.statusCode = 404;
        response.end("{}");
      } else response.end(body);
    }
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, hits };
}

/** A package `agentplugged` of a version whose `init` pins itself in the product, as the engine's does. */
function fakePackage(version: string): Buffer {
  const source = mkdtempSync(join(root, "pkg-"));
  mkdirSync(join(source, "dist"));
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({
      name: "agentplugged",
      version,
      type: "module",
      bin: { agentplugged: "dist/bin.js" },
      files: ["dist"],
    }),
  );
  writeFileSync(
    join(source, "dist", "bin.js"),
    `import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
appendFileSync(process.env.FAKE_LOG, process.argv.slice(2).join(" ") + "\\n");
if (process.argv[2] === "init") {
  const file = ".agentplugged/method.yaml";
  writeFileSync(file, readFileSync(file, "utf8").replace(/engine_version: .*/, "engine_version: " + version));
}
`,
  );
  const out = mkdtempSync(join(root, "tgz-"));
  const npm = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const packed = existsSync(npm)
    ? spawnSync(process.execPath, [npm, "pack", "--pack-destination", out, "--silent"], {
        cwd: source,
        encoding: "utf8",
      })
    : spawnSync("npm", ["pack", "--pack-destination", out, "--silent"], {
        cwd: source,
        encoding: "utf8",
        shell: true,
      });
  if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr}`);
  return readFileSync(join(out, readdirSync(out)[0] as string));
}

const methodPin = () =>
  /engine_version: (.*)/.exec(readFileSync(join(cwd, ".agentplugged/method.yaml"), "utf8"))?.[1];

/** The product as a Git repository, as the journal needs. */
function gitInit(): void {
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.name", "Ada"],
    ["config", "user.email", "ada@example.com"],
  ]) {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
}

/** A real server, as an AI tool starts it, and the lines of the protocol on its stdio. */
async function connect(extra: Record<string, string> = {}) {
  const child = spawn(process.execPath, [bin, "mcp"], {
    cwd,
    env: { ...env, ...extra },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stderr: string[] = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  let buffer = "";
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line !== "") {
        const message = JSON.parse(line) as { id: number };
        waiting.get(message.id)?.(message);
      }
    }
  });
  let id = 0;
  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) => {
      id += 1;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const init = (await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "update-test", version: "1" },
  })) as { result: { serverInfo: { version: string } } };
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  /** The structured answer of a tool. */
  const tool = async (name: string) => {
    // The tools are grouped: `get_state` is `state` with `action: "get"`.
    const mapped = toolInputOf(name, {});
    const reply = (await request("tools/call", {
      name: mapped?.tool ?? name,
      arguments: mapped?.input ?? {},
    })) as {
      result?: { content: Array<{ text: string }> };
    };
    if (reply.result === undefined)
      throw new Error(`${name}: ${JSON.stringify(reply)}\n${stderr.join("")}`);
    return JSON.parse(reply.result.content[0]?.text ?? "{}") as Record<string, unknown>;
  };
  const close = async () => {
    child.stdin.end();
    await new Promise((done) => child.once("exit", done));
  };
  return { init, tool, stderr, close };
}

describe("agentplugged mcp moves to the version the product pins, between two calls", () => {
  it("answers the next call with the new version, the connection intact, with a server running", async (context) => {
    if (!(await keychainAvailable())) context.skip("no system keychain on this machine");
    gitInit();
    expect((await run(["init", "--profile", "new-product"])).status).toBe(0);
    expect((await run(["sync"])).status).toBe(0);
    const announced = await registry(ANNOUNCED);
    const server = await connect({ npm_config_registry: announced.origin });
    try {
      expect(server.init.result.serverInfo.version).toBe(VERSION);
      // The registry's announcement arrives in the background: the first calls never wait for it.
      let before: Record<string, unknown> | undefined;
      await vi.waitFor(
        async () => {
          before = (await server.tool("get_state")).update_available as Record<string, unknown>;
          expect(before).toBeDefined();
        },
        { timeout: 30_000, interval: 300 },
      );
      expect((await server.tool("next")).engine_version).toBe(VERSION);
      expect(before).toMatchObject({
        version: ANNOUNCED,
        running: VERSION,
        summary: "Test release.",
      });
      // Once, and nothing of the project: one GET of the latest version.
      expect(announced.hits).toEqual(["/agentplugged/latest"]);

      // A second version, in a folder of its own (the running one is not touched: on Windows it holds
      // its native keychain module), and the product now pins it.
      const folder = join(
        home,
        ".agentplugged",
        "engines",
        MOVED_TO,
        "node_modules",
        "agentplugged",
      );
      mkdirSync(folder, { recursive: true });
      cpSync(join(cliDir, "dist"), join(folder, "dist"), { recursive: true });
      writeFileSync(
        join(folder, "package.json"),
        JSON.stringify({
          ...(JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8")) as object),
          version: MOVED_TO,
        }),
      );
      symlinkSync(join(cliDir, "node_modules"), join(folder, "node_modules"), "junction");
      const config = join(cwd, ".agentplugged/method.yaml");
      writeFileSync(
        config,
        readFileSync(config, "utf8").replace(/engine_version: .*/, `engine_version: ${MOVED_TO}`),
      );

      // The next call is the new engine's: it says so, with no reconnection and no EBUSY.
      // A loaded machine (a shared CI runner) may start the new engine slowly: the launcher tries again
      // at each call it finds idle, so the first answers are given time, and a failure shows what the
      // launcher said instead of a bare version mismatch.
      let after = await server.tool("get_state");
      for (let attempt = 0; attempt < 20 && after.engine_version !== MOVED_TO; attempt++) {
        if (/did not answer/.test(server.stderr.join(""))) break;
        await new Promise((done) => setTimeout(done, 1_000));
        after = await server.tool("get_state");
      }
      expect(after.engine_version, server.stderr.join("")).toBe(MOVED_TO);
      expect((after.update_available as { running: string }).running).toBe(MOVED_TO);
      expect(after.engine_update).toBeUndefined();
      expect(server.stderr.join("")).toContain(`engine ${VERSION} replaced by ${MOVED_TO}`);
      // Still one request to the registry: the new engine read the kept answer.
      expect(announced.hits).toEqual(["/agentplugged/latest"]);
    } finally {
      await server.close();
    }
    expect(server.stderr.join("")).not.toMatch(/EBUSY|Error/);
  });

  it("says it, with the exact gesture, when the product pins a version that is not installed", async (context) => {
    if (!(await keychainAvailable())) context.skip("no system keychain on this machine");
    gitInit();
    expect((await run(["init", "--profile", "new-product"])).status).toBe(0);
    const config = join(cwd, ".agentplugged/method.yaml");
    const server = await connect();
    try {
      writeFileSync(
        config,
        readFileSync(config, "utf8").replace(/engine_version: .*/, `engine_version: ${MOVED_TO}`),
      );
      const update = (await server.tool("next")).engine_update as
        | { running: string; installed: string; action: string }
        | undefined;
      expect(update).toMatchObject({ running: VERSION, installed: MOVED_TO });
      expect(update?.action).toContain("engine_update");
      expect(update?.action).not.toContain("/mcp");
    } finally {
      await server.close();
    }
  });
});

/**
 * `agentplugged update` as the creator runs it at a terminal: in this process, with this machine's
 * registry and a home folder of the test's own (the command is refused without a terminal, so the
 * built binary cannot be driven from here; see the last test).
 */
async function update(args: string[], extra: { registry?: string; log?: string } = {}) {
  let stdout = "";
  let stderr = "";
  const given = {
    ...env,
    ...(extra.registry === undefined ? {} : { npm_config_registry: extra.registry }),
    ...(extra.log === undefined ? {} : { FAKE_LOG: extra.log }),
  };
  const status = await main({
    argv: ["update", ...args],
    cwd,
    env: given,
    engineVersion: VERSION,
    systemLocale: "en-US",
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    interactive: true,
    platform: process.platform,
    engineUpdates: new NodeEngineUpdates({ engineVersion: VERSION, cwd, env: given, home }),
  });
  return { status, stdout, stderr };
}

describe("the release summary", () => {
  it("is declared by the package, one short line the registry shows with the version", () => {
    const { releaseSummary } = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8")) as {
      releaseSummary?: unknown;
    };
    expect(typeof releaseSummary).toBe("string");
    // Printable characters only, no more than the engine shows (200): shown as it is, nothing hidden.
    expect(releaseSummary).toMatch(/^[\x20-\x7e]{10,200}$/);
  });
});

describe("agentplugged update", () => {
  const product = () => {
    mkdirSync(join(cwd, ".agentplugged"), { recursive: true });
    writeFileSync(
      join(cwd, ".agentplugged/method.yaml"),
      `format_version: 2\nengine_version: ${VERSION}\n`,
    );
  };

  it("installs the latest version in its own folder and pins the product on it", async () => {
    product();
    const log = join(root, "fake.log");
    const served = await registry(ANNOUNCED, { [ANNOUNCED]: fakePackage(ANNOUNCED) });
    const result = await update([], { registry: served.origin, log });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Installing the new engine ${ANNOUNCED}`);
    expect(result.stdout).toContain(
      `Engine ${ANNOUNCED} is installed and the product is pinned to it`,
    );
    const folder = join(
      home,
      ".agentplugged",
      "engines",
      ANNOUNCED,
      "node_modules",
      "agentplugged",
    );
    expect(existsSync(join(folder, "dist", "bin.js"))).toBe(true);
    // The new version's own engine did it: init pinned it, then sync.
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["init --upgrade-engine", "sync"]);
    expect(methodPin()).toBe(ANNOUNCED);
    // A second run finds the version installed and the product already on it: nothing is redone.
    const again = await update([], { registry: served.origin, log });
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("the product already pinned it");
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("is quiet and harmless when the registry has nothing, or is not there", async () => {
    product();
    const same = await registry(VERSION);
    const up = await update([], { registry: same.origin });
    expect(up.status).toBe(0);
    expect(up.stdout).toContain("nothing to update");
    expect((await update([], { registry: "http://127.0.0.1:9/" })).stdout).toContain(
      "nothing to update",
    );
    expect(methodPin()).toBe(VERSION);
    expect(existsSync(join(home, ".agentplugged", "engines"))).toBe(false);
  });

  it("says why it failed and touches nothing when the version cannot be installed", async () => {
    product();
    // Announced, but not served: the registry has no such package file.
    const served = await registry(ANNOUNCED);
    const result = await update([], { registry: served.origin });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("The update did not happen (install_failed)");
    expect(result.stderr).toContain("The running engine was not touched.");
    expect(methodPin()).toBe(VERSION);
    expect(existsSync(join(home, ".agentplugged", "engines", ANNOUNCED))).toBe(false);
  });

  it("turns the check and the automatic updates on and off", async () => {
    product();
    const off = await update(["--check", "off"]);
    expect(off.status).toBe(0);
    expect(off.stdout).toContain("Update check: off");
    expect(off.stdout).toContain("Automatic updates: off");
    const settings = join(home, ".agentplugged", "settings.json");
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({
      updates: { check: false, auto: false },
    });
    expect((await update(["--auto", "on"])).stdout).toContain("Automatic updates: on");
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({
      updates: { check: false, auto: true },
    });
    // With the check off, `update` never asks the registry.
    const served = await registry(ANNOUNCED, { [ANNOUNCED]: fakePackage(ANNOUNCED) });
    const quiet = await update([], { registry: served.origin });
    expect(quiet.stdout).toContain("The update check is off");
    expect(served.hits).toEqual([]);
    expect((await update(["--check", "maybe"])).status).toBe(1);
    expect((await update(["--nope"])).stderr).toContain("unexpected --nope");
  });

  it("is refused outside an interactive terminal, as an agent's shell is: nothing is written", async () => {
    product();
    // The built binary, with no terminal on its input or output.
    const result = await run(["update", "--auto", "on"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("REVIEW_NOT_INTERACTIVE");
    expect(existsSync(join(home, ".agentplugged", "settings.json"))).toBe(false);
    const installing = await run(["update"], { npm_config_registry: "http://127.0.0.1:9/" });
    expect(installing.status).toBe(1);
    expect(existsSync(join(home, ".agentplugged", "engines"))).toBe(false);
  });

  it("is in the help, in both languages", async () => {
    expect((await run(["--help"])).stdout).toContain("update [--check on|off] [--auto on|off]");
    expect((await run(["--help"], { AGENTPLUGGED_LANG: "fr" })).stdout).toContain(
      "update [--check on|off] [--auto on|off]",
    );
  });
});
