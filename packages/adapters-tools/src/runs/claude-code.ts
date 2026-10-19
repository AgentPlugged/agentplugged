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

function commandRules(commands: readonly string[] | undefined, what: string): string[] {
  const rules: string[] = [];
  for (const command of commands ?? []) {
    const trimmed = command.trim();
    if (!COMMAND_PATTERN.test(trimmed)) {
      throw new RunRequestInvalid(
        `${what}: "${command.slice(0, 40)}" is not a plain command prefix`,
      );
    }
    for (const tool of COMMAND_TOOLS) rules.push(`${tool}(${trimmed}:*)`);
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

function rulesOf(permissions: PermissionPlan): {
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
      ...commandRules(permissions.allowCommands, "allowCommands"),
    ],
    deny: [...NEVER_READ, ...commandRules(permissions.denyCommands, "denyCommands")],
    project,
  };
}

function plan(request: RunRequest): LaunchPlan {
  const { allow, deny, mode, project } = rulesOf(request.permissions);
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
  if (request.persistSession === false) args.push("--no-session-persistence");
  if (request.maxBudgetUsd !== undefined) {
    if (!Number.isFinite(request.maxBudgetUsd) || request.maxBudgetUsd <= 0) {
      throw new RunRequestInvalid("maxBudgetUsd: not a positive amount");
    }
    args.push("--max-budget-usd", String(request.maxBudgetUsd));
  }
  // The product's own rules go in a settings file: there can be more of them than a command line
  // holds. The floor of refusals above stays on the command line, whatever the file says.
  const settings =
    project.allow.length === 0 && project.deny.length === 0
      ? undefined
      : JSON.stringify({ permissions: { allow: project.allow, deny: project.deny } });
  return { args, ...(settings === undefined ? {} : { settings }) };
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

/** A tool's rate limit that is neither open nor merely close to its end is told. */
const OPEN_LIMITS = new Set(["allowed", "allowed_warning"]);

class ClaudeLines implements LineTranslator {
  /** The latest usage of each answer of the model: an answer is repeated once per block. */
  readonly #answers = new Map<string, RunUsage>();
  #billing: RunBilling | undefined;

  line(value: unknown): readonly RunEvent[] {
    if (!isObject(value)) return [];
    switch (value.type) {
      case "system":
        return this.#system(value);
      case "assistant":
        return this.#assistant(value);
      case "user":
        return this.#user(value);
      case "rate_limit_event":
        return this.#limit(value);
      case "result":
        return this.#result(value);
      default:
        return [];
    }
  }

  #system(value: Json): RunEvent[] {
    if (value.subtype !== "init") return [];
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

  #assistant(value: Json): RunEvent[] {
    const message = value.message;
    if (!isObject(message) || !Array.isArray(message.content)) return [];
    const events: RunEvent[] = [];
    for (const block of message.content) {
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
    return events;
  }

  #user(value: Json): RunEvent[] {
    const message = value.message;
    if (!isObject(message) || !Array.isArray(message.content)) return [];
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
      const tool = isObject(denial) ? str(denial.tool_name) : undefined;
      events.push({ type: "permission.denied", tool: tool ?? "unknown" });
    }
    const subtype = str(value.subtype) ?? "success";
    const ok = value.is_error !== true && subtype === "success";
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
    events.push({
      type: "turn.completed",
      ok,
      ...(session === undefined ? {} : { session }),
      ...(text === undefined ? {} : { text }),
      ...(usage === undefined ? {} : { usage }),
      ...(costUsd === undefined ? {} : { costUsd }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(failure === undefined ? {} : { failure }),
    });
    return events;
  }
}

export const claudeCodeTranslator: ToolTranslator = {
  tool: "claude-code",
  capabilities: CAPABILITIES,
  plan,
  begin: () => new ClaudeLines(),
};
