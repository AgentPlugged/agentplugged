/**
 * Port through which the engine starts a command of the project. `core` knows no
 * process: an adapter (Node) implements it. It starts the program without a shell when the line
 * allows it (`argv`), keeps the output bounded, stops the whole tree of processes at the time
 * limit, and hands the command an environment without the secrets of the machine.
 */

/** What the engine asks the adapter to start. */
export interface ProofRunRequest {
  /** The line exactly as the creator accepted it. */
  readonly line: string;
  /** The program and its arguments when the line is plain; null when it needs the shell's syntax. */
  readonly argv: readonly string[] | null;
  /** The folder, relative to the project, with `/`; `.` is the project's. */
  readonly cwd: string;
  /**
   * The working copy of a story, as `story.started` recorded it: relative to the
   * repository, `../shop.worktrees/17-3`. The folder is then looked for in it, not in the
   * project's own. The adapter checks that it is a working copy of the same repository.
   */
  readonly workspace?: string;
  /** The time limit: the whole tree of processes is stopped after it. */
  readonly timeoutMs: number;
  /** The most output kept, in bytes; the middle of a longer output is dropped. */
  readonly maxOutputBytes: number;
}

/** How a run ended. */
export interface ProofRunResult {
  /** `exit`: the command ended by itself; `timeout`: the engine stopped it; `error`: it never started. */
  readonly ended: "exit" | "timeout" | "error";
  /** The exit code, null when it was stopped (timeout, signal) or never started. */
  readonly exit: number | null;
  readonly ms: number;
  /** The start of the output (standard output and error, in order) and its end; `omitted` bytes lie between. */
  readonly head: string;
  readonly tail: string;
  readonly omitted: number;
  /** Why it never started, or what stopped it. */
  readonly detail?: string;
}

/** What Git says of the project's folder: the commit tested, and whether nothing was left uncommitted. */
export interface WorkingCopy {
  readonly commit?: string;
  readonly clean?: boolean;
}

export interface ProofRunner {
  /** The commit the project's folder is at and whether it is clean; empty when Git cannot say. */
  workingCopy(workspace?: string): Promise<WorkingCopy>;
  /** Starts the command and waits for it to end, or to be stopped. Never throws for a command that fails. */
  run(request: ProofRunRequest): Promise<ProofRunResult>;
}

/** The most output a run keeps, and the largest the adapter may be asked to keep. */
export const MAX_PROOF_OUTPUT_BYTES = 256 * 1024;
