import { canonicalBytes, fromUtf8 } from "@agentplugged/crypto";
import {
  CHAT_EVENT_TYPES,
  CHECKPOINT_DECIDED_EVENT_TYPES,
  CHECKPOINT_EVENT_TYPES,
  ELICITATION_EVENT_TYPES,
  ErrorCode,
  type EventEnvelope,
  HISTORY_COLUMNS,
  HISTORY_CSV_COLUMNS,
  type HistoryEntry,
  HUMAN_EVENT_TYPES,
  historyCsv,
  type IgnoredValidation,
  type ProjectionState,
  RESOLUTION_DECISIONS,
  STACK_EVENT_TYPES,
  StoryIdSchema,
  type ValidationDecision,
  WEB_ANSWER_EVENT_TYPES,
} from "@agentplugged/protocol";
import { AgentPluggedError } from "../errors.js";
import type { CheckpointState, ValidationEntry } from "../projection/checkpoint-reducers.js";
import type { HumanState } from "../projection/human-reducers.js";

// The row and the CSV text are the protocol's: the web view writes the same export.
export {
  HISTORY_COLUMNS,
  HISTORY_CSV_COLUMNS,
  type HistoryEntry,
  historyCsv,
  type IgnoredValidation,
};

/** What `history` keeps: one story, from a date on, one decision. */
export interface HistoryFilters {
  readonly story?: string;
  /** Milliseconds since the epoch: validations at this instant or later. */
  readonly since?: number;
  readonly decision?: ValidationDecision;
}

/** The export's format, chosen by the file's extension. */
export type HistoryFormat = "json" | "csv";

/** The decisions `--decision` filters on: the resolutions, and `reopened`. */
export const HISTORY_DECISIONS: readonly ValidationDecision[] = [
  ...RESOLUTION_DECISIONS,
  "reopened",
];

/** The events that answer a checkpoint: at the terminal, from the chat, by the engine. */
const ANSWER_TYPES: ReadonlySet<string> = new Set([
  CHECKPOINT_EVENT_TYPES.resolved,
  CHAT_EVENT_TYPES.answered,
  CHAT_EVENT_TYPES.autoApplied,
  CHAT_EVENT_TYPES.reopened,
  CHECKPOINT_DECIDED_EVENT_TYPES.decided,
  ELICITATION_EVENT_TYPES.answered,
  STACK_EVENT_TYPES.answered,
  WEB_ANSWER_EVENT_TYPES.answered,
]);

function invalid(reason: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", { reason });
}

/**
 * An ISO date (`2026-10-03`) or a date and time with its offset (`2026-10-03T12:00:00Z`,
 * `…T12:00+02:00`): a time without its offset is refused.
 */
const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2})))?$/;

/**
 * The instant of an ISO date given by the creator, or undefined: a date alone is midnight in the
 * local time zone; a date and time needs its offset (`Z` or `+02:00`). An impossible date
 * (`2026-02-30`, `25:00`) is refused. Years 0000 to 0099 are those years (never 1900 + year).
 */
export function parseSince(text: string): number | undefined {
  const match = ISO_DATE.exec(text);
  if (match === null) return undefined;
  const [, y, mo, d, hour, minute, second, offsetHour, offsetMinute] = match;
  const year = Number(y);
  const month = Number(mo) - 1;
  const day = Number(d);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month, day);
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month ||
    calendar.getUTCDate() !== day ||
    Number(hour ?? 0) > 23 ||
    Number(minute ?? 0) > 59 ||
    Number(second ?? 0) > 59 ||
    Number(offsetHour ?? 0) > 23 ||
    Number(offsetMinute ?? 0) > 59
  ) {
    return undefined;
  }
  if (hour === undefined) {
    const local = new Date(0);
    local.setFullYear(year, month, day);
    local.setHours(0, 0, 0, 0);
    return local.getTime();
  }
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * The filters of `history` from its input (`story`, `since`, `decision`), or `INVALID_ARGUMENTS`
 * naming the first value refused.
 */
