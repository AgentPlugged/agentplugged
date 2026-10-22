import { isAllowableCommand, type RefusalReason, refusalReason } from "./command-allow.js";
import {
  type LaunchPlan,
  type LineTranslator,
  type PermissionPlan,
  type RunBilling,
  type RunEvent,
  type RunRequest,
  RunRequestInvalid,
  type RunUsage,
  type ToolAction,
  type ToolCapabilities,
  type ToolTranslator,
} from "./contract.js";
import { AGENT_NAME } from "./json.js";

/**
 * Claude Code in its non-interactive mode: `claude -p` with a structured output stream. The
 * official program is started as it is installed; nothing of it is modified. The prompt travels on
 * the standard input. Permissions are decided before the start (`--permission-prompts none`: an
 * action outside the plan is refused, never asked), and no level bypasses the tool's checks.
 */

const CAPABILITIES: ToolCapabilities = {
  reportsUsage: true,
  reportsCost: true,
  interceptsPermissions: false,
  canResume: true,
  nativePause: false,
  subAgents: true,
  liveInput: true,
  namedSessions: true,
  subAgentUsage: true,
  reportsContext: true,
  streamsText: true,
  keepsWarm: true,
  isolates: true,
  enforcesLimits: true,
  refusalsLive: true,
  interrupts: true,
};

const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;
/** A command prefix: words, paths and options only; nothing the tool's rule syntax could read as a pattern. */
const COMMAND_PATTERN = /^(?:[A-Za-z0-9][A-Za-z0-9._/ -]{0,98}[A-Za-z0-9]|[A-Za-z0-9])$/;
/**
 * What an agent never reads, whatever the project's own settings say: the tool reads outside its
 * working folder by default, and the sign-in of the creator's tools, keys and secret files must
 * stay unread. (The project's settings add the creator's own list; this is the floor.)
 */
const NEVER_READ = [
  "Read(~/.ssh/**)",
  "Read(~/.aws/**)",
  "Read(~/.claude/.credentials.json)",
  "Read(~/.codex/auth.json)",
  "Read(~/.gemini/**)",
  "Read(//**/.env)",
  "Read(//**/.env.*)",
  "Read(//**/*.pem)",
  "Read(//**/id_rsa*)",
  "Read(//**/id_ed25519*)",
] as const;

/** The name of an MCP server: letters, digits, dashes and underscores. */
const MCP_SERVER_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** The tools that run commands: on Windows the tool offers a second one. */
const COMMAND_TOOLS = ["Bash", "PowerShell"] as const;
type CommandShell = NonNullable<RunRequest["shell"]>;
/** The command tool a run keeps, by the shell it was given. */
const SHELL_TOOL: Readonly<Record<CommandShell, (typeof COMMAND_TOOLS)[number]>> = {
  bash: "Bash",
  powershell: "PowerShell",
};
/** The command tool a run cuts, by the shell it keeps. */
const CUT_TOOL: Readonly<Record<CommandShell, (typeof COMMAND_TOOLS)[number]>> = {
  bash: "PowerShell",
  powershell: "Bash",
};

function shellOf(request: RunRequest): CommandShell | undefined {
  const shell: unknown = request.shell;
  if (shell === undefined) return undefined;
  if (shell !== "bash" && shell !== "powershell") {
    throw new RunRequestInvalid("shell: unknown shell");
  }
  return shell;
}

function commandRules(
  commands: readonly string[] | undefined,
  what: string,
  shell: CommandShell | undefined,
): string[] {
  const rules: string[] = [];
  for (const command of commands ?? []) {
    const trimmed = command.trim();
    if (!COMMAND_PATTERN.test(trimmed)) {
      throw new RunRequestInvalid(
        `${what}: "${command.slice(0, 40)}" is not a plain command prefix`,
      );
    }
    for (const tool of shell === undefined ? COMMAND_TOOLS : [SHELL_TOOL[shell]]) {
      rules.push(`${tool}(${trimmed}:*)`);
    }
  }
  return rules;
}

function mcpRules(servers: readonly string[] | undefined): string[] {
  const rules: string[] = [];
  for (const server of servers ?? []) {
    if (!MCP_SERVER_PATTERN.test(server)) {
      throw new RunRequestInvalid(`allowMcpServers: "${server.slice(0, 40)}" is not a server name`);
    }
    rules.push(`mcp__${server}`);
  }
  return rules;
}

