import { TOOL_GROUPS } from "./mcp-tools.js";
import { isRecord } from "./values.js";

/**
 * The answers of the grouped tools, limited to the essential. The creator's rule: the
 * answers of the tools carry what the next step needs, no more; the summaries of the end of a
 * story and the essential information are what matter.
 *
 * - A **write** answers with its identifier and nothing else (`ack`): never the object back,
 *   never a timestamp, never the type of the event it wrote.
 * - A **read** answers with what makes the agent act or decide; what is empty, null or fixed by
 *   the settings and already known is not sent, and a warning is said once per session.
 * - A **decision** (an answer that tells the agent what to do next) keeps its fields, minus the
 *   empty ones and the references to the events written.
 *
 * Nothing is lost: the detail is one call away (`state.get` with an option, `review.get`…), and
 * the journal keeps everything the engine wrote. This module only shapes what is sent back to an
 * agent; the commands, their validations and their events are untouched.
 */
export type ResponseKind = "ack" | "read" | "decision";

export interface ResponseForm {
  readonly kind: ResponseKind;
  /** The largest answer of the action on the sample of the tests, in characters. */
  readonly max: number;
}

const ACK = { kind: "ack", max: 120 } as const satisfies ResponseForm;

/** « tool.action -> form of its answer », the single source of what each answer may weigh. */
export const RESPONSE_FORMS: Readonly<Record<string, ResponseForm>> = {
  "state.get": { kind: "read", max: 2_000 },
  "state.next": { kind: "read", max: 1_500 },
  "state.trace": { kind: "read", max: 4_000 },
  "state.merge_order": { kind: "read", max: 800 },
  "state.environment": { kind: "read", max: 1_200 },
  "checkpoint.open": { kind: "decision", max: 600 },
  "checkpoint.decide": { kind: "decision", max: 400 },
  "checkpoint.measures": ACK,
  "checkpoint.gap": ACK,
  "chat.answer": { kind: "decision", max: 500 },
  "chat.ask": { kind: "decision", max: 1_500 },
  "chat.stack_open": { kind: "decision", max: 800 },
  "chat.stack_ask": { kind: "decision", max: 1_500 },
  "chat.stack_answer": { kind: "decision", max: 500 },
  "chat.table": { kind: "decision", max: 4_800 },
  "story.start": { kind: "decision", max: 600 },
  "story.status": ACK,
  "story.progress": ACK,
  "story.result": ACK,
  "story.pr": { kind: "decision", max: 500 },
  "story.ci": { kind: "decision", max: 600 },
  "story.deviation": ACK,
  "story.lift_deviation": ACK,
  "story.leave_fast_track": ACK,
  "story.criterion": { kind: "decision", max: 1_600 },
  "story.loop": { kind: "decision", max: 700 },
  "story.merge_conflict": { kind: "decision", max: 500 },
  "review.start": { kind: "decision", max: 600 },
  "review.submit": { kind: "decision", max: 500 },
  "review.triage": { kind: "decision", max: 500 },
  "review.get": { kind: "read", max: 2_500 },
  "review.publish": { kind: "decision", max: 500 },
  "review.audit": ACK,
  "review.critique": { kind: "decision", max: 2_600 },
  "review.ready": { kind: "decision", max: 2_600 },
  "review.tests": { kind: "decision", max: 4_000 },
  "review.qa": { kind: "decision", max: 1_500 },
  "review.export": { kind: "decision", max: 500 },
  "agent.status": ACK,
  "agent.delegate": { kind: "decision", max: 300 },
  "agent.summarize": ACK,
  "agent.pause": ACK,
  "agent.workshop": { kind: "read", max: 2_400 },
  "guard.request": { kind: "decision", max: 300 },
  "guard.check": { kind: "decision", max: 300 },
  "guard.write": { kind: "decision", max: 500 },
  "guard.call": { kind: "decision", max: 500 },
  "guard.external_read": ACK,
  "guard.creator_action": { kind: "decision", max: 800 },
  "guard.read_sensitive": { kind: "read", max: 8_000 },
  "guard.write_sensitive": ACK,
  "plan.sprint": { kind: "decision", max: 800 },
  "plan.course": { kind: "decision", max: 2_600 },
  "plan.defer": ACK,
  "plan.complete_deferred": ACK,
  "memory.read": { kind: "read", max: 3_000 },
  "memory.retrospective": { kind: "decision", max: 800 },
  "memory.record": ACK,
  "memory.promote_propose": { kind: "decision", max: 800 },
  "memory.promote": ACK,
  "measure.cost": ACK,
  "measure.usage": { kind: "read", max: 800 },
  "measure.requirements": { kind: "read", max: 700 },
  "measure.proof": ACK,
  "measure.run": { kind: "decision", max: 1_500 },
};

