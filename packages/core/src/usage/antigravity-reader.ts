import { isRecord } from "../values.js";
import {
  count,
  lines,
  summaryOfAnswers,
  type TraceAnswer,
  type TraceSummary,
} from "./trace-readers.js";

/**
 * Reading the transcripts Antigravity keeps, pure: the text of
 * `~/.gemini/antigravity/brain/<conversation>/.system_generated/logs/transcript.jsonl` in, what the
 * conversation consumed out. Checked against the real transcripts of the machine this engine was
 * written on (2026-10-07). One JSON line per step of the conversation (`step_index`, `source`,
 * `type`, `created_at` to the second):
 *
 * - `PLANNER_RESPONSE` steps are the model's answers: `input_tokens` (the new input, the cached
 *   part excluded: a prompt is `input_tokens + cache_read_tokens`), `cache_read_tokens` and
 *   `output_tokens` (what the model wrote, its reasoning included). Only these fields give
 *   figures, and the tool never truncates them (`truncated_fields` names only the texts);
 * - the model is not on the answer: the creator's choice is told in the `USER_INPUT` step that
 *   follows the change (« changed setting `Model Selection` from A to B »), in the tool's human
 *   names (« Gemini 3.1 Pro (Low) »). The model of an answer is the last one chosen before it;
 * - a conversation a sub-agent ran starts with a `SYSTEM_MESSAGE` from its parent conversation
 *   (`sender=<conversation>`) holding the brief, and never holds a `USER_INPUT`: the tool says
 *   nothing of the model it runs on, so the adapter gives it its parent's (`hint`).
 */

/** What the transcript says of the model the creator chose, in order. */
interface ModelChange {
  readonly at: number;
  readonly from: string | undefined;
  readonly to: string | undefined;
}

/**
 * A model as the engine names it: the tool's human name without the effort in parentheses
 * (« Gemini 3.1 Pro (Low) » is `gemini-3.1-pro`; « Claude Sonnet 4.6 (Thinking) » is
 * `claude-sonnet-4-6`, the Claude spelling). Undefined for « None ».
 */
export function antigravityModelId(name: string): string | undefined {
  const base = name
    .replace(/\s*\([^)]*\)/gu, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, "-");
  if (base === "" || base === "none") return undefined;
  const id = base.startsWith("claude") ? base.replace(/(\d)\.(\d)/gu, "$1-$2") : base;
  return id.slice(0, 100);
}

const timeOf = (row: Record<string, unknown>): number =>
  typeof row.created_at === "string" ? Date.parse(row.created_at) : Number.NaN;

function modelChanges(rows: readonly Record<string, unknown>[]): ModelChange[] {
  const changes: ModelChange[] = [];
  // A step written without a valid time is read at the time of the step before it.
  let last = 0;
  for (const row of rows) {
    if (row.type !== "USER_INPUT" || typeof row.content !== "string") continue;
    const at = Number.isNaN(timeOf(row)) ? last : timeOf(row);
    last = at;
    for (const match of row.content.matchAll(
      /changed setting `Model Selection` from (.+?) to (.+?)\.(?=\s|$)/gu,
    )) {
      changes.push({
        at,
        from: antigravityModelId(match[1] as string),
        to: antigravityModelId(match[2] as string),
      });
    }
  }
  return changes;
}

/** The model chosen at a time (milliseconds), `initial` before the first choice told. */
function modelIn(
  changes: readonly ModelChange[],
  at: number,
  initial: string | undefined,
): string | undefined {
  let model = initial ?? changes[0]?.from;
  for (const change of changes) {
    if (change.at > at) break;
    model = change.to;
  }
  return model;
}

/** The model a conversation ran on at a time, `hint` when it tells nothing. */
export function antigravityModelAt(text: string, at: number, hint?: string): string | undefined {
  return modelIn(modelChanges(lines(text)), at, hint);
}

/** A model name the engine cannot read: its tokens are measured, its amount is not. */
const UNKNOWN_MODEL = "unknown";

