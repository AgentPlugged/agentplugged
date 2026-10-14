import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

/** Variables that would point `git` at another repository, index or object store. */
const REPOSITORY_VARIABLES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
];

/**
 * Environment of every `git` this adapter starts: the repository is found from the folder only
 * (variables set by a hook or a caller are dropped), output is flushed line by line, never a
 * prompt.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (REPOSITORY_VARIABLES.includes(name.toUpperCase())) delete env[name];
  }
  return { ...env, GIT_FLUSH: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}

export interface GitRun {
  readonly status: number | null;
  readonly stdout: Buffer;
  readonly stderr: string;
  /** True when the run was killed at its time limit. */
  readonly timedOut?: boolean;
}

/**
 * Runs one `git` command to completion. Rejects only when `git` cannot be started. `env` adds
 * variables (for example `LC_ALL=C`, so that messages can be recognised). After `timeoutMs`, the
 * process is killed and the run ends with `status: null` and `timedOut: true`.
 */
export function runGit(
  cwd: string,
  args: readonly string[],
  input?: string,
  env: Readonly<Record<string, string>> = {},
  timeoutMs?: number,
): Promise<GitRun> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: { ...gitEnv(), ...env }, windowsHide: true });
    let timedOut = false;
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill();
          }, timeoutMs);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      const stderr = Buffer.concat(err).toString("utf8").trim();
      resolve({
        status: timedOut ? null : status,
        stdout: Buffer.concat(out),
        stderr: timedOut
          ? `${stderr}\nfatal: git ${args[0] ?? ""} took more than ${Math.round((timeoutMs ?? 0) / 1000)} s`.trim()
          : stderr,
        timedOut,
      });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

type Reader =
  | { kind: "line"; resolve: (line: string) => void; reject: (error: Error) => void }
  | {
      kind: "bytes";
      length: number;
      resolve: (bytes: Buffer) => void;
      reject: (error: Error) => void;
    };

/**
 * A long-running `git` process spoken to line by line (`cat-file --batch-command`,
 * `mktree --batch`, `hash-object --stdin-paths`, `update-ref --stdin`): one start for many
 * requests. Requests are not interleaved: callers serialise them. While idle, the process does
 * not keep Node.js alive; it ends when its standard input closes.
 */
export class GitBatch {
  readonly #child: ChildProcessWithoutNullStreams;
  #buffer: Buffer = Buffer.alloc(0);
  readonly #readers: Reader[] = [];
  #stderr = "";
  #failure: Error | undefined;

  constructor(cwd: string, args: readonly string[]) {
    this.#child = spawn("git", args, { cwd, env: gitEnv(), windowsHide: true });
    const name = `git ${args.join(" ")}`;
    this.#child.stdout.on("data", (chunk: Buffer) => {
      this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
      this.#drain();
    });
    this.#child.stderr.on("data", (chunk: Buffer) => {
      this.#stderr += chunk.toString("utf8");
    });
    this.#child.stdin.on("error", () => {});
    const stop = (reason: string) => {
      this.#failure ??= new Error(
        `${name}: ${reason}${this.#stderr ? `: ${this.#stderr.trim()}` : ""}`,
      );
      for (const reader of this.#readers.splice(0)) reader.reject(this.#failure);
    };
    this.#child.on("error", (error) => stop(error.message));
    this.#child.on("close", (status) => stop(`exited (${status})`));
    this.idle();
  }

  /** True once the process has ended (an error, or a refused `update-ref` transaction). */
  get ended(): boolean {
    return this.#failure !== undefined;
  }

  /** Keeps Node.js alive while a request is pending. */
  busy(): void {
    this.#child.ref();
    for (const stream of [this.#child.stdin, this.#child.stdout, this.#child.stderr]) {
      (stream as unknown as { ref?: () => void }).ref?.();
    }
  }

  /** Lets Node.js exit while no request is pending. */
  idle(): void {
    this.#child.unref();
    for (const stream of [this.#child.stdin, this.#child.stdout, this.#child.stderr]) {
      (stream as unknown as { unref?: () => void }).unref?.();
    }
  }

  write(text: string): void {
    if (this.#failure) throw this.#failure;
    this.#child.stdin.write(text);
  }

  readLine(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.#failure) return reject(this.#failure);
      this.#readers.push({ kind: "line", resolve, reject });
      this.#drain();
    });
  }

  readBytes(length: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (this.#failure) return reject(this.#failure);
      this.#readers.push({ kind: "bytes", length, resolve, reject });
      this.#drain();
    });
  }

  /** Writes `request`, then reads one line of answer. */
  async ask(request: string): Promise<string> {
    this.write(request);
    return this.readLine();
  }

  close(): void {
    this.#child.stdin.end();
  }

  #drain(): void {
    for (;;) {
      const reader = this.#readers[0];
      if (reader === undefined) return;
      if (reader.kind === "line") {
        const end = this.#buffer.indexOf(10);
        if (end === -1) return;
        const line = this.#buffer.subarray(0, end).toString("utf8");
        this.#buffer = this.#buffer.subarray(end + 1);
        this.#readers.shift();
        reader.resolve(line.endsWith("\r") ? line.slice(0, -1) : line);
      } else {
        if (this.#buffer.length < reader.length) return;
        const bytes = Buffer.from(this.#buffer.subarray(0, reader.length));
        this.#buffer = this.#buffer.subarray(reader.length);
        this.#readers.shift();
        reader.resolve(bytes);
      }
    }
  }
}

/** A commit id: only these reach Git as one, never an option. */
export const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The last non-blank line of a text, trimmed (what a refusal says); empty when there is none. */
export function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.at(-1) ?? "";
}

/** A file of a Git tree, as `git ls-tree -z` (with `-l`, the size) lists it. */
export interface TreeEntry {
  readonly oid: string;
  readonly path: string;
  /** Bytes, when listed with `-l`; NaN when not listed. */
  readonly bytes: number;
}

/**
 * The files (blobs) of a `git ls-tree -z` output: `<mode> <type> <object>[ <size>]\t<path>`, the
 * path as stored (no quoting with `-z`). Trees and submodules are left out.
 */
export function treeFiles(output: Buffer): TreeEntry[] {
  const files: TreeEntry[] = [];
  for (const record of output.toString("utf8").split("\0")) {
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const [, type, oid, size] = record.slice(0, tab).trim().split(/\s+/);
    if (type === "blob" && oid !== undefined) {
      files.push({ oid, path: record.slice(tab + 1), bytes: Number(size) });
    }
  }
  return files;
}
