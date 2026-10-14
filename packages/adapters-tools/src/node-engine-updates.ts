import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
  EngineAutoUpdate,
  EngineRelease,
  EngineUpdateFailure,
  EngineUpdateSettings,
  EngineUpdates,
} from "@agentplugged/core";
import {
  agentpluggedHome,
  ENGINE_PACKAGE,
  engineDir,
  engineEntry,
  isInstalledEngine,
  isReleaseVersion,
} from "./engine-store.js";

/**
 * The engine's updates on this machine: what the npm registry says is the latest
 * version (asked at most twice a day, kept in `~/.agentplugged/update-check.json`), the two
 * settings (`~/.agentplugged/settings.json`), and the installation of a version in its own folder.
 *
 * What goes over the network, and only this: one `GET <registry>/agentplugged/latest` (the name of
 * the package; no project data, no identifier, no cookie), and the `npm install` of the exact
 * version `agentplugged@<x.y.z>` from the same registry, scripts of the packages off. The registry is
 * the one npm is configured with (`npm_config_registry`), over https (http only to this machine,
 * for tests). Nothing ever makes a call fail: an unreachable registry, an unknown package or a
 * reply that is not what it should be is silence.
 */

export interface NodeEngineUpdatesOptions {
  /** The version running here. */
  readonly engineVersion: string;
  /** The product's folder: where the product is brought to a new version. */
  readonly cwd: string;
  /** The environment: the registry (`npm_config_registry`) and the folders are read from it. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The home folder (`~/.agentplugged` lives there). The user's home by default. */
  readonly home?: string;
  readonly now?: () => number;
  /** The HTTP client (`fetch`); tests give theirs. */
  readonly fetch?: typeof fetch;
  /** How long a kept answer is trusted: half a day, so at most two requests a day. */
  readonly intervalMs?: number;
  /** The limit of the registry request. */
  readonly timeoutMs?: number;
  /** The limit of an installation and of a product update. */
  readonly installTimeoutMs?: number;
  /** Called after each check, whether the registry was asked or not (the automatic update hooks in here). */
  readonly onChecked?: () => void;
}

const HALF_DAY_MS = 12 * 3_600_000;
const REGISTRY_TIMEOUT_MS = 5_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
/** The reply of the registry is a small document: anything bigger is not read. */
const MAX_REPLY_BYTES = 256 * 1024;
const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const SUMMARY_MAX = 200;
/** The tail of a tool's output kept to say why it failed. */
const OUTPUT_TAIL = 1500;

const DEFAULT_SETTINGS: EngineUpdateSettings = { check: true, auto: false };

interface Cache {
  readonly checked_at?: string;
  readonly latest?: EngineRelease;
  readonly auto?: EngineAutoUpdate;
}

/** The registry the machine's npm uses, when it is one this engine may talk to, else the default. */
export function registryOf(env: Readonly<Record<string, string | undefined>>): string {
  const raw = env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY;
  if (raw === undefined || raw.trim() === "") return DEFAULT_REGISTRY;
  try {
    const url = new URL(raw.trim());
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const allowed = url.protocol === "https:" || (url.protocol === "http:" && local);
    if (!allowed || url.username !== "" || url.password !== "") return DEFAULT_REGISTRY;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return DEFAULT_REGISTRY;
  }
}

/** A line of text the registry gave, made safe to show: no control characters, one line, short. */
export function cleanSummary(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Control and format characters (the invisible ones too: zero-width, bidi marks, tags) become a space.
  const clean = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (clean === "") return undefined;
  return clean.length > SUMMARY_MAX ? `${[...clean].slice(0, SUMMARY_MAX - 1).join("")}…` : clean;
}

/** The release the registry's reply describes, or undefined when it is not a release of the package. */
export function releaseOf(reply: unknown): EngineRelease | undefined {
  if (typeof reply !== "object" || reply === null || Array.isArray(reply)) return undefined;
  const { name, version, releaseSummary } = reply as Record<string, unknown>;
  if (name !== ENGINE_PACKAGE || !isReleaseVersion(version)) return undefined;
  const summary = cleanSummary(releaseSummary);
  return { version, ...(summary === undefined ? {} : { summary }) };
}

/** The reply's text, read up to a limit; undefined when it is longer. */
async function readCapped(response: Response, limit: number): Promise<string | undefined> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return undefined;
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface Ran {
  readonly code: number | null;
  readonly output: string;
  readonly timedOut: boolean;
  readonly missing: boolean;
}

/** Runs a program with no shell, its output kept (the tail), a time limit, no input. */
function runProgram(
  program: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly timeoutMs: number;
    readonly shell?: boolean;
  },
): Promise<Ran> {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    const finish = (ran: Ran) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ran);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(program, [...args], {
        cwd: options.cwd,
        env: options.env as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: options.shell === true,
      });
    } catch {
      resolve({ code: null, output: "", timedOut: false, missing: true });
      return;
    }
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL * 2);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    child.on("error", (error: NodeJS.ErrnoException) =>
      finish({ code: null, output, timedOut: false, missing: error.code === "ENOENT" }),
    );
    child.on("close", (code) => finish({ code, output, timedOut, missing: false }));
  });
}