type Json = Record<string, unknown>;

/** What an agent was already told in this session (a warning, a hint): said once. */
export class ResponseMemory {
  readonly #said = new Set<string>();

  /** True the first time `key` is asked, false after. */
  once(key: string): boolean {
    if (this.#said.has(key)) return false;
    this.#said.add(key);
    return true;
  }
}

/** A reference to an event the engine wrote: `{ id, at }` or `{ id, type, at }`. */
function isEventRef(value: Json): boolean {
  const keys = Object.keys(value);
  return (
    typeof value.id === "string" &&
    typeof value.at === "string" &&
    keys.every((key) => key === "id" || key === "type" || key === "at")
  );
}

/**
 * `value` without what says nothing: null, undefined, empty strings, arrays and objects, and the
 * references to events (`{ id, type, at }`) reduced to their identifier. `false` and `0` stay:
 * they say something.
 */
export function compact(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(compact).filter((item) => !isEmpty(item));
    return items;
  }
  if (!isRecord(value)) return value;
  if (isEventRef(value)) return { id: value.id };
  const out: Json = {};
  for (const [key, field] of Object.entries(value)) {
    const kept = compact(field);
    if (isEmpty(kept)) continue;
    // `event: { id }` is the identifier alone.
    out[key] =
      key === "event" && isRecord(kept) && Object.keys(kept).join() === "id" ? kept.id : kept;
  }
  return out;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.keys(value).length === 0;
  return false;
}

function without(source: Json, keys: readonly string[]): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(source)) if (!keys.includes(key)) out[key] = value;
  return out;
}

/** True when `a` and `b` say the same (key order aside). */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortedKeys(a)) === JSON.stringify(sortedKeys(b));
}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedKeys(value[key])]),
  );
}

const cut = (text: string, length: number): string =>
  text.length <= length ? text : `${text.slice(0, length - 1)}…`;

/** The settings blocks of `state.get` and `state.next`, without what is fixed or already known. */
function settingsOf(value: Json, keepChannels: boolean): Json {
  const out: Json = { ...value };
  const validation = value.validation;
  if (isRecord(validation)) {
    const kept: Json = { mode: validation.mode, points: validation.points };
    if (validation.unpublished !== undefined) kept.unpublished = validation.unpublished;
    if (validation.warning !== undefined) kept.warning = validation.warning;
    if (keepChannels && validation.channels !== undefined) kept.channels = validation.channels;
    out.validation = kept;
  }
  const git = value.git;
  if (isRecord(git) && isRecord(git.recommended)) {
    // The recommendation is said where it differs from what is in force; the same says nothing.
    const recommended = git.recommended;
    const differs = Object.keys(recommended).some((key) => !same(recommended[key], git[key]));
    out.git = differs ? git : without(git, ["recommended"]);
  }
  const installs = value.installs;
  if (isRecord(installs)) out.installs = without(installs, ["source"]);
  return out;
}

/** The engine's own backup of the journal: its state, and the instruction once per session. */
function backupOf(value: unknown, memory: ResponseMemory): unknown {
  if (!isRecord(value)) return value;
  const status = String(value.status ?? "");
  const kept: Json = { status };
  if (typeof value.reason === "string") kept.reason = cut(value.reason, 80);
  if (typeof value.action === "string" && memory.once(`journal_backup:${status}`)) {
    kept.action = value.action;
  }
  return kept;
}

