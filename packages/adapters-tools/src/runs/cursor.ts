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
  failureCode,
  isObject,
  type Json,
  MODEL_PATTERN,
  num,
  SESSION_PATTERN,
  str,
} from "./json.js";

/**
 * Cursor's command line agent in its non-interactive mode (`-p`, `--output-format stream-json`),
 * read from its documentation. It takes the instruction as an argument (its documentation names
 * no standard input), reports no token and no cost, and has no input that stays open while it
 * works. Without `--force` it only proposes changes and asks before a command: this adapter never
 * passes `--force` (it allows every command that is not explicitly denied), so a run is read-only
 * and a request to edit is refused. Sub-agents are not documented for the non-interactive mode, so
 * none is promised.
 */

const CAPABILITIES: ToolCapabilities = {
  reportsUsage: false,
  reportsCost: false,
  interceptsPermissions: false,
  canResume: true,
  nativePause: false,
};

/** What a command line holds on every platform, with room for the other arguments. */
const MAX_PROMPT_CHARS = 24_000;

function plan(request: RunRequest): LaunchPlan {
  const level: unknown = request.permissions.level;
  if (level !== "read" && level !== "edit") {
    throw new RunRequestInvalid("permissions: unknown level");
  }
  if (level === "edit") {
    throw new RunRequestInvalid(
      "permissions: writing needs --force, which allows every command not explicitly denied",
    );
  }
  if (request.permissions.subAgents !== undefined) {
    throw new RunRequestInvalid("subAgents: not documented for this tool's non-interactive mode");
  }
  if (request.permissions.noTools === true) {
    throw new RunRequestInvalid("noTools: this tool cannot be started without its tools");
  }
  if ((request.permissions.denyCommands ?? []).length > 0) {
    throw new RunRequestInvalid("denyCommands: this tool takes its rules from the project");
  }
  if (request.liveInput === true) {
    throw new RunRequestInvalid("liveInput: this tool cannot take messages while it runs");
  }
  if (request.sessionId !== undefined) {
    throw new RunRequestInvalid("sessionId: this tool names its chats itself");
  }
  if (request.persistSession === false) {
    throw new RunRequestInvalid("persistSession: this tool always keeps its chats");
  }
  if (request.maxBudgetUsd !== undefined) {
    throw new RunRequestInvalid("maxBudgetUsd: this tool reports no cost to stop at");
  }
  if (request.prompt.length > MAX_PROMPT_CHARS) {
    throw new RunRequestInvalid("prompt: too long for this tool's command line");
  }
  // The workspace is the one the bridge serves. Headless mode cannot ask, so the project's MCP
  // servers are approved: `--approve-mcps` approves all of them, `allowMcpServers` cannot narrow it.
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--trust",
    "--approve-mcps",
    "--workspace",
    request.cwd,
  ];
  if (request.model !== undefined) {
    if (!MODEL_PATTERN.test(request.model)) throw new RunRequestInvalid("model: not a model name");
    args.push("--model", request.model);
  }
  if (request.resume !== undefined) {
    if (!SESSION_PATTERN.test(request.resume)) {
      throw new RunRequestInvalid("resume: not a chat id");
    }
    args.push("--resume", request.resume);
  }
  // A leading dash would be read as an option.
  args.push(request.prompt.startsWith("-") ? ` ${request.prompt}` : request.prompt);
  return { args, input: "none" };
}

/** The field of a tool call's arguments that names its target, by kind of call. */
function actionOf(kind: string, args: unknown): ToolAction | undefined {
  if (!isObject(args)) return undefined;
  if (kind === "read") {
    const path = str(args.path);
    return path === undefined ? undefined : { kind: "read", target: path };
  }
  if (kind === "write" || kind === "edit" || kind === "delete") {
    const path = str(args.path);
    return path === undefined ? undefined : { kind: "edit", target: path };
  }
  if (kind === "shell") {
    const command = str(args.command);
    return command === undefined ? undefined : { kind: "command", target: command };
  }
  return undefined;
}

class CursorLines implements LineTranslator {
  /** The name of each call that started, to tell a refusal under its tool. */
  readonly #names = new Map<string, string>();

  line(value: unknown): readonly RunEvent[] {
    if (!isObject(value)) return [];
    switch (value.type) {
      case "system":
        return this.#system(value);
      case "assistant":
        return this.#assistant(value);
      case "tool_call":
        return this.#call(value);
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
    const model = str(value.model);
    return [{ type: "session.started", session, ...(model === undefined ? {} : { model }) }];
  }

  #assistant(value: Json): RunEvent[] {
    const message = value.message;
    if (!isObject(message) || !Array.isArray(message.content)) return [];
    const events: RunEvent[] = [];
    for (const block of message.content) {
      if (!isObject(block) || block.type !== "text") continue;
      const text = str(block.text);
      if (text !== undefined) events.push({ type: "message", text });
    }
    return events;
  }

  #call(value: Json): RunEvent[] {
    const id = str(value.call_id);
    const call = value.tool_call;
    if (id === undefined || !isObject(call)) return [];
    const key = Object.keys(call)[0];
    if (key === undefined) return [];
    const body = call[key];
    if (value.subtype === "started") {
      const detail = isObject(body) ? body : undefined;
      const fn = key === "function" ? detail : undefined;
      const kind = key.endsWith("ToolCall") ? key.slice(0, -"ToolCall".length) : key;
      const name = (fn === undefined ? undefined : str(fn.name)) ?? kind;
      this.#names.set(id, name);
      const action = actionOf(kind, detail?.args);
      return [{ type: "tool.started", id, name, ...(action === undefined ? {} : { action }) }];
    }
    if (value.subtype !== "completed") return [];
    const name = this.#names.get(id) ?? "tool";
    this.#names.delete(id);
    const result = isObject(body) && isObject(body.result) ? body.result : undefined;
    const refused = result !== undefined && (isObject(result.rejected) || "rejected" in result);
    const failed = result !== undefined && ("error" in result || "failure" in result);
    const events: RunEvent[] = [];
    if (refused) events.push({ type: "permission.denied", tool: name.slice(0, 40) });
    events.push({ type: "tool.completed", id, ok: !refused && !failed });
    return events;
  }

  #result(value: Json): RunEvent[] {
    const subtype = str(value.subtype) ?? "success";
    const ok = value.is_error !== true && subtype === "success";
    const text = typeof value.result === "string" ? value.result : undefined;
    const session = str(value.session_id);
    const durationMs = num(value.duration_ms);
    const failure = ok
      ? undefined
      : subtype !== "success" && /^[a-z0-9_]{1,40}$/.test(subtype)
        ? subtype
        : failureCode(text);
    const events: RunEvent[] = [];
    if (!ok) {
      events.push({
        type: "error",
        code: failure ?? "turn_failed",
        message: (text ?? "the tool reported an error").slice(0, 300),
      });
    }
    events.push({
      type: "turn.completed",
      ok,
      ...(session === undefined ? {} : { session }),
      ...(text === undefined ? {} : { text }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(failure === undefined ? {} : { failure }),
    });
    return events;
  }
}

export const cursorTranslator: ToolTranslator = {
  tool: "cursor",
  capabilities: CAPABILITIES,
  plan,
  begin: () => new CursorLines(),
};
