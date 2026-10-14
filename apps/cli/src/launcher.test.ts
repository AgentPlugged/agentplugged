import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chooseEngine, pinnedEngineOf, runLauncher } from "./launcher.js";

vi.setConfig({ testTimeout: 60_000 });

/**
 * A fake engine: a small program that speaks the protocol's lines, as the real one does, and says
 * which version it is (its folder's `package.json`). `who` answers with what it knows; `slow` is a
 * call that waits for the test to release it (`test/release`); `hang` is one that never answers;
 * `ask` is a call that asks the client something before it answers.
 */
const FAKE_ENGINE = String.raw`
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version;
const log = process.env.FAKE_LOG;
const note = (what) => log && appendFileSync(log, version + " " + what + "\n");
note("start " + process.argv.slice(2).join(" "));
if (process.env.FAKE_DIE_AT === version) { console.error("this engine cannot start"); process.exit(7); }
let initializes = 0, initialized = 0, pending = 0, ended = false;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const waiting = new Map();
const maybeExit = () => { if (ended && pending === 0) process.exit(Number(process.env.FAKE_EXIT_CODE ?? 0)); };
async function call(message) {
  const name = message.params?.name;
  pending++;
  try {
    if (name === "slow" || name === "hang") note(name);
    if (name === "slow") await new Promise((r) => waiting.set("slow", r));
    if (name === "hang") await new Promise(() => undefined);
    if (name === "ask") {
      send({ id: "server-1", method: "elicitation/create", params: {} });
      await new Promise((r) => waiting.set("server-1", r));
    }
    if (name === "crash") process.exit(9);
    send({ id: message.id, result: { content: [{ type: "text", text: "ok" }], structuredContent: {
      version, pid: process.pid, initializes, initialized, name,
      instance: process.env.AGENTPLUGGED_SESSION_INSTANCE ?? null,
      key: process.env.AGENTPLUGGED_SESSION_KEY ?? null,
      child: process.env.AGENTPLUGGED_ENGINE_CHILD ?? null,
    } } });
  } finally { pending--; maybeExit(); }
}
let rest = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  rest += chunk;
  const lines = rest.split("\n"); rest = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      initializes++;
      if (process.env.FAKE_SILENT_AT === version) continue;
      send({ id: message.id, result: { serverInfo: { name: "fake", version } } });
    } else if (message.method === "notifications/initialized") initialized++;
    else if (message.method === "ping") send({ id: message.id, result: {} });
    else if (message.method === "tools/call") call(message);
    else if (message.method === "test/release") waiting.get(message.params.name)?.();
    else if (message.method === undefined && waiting.has(String(message.id))) waiting.get(String(message.id))();
  }
});
process.stdin.on("end", () => { ended = true; maybeExit(); });
`;

let root: string;
let home: string;
let product: string;
let log: string;

/** A version of the fake engine, in the folder the engine store gives it (or the launcher's own). */
function installFake(folder: string, version: string): string {
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(
    join(folder, "package.json"),
    JSON.stringify({ name: "agentplugged", version, type: "module" }),
  );
  const entry = join(folder, "dist", "bin.js");
  writeFileSync(entry, FAKE_ENGINE);
  return entry;
}

const installedFolder = (version: string) =>
  join(home, ".agentplugged", "engines", version, "node_modules", "agentplugged");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentplugged-launcher-"));
  home = join(root, "home");
  product = join(root, "product");
  log = join(root, "fake.log");
  mkdirSync(join(product, ".agentplugged"), { recursive: true });
  mkdirSync(home);
  pin("0.1.0");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

function pin(version: string, extra = "") {
  writeFileSync(
    join(product, ".agentplugged", "method.yaml"),
    `format_version: 2\nengine_version: ${version}${extra}\n`,
  );
}

type Message = Record<string, unknown>;

/** The AI tool's side of the connection. */
class Tool {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr: string[] = [];
  readonly received: Message[] = [];
  readonly #waiting = new Map<unknown, (message: Message) => void>();
  #rest = "";
  #id = 0;
  done: Promise<number>;

