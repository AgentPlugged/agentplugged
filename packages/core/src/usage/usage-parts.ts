import {
  AGENT_EVENT_TYPES,
  CHECKPOINT_EVENT_TYPES,
  checkpointIdOf,
  DELEGATION_EVENT_TYPES,
  type EventEnvelope,
  MAIN_SESSION_AGENT,
  NOAH_AGENT,
  type PhaseId,
  type UsagePart,
  type UsageSkillAttribution,
  type UsageWork,
} from "@agentplugged/protocol";
import { isRecord } from "../values.js";
import { mergeModels, sliceSummary, type TimeSlice, type TraceSummary } from "./trace-readers.js";
import {
  type SkillSpan,
  skillAt,
  skillBoundaries,
  stepOf,
  toolSkillSpans,
} from "./usage-attribution.js";
import type { TraceFile } from "./usage-traces.js";

/**
 * What each part of a measured session served: the engine cuts a session where the
 * journal says the work changed hands, and ties each part to its agent, its phase and its work (a
 * document, a point for the creator, a handover, a story). Only data: nothing here adds a cost
 * nor shows one; a module may read the parts and do what it wants with them.
 *
 * The journal is the only source. Noah hands a conversation over to an agent (`agent.delegated`,
 * `conversation`): from then on the creator talks to that agent, until it returns its result
 * (`agent.result_recorded`); the rest of the conversation is Noah's. An agent that Noah ran as a
 * sub-agent is tied to the handover that started it. An agent never chooses the label of its own
 * consumption: the handover is Noah's, the documents and points are the ones it recorded, and a
 * story's agent is tied by the story tie of `measure-usage`.
 */

/** A handover from Noah, as `agent.delegated` recorded it. */
export interface Handover {
  readonly id: string;
  readonly at: number;
  readonly to: string;
  readonly kind: "agent" | "skill";
  readonly mode: "conversation" | "autonomous";
  readonly brief: string;
  readonly story: string | undefined;
}

/** A point for the creator an agent opened: its id, its title and the documents it cites. */
export interface Opening {
  readonly agent: string;
  readonly at: number;
  readonly checkpoint: string;
  readonly title: string;
  readonly documents: readonly string[];
}

/** What the journal says of who did what when, for cutting sessions. */
export interface Timeline {
  readonly handovers: readonly Handover[];
  readonly openings: readonly Opening[];
  /** The times an agent recorded a result, and every time it wrote anything. */
  readonly results: readonly { readonly agent: string; readonly at: number }[];
  readonly writes: readonly { readonly agent: string; readonly at: number }[];
  /**
   * The skills an agent reported starting (`report_status` with a `skill`), each until
   * that agent's next status report or result, else until its last write: begin and end are the
   * journal's, the span is deduced from them.
   */
  readonly skills: readonly SkillSpan[];
}

/** The timeline of a journal's clear events (sensitive payloads are not needed). */
export function timelineOf(events: readonly EventEnvelope[]): Timeline {
  const handovers: Handover[] = [];
  const openings: Opening[] = [];
  const results: { agent: string; at: number }[] = [];
  const writes: { agent: string; at: number }[] = [];
  const marks: { agent: string; at: number; skill: string | undefined }[] = [];
  for (const event of events) {
    const at = Date.parse(event.at);
    if (Number.isNaN(at)) continue;
    const payload = isRecord(event.payload) ? event.payload : undefined;
    const agent = event.actor.kind === "agent" ? event.actor.agent : undefined;
    if (agent !== undefined) writes.push({ agent, at });
    // Only Noah hands work over (`delegate` refuses any other): a handover another agent wrote moves nothing.
    if (
      event.type === DELEGATION_EVENT_TYPES.delegated &&
      payload !== undefined &&
      agent === NOAH_AGENT
    ) {
      if (typeof payload.to === "string" && typeof payload.brief === "string") {
        handovers.push({
          id: event.id,
          at,
          to: payload.to,
          kind: payload.kind === "skill" ? "skill" : "agent",
          mode: payload.mode === "conversation" ? "conversation" : "autonomous",
          brief: payload.brief,
          story: event.story,
        });
      }
    }
    if (agent === undefined) continue;
    if (event.type === AGENT_EVENT_TYPES.resultRecorded) {
      results.push({ agent, at });
      marks.push({ agent, at, skill: undefined });
    }
    if (event.type === AGENT_EVENT_TYPES.statusReported) {
      const skill = typeof payload?.skill === "string" ? payload.skill : undefined;
      marks.push({ agent, at, skill });
    }
    if (event.type === CHECKPOINT_EVENT_TYPES.opened && payload !== undefined) {
      const documents = Array.isArray(payload.documents)
        ? payload.documents.flatMap((cited) =>
            isRecord(cited) && typeof cited.path === "string" ? [cited.path] : [],
          )
        : [];
      openings.push({
        agent,
        at,
        checkpoint: checkpointIdOf(event.id),
        title: typeof payload.title === "string" ? payload.title : "",
        documents,
      });
    }
  }
  return { handovers, openings, results, writes, skills: journalSkillSpans(marks, writes) };
}

