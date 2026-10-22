/**
 * The contract between the bridge and the AI tools it drives. The bridge only ever talks to a
 * `ToolAdapter`; an adapter is a small, pure `ToolTranslator` (how to start the official program
 * and how to read its structured output) plus the shared process core (`startToolRun`), which
 * owns the process, the line-by-line JSON stream, the stop and the failure detection. A further
 * tool needs a translator and nothing else.
 */

/** The AI tools the bridge can drive. */
export type RunToolId = "claude-code" | "codex" | "antigravity" | "cursor" | "kimi";

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
  /**
   * The agent may launch sub-agents with the tool's own agent tool (the product's agents, written
   * for the tool by `sync`); a tool that cannot refuses the request. The sub-agents work under the
   * same plan: the same level, the same refusals, nothing more is allowed to them.
   *
   * `mainSessionDeny` lists refusals (tool rules) that hold for the agent's own session and not
   * for the sub-agents it launches: the tools the agent has no contract for, which his
   * sub-agents need to do their own work. Applied by running the agent's session as a defined
   * agent of the launch, never by a rule that would reach the sub-agents too.
   */
  readonly subAgents?: { readonly mainSessionDeny?: readonly string[] };
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
  /** A display name for a new session, shown in the tool's own list of sessions (Claude Code: `--name`). */
  readonly sessionName?: string;
  /** False: the tool keeps no trace of the session on the disk (it cannot be resumed). Default true. */
  readonly persistSession?: boolean;
  /** A spending ceiling in US dollars, for the tools that bill by usage. */
  readonly maxBudgetUsd?: number;
  /** The run is stopped after this long (default 30 minutes). */
  readonly maxDurationMs?: number;
  /**
   * Keeps the run open to further messages (`ToolRun.send`) while it works, for the tools that
   * can (`ToolCapabilities.liveInput`; any other refuses the request). The input is closed by the
   * adapter once the tool has answered every message and has nothing left running in the
   * background, so that a run that launches no sub-agent ends as it would without this option.
   */
  readonly liveInput?: boolean;
  /**
   * With `liveInput`: once every message is answered and nothing runs in the background, the
   * program is kept open this long (milliseconds) for a further message instead of being ended at
   * once, and the run tells it is waiting (`idle`). A message then costs no new program, no new
   * session opening and no new start of its servers. Only for a tool that can
   * (`ToolCapabilities.keepsWarm`); the waiting costs no token. The run's duration limit counts
   * the time it works, not the time it waits.
   */
  readonly keepWarmMs?: number;
  /**
   * The agent's own text is told as it is written (`message.delta`), in pieces, before the whole
   * message comes. Only for a tool that can (`ToolCapabilities.streamsText`); any other ignores it.
   */
  readonly partialText?: boolean;
  /**
   * The folder is the creator's own product, served by the bridge: a tool that asks the creator
   * to trust a folder before it starts that folder's MCP servers is told to trust this one, for
   * this run only. Absent: the tool keeps its own answer for the folder.
   */
  readonly trustFolder?: boolean;
  /**
   * The MCP servers the run is given, by name, each started as a program with its arguments (the
   * product's own server, started by its installed path). `only`: the tool is given these servers
   * and no other (the creator's personal servers and connectors stay out of the run and of its
   * sub-agents). `startupWaitMs`: how long the first turn waits for a server that is still
   * starting. A tool that cannot take servers on its launch ignores it.
   */
  readonly mcp?: McpPlan;
  /**
   * The one shell the agent's commands go through. On Windows the tool can offer two (a Unix-like
   * shell and PowerShell), each with its own rule syntax and its own way to be refused; the run
   * keeps one: `bash` cuts the PowerShell tool, `powershell` cuts the Unix-like one, and the
   * command rules of the plan are written for the one kept. Absent: the tool offers what it has.
   */
  readonly shell?: "bash" | "powershell";
  /**
   * True: the run works with the product's own context only (its project and local settings, its
   * agents, skills and servers) and none of the creator's personal one (user settings, plugins,
   * connectors, the tool's own memory of the folder). The tool's sign-in stays as it is. Only for a
   * tool that can (`ToolCapabilities.isolates`); any other ignores it.
   */
  readonly isolated?: boolean;
  /** Hard ceilings the program enforces itself, whatever the agent does; see `RunLimits`. */
  readonly limits?: RunLimits;
}

/**
 * Ceilings set on a launch, enforced by the tool and not by the agent's instructions. A run that
 * reaches `maxTurns` ends with a named failure (`error_max_turns`), never silently. A tool that
 * has no such option ignores them (`ToolCapabilities.enforcesLimits`).
 */