/** A command rule of the tool's own syntax: Bash(npm test*), PowerShell(git status:*). */
const COMMAND_RULE = /^(?:Bash|PowerShell)\([^()\r\n"`$;|&<>]{1,200}\)$/;
/** A refusal: a tool, or a tool and what it is refused. */
const DENY_RULE = /^[A-Za-z][A-Za-z0-9_]{0,60}(?:\([^\r\n]{1,250}\))?$/;

function projectRules(rules: PermissionPlan["projectRules"]): { allow: string[]; deny: string[] } {
  if (rules === undefined) return { allow: [], deny: [] };
  // A rule that is not for running a command is left out, not trusted: the project file is data.
  const allow = rules.allow.filter((rule) => COMMAND_RULE.test(rule));
  const deny = rules.deny.filter((rule) => DENY_RULE.test(rule));
  return { allow: [...new Set(allow)], deny: [...new Set(deny)] };
}

function rulesOf(
  permissions: PermissionPlan,
  shell: CommandShell | undefined,
): {
  allow: string[];
  deny: string[];
  mode: string;
  project: { allow: string[]; deny: string[] };
} {
  const level: unknown = permissions.level;
  if (level !== "read" && level !== "edit") {
    throw new RunRequestInvalid("permissions: unknown level");
  }
  const project = projectRules(permissions.projectRules);
  return {
    mode: level === "edit" ? "acceptEdits" : "dontAsk",
    // No bare tool name is allowed: it would reach every path of the machine. The mode alone lets
    // the agent read, or edit, inside its working folder.
    allow: [
      ...mcpRules(permissions.allowMcpServers),
      ...commandRules(permissions.allowCommands, "allowCommands", shell),
    ],
    deny: [
      ...NEVER_READ,
      ...commandRules(permissions.denyCommands, "denyCommands", shell),
      // The shell the run does not keep is cut whole: the agent never sees it, so no command goes
      // through a syntax the plan's rules were not written for.
      ...(shell === undefined ? [] : [CUT_TOOL[shell]]),
    ],
    project,
  };
}

/**
 * The tool that launches a sub-agent. It is allowed by its bare name because it takes no path or
 * command: what the sub-agents may do is still decided by the plan's mode and rules, which they
 * share with the session that launched them.
 */
const AGENT_TOOL = "Agent";
/** The name of the agent definition the session runs as when some refusals are its own. */
const MAIN_AGENT_NAME = "bridge-main";

/**
 * The kinds of sub-agent the tool has of its own, and the catch-all some briefs name: none is an
 * agent of the product's team, so a cost could not be attributed to anyone.
 */
const GENERIC_SUBAGENTS: ReadonlySet<string> = new Set([
  "claude",
  "general-purpose",
  "explore",
  "plan",
  "statusline-setup",
  "claude-code-guide",
]);
const OWN_DENY_RULE = /^[A-Za-z][A-Za-z0-9_-]{0,80}(?:\([A-Za-z0-9_.-]{1,60}\))?$/;

/**
 * What a session that launches sub-agents needs on top of its plan: the right to use the agent
 * tool and, for the refusals that are its own (`mainSessionDeny`), a definition of the session as
 * an agent. The tool applies an agent's own refusals to that agent only, not to the sub-agents
 * it launches, which a refusal on the command line or in a settings file would reach as well.
 */
function subAgentPlan(request: RunRequest): { allow: string[]; args: string[] } {
  const sub = request.permissions.subAgents;
  if (sub === undefined) return { allow: [], args: [] };
  if (request.permissions.noTools === true) {
    throw new RunRequestInvalid("subAgents: not with a run that has no tool");
  }
  const own = [...new Set(sub.mainSessionDeny ?? [])];
  for (const rule of own) {
    // Stricter than a project rule: these travel on the command line, so a tool name or a tool
    // and one plain word, nothing a shell could read.
    if (!OWN_DENY_RULE.test(rule)) throw new RunRequestInvalid("subAgents: not a refusal rule");
  }
  if (own.length === 0) return { allow: [AGENT_TOOL], args: [] };
  const definition = {
    [MAIN_AGENT_NAME]: {
      description: "The session the bridge runs for the creator.",
      prompt: "Follow the user's message. Your role is given in the message itself.",
      disallowedTools: own,
    },
  };
  return {
    allow: [AGENT_TOOL],
    args: ["--agents", JSON.stringify(definition), "--agent", MAIN_AGENT_NAME],
  };
}

/** The folders of settings an isolated run reads: the product's own, never the creator's. */
const ISOLATED_SETTING_SOURCES = "project,local";
/** Turned off for an isolated run: the tool's own memory of the folder, kept in the creator's home. */
const ISOLATED_ENV = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } as const;

/** The most a ceiling may be set to: a larger number is a mistake, not a ceiling. */
const LIMIT_MAX = { turns: 10_000, concurrent: 64, depth: 8 } as const;

function limit(value: number | undefined, name: string, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new RunRequestInvalid(`limits: ${name} is not a whole number between 1 and ${max}`);
  }
  return value;
}

