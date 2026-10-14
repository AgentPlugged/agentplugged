import type { UsageModel } from "@agentplugged/protocol";
import { isRecord } from "../values.js";

/**
 * Reading the traces an AI tool keeps, pure: a trace's text in, what it consumed
 * out. Claude Code's transcripts are read and checked against real ones; Codex's rollouts are
 * read from the format the tool documents (never seen on the machine this engine was written
 * on: its tests use a hand-made trace); Antigravity's transcripts are read in
 * `antigravity-reader.ts`, with the helpers below; Cursor keeps no token count in any local trace, so the
 * engine measures nothing of it and says so.
 */

/** What a session consumed, as its trace says. */
export interface TraceSummary {
  /** ISO time of the first and the last line of the session, or null for an empty trace. */
  readonly started_at: string | null;
  readonly ended_at: string | null;
  /** The session's working time: gaps between two lines under five minutes. */
  readonly active_ms: number;
  readonly models: UsageModel[];
  /**
   * Each answer of a model with the time it was complete (milliseconds), so that a session can be
   * cut in time. Empty for a trace that only gives a total (Codex's).
   */
  readonly answers: readonly TraceAnswer[];
  /** The times of the session's lines (milliseconds): the working time is counted between them. */
  readonly times: readonly number[];
  /**
   * What the tool itself says of the skills it ran: the time of each call to a
   * skill, and of each message the creator typed (a skill ends there). Only Claude Code's trace
   * says it; absent for a tool whose trace does not (its parts are then not attributed by the tool).
   */
  readonly skillCalls?: readonly SkillCall[];
  readonly prompts?: readonly number[];
}

/** A skill the AI tool ran, as its trace names it. */
export interface SkillCall {
  readonly at: number;
  readonly skill: string;
}

/** One answer of a model: its consumption (`messages: 1`) and when it ended. */
export interface TraceAnswer {
  readonly at: number;
  readonly usage: UsageModel;
}

/** A gap between two lines of a session longer than this is the creator away, not the tool working. */
export const MAX_ACTIVE_GAP_MS = 5 * 60 * 1000;

export const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), 1_000_000_000_000)
    : 0;

export function lines(text: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) rows.push(parsed);
    } catch {
      // A half-written last line while the tool is still writing: not a measure.
    }
  }
  return rows;
}

/** The working time of a session from the times of its lines. */
function activeMs(times: readonly number[]): number {
  const sorted = [...times].sort((a, b) => a - b);
  let active = 0;
  for (let index = 1; index < sorted.length; index += 1) {
    const gap = (sorted[index] as number) - (sorted[index - 1] as number);
    if (gap <= MAX_ACTIVE_GAP_MS) active += gap;
  }
  return active;
}

function span(times: readonly number[]): {
  started_at: string | null;
  ended_at: string | null;
} {
  if (times.length === 0) return { started_at: null, ended_at: null };
  // A loop, not `Math.min(...times)`: a long session has more lines than a call may take.
  let first = times[0] as number;
  let last = first;
  for (const time of times) {
    if (time < first) first = time;
    if (time > last) last = time;
  }
  return { started_at: new Date(first).toISOString(), ended_at: new Date(last).toISOString() };
}

/**
 * Claude Code's transcript (`~/.claude/projects/<folder>/<session>.jsonl`, and the sub-agents'
 * under `<session>/subagents/`): one JSON line per turn. An answer (`type: assistant`) carries
 * `message.usage`, `message.model` and `message.id`. The tool writes an answer's line again for
 * each block of its content, with a count of output tokens that grows while it streams: an answer
 * counts once, with the largest of each count. A `<synthetic>` model is no call to a model.
 */