export interface RunLimits {
  /** The most turns (model answers followed by tool calls) the run may take. */
  readonly maxTurns?: number;
  /** The most sub-agents working at the same time. */
  readonly maxConcurrentSubAgents?: number;
  /** The deepest chain of sub-agents launching sub-agents (1: the agent's own sub-agents only). */
  readonly maxSubAgentDepth?: number;
}

/** The MCP servers a run is given; see `RunRequest.mcp`. */
export interface McpPlan {
  readonly servers: Readonly<
    Record<string, { readonly command: string; readonly args: readonly string[] }>
  >;
  readonly only?: boolean;
  readonly startupWaitMs?: number;
  /**
   * The servers whose tools the agent needs from its first turn: their tool descriptions are
   * loaded at once instead of being found by a search first (a turn saved), and the first turn
   * waits for them to be ready. Names of `servers`.
   */
  readonly eager?: readonly string[];
  /**
   * How long one server may take to start before the tool gives it up, in milliseconds (a server
   * that never answers is reported failed after this long, not after the tool's own default).
   */
  readonly serverTimeoutMs?: number;
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
  /** An agent run can launch sub-agents (`PermissionPlan.subAgents`). Absent: it cannot. */
  readonly subAgents?: boolean;
  /**
   * A message can be written to a run while it goes on (`RunRequest.liveInput`, `ToolRun.send`).
   * Absent: it cannot, and a message waits for the end of the run.
   */
  readonly liveInput?: boolean;
  /**
   * A new session can be given its identifier before the run starts (`RunRequest.sessionId`).
   * Absent: the tool names its sessions itself and the identifier is known once the run started.
   */
  readonly namedSessions?: boolean;
  /**
   * The tool reports, while a sub-agent works, how many tokens that sub-agent used so far
   * (`subagent.updated` with `tokens`). Absent: it does not, and a view says so.
   */
  readonly subAgentUsage?: boolean;
  /**
   * The tool reports, at the end of a turn, how many tokens the agent's own conversation made the
   * model read (`turn.completed` with `context`). Absent: it does not, and a view says so.
   */
  readonly reportsContext?: boolean;
  /** The tool can tell the agent's text in pieces as it is written (`RunRequest.partialText`). */
  readonly streamsText?: boolean;
  /** A run with `liveInput` can be kept open while it waits (`RunRequest.keepWarmMs`). */
  readonly keepsWarm?: boolean;
  /** The tool can be started without the creator's personal context (`RunRequest.isolated`). */
  readonly isolates?: boolean;
  /** The tool enforces the ceilings of `RunRequest.limits` itself. */
  readonly enforcesLimits?: boolean;
  /** The tool tells a refused action while the turn goes on, not only at its end. */
  readonly refusalsLive?: boolean;
  /**
   * The tool ends the turn in progress on request, keeping the session and the program
   * (`ToolRun.interrupt`). Absent: only stopping the program ends it.
   */
  readonly interrupts?: boolean;
}