/** The spans of the skills agents reported starting: until the same agent's next report or result. */
function journalSkillSpans(
  marks: readonly { agent: string; at: number; skill: string | undefined }[],
  writes: readonly { agent: string; at: number }[],
): SkillSpan[] {
  const spans: SkillSpan[] = [];
  for (const [index, mark] of marks.entries()) {
    if (mark.skill === undefined) continue;
    const next = marks
      .slice(index + 1)
      .find((other) => other.agent === mark.agent && other.at >= mark.at);
    const last = writes
      .filter((write) => write.agent === mark.agent && write.at >= mark.at)
      .reduce((latest, write) => Math.max(latest, write.at), mark.at);
    spans.push({
      from: mark.at,
      to: next === undefined ? last + CLOSE_SLACK_MS : next.at,
      skill: mark.skill,
      origin: "interval",
      agent: mark.agent,
    });
  }
  return spans.filter((span) => span.to > span.from);
}

/** The slack after an agent's result: the last message of its turn is still its own. */
const CLOSE_SLACK_MS = 30_000;

/** How far before a sub-agent session started its handover may have been recorded. */
const HANDOVER_LEAD_MS = 15 * 60 * 1000;

/** The words of a text cut to `max` characters, on one line. */
function clip(text: string, max: number): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** A document's key: its file's name without its extension (`.agentplugged/docs/prd.md` → `prd`). */
export function documentKey(path: string): string {
  const name = path.replaceAll("\\", "/").split("/").pop() ?? path;
  const stem = name.replace(/\.[^.]+$/u, "").toLowerCase();
  return clip(stem === "" ? name : stem, 128);
}

/**
 * The work an agent did between `from` and `to`, from what it recorded in the journal: the
 * document it asked the creator to read (the last it cites), else the point it opened, else the
 * handover that started it, else the session's own title or nothing but its agent.
 */
export function workOf(
  timeline: Timeline,
  agent: string,
  from: number,
  to: number,
  handover: Handover | undefined,
  title: string | undefined,
): UsageWork {
  const mine = timeline.openings
    .filter((opening) => opening.agent === agent && opening.at >= from && opening.at <= to)
    .sort((a, b) => a.at - b.at);
  const document = mine.find((opening) => opening.documents.length > 0);
  if (document !== undefined) {
    return { kind: "document", key: documentKey(document.documents.at(-1) as string) };
  }
  const point = mine[0];
  if (point !== undefined) {
    return {
      kind: "checkpoint",
      key: point.checkpoint,
      ...(point.title === "" ? {} : { label: clip(point.title, 200) }),
    };
  }
  if (handover !== undefined) {
    return { kind: "delegation", key: handover.id, label: clip(handover.brief, 200) };
  }
  const named = title === undefined ? "" : clip(title, 128);
  return {
    kind: "session",
    key: named === "" ? agent : named,
    ...(named === "" ? {} : { label: named }),
  };
}

/** The handover that started a sub-agent's session: the nearest one to that agent just before it. */
function handoverOf(
  timeline: Timeline,
  agent: string,
  from: number,
  to: number,
): Handover | undefined {
  let best: Handover | undefined;
  for (const handover of timeline.handovers) {
    if (handover.to !== agent || handover.mode !== "autonomous") continue;
    if (handover.at > to || handover.at < from - HANDOVER_LEAD_MS) continue;
    if (best === undefined || Math.abs(handover.at - from) < Math.abs(best.at - from)) {
      best = handover;
    }
  }
  return best;
}