/**
 * The ceilings of a launch, as the tool takes them: the number of turns on the command line, the
 * sub-agent ceilings in its environment. A run that reaches the turns ceiling ends with the tool's
 * own named failure, which the run reports as it is.
 */
function limitsPlan(limits: RunRequest["limits"]): {
  args: string[];
  env: Record<string, string>;
} {
  const args: string[] = [];
  const env: Record<string, string> = {};
  if (limits === undefined) return { args, env };
  const turns = limit(limits.maxTurns, "maxTurns", LIMIT_MAX.turns);
  if (turns !== undefined) args.push("--max-turns", String(turns));
  const concurrent = limit(
    limits.maxConcurrentSubAgents,
    "maxConcurrentSubAgents",
    LIMIT_MAX.concurrent,
  );
  if (concurrent !== undefined) env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = String(concurrent);
  const depth = limit(limits.maxSubAgentDepth, "maxSubAgentDepth", LIMIT_MAX.depth);
  if (depth !== undefined) env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = String(depth);
  return { args, env };
}

function plan(request: RunRequest): LaunchPlan {
  const shell = shellOf(request);
  const { allow, deny, mode, project } = rulesOf(request.permissions, shell);
  if (shell !== undefined) {
    // A rule for the shell that is cut would never apply: it is not carried.
    const cut = `${CUT_TOOL[shell]}(`;
    project.allow = project.allow.filter((rule) => !rule.startsWith(cut));
  }
  const sub = subAgentPlan(request);
  allow.push(...sub.allow);
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-prompts",
    "none",
    "--permission-mode",
    mode,
  ];
  if (allow.length > 0) args.push("--allowedTools", ...allow);
  args.push("--disallowedTools", ...deny);
  if (request.permissions.noTools === true) args.push("--tools", "", "--strict-mcp-config");
  args.push(...sub.args);
  // Messages arrive as lines of JSON on the input, which stays open for further ones.
  if (request.liveInput === true) args.push("--input-format", "stream-json");
  // The agent's text comes in pieces as it is written, before the whole message.
  if (request.partialText === true) args.push("--include-partial-messages");
  if (request.model !== undefined) {
    if (!MODEL_PATTERN.test(request.model)) throw new RunRequestInvalid("model: not a model name");
    args.push("--model", request.model);
  }
  if (request.resume !== undefined) {
    if (!SESSION_PATTERN.test(request.resume))
      throw new RunRequestInvalid("resume: not a session id");
    args.push("--resume", request.resume);
  }
  if (request.sessionId !== undefined) {
    if (request.resume !== undefined) {
      throw new RunRequestInvalid("sessionId: a session is resumed or named, not both");
    }
    // Claude Code takes a UUID for a new session.
    if (!SESSION_UUID.test(request.sessionId)) throw new RunRequestInvalid("sessionId: not a UUID");
    args.push("--session-id", request.sessionId);
  }
  // A name for the session list of the tool (`/resume`): one line, nothing the shell could read.
  if (request.sessionName !== undefined && request.resume === undefined) {
    const name = request.sessionName
      .replace(/\p{Cc}+/gu, " ")
      .trim()
      .slice(0, 120);
    if (name !== "") args.push("--name", name);
  }
  if (request.persistSession === false) args.push("--no-session-persistence");
  if (request.maxBudgetUsd !== undefined) {
    if (!Number.isFinite(request.maxBudgetUsd) || request.maxBudgetUsd <= 0) {
      throw new RunRequestInvalid("maxBudgetUsd: not a positive amount");
    }
    args.push("--max-budget-usd", String(request.maxBudgetUsd));
  }
  // The product's own rules go in a settings file: there can be more of them than a command line
  // holds. The floor of refusals above stays on the command line, whatever the file says.
  const mcp = mcpPlan(request);
  if (mcp !== undefined) args.push(...mcp.args);
  const limits = limitsPlan(request.limits);
  args.push(...limits.args);
  // The product's own context only: the settings of its project, none of the creator's own.
  const isolated = request.isolated === true;
  if (isolated) args.push("--setting-sources", ISOLATED_SETTING_SOURCES);
  const settings =
    project.allow.length === 0 && project.deny.length === 0
      ? undefined
      : JSON.stringify({ permissions: { allow: project.allow, deny: project.deny } });
  const env = {
    ...(mcp?.env ?? {}),
    ...limits.env,
    ...(isolated ? ISOLATED_ENV : {}),
  };
  return {
    args,
    ...(settings === undefined ? {} : { settings }),
    ...(Object.keys(env).length === 0 ? {} : { env }),
  };
}

