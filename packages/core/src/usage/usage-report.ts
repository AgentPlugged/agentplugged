import {
  ErrorCode,
  type MethodConfig,
  StoryIdSchema,
  TOOL_IDS,
  USAGE_SOURCES,
  type UsageModel,
  type UsageOrigin,
  type UsageSource,
} from "@agentplugged/protocol";
import type { CommandContext } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import type { StoryState } from "../projection/agent-reducers.js";
import { journalFacts } from "./measure-usage.js";
import { habitsOf, type SessionHabits } from "./session-habits.js";
import {
  type Estimates,
  type UsageSessionState,
  usageSessionsOf,
  usageView,
} from "./usage-rules.js";

/**
 * The report of what the AI tools consumed, by story, step, skill, agent or session over a period
 *, as pure rules over the measured sessions. Tokens and the origin of
 * each figure, never an amount of money: the only cost it carries is the estimate of a story (the
 * method's reference, or the range of the product's own finished stories), labelled as one. The
 * real cost belongs to an optional module, which plugs in through `CostSource` and whose figures are
 * not among the lines this engine prints.
 */

export const REPORT_AXES = ["story", "step", "skill", "agent", "session"] as const;
export type ReportAxis = (typeof REPORT_AXES)[number];

/** How the key of a row was attributed: named by the tool, deduced from an interval, or unknown. */
export type RowOrigin = UsageOrigin | "unknown";

export interface Tokens {
  readonly tokens_in: number;
  readonly tokens_out: number;
  readonly cache_read: number;
  readonly cache_write: number;
}

export interface ReportRow extends Tokens {
  /** The story, step, skill, agent or session; null for the row of what is not attributed. */
  readonly key: string | null;
  readonly origin: RowOrigin;
  /** Every token of the row, cache included. */
  readonly total: number;
  /** The row's share of the report's total, between 0 and 1. */
  readonly share: number;
}

export interface UsageAsk {
  readonly axis: ReportAxis;
  readonly story?: string;
  /** Inclusive days, `YYYY-MM-DD`, UTC. */
  readonly since?: string;
  readonly until?: string;
  /** `<source>:<session>`: the habits of that session are read as well. */
  readonly session?: string;
}

/** The tools the report names for what it cannot give. */
export interface ToolNotes {
  /** Tools of the product that keep no token count in any local trace: nothing can be measured of them. */
  readonly unmeasurable: readonly string[];
  /** Tools the engine can read, with no session measured yet: not zero, not read. */
  readonly unread: readonly string[];
}