export function parseHistoryFilters(
  input: Readonly<Record<string, unknown>>,
): HistoryFilters | AgentPluggedError {
  const filters: { story?: string; since?: number; decision?: ValidationDecision } = {};
  const { story, since, decision } = input;
  if (story !== undefined) {
    if (typeof story !== "string" || !StoryIdSchema.safeParse(story).success) {
      return invalid(`--story ${String(story)} (<epic>-<story>, for example 2-6)`);
    }
    filters.story = story;
  }
  if (since !== undefined) {
    const ms = typeof since === "string" ? parseSince(since) : undefined;
    if (ms === undefined) {
      return invalid(
        `--since ${String(since)} (an ISO date, 2026-10-03 for local midnight, or a date and time with its offset, 2026-10-03T12:00:00Z or 2026-10-03T14:00:00+02:00)`,
      );
    }
    filters.since = ms;
  }
  if (decision !== undefined) {
    if (
      typeof decision !== "string" ||
      !(HISTORY_DECISIONS as readonly string[]).includes(decision)
    ) {
      return invalid(`--decision ${String(decision)} (${HISTORY_DECISIONS.join(", ")})`);
    }
    filters.decision = decision as ValidationDecision;
  }
  return filters;
}

/** The export's format by the file's extension (case ignored), or undefined for another one. */
export function historyFormatOf(path: string): HistoryFormat | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".csv")) return "csv";
  return undefined;
}

/** ISO 8601 UTC with milliseconds (`toISOString`); the text as is when it is not a date. */
function isoUtc(text: string): string {
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? text : new Date(ms).toISOString();
}

function record<T>(state: ProjectionState, key: string): Readonly<Record<string, T>> {
  const value = state.state[key];
  return value !== null && typeof value === "object" ? (value as Record<string, T>) : {};
}

function own<T>(dictionary: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(dictionary, key) ? dictionary[key] : undefined;
}

/**
 * Most recent first: by date, then by event id (a ULID), both descending. An item without a valid
 * date comes after every dated one (then by event id): the order is always the same.
 */
function byRecency(a: { at: string; event: string }, b: { at: string; event: string }): number {
  const left = Date.parse(a.at);
  const right = Date.parse(b.at);
  const leftDated = !Number.isNaN(left);
  const rightDated = !Number.isNaN(right);
  if (leftDated !== rightDated) return leftDated ? -1 : 1;
  if (leftDated && left !== right) return right - left;
  return a.event < b.event ? 1 : a.event > b.event ? -1 : 0;
}

/**
 * When each endorsed creator key was endorsed: the date of the first `human.key_endorsed` the
 * projection did not ignore, naming that key, written by the creator its state names.
 */
function endorsementDates(
  state: ProjectionState,
  events: readonly EventEnvelope[],
): Map<string, string> {
  const humans = record<HumanState>(state, "humans");
  const ignored = new Set(state.ignored.map((entry) => entry.id));
  const dates = new Map<string, string>();
  for (const event of events) {
    if (event.type !== HUMAN_EVENT_TYPES.keyEndorsed || ignored.has(event.id)) continue;
    const device = (event.payload as { device?: unknown }).device;
    if (typeof device !== "string") continue;
    const human = own(humans, device);
    if (human?.trust !== "endorsed" || human.endorsed_by !== event.actor.device) continue;
    const known = dates.get(device);
    if (known === undefined || Date.parse(event.at) < Date.parse(known)) {
      dates.set(device, event.at);
    }
  }
  return dates;
}

/**
 * The validations of the projection (`state.validations[]`), most recent first, with the author's
 * trust, the checkpoint's type, risk, title and story, and a waiver's deadline (read from the
 * answer's event, by its id). Pure: the projection and the events it was computed from.
 */