/** Warnings not yet said in this session, and the hint on how to read more, once. */
function sayOnce(value: Json, memory: ResponseMemory, tool: string): Json {
  const out: Json = { ...value };
  if (Array.isArray(value.warnings)) {
    out.warnings = value.warnings.filter((warning) =>
      memory.once(`warning:${JSON.stringify(warning)}`),
    );
  }
  if (typeof value.more === "string" && !memory.once(`more:${tool}`)) delete out.more;
  return out;
}

/** Bookkeeping keys of the detail views: when and by which device, hashes, relays. */
const BOOKKEEPING = new Set([
  "at",
  "opened_at",
  "event",
  "device",
  "base_ref",
  "base",
  "body_sha256",
  "abridged",
  "relayed_by",
  "channel",
]);

/** `value` without the bookkeeping keys, at any depth; a `resolution` also loses its `source`. */
function withoutBookkeeping(value: unknown, inResolution = false): unknown {
  if (Array.isArray(value)) return value.map((item) => withoutBookkeeping(item, inResolution));
  if (!isRecord(value)) return value;
  const out: Json = {};
  for (const [key, field] of Object.entries(value)) {
    if (BOOKKEEPING.has(key) || (inResolution && key === "source")) continue;
    out[key] = withoutBookkeeping(field, key === "resolution");
  }
  return out;
}

/** The commits a CI status and a pull request are about, cut to the length Git itself shows. */
function shortCommits(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shortCommits);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key,
      (key === "commit" || key === "head") && typeof field === "string"
        ? field.slice(0, 12)
        : shortCommits(field),
    ]),
  );
}

/** One line for a checkpoint that is over: what it was and how it ended. */
function settledLine(point: Json): string {
  const resolution = isRecord(point.resolution) ? point.resolution : {};
  const how = [resolution.decision, resolution.option, resolution.note].filter(
    (part) => typeof part === "string",
  );
  // A refused point keeps the actions it blocked: the line says so, the point has the detail.
  const blocks = point.blocks_lifted === false && point.blocks_count !== undefined;
  return [
    point.id,
    point.type,
    point.risk,
    point.status,
    how.length === 0 ? "" : how.join(" · "),
    blocks ? "blocks kept" : "",
    String(point.title ?? ""),
  ]
    .filter((part) => part !== "" && part !== undefined)
    .join(" · ");
}

/** The checkpoints of a story's detail: the open ones whole, the settled ones in a line each. */
function settledAsLines(points: unknown): unknown {
  const line = (point: unknown) =>
    isRecord(point) && point.status !== "open" && point.status !== undefined
      ? settledLine(point)
      : point;
  if (Array.isArray(points)) return points.map(line);
  if (!isRecord(points)) return points;
  return Object.fromEntries(Object.entries(points).map(([id, point]) => [id, line(point)]));
}

function stateGet(value: Json, memory: ResponseMemory): Json {
  // The detail of a story, minus the bookkeeping (times, devices, hashes), with the settled
  // checkpoints told in a line; the page of checkpoints keeps each one whole (its documents, what
  // it supersedes), minus the bookkeeping.
  if (value.detail === "story" || value.detail === "checkpoints") {
    const detail = shortCommits(withoutBookkeeping(value)) as Json;
    if (value.detail === "story") detail.checkpoints = settledAsLines(detail.checkpoints);
    return detail;
  }
  let out = without(value, ["detail", "agents_idle", "session_trusted"]);
  if (value.session_trusted === false) out.session_trusted = false;
  if (isRecord(value.clock)) {
    out.clock = { now_local: value.clock.now_local, time_zone: value.clock.time_zone };
  }
  out = settingsOf(out, false);
  out.journal_backup = backupOf(value.journal_backup, memory);
  return sayOnce(out, memory, "state.get");
}

