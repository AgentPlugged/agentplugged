import {
  type LaunchPlan,
  type LineTranslator,
  type RunEvent,
  type RunRequest,
  RunRequestInvalid,
  type ToolAction,
  type ToolCapabilities,
  type ToolTranslator,
} from "./contract.js";
import {
  AGENT_NAME,
  failureCode,
  isObject,
  type Json,
  MODEL_PATTERN,
  SESSION_PATTERN,
  str,
} from "./json.js";

/**
 * Kimi Code CLI in its non-interactive mode: `kimi -p <instruction> --output-format stream-json`,
 * read from its public source (`apps/kimi-code/src/cli/prompt-render.ts` and `v2/run-v2-print.ts`
 * of the open source repository) and its documentation. The stream is one JSON object per line in
 * the shape of a chat transcript, not a list of typed events:
 *
 * - `{"role":"meta","type":"system.version"}` first;
 * - `{"role":"assistant","content":…,"tool_calls":[{"id","function":{"name","arguments"}}]}`: one
 *   line per model step (the text is not streamed in pieces), the calls of the step with it;
 * - `{"role":"tool","tool_call_id","content"}`: the result of a call, as text (the tool's own
 *   error flag is not written, so a failed call is told only when its text says so);
 * - `{"role":"meta","type":"turn.step.retrying",…}` when the provider is retried;
 * - `{"role":"meta","type":"session.resume_hint","session_id"}` last, and only when the run ended
 *   well: it is the end of the turn and the only place the session identifier appears.
 *
 * A failure is told on the error output (`error: failed to run prompt: …`) with exit code 1, and
 * nothing in the stream: the cause is read from that text by `exitFailure`. A session that another
 * client holds is told as a JSON line of type `error` with exit code 4.
 *
 * The non-interactive mode approves every tool call and cannot be given rules of commands by the
 * command line, so the brake of a run is the definition of its main agent: the tools it is given
 * (and the MCP servers it may call) are written as an agent file for the launch. That file is
 * bound to the session when it is created, and a resumed session restores it, so `--agent-file`
 * is never passed together with `--session`. The shell is never among the tools.
 */

const CAPABILITIES: ToolCapabilities = {
  reportsUsage: false,
  reportsCost: false,
  interceptsPermissions: false,
  canResume: true,
  nativePause: false,
  subAgents: true,
};

/** What a command line holds on every platform, with room for the other arguments. */
const MAX_PROMPT_CHARS = 24_000;
/** A tool name or pattern as the agent file may carry it. */
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/;

/** The placeholder of the tool's own template that stands for its default system prompt. */
const BASE_PROMPT = "$" + "{base_prompt}";

const READ_TOOLS = ["Read", "Glob", "Grep"] as const;
const EDIT_TOOLS = ["Edit", "Write"] as const;

function agentFileText(tools: readonly string[], disallowed: readonly string[], agents: boolean) {
  const list = (items: readonly string[]) =>
    items.length === 0
      ? " []"
      : `\n${items.map((item) => `  - ${JSON.stringify(item)}`).join("\n")}`;
  return [
    "---",
    "name: agentplugged-run",
    "description: The main agent of a run started by the bridge",
    `tools:${list(tools)}`,
    ...(disallowed.length === 0 ? [] : [`disallowedTools:${list(disallowed)}`]),
    // No sub-agent but the ones of the product: the generic ones of the tool are left out.
    ...(agents ? ["subagents: []"] : []),
    "---",
    BASE_PROMPT,
    "",
  ].join("\n");
}

