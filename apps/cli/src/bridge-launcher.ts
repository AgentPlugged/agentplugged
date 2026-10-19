import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { Translate } from "@agentplugged/i18n";

/**
 * `agentplugged bridge …`: the public command line only LAUNCHES the
 * bridge, which is distributed apart (its own package, under the licence of Innovel Studio SASU).
 * It holds no logic of the bridge: it finds the program installed on this machine, runs it with
 * the same arguments and hands back its exit code. When none is installed, it says how to get
 * one. Everything the bridge does (start, status, and later pairing and the service) lives in it.
 */

export interface LauncherEnvironment {
  /** Runs npm with these arguments; resolves with its exit code. Absent: the real npm. */
  readonly runNpm?: (args: readonly string[]) => Promise<{ code: number; output: string }>;
  readonly argv: readonly string[];
  /** The folder the command was run in: the bridge's `pair` works in the product's folder. */
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform?: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** The file where an installation of the bridge says where its program is: `{ "entry": "<absolute path>" }`. */
export const BRIDGE_POINTER_FILE = "install.json";

/** The folder an installation of the bridge writes its pointer in, on each system. */
export function bridgeInstallDir(
  env: LauncherEnvironment["env"],
  platform: string = process.platform,
): string | undefined {
  const home = env.USERPROFILE?.trim() || env.HOME?.trim();
  if (platform === "win32") {
    const base = env.LOCALAPPDATA?.trim() || (home ? join(home, "AppData", "Local") : undefined);
    return base ? join(base, "AgentPlugged", "bridge-install") : undefined;
  }
  if (platform === "darwin") {
    return home
      ? join(home, "Library", "Application Support", "AgentPlugged", "bridge-install")
      : undefined;
  }
  const data = env.XDG_DATA_HOME?.trim() || (home ? join(home, ".local", "share") : undefined);
  return data ? join(data, "agentplugged", "bridge-install") : undefined;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * The program of the installed bridge: `AGENTPLUGGED_BRIDGE_ENTRY` when set (a bridge kept
 * elsewhere), else the pointer file of the installation folder. `undefined` when there is none,
 * or when what it points to is not a file.
 */
export async function findBridge(
  env: LauncherEnvironment["env"],
  platform: string = process.platform,
): Promise<string | undefined> {
  const given = env.AGENTPLUGGED_BRIDGE_ENTRY?.trim();
  if (given) return isAbsolute(given) && (await isFile(given)) ? given : undefined;
  const dir = bridgeInstallDir(env, platform);
  if (dir === undefined) return undefined;
  try {
    const pointer: unknown = JSON.parse(await readFile(join(dir, BRIDGE_POINTER_FILE), "utf8"));
    const entry =
      typeof pointer === "object" && pointer !== null
        ? (pointer as { entry?: unknown }).entry
        : undefined;
    return typeof entry === "string" && isAbsolute(entry) && (await isFile(entry))
      ? entry
      : undefined;
  } catch {
    return undefined;
  }
}

/** The npm package the bridge is distributed as (its own package, apart from this one). */
export const BRIDGE_PACKAGE = "agentplugged-bridge";

/**
 * npm's own JavaScript program on Windows, where `npm` is a batch file that only runs through a
 * shell: the one next to Node, else the one that started this process. `undefined` when neither is
 * found.
 */
function npmProgram(env: LauncherEnvironment["env"]): string | undefined {
  const candidates = [
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    env.npm_execpath ?? "",
  ];
  return candidates.find((path) => path.endsWith("npm-cli.js") && existsSync(path));
}

/** Runs npm; no argument ever passes through a shell. */
function realNpm(
  args: readonly string[],
  platform: string,
  env: LauncherEnvironment["env"],
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    let output = "";
    const program = platform === "win32" ? npmProgram(env) : undefined;
    if (platform === "win32" && program === undefined) {
      resolve({ code: -1, output: "npm was not found next to Node" });
      return;
    }
    const options = {
      env: { ...process.env, ...env } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
      windowsHide: true,
    };
    const child =
      program === undefined
        ? spawn("npm", [...args], options)
        : spawn(process.execPath, [program, ...args], options);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (error) => resolve({ code: -1, output: error.message }));
    child.on("close", (code) => resolve({ code: code ?? -1, output }));
  });
}

/**
 * `agentplugged bridge install`: gets the bridge, or its newest version, before the bridge itself
 * makes itself a service. The bridge is its own npm package, put in a folder of its own; the
 * pointer file then tells this launcher where it is. A bridge kept elsewhere
 * (`AGENTPLUGGED_BRIDGE_ENTRY`) is never touched. When the newest version cannot be fetched and a
 * bridge is already there, that one is used and the failure is said. Returns false when there is
 * no bridge at all at the end.
 */