function stateNext(value: Json, memory: ResponseMemory): Json {
  let out = without(value, ["agent_name", "phases", "you"]);
  if (value.you === true) out.you = true;
  out = settingsOf(out, true);
  if (isRecord(out.validation)) out.validation = without(out.validation, []);
  out.journal_backup = backupOf(value.journal_backup, memory);
  // The offer of a critique is said once per session (the engine remembers it per
  // version of the document once Noah records it).
  if (isRecord(value.critique) && !memory.once(`critique:${JSON.stringify(value.critique)}`)) {
    delete out.critique;
  }
  // The same for the offer of the three views of a sensitive story.
  if (isRecord(value.table) && !memory.once(`table:${JSON.stringify(value.table)}`)) {
    delete out.table;
  }
  return sayOnce(out, memory, "state.next");
}

function dropZeroTotals(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropZeroTotals);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, field]) => !(key.endsWith("_total") && field === 0))
      .map(([key, field]) => [key, dropZeroTotals(field)]),
  );
}

/** The overview of the trace: one line of counts per requirement, its text cut short. */
function stateTrace(value: Json): Json {
  if (!Array.isArray(value.requirements)) return value;
  return {
    ...value,
    requirements: value.requirements.map((requirement) => {
      if (!isRecord(requirement)) return requirement;
      const out: Json = { ...requirement };
      for (const key of ["tests", "pull_requests", "deviations"]) {
        if (requirement[key] === 0) delete out[key];
      }
      return out;
    }),
  };
}

/**
 * The answer of the action `tool.action` as it is sent to the agent: the engine's value, limited
 * to the essential. `memory` is the session's: what it already said is not repeated.
 */
export function shapeResponse(
  tool: string,
  action: string,
  value: unknown,
  memory: ResponseMemory,
): unknown {
  const form = RESPONSE_FORMS[`${tool}.${action}`];
  if (form === undefined || !isRecord(value)) return value;
  let shaped: Json = value;
  if (tool === "state" && action === "get") {
    // The other options (`agent`, `checkpoint`, `delegations`, `full`) are the detail asked for, whole.
    if (!["summary", "story", "checkpoints"].includes(String(value.detail))) return value;
    shaped = stateGet(value, memory);
  } else if (tool === "state" && action === "next") shaped = stateNext(value, memory);
  else if (tool === "state" && action === "trace") shaped = stateTrace(value);
  const compacted = compact(dropZeroTotals(shaped));
  if (!isRecord(compacted)) return compacted;
  if (tool === "state" && action === "next") return withoutIdleBlocks(compacted);
  return withoutEventNoise(compacted);
}

/** `state.next`: the morning's report and the pile of waiting points, only when they hold something. */
function withoutIdleBlocks(value: Json): Json {
  const out: Json = { ...value };
  const morning = value.morning;
  if (isRecord(morning) && Object.keys(morning).every((key) => key === "since")) delete out.morning;
  const pile = value.pile;
  if (isRecord(pile) && Object.values(pile).every((field) => field === 0 || isEmpty(field))) {
    delete out.pile;
  }
  return out;
}

/**
 * The answer of a write: the identifier of the event, and the identifiers it created (the
 * checkpoint it opened, the sprint, the deferred item…). The type of the event and its time say
 * nothing the next step needs.
 */
function withoutEventNoise(value: Json): Json {
  if (typeof value.id !== "string" || typeof value.type !== "string") return value;
  if (typeof value.at !== "string") return value;
  return without(value, ["type", "at"]);
}

/** Every action the server publishes has a form, and none is left over. */
export function responseFormsCover(): { missing: string[]; extra: string[] } {
  const published = Object.entries(TOOL_GROUPS).flatMap(([tool, group]) =>
    Object.keys(group.actions).map((action) => `${tool}.${action}`),
  );
  return {
    missing: published.filter((name) => RESPONSE_FORMS[name] === undefined),
    extra: Object.keys(RESPONSE_FORMS).filter((name) => !published.includes(name)),
  };
}
