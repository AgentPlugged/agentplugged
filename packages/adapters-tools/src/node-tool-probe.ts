import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import {
  type CommandMatch,
  DEFAULT_PATHEXT,
  type Editor,
  type ExtensionMatch,
  envValue,
  type ToolProbe,
} from "@agentplugged/core";

export interface NodeToolProbeOptions {
  /** Environment to read `PATH`, `PATHEXT`, `HOME` and `USERPROFILE` from. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Defaults to the running platform. */
  readonly platform?: NodeJS.Platform;
  /** Time limit of one `--version` probe. Defaults to 10 s. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** Enough for any version banner; anything longer is cut. */
const MAX_OUTPUT = 64 * 1024;
/** Windows executables the probe knows how to start without a shell. */
const DIRECT = new Set([".exe", ".com"]);
const VIA_CMD = new Set([".bat", ".cmd"]);
/** Characters `cmd` would still interpret inside double quotes. */
const UNSAFE_FOR_CMD = /["%!\r\n]/;

/**
 * Folders, under the home folder, where an AI tool's installer puts its command without adding
 * it to `PATH`: searched after `PATH`, in this order. Antigravity CLI installs `agy` in
 * `~/.gemini/bin`, which its installer does not add to `PATH` on Windows.
 */
const HOME_TOOL_DIRS: ReadonlyArray<readonly string[]> = [
  [".gemini", "bin"],
  // Claude Code's native installer (and its former local install).
  [".local", "bin"],
  [".claude", "local"],
];

const EXTENSION_DIRS: ReadonlyArray<{ editor: Editor; dir: readonly string[] }> = [
  { editor: "vscode", dir: [".vscode", "extensions"] },
  { editor: "vscode", dir: [".vscode-insiders", "extensions"] },
  { editor: "cursor", dir: [".cursor", "extensions"] },
];

/** `ToolProbe` on the local machine: `PATH` lookup, `--version`, editor extension folders. */
export class NodeToolProbe implements ToolProbe {
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #windows: boolean;
  /** Path functions of the configured platform, not of the host. */
  readonly #path: typeof posix;
  readonly #timeoutMs: number;

  constructor(options: NodeToolProbeOptions) {
    this.#env = options.env;
    this.#windows = (options.platform ?? process.platform) === "win32";
    this.#path = this.#windows ? win32 : posix;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  #get(name: string): string | undefined {
    return envValue(this.#env, name, this.#windows);
  }

  async which(names: readonly string[]): Promise<CommandMatch | undefined> {
    const dirs = (this.#get("PATH") ?? "")
      .split(this.#path.delimiter)
      .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
      .filter((dir) => dir !== "");
    const onPath = dirs.length;
    const home = this.#home();
    if (home !== undefined) {
      for (const dir of HOME_TOOL_DIRS) dirs.push(this.#path.join(home, ...dir));
    }
    const extensions = this.#windows
      ? (this.#get("PATHEXT") || DEFAULT_PATHEXT)
          .split(";")
          .map((ext) => ext.trim().toLowerCase())
          .filter((ext) => DIRECT.has(ext) || VIA_CMD.has(ext))
      : [""];
    for (const name of names) {
      for (const [index, dir] of dirs.entries()) {
        for (const ext of extensions) {
          const path = this.#path.join(dir, `${name}${ext}`);
          if (await this.#isExecutable(path))
            return index < onPath ? { name, path } : { name, path, onPath: false };
        }
      }
    }
    return undefined;
  }

  async #isExecutable(path: string): Promise<boolean> {
    try {
      if (!(await stat(path)).isFile()) return false;
      if (!this.#windows) await access(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  version(path: string): Promise<string | undefined> {
    let file = path;
    let args = ["--version"];
    let verbatim = false;
    if (this.#windows) {
      const ext = this.#path.extname(path).toLowerCase();
      if (VIA_CMD.has(ext)) {
        // A batch file needs cmd; the path is quoted and the argument is fixed.
        if (UNSAFE_FOR_CMD.test(path)) return Promise.resolve(undefined);
        file = this.#get("ComSpec") || this.#system32("cmd.exe");
        args = ["/d", "/s", "/c", `""${path}" --version"`];
        verbatim = true;
      } else if (!DIRECT.has(ext)) {
        return Promise.resolve(undefined);
      }
    }
    return this.#run(file, args, verbatim);
  }

  /** A Windows system program, found without relying on `PATH`. */
  #system32(program: string): string {
    return win32.join(this.#get("SystemRoot") || "C:/Windows", "System32", program);
  }

  /** Stops a probe; on Windows the whole tree, since `cmd` does not stop its children. */
  #kill(child: ReturnType<typeof spawn>): void {
    if (this.#windows && child.pid !== undefined) {
      try {
        spawn(this.#system32("taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        }).on("error", () => {});
      } catch {
        // The direct kill below still applies.
      }
    }
    child.kill();
  }

  #run(file: string, args: string[], verbatim: boolean): Promise<string | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      let stdout = "";
      let stderr = "";
      const finish = (value: string | undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(file, args, {
          env: this.#env as NodeJS.ProcessEnv,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          windowsVerbatimArguments: verbatim,
          shell: false,
        });
      } catch {
        resolve(undefined);
        return;
      }
      const timer = setTimeout(() => {
        this.#kill(child);
        // A grandchild may keep the pipes open: release them so nothing waits on it.
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(undefined);
      }, this.#timeoutMs);
      // Decoded as streams, so a character split between two chunks stays whole.
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        if (stdout.length < MAX_OUTPUT) stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        if (stderr.length < MAX_OUTPUT) stderr += chunk;
      });
      child.on("error", () => finish(undefined));
      child.on("close", (code) => {
        if (code !== 0) return finish(undefined);
        // stdout is the answer; stderr (warnings) only when a tool prints its version there.
        finish((stdout.trim() !== "" ? stdout : stderr).slice(0, MAX_OUTPUT));
      });
    });
  }

  /** The home folder: `USERPROFILE` first on Windows, `HOME` first elsewhere. */
  #home(): string | undefined {
    const home = this.#windows
      ? this.#get("USERPROFILE") || this.#get("HOME")
      : this.#get("HOME") || this.#get("USERPROFILE");
    return home || undefined;
  }

  async extensions(prefix: string): Promise<ExtensionMatch[]> {
    const home = this.#home();
    if (home === undefined) return [];
    const lowerPrefix = `${prefix.toLowerCase()}-`;
    const found = await Promise.all(
      EXTENSION_DIRS.map(async ({ editor, dir }) => {
        const root = this.#path.join(home, ...dir);
        const [entries, obsolete] = await Promise.all([
          readdir(root, { withFileTypes: true }).catch(() => []),
          readObsolete(this.#path.join(root, ".obsolete")),
        ]);
        const folders = entries.filter(
          (entry) =>
            entry.isDirectory() &&
            entry.name.toLowerCase().startsWith(lowerPrefix) &&
            !obsolete.has(entry.name),
        );
        return Promise.all(
          folders.map(async (entry) => ({
            editor,
            version: await readManifestVersion(this.#path.join(root, entry.name, "package.json")),
          })),
        );
      }),
    );
    return found.flat();
  }
}

/**
 * Folders the editor has uninstalled but not yet deleted: truthy keys of its `.obsolete` file.
 * A missing or invalid file means none.
 */
async function readObsolete(path: string): Promise<Set<string>> {
  try {
    const content: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof content !== "object" || content === null || Array.isArray(content)) return new Set();
    return new Set(
      Object.entries(content)
        .filter(([, value]) => Boolean(value))
        .map(([key]) => key),
    );
  } catch {
    return new Set();
  }
}

/** The `version` of an extension's `package.json`; nothing else is read from it. */
async function readManifestVersion(path: string): Promise<string | undefined> {
  try {
    const manifest: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof manifest !== "object" || manifest === null) return undefined;
    const version = (manifest as { version?: unknown }).version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}