/** The longest a first turn is asked to wait for an MCP server, in milliseconds. */
const MCP_WAIT_MAX_MS = 120_000;

/**
 * The servers given on the launch: `--mcp-config` (and `--strict-mcp-config` to leave out every
 * other one), and the variables that make the first turn wait for a server that is still starting
 * instead of answering without its tools.
 */
function mcpPlan(
  request: RunRequest,
): { args: string[]; env?: Record<string, string> } | undefined {
  const mcp = request.mcp;
  if (mcp === undefined || request.permissions.noTools === true) return undefined;
  const eager = new Set(mcp.eager ?? []);
  const timeout = mcp.serverTimeoutMs;
  if (timeout !== undefined && (!Number.isFinite(timeout) || Math.round(timeout) < 1)) {
    throw new RunRequestInvalid("mcp: serverTimeoutMs is not a positive duration");
  }
  const servers: Record<string, unknown> = {};
  for (const [name, launch] of Object.entries(mcp.servers)) {
    if (!MCP_SERVER_PATTERN.test(name)) {
      throw new RunRequestInvalid(`mcp: "${name.slice(0, 40)}" is not a server name`);
    }
    servers[name] = {
      type: "stdio",
      command: launch.command,
      args: [...launch.args],
      ...(eager.has(name) ? { alwaysLoad: true } : {}),
      ...(timeout === undefined ? {} : { timeout: Math.min(Math.round(timeout), MCP_WAIT_MAX_MS) }),
    };
  }
  for (const name of eager) {
    if (!Object.hasOwn(servers, name)) {
      throw new RunRequestInvalid(`mcp: eager server "${name.slice(0, 40)}" is not given`);
    }
  }
  if (Object.keys(servers).length === 0) return undefined;
  const args = ["--mcp-config", JSON.stringify({ mcpServers: servers })];
  if (mcp.only === true) args.push("--strict-mcp-config");
  const wait = mcp.startupWaitMs;
  if (wait === undefined) return { args };
  if (!Number.isFinite(wait) || wait <= 0) {
    throw new RunRequestInvalid("mcp: startupWaitMs is not a positive duration");
  }
  const ms = String(Math.min(Math.round(wait), MCP_WAIT_MAX_MS));
  return {
    args,
    env: {
      CLAUDE_CODE_MCP_STARTUP_WAIT_MS: ms,
      MCP_TIMEOUT: ms,
      // The servers the agent needs at once are waited for before its first turn.
      ...(eager.size === 0
        ? {}
        : {
            CLAUDE_CODE_MCP_PREWAIT_SERVERS: [...eager].join(","),
            CLAUDE_CODE_MCP_PREWAIT_SERVERS_MS: ms,
          }),
    },
  };
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** Everything the model read counts as input, cached or not; the cache split stays visible. */
function usageOf(raw: unknown): RunUsage | undefined {
  if (!isObject(raw)) return undefined;
  const input = num(raw.input_tokens);
  const cacheRead = num(raw.cache_read_input_tokens);
  const cacheWrite = num(raw.cache_creation_input_tokens);
  const output = num(raw.output_tokens);
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined
  ) {
    return undefined;
  }
  return {
    tokensIn: (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0),
    ...(output === undefined ? {} : { tokensOut: output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}

function sum(parts: Iterable<RunUsage>): RunUsage {
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const part of parts) {
    tokensIn += part.tokensIn ?? 0;
    tokensOut += part.tokensOut ?? 0;
    cacheRead += part.cacheRead ?? 0;
    cacheWrite += part.cacheWrite ?? 0;
  }
  return { tokensIn, tokensOut, cacheRead, cacheWrite };
}

/**
 * The tools of Claude Code that read a file, change a file or run a command, and the field of
 * their input that names the target. Any other tool (searches, the web, MCP tools) has no action:
 * only its name is told.
 */
const READ_TOOLS: Readonly<Record<string, string>> = { Read: "file_path" };
const EDIT_TOOLS: Readonly<Record<string, string>> = {
  Edit: "file_path",
  MultiEdit: "file_path",
  Write: "file_path",
  NotebookEdit: "notebook_path",
};
const COMMAND_RUN_TOOLS: Readonly<Record<string, string>> = {
  Bash: "command",
  PowerShell: "command",
};

function actionOf(name: string, input: unknown): ToolAction | undefined {
  if (!isObject(input)) return undefined;
  const pick = (table: Readonly<Record<string, string>>): string | undefined => {
    const field = Object.hasOwn(table, name) ? table[name] : undefined;
    return field === undefined ? undefined : str(input[field]);
  };
  const read = pick(READ_TOOLS);
  if (read !== undefined) return { kind: "read", target: read };
  const edit = pick(EDIT_TOOLS);
  if (edit !== undefined) return { kind: "edit", target: edit };
  const command = pick(COMMAND_RUN_TOOLS);
  return command === undefined ? undefined : { kind: "command", target: command };
}

/** The most tool calls kept at once to name a refusal; the oldest go first. */
const CALLS_KEPT = 400;
/** What the identifier of an interruption request starts with, to know its answer. */
const INTERRUPT_REQUEST_PREFIX = "ap-interrupt-";

/** A tool's rate limit that is neither open nor merely close to its end is told. */
const OPEN_LIMITS = new Set(["allowed", "allowed_warning"]);

/**
 * The prefix of a refused command that the creator may allow: its first one or two words when
 * they are plain (`pnpm test`, `git status`), else nothing. A refused command is never allowed as
 * a whole line.
 */
function refusedCommand(
  tool: string | undefined,
  input: unknown,
): { readonly command?: string; readonly why?: RefusalReason } {
  if (tool === undefined || !isObject(input)) return {};
  if (!(COMMAND_TOOLS as readonly string[]).includes(tool)) return {};
  const line = str(input.command);
  if (line === undefined) return {};
  const words = line.trim().split(/\s+/u);
  const first = words[0] ?? "";
  // A second word that is a sub-command, not an option, a path or a value.
  const second = words[1];
  const prefix =
    second !== undefined && /^[a-z][a-z0-9:_-]{0,30}$/u.test(second) && words.length <= 6
      ? `${first} ${second}`
      : first;
  if (isAllowableCommand(prefix)) return { command: prefix };
  const why = refusalReason(first, second);
  return why === undefined ? {} : { why };
}

class ClaudeLines implements LineTranslator {
  /** The latest usage of each answer of the model: an answer is repeated once per block. */
  readonly #answers = new Map<string, RunUsage>();
  /** What the model read at the latest answer of the agent's own conversation, and its model. */
  #mainTokens: number | undefined;
  #mainModel: string | undefined;
  #billing: RunBilling | undefined;
  /** The tasks the tool says run in the background (sub-agents it launched), by identifier. */
  #background = new Set<string>();
  /** The tasks that started as sub-agents, by identifier. */
  readonly #agentTasks = new Set<string>();
  /**
   * The tool calls seen so far (the agent's and its sub-agents'), by call identifier, until their
   * result comes: a refusal names the call, and the call holds what was asked and by whom.
   */
  readonly #calls = new Map<string, { name: string; input: unknown; agent?: string }>();
  /** The refusals already told while the turn went on: the final message does not tell them again. */
  readonly #denied = new Set<string>();
  /** The tool acknowledged an interruption that was asked: the turn's end is not a failure. */
  #interrupted = false;

  /** Nothing runs in the background: the tool only waits for what the caller writes next. */
  idle(): boolean {
    return this.#background.size === 0;
  }

  line(value: unknown): readonly RunEvent[] {
    if (!isObject(value)) return [];
    switch (value.type) {
      case "control_response":
        this.#control(value);
        return [];
      case "system":
        return this.#system(value);
      case "assistant":
        return [...this.#identity(value), ...this.#assistant(value)];
      case "user":
        return [...this.#identity(value), ...this.#user(value)];
      case "rate_limit_event":
        return this.#limit(value);
      case "stream_event":
        return this.#piece(value);
      case "result":
        return this.#result(value);
      default:
        return [];
    }
  }

  /**
   * The sub-agents the tool runs, from its own task messages: one when a task starts, one at each
   * measure of its progress (tokens and tool calls so far, the task's own clock) and one when it
   * ends. A task of another kind (a command left running in the background) is not a sub-agent.
   * The brief of the task is in the start message and is never read here.
   */
  #task(value: Json): RunEvent[] {
    const id = str(value.task_id);
    if (id === undefined || id.length > 128) return [];
    const kind = str(value.task_type);
    // Only a task that started as a sub-agent is told: the end of a command left running in the
    // background arrives in the same shape, without its kind.
    if (value.subtype === "task_started") {
      if (kind !== undefined && kind !== "local_agent") return [];
      this.#agentTasks.add(id);
    } else if (!this.#agentTasks.has(id) && kind !== "local_agent") {
      return [];
    }
    const type = str(value.subagent_type);
    const generic = type !== undefined && GENERIC_SUBAGENTS.has(type.toLowerCase());
    const name = generic ? undefined : type;
    const task = str(value.description);
    const identity = {
      ...(name !== undefined && AGENT_NAME.test(name) ? { name } : {}),
      ...(generic ? { generic: true as const } : {}),
      ...(task === undefined ? {} : { task: task.slice(0, 200) }),
    };
    if (value.subtype === "task_started") {
      return [{ type: "subagent.updated", id, state: "working", ...identity }];
    }
    const usage = isObject(value.usage) ? value.usage : undefined;
    const tokens = usage === undefined ? undefined : num(usage.total_tokens);
    const toolUses = usage === undefined ? undefined : num(usage.tool_uses);
    const durationMs = usage === undefined ? undefined : num(usage.duration_ms);
    const measure = {
      ...(tokens === undefined ? {} : { tokens: Math.round(tokens) }),
      ...(toolUses === undefined ? {} : { toolUses: Math.round(toolUses) }),
      ...(durationMs === undefined ? {} : { durationMs: Math.round(durationMs) }),
    };
    if (value.subtype === "task_progress") {
      // The description of a progress message is what the task does now: the task keeps its own.
      return [
        {
          type: "subagent.updated",
          id,
          state: "working",
          ...(identity.name === undefined ? {} : { name: identity.name }),
          ...(generic ? { generic: true as const } : {}),
          ...measure,
        },
      ];
    }
    const status = str(value.status);
    const state =
      status === "completed"
        ? "done"
        : status === "failed" || status === "error"
          ? "failed"
          : status === "stopped" || status === "killed" || status === "cancelled"
            ? "stopped"
            : undefined;
    if (state === undefined) return [];
    return [
      {
        type: "subagent.updated",
        id,
        state,
        ...(identity.name === undefined ? {} : { name: identity.name }),
        ...(generic ? { generic: true as const } : {}),
        ...measure,
      },
    ];
  }

  /**
   * A refusal told by the tool while the turn goes on, by the agent or by one of its sub-agents:
   * the tool, the command when there is one (its first words, never the line) and, for a
   * sub-agent, its real kind. The final message lists the same refusals again; they are not told twice.
   */
  #refusal(value: Json): RunEvent[] {
    const tool = str(value.tool_name);
    if (tool === undefined) return [];
    const id = str(value.tool_use_id);
    const call = id === undefined ? undefined : this.#calls.get(id);
    if (id !== undefined) this.#denied.add(id);
    const { command, why } = refusedCommand(tool, call?.input);
    return [
      {
        type: "permission.denied",
        tool,
        ...(command === undefined ? {} : { command }),
        ...(why === undefined ? {} : { why }),
        ...(call?.agent === undefined ? {} : { agent: call.agent }),
      },
    ];
  }

  #system(value: Json): RunEvent[] {
    if (
      value.subtype === "task_started" ||
      value.subtype === "task_progress" ||
      value.subtype === "task_notification"
    ) {
      return this.#task(value);
    }
    if (value.subtype === "background_tasks_changed") {
      // The tool tells the whole list each time it changes.
      const tasks = Array.isArray(value.tasks) ? value.tasks : [];
      this.#background = new Set(
        tasks.flatMap((task) =>
          isObject(task) && str(task.task_id) !== undefined ? [String(task.task_id)] : [],
        ),
      );
      return [];
    }
    if (value.subtype === "permission_denied") return this.#refusal(value);
    if (value.subtype !== "init") return [];
    // A new turn starts: an acknowledgement that came after its turn ended must not outlive it.
    this.#interrupted = false;
    const session = str(value.session_id);
    if (session === undefined) return [];
    // `none` means the program is signed in by the creator himself (a subscription); a key means usage billing.
    const source = str(value.apiKeySource);
    this.#billing = source === undefined ? undefined : source === "none" ? "subscription" : "usage";
    const model = str(value.model);
    return [
      {
        type: "session.started",
        session,
        ...(model === undefined ? {} : { model }),
        ...(this.#billing === undefined ? {} : { billing: this.#billing }),
      },
    ];
  }

  /**
   * A piece of text the model is writing, from the tool's partial messages. Only the agent's own
   * text is told: what a sub-agent writes carries the identifier of the call that launched it, and
   * thinking and tool inputs are not text.
   */
  #piece(value: Json): RunEvent[] {
    if (str(value.parent_tool_use_id) !== undefined) return [];
    const event = value.event;
    if (!isObject(event) || event.type !== "content_block_delta") return [];
    const delta = event.delta;
    if (!isObject(delta) || delta.type !== "text_delta") return [];
    const text = typeof delta.text === "string" && delta.text !== "" ? delta.text : undefined;
    return text === undefined ? [] : [{ type: "message.delta", text }];
  }

  #assistant(value: Json): RunEvent[] {
    const message = value.message;
    if (!isObject(message) || !Array.isArray(message.content)) return [];
    const events: RunEvent[] = [];
    // The lines of a sub-agent carry the identifier of the call that launched it: what it says and
    // the tools it calls are never the agent's own words (only its tokens are counted).
    const own = str(value.parent_tool_use_id) === undefined;
    this.#note(value, message.content);
    for (const block of own ? message.content : []) {
      if (!isObject(block)) continue;
      if (block.type === "text") {
        const text = str(block.text);
        if (text !== undefined) events.push({ type: "message", text });
      } else if (block.type === "tool_use") {
        const id = str(block.id);
        const name = str(block.name);
        if (id !== undefined && name !== undefined) {
          const action = actionOf(name, block.input);
          events.push({
            type: "tool.started",
            id,
            name,
            ...(action === undefined ? {} : { action }),
          });
        }
      }
    }
    const id = str(message.id);
    const usage = usageOf(message.usage);
    if (id !== undefined && usage !== undefined) {
      this.#answers.set(id, usage);
      events.push({ type: "usage", usage: sum(this.#answers.values()) });
    }
    this.#remember(value, message, usage);
    return events;
  }

  /**
   * Who a sub-agent is, from the lines it writes: each carries the identifier of the sub-agent and
   * the kind it was launched as, which the tool sets itself (the agent cannot say otherwise). A
   * sub-agent whose start was not told (a task message that did not come) is told from its first
   * line.
   */
  #identity(value: Json): RunEvent[] {
    const id = str(value.agent_id);
    const type = str(value.subagent_type);
    if (id === undefined || id.length > 128 || type === undefined) return [];
    if (this.#agentTasks.has(id)) return [];
    this.#agentTasks.add(id);
    const generic = GENERIC_SUBAGENTS.has(type.toLowerCase());
    const task = str(value.task_description);
    return [
      {
        type: "subagent.updated",
        id,
        state: "working",
        ...(!generic && AGENT_NAME.test(type) ? { name: type } : {}),
        ...(generic ? { generic: true as const } : {}),
        ...(task === undefined ? {} : { task: task.slice(0, 200) }),
      },
    ];
  }

  /** Keeps the tool calls of a line, with the real kind of the sub-agent that made them. */
  #note(value: Json, content: readonly unknown[]): void {
    const kind = str(value.subagent_type);
    const agent =
      kind !== undefined && !GENERIC_SUBAGENTS.has(kind.toLowerCase()) && AGENT_NAME.test(kind)
        ? kind
        : undefined;
    for (const block of content) {
      if (!isObject(block) || block.type !== "tool_use") continue;
      const id = str(block.id);
      const name = str(block.name);
      if (id === undefined || name === undefined) continue;
      if (this.#calls.size >= CALLS_KEPT) {
        const oldest = this.#calls.keys().next().value;
        if (oldest !== undefined) this.#calls.delete(oldest);
      }
      this.#calls.set(id, {
        name,
        input: block.input,
        ...(agent === undefined ? {} : { agent }),
      });
    }
  }

  /** The tool's answer to a request written on its input: only an interruption is followed. */
  #control(value: Json): void {
    const response = value.response;
    if (!isObject(response) || response.subtype !== "success") return;
    const id = str(response.request_id);
    if (id !== undefined && id.startsWith(INTERRUPT_REQUEST_PREFIX)) this.#interrupted = true;
  }

  /**
   * Keeps what the model read at an answer of the agent's own conversation (the lines of its
   * sub-agents carry the identifier of the call that launched them and are left out). An answer
   * that read nothing (the tool's own error lines) says nothing about the conversation.
   */
  #remember(value: Json, message: Json, usage: RunUsage | undefined): void {
    if (str(value.parent_tool_use_id) !== undefined) return;
    const read = usage?.tokensIn;
    if (read === undefined || read <= 0) return;
    this.#mainTokens = read;
    this.#mainModel = str(message.model) ?? this.#mainModel;
  }

  /** The window of the agent's model, from the per-model report of the final message. */
  #windowOf(value: Json): number | undefined {
    const report = value.modelUsage;
    if (!isObject(report)) return undefined;
    const windows = Object.entries(report).flatMap(([model, entry]) => {
      const window = isObject(entry) ? num(entry.contextWindow) : undefined;
      return window === undefined || window <= 0 ? [] : [{ model, window }];
    });
    const own = this.#mainModel;
    const found =
      own === undefined
        ? undefined
        : windows.find(
            (one) => one.model === own || one.model.startsWith(own) || own.startsWith(one.model),
          );
    // Several models and none is the agent's: no window is guessed.
    return found?.window ?? (windows.length === 1 ? windows[0]?.window : undefined);
  }

  #user(value: Json): RunEvent[] {
    const message = value.message;
    if (!isObject(message) || !Array.isArray(message.content)) return [];
    // The results of a sub-agent's own tools are not the agent's.
    if (str(value.parent_tool_use_id) !== undefined) return [];
    const events: RunEvent[] = [];
    for (const block of message.content) {
      if (!isObject(block) || block.type !== "tool_result") continue;
      const id = str(block.tool_use_id);
      if (id !== undefined)
        events.push({ type: "tool.completed", id, ok: block.is_error !== true });
    }
    return events;
  }

  #limit(value: Json): RunEvent[] {
    const info = value.rate_limit_info;
    const status = isObject(info) ? str(info.status) : undefined;
    return status === undefined || OPEN_LIMITS.has(status) ? [] : [{ type: "limit", status }];
  }

  #result(value: Json): RunEvent[] {
    const events: RunEvent[] = [];
    const denials = Array.isArray(value.permission_denials) ? value.permission_denials : [];
    for (const denial of denials) {
      const told = isObject(denial) ? str(denial.tool_use_id) : undefined;
      // Already told when it happened.
      if (told !== undefined && this.#denied.has(told)) continue;
      const tool = isObject(denial) ? str(denial.tool_name) : undefined;
      const { command, why } = isObject(denial)
        ? refusedCommand(tool, denial.tool_input)
        : { command: undefined, why: undefined };
      events.push({
        type: "permission.denied",
        tool: tool ?? "unknown",
        ...(command === undefined ? {} : { command }),
        ...(why === undefined ? {} : { why }),
      });
    }
    const subtype = str(value.subtype) ?? "success";
    // A turn the creator's side ended on purpose (an interruption the tool acknowledged) is a
    // turn that ended, not one that failed.
    const reason = str(value.terminal_reason);
    const interrupted =
      this.#interrupted &&
      subtype !== "success" &&
      (subtype === "error_during_execution" || reason?.startsWith("aborted") === true);
    this.#interrupted = false;
    this.#denied.clear();
    // The calls of the turn are no longer needed to name a refusal.
    this.#calls.clear();
    const ok = interrupted || (value.is_error !== true && subtype === "success");
    const usage = usageOf(value.usage);
    const costUsd = num(value.total_cost_usd);
    const durationMs = num(value.duration_ms);
    const session = str(value.session_id);
    const text = typeof value.result === "string" ? value.result : undefined;
    // Only a short code of the tool's own vocabulary goes further, never free text.
    const failure = ok
      ? undefined
      : subtype !== "success" && /^[a-z0-9_]{1,40}$/.test(subtype)
        ? subtype
        : "tool_error";
    if (!ok) {
      events.push({
        type: "error",
        code: failure ?? "tool_error",
        message: (text ?? "the tool reported an error").slice(0, 300),
      });
    }
    const window = this.#windowOf(value);
    const tokens = this.#mainTokens;
    events.push({
      type: "turn.completed",
      ok,
      ...(session === undefined ? {} : { session }),
      ...(text === undefined ? {} : { text }),
      ...(usage === undefined ? {} : { usage }),
      ...(tokens === undefined
        ? {}
        : {
            context: {
              tokens,
              ...(window === undefined ? {} : { window }),
            },
          }),
      ...(costUsd === undefined ? {} : { costUsd }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(failure === undefined ? {} : { failure }),
      ...(interrupted ? { interrupted: true as const } : {}),
    });
    return events;
  }
}

export const claudeCodeTranslator: ToolTranslator = {
  tool: "claude-code",
  capabilities: CAPABILITIES,
  plan,
  begin: () => new ClaudeLines(),
  frame: (text) => JSON.stringify({ type: "user", message: { role: "user", content: text } }),
  interruptFrame: () =>
    JSON.stringify({
      type: "control_request",
      request_id: `${INTERRUPT_REQUEST_PREFIX}${++interruptCount}`,
      request: { subtype: "interrupt" },
    }),
};

let interruptCount = 0;
