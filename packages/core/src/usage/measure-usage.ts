import {
  type EventEnvelope,
  MAIN_SESSION_AGENT,
  type PhaseId,
  USAGE_EVENT_TYPES,
  type UsageBasis,
  type UsageMeasuredPayload,
  UsageMeasuredPayloadSchema,
  type UsageModel,
} from "@agentplugged/protocol";
import type { JournalListing, StateStore } from "../journal/state-store.js";
import { readAntigravityTranscript } from "./antigravity-reader.js";
import { readClaudeTranscript, readCodexRollout, type TraceSummary } from "./trace-readers.js";
import { partsOf, timelineOf } from "./usage-parts.js";
import type { UsageSessionState } from "./usage-rules.js";
import type { TraceFile } from "./usage-traces.js";

/**
 * Measuring the sessions of the AI tools: each trace is read by the engine, tied to
 * the story its agent worked on, and written to the journal as `usage.measured`. The tie comes
 * from the journal first (the agent that ran the session wrote events on that story while it
 * ran), then from the session's own title. A session tied to no story is still measured: the
 * product's total counts everything, so that nothing an agent does can hide its consumption by
 * leaving no trace in the journal.
 */

/** What the journal says an agent did: it wrote an event on a story at a time. */
export interface JournalFact {
  readonly agent: string;
  readonly story: string;
  readonly at: number;
}

/** A story's working copy, as `story.started` recorded it. */
export interface StoryFolder {
  readonly story: string;
  readonly agent: string;
  readonly worktree: string;
}

/** The facts the journal gives for the tie: who wrote on which story when, and where stories started. */
export function journalFacts(events: readonly EventEnvelope[]): {
  facts: JournalFact[];
  folders: StoryFolder[];
  /** The stories a sprint holds or a developer started: the only ones the writing of an agent may tie a session to. */
  stories: Set<string>;
  /** Every story an event names: a session's title may name one (« Lina · story 2-4 ») that was never planned. */
  seen: Set<string>;
} {
  const facts: JournalFact[] = [];
  const folders: StoryFolder[] = [];
  const stories = new Set<string>();
  const seen = new Set<string>();
  for (const event of events) {
    // A story is known once a sprint holds it or a developer started it: an agent cannot make one
    // up by writing on it.
    if (event.type === "sprint.planned") {
      const planned = (event.payload as { stories?: unknown } | undefined)?.stories;
      if (Array.isArray(planned)) {
        for (const entry of planned as { id?: unknown }[]) {
          if (typeof entry?.id === "string") stories.add(entry.id);
        }
      }
    }
    if (event.story === undefined) continue;
    seen.add(event.story);
    if (event.type === "story.started") {
      stories.add(event.story);
      const payload = event.payload as { agent?: unknown; worktree?: unknown } | undefined;
      if (typeof payload?.worktree === "string" && typeof payload.agent === "string") {
        folders.push({ story: event.story, agent: payload.agent, worktree: payload.worktree });
      }
    }
    if (event.actor.kind !== "agent" || event.actor.agent === undefined) continue;
    if (event.type === USAGE_EVENT_TYPES.measured) continue;
    const at = Date.parse(event.at);
    if (!Number.isNaN(at)) facts.push({ agent: event.actor.agent, story: event.story, at });
  }
  return { facts, folders, stories, seen };
}

/** The slack around a session's lines when looking for what its agent wrote: clocks of two tools. */
export const WINDOW_SLACK_MS = 2 * 60 * 1000;

/** A story id a session's title names (« Quentin · revue 4-3 »), not a sprint's or an epic's. */
export function storyNamedBy(
  description: string | undefined,
  known: ReadonlySet<string>,
): string | undefined {
  if (description === undefined) return undefined;
  for (const match of description.matchAll(/(?<![\w-])(\d{1,6}-\d{1,6})(?![\w-])/gu)) {
    const id = match[1] as string;
    const before = description.slice(0, match.index).trimEnd().toLowerCase();
    if (/(sprints?|epics?|épopées?)$/u.test(before)) continue;
    if (known.has(id)) return id;
  }
  return undefined;
}

/** The story a session belongs to, how it was found, and the agent that ran it. */
export interface Tie {
  readonly story: string | null;
  readonly agent: string;
  readonly basis: UsageBasis;
}

/**
 * Ties a trace to a story. In order: the story worktree it ran in; the story its title names (the
 * agent that started the session gave it, not the session itself), `journal` when the agent also
 * wrote on that story while it ran, `label` when it did not; the known story its agent wrote on
 * most while it ran; else none. An agent cannot move its cost by writing on another story: a title
 * that names one wins, and a story no sprint holds and no developer started is not known.
 */