/** The tail of a tool's output, to say why it failed (one short block). */
function tail(output: string): string {
  const text = output.trim();
  return text.length > OUTPUT_TAIL ? text.slice(-OUTPUT_TAIL) : text;
}

/** Characters `cmd` would still interpret inside double quotes. */
const UNSAFE_FOR_CMD = /["%!\r\n^&|<>]/;

/**
 * How to run npm: the `npm-cli.js` that npm itself names or that sits next to this Node.js (no
 * shell), else the `npm` command of the PATH (through `cmd` on Windows, arguments quoted).
 */
function npmProgram(
  env: Readonly<Record<string, string | undefined>>,
): { program: string; prefix: readonly string[]; shell: boolean } | { shell: true } {
  const named = env.npm_execpath;
  if (named !== undefined && basename(named) === "npm-cli.js" && existsSync(named)) {
    return { program: process.execPath, prefix: [named], shell: false };
  }
  const here = dirname(process.execPath);
  for (const candidate of [
    join(here, "node_modules", "npm", "bin", "npm-cli.js"),
    join(here, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ]) {
    if (existsSync(candidate))
      return { program: process.execPath, prefix: [candidate], shell: false };
  }
  return { shell: true };
}

/** `EngineUpdates` on this machine. */
export class NodeEngineUpdates implements EngineUpdates {
  readonly #options: NodeEngineUpdatesOptions;
  readonly #home: string;
  readonly #registry: string;
  #refreshing: Promise<void> | undefined;

  constructor(options: NodeEngineUpdatesOptions) {
    this.#options = options;
    this.#home = options.home ?? homedir();
    this.#registry = registryOf(options.env);
  }

  get #settingsPath(): string {
    return join(agentpluggedHome(this.#home), "settings.json");
  }

  get #cachePath(): string {
    return join(agentpluggedHome(this.#home), "update-check.json");
  }

  get #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  async #readJson(path: string): Promise<Record<string, unknown> | undefined> {
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as unknown;
      return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** Written whole to a file of its own, then moved in place: never half a file. */
  async #writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async settings(): Promise<EngineUpdateSettings> {
    const updates = (await this.#readJson(this.#settingsPath))?.updates;
    const kept =
      typeof updates === "object" && updates !== null ? (updates as Record<string, unknown>) : {};
    return {
      check: typeof kept.check === "boolean" ? kept.check : DEFAULT_SETTINGS.check,
      auto: typeof kept.auto === "boolean" ? kept.auto : DEFAULT_SETTINGS.auto,
    };
  }

  async saveSettings(patch: Partial<EngineUpdateSettings>): Promise<EngineUpdateSettings> {
    const next = { ...(await this.settings()), ...patch };
    const file = (await this.#readJson(this.#settingsPath)) ?? {};
    await this.#writeJson(this.#settingsPath, { ...file, updates: next });
    return next;
  }

  async #cache(): Promise<Cache> {
    const raw = await this.#readJson(this.#cachePath);
    if (raw === undefined) return {};
    const kept = raw.latest as { version?: unknown; summary?: unknown } | undefined;
    const summary = cleanSummary(kept?.summary);
    const latest: EngineRelease | undefined = isReleaseVersion(kept?.version)
      ? { version: kept.version, ...(summary === undefined ? {} : { summary }) }
      : undefined;
    const auto = raw.auto as Partial<EngineAutoUpdate> | undefined;
    return {
      ...(typeof raw.checked_at === "string" ? { checked_at: raw.checked_at } : {}),
      ...(latest === undefined ? {} : { latest }),
      ...(auto !== undefined &&
      typeof auto.from === "string" &&
      typeof auto.to === "string" &&
      typeof auto.at === "string"
        ? { auto: { from: auto.from, to: auto.to, at: auto.at } }
        : {}),
    };
  }

  /** True when the kept answer is older than half a day, or was never asked for. */
  #stale(cache: Cache): boolean {
    const checked = cache.checked_at === undefined ? Number.NaN : Date.parse(cache.checked_at);
    const age = this.#now - checked;
    return !(age >= 0 && age < (this.#options.intervalMs ?? HALF_DAY_MS));
  }

  async latest(): Promise<EngineRelease | undefined> {
    if (!(await this.settings()).check) return undefined;
    const cache = await this.#cache();
    if (this.#stale(cache)) void this.refresh();
    return cache.latest;
  }

  /**
   * Asks the registry for the latest version when the kept answer is older than half a day (and the
   * check is on). The attempt is written first: an unreachable registry is not asked again for half a
   * day, and two servers of the machine do not ask together. Never throws.
   */
  refresh(options: { readonly force?: boolean } = {}): Promise<void> {
    this.#refreshing ??= this.#refresh(options.force === true)
      .catch(() => undefined)
      .finally(() => {
        this.#refreshing = undefined;
        try {
          this.#options.onChecked?.();
        } catch {
          // Nothing the listener does is the check's business.
        }
      });
    return this.#refreshing;
  }

  async #refresh(force: boolean): Promise<void> {
    if (!(await this.settings()).check) return;
    const cache = await this.#cache();
    if (!force && !this.#stale(cache)) return;
    await this.#writeJson(this.#cachePath, {
      ...cache,
      checked_at: new Date(this.#now).toISOString(),
    });
    const release = await this.#ask();
    // Written again from what is on disk now: the automatic update's note may have landed meanwhile.
    const fresh = await this.#cache();
    await this.#writeJson(this.#cachePath, {
      ...fresh,
      checked_at: new Date(this.#now).toISOString(),
      ...(release === undefined ? {} : { latest: release }),
    });
  }

  async #ask(): Promise<EngineRelease | undefined> {
    try {
      const response = await (this.#options.fetch ?? fetch)(
        `${this.#registry}/${ENGINE_PACKAGE}/latest`,
        {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(this.#options.timeoutMs ?? REGISTRY_TIMEOUT_MS),
          redirect: "error",
          credentials: "omit",
        },
      );
      if (!response.ok) return undefined;
      const text = await readCapped(response, MAX_REPLY_BYTES);
      return text === undefined ? undefined : releaseOf(JSON.parse(text));
    } catch {
      return undefined;
    }
  }

  async isInstalled(version: string): Promise<boolean> {
    return isReleaseVersion(version) && isInstalledEngine(engineDir(version, this.#home), version);
  }

  async install(version: string): Promise<{ readonly ok: true } | EngineUpdateFailure> {
    if (!isReleaseVersion(version)) return { ok: false, reason: "bad_version" };
    const target = engineDir(version, this.#home);
    if (isInstalledEngine(target, version)) return { ok: true };
    const parent = dirname(target);
    const work = join(parent, `.install-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
    try {
      await mkdir(work, { recursive: true });
      await writeFile(join(work, "package.json"), '{"private":true}\n', "utf8");
      const ran = await this.#npm(work, version);
      if (ran === "no_npm") return { ok: false, reason: "no_npm" };
      if (ran.timedOut) return { ok: false, reason: "install_timeout" };
      if (ran.code !== 0) return { ok: false, reason: "install_failed", message: tail(ran.output) };
      if (!isInstalledEngine(work, version)) {
        return { ok: false, reason: "not_the_package", message: tail(ran.output) };
      }
      // A folder of that version that is not whole (an interrupted installation) is replaced; a
      // whole one another server just made is kept.
      if (existsSync(target)) {
        if (isInstalledEngine(target, version)) return { ok: true };
        await rm(target, { recursive: true, force: true });
      }
      try {
        await rename(work, target);
      } catch (error) {
        if (isInstalledEngine(target, version)) return { ok: true };
        return {
          ok: false,
          reason: "install_failed",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: "install_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** `npm install agentplugged@<version>` into `work`, the registry named, scripts off. */
  async #npm(work: string, version: string): Promise<Ran | "no_npm"> {
    const args = [
      "install",
      `${ENGINE_PACKAGE}@${version}`,
      "--prefix",
      work,
      "--registry",
      this.#registry,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--loglevel=error",
    ];
    const options = {
      cwd: work,
      env: this.#options.env,
      timeoutMs: this.#options.installTimeoutMs ?? INSTALL_TIMEOUT_MS,
    };
    const how = npmProgram(this.#options.env);
    if (!how.shell) return await runProgram(how.program, [...how.prefix, ...args], options);
    const windows = process.platform === "win32";
    if (windows && args.some((arg) => UNSAFE_FOR_CMD.test(arg))) return "no_npm";
    const ran = await runProgram(
      windows ? "npm.cmd" : "npm",
      windows ? args.map((arg) => `"${arg}"`) : args,
      { ...options, shell: windows },
    );
    return ran.missing ? "no_npm" : ran;
  }

  async upgradeProduct(version: string): Promise<{ readonly ok: true } | EngineUpdateFailure> {
    if (!isReleaseVersion(version)) return { ok: false, reason: "bad_version" };
    const folder = engineDir(version, this.#home);
    if (!isInstalledEngine(folder, version)) return { ok: false, reason: "not_installed" };
    const entry = engineEntry(folder);
    // The new engine does it, with its own files: it pins itself, refreshes the method, then writes
    // the AI tools' files (the launch they declare names the new version).
    for (const args of [["init", "--upgrade-engine"], ["sync"]]) {
      const ran = await runProgram(process.execPath, [entry, ...args], {
        cwd: this.#options.cwd,
        env: this.#options.env,
        timeoutMs: this.#options.installTimeoutMs ?? INSTALL_TIMEOUT_MS,
      });
      if (ran.timedOut) return { ok: false, reason: "product_update_timeout" };
      if (ran.code !== 0) {
        return { ok: false, reason: "product_update_failed", message: tail(ran.output) };
      }
    }
    return { ok: true };
  }

  async noteAutoUpdate(update: EngineAutoUpdate): Promise<void> {
    await this.#writeJson(this.#cachePath, { ...(await this.#cache()), auto: update });
  }

  async lastAutoUpdate(): Promise<EngineAutoUpdate | undefined> {
    return (await this.#cache()).auto;
  }
}