function plan(request: RunRequest): LaunchPlan {
  const { permissions } = request;
  const level: unknown = permissions.level;
  if (level !== "read" && level !== "edit") {
    throw new RunRequestInvalid("permissions: unknown level");
  }
  if (
    (permissions.allowCommands ?? []).length > 0 ||
    (permissions.denyCommands ?? []).length > 0 ||
    (permissions.projectRules?.allow.length ?? 0) > 0 ||
    (permissions.projectRules?.deny.length ?? 0) > 0
  ) {
    // The tool takes no rule of commands on its command line, and a run is never given the shell.
    throw new RunRequestInvalid(
      "commands: this tool takes no rule of commands at launch and is never given the shell",
    );
  }
  if (request.liveInput === true) {
    throw new RunRequestInvalid("liveInput: this tool cannot take messages while it runs");
  }
  if (request.sessionId !== undefined) {
    throw new RunRequestInvalid("sessionId: this tool names its sessions itself");
  }
  if (request.persistSession === false) {
    throw new RunRequestInvalid("persistSession: this tool always keeps its sessions");
  }
  if (request.maxBudgetUsd !== undefined) {
    throw new RunRequestInvalid("maxBudgetUsd: this tool reports no cost to stop at");
  }
  if (request.prompt.length > MAX_PROMPT_CHARS) {
    throw new RunRequestInvalid("prompt: too long for this tool's command line");
  }
  const args = [
    "-p",
    request.prompt.startsWith("-") || request.prompt.startsWith("/")
      ? ` ${request.prompt}`
      : request.prompt,
  ];
  args.push("--output-format", "stream-json");
  if (request.model !== undefined) {
    if (!MODEL_PATTERN.test(request.model)) throw new RunRequestInvalid("model: not a model name");
    args.push("--model", request.model);
  }
  const env = request.trustFolder === true ? { KIMI_CODE_TRUST_WORKSPACE: "1" } : undefined;
  if (request.resume !== undefined) {
    if (!SESSION_PATTERN.test(request.resume)) {
      throw new RunRequestInvalid("resume: not a session id");
    }
    // The agent bound to the session when it was created comes back with it.
    args.push("--session", request.resume);
    return { args, input: "none", ...(env === undefined ? {} : { env }) };
  }
  const servers = permissions.noTools === true ? [] : (permissions.allowMcpServers ?? []);
  for (const server of servers) {
    if (!SERVER_NAME.test(server))
      throw new RunRequestInvalid("allowMcpServers: not a server name");
  }
  const agents = permissions.subAgents !== undefined && permissions.noTools !== true;
  const tools =
    permissions.noTools === true
      ? []
      : [
          ...READ_TOOLS,
          ...(level === "edit" ? EDIT_TOOLS : []),
          ...(agents ? ["Agent"] : []),
          ...servers.map((server) => `mcp__${server}__*`),
        ];
  const disallowed = permissions.subAgents?.mainSessionDeny ?? [];
  for (const name of disallowed) {
    if (
      !/^(?:mcp__[A-Za-z0-9_-]{1,60}__[A-Za-z0-9_-]{1,80}|[A-Za-z][A-Za-z0-9_]{0,59})$/.test(name)
    ) {
      throw new RunRequestInvalid("mainSessionDeny: not a tool name");
    }
  }
  for (const name of tools) {
    if (!TOOL_NAME.test(name) && !/^mcp__[A-Za-z0-9_-]{1,60}__\*$/.test(name)) {
      throw new RunRequestInvalid("tools: not a tool name");
    }
  }
  return {
    args,
    input: "none",
    agentFile: { text: agentFileText(tools, disallowed, agents), flag: "--agent-file" },
    ...(env === undefined ? {} : { env }),
  };
}

/** The field of a tool call's arguments that names its target, by tool. */
function actionOf(name: string, args: unknown): ToolAction | undefined {
  if (!isObject(args)) return undefined;
  if (name === "Read" || name === "ReadMediaFile") {
    const path = str(args.path);
    return path === undefined ? undefined : { kind: "read", target: path };
  }
  if (name === "Edit" || name === "Write") {
    const path = str(args.path);
    return path === undefined ? undefined : { kind: "edit", target: path };
  }
  if (name === "Bash") {
    const command = str(args.command);
    return command === undefined ? undefined : { kind: "command", target: command };
  }
  return undefined;
}

/** The text of a message's content: a string, or the text parts of a list of parts. */
function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((part) =>
    isObject(part) && typeof part.text === "string" ? [part.text] : [],
  );
  return parts.length === 0 ? undefined : parts.join("");
}

function parseArguments(raw: unknown): unknown {
  if (isObject(raw)) return raw;
  if (typeof raw !== "string") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** The result texts the tool writes for a call that was refused, and for one it could not run. */
const REFUSED = /^Tool "[^"]{1,80}" was denied/;
const NOT_RUN = /^(?:Tool "[^"]{1,80}" (?:not found|is not available)|Invalid args for tool )/;
/** A hook's own line: `<Event> hook` or `<Event> hook blocked`, then a blank line and its text. */
const HOOK_LINE = /^[A-Za-z]{3,30} hook( blocked)?\n\n/;

class KimiLines implements LineTranslator {
  /** The name of each call that started, to tell a refusal under its tool. */
  readonly #names = new Map<string, string>();
  /** The sub-agents launched in the foreground: their call ends when they do. */
  readonly #foreground = new Set<string>();
  #lastText: string | undefined;

  line(value: unknown): readonly RunEvent[] {
    if (!isObject(value)) return [];
    if (value.role === "assistant") return this.#assistant(value);
    if (value.role === "tool") return this.#tool(value);
    if (value.role === "meta") return this.#meta(value);
    if (value.type === "error") return this.#error(value);
    return [];
  }