export function tieOf(
  trace: TraceFile,
  summary: TraceSummary,
  journal: {
    facts: readonly JournalFact[];
    folders: readonly StoryFolder[];
    stories: ReadonlySet<string>;
    seen: ReadonlySet<string>;
  },
): Tie {
  const agent = trace.agent_type ?? MAIN_SESSION_AGENT;
  if (trace.worktree !== undefined) {
    const folder = journal.folders.find((item) => item.worktree === trace.worktree);
    if (folder !== undefined) {
      return { story: folder.story, agent: trace.agent_type ?? folder.agent, basis: "journal" };
    }
  }
  if (trace.kind !== "sub" || trace.agent_type === undefined) {
    return { story: null, agent, basis: "none" };
  }
  const counts = new Map<string, number>();
  if (summary.started_at !== null && summary.ended_at !== null) {
    const from = Date.parse(summary.started_at) - WINDOW_SLACK_MS;
    const to = Date.parse(summary.ended_at) + WINDOW_SLACK_MS;
    for (const fact of journal.facts) {
      if (fact.agent !== trace.agent_type || fact.at < from || fact.at > to) continue;
      if (!journal.stories.has(fact.story)) continue;
      counts.set(fact.story, (counts.get(fact.story) ?? 0) + 1);
    }
  }
  const named = storyNamedBy(trace.description, journal.seen);
  if (named !== undefined) {
    return { story: named, agent, basis: counts.has(named) ? "journal" : "label" };
  }
  let best: string | undefined;
  for (const [story, seen] of [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (best === undefined || seen > (counts.get(best) as number)) best = story;
  }
  if (best !== undefined) return { story: best, agent, basis: "journal" };
  return { story: null, agent, basis: "none" };
}

/** A trace read by the reader of its tool. */
function readTrace(trace: TraceFile): TraceSummary {
  if (trace.source === "codex") return readCodexRollout(trace.text);
  if (trace.source === "antigravity") return readAntigravityTranscript(trace.text, trace.model);
  return readClaudeTranscript(trace.text);
}

/** One session, read and tied. */
export interface MeasuredSession {
  readonly story: string | null;
  readonly payload: UsageMeasuredPayload;
}

/** The sessions measured, and how many traces could not be (unreadable, or breaking a schema). */
export interface Measured {
  readonly sessions: MeasuredSession[];
  readonly skipped: number;
}

/**
 * Reads and ties every trace. A trace with no answer of a model (nothing consumed) is left out, a
 * trace that could not be read is counted (`skipped`) and never stops the others, a session found
 * twice (the product's folder and a story's working copy) counts once, the working copy's tie
 * first, and a trace the adapter says did not change since it was measured is not read again.
 */
export function measureTraces(
  traces: readonly TraceFile[],
  events: readonly EventEnvelope[],
  phaseAt: (time: number) => PhaseId | undefined = () => undefined,
  phaseEnds: readonly number[] = [],
): Measured {
  const journal = journalFacts(events);
  const timeline = timelineOf(events);
  const once = new Map<string, TraceFile>();
  for (const trace of traces) {
    if (trace.unchanged === true) continue;
    const key = `${trace.source}:${trace.id}`;
    const seen = once.get(key);
    if (seen === undefined || (seen.worktree === undefined && trace.worktree !== undefined)) {
      once.set(key, trace);
    }
  }
  const sessions: MeasuredSession[] = [];
  let skipped = 0;
  for (const trace of once.values()) {
    try {
      const summary = readTrace(trace);
      if (summary.models.length === 0 || summary.started_at === null || summary.ended_at === null) {
        continue;
      }
      const tie = tieOf(trace, summary, journal);
      const parts = partsOf({ trace, summary, tie, timeline, phaseAt, phaseEnds });
      const payload = {
        source: trace.source,
        session: trace.id,
        agent: tie.agent,
        basis: tie.basis,
        started_at: summary.started_at,
        ended_at: summary.ended_at,
        active_ms: summary.active_ms,
        models: summary.models,
      };
      const withParts = { ...payload, parts };
      // A tool's own names are not always an agent's id (a plug-in's `brand-voice:writer`): such a
      // session is the creator's tool at work, counted under `main`.
      // The parts are an addition: a session whose parts break the schema is measured without them.
      const asMain = parts.map((part) =>
        part.agent === tie.agent ? { ...part, agent: MAIN_SESSION_AGENT } : part,
      );
      const attempts = [
        withParts,
        payload,
        { ...payload, agent: MAIN_SESSION_AGENT, parts: asMain },
        { ...payload, agent: MAIN_SESSION_AGENT },
      ];
      const accepted = attempts
        .map((attempt) => UsageMeasuredPayloadSchema.safeParse(attempt))
        .find((attempt) => attempt.success) ?? { success: false as const };
      if (accepted.success && "data" in accepted) {
        sessions.push({ story: tie.story, payload: accepted.data });
      } else {
        skipped += 1;
      }
    } catch {
      skipped += 1;
    }
  }
  return { sessions, skipped };
}

/** The same consumption model by model, whatever the order of the fields (the journal sorts them). */
function sameModels(a: readonly UsageModel[], b: readonly UsageModel[]): boolean {
  return (
    a.length === b.length &&
    a.every((one, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        one.model === other.model &&
        one.messages === other.messages &&
        one.tokens_in === other.tokens_in &&
        one.tokens_out === other.tokens_out &&
        one.cache_read === other.cache_read &&
        one.cache_write === other.cache_write &&
        one.cache_write_1h === other.cache_write_1h
      );
    })
  );
}

