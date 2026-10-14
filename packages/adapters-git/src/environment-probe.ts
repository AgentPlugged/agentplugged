import { spawn } from "node:child_process";
import { constants, statSync } from "node:fs";
import { access, statfs } from "node:fs/promises";
import { createServer } from "node:net";
import { arch, homedir, release, totalmem, userInfo } from "node:os";
import { posix, resolve as resolvePath, win32 } from "node:path";
import {
  DEFAULT_PATHEXT,
  type DirectorySpec,
  type EnvironmentProbe,
  type EnvironmentRun,
  envValue,
  type FoundCommand,
  type KeyStore,
  type MachineDescription,
  type PresenceAuthenticator,
  type RunOptions,
} from "@agentplugged/core";
import { CMD_META, cmdArgument, resolveCommand, toolEnv } from "./git-forge.js";
import { runGit } from "./git-process.js";

/** Longest time a quick question of the machine may take. */
const QUICK_MS = 15_000;
/** Longest time a run may take when nobody gives a limit (an installer included). */
const LONG_MS = 10 * 60_000;
/** Enough for any message of a tool; the rest is cut. */
const MAX_OUTPUT = 64 * 1024;
/** What Windows runs without a shell, or through `cmd` for a batch file. */
const RUNNABLE = new Set([".exe", ".com", ".bat", ".cmd"]);

export interface NodeEnvironmentProbeOptions {
  /** The product's folder: where Git is asked about the repository. */
  readonly cwd: string;
  /** Where `PATH`, `PATHEXT` and the install folders are read; the process' by default. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The running platform by default. */
  readonly platform?: NodeJS.Platform;
  /** The system keychain, only asked whether it answers. */
  readonly keys?: Pick<KeyStore, "readMachineSecret">;
  /** Windows Hello, only asked whether it is available. */
  readonly presence?: PresenceAuthenticator;
}

/** The host of a remote's address: `github.com` for both `https://github.com/a/b` and `git@github.com:a/b`. */
function hostOf(url: string): string | undefined {
  const host =
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)/i.exec(url)?.[1] ??
    /^(?:[^@/]+@)?([^/:]+):/.exec(url)?.[1];
  return host?.toLowerCase();
}

function forgeOfHost(host: string): "github" | "gitlab" | undefined {
  if (host === "github.com" || host.startsWith("github.")) return "github";
  if (host === "gitlab.com" || host.startsWith("gitlab.")) return "gitlab";
  return undefined;
}

/**
 * `EnvironmentProbe` on the real machine. It starts programs without a shell (a batch
 * file on Windows through `cmd`, every argument escaped), never asks for a login token, never
 * writes anything itself: what a repair changes is what the program it was told to run changes.
 */
export class NodeEnvironmentProbe implements EnvironmentProbe {
  readonly platform: string;
  readonly #cwd: string;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #windows: boolean;
  readonly #path: typeof posix;
  readonly #keys: Pick<KeyStore, "readMachineSecret"> | undefined;
  readonly #presence: PresenceAuthenticator | undefined;

  constructor(options: NodeEnvironmentProbeOptions) {
    this.platform = options.platform ?? process.platform;
    this.#windows = this.platform === "win32";
    this.#path = this.#windows ? win32 : posix;
    this.#cwd = options.cwd;
    this.#env = options.env ?? process.env;
    this.#keys = options.keys;
    this.#presence = options.presence;
  }

  #get(name: string): string | undefined {
    return envValue(this.#env, name, this.#windows);
  }

  nodeVersion(): string {
    return process.version;
  }

  memoryGb(): number {
    return totalmem() / 1024 ** 3;
  }

  directories(specs: readonly DirectorySpec[]): string[] {
    const folders: string[] = [];
    for (const spec of specs) {
      if (spec.env !== undefined) {
        const base = this.#get(spec.env);
        if (base !== undefined && base.trim() !== "") {
          folders.push(this.#path.join(base, ...spec.path));
        }
      } else if (spec.home === true) {
        folders.push(
          this.#path.join(
            this.#get(this.#windows ? "USERPROFILE" : "HOME") ?? homedir(),
            ...spec.path,
          ),
        );
      } else if (spec.root === true && !this.#windows) {
        folders.push(posix.join("/", ...spec.path));
      }
    }
    return folders;
  }