export function readClaudeTranscript(text: string): TraceSummary {
  const answers = new Map<
    string,
    {
      model: string;
      tokens_in: number;
      tokens_out: number;
      cache_read: number;
      cw: number;
      cw1h: number;
      at: number;
    }
  >();
  const times: number[] = [];
  const skillCalls: SkillCall[] = [];
  const prompts: number[] = [];
  const calledOnce = new Set<string>();
  let anonymous = 0;
  for (const row of lines(text)) {
    const at = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : Number.NaN;
    if ((row.type === "assistant" || row.type === "user") && !Number.isNaN(at)) times.push(at);
    if (row.type === "user" && !Number.isNaN(at) && isCreatorPrompt(row)) prompts.push(at);
    if (row.type === "assistant" && !Number.isNaN(at) && isRecord(row.message)) {
      // The tool writes an answer's line again for each block: a call counts once, by its id.
      for (const call of skillsCalledIn(row.message.content)) {
        const key = typeof call.id === "string" ? call.id : `${at}:${call.name}`;
        if (calledOnce.has(key)) continue;
        calledOnce.add(key);
        skillCalls.push({ at, skill: call.name });
      }
    }
    if (row.type !== "assistant" || !isRecord(row.message)) continue;
    const message = row.message;
    const usage = message.usage;
    const model = message.model;
    if (!isRecord(usage) || typeof model !== "string" || model.startsWith("<")) continue;
    const id = typeof message.id === "string" ? message.id : `anonymous-${anonymous++}`;
    const written = isRecord(usage.cache_creation) ? usage.cache_creation : {};
    const previous = answers.get(id);
    const next = {
      at: Number.isNaN(at) ? 0 : at,
      model,
      tokens_in: count(usage.input_tokens),
      tokens_out: count(usage.output_tokens),
      cache_read: count(usage.cache_read_input_tokens),
      cw: count(usage.cache_creation_input_tokens),
      cw1h: count(written.ephemeral_1h_input_tokens),
    };
    answers.set(
      id,
      previous === undefined
        ? next
        : {
            model: previous.model,
            tokens_in: Math.max(previous.tokens_in, next.tokens_in),
            tokens_out: Math.max(previous.tokens_out, next.tokens_out),
            cache_read: Math.max(previous.cache_read, next.cache_read),
            cw: Math.max(previous.cw, next.cw),
            cw1h: Math.max(previous.cw1h, next.cw1h),
            at: Math.max(previous.at, next.at),
          },
    );
  }
  const timed: TraceAnswer[] = [];
  for (const answer of answers.values()) {
    timed.push({
      at: answer.at,
      usage: {
        model: answer.model,
        messages: 1,
        tokens_in: answer.tokens_in,
        tokens_out: answer.tokens_out,
        cache_read: answer.cache_read,
        cache_write: answer.cw,
        cache_write_1h: Math.min(answer.cw1h, answer.cw),
      },
    });
  }
  return { ...summaryOfAnswers(timed, times), skillCalls, prompts };
}

/**
 * True for a line that is a message typed to the tool (or to a sub-agent as its brief): a user
 * line that is not a tool's result and not one the tool wrote itself (`isMeta`, the text of a skill
 * it loaded).
 */
function isCreatorPrompt(row: Record<string, unknown>): boolean {
  if (row.isMeta === true || !isRecord(row.message)) return false;
  const content = row.message.content;
  const typed = (text: string) => text.trim() !== "" && !HARNESS_TEXT.test(text.trimStart());
  if (typeof content === "string") return typed(content);
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) =>
      isRecord(block) &&
      block.type === "text" &&
      typeof block.text === "string" &&
      typed(block.text),
  );
}

/**
 * What the tool writes as a user line without the creator having typed it: the notice of a task
 * that ended, a reminder, the output of a local command, what the editor has open. It ends no skill.
 */
const HARNESS_TEXT =
  /^<(?:task-notification|system-reminder|local-command-[a-z]+|ide_[a-z_]+|artifact-[a-z-]+)(?![\w-])/;

/** A skill's name as the tool wrote it in a `Skill` call (`input.skill`), or undefined when it is none. */
export function skillNameOf(input: unknown): string | undefined {
  if (!isRecord(input) || typeof input.skill !== "string") return undefined;
  const name = input.skill.trim().replace(/^\//u, "");
  return /^[A-Za-z0-9._:-]{1,64}$/u.test(name) ? name : undefined;
}

/** The skills an answer's content calls through the tool's `Skill` call. */
function skillsCalledIn(content: unknown): { id: unknown; name: string }[] {
  if (!Array.isArray(content)) return [];
  const found: { id: unknown; name: string }[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "tool_use" || block.name !== "Skill") continue;
    const name = skillNameOf(block.input);
    if (name !== undefined) found.push({ id: block.id, name });
  }
  return found;
}

/**
 * A session's summary from its timed answers and the times of its lines: the models are the sum of
 * the answers model by model. Shared by the readers whose trace gives one record per answer
 * (Claude Code, Antigravity).
 */
export function summaryOfAnswers(
  answers: readonly TraceAnswer[],
  times: readonly number[],
): TraceSummary {
  return {
    ...span(times),
    active_ms: activeMs(times),
    models: mergeModels(answers.map((answer) => [answer.usage])),
    answers,
    times,
  };
}

