import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { installedEntry, isReleaseVersion } from "@agentplugged/adapters-tools";
import { randomBytes } from "@agentplugged/crypto";
import { ENGINE_CHILD_ENV, SESSION_INSTANCE_ENV, SESSION_KEY_ENV } from "./launcher-env.js";
import { PRODUCT_CONFIG_PATH, productRootOf } from "./product-root.js";

/**
 * The MCP server of the AI tool as a stable launcher. `agentplugged mcp` no longer is
 * the engine: it is a small relay that runs the engine of one version in a child process (the same
 * program, told by `AGENTPLUGGED_ENGINE_CHILD`) and passes the protocol's lines both ways. Between two
 * calls, when the product pins a newer version of the engine than the one running and that version
 * is installed in its own folder (`~/.agentplugged/engines/<version>/`), it starts that version's
 * child, replays it the handshake the AI tool made, hands it the next call, and lets the old child
 * end. The connection with the AI tool never closes, no call in flight is ever cut (the move waits
 * for none to be), and nothing is replaced in place: a running engine locks its native keychain
 * module on Windows, so every version lives in a folder of its own.
 *
 * What the launcher is not: it does not read the protocol beyond what it needs (the ids of the calls
 * in flight, the handshake), it never installs anything, and it asks no one anything.
 */

/** How long a new child has to answer the replayed handshake. */
const HANDSHAKE_TIMEOUT_MS = 20_000;
/** How long an old child has to end by itself once its input is closed. */
const RETIRE_TIMEOUT_MS = 10_000;
/** The id of the probe sent to a new child when the AI tool made no handshake (revision 2026-07-28). */
const PROBE_ID = "agentplugged-launcher-probe";

/** An engine to run: its version and the program that runs it. */
export interface EngineChoice {
  readonly version: string;
  readonly entry: string;
}

/**
 * Release versions compared as numbers: negative when `a` < `b`. The core's `compareSemver` does
 * the same; it is written again here so that the launcher does not load the core.
 */
function compareRelease(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

/**
 * The engine version the product pins (`engine_version` of `method.yaml`), or undefined. A line of
 * the file read as is, never parsed: the launcher loads neither the core nor a YAML reader.
 */
export function pinnedEngineOf(root: string): string | undefined {
  try {
    const text = readFileSync(join(root, PRODUCT_CONFIG_PATH), "utf8");
    const found = /^engine_version:[ \t]*["']?([0-9]+\.[0-9]+\.[0-9]+)["']?[ \t]*(?:#.*)?$/m.exec(
      text,
    );
    return found?.[1];
  } catch {
    return undefined;
  }
}

/**
 * The engine the session should run now: the version the product pins when it is newer than the one
 * running (at the start: the package that runs the launcher) and installed in its own folder, and not
 * one that already failed to start in this session; else the one running.
 */
export function chooseEngine(options: {
  readonly cwd: string;
  readonly running: string;
  /** The program that runs it. */
  readonly runningEntry: string;
  readonly home?: string;
  readonly failed?: ReadonlySet<string>;
}): EngineChoice {
  const own: EngineChoice = { version: options.running, entry: options.runningEntry };
  const pinned = pinnedEngineOf(productRootOf(options.cwd));
  if (
    pinned === undefined ||
    !isReleaseVersion(options.running) ||
    compareRelease(pinned, options.running) <= 0 ||
    options.failed?.has(pinned) === true
  ) {
    return own;
  }
  const entry = installedEntry(pinned, options.home);
  return entry === undefined ? own : { version: pinned, entry };
}

export interface LauncherOptions {
  /** The arguments after `mcp`, passed on to the engine. */
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: (text: string) => void;
  /** The version of the package that runs the launcher. */
  readonly version: string;
  /** The program of that package: the engine it runs when nothing newer is chosen. */
  readonly selfEntry: string;
  readonly home?: string;
  /** Starts the engine of an entry (tests give theirs). */
  readonly spawnEngine?: (
    entry: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => ChildProcess;
  readonly handshakeTimeoutMs?: number;
  readonly retireTimeoutMs?: number;
}

/** A JSON-RPC message as far as the launcher reads it. */
interface Message {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly error?: unknown;
  readonly params?: { readonly requestId?: unknown };
}

function parse(line: string): Message | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Message)
      : undefined;
  } catch {
    return undefined;
  }
}