  #assistant(value: Json): RunEvent[] {
    const events: RunEvent[] = [];
    const text = textOf(value.content);
    if (text !== undefined && text.trim() !== "") {
      const hook = HOOK_LINE.exec(text);
      if (hook === null) {
        this.#lastText = text;
        events.push({ type: "message", text });
      } else if (hook[1] !== undefined) {
        // A hook that blocked the request or a step: told as a refusal, its words stay with it.
        events.push({ type: "permission.denied", tool: "hook" });
      }
    }
    const calls = Array.isArray(value.tool_calls) ? value.tool_calls : [];
    for (const call of calls) {
      if (!isObject(call)) continue;
      const id = str(call.id);
      const fn = isObject(call.function) ? call.function : undefined;
      const name = fn === undefined ? undefined : str(fn.name);
      if (id === undefined || name === undefined) continue;
      this.#names.set(id, name);
      const parsed = parseArguments(fn?.arguments);
      const action = actionOf(name, parsed);
      events.push({ type: "tool.started", id, name, ...(action === undefined ? {} : { action }) });
      if (name === "Agent" && id.length <= 128) events.push(this.#launch(id, parsed));
    }
    return events;
  }

  /**
   * A sub-agent the tool was asked to launch: it works from the call on. The tool writes no count
   * of tokens, so none is carried. One that runs in the background has no end of its own in the
   * stream (its call returns at once): it is left to the end of the run.
   */
  #launch(id: string, args: unknown): RunEvent {
    const given = isObject(args) ? args : {};
    const name = str(given.subagent_type);
    const task = str(given.description);
    if (given.run_in_background !== true) this.#foreground.add(id);
    return {
      type: "subagent.updated",
      id,
      state: "working",
      ...(name !== undefined && AGENT_NAME.test(name) ? { name } : {}),
      ...(task === undefined ? {} : { task: task.slice(0, 200) }),
    };
  }

  #tool(value: Json): RunEvent[] {
    const id = str(value.tool_call_id);
    if (id === undefined) return [];
    const name = this.#names.get(id) ?? "tool";
    this.#names.delete(id);
    const text = typeof value.content === "string" ? value.content : "";
    const refused = REFUSED.test(text);
    const events: RunEvent[] = [];
    if (refused) events.push({ type: "permission.denied", tool: name.slice(0, 40) });
    const ok = !refused && !NOT_RUN.test(text);
    events.push({ type: "tool.completed", id, ok });
    if (this.#foreground.delete(id)) {
      events.push({ type: "subagent.updated", id, state: ok ? "done" : "failed" });
    }
    return events;
  }

  #meta(value: Json): RunEvent[] {
    switch (value.type) {
      case "session.resume_hint": {
        const session = str(value.session_id);
        if (session === undefined) return [];
        // The end of a turn that went well, and the first time the session is known.
        return [
          { type: "session.started", session },
          {
            type: "turn.completed",
            ok: true,
            session,
            ...(this.#lastText === undefined ? {} : { text: this.#lastText }),
          },
        ];
      }
      case "turn.step.retrying": {
        // The provider failed and the tool tries again: told, never fatal by itself.
        const detail = `${str(value.error_name) ?? ""} ${str(value.error_message) ?? ""}`;
        const code = failureCode(detail);
        return [
          {
            type: "error",
            code: code === "turn_failed" ? "retrying" : code,
            message: "the provider failed and the tool tries again",
          },
        ];
      }
      default:
        return [];
    }
  }

  #error(value: Json): RunEvent[] {
    const code = str(value.code);
    return [
      {
        type: "error",
        code: code !== undefined && /^[a-z0-9_.]{1,40}$/.test(code) ? code : "tool_error",
        message: (str(value.message) ?? "the tool reported an error").slice(0, 300),
      },
    ];
  }
}

/**
 * The cause of a run that ended with no turn, from the end of the error output: the codes of the
 * tool's own errors first (`provider.rate_limit`, `auth.login_required`), then its words.
 */
export function kimiExitFailure(errorOutput: string, exitCode: number | null): string | undefined {
  if (exitCode === 4) return "session_busy";
  // Warnings come before the error: only what follows the last `error:` tells the cause.
  const at = errorOutput.toLowerCase().lastIndexOf("error:");
  const text = (at < 0 ? errorOutput : errorOutput.slice(at)).toLowerCase();
  if (/provider\.rate_limit|rate limit|usage limit|quota|too many requests/.test(text)) {
    return "usage_limit";
  }
  if (
    /auth\.login_required|provider\.auth_error|no model configured|\/login|not (?:logged|signed) in|unauthori[sz]ed|api key/.test(
      text,
    )
  ) {
    return "not_signed_in";
  }
  if (/provider\.not_found/.test(text)) return "model_unknown";
  if (/session "[^"]{1,128}" not found/.test(text)) return "session_not_found";
  const code = failureCode(text);
  return code === "turn_failed" ? undefined : code;
}

export const kimiTranslator: ToolTranslator = {
  tool: "kimi",
  capabilities: CAPABILITIES,
  plan,
  begin: () => new KimiLines(),
  exitFailure: kimiExitFailure,
};