/**
 * Antigravity's transcript. An answer is a step written once (`step_index`): a step seen twice
 * counts once. `hint` is the model of a conversation that never says which it runs on (a
 * sub-agent's: its parent's).
 */
export function readAntigravityTranscript(text: string, hint?: string): TraceSummary {
  const rows = lines(text);
  const changes = modelChanges(rows);
  const answers: TraceAnswer[] = [];
  const times: number[] = [];
  const seen = new Set<number>();
  for (const row of rows) {
    const at = timeOf(row);
    if (row.type !== "CHECKPOINT" && !Number.isNaN(at)) times.push(at);
    if (row.type !== "PLANNER_RESPONSE") continue;
    if (typeof row.step_index === "number") {
      if (seen.has(row.step_index)) continue;
      seen.add(row.step_index);
    }
    const tokens_in = count(row.input_tokens);
    const cache_read = count(row.cache_read_tokens);
    const tokens_out = count(row.output_tokens);
    if (tokens_in + cache_read + tokens_out === 0) continue;
    answers.push({
      at: Number.isNaN(at) ? 0 : at,
      usage: {
        model: modelIn(changes, Number.isNaN(at) ? 0 : at, hint) ?? UNKNOWN_MODEL,
        messages: 1,
        tokens_in,
        tokens_out,
        cache_read,
        cache_write: 0,
        cache_write_1h: 0,
      },
    });
  }
  return summaryOfAnswers(answers, times);
}

/** What a conversation says of itself, for the adapter that ties it to a product. */
export interface AntigravityInfo {
  /** `main`: the creator talks in it; `sub`: a sub-agent's conversation, started by `parent`. */
  readonly kind: "main" | "sub";
  readonly parent?: string;
  /** A `sub`: the start of the brief it was given. */
  readonly description?: string;
  /** A `sub`: the agent the brief names. */
  readonly agent_type?: string;
  /** A `sub`: when it started (milliseconds), the time its parent's model is read at. */
  readonly started_at?: number;
}

const SENDER = /\[Message\][^\n]*?sender=(\S+)[^\n]*?content=([\s\S]*?)(?:<\/SYSTEM_MESSAGE>|$)/u;

/** The agent id a brief names (« Ton agent id MCP est "hugo" », `agent="chloe"`, « Tu es Lina »). */
function agentNamedBy(brief: string, rows: readonly Record<string, unknown>[]): string | undefined {
  const named =
    /agent id MCP est "([a-z][a-z0-9_-]*)"/iu.exec(brief) ??
    /agent="([a-z][a-z0-9_-]*)"/iu.exec(brief) ??
    /\bTu es ([A-ZÀ-ÖØ-Ý][\p{L}0-9_-]*)/u.exec(brief);
  if (named !== null)
    return (named[1] as string).toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  // Else the agent the conversation itself acts as in the product's tools.
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!Array.isArray(row.tool_calls)) continue;
    for (const call of row.tool_calls as unknown[]) {
      if (!isRecord(call) || !isRecord(call.args) || typeof call.args.Arguments !== "string") {
        continue;
      }
      const agent = /"agent"\s*:\s*"([a-z][a-z0-9_-]*)"/u.exec(call.args.Arguments)?.[1];
      if (agent !== undefined) counts.set(agent, (counts.get(agent) ?? 0) + 1);
    }
  }
  let best: string | undefined;
  for (const [agent, seen] of [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (best === undefined || seen > (counts.get(best) as number)) best = agent;
  }
  return best;
}

