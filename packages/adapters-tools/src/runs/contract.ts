/**
 * The contract between the bridge and the AI tools it drives. The bridge only ever talks to a
 * `ToolAdapter`; an adapter is a small, pure `ToolTranslator` (how to start the official program
 * and how to read its structured output) plus the shared process core (`startToolRun`), which
 * owns the process, the line-by-line JSON stream, the stop and the failure detection. A further
 * tool needs a translator and nothing else.
 */

/** The AI tools the bridge can drive. */
export type RunToolId = "claude-code" | "codex" | "antigravity" | "cursor";

/**
 * What the creator allowed, decided before the run starts. The tool never asks while it runs: an
 * action outside this plan is refused, and the refusal is told (`permission.denied`).
 *
 * - `read`: the agent reads and searches; it writes nothing.
 * - `edit`: it also edits files of the working folder.
 *
 * `allowMcpServers` names the MCP servers whose tools the agent may call, by server name (the
 * product's own server, through which an agent reports and opens checkpoints): without it a folder
 * the tool does not trust yet would refuse the agent its only way to report. Never a tool of
 * another kind, never a pattern.
 *
 * `allowCommands` and `denyCommands` are command prefixes (`git status`, `pnpm test`), never a
 * pattern of the tool's own syntax; each translator turns them into its tool's rules. There is no
 * level that bypasses the tool's permission checks.
 */
export interface PermissionPlan {
  readonly level: "read" | "edit";
  readonly allowCommands?: readonly string[];
  readonly denyCommands?: readonly string[];
  readonly allowMcpServers?: readonly string[];
  /**
   * The agent gets no tool at all and no MCP server, whatever the creator's own settings allow
   * (a question answered from text given in the prompt): the tool is started with its tool list
   * empty and with only the MCP servers named on the command line, which are none.
   */
  readonly noTools?: boolean;
  /**
   * The rules the product's own settings give its agents (the creator's policy, written by sync),
   * already in the tool's syntax, passed at the launch so that they hold even in a folder the tool
   * does not trust yet, in a settings file of the launch (any number of rules). Only rules for
   * running commands are accepted as allowed (never a bare tool, a path or the web); refusals may
   * be of any kind. The floor of refusals the adapter keeps is added to them, never removed.
   */
  readonly projectRules?: { readonly allow: readonly string[]; readonly deny: readonly string[] };
}

/** One run of an agent: what to start, where, and with which permissions. */
export interface RunRequest {
  /** The folder the agent works in (its worktree). */
  readonly cwd: string;
  /** The instruction, passed on the standard input and never on a command line. */
  readonly prompt: string;
  readonly permissions: PermissionPlan;
  /** A model name or alias the tool knows; absent: the tool's own default. */
  readonly model?: string;
  /** The session to continue (its identifier from an earlier run); absent: a new session. */
  readonly resume?: string;
  /**
   * The identifier a new session is given, chosen by the caller so that it is known before the run
   * starts (a tool that cannot name its sessions refuses it). Never together with `resume`.
   */
  readonly sessionId?: string;
  /** False: the tool keeps no trace of the session on the disk (it cannot be resumed). Default true. */
  readonly persistSession?: boolean;
  /** A spending ceiling in US dollars, for the tools that bill by usage. */
  readonly maxBudgetUsd?: number;
  /** The run is stopped after this long (default 30 minutes). */
  readonly maxDurationMs?: number;
}

/**
 * What a tool can do and what it cannot, told to the creator so that a fallback is shown instead
 * of hidden. A `false` is never an error: it is the mode the creator is told about.
 */
export interface ToolCapabilities {
  /** The tool reports tokens (and perhaps a cost) while it works or at the end. */
  readonly reportsUsage: boolean;
  /** The tool reports a cost in money (for a subscription, an estimate). */
  readonly reportsCost: boolean;
  /** A permission request can be answered while the run goes on. When false, permissions are decided before the start. */
  readonly interceptsPermissions: boolean;
  /** A session can be continued with a new instruction. */
  readonly canResume: boolean;
  /** The run can be held and continued without stopping the process. When false, a pause is a stop and a resume. */
  readonly nativePause: boolean;
}