/** One cut of a session: a time slice and what it served. */
interface Cut {
  readonly slice: TimeSlice;
  readonly agent: string;
  readonly work: UsageWork;
  readonly story: string | undefined;
  /** The skill the whole cut served, when the journal says it (a handover of Noah's to a skill). */
  readonly skill?: UsageSkillAttribution;
}

/**
 * The cuts of the creator's conversation: each handover of the conversation to an agent runs until
 * that agent returns its result (or, without a result, until its last write, or the next handover),
 * the rest is Noah's.
 */
function conversationCuts(timeline: Timeline): Cut[] {
  const handed = timeline.handovers
    .filter((handover) => handover.mode === "conversation" && handover.to !== NOAH_AGENT)
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  const cuts: Cut[] = [];
  let cursor = Number.NEGATIVE_INFINITY;
  const coordination = (from: number, to: number) => {
    if (to > from) {
      cuts.push({
        slice: { from, to },
        agent: NOAH_AGENT,
        work: { kind: "coordination", key: "conversation" },
        story: undefined,
      });
    }
  };
  for (const [index, handover] of handed.entries()) {
    const sameAgentNext = timeline.handovers
      .filter(
        (other) => other.to === handover.to && other.id !== handover.id && other.at > handover.at,
      )
      .map((other) => other.at);
    const next = Math.min(handed[index + 1]?.at ?? Number.POSITIVE_INFINITY, ...sameAgentNext);
    const start = Math.max(handover.at, cursor);
    const result = timeline.results.find(
      (item) => item.agent === handover.to && item.at >= handover.at && item.at < next,
    );
    let end: number;
    if (result !== undefined) {
      end = result.at + CLOSE_SLACK_MS;
    } else {
      const wrote = timeline.writes
        .filter((item) => item.agent === handover.to && item.at >= handover.at && item.at < next)
        .map((item) => item.at);
      end = wrote.length === 0 ? handover.at : Math.max(...wrote) + CLOSE_SLACK_MS;
    }
    end = Math.min(end, next);
    if (end <= start) continue;
    coordination(cursor, start);
    cuts.push({
      slice: { from: start, to: end },
      agent: handover.kind === "agent" ? handover.to : NOAH_AGENT,
      work: workOf(timeline, handover.to, handover.at, end, handover, undefined),
      story: handover.story,
      ...(handover.kind === "skill"
        ? { skill: { name: handover.to, origin: "interval" as const } }
        : {}),
    });
    cursor = end;
  }
  coordination(cursor, Number.POSITIVE_INFINITY);
  return cuts;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC midnights strictly inside a session (at most a year of them). */
function midnightsBetween(start: number, end: number): number[] {
  const found: number[] = [];
  for (
    let day = (Math.floor(start / DAY_MS) + 1) * DAY_MS;
    day <= end && found.length < 366;
    day += DAY_MS
  ) {
    found.push(day);
  }
  return found;
}

/** What the tie of a session says of it, as `measure-usage` found it. */
export interface PartTie {
  readonly story: string | null;
  readonly agent: string;
}

/**
 * The parts of a session: the creator's conversation is cut where Noah handed it
 * over; a sub-agent's session is one part (its story, else its handover, else its title). Parts of
 * the same agent, phase, work and story are merged; their consumption adds up to the session's.
 */
export function partsOf(input: {
  readonly trace: TraceFile;
  readonly summary: TraceSummary;
  readonly tie: PartTie;
  readonly timeline: Timeline;
  readonly phaseAt: (time: number) => PhaseId | undefined;
  /** The times (milliseconds) the approved ends of phase closed a phase: a part never straddles one. */
  readonly phaseEnds?: readonly number[];
}): UsagePart[] {
  const { trace, summary, tie, timeline } = input;
  if (summary.started_at === null || summary.ended_at === null) return [];
  const start = Date.parse(summary.started_at);
  const end = Date.parse(summary.ended_at);
  let cuts: Cut[];
  if (trace.kind === "main" || trace.agent_type === undefined) {
    cuts =
      trace.kind === "main" && tie.story === null
        ? conversationCuts(timeline)
        : [
            {
              slice: { from: Number.NEGATIVE_INFINITY, to: Number.POSITIVE_INFINITY },
              agent: tie.agent === MAIN_SESSION_AGENT ? NOAH_AGENT : tie.agent,
              work:
                tie.story === null
                  ? { kind: "coordination", key: "conversation" }
                  : { kind: "story", key: tie.story },
              story: tie.story ?? undefined,
            },
          ];
  } else {
    const work: UsageWork =
      tie.story !== null
        ? { kind: "story", key: tie.story }
        : workOf(
            timeline,
            tie.agent,
            start,
            end,
            handoverOf(timeline, tie.agent, start, end),
            trace.description,
          );
    cuts = [
      {
        slice: { from: Number.NEGATIVE_INFINITY, to: Number.POSITIVE_INFINITY },
        agent: tie.agent,
        work,
        story: tie.story ?? undefined,
      },
    ];
  }
  // A session that goes on across the approval of an end of phase is cut there: what it did after
  // belongs to the next phase (the approval itself still closes the phase it ended).
  // A part never straddles a UTC midnight either: the report by period places a part by its start,
  // so a part of two days would count whole on one of them.
  const bounds = [
    ...(input.phaseEnds ?? []).map((time) => time + 1),
    ...midnightsBetween(start, end),
  ].sort((a, b) => a - b);
  cuts = cuts.flatMap((cut) => {
    const inside = bounds.filter((bound) => bound > cut.slice.from && bound < cut.slice.to);
    const points = [cut.slice.from, ...inside, cut.slice.to];
    return points.slice(1).map((to, index) => ({
      ...cut,
      slice: { from: points[index] as number, to },
    }));
  });
  // Then at each start and end of a skill (the tool's own calls, the journal's reports): what a
  // slice served is attributed to the skill running when it began.
  const skillSpans = {
    tool: toolSkillSpans(summary.skillCalls ?? [], summary.prompts ?? []),
    journal: timeline.skills,
  };
  cuts = cuts.flatMap((cut) => {
    const inside = skillBoundaries(skillSpans, cut.agent, cut.slice.from, cut.slice.to);
    const points = [cut.slice.from, ...inside, cut.slice.to];
    return points.slice(1).map((to, index) => {
      const from = points[index] as number;
      const skill = skillAt(from, skillSpans, cut.agent, cut.skill);
      const { skill: _handed, ...rest } = cut;
      return { ...rest, slice: { from, to }, ...(skill === undefined ? {} : { skill }) };
    });
  });
  const sliced = sliceSummary(
    summary,
    cuts.map((cut) => cut.slice),
  );
  const merged = new Map<string, UsagePart>();
  const spans = new Map<string, { from: number; to: number }>();
  for (const [index, cut] of cuts.entries()) {
    const used = sliced[index];
    if (used === undefined || used.started_at === null || used.ended_at === null) continue;
    if (used.models.length === 0 && used.active_ms === 0) continue;
    const phase = input.phaseAt(Date.parse(used.started_at));
    const step = stepOf({ agent: cut.agent, phase, story: cut.story, work: cut.work });
    const key = [
      cut.agent,
      phase ?? "",
      cut.work.kind,
      cut.work.key,
      cut.story ?? "",
      used.started_at.slice(0, 10),
      step?.name ?? "",
      cut.skill?.name ?? "",
      cut.skill?.origin ?? "",
    ].join("\u0000");
    const held = merged.get(key);
    if (held === undefined) {
      merged.set(key, {
        agent: cut.agent,
        ...(phase === undefined ? {} : { phase }),
        work: cut.work,
        ...(cut.story === undefined ? {} : { story: cut.story }),
        ...(step === undefined ? {} : { step }),
        ...(cut.skill === undefined ? {} : { skill: cut.skill }),
        started_at: used.started_at,
        ended_at: used.ended_at,
        active_ms: used.active_ms,
        models: used.models,
      });
      spans.set(key, { from: Date.parse(used.started_at), to: Date.parse(used.ended_at) });
    } else {
      const span = spans.get(key) as { from: number; to: number };
      span.from = Math.min(span.from, Date.parse(used.started_at));
      span.to = Math.max(span.to, Date.parse(used.ended_at));
      merged.set(key, {
        ...held,
        started_at: new Date(span.from).toISOString(),
        ended_at: new Date(span.to).toISOString(),
        active_ms: held.active_ms + used.active_ms,
        models: mergeModels([held.models, used.models]),
      });
    }
  }
  return [...merged.values()];
}
