import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  isSecretVariable,
  type ProofRunner,
  type ProofRunRequest,
  type ProofRunResult,
  type WorkingCopy,
} from "@agentplugged/core";

/**
 * Starts the commands the project declares for its proofs. It starts the program
 * itself, without a shell, when the line is a program and its arguments; through the system's shell
 * when the line needs one (its syntax) or, on Windows, when the program is a script (`npm.cmd`).
 * The command runs in a folder inside the project, with the machine's environment minus the
 * variables that look like secrets, without a keyboard; its output is kept bounded (the start and
 * the end); at the time limit the whole tree of processes is stopped, on Windows and on Unix.
 */

export interface NodeProofRunnerOptions {
  /** The project's folder: commands run in it or below it, and Git is asked about it. */
  readonly root: string;
  /** The environment handed on (minus secrets); `process.env` when absent. Tests give their own. */
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

/** How long after the program ended its pipes may stay open (a daemon it started) before the run is over. */
const PIPE_GRACE_MS = 1000;
/** How long a stopped command has to end before the run is reported anyway. */
const KILL_GRACE_MS = 3000;
/** Time given to `git` to say what the copy is. */
const GIT_TIMEOUT_MS = 15_000;

/** The variables that would point `git` at another repository, dropped before asking it. */
const GIT_REPOSITORY_VARIABLES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"];

/** What `git` prints in `root`, or null when it fails. */
export function gitOutput(
  root: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const clean: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
  for (const name of Object.keys(clean)) {
    if (GIT_REPOSITORY_VARIABLES.includes(name.toUpperCase())) delete clean[name];
  }
  return new Promise((done) => {
    execFile(
      "git",
      [...args],
      {
        cwd: root,
        env: clean,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => done(error === null ? stdout : null),
    );
  });
}

/** Where a program lies on Windows: the first match of the PATH with the extensions, or undefined. */
function windowsProgram(program: string, env: NodeJS.ProcessEnv, cwd: string): string | undefined {
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => ext !== "");
  const hasPath = /[\\/]/.test(program);
  const folders = hasPath ? [""] : [cwd, ...(env.PATH ?? env.Path ?? "").split(delimiter)];
  for (const folder of folders) {
    const base = hasPath ? resolve(cwd, program) : join(folder, program);
    const candidates = extname(program) === "" ? extensions.map((ext) => base + ext) : [base];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** True when starting `argv` on Windows needs the shell: the program is a script, not an executable. */
function needsWindowsShell(argv: readonly string[], env: NodeJS.ProcessEnv, cwd: string): boolean {
  const program = argv[0];
  if (program === undefined) return false;
  const found = windowsProgram(program, env, cwd);
  return found !== undefined && /\.(?:cmd|bat)$/i.test(found);
}

/** The bounded start and end of an output, in the order it came. */
class Capture {
  readonly #headMax: number;
  readonly #tailMax: number;
  readonly #head: Buffer[] = [];
  #headSize = 0;
  #tail: Buffer[] = [];
  #tailSize = 0;
  #total = 0;

  constructor(max: number) {
    this.#headMax = Math.floor(max / 4);
    this.#tailMax = max - this.#headMax;
  }

  push(chunk: Buffer): void {
    this.#total += chunk.length;
    let rest = chunk;
    if (this.#headSize < this.#headMax) {
      const room = this.#headMax - this.#headSize;
      this.#head.push(rest.subarray(0, room));
      this.#headSize += Math.min(room, rest.length);
      rest = rest.subarray(room);
    }
    if (rest.length === 0) return;
    this.#tail.push(rest);
    this.#tailSize += rest.length;
    while (this.#tailSize > this.#tailMax) {
      const first = this.#tail[0] as Buffer;
      const over = this.#tailSize - this.#tailMax;
      if (first.length <= over) {
        this.#tail.shift();
        this.#tailSize -= first.length;
      } else {
        this.#tail[0] = first.subarray(over);
        this.#tailSize -= over;
      }
    }
  }

  result(): Pick<ProofRunResult, "head" | "tail" | "omitted"> {
    return {
      head: Buffer.concat(this.#head).toString("utf8"),
      tail: Buffer.concat(this.#tail).toString("utf8"),
      omitted: Math.max(0, this.#total - this.#headSize - this.#tailSize),
    };
  }
}

/**
 * The folder a run starts from: the project's, or the working copy of a story, given
 * as `story.started` recorded it, relative to the repository. It must exist and belong to the same
 * repository as the project (the same Git folder): the engine never runs anywhere else.
 */
export async function workspaceBase(
  root: string,
  workspace: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<string | { readonly error: string }> {
  if (workspace === undefined || workspace === ".") return root;
  const top = (await gitOutput(root, ["rev-parse", "--show-toplevel"], env))?.trim();
  const prefix = (await gitOutput(root, ["rev-parse", "--show-prefix"], env))?.trim() ?? "";
  if (top === undefined || top === "") return { error: "the project is not in a repository" };
  const worktree = resolve(top, workspace);
  const common = async (folder: string): Promise<string | undefined> => {
    const found = (await gitOutput(folder, ["rev-parse", "--git-common-dir"], env))?.trim();
    return found === undefined || found === ""
      ? undefined
      : realpath(resolve(folder, found)).catch(() => undefined);
  };
  const [mine, theirs] = await Promise.all([common(root), common(worktree)]);
  if (mine === undefined || theirs === undefined || mine !== theirs) {
    return { error: "the story's working copy is not a working copy of this repository" };
  }
  return resolve(worktree, prefix);
}

export class NodeProofRunner implements ProofRunner {
  readonly #root: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #platform: NodeJS.Platform;

  constructor(options: NodeProofRunnerOptions) {
    this.#root = resolve(options.root);
    this.#env = options.env ?? process.env;
    this.#platform = options.platform ?? process.platform;
  }

  #base(workspace: string | undefined): Promise<string | { readonly error: string }> {
    return workspaceBase(this.#root, workspace, this.#env);
  }

  async workingCopy(workspace?: string): Promise<WorkingCopy> {
    const base = await this.#base(workspace);
    if (typeof base !== "string") return {};
    const head = await gitOutput(base, ["rev-parse", "HEAD"], this.#env);
    const commit = head?.trim();
    const status = await gitOutput(
      base,
      ["status", "--porcelain", "--untracked-files=normal"],
      this.#env,
    );
    return {
      ...(commit !== undefined && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit) ? { commit } : {}),
      ...(status === null ? {} : { clean: status.trim() === "" }),
    };
  }

  /** The environment of the command: the machine's, without what looks like a secret. */
  #environment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(this.#env)) {
      if (value !== undefined && !isSecretVariable(name, value)) env[name] = value;
    }
    // No keyboard and no screen: a tool must not wait for an answer, nor colour its output.
    return { ...env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" };
  }

  /** The folder to run in, or why it is not allowed: inside the project, links followed. */
  async #folder(base: string, cwd: string): Promise<string | { readonly error: string }> {
    try {
      const root = await realpath(base);
      const folder = await realpath(resolve(base, cwd));
      const inside = relative(root, folder);
      if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
        return { error: "the folder is outside the project" };
      }
      return folder;
    } catch {
      return { error: `the folder ${cwd} does not exist` };
    }
  }

  async run(request: ProofRunRequest): Promise<ProofRunResult> {
    const started = performance.now();
    const failed = (detail: string): ProofRunResult => ({
      ended: "error",
      exit: null,
      ms: Math.round(performance.now() - started),
      head: "",
      tail: "",
      omitted: 0,
      detail,
    });
    const base = await this.#base(request.workspace);
    if (typeof base !== "string") return failed(base.error);
    const folder = await this.#folder(base, request.cwd);
    if (typeof folder !== "string") return failed(folder.error);
    const env = this.#environment();
    const windows = this.#platform === "win32";
    const viaShell =
      request.argv === null || (windows && needsWindowsShell(request.argv, env, folder));
    const capture = new Capture(request.maxOutputBytes);
    const options = {
      cwd: folder,
      env,
      stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // A group of its own on Unix, so that the whole tree can be stopped.
      detached: !windows,
    };
    return await new Promise<ProofRunResult>((done) => {
      let child: ChildProcess;
      try {
        child =
          viaShell || request.argv === null
            ? spawn(request.line, { ...options, shell: true })
            : spawn(request.argv[0] as string, request.argv.slice(1), options);
      } catch (error) {
        done(failed(error instanceof Error ? error.message : "the command could not be started"));
        return;
      }
      let timedOut = false;
      let settled = false;
      let exit: number | null = null;
      let ended = false;
      const timers: NodeJS.Timeout[] = [];
      const finish = (error?: string) => {
        if (settled) return;
        settled = true;
        for (const timer of timers) clearTimeout(timer);
        child.stdout?.destroy();
        child.stderr?.destroy();
        done({
          ended: error !== undefined ? "error" : timedOut ? "timeout" : "exit",
          exit: error !== undefined || timedOut ? null : exit,
          ms: Math.round(performance.now() - started),
          ...capture.result(),
          ...(error === undefined ? {} : { detail: error }),
        });
      };
      child.stdout?.on("data", (chunk: Buffer) => capture.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => capture.push(chunk));
      child.on("error", (error) => finish(error.message));
      child.on("close", () => finish());
      child.on("exit", (code) => {
        ended = true;
        exit = code;
        // The program is over; what it left running does not keep the run open.
        timers.push(
          setTimeout(() => {
            this.#stop(child, true);
            finish();
          }, PIPE_GRACE_MS),
        );
      });
      timers.push(
        setTimeout(() => {
          if (ended || settled) return;
          timedOut = true;
          this.#stop(child, false);
          timers.push(setTimeout(() => finish(), KILL_GRACE_MS));
        }, request.timeoutMs),
      );
    });
  }

  /** Stops the command and everything it started. `quiet`: the leftovers of a command that ended. */
  #stop(child: ChildProcess, quiet: boolean): void {
    const pid = child.pid;
    if (pid === undefined) return;
    if (this.#platform === "win32") {
      // `/T` follows the tree of children, `/F` forces: the only way to reach what a script started.
      if (!quiet) {
        const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.on("error", () => child.kill());
      }
      return;
    }
    try {
      process.kill(-pid, quiet ? "SIGKILL" : "SIGTERM");
      if (!quiet) {
        setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }, 1000).unref();
      }
    } catch {
      child.kill("SIGKILL");
    }
  }
}
