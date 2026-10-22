import {
  type LaunchPlan,
  type LineTranslator,
  type RunEvent,
  type RunRequest,
  RunRequestInvalid,
  type RunUsage,
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
 * Codex in its non-interactive mode: `codex exec --json`, one JSON event per line (the open
 * source `codex-rs` crate defines them: `thread.started`, `turn.*`, `item.started`,
 * `item.completed`, `error`). The instruction travels on the standard input (`-`). Permissions are
 * decided before the start by the sandbox (`read-only`, `workspace-write`): `exec` never asks, an
 * action the sandbox forbids is refused and the agent says so in text. No level bypasses the
 * sandbox or the approvals.
 *
 * What the command line cannot carry stays with the project: the product's rules of commands and
 * its hooks are read by Codex from the project's `.codex/` folder once the creator trusted it.
 * Codex has no input that stays open while it works, no cost in money and no session name given
 * before the start; its sub-agents (`collab_tool_call` items) are launched by the agent itself.
 */

const CAPABILITIES: ToolCapabilities = {
  reportsUsage: true,
  reportsCost: false,
  interceptsPermissions: false,
  canResume: true,
  nativePause: false,
  subAgents: true,
};

function plan(request: RunRequest): LaunchPlan {
  const level: unknown = request.permissions.level;
  if (level !== "read" && level !== "edit") {
    throw new RunRequestInvalid("permissions: unknown level");
  }
  if (request.permissions.noTools === true) {
    throw new RunRequestInvalid("noTools: this tool cannot be started without its tools");
  }
  if ((request.permissions.denyCommands ?? []).length > 0) {
    // A refusal that cannot be applied is never dropped in silence.
    throw new RunRequestInvalid(
      "denyCommands: this tool takes its rules of commands from the project",
    );
  }
  if (request.liveInput === true) {
    throw new RunRequestInvalid("liveInput: this tool cannot take messages while it runs");
  }
  if (request.sessionId !== undefined) {
    throw new RunRequestInvalid("sessionId: this tool names its sessions itself");
  }
  if (request.maxBudgetUsd !== undefined) {
    throw new RunRequestInvalid("maxBudgetUsd: this tool reports no cost in money to stop at");
  }
  const args = ["exec", "--json", "--sandbox", level === "edit" ? "workspace-write" : "read-only"];
  if (request.model !== undefined) {
    if (!MODEL_PATTERN.test(request.model)) throw new RunRequestInvalid("model: not a model name");
    args.push("--model", request.model);
  }
  if (request.persistSession === false) args.push("--ephemeral");
  // The options come before `resume`: the subcommand takes the ones of `exec` as its own.
  if (request.resume !== undefined) {
    if (!SESSION_PATTERN.test(request.resume)) {
      throw new RunRequestInvalid("resume: not a session id");
    }
    args.push("resume", request.resume);
  }
  // `-` : the instruction is read from the standard input.
  args.push("-");
  return { args, input: "prompt" };
}

function usageOf(raw: unknown): RunUsage | undefined {
  if (!isObject(raw)) return undefined;
  const input = num(raw.input_tokens);
  const output = num(raw.output_tokens);
  const cacheRead = num(raw.cached_input_tokens);
  const cacheWrite = num(raw.cache_write_input_tokens);
  if (input === undefined && output === undefined) return undefined;
  // `input_tokens` already counts the cached ones; the split stays visible.
  return {
    ...(input === undefined ? {} : { tokensIn: input }),
    ...(output === undefined ? {} : { tokensOut: output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined || cacheWrite === 0 ? {} : { cacheWrite }),
  };
}

class CodexLines implements LineTranslator {
  #session: string | undefined;
  #lastText: string | undefined;
  #failure: string | undefined;

  line(value: unknown): readonly RunEvent[] {
    if (!isObject(value)) return [];
    switch (value.type) {
      case "thread.started": {
        const session = str(value.thread_id);
        if (session === undefined) return [];
        this.#session = session;
        return [{ type: "session.started", session }];
      }
      case "item.started":
      case "item.completed":
        return this.#item(value.type === "item.completed", value.item);
      case "turn.completed":
        return this.#completed(value);
      case "turn.failed":
        return this.#turnFailed(value);
      case "error":
        return this.#error(value);
      default:
        return [];
    }
  }

  #item(done: boolean, raw: unknown): RunEvent[] {
    if (!isObject(raw)) return [];
    const id = str(raw.id);
    if (id === undefined) return [];
    switch (raw.type) {
      case "agent_message": {
        const text = done ? str(raw.text) : undefined;
        if (text === undefined) return [];
        this.#lastText = text;
        return [{ type: "message", text }];
      }
      case "command_execution":
        return this.#command(done, id, raw);
      case "file_change":
        return this.#files(done, id, raw);
      case "mcp_tool_call": {
        const server = str(raw.server) ?? "mcp";
        const tool = str(raw.tool) ?? "tool";
        return this.#call(done, id, `mcp__${server}__${tool}`, raw.status);
      }
      case "collab_tool_call":
        return this.#call(done, id, `agent.${str(raw.tool) ?? "call"}`, raw.status);
      case "web_search":
        return this.#call(done, id, "web_search", done ? "completed" : "in_progress");
      default:
        // Reasoning, the to-do list and the non-fatal error items carry nothing to report.
        return [];
    }
  }

  #command(done: boolean, id: string, raw: Json): RunEvent[] {
    const command = str(raw.command);
    const action: ToolAction | undefined =
      command === undefined ? undefined : { kind: "command", target: command };
    if (!done) {
      return [
        { type: "tool.started", id, name: "shell", ...(action === undefined ? {} : { action }) },
      ];
    }
    const events: RunEvent[] = [];
    // A command the sandbox or the approvals refused is told as a refusal, not as a failure.
    if (raw.status === "declined") events.push({ type: "permission.denied", tool: "shell" });
    events.push({ type: "tool.completed", id, ok: raw.status === "completed" });
    return events;
  }

  #files(done: boolean, id: string, raw: Json): RunEvent[] {
    // A file change is only ever told once it ended, with the paths it touched.
    if (!done) return [];
    const ok = raw.status === "completed";
    const changes = Array.isArray(raw.changes) ? raw.changes : [];
    const events: RunEvent[] = [];
    let index = 0;
    for (const change of changes) {
      const path = isObject(change) ? str(change.path) : undefined;
      if (path === undefined) continue;
      const callId = `${id}:${index++}`;
      events.push({
        type: "tool.started",
        id: callId,
        name: "file_change",
        action: { kind: "edit", target: path },
      });
      events.push({ type: "tool.completed", id: callId, ok });
    }
    if (index === 0) {
      events.push({ type: "tool.started", id, name: "file_change" });
      events.push({ type: "tool.completed", id, ok });
    }
    return events;
  }

  #call(done: boolean, id: string, name: string, status: unknown): RunEvent[] {
    if (!done) return [{ type: "tool.started", id, name }];
    return [{ type: "tool.completed", id, ok: status === "completed" }];
  }

  #completed(value: Json): RunEvent[] {
    const usage = usageOf(value.usage);
    const events: RunEvent[] = [];
    if (usage !== undefined) events.push({ type: "usage", usage });
    events.push({
      type: "turn.completed",
      ok: true,
      ...(this.#session === undefined ? {} : { session: this.#session }),
      ...(this.#lastText === undefined ? {} : { text: this.#lastText }),
      ...(usage === undefined ? {} : { usage }),
    });
    return events;
  }

  #error(value: Json): RunEvent[] {
    const message = str(value.message) ?? "the tool reported an error";
    const code = failureCode(message);
    // A non-fatal error (a reconnection) names no cause: the final failure is worked out then.
    if (code !== "turn_failed") this.#failure = code;
    return [{ type: "error", code, message: message.slice(0, 300) }];
  }

  #turnFailed(value: Json): RunEvent[] {
    const detail = isObject(value.error) ? str(value.error.message) : undefined;
    // `error` comes first in the stream and already named the cause; `turn.failed` ends the turn.
    const failure = this.#failure ?? failureCode(detail);
    const events: RunEvent[] = [];
    if (failure === "usage_limit") events.push({ type: "limit", status: "exceeded" });
    events.push({
      type: "turn.completed",
      ok: false,
      ...(this.#session === undefined ? {} : { session: this.#session }),
      failure,
    });
    return events;
  }
}

export const codexTranslator: ToolTranslator = {
  tool: "codex",
  capabilities: CAPABILITIES,
  plan,
  begin: () => new CodexLines(),
};
