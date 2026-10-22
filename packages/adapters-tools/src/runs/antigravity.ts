import {
  type LaunchPlan,
  type LineTranslator,
  type RunEvent,
  type RunRequest,
  RunRequestInvalid,
  type RunUsage,
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
 * Antigravity CLI (`agy`) in its non-interactive mode, read from its headless documentation: the
 * instruction and the further messages arrive as lines of JSON on the standard input
 * (`--input-format stream-json`, without `-p`, which would drop them), and the answer is a stream
 * of events (`--output-format stream-json`: `init`, `step_update`, `result`). Closing the input
 * ends the session after the turn in progress. The program asks nothing while it runs: a tool that
 * needs an approval it cannot get is refused softly (the run goes on and exits 0), so the
 * permissions are decided before the start, in the tool's own rules and in the project's plugin.
 * The level `read` cannot be held by this tool (it writes inside the workspace without asking), so
 * it is refused rather than promised.
 */

const CAPABILITIES: ToolCapabilities = {
  reportsUsage: true,
  reportsCost: false,
  interceptsPermissions: false,
  canResume: true,
  nativePause: false,
  subAgents: true,
  liveInput: true,
};

/** A sub-agent not mentioned for this long no longer keeps the input open. */
const STALE_SUBAGENT_MS = 10 * 60_000;

/** `--print-timeout` takes a duration such as `15m`; the tool's default (5 minutes) would cut a long turn. */
function timeoutArg(ms: number | undefined): string {
  const minutes = Math.max(1, Math.ceil((ms ?? 30 * 60_000) / 60_000));
  return `${minutes}m`;
}

function plan(request: RunRequest): LaunchPlan {
  const level: unknown = request.permissions.level;
  if (level !== "read" && level !== "edit") {
    throw new RunRequestInvalid("permissions: unknown level");
  }
  if (level === "read") {
    throw new RunRequestInvalid(
      "permissions: this tool writes inside its workspace without asking, a read-only level cannot be held",
    );
  }
  if (request.permissions.noTools === true) {
    throw new RunRequestInvalid("noTools: this tool cannot be started without its tools");
  }
  if ((request.permissions.denyCommands ?? []).length > 0) {
    throw new RunRequestInvalid("denyCommands: this tool takes its rules from its own settings");
  }
  if (request.sessionId !== undefined) {
    throw new RunRequestInvalid("sessionId: this tool names its conversations itself");
  }
  if (request.persistSession === false) {
    throw new RunRequestInvalid("persistSession: this tool always keeps its conversations");
  }
  if (request.maxBudgetUsd !== undefined) {
    throw new RunRequestInvalid("maxBudgetUsd: this tool reports no cost in money to stop at");
  }
  const args = [
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--print-timeout",
    timeoutArg(request.maxDurationMs),
  ];
  if (request.model !== undefined) {
    if (!MODEL_PATTERN.test(request.model)) throw new RunRequestInvalid("model: not a model name");
    args.push("--model", request.model);
  }
  if (request.resume !== undefined) {
    if (!SESSION_PATTERN.test(request.resume)) {
      throw new RunRequestInvalid("resume: not a conversation id");
    }
    args.push("--conversation", request.resume);
  }
  return { args, input: "framed" };
}

function usageOf(raw: unknown): RunUsage | undefined {
  if (!isObject(raw)) return undefined;
  const input = num(raw.input_tokens);
  const output = num(raw.output_tokens);
  const thinking = num(raw.thinking_tokens);
  const cacheRead = num(raw.cache_read_tokens);
  if (input === undefined && output === undefined) return undefined;
  return {
    ...(input === undefined ? {} : { tokensIn: input }),
    // Thinking is billed as output.
    ...(output === undefined && thinking === undefined
      ? {}
      : { tokensOut: (output ?? 0) + (thinking ?? 0) }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
  };
}

/** The payload of an event: the tool nests it under a key named like the event. */
function payload(value: Json, key: string): Json | undefined {
  const inner = value[key];
  return isObject(inner) ? inner : undefined;
}

class AntigravityLines implements LineTranslator {
  #model: string | undefined;
  #main: string | undefined;
  /** The text of each agent answer being streamed, by step. */
  readonly #text = new Map<number, string>();
  /** Sub-agents the tool says are at work (their conversation ids, and when it last said so), until their step is done. */
  readonly #background = new Map<string, number>();
  #lastText: string | undefined;

  /** Nothing runs in the background: the tool only waits for what the caller writes next. */
  idle(): boolean {
    // A sub-agent the tool has not mentioned for a long while is let go: the input must not stay
    // open until the run's time limit because an end was never told.
    const now = Date.now();
    for (const [id, at] of this.#background) {
      if (now - at > STALE_SUBAGENT_MS) this.#background.delete(id);
    }
    return this.#background.size === 0;
  }

  line(value: unknown): readonly RunEvent[] {
    if (!isObject(value)) return [];
    switch (value.event) {
      case "init": {
        const init = payload(value, "init");
        this.#model = init === undefined ? undefined : str(init.model);
        return [];
      }
      case "step_update": {
        const step = payload(value, "step_update");
        return step === undefined ? [] : this.#step(step);
      }
      case "result": {
        const result = payload(value, "result");
        return result === undefined ? [] : this.#result(result);
      }
      default:
        return [];
    }
  }

  #step(step: Json): RunEvent[] {
    const events: RunEvent[] = [];
    const conversation = str(step.conversation_id);
    if (this.#main === undefined && conversation !== undefined) {
      this.#main = conversation;
      events.push({
        type: "session.started",
        session: conversation,
        ...(this.#model === undefined ? {} : { model: this.#model }),
      });
    }
    const done = step.state === "DONE";
    const index = num(step.step_index) ?? -1;
    const own = conversation === undefined || conversation === this.#main;
    events.push(...this.#subAgents(step, done));
    switch (step.step_type) {
      case "agent_response":
        // The words of a sub-agent are its own: only the main conversation speaks to the creator.
        if (own) events.push(...this.#words(step, index, done));
        break;
      case "tool":
        events.push(...this.#tool(step, conversation ?? "", index, done));
        break;
      default:
        break;
    }
    return events;
  }

  /**
   * The sub-agents the step names: told when one first appears and when its step is done. The tool
   * names no kind, task or token count for them in this message, so none is carried.
   */
  #subAgents(step: Json, done: boolean): RunEvent[] {
    const info = isObject(step.subagent_info) ? step.subagent_info : undefined;
    const list = info !== undefined && Array.isArray(info.subagents) ? info.subagents : [];
    const events: RunEvent[] = [];
    for (const entry of list) {
      const id = isObject(entry) ? str(entry.conversation_id) : undefined;
      if (id === undefined || id.length > 128) continue;
      const known = this.#background.has(id);
      if (done) {
        this.#background.delete(id);
        if (known) events.push({ type: "subagent.updated", id, state: "done" });
      } else {
        this.#background.set(id, Date.now());
        if (!known) events.push({ type: "subagent.updated", id, state: "working" });
      }
    }
    return events;
  }

  #words(step: Json, index: number, done: boolean): RunEvent[] {
    const delta = typeof step.text_delta === "string" ? step.text_delta : "";
    const before = this.#text.get(index) ?? "";
    if (!done) {
      if (delta !== "") this.#text.set(index, before + delta);
      return [];
    }
    // The ended step may repeat the whole text or carry only the last piece.
    let text = before;
    if (delta !== "") {
      if (before === "" || delta.startsWith(before)) text = delta;
      else if (!before.endsWith(delta)) text = before + delta;
    }
    this.#text.delete(index);
    if (text.trim() === "") return [];
    this.#lastText = text;
    return [{ type: "message", text }];
  }

  #tool(step: Json, conversation: string, index: number, done: boolean): RunEvent[] {
    const info = isObject(step.tool_info) ? step.tool_info : undefined;
    const name = str(step.tool_name) ?? (info === undefined ? undefined : str(info.name)) ?? "tool";
    const id = `${conversation}:${index}`;
    if (!done) return [{ type: "tool.started", id, name }];
    const failed = info !== undefined && isObject(info.error);
    const events: RunEvent[] = [];
    if (
      failed &&
      isObject(info.error) &&
      /permission|denied|approval/i.test(str(info.error.type) ?? "")
    ) {
      events.push({ type: "permission.denied", tool: name.slice(0, 40) });
    }
    events.push({ type: "tool.completed", id, ok: !failed });
    return events;
  }

  #result(result: Json): RunEvent[] {
    const status = str(result.status) ?? "SUCCESS";
    const ok = status === "SUCCESS";
    const usage = usageOf(result.usage);
    const seconds = num(result.duration_seconds);
    const session = str(result.conversation_id) ?? this.#main;
    const response = typeof result.response === "string" ? result.response : this.#lastText;
    const error = result.error;
    const detail =
      typeof error === "string" ? error : isObject(error) ? str(error.message) : undefined;
    if (!ok) this.#background.clear();
    const failure = ok
      ? undefined
      : status === "ERROR"
        ? failureCode(detail)
        : status
            .toLowerCase()
            .replace(/[^a-z0-9_]/g, "_")
            .slice(0, 40);
    const events: RunEvent[] = [];
    if (!ok) {
      events.push({
        type: "error",
        code: failure ?? "tool_error",
        message: (detail ?? "the tool reported an error").slice(0, 300),
      });
    }
    if (usage !== undefined) events.push({ type: "usage", usage });
    events.push({
      type: "turn.completed",
      ok,
      ...(session === undefined ? {} : { session }),
      ...(response === undefined || response === "" ? {} : { text: response }),
      ...(usage === undefined ? {} : { usage }),
      ...(seconds === undefined ? {} : { durationMs: Math.round(seconds * 1000) }),
      ...(failure === undefined ? {} : { failure }),
    });
    return events;
  }
}

export const antigravityTranslator: ToolTranslator = {
  tool: "antigravity",
  capabilities: CAPABILITIES,
  plan,
  begin: () => new AntigravityLines(),
  frame: (text) => JSON.stringify({ event: "user", message: { content: text } }),
};
