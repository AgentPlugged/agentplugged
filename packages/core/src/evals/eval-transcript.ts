import { count, lines, readClaudeTranscript } from "../usage/trace-readers.js";
import { isRecord } from "../values.js";

/**
 * What a run of an agent left, read from the transcript the tool wrote, pure: the
 * answer, the calls it made, and what it consumed. Claude Code's stream is read first; another
 * tool's transcript is read by the same function with what it can give: its text as the answer, no
 * calls, no tokens. Tokens the tool does not give are `undefined`, never zero: a zero would pass
 * for a free run and hide a regression of cost.
 */

/** What a run consumed, as the tool says. */
export interface RunUsage {
  readonly tokens_in: number;
  readonly tokens_out: number;
  readonly cache_read: number;
  readonly cache_write: number;
  /** All four: the same however the cache happened to split the prompt. */
  readonly total: number;
  /** Dollars the tool reports, when it does. */
  readonly usd?: number;
  readonly models: readonly string[];
}

/** A call the agent made: the tool's name and its input. */
export interface ToolCall {
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface RunReading {
  /** The agent's final message. */
  readonly answer: string;
  readonly calls: readonly ToolCall[];
  /** Absent when the tool did not give a count: the run is « not measured ». */
  readonly usage?: RunUsage;
  /** False when the tool says the run failed (an error result). */
  readonly ok: boolean;
}

const MAX_ANSWER = 20_000;

/** The calls one line of a Claude Code stream holds. */
export function callsOfLine(line: string): ToolCall[] {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isRecord(row) || row.type !== "assistant" || !isRecord(row.message)) return [];
  const content = row.message.content;
  if (!Array.isArray(content)) return [];
  const calls: ToolCall[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "tool_use" && typeof block.name === "string") {
      calls.push({ name: block.name, input: isRecord(block.input) ? block.input : {} });
    }
  }
  return calls;
}

function usageOf(
  result: Record<string, unknown> | undefined,
  transcript: string,
): RunUsage | undefined {
  const models: string[] = [];
  let tokens_in = 0;
  let tokens_out = 0;
  let cache_read = 0;
  let cache_write = 0;
  const perModel =
    result !== undefined && isRecord(result.modelUsage) ? result.modelUsage : undefined;
  if (perModel !== undefined) {
    // Every model of the run, those of sub-agents too.
    for (const [model, usage] of Object.entries(perModel)) {
      if (!isRecord(usage)) continue;
      models.push(model);
      tokens_in += count(usage.inputTokens);
      tokens_out += count(usage.outputTokens);
      cache_read += count(usage.cacheReadInputTokens);
      cache_write += count(usage.cacheCreationInputTokens);
    }
  } else if (result !== undefined && isRecord(result.usage)) {
    tokens_in = count(result.usage.input_tokens);
    tokens_out = count(result.usage.output_tokens);
    cache_read = count(result.usage.cache_read_input_tokens);
    cache_write = count(result.usage.cache_creation_input_tokens);
  } else {
    // No result line (a run cut short): the answers the stream holds, each counted once.
    for (const usage of readClaudeTranscript(transcript).models) {
      models.push(usage.model);
      tokens_in += usage.tokens_in;
      tokens_out += usage.tokens_out;
      cache_read += usage.cache_read;
      cache_write += usage.cache_write;
    }
  }
  const total = tokens_in + tokens_out + cache_read + cache_write;
  // A run that consumed nothing did not run: the count is missing, not zero.
  if (total === 0) return undefined;
  const usd =
    typeof result?.total_cost_usd === "number" && result.total_cost_usd >= 0
      ? result.total_cost_usd
      : undefined;
  return {
    tokens_in,
    tokens_out,
    cache_read,
    cache_write,
    total,
    ...(usd === undefined ? {} : { usd }),
    models: [...new Set(models)].sort(),
  };
}

/** Reads a Claude Code run (`--output-format stream-json`). */
export function readClaudeRun(transcript: string): RunReading {
  const rows = lines(transcript);
  const calls = transcript
    .split("\n")
    .flatMap((line) => (line.trim() === "" ? [] : callsOfLine(line)));
  const result = rows.findLast((row) => row.type === "result");
  let answer = typeof result?.result === "string" ? result.result : undefined;
  if (answer === undefined) {
    // No result line: the last text the agent wrote.
    for (const row of rows.toReversed()) {
      if (row.type !== "assistant" || !isRecord(row.message) || !Array.isArray(row.message.content))
        continue;
      const text = row.message.content
        .flatMap((block) =>
          isRecord(block) && block.type === "text" && typeof block.text === "string"
            ? [block.text]
            : [],
        )
        .join("\n");
      if (text.trim() !== "") {
        answer = text;
        break;
      }
    }
  }
  const usage = usageOf(result, transcript);
  return {
    answer: (answer ?? "").slice(0, MAX_ANSWER),
    calls,
    ...(usage === undefined ? {} : { usage }),
    ok: result !== undefined && result.is_error !== true,
  };
}

/** Reads a transcript of any tool: Claude Code's richly, the others as plain text and « not measured ». */
export function readRun(tool: string, transcript: string): RunReading {
  if (tool === "claude-code") return readClaudeRun(transcript);
  return {
    answer: transcript.trim().slice(0, MAX_ANSWER),
    calls: [],
    ok: transcript.trim() !== "",
  };
}