/** A value as text with its keys in order: the journal stores canonical JSON, which sorts them. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "object" && item !== null && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([x], [y]) => (x < y ? -1 : 1)))
      : item,
  );
}

/** True when the journal already holds this measure of the session, to the last token. */
export function sameMeasure(
  measured: MeasuredSession,
  held: UsageSessionState | undefined,
): boolean {
  if (held === undefined) return false;
  const { payload } = measured;
  return (
    held.story === measured.story &&
    held.agent === payload.agent &&
    held.basis === payload.basis &&
    held.started_at === payload.started_at &&
    held.ended_at === payload.ended_at &&
    held.active_ms === payload.active_ms &&
    sameModels(held.models, payload.models) &&
    canonical(held.parts ?? null) === canonical(payload.parts ?? null)
  );
}

/** What a measure wrote. */
export interface MeasureResult {
  /** The sessions measured in the traces read this time. */
  readonly read: number;
  /** Traces that could not be measured (unreadable, or breaking a schema): said, never silent. */
  readonly skipped: number;
  /** The sessions written: new, or changed since their last measure. */
  readonly written: number;
  /** The stories whose measure changed. */
  readonly stories: readonly string[];
}

/**
 * Measures the traces and writes what is new or changed, in one append, as the engine itself
 * (`actor.kind: system`). `held` is what the journal already holds (decrypted). A re-measure that
 * holds fewer tokens than the one held (a trace cut or rewritten) never replaces it: a session's
 * cost only grows. Writes nothing when nothing changed.
 */
export async function writeMeasures(input: {
  readonly journal: StateStore;
  readonly product: string;
  readonly listing: JournalListing;
  readonly traces: readonly TraceFile[];
  readonly held: Readonly<Record<string, UsageSessionState>>;
  /** The phase current at a time, from the journal's approved `phase_end` checkpoints. */
  readonly phaseAt?: (time: number) => PhaseId | undefined;
  /** The times the approved ends of phase closed a phase. */
  readonly phaseEnds?: readonly number[];
}): Promise<MeasureResult> {
  const { sessions, skipped } = measureTraces(
    input.traces,
    input.listing.events,
    input.phaseAt,
    input.phaseEnds,
  );
  const changed = sessions.filter((session) => {
    const key = `${session.payload.source}:${session.payload.session}`;
    const held = Object.hasOwn(input.held, key) ? input.held[key] : undefined;
    if (
      held !== undefined &&
      held.started_at === session.payload.started_at &&
      tokensOf(session.payload.models) < tokensOf(held.models)
    ) {
      return false;
    }
    return !sameMeasure(session, held);
  });
  if (changed.length > 0) {
    await input.journal.appendAll(
      changed.map((session) => ({
        type: USAGE_EVENT_TYPES.measured,
        actor: { kind: "system" as const },
        product: input.product,
        ...(session.story === null ? {} : { story: session.story }),
        provenance: "trusted" as const,
        payload: { ...session.payload },
      })),
    );
  }
  return {
    read: sessions.length,
    skipped,
    written: changed.length,
    stories: [
      ...new Set(changed.flatMap((session) => (session.story === null ? [] : [session.story]))),
    ].sort(),
  };
}

/** Every token a session consumed, of every kind. */
function tokensOf(models: readonly UsageModel[]): number {
  return models.reduce(
    (total, usage) =>
      total + usage.tokens_in + usage.tokens_out + usage.cache_read + usage.cache_write,
    0,
  );
}