/** An id as a key: `1` and `"1"` are two ids. */
function idKey(id: unknown): string | undefined {
  return typeof id === "string" || typeof id === "number" ? `${typeof id}:${id}` : undefined;
}

/** Splits a stream of text into its lines. */
class Lines {
  readonly #decoder = new StringDecoder("utf8");
  #rest = "";

  push(chunk: Buffer | string): string[] {
    this.#rest += typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    const lines = this.#rest.split("\n");
    this.#rest = lines.pop() ?? "";
    return lines.map((line) => line.replace(/\r$/, "")).filter((line) => line !== "");
  }

  end(): string[] {
    const last = (this.#rest + this.#decoder.end()).replace(/\r$/, "");
    this.#rest = "";
    return last === "" ? [] : [last];
  }
}

/** One engine process the launcher runs. */
interface Engine {
  readonly choice: EngineChoice;
  readonly child: ChildProcess;
  /** `live`: the session's; `trial`: being started, its lines are the launcher's; `retired`: ending. */
  mode: "trial" | "live" | "retired";
  /** While `trial`: what the engine said, and that it ended or could not start. */
  onTrialMessage?: (message: Message) => void;
  onTrialEnd?: () => void;
  exited: boolean;
}

/**
 * Runs the launcher until the AI tool closes the connection (or the engine ends). Returns the exit
 * code: the engine's.
 */
export async function runLauncher(options: LauncherOptions): Promise<number> {
  const instance = `server:${Buffer.from(randomBytes(16)).toString("hex")}`;
  const key = Buffer.from(randomBytes(32)).toString("hex");
  const childEnv: NodeJS.ProcessEnv = {
    ...options.env,
    [ENGINE_CHILD_ENV]: "1",
    [SESSION_INSTANCE_ENV]: instance,
    [SESSION_KEY_ENV]: key,
  };
  const start =
    options.spawnEngine ??
    ((entry, args, env) =>
      spawn(process.execPath, [entry, "mcp", ...args], {
        cwd: options.cwd,
        env,
        stdio: ["pipe", "pipe", "inherit"],
        windowsHide: true,
      }));
  const failed = new Set<string>();
  const engines = new Set<Engine>();

  /** The calls the AI tool made that no answer closed, and those the engine made to the AI tool. */
  const fromClient = new Set<string>();
  const fromEngine = new Set<string>();
  /** The handshake the AI tool made, to replay to the next engine. */
  let initialize: string | undefined;
  let initialized: string | undefined;
  let finished = false;
  let current: Engine;
  let resolveDone: (code: number) => void = () => undefined;
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });

  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    // An engine being retired ends by itself (its input is closed, and its timer kills it if not).
    for (const engine of engines) {
      if (!engine.exited && engine.mode !== "retired") engine.child.kill();
    }
    resolveDone(code);
  };

  /** A call or a question the other side gave up (`notifications/cancelled`) is never answered. */
  const forget = (pending: Set<string>, message: Message) => {
    if (message.method !== "notifications/cancelled") return;
    const id = idKey(message.params?.requestId);
    if (id !== undefined) pending.delete(id);
  };

  const startEngine = (choice: EngineChoice, mode: Engine["mode"]): Engine => {
    const child = start(choice.entry, options.args, childEnv);
    const engine: Engine = { choice, child, mode, exited: false };
    engines.add(engine);
    const lines = new Lines();
    const onLine = (line: string) => {
      const message = parse(line);
      if (engine.mode === "trial") {
        if (message !== undefined) engine.onTrialMessage?.(message);
        return;
      }
      if (engine.mode === "retired") return;
      if (message !== undefined) {
        const id = idKey(message.id);
        if (id !== undefined) {
          if (message.method === undefined) fromClient.delete(id);
          else fromEngine.add(id);
        }
        forget(fromEngine, message);
      }
      options.stdout.write(`${line}\n`);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      for (const line of lines.push(chunk)) onLine(line);
    });
    child.stdout?.on("end", () => {
      for (const line of lines.end()) onLine(line);
    });
    child.stdin?.on("error", () => undefined);
    child.on("error", (error) => {
      engine.exited = true;
      if (engine.mode === "live") {
        options.stderr(`agentplugged mcp: ${error.message}\n`);
        finish(1);
      } else engine.onTrialEnd?.();
    });
    child.on("close", (code) => {
      engine.exited = true;
      if (engine.mode === "live") finish(code ?? 1);
      else if (engine.mode === "trial") engine.onTrialEnd?.();
    });
    return engine;
  };

  /** Starts the engine of `choice` and tells whether it answers the handshake the session made. */
  const tryEngine = async (choice: EngineChoice): Promise<Engine | undefined> => {
    const engine = startEngine(choice, "trial");
    const answered = new Promise<boolean>((resolve) => {
      const timer = setTimeout(
        () => resolve(false),
        options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
      );
      const wanted = idKey(initialize === undefined ? PROBE_ID : parse(initialize)?.id);
      engine.onTrialEnd = () => {
        clearTimeout(timer);
        resolve(false);
      };
      engine.onTrialMessage = (message) => {
        if (message.method === undefined && idKey(message.id) === wanted) {
          clearTimeout(timer);
          // A probe is answered by a result or by an error: the engine is alive either way.
          resolve(initialize === undefined || message.error === undefined);
        }
      };
      engine.child.stdin?.write(
        `${initialize ?? JSON.stringify({ jsonrpc: "2.0", id: PROBE_ID, method: "ping" })}\n`,
      );
    });
    const ok = await answered;
    delete engine.onTrialMessage;
    delete engine.onTrialEnd;
    if (!ok) {
      engine.mode = "retired";
      engine.child.kill();
      return undefined;
    }
    if (initialized !== undefined) engine.child.stdin?.write(`${initialized}\n`);
    return engine;
  };

  /** Moves the session to `choice`: false (the old engine stays) when it does not start. */
  const moveTo = async (choice: EngineChoice): Promise<boolean> => {
    const next = await tryEngine(choice);
    if (next === undefined) {
      failed.add(choice.version);
      options.stderr(
        `agentplugged mcp: engine ${choice.version} did not answer; staying on ${current.choice.version}\n`,
      );
      return false;
    }
    const old = current;
    next.mode = "live";
    current = next;
    old.mode = "retired";
    old.child.stdin?.end();
    const timer = setTimeout(() => {
      if (!old.exited) old.child.kill();
    }, options.retireTimeoutMs ?? RETIRE_TIMEOUT_MS);
    timer.unref();
    options.stderr(
      `agentplugged mcp: engine ${old.choice.version} replaced by ${next.choice.version}\n`,
    );
    return true;
  };

  current = startEngine(
    chooseEngine({
      cwd: options.cwd,
      running: options.version,
      runningEntry: options.selfEntry,
      ...(options.home === undefined ? {} : { home: options.home }),
    }),
    "live",
  );

  /** The lines of the AI tool, one after the other: a move holds the ones behind it. */
  let chain: Promise<void> = Promise.resolve();
  const handle = async (line: string): Promise<void> => {
    if (finished) return;
    const message = parse(line);
    const id = message === undefined ? undefined : idKey(message.id);
    const idle = fromClient.size === 0 && fromEngine.size === 0;
    if (message?.method === "tools/call" && id !== undefined && idle) {
      // Newer than the one running, never older: a session is never taken back.
      const wanted = chooseEngine({
        cwd: options.cwd,
        running: current.choice.version,
        runningEntry: current.choice.entry,
        failed,
        ...(options.home === undefined ? {} : { home: options.home }),
      });
      if (wanted.version !== current.choice.version) await moveTo(wanted);
    }
    if (message !== undefined) {
      if (message.method === "initialize" && id !== undefined) initialize = line;
      else if (message.method === "notifications/initialized") initialized = line;
      if (id !== undefined) {
        if (message.method === undefined) fromEngine.delete(id);
        else fromClient.add(id);
      }
      forget(fromClient, message);
    }
    current.child.stdin?.write(`${line}\n`);
  };
  const clientLines = new Lines();
  const enqueue = (lines: readonly string[]) => {
    for (const line of lines) chain = chain.then(() => handle(line)).catch(() => undefined);
  };
  /** The AI tool closed the connection: the engine's input ends after the lines already received. */
  const closeInput = () => {
    enqueue(clientLines.end());
    chain = chain.then(() => {
      current.child.stdin?.end();
    });
  };
  options.stdin.on("data", (chunk: Buffer | string) => enqueue(clientLines.push(chunk)));
  options.stdin.on("end", closeInput);
  options.stdin.on("error", closeInput);
  options.stdout.on("error", () => undefined);

  const code = await done;
  // The connection ended on the AI tool's side, or the engine ended: nothing is left running.
  options.stdin.removeAllListeners("data");
  options.stdin.pause();
  return code;
}