export interface UsageReport {
  readonly usage: "report";
  readonly axis: ReportAxis;
  readonly story: string | null;
  readonly since: string | null;
  readonly until: string | null;
  /** False when no session was measured in the scope: no figure, never a zero. */
  readonly measured: boolean;
  /** The sessions measured in the scope, and how many of them have no parts (their tokens are unattributed). */
  readonly sessions: number;
  readonly sessions_without_parts: number;
  /** Where the tokens come from: the AI tool's own counters, per tool. */
  readonly tokens_origin: Readonly<Partial<Record<UsageSource, number>>>;
  readonly total: Tokens & { readonly total: number };
  readonly rows: readonly ReportRow[];
  /** The part of the total on the row of what is not attributed, between 0 and 1. */
  readonly unattributed_share: number;
  readonly tools: ToolNotes;
  /** The measure is encrypted: true when sensitive events could not be read here (no product key). */
  readonly unreadable: boolean;
  /** An estimate of a story's cost (US dollars, API public prices), never a measured one. */
  readonly estimates: Pick<Estimates, "standard" | "fast">;
  /** One session's habits, when asked: null for a tool whose trace does not say them. */
  readonly habits?: { readonly session: string; readonly found: SessionHabits | null };
  /** What an optional source provided: for the module that reads it, never printed by the engine. */
  readonly provided?: unknown;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day: `2026-02-31` is not one (it would be read as the 3rd of March). */
function isDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function invalid(reason: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", { reason });
}

/** The ask from the words of the command, or the error. */
export function parseUsageAsk(
  input: Readonly<Record<string, unknown>>,
): UsageAsk | AgentPluggedError {
  const axis = input.axis === undefined ? "step" : input.axis;
  if (!(REPORT_AXES as readonly unknown[]).includes(axis)) {
    return invalid(`usage --by ${String(axis)} (${REPORT_AXES.join(", ")})`);
  }
  const ask: { -readonly [K in keyof UsageAsk]: UsageAsk[K] } = { axis: axis as ReportAxis };
  if (input.story !== undefined) {
    if (!StoryIdSchema.safeParse(input.story).success) {
      return invalid(`usage --story ${String(input.story)} (<epic>-<story>)`);
    }
    ask.story = String(input.story);
  }
  for (const name of ["since", "until"] as const) {
    const value = input[name];
    if (value === undefined) continue;
    if (typeof value !== "string" || !isDay(value)) {
      return invalid(`usage --${name} ${String(value)} (YYYY-MM-DD)`);
    }
    ask[name] = value;
  }
  if (ask.since !== undefined && ask.until !== undefined && ask.since > ask.until) {
    return invalid(`usage --since ${ask.since} --until ${ask.until} (since is after until)`);
  }
  if (input.session !== undefined) {
    if (
      typeof input.session !== "string" ||
      !/^[a-z-]+:[A-Za-z0-9._:-]{1,128}$/.test(input.session)
    ) {
      return invalid(`usage --session ${String(input.session)} (<tool>:<session>)`);
    }
    ask.session = input.session;
  }
  return ask;
}

/** The tokens of models, of every kind. */
function tokensOf(models: readonly UsageModel[]): Tokens {
  const sum = (pick: (usage: UsageModel) => number) =>
    models.reduce((total, usage) => total + pick(usage), 0);
  return {
    tokens_in: sum((usage) => usage.tokens_in),
    tokens_out: sum((usage) => usage.tokens_out),
    cache_read: sum((usage) => usage.cache_read),
    cache_write: sum((usage) => usage.cache_write),
  };
}

const totalOf = (tokens: Tokens) =>
  tokens.tokens_in + tokens.tokens_out + tokens.cache_read + tokens.cache_write;

/** A piece of consumption to place on an axis: a part of a session, or a session whole when it has no parts. */
interface Piece {
  readonly session: UsageSessionState;
  readonly at: string;
  readonly agent: string;
  readonly story: string | null;
  readonly step: { readonly name: string; readonly origin: UsageOrigin } | undefined;
  readonly skill: { readonly name: string; readonly origin: UsageOrigin } | undefined;
  readonly tokens: Tokens;
}

function piecesOf(session: UsageSessionState): Piece[] {
  if (session.parts === undefined || session.parts.length === 0) {
    return [
      {
        session,
        at: session.started_at,
        agent: session.agent,
        story: session.story,
        step: undefined,
        skill: undefined,
        tokens: tokensOf(session.models),
      },
    ];
  }
  return session.parts.map((part) => ({
    session,
    at: part.started_at,
    agent: part.agent,
    story: part.story ?? null,
    step: part.step,
    skill: part.skill,
    tokens: tokensOf(part.models),
  }));
}

/** How the session's story was tied: the journal bounds it, the tool's own title names it, or nothing. */
function storyOrigin(session: UsageSessionState): RowOrigin {
  return session.basis === "journal" ? "interval" : session.basis === "label" ? "tool" : "unknown";
}

function placed(piece: Piece, axis: ReportAxis): { key: string | null; origin: RowOrigin } {
  switch (axis) {
    case "story":
      return piece.story === null
        ? { key: null, origin: "unknown" }
        : { key: piece.story, origin: storyOrigin(piece.session) };
    case "step":
      return piece.step === undefined
        ? { key: null, origin: "unknown" }
        : { key: piece.step.name, origin: piece.step.origin };
    case "skill":
      return piece.skill === undefined
        ? { key: null, origin: "unknown" }
        : { key: piece.skill.name, origin: piece.skill.origin };
    case "agent":
      return { key: piece.agent, origin: "interval" };
    case "session":
      return { key: `${piece.session.source}:${piece.session.session}`, origin: "tool" };
  }
}

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

/** The tools the report names: those no trace can measure, and those readable but not read yet. */
export function toolNotes(
  config: Pick<MethodConfig, "tools">,
  sessions: readonly UsageSessionState[],
): ToolNotes {
  const used: readonly string[] = config.tools ?? TOOL_IDS;
  const read = new Set(sessions.map((session) => session.source));
  return {
    unmeasurable: used.filter((tool) => !(USAGE_SOURCES as readonly string[]).includes(tool)),
    unread: used.filter(
      (tool) =>
        (USAGE_SOURCES as readonly string[]).includes(tool) && !read.has(tool as UsageSource),
    ),
  };
}

/** The report of `sessions` for `ask`. Pure. */
export function reportOf(input: {
  readonly ask: UsageAsk;
  readonly sessions: readonly UsageSessionState[];
  readonly tools: ToolNotes;
  readonly estimates: Pick<Estimates, "standard" | "fast">;
  readonly unreadable: boolean;
}): UsageReport {
  const { ask } = input;
  const since = ask.since === undefined ? undefined : Date.parse(`${ask.since}T00:00:00.000Z`);
  const until = ask.until === undefined ? undefined : Date.parse(`${ask.until}T23:59:59.999Z`);
  const pieces = input.sessions
    .flatMap(piecesOf)
    .filter((piece) => ask.story === undefined || piece.story === ask.story)
    .filter((piece) => {
      const at = Date.parse(piece.at);
      return (since === undefined || at >= since) && (until === undefined || at <= until);
    });
  const sessions = [...new Set(pieces.map((piece) => piece.session))];
  const rows = new Map<string, { key: string | null; origin: RowOrigin; tokens: Tokens }>();
  const origin: Partial<Record<UsageSource, number>> = {};
  let all: Tokens = { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0 };
  const add = (a: Tokens, b: Tokens): Tokens => ({
    tokens_in: a.tokens_in + b.tokens_in,
    tokens_out: a.tokens_out + b.tokens_out,
    cache_read: a.cache_read + b.cache_read,
    cache_write: a.cache_write + b.cache_write,
  });
  for (const piece of pieces) {
    const { key, origin: how } = placed(piece, ask.axis);
    // The same name reached two ways (the tool's, the journal's) stays two rows: never merged.
    const id = `${how}\u0000${key ?? ""}`;
    const held = rows.get(id);
    rows.set(id, {
      key,
      origin: how,
      tokens: held === undefined ? piece.tokens : add(held.tokens, piece.tokens),
    });
    all = add(all, piece.tokens);
    origin[piece.session.source] = (origin[piece.session.source] ?? 0) + totalOf(piece.tokens);
  }
  const total = totalOf(all);
  const measured = pieces.length > 0 && total > 0;
  const list: ReportRow[] = [...rows.values()]
    .map((row) => ({
      ...row.tokens,
      key: row.key,
      origin: row.origin,
      total: totalOf(row.tokens),
      share: total === 0 ? 0 : round4(totalOf(row.tokens) / total),
    }))
    .sort(
      (a, b) =>
        Number(a.key === null) - Number(b.key === null) ||
        b.total - a.total ||
        ((a.key ?? "") < (b.key ?? "") ? -1 : 1),
    );
  const unattributed = list
    .filter((row) => row.origin === "unknown")
    .reduce((sum, row) => sum + row.total, 0);
  return {
    usage: "report",
    axis: ask.axis,
    story: ask.story ?? null,
    since: ask.since ?? null,
    until: ask.until ?? null,
    measured,
    sessions: sessions.length,
    sessions_without_parts: sessions.filter(
      (session) => session.parts === undefined || session.parts.length === 0,
    ).length,
    tokens_origin: origin,
    total: { ...all, total },
    rows: list,
    unattributed_share: total === 0 ? 0 : round4(unattributed / total),
    tools: input.tools,
    unreadable: input.unreadable,
    estimates: { standard: input.estimates.standard, fast: input.estimates.fast },
  };
}

/** The report of the product, from the journal and (for one session's habits) the traces. */
export async function usageReport(
  context: CommandContext,
  config: MethodConfig,
  ask: UsageAsk,
  read: {
    readonly state: Readonly<Record<string, unknown>>;
    readonly unreadable: boolean;
    readonly events: Parameters<typeof journalFacts>[0];
  },
): Promise<UsageReport> {
  const all = usageSessionsOf(read.state);
  const view = usageView({
    state: read.state,
    stories: (read.state.stories as Record<string, StoryState> | undefined) ?? {},
  });
  const base = reportOf({
    ask,
    sessions: all,
    tools: toolNotes(config, all),
    estimates: view.estimates,
    unreadable: read.unreadable,
  });
  const withHabits =
    ask.session === undefined
      ? base
      : { ...base, habits: await habitsFor(context, ask.session, read.events) };
  const stories = ask.story === undefined ? storiesIn(all) : 1;
  const provided =
    context.costSource === undefined || stories === 0
      ? undefined
      : await context.costSource.provide({ stories });
  return provided === undefined ? withHabits : { ...withHabits, provided };
}

function storiesIn(sessions: readonly UsageSessionState[]): number {
  return new Set(sessions.flatMap((session) => (session.story === null ? [] : [session.story])))
    .size;
}

/** The habits of one session: read in the tool's trace, nothing the agent says. */
async function habitsFor(
  context: CommandContext,
  id: string,
  events: Parameters<typeof journalFacts>[0],
): Promise<{ session: string; found: SessionHabits | null }> {
  if (context.usageTraces === undefined) return { session: id, found: null };
  const { folders } = journalFacts(events);
  const traces = await context.usageTraces.read([...new Set(folders.map((one) => one.worktree))]);
  const trace = traces.find((one) => `${one.source}:${one.id}` === id);
  // Only Claude Code's transcript says which files were read and which tools failed.
  if (trace === undefined || trace.source !== "claude-code" || trace.unchanged === true) {
    return { session: id, found: null };
  }
  return { session: id, found: habitsOf(trace.text) };
}