/** What a Codex counter says: input (cached tokens included), cached input, output (reasoning included). */
interface CodexCounts {
  input: number;
  cached: number;
  output: number;
}

/**
 * The counters of one usage object. OpenAI counts the cached input inside `input_tokens`; the cached
 * count is `cached_input_tokens` (or `cached_tokens` in some versions). Reasoning tokens are part of
 * the output.
 */
function codexCounts(usage: unknown): CodexCounts | undefined {
  if (!isRecord(usage)) return undefined;
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  if (input === 0 && output === 0) return undefined;
  const cached = Math.min(input, count(usage.cached_input_tokens) || count(usage.cached_tokens));
  return { input, cached, output };
}

/**
 * Codex's rollout (`~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl`; the format is not
 * documented by the tool: read from what its public readers describe, then checked on real rollouts of Codex
 * 0.160.1 written against a stand-in model server, 2026-10-06: the shape is Codex's, the figures were
 * made up for the check). Two shapes:
 *
 * - the `token_count` events carry the running total of the session (`info.total_token_usage`),
 *   which an event repeats while nothing happens (`info: null` too): what a session consumed is the
 *   growth of that total between two events, counted for the model that `turn_context` named last;
 * - the newer per-response records (`token_usage_record`, with a `response_id`) carry one response's
 *   counters, counted once each (the largest of each counter when a record is written again). When a
 *   rollout holds some, they replace the running totals (a tool that writes both counts the same
 *   consumption twice).
 *
 * Cached input is read from the cache, the rest is new input. A rollout that fits neither shape
 * consumes nothing: no figure rather than a wrong one.
 */
export function readCodexRollout(text: string): TraceSummary {
  const times: number[] = [];
  let model = "unknown";
  let previous: CodexCounts | undefined;
  const totals = new Map<string, { messages: number } & CodexCounts>();
  const records = new Map<string, { model: string } & CodexCounts>();
  let anonymous = 0;
  const add = (name: string, delta: CodexCounts) => {
    const entry = totals.get(name) ?? { messages: 0, input: 0, cached: 0, output: 0 };
    totals.set(name, {
      messages: entry.messages + 1,
      input: entry.input + delta.input,
      cached: entry.cached + delta.cached,
      output: entry.output + delta.output,
    });
  };
  for (const row of lines(text)) {
    const at = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : Number.NaN;
    if (!Number.isNaN(at)) times.push(at);
    const payload = isRecord(row.payload) ? row.payload : undefined;
    if (payload === undefined) continue;
    if (row.type === "turn_context" && typeof payload.model === "string") model = payload.model;
    if (row.type === "event_msg" && payload.type === "token_count" && isRecord(payload.info)) {
      const total = codexCounts(payload.info.total_token_usage);
      if (total === undefined) continue;
      // A total that went down (a new baseline): what it holds is new.
      const grown =
        previous === undefined || total.input < previous.input || total.output < previous.output
          ? total
          : {
              input: total.input - previous.input,
              cached: Math.min(
                total.input - previous.input,
                Math.max(0, total.cached - previous.cached),
              ),
              output: total.output - previous.output,
            };
      previous = total;
      if (grown.input > 0 || grown.output > 0) add(model, grown);
    }
    if (row.type === "token_usage_record" || payload.type === "token_usage_record") {
      const counts = codexCounts(isRecord(payload.usage) ? payload.usage : payload);
      if (counts === undefined) continue;
      const id =
        typeof payload.response_id === "string" ? payload.response_id : `anonymous-${anonymous++}`;
      const before = records.get(id);
      records.set(
        id,
        before === undefined
          ? { model, ...counts }
          : {
              model: before.model,
              input: Math.max(before.input, counts.input),
              cached: Math.max(before.cached, counts.cached),
              output: Math.max(before.output, counts.output),
            },
      );
    }
  }
  const byModel = new Map<string, { messages: number } & CodexCounts>();
  if (records.size > 0) {
    for (const record of records.values()) {
      const entry = byModel.get(record.model) ?? { messages: 0, input: 0, cached: 0, output: 0 };
      byModel.set(record.model, {
        messages: entry.messages + 1,
        input: entry.input + record.input,
        cached: entry.cached + record.cached,
        output: entry.output + record.output,
      });
    }
  } else {
    for (const [name, entry] of totals) byModel.set(name, entry);
  }
  const models: UsageModel[] = [...byModel.entries()]
    .map(([name, entry]) => ({
      model: name,
      messages: entry.messages,
      tokens_in: Math.max(0, entry.input - entry.cached),
      tokens_out: entry.output,
      cache_read: entry.cached,
      cache_write: 0,
      cache_write_1h: 0,
    }))
    .sort((x, y) => (x.model < y.model ? -1 : 1));
  return { ...span(times), active_ms: activeMs(times), models, answers: [], times };
}