export function antigravityTraceInfo(text: string): AntigravityInfo {
  const rows = lines(text);
  // A conversation a parent started opens with its brief, before any word of the creator (who may
  // then talk to the agent in it).
  for (const row of rows) {
    if (row.type === "USER_INPUT") return { kind: "main" };
    if (row.type !== "SYSTEM_MESSAGE" || typeof row.content !== "string") continue;
    const match = SENDER.exec(row.content);
    if (match === null) continue;
    const brief = (match[2] as string).replace(/\s+/gu, " ").trim();
    const agent = agentNamedBy(brief, rows);
    const at = timeOf(row);
    return {
      kind: "sub",
      parent: match[1] as string,
      description: brief.slice(0, 200),
      ...(agent === undefined ? {} : { agent_type: agent }),
      ...(Number.isNaN(at) ? {} : { started_at: at }),
    };
  }
  return { kind: "main" };
}

/** A path as compared: lower case, forward slashes, no `file://` (a drive letter or a root `/` stays). */
function antigravityPath(path: string): string {
  return path
    .toLowerCase()
    .replace(/file:\/\/\/([a-z]:)/gu, "$1")
    .replace(/file:\/\//gu, "")
    .replace(/\\+/gu, "/")
    .replace(/\/{2,}/gu, "/")
    .replace(/\/+$/u, "");
}

/** The arguments of the tool's calls that name a folder or a file the conversation works on. */
const PATH_ARGUMENTS = new Set([
  "Cwd",
  "AbsolutePath",
  "TargetFile",
  "SearchPath",
  "DirectoryPath",
  "Directory",
  "FilePath",
  "Path",
]);

/** The files and folders a conversation worked on: the document open, the arguments of its calls. */
function workedOn(rows: readonly Record<string, unknown>[]): string[] {
  const paths: string[] = [];
  const add = (value: string) => {
    const path = antigravityPath(value.trim().replace(/^"|"$/gu, ""));
    if (/^([a-z]:)?\//u.test(path) && !path.includes("/.gemini/")) paths.push(path);
  };
  for (const row of rows) {
    if (row.type === "USER_INPUT" && typeof row.content === "string") {
      for (const match of row.content.matchAll(/Active Document: (.+?) \(/gu)) {
        add(match[1] as string);
      }
    }
    if (!Array.isArray(row.tool_calls)) continue;
    for (const call of row.tool_calls as unknown[]) {
      if (!isRecord(call) || !isRecord(call.args)) continue;
      for (const [name, value] of Object.entries(call.args)) {
        if (PATH_ARGUMENTS.has(name) && typeof value === "string") add(value);
      }
    }
  }
  return paths;
}

/** True when `path` is `place` or inside it. */
const within = (path: string, place: string) => path === place || path.startsWith(`${place}/`);

/**
 * The product folder a conversation belongs to: the index of the place among `places` (the
 * product's folder, then its story working copies; absolute paths); `"elsewhere"` for a
 * conversation of another folder; undefined for one that names no file or folder it works on (a
 * short sub-agent's: the adapter then gives it its parent's). What it worked on is read from the
 * document the creator had open and the arguments of its calls (the folder a command ran in, the
 * files viewed or written), never from the text of a command or a message (an engine's path is
 * not the work). It belongs to the product when most of those paths are inside it, to the place
 * that holds the most. The tool's own files (`.gemini`) are not the work.
 */
export function antigravityPlace(
  text: string,
  places: readonly string[],
): number | "elsewhere" | undefined {
  const normalized = places.map(antigravityPath);
  // The files it worked on, each once: a document open for the whole conversation is one file.
  const paths = [...new Set(workedOn(lines(text)))];
  if (paths.length === 0) return undefined;
  const counts = normalized.map(() => 0);
  for (const path of paths) {
    let best: number | undefined;
    normalized.forEach((place, index) => {
      if (
        within(path, place) &&
        (best === undefined || place.length > (normalized[best] as string).length)
      ) {
        best = index;
      }
    });
    if (best !== undefined) counts[best] = (counts[best] as number) + 1;
  }
  const inside = counts.reduce((sum, seen) => sum + seen, 0);
  if (inside * 2 <= paths.length) return "elsewhere";
  let top = 0;
  counts.forEach((seen, index) => {
    if (seen > (counts[top] as number)) top = index;
  });
  return top;
}