  constructor(
    options: {
      version?: string;
      selfEntry?: string;
      env?: Record<string, string | undefined>;
      retireTimeoutMs?: number;
      handshakeTimeoutMs?: number;
    } = {},
  ) {
    this.stdout.setEncoding("utf8");
    this.stdout.on("data", (chunk: string) => {
      this.#rest += chunk;
      const lines = this.#rest.split("\n");
      this.#rest = lines.pop() ?? "";
      for (const line of lines) {
        const message = JSON.parse(line) as Message;
        this.received.push(message);
        this.#waiting.get(message.id)?.(message);
      }
    });
    this.done = runLauncher({
      args: [],
      cwd: product,
      env: { FAKE_LOG: log, ...options.env },
      stdin: this.stdin,
      stdout: this.stdout,
      stderr: (text) => this.stderr.push(text),
      version: options.version ?? "0.1.0",
      selfEntry: options.selfEntry ?? self,
      home,
      ...(options.retireTimeoutMs === undefined
        ? {}
        : { retireTimeoutMs: options.retireTimeoutMs }),
      ...(options.handshakeTimeoutMs === undefined
        ? {}
        : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
    });
  }

  send(message: Message): void {
    this.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  request(method: string, params: Message = {}): Promise<Message> {
    const id = ++this.#id;
    const answer = new Promise<Message>((resolve) => this.#waiting.set(id, resolve));
    this.send({ id, method, params });
    return answer;
  }

  /** Sends a request and does not wait: the answer is read with `answer`. */
  start(method: string, params: Message = {}): { id: number; answer: Promise<Message> } {
    const id = ++this.#id;
    const answer = new Promise<Message>((resolve) => this.#waiting.set(id, resolve));
    this.send({ id, method, params });
    return { id, answer };
  }

  async call(name: string): Promise<Record<string, unknown>> {
    const reply = await this.request("tools/call", { name, arguments: {} });
    return (reply.result as { structuredContent: Record<string, unknown> }).structuredContent;
  }

  async handshake(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    this.send({ method: "notifications/initialized" });
  }

  async close(): Promise<number> {
    this.stdin.end();
    return await this.done;
  }
}

let self: string;
beforeEach(() => {
  self = installFake(join(root, "self"), "0.1.0");
});

/** The lines of the fake engines' log, to see which versions started and what they were told. */
const logged = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);

describe("the engine the product asks for", () => {
  it("reads the pinned version of method.yaml, however it is written", () => {
    for (const text of [
      "engine_version: 0.2.0\n",
      'engine_version: "0.2.0"\n',
      "engine_version: '0.2.0'   # pinned\n",
      "format_version: 2\r\nengine_version: 0.2.0\r\nproduct_id: x\r\n",
    ]) {
      writeFileSync(join(product, ".agentplugged", "method.yaml"), text);
      expect(pinnedEngineOf(product), JSON.stringify(text)).toBe("0.2.0");
    }
    writeFileSync(join(product, ".agentplugged", "method.yaml"), "tools: [a]\n");
    expect(pinnedEngineOf(product)).toBeUndefined();
    expect(pinnedEngineOf(join(root, "nowhere"))).toBeUndefined();
  });

  it("runs its own package unless the product pins a newer installed version", () => {
    const own = { cwd: product, running: "0.1.0", runningEntry: self, home };
    expect(chooseEngine(own)).toEqual({ version: "0.1.0", entry: self });
    // Newer, but not installed: the own one stays.
    pin("0.2.0");
    expect(chooseEngine(own)).toEqual({ version: "0.1.0", entry: self });
    const entry = installFake(installedFolder("0.2.0"), "0.2.0");
    expect(chooseEngine(own)).toEqual({ version: "0.2.0", entry });
    // Older or equal pins, pre-releases and versions that already failed never move the session.
    pin("0.0.9");
    expect(chooseEngine(own).version).toBe("0.1.0");
    pin("0.2.0-beta.1");
    expect(chooseEngine(own).version).toBe("0.1.0");
    pin("0.2.0");
    expect(chooseEngine({ ...own, failed: new Set(["0.2.0"]) }).version).toBe("0.1.0");
    // A folder that is not the package of that version is not an engine.
    writeFileSync(
      join(installedFolder("0.2.0"), "package.json"),
      JSON.stringify({ name: "agentplugged", version: "0.2.1" }),
    );
    expect(chooseEngine(own).version).toBe("0.1.0");
  });

  it("finds the product from a folder inside it", () => {
    pin("0.2.0");
    installFake(installedFolder("0.2.0"), "0.2.0");
    const inner = join(product, "src", "deep");
    mkdirSync(inner, { recursive: true });
    expect(chooseEngine({ cwd: inner, running: "0.1.0", runningEntry: self, home }).version).toBe(
      "0.2.0",
    );
  });
});

describe("the launcher relays the protocol", () => {
  it("passes the lines both ways, and ends with the engine when the tool closes the connection", async () => {
    const tool = new Tool();
    await tool.handshake();
    const seen = await tool.call("who");
    expect(seen).toMatchObject({ version: "0.1.0", initializes: 1, initialized: 1, child: "1" });
    expect(await tool.close()).toBe(0);
    expect(logged()[0]).toBe("0.1.0 start mcp");
  });

  it("passes its arguments to the engine and returns the engine's exit code", async () => {
    const tool = new Tool({ env: { FAKE_EXIT_CODE: "3" } });
    await tool.handshake();
    expect(await tool.close()).toBe(3);
  });

  it("ends when the engine ends first (it refused to start): its code, nothing left running", async () => {
    const tool = new Tool({ env: { FAKE_DIE_AT: "0.1.0" } });
    expect(await tool.done).toBe(7);
  });

  it("gives every engine of a session the same name and secret, and each session its own", async () => {
    const one = new Tool();
    await one.handshake();
    const first = await one.call("who");
    expect(first.instance).toMatch(/^server:[0-9a-f]{32}$/);
    expect(first.key).toMatch(/^[0-9a-f]{64}$/);
    pin("0.2.0");
    installFake(installedFolder("0.2.0"), "0.2.0");
    const second = await one.call("who");
    expect(second.version).toBe("0.2.0");
    expect(second.instance).toBe(first.instance);
    expect(second.key).toBe(first.key);
    await one.close();
    const other = new Tool();
    await other.handshake();
    expect((await other.call("who")).instance).not.toBe(first.instance);
    await other.close();
  });

  it("starts the version the product pins at once when it is installed", async () => {
    pin("0.2.0");
    installFake(installedFolder("0.2.0"), "0.2.0");
    const tool = new Tool();
    await tool.handshake();
    expect((await tool.call("who")).version).toBe("0.2.0");
    expect(logged()).toEqual(["0.2.0 start mcp"]);
    await tool.close();
  });
});

describe("the session moves to a newer engine between two calls", () => {
  it("answers the next call with the new version, the handshake replayed, the connection never cut", async () => {
    const tool = new Tool();
    await tool.handshake();
    const before = await tool.call("who");
    expect(before.version).toBe("0.1.0");
    // The product now pins 0.2.0, installed in a folder of its own: nothing replaced in place.
    pin("0.2.0");
    installFake(installedFolder("0.2.0"), "0.2.0");
    const after = await tool.call("who");
    expect(after).toMatchObject({ version: "0.2.0", initializes: 1, initialized: 1 });
    expect(after.pid).not.toBe(before.pid);
    expect(tool.stderr.join("")).toContain("engine 0.1.0 replaced by 0.2.0");
    // The old engine ended by itself (its input was closed), and is not the one that answers.
    await vi.waitFor(() => expect(() => process.kill(before.pid as number, 0)).toThrow());
    // And again: the third call is the new engine's, with no second move.
    expect((await tool.call("who")).version).toBe("0.2.0");
    expect(logged().filter((line) => line.includes("start"))).toEqual([
      "0.1.0 start mcp",
      "0.2.0 start mcp",
    ]);
    expect(await tool.close()).toBe(0);
  });

  it("answers nothing of the handshake twice to the tool: the replayed answer is the launcher's", async () => {
    const tool = new Tool();
    await tool.handshake();
    pin("0.2.0");
    installFake(installedFolder("0.2.0"), "0.2.0");
    await tool.call("who");
    const initializeAnswers = tool.received.filter(
      (message) =>
        (message.result as { serverInfo?: unknown } | undefined)?.serverInfo !== undefined,
    );
    expect(initializeAnswers).toHaveLength(1);
    await tool.close();
  });

  it("never cuts a call in flight: it ends on the old engine, and the move waits for it", async () => {
    const tool = new Tool();
    await tool.handshake();
    const slow = tool.start("tools/call", { name: "slow", arguments: {} });
    // The call is in the engine's hands before the product moves on.
    await vi.waitFor(() => expect(logged()).toContain("0.1.0 slow"));
    pin("0.2.0");
    installFake(installedFolder("0.2.0"), "0.2.0");
    // This call arrives while the first one runs: no move yet.
    const during = await tool.call("who");
    expect(during.version).toBe("0.1.0");
    tool.send({ method: "test/release", params: { name: "slow" } });
    const finished = (await slow.answer).result as { structuredContent: { version: string } };
    expect(finished.structuredContent.version).toBe("0.1.0");
    // Nothing is in flight now: the next call is the new engine's.
    expect((await tool.call("who")).version).toBe("0.2.0");
    await tool.close();
  });

  it("is not held back by a call the tool gave up: a cancelled call is never answered", async () => {
    const tool = new Tool();
    await tool.handshake();
    const hung = tool.start("tools/call", { name: "hang", arguments: {} });
    await vi.waitFor(() => expect(logged()).toContain("0.1.0 hang"));
    pin("0.2.0");
    installFake(installedFolder("0.2.0"), "0.2.0");
    // While it is pending, the session stays on the old engine...
    expect((await tool.call("who")).version).toBe("0.1.0");
    // ...and once the tool cancelled it, the next call is the new engine's.
    tool.send({ method: "notifications/cancelled", params: { requestId: hung.id } });
    expect((await tool.call("who")).version).toBe("0.2.0");
    await tool.close();
  });

  it("waits for a question the engine asked the tool, too", async () => {
    const tool = new Tool();
    await tool.handshake();
    const ask = tool.start("tools/call", { name: "ask", arguments: {} });
    await vi.waitFor(() =>
      expect(tool.received.some((message) => message.id === "server-1")).toBe(true),
    );
    pin("0.2.0");
    installFake(installedFolder("0.2.0"), "0.2.0");
    // The tool's answer to the engine's question, then the call ends on the old engine.
    tool.send({ id: "server-1", result: { action: "accept" } });
    const done = (await ask.answer).result as { structuredContent: { version: string } };
    expect(done.structuredContent.version).toBe("0.1.0");
    expect((await tool.call("who")).version).toBe("0.2.0");
    await tool.close();
  });

  it("stays on the old engine, and says so, when the new one does not start", async () => {
    const tool = new Tool({ env: { FAKE_DIE_AT: "0.2.0" } });
    await tool.handshake();
    pin("0.2.0");
    installFake(installedFolder("0.2.0"), "0.2.0");
    const answer = await tool.call("who");
    expect(answer.version).toBe("0.1.0");
    expect(tool.stderr.join("")).toContain("engine 0.2.0 did not answer; staying on 0.1.0");
    // Not tried again in this session.
    expect((await tool.call("who")).version).toBe("0.1.0");
    expect(logged().filter((line) => line === "0.2.0 start mcp")).toHaveLength(1);
    expect(await tool.close()).toBe(0);
  });

  it("stays on the old engine when the new one does not answer the handshake in time", async () => {
    const tool = new Tool({ env: { FAKE_SILENT_AT: "0.2.0" }, handshakeTimeoutMs: 800 });
    await tool.handshake();
    pin("0.2.0");
    installFake(installedFolder("0.2.0"), "0.2.0");
    expect((await tool.call("who")).version).toBe("0.1.0");
    expect(tool.stderr.join("")).toContain("did not answer");
    expect(await tool.close()).toBe(0);
  });

  it("moves when the tool made no handshake (revision 2026-07-28): the new engine is probed", async () => {
    const tool = new Tool();
    expect((await tool.call("who")).version).toBe("0.1.0");
    pin("0.2.0");
    installFake(installedFolder("0.2.0"), "0.2.0");
    const after = await tool.call("who");
    expect(after).toMatchObject({ version: "0.2.0", initializes: 0 });
    await tool.close();
  });

  it("does not move for a pin that is older, equal or not a release", async () => {
    installFake(installedFolder("0.0.9"), "0.0.9");
    installFake(installedFolder("0.2.0"), "0.2.0");
    const tool = new Tool();
    await tool.handshake();
    pin("0.0.9");
    expect((await tool.call("who")).version).toBe("0.1.0");
    pin("0.2.0-rc.1");
    expect((await tool.call("who")).version).toBe("0.1.0");
    await tool.close();
  });

  it("moves again to a newer one, never back to an older one", async () => {
    const tool = new Tool();
    await tool.handshake();
    pin("0.2.0");
    installFake(installedFolder("0.2.0"), "0.2.0");
    expect((await tool.call("who")).version).toBe("0.2.0");
    pin("0.3.0");
    installFake(installedFolder("0.3.0"), "0.3.0");
    expect((await tool.call("who")).version).toBe("0.3.0");
    // A product brought back to an older pin does not take the session back: nothing is downgraded.
    pin("0.2.0");
    expect((await tool.call("who")).version).toBe("0.3.0");
    await tool.close();
  });

  it("ends the retired engine even when it does not end by itself", async () => {
    const tool = new Tool({ retireTimeoutMs: 300 });
    await tool.handshake();
    const before = await tool.call("who");
    pin("0.2.0");
    installFake(installedFolder("0.2.0"), "0.2.0");
    await tool.call("who");
    await vi.waitFor(() => expect(() => process.kill(before.pid as number, 0)).toThrow());
    await tool.close();
  });
});