export async function installBridgePackage(
  environment: LauncherEnvironment,
  t: Translate,
): Promise<boolean> {
  const { env } = environment;
  const platform = environment.platform ?? process.platform;
  if (env.AGENTPLUGGED_BRIDGE_ENTRY?.trim()) return (await findBridge(env, platform)) !== undefined;
  const dir = bridgeInstallDir(env, platform);
  const known = await findBridge(env, platform);
  const source = env.AGENTPLUGGED_BRIDGE_PACKAGE?.trim() || `${BRIDGE_PACKAGE}@latest`;
  if (dir === undefined || !/^[^\s"'&|<>^%;$`-][^\s"'&|<>^%;$`]*$/.test(source)) {
    environment.stderr(`${t("bridge.launcher.install_failed", { reason: "folder" })}\n`);
    return known !== undefined;
  }
  const folder = join(dir, "package");
  environment.stdout(`${t("bridge.launcher.installing")}\n`);
  try {
    await mkdir(folder, { recursive: true });
    const manifest = join(folder, "package.json");
    if (!(await isFile(manifest))) await writeFile(manifest, '{ "private": true }\n');
    const args = [
      "install",
      "--prefix",
      folder,
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
      source,
    ];
    const done = await (environment.runNpm ?? ((a) => realNpm(a, platform, env)))(args);
    if (done.code !== 0) throw new Error(done.output.trim().split("\n")[0] ?? "npm");
    const dependencies = (
      JSON.parse(await readFile(manifest, "utf8")) as { dependencies?: Record<string, string> }
    ).dependencies;
    const name = Object.keys(dependencies ?? {})[0];
    if (name === undefined) throw new Error("no package");
    const entry = join(folder, "node_modules", name, "dist", "bin.js");
    if (!(await isFile(entry))) throw new Error("no program");
    await writeFile(join(dir, BRIDGE_POINTER_FILE), `${JSON.stringify({ entry })}\n`);
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 200) : "unknown";
    environment.stderr(
      `${t(known === undefined ? "bridge.launcher.install_failed" : "bridge.launcher.update_failed", { reason })}\n`,
    );
    return known !== undefined;
  }
}

/** Runs the bridge's program with `args`; resolves with its exit code (1 when a signal ended it). */
function runProgram(
  entry: string,
  args: readonly string[],
  environment: LauncherEnvironment,
  failed: string,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], {
      env: { ...process.env, ...environment.env } as NodeJS.ProcessEnv,
      ...(environment.cwd === undefined ? {} : { cwd: environment.cwd }),
      stdio: ["inherit", "pipe", "pipe"],
    });
    // Decoded as a stream: a character cut between two chunks is not broken.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text: string) => environment.stdout(text));
    child.stderr.on("data", (text: string) => environment.stderr(text));
    // Ctrl+C reaches the bridge too (the same terminal): the launcher waits for it to clean up
    // instead of dying first. SIGTERM and SIGHUP aimed at the launcher alone are passed on (on
    // Windows a signal sent to a process ends it at once: the bridge then leaves its lock to go
    // stale, which the next start recognises). A SIGINT sent to the launcher alone, not by a
    // terminal, is not passed on: stopping the bridge that way is done with `SIGTERM`.
    const ignore = (): void => {};
    const pass = (signal: NodeJS.Signals) => (): void => {
      child.kill(signal);
    };
    const handlers: Array<[NodeJS.Signals, () => void]> = [
      ["SIGINT", ignore],
      ["SIGBREAK", ignore],
      ["SIGTERM", pass("SIGTERM")],
      ["SIGHUP", pass("SIGHUP")],
    ];
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const finish = (code: number): void => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      resolve(code);
    };
    child.on("error", () => {
      // The program could not even be started: said, never a silent failure.
      environment.stderr(`${failed}\n`);
      finish(1);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
}

/**
 * `agentplugged bridge <arguments>`, and `agentplugged pair <arguments>`: launches the
 * installed bridge with the arguments after `bridge`, or with the whole command for `pair` (the
 * bridge's own command line knows `pair`), or says how to get the bridge. Nothing is done here,
 * nothing is left half done: the pairing is entirely the bridge's.
 */
export async function runBridgeLauncher(
  environment: LauncherEnvironment,
  t: Translate,
): Promise<number> {
  // `bridge install` first gets (or updates) the bridge, then the bridge makes itself a service.
  if (environment.argv[0] === "bridge" && environment.argv[1] === "install") {
    if (!(await installBridgePackage(environment, t))) return 1;
  }
  const entry = await findBridge(environment.env, environment.platform);
  if (entry === undefined) {
    environment.stderr(`${t("bridge.launcher.not_installed")}\n`);
    return 1;
  }
  return runProgram(
    entry,
    environment.argv[0] === "pair" || environment.argv[0] === "device"
      ? environment.argv
      : environment.argv.slice(1),
    environment,
    t("bridge.launcher.not_installed"),
  );
}