/** The consumption of a run, cumulative since its start. Absent fields are unknown, not zero. */
export interface RunUsage {
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

/** How the tool bills the work, when it says. A subscription's cost is an equivalent. */
export type RunBilling = "usage" | "subscription";

/**
 * What a tool call does, in the same words for every tool: the file it reads, the file it
 * changes, or the command it runs. `target` is what the tool gave, untouched (a path as the tool
 * wrote it, the text of a command): the bridge makes a path relative to the working folder and
 * masks secrets before anything is shown. A call that does none of these has no action.
 */
export interface ToolAction {
  readonly kind: "read" | "edit" | "command";
  readonly target: string;
}

/** What a run reports, in the same words for every tool. */
export type RunEvent =
  | {
      readonly type: "session.started";
      readonly session: string;
      readonly model?: string;
      readonly billing?: RunBilling;
    }
  | { readonly type: "message"; readonly text: string }
  | {
      readonly type: "tool.started";
      readonly id: string;
      readonly name: string;
      /** What the call does to the machine, when the tool names it (a read, a change, a command). */
      readonly action?: ToolAction;
    }
  | { readonly type: "tool.completed"; readonly id: string; readonly ok: boolean }
  | { readonly type: "permission.denied"; readonly tool: string }
  | { readonly type: "usage"; readonly usage: RunUsage }
  | { readonly type: "limit"; readonly status: string }
  | {
      readonly type: "turn.completed";
      readonly ok: boolean;
      readonly session?: string;
      /** The agent's last message. */
      readonly text?: string;
      readonly usage?: RunUsage;
      /** The cost in US dollars, real or (for a subscription) the equivalent. */
      readonly costUsd?: number;
      readonly durationMs?: number;
      /** Why the turn failed, in a short code, when it did. */
      readonly failure?: string;
    }
  | { readonly type: "error"; readonly code: string; readonly message: string };

/**
 * How a run ended, judged by the process core and not by the exit code alone:
 * - `completed`: a turn ended well and the process exited 0;
 * - `failed`: the tool said it failed, or exited non-zero, or exited 0 without ever ending a turn
 *   (a failure disguised as success);
 * - `stopped`: the bridge stopped it;
 * - `timeout`: it ran past its allowed duration and was stopped;
 * - `not_started`: the program could not be started.
 */
export type RunOutcome = "completed" | "failed" | "stopped" | "timeout" | "not_started";

export interface RunResult {
  readonly outcome: RunOutcome;
  /** The process exit code; null when it was ended by a signal or never started. */
  readonly exitCode: number | null;
  readonly session?: string;
  /** The agent's last message, when the turn ended. */
  readonly text?: string;
  readonly usage?: RunUsage;
  readonly costUsd?: number;
  readonly billing?: RunBilling;
  /** How many actions the tool refused for lack of permission. */
  readonly denied: number;
  /** The names of the tools whose actions were refused (distinct, at most five, short codes only). */
  readonly deniedTools: readonly string[];
  /** A short code when the run did not complete well (`no_result`, `exit_1`, `tool_error`, ...). */
  readonly failure?: string;
  readonly durationMs: number;
}

/** A started run: its events as they come, a way to stop it, and its end. */
export interface ToolRun {
  /** The operating-system process id, once started. */
  readonly pid: number | undefined;
  /** Receives every event, in order, until the run ends. Returns a function that stops listening. */
  onEvent(listener: (event: RunEvent) => void): () => void;
  /** Stops the process and everything it started. Resolves when nothing is left running. */
  stop(): Promise<void>;
  /** Resolves, never rejects, when the process has ended and the last line was read. */
  readonly done: Promise<RunResult>;
}

/** The program to start: an executable and the arguments that come before the translator's. */
export interface Launcher {
  readonly file: string;
  readonly prefixArgs: readonly string[];
  /** True when the arguments go through `cmd` and must be written verbatim (Windows scripts). */
  readonly verbatim?: boolean;
}

/** What a translator decides to start. */
export interface LaunchPlan {
  readonly args: readonly string[];
  /**
   * The text of a settings file the tool is given for this launch (`--settings <path>`): the core
   * writes it to a file the user alone can read and removes it when the launch ends.
   */
  readonly settings?: string;
}

/**
 * The only tool-specific part: how to start the official program and how to read its lines. Pure:
 * it holds the state of one run in the object `begin` returns and nothing else.
 */
export interface ToolTranslator {
  readonly tool: RunToolId;
  readonly capabilities: ToolCapabilities;
  /** The arguments of the non-interactive command; throws `RunRequestInvalid` for a request it refuses. */
  plan(request: RunRequest): LaunchPlan;
  /** A fresh reader for one run's lines. */
  begin(): LineTranslator;
}

export interface LineTranslator {
  /** The events one parsed JSON line stands for (none for a line that carries nothing to report). */
  line(value: unknown): readonly RunEvent[];
}

/** The request asks for something the adapter refuses; nothing was started. */
export class RunRequestInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunRequestInvalid";
  }
}

/** The contract the bridge drives. */
export interface ToolAdapter {
  readonly tool: RunToolId;
  readonly capabilities: ToolCapabilities;
  /** Starts a run; throws `RunRequestInvalid` before starting anything for a request it refuses. */
  start(request: RunRequest): ToolRun;
}