  #isExecutable(path: string): Promise<boolean> {
    try {
      if (!statSync(path).isFile()) return Promise.resolve(false);
    } catch {
      return Promise.resolve(false);
    }
    return this.#windows
      ? Promise.resolve(true)
      : access(path, constants.X_OK).then(
          () => true,
          () => false,
        );
  }

  /** The executable `name` in each folder, in order; undefined when none holds it. */
  async #search(
    names: readonly string[],
    folders: readonly { readonly dir: string; readonly onPath: boolean }[],
  ): Promise<FoundCommand | undefined> {
    const extensions = this.#windows
      ? (this.#get("PATHEXT") || DEFAULT_PATHEXT)
          .split(";")
          .map((ext) => ext.trim().toLowerCase())
          .filter((ext) => RUNNABLE.has(ext))
      : [""];
    for (const name of names) {
      for (const { dir, onPath } of folders) {
        for (const ext of extensions) {
          const path = this.#path.join(dir, `${name}${ext}`);
          if (await this.#isExecutable(path)) return { name, path, onPath };
        }
      }
    }
    return undefined;
  }

  processPath(): string[] {
    return (
      (this.#get("PATH") ?? "")
        .split(this.#path.delimiter)
        .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
        // A relative folder (`.`) would make a file of the open repository a program of the machine.
        .filter((dir) => dir !== "" && this.#path.isAbsolute(dir))
    );
  }

  async find(
    names: readonly string[],
    extra: readonly DirectorySpec[] = [],
  ): Promise<FoundCommand | undefined> {
    const wanted = new Set(names);
    const elsewhere = this.directories(
      extra.filter((spec) => spec.for === undefined || wanted.has(spec.for)),
    );
    return this.#search(names, [
      ...this.processPath().map((dir) => ({ dir, onPath: true })),
      ...elsewhere.map((dir) => ({ dir, onPath: false })),
    ]);
  }

  async findIn(
    names: readonly string[],
    folders: readonly string[],
  ): Promise<FoundCommand | undefined> {
    return this.#search(
      names,
      folders.filter((dir) => this.#path.isAbsolute(dir)).map((dir) => ({ dir, onPath: false })),
    );
  }

  /** The program and arguments to start: a batch file goes through `cmd`, escaped. */
  #launch(
    command: readonly string[],
  ): { file: string; args: string[]; verbatim: boolean } | undefined {
    const [program, ...args] = command;
    if (program === undefined) return undefined;
    const env = toolEnv();
    const file = this.#windows ? resolveCommand(program, env, "win32") : program;
    if (file === undefined) return undefined;
    if (this.#windows && /\.(?:cmd|bat)$/i.test(file)) {
      return {
        file: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
        args: [
          "/d",
          "/s",
          "/c",
          `"${[file.replace(CMD_META, "^$1"), ...args.map(cmdArgument)].join(" ")}"`,
        ],
        verbatim: true,
      };
    }
    return { file, args, verbatim: false };
  }

  run(command: readonly string[], options: RunOptions = {}): Promise<EnvironmentRun> {
    const launch = this.#launch(command);
    if (launch === undefined) {
      return Promise.resolve({
        status: null,
        stdout: "",
        stderr: `${command[0] ?? ""}: not found`,
        missing: true,
      });
    }
    return new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(launch.file, launch.args, {
          cwd: options.cwd ?? this.#cwd,
          env: toolEnv(),
          windowsHide: true,
          windowsVerbatimArguments: launch.verbatim,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        resolve({ status: null, stdout: "", stderr: "", missing: true });
        return;
      }
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      const finish = (result: EnvironmentRun) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(
        () => {
          timedOut = true;
          this.#kill(child);
          // A grandchild may keep the pipes open: release them so nothing waits on it.
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish({ status: null, stdout, stderr, timedOut: true });
        },
        options.timeoutMs ?? (this.#isQuick(command) ? QUICK_MS : LONG_MS),
      );
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        // The end is what says why a program stopped.
        stdout = (stdout + chunk).slice(-MAX_OUTPUT);
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-MAX_OUTPUT);
      });
      child.on("error", (error: NodeJS.ErrnoException) =>
        finish({ status: null, stdout, stderr: error.message, missing: error.code === "ENOENT" }),
      );
      child.on("close", (status) =>
        finish({ status: timedOut ? null : status, stdout, stderr: stderr.trim() }),
      );
    });
  }

  /** A question (`--version`, `auth status`, `config`) is quick; the rest may be an installer. */
  #isQuick(command: readonly string[]): boolean {
    return command[1] === "--version" || (command[1] === "auth" && command[2] === "status");
  }

  /** Stops a run; on Windows the whole tree, since `cmd` does not stop its children. */
  #kill(child: ReturnType<typeof spawn>): void {
    if (this.#windows && child.pid !== undefined) {
      try {
        spawn(
          win32.join(this.#get("SystemRoot") || "C:/Windows", "System32", "taskkill.exe"),
          ["/pid", String(child.pid), "/T", "/F"],
          { stdio: "ignore", windowsHide: true },
        ).on("error", () => {});
      } catch {
        // The direct kill below still applies.
      }
    }
    child.kill();
  }

  runInTerminal(
    command: readonly string[],
    options: RunOptions = {},
  ): Promise<{ status: number | null; missing?: boolean }> {
    const launch = this.#launch(command);
    if (launch === undefined) return Promise.resolve({ status: null, missing: true });
    return new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(launch.file, launch.args, {
          cwd: options.cwd ?? this.#cwd,
          // The creator's own environment: a sign-in or an installer may ask, show, open a browser.
          env: { ...process.env },
          windowsVerbatimArguments: launch.verbatim,
          shell: false,
          stdio: "inherit",
        });
      } catch {
        resolve({ status: null, missing: true });
        return;
      }
      child.on("error", (error: NodeJS.ErrnoException) =>
        resolve({ status: null, ...(error.code === "ENOENT" ? { missing: true } : {}) }),
      );
      child.on("close", (status) => resolve({ status }));
    });
  }

  async isRepository(): Promise<boolean> {
    try {
      const run = await runGit(
        this.#cwd,
        ["rev-parse", "--is-inside-work-tree"],
        undefined,
        { LC_ALL: "C" },
        QUICK_MS,
      );
      return run.status === 0 && run.stdout.toString("utf8").trim() === "true";
    } catch {
      return false;
    }
  }

  async gitConfig(key: string): Promise<string | undefined> {
    try {
      const run = await runGit(
        this.#cwd,
        ["config", "--get", key],
        undefined,
        { LC_ALL: "C" },
        QUICK_MS,
      );
      const value = run.stdout.toString("utf8").trim();
      return run.status === 0 && value !== "" ? value : undefined;
    } catch {
      return undefined;
    }
  }

  async forge(): Promise<{ forge?: "github" | "gitlab"; host?: string }> {
    try {
      const names = await runGit(this.#cwd, ["remote"], undefined, { LC_ALL: "C" }, QUICK_MS);
      const remotes = names.stdout
        .toString("utf8")
        .split(/\r?\n/)
        .map((name) => name.trim())
        .filter((name) => name !== "");
      const name = remotes.includes("origin") ? "origin" : remotes[0];
      if (name === undefined) return {};
      // The address Git pushes to (`pushurl`, `insteadOf` applied), as the forge gestures read it.
      const url = await runGit(
        this.#cwd,
        ["remote", "get-url", "--push", name],
        undefined,
        { LC_ALL: "C" },
        QUICK_MS,
      );
      const host = url.status === 0 ? hostOf(url.stdout.toString("utf8").trim()) : undefined;
      if (host === undefined) return {};
      const forge = forgeOfHost(host);
      return forge === undefined ? { host } : { forge, host };
    } catch {
      return {};
    }
  }

  port(port: number): Promise<"free" | "busy" | "refused"> {
    return new Promise((resolve) => {
      const server = createServer();
      server.once("error", (error: NodeJS.ErrnoException) => {
        // Taken, or not allowed; any other error means the port cannot be used either.
        resolve(error.code === "EADDRINUSE" ? "busy" : "refused");
      });
      server.once("listening", () => server.close(() => resolve("free")));
      try {
        server.listen(port);
      } catch {
        resolve("refused");
      }
    });
  }

  env(name: string): string | undefined {
    const value = this.#get(name)?.trim();
    return value === undefined || value === "" ? undefined : value;
  }

  envNames(): string[] {
    return Object.keys(this.#env);
  }

  describeMachine(): MachineDescription {
    let user: string | undefined;
    try {
      user = userInfo().username;
    } catch {
      // No account entry for this process (a container, a service): the name is not known.
      user = undefined;
    }
    const home = this.#get(this.#windows ? "USERPROFILE" : "HOME") ?? homedir();
    return {
      arch: arch(),
      release: release(),
      ...(home.trim() === "" ? {} : { home }),
      ...(user === undefined || user === "" ? {} : { user }),
    };
  }

  workingFolder(): string {
    return resolvePath(this.#cwd);
  }

  async diskFreeGb(): Promise<number | undefined> {
    try {
      const stats = await statfs(this.#cwd);
      return (Number(stats.bavail) * Number(stats.bsize)) / 1024 ** 3;
    } catch {
      return undefined;
    }
  }

  async reservedPortRanges(): Promise<{ from: number; to: number }[] | undefined> {
    if (!this.#windows) return undefined;
    const run = await this.run(
      ["netsh", "interface", "ipv4", "show", "excludedportrange", "protocol=tcp"],
      {
        timeoutMs: QUICK_MS,
      },
    );
    if (run.status !== 0) return undefined;
    const ranges: { from: number; to: number }[] = [];
    // Two numbers per line, whatever the language of the system (a trailing * marks an administrator's).
    for (const line of run.stdout.split(/\r?\n/)) {
      const match = /^\s*(\d{1,5})\s+(\d{1,5})\s*\*?\s*$/.exec(line);
      if (match === null) continue;
      ranges.push({ from: Number(match[1]), to: Number(match[2]) });
    }
    return ranges;
  }

  async isAdministrator(): Promise<boolean | undefined> {
    if (!this.#windows) {
      return typeof process.getuid === "function" ? process.getuid() === 0 : undefined;
    }
    // `fltmc` lists the file system filters, which only an elevated process may do.
    const run = await this.run(["fltmc"], { timeoutMs: QUICK_MS });
    if (run.missing === true || run.timedOut === true || run.status === null) return undefined;
    return run.status === 0;
  }

  async longPathsEnabled(): Promise<boolean | undefined> {
    if (!this.#windows) return undefined;
    const run = await this.run(
      [
        "reg",
        "query",
        "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem",
        "/v",
        "LongPathsEnabled",
      ],
      { timeoutMs: QUICK_MS },
    );
    if (run.status !== 0) return undefined;
    const value = /LongPathsEnabled\s+REG_DWORD\s+(0x[0-9a-f]+)/i.exec(run.stdout)?.[1];
    return value === undefined ? undefined : Number(value) !== 0;
  }

  async systemPath(): Promise<string[] | undefined> {
    if (!this.#windows) return undefined;
    const keys = [
      "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
      "HKCU\\Environment",
    ];
    const folders: string[] = [];
    let readAny = false;
    for (const key of keys) {
      const run = await this.run(["reg", "query", key, "/v", "Path"], { timeoutMs: QUICK_MS });
      if (run.status !== 0) continue;
      const value = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/im.exec(run.stdout)?.[1];
      if (value === undefined) continue;
      readAny = true;
      const expanded = value.replace(/%([^%]+)%/g, (all, name: string) => this.#get(name) ?? all);
      for (const raw of expanded.split(";")) {
        const dir = raw.trim().replace(/^"(.*)"$/, "$1");
        if (dir === "" || !win32.isAbsolute(dir) || dir.includes("%")) continue;
        try {
          if (statSync(dir).isDirectory() && !folders.includes(dir)) folders.push(dir);
        } catch {
          // A folder that is not there cannot hold a program.
        }
      }
    }
    return readAny ? folders : undefined;
  }

  async keychain(): Promise<boolean> {
    if (this.#keys === undefined) return false;
    try {
      // Reads the machine key's entry (empty is fine): only whether the keychain answers.
      await this.#keys.readMachineSecret();
      return true;
    } catch {
      return false;
    }
  }

  async presence(): Promise<boolean> {
    if (this.#presence === undefined) return false;
    try {
      return (await this.#presence.availability()).available;
    } catch {
      return false;
    }
  }
}