/** One slice of a session's time: from (included) to (excluded), milliseconds. */
export interface TimeSlice {
  readonly from: number;
  readonly to: number;
}

/** What a session consumed during a slice of its time. */
export interface SliceUsage {
  readonly models: UsageModel[];
  readonly active_ms: number;
  readonly started_at: string | null;
  readonly ended_at: string | null;
}

/** The sum of two lists of consumption, model by model, in a stable order. */
export function mergeModels(lists: readonly (readonly UsageModel[])[]): UsageModel[] {
  const merged = new Map<string, UsageModel>();
  for (const list of lists) {
    for (const usage of list) {
      const entry = merged.get(usage.model);
      merged.set(
        usage.model,
        entry === undefined
          ? { ...usage }
          : {
              model: usage.model,
              messages: entry.messages + usage.messages,
              tokens_in: entry.tokens_in + usage.tokens_in,
              tokens_out: entry.tokens_out + usage.tokens_out,
              cache_read: entry.cache_read + usage.cache_read,
              cache_write: entry.cache_write + usage.cache_write,
              cache_write_1h: entry.cache_write_1h + usage.cache_write_1h,
            },
      );
    }
  }
  return [...merged.values()].sort((a, b) => (a.model < b.model ? -1 : 1));
}

/**
 * What a session consumed in each slice: an answer belongs to the slice its end falls
 * in, a gap between two lines (under five minutes) to the slice of the later line. The slices
 * should cover the session without overlapping; what falls in none is left out (the caller adds a
 * slice for the rest). A trace without per-answer times (Codex's) gives its whole total to the
 * first slice that holds the session's start.
 */
export function sliceSummary(summary: TraceSummary, slices: readonly TimeSlice[]): SliceUsage[] {
  const at = (time: number) => slices.findIndex((slice) => time >= slice.from && time < slice.to);
  const models: UsageModel[][] = slices.map(() => []);
  const active = slices.map(() => 0);
  const first = slices.map(() => Number.POSITIVE_INFINITY);
  const last = slices.map(() => Number.NEGATIVE_INFINITY);
  if (summary.answers.length === 0 && summary.models.length > 0 && summary.started_at !== null) {
    const index = at(Date.parse(summary.started_at));
    if (index >= 0) {
      models[index] = [...summary.models];
      active[index] = summary.active_ms;
      first[index] = Date.parse(summary.started_at);
      last[index] = Date.parse(summary.ended_at ?? summary.started_at);
    }
    return finish(slices, models, active, first, last);
  }
  const opening = summary.started_at === null ? 0 : Date.parse(summary.started_at);
  for (const answer of summary.answers) {
    // An answer written without a time is the session's, whenever it came: it counts at the start.
    const index = at(answer.at > 0 ? answer.at : opening);
    if (index < 0) continue;
    (models[index] as UsageModel[]).push(answer.usage);
  }
  const sorted = [...summary.times].sort((a, b) => a - b);
  for (let index = 0; index < sorted.length; index += 1) {
    const time = sorted[index] as number;
    const slice = at(time);
    if (slice < 0) continue;
    if (time < (first[slice] as number)) first[slice] = time;
    if (time > (last[slice] as number)) last[slice] = time;
    const gap = index === 0 ? 0 : time - (sorted[index - 1] as number);
    if (gap > 0 && gap <= MAX_ACTIVE_GAP_MS) active[slice] = (active[slice] as number) + gap;
  }
  return finish(slices, models, active, first, last);
}

function finish(
  slices: readonly TimeSlice[],
  models: readonly (readonly UsageModel[])[],
  active: readonly number[],
  first: readonly number[],
  last: readonly number[],
): SliceUsage[] {
  return slices.map((_, index) => {
    const from = first[index] as number;
    const to = last[index] as number;
    return {
      models: mergeModels([models[index] as readonly UsageModel[]]),
      active_ms: active[index] as number,
      started_at: Number.isFinite(from) ? new Date(from).toISOString() : null,
      ended_at: Number.isFinite(to) ? new Date(to).toISOString() : null,
    };
  });
}