export function historyEntries(
  state: ProjectionState,
  events: readonly EventEnvelope[],
): HistoryEntry[] {
  const validations = (state.state.validations ?? []) as readonly ValidationEntry[];
  const checkpoints = record<CheckpointState>(state, "checkpoints");
  const humans = record<HumanState>(state, "humans");
  const byId = new Map(events.map((event) => [event.id, event]));
  const endorsed = endorsementDates(state, events);
  const flagged = new Set(
    state.warnings.flatMap((warning) =>
      warning.code === "locale_on_high_risk" ? [warning.id] : [],
    ),
  );
  const entries = validations.map((validation): HistoryEntry => {
    const checkpoint = own(checkpoints, validation.checkpoint);
    const human = own(humans, validation.author);
    const payload = byId.get(validation.event)?.payload as { waiver_until?: unknown } | undefined;
    const waiver = typeof payload?.waiver_until === "string" ? payload.waiver_until : undefined;
    const endorsedAt = endorsed.get(validation.author);
    return {
      event: validation.event,
      at: isoUtc(validation.at),
      author: validation.author,
      author_trust: human === undefined || human.trust === "pending" ? null : human.trust,
      author_endorsed_at:
        human?.trust === "endorsed" && endorsedAt !== undefined ? isoUtc(endorsedAt) : null,
      source: validation.source,
      decision: validation.decision,
      option: validation.option,
      waiver_until:
        validation.decision === "waived" && waiver !== undefined ? isoUtc(waiver) : null,
      assurance: validation.assurance,
      locale_on_high_risk:
        flagged.has(validation.event) ||
        (checkpoint?.risk === "high" && validation.assurance === "locale"),
      checkpoint: validation.checkpoint,
      checkpoint_type: checkpoint?.type ?? null,
      checkpoint_risk: checkpoint?.risk ?? null,
      checkpoint_title: checkpoint?.title ?? null,
      story: checkpoint?.story ?? null,
      checkpoint_phase: checkpoint?.phase ?? null,
      quote: validation.quote ?? null,
      relayed_by: validation.relayed_by ?? null,
      channel: validation.channel ?? null,
      stack: validation.stack ?? null,
      via: validation.via ?? null,
    };
  });
  return entries.sort(byRecency);
}

/**
 * The answers the projection ignored (`not_human`, `unendorsed_human`, `already_resolved`,
 * `bad_signature`…), most recent first: each `checkpoint.resolved` of the events whose id the
 * projection lists as ignored, with its reason.
 */
export function ignoredValidations(
  state: ProjectionState,
  events: readonly EventEnvelope[],
): IgnoredValidation[] {
  const checkpoints = record<CheckpointState>(state, "checkpoints");
  const byId = new Map<string, EventEnvelope>();
  for (const event of events) {
    if (ANSWER_TYPES.has(event.type) && !byId.has(event.id)) {
      byId.set(event.id, event);
    }
  }
  const seen = new Set<string>();
  const ignored: IgnoredValidation[] = [];
  for (const entry of state.ignored) {
    const event = byId.get(entry.id);
    if (event === undefined || seen.has(entry.id)) continue;
    seen.add(entry.id);
    const payload = (event.payload ?? {}) as { checkpoint?: unknown; decision?: unknown };
    const checkpointId = typeof payload.checkpoint === "string" ? payload.checkpoint : null;
    const checkpoint = checkpointId === null ? undefined : own(checkpoints, checkpointId);
    const actor = (event.actor ?? {}) as { kind?: unknown; device?: unknown };
    ignored.push({
      event: event.id,
      at: typeof event.at === "string" ? isoUtc(event.at) : "",
      author: typeof actor.device === "string" ? actor.device : null,
      actor_kind: typeof actor.kind === "string" ? actor.kind : null,
      checkpoint: checkpointId,
      decision: typeof payload.decision === "string" ? payload.decision : null,
      story: checkpoint?.story ?? (typeof event.story === "string" ? event.story : null),
      reason: entry.reason,
    });
  }
  return ignored.sort(byRecency);
}

/** Keeps what the filters ask; a filter on a field the item lacks leaves it out. */
export function filterHistory<
  T extends { readonly at: string; readonly story: string | null; readonly decision: unknown },
>(items: readonly T[], filters: HistoryFilters): T[] {
  return items.filter((item) => {
    if (filters.story !== undefined && item.story !== filters.story) return false;
    if (filters.decision !== undefined && item.decision !== filters.decision) return false;
    if (filters.since !== undefined) {
      const at = Date.parse(item.at);
      if (Number.isNaN(at) || at < filters.since) return false;
    }
    return true;
  });
}

/**
 * The JSON export, the exact one: canonical JSON (RFC 8785), then `\n`. The array of the entries;
 * with the ignored answers (`--all`), `{ validations: [...], ignored: [...] }`.
 */
export function historyJson(
  entries: readonly HistoryEntry[],
  ignored: readonly IgnoredValidation[] | null = null,
): string {
  const value = ignored === null ? entries : { validations: entries, ignored };
  return `${fromUtf8(canonicalBytes(value))}\n`;
}