/** The consumption of a run, cumulative since its start. Absent fields are unknown, not zero. */
export interface RunUsage {
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

/**
 * How heavy the conversation of the agent's own session was at its latest turn, as the tool
 * reported it: everything the model read at that turn (the sub-agents' turns are not counted).
 * Absent fields are unknown, never estimated.
 */
export interface RunContext {
  /** Tokens read at the agent's latest own turn. */
  readonly tokens: number;
  /** The window of the agent's model, when the tool announced it. */
  readonly window?: number;
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
      /**
       * A piece of the text the agent itself is writing (never a sub-agent's), in order, to be put
       * end to end. The whole message follows as a `message` once it is written.
       */
      readonly type: "message.delta";
      readonly text: string;
    }
  | {
      /**
       * Every message is answered and nothing runs in the background: the program waits for the
       * next message (only told for a run with `keepWarmMs`). Carries what the last turn reported.
       */
      readonly type: "idle";
      readonly ok: boolean;
      readonly session?: string;
      readonly context?: RunContext;
      /** The cost so far of the whole program, since it started. */
      readonly costUsd?: number;
    }
  | {
      readonly type: "tool.started";
      readonly id: string;
      readonly name: string;
      /** What the call does to the machine, when the tool names it (a read, a change, a command). */
      readonly action?: ToolAction;
    }
  | { readonly type: "tool.completed"; readonly id: string; readonly ok: boolean }
  | {
      readonly type: "permission.denied";
      readonly tool: string;
      /** For a refused command: its first words (a prefix the creator may allow), never the whole line. */
      readonly command?: string;
      /** For a refused command with no prefix to allow: why, as a stable code a view tells in words. */
      readonly why?: "runs_anything" | "git_folder" | "subcommand";
      /** For a refusal of a sub-agent's action: its kind, as the tool set it (an agent of the team). */
      readonly agent?: string;
    }
  | {
      /**
       * A sub-agent the agent launched: it works, or it ended. `id` is the tool's own identifier
       * of the task. `name` is the sub-agent's kind as the tool names it (a product agent's
       * identifier), `task` its short description. `tokens` and `toolUses` are what the tool
       * measured so far (cumulative; absent when it gave none), `durationMs` the tool's own clock
       * for the task. The brief handed to the sub-agent is never carried.
       */
      readonly type: "subagent.updated";
      readonly id: string;
      readonly state: "working" | "done" | "failed" | "stopped";
      readonly name?: string;
      /**
       * True when the tool launched a generic sub-agent (no agent of the product's team): `name`
       * is then absent, and a view says it is not named instead of showing the tool's word.
       */
      readonly generic?: true;
      readonly task?: string;
      readonly tokens?: number;
      readonly toolUses?: number;
      readonly durationMs?: number;
    }
  | { readonly type: "usage"; readonly usage: RunUsage }
  | { readonly type: "limit"; readonly status: string }
  | {
      readonly type: "turn.completed";
      readonly ok: boolean;
      readonly session?: string;
      /** The agent's last message. */
      readonly text?: string;
      readonly usage?: RunUsage;
      /** How heavy the agent's own conversation was at this turn, when the tool says. */
      readonly context?: RunContext;
      /** The cost in US dollars, real or (for a subscription) the equivalent. */
      readonly costUsd?: number;
      readonly durationMs?: number;
      /** Why the turn failed, in a short code, when it did. */
      readonly failure?: string;
      /** The turn ended because it was interrupted on request (`ToolRun.interrupt`): not a failure. */
      readonly interrupted?: true;
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
  /** How heavy the agent's own conversation was at its last turn, when the tool says. */
  readonly context?: RunContext;
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
  /**
   * Writes a further message to a run started with `liveInput`. True when the message was handed
   * to the running program; false when it cannot be (no live input, the input is already closed,
   * the program ended): the caller then keeps the message for the end of the run.
   */
  send?(text: string): boolean;
  /**
   * Asks the tool to end the turn in progress and wait for the next message, keeping the session
   * and the program (a run started with `liveInput`). True when the request was handed to the
   * running program; false when it cannot be (no live input, the program ended): the caller then
   * stops the run instead.
   */
  interrupt?(): boolean;
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
   * How the instruction reaches the program: `prompt` (default) writes it as is on the standard
   * input and closes it; `framed` writes it as one framed line (`ToolTranslator.frame`) and, unless
   * the run is live, closes the input after it; `none` writes nothing (the instruction is in the
   * arguments, for a program that takes it nowhere else).
   */
  readonly input?: "prompt" | "framed" | "none";
  /**
   * The text of a settings file the tool is given for this launch (`--settings <path>`): the core
   * writes it to a file the user alone can read and removes it when the launch ends.
   */
  readonly settings?: string;
  /**
   * The text of an agent definition file the tool is started with for this launch (the session's
   * tool list and refusals, for a tool that takes them only from such a file): the core writes it
   * like `settings` and passes its flag and its path after the translator's arguments.
   */
  readonly agentFile?: { readonly text: string; readonly flag: string };
  /** Variables added to the program's environment for this launch only (never a secret). */
  readonly env?: Readonly<Record<string, string>>;
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
  /** How a message is written on the input of a run started with `liveInput` (one line). */
  frame?(text: string): string;
  /**
   * How the end of the turn in progress is asked for on the input of a run started with
   * `liveInput` (one line); the program and the session stay. Absent: the tool cannot.
   */
  interruptFrame?(): string;
  /**
   * For a tool that tells its failures only on its error output and ends with a non-zero code and
   * no turn: a short code for the cause, from the end of that output. Absent or undefined: the
   * generic code of the exit.
   */
  exitFailure?(errorOutput: string, exitCode: number | null): string | undefined;
}

export interface LineTranslator {
  /** The events one parsed JSON line stands for (none for a line that carries nothing to report). */
  line(value: unknown): readonly RunEvent[];
  /**
   * True when the tool waits for input with nothing left running in the background, so that a
   * live input may be closed after an answer. Absent: a live input is never closed by the reader.
   */
  idle?(): boolean;
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
