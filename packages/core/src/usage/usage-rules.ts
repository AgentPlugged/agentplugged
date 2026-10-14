import type { UsageBasis, UsageModel, UsagePart, UsageSource } from "@agentplugged/protocol";
import type { StoryState } from "../projection/agent-reducers.js";
import { PRICE_TABLE, type PriceTable, priceModels } from "./price-table.js";

/**
 * What the engine measured of the AI tools' sessions, as pure rules over the projection:
 * the state of the measured sessions (with what each part of them served) and the
 * estimates (the product's own history, else the method's reference) with the order-of-magnitude
 * guard. What a story really cost is never shown by the engine: the history refines the
 * estimates and the sessions stay in the journal where a module may read them.
 */

/** `state.usage.sessions[<source>:<session>]`: one session as its latest measure recorded it. */
export interface UsageSessionState {
  readonly source: UsageSource;
  readonly session: string;
  /** The story it belongs to, or null (the creator's own conversation, planning). */
  readonly story: string | null;
  readonly agent: string;
  readonly basis: UsageBasis;
  readonly started_at: string;
  readonly ended_at: string;
  readonly active_ms: number;
  readonly models: readonly UsageModel[];
  /** What each part of the session served, when the measure holds them. */
  readonly parts?: readonly UsagePart[];
  /** When the measure was written, and its event. */
  readonly at: string;
  readonly event: string;
}

export interface UsageState {
  readonly sessions: Record<string, UsageSessionState>;
}

/** What a set of sessions consumed, with its cost at the table's prices. */
export interface UsageFigures {
  readonly sessions: number;
  readonly tokens_in: number;
  readonly tokens_out: number;
  readonly cache_read: number;
  readonly cache_write: number;
  /** Working time, in milliseconds. */
  readonly active_ms: number;
  readonly models: readonly string[];
  /** Cost at the API's public prices (equivalent, never billed), micro-dollars rounded. */
  readonly usd: number;
  /** False when a model has no price in the table: `usd` leaves it out. */
  readonly complete: boolean;
  readonly unpriced_models: readonly string[];
}

/** The measured sessions of the projection, in a stable order. */
export function usageSessionsOf(state: Readonly<Record<string, unknown>>): UsageSessionState[] {
  const usage = state.usage as UsageState | undefined;
  if (usage === undefined) return [];
  return Object.values(usage.sessions).sort((a, b) => {
    if (a.started_at !== b.started_at) return a.started_at < b.started_at ? -1 : 1;
    return a.session < b.session ? -1 : 1;
  });
}

/** The figures of `sessions` at `table`'s prices. */
export function figuresOf(
  sessions: readonly UsageSessionState[],
  table: PriceTable = PRICE_TABLE,
): UsageFigures {
  const merged = new Map<string, UsageModel>();
  let active = 0;
  for (const session of sessions) {
    active += session.active_ms;
    for (const usage of session.models) {
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
  const models = [...merged.values()];
  const priced = priceModels(models, table);
  const sum = (pick: (usage: UsageModel) => number) =>
    models.reduce((total, usage) => total + pick(usage), 0);
  return {
    sessions: sessions.length,
    tokens_in: sum((usage) => usage.tokens_in),
    tokens_out: sum((usage) => usage.tokens_out),
    cache_read: sum((usage) => usage.cache_read),
    cache_write: sum((usage) => usage.cache_write),
    active_ms: active,
    models: models.map((usage) => usage.model).sort(),
    usd: priced.usd,
    complete: priced.complete,
    unpriced_models: priced.unpriced_models,
  };
}

/** The lane a story went through: the fast track, or the full lane. */
export type StoryLane = "standard" | "fast";

export function laneOf(story: StoryState | undefined): StoryLane {
  return story?.fast_track === undefined ? "standard" : "fast";
}

/** A range of costs in US dollars at the API's public prices. */
export interface UsdRange {
  readonly low: number;
  readonly expected: number;
  readonly high: number;
}

/** Where an estimate comes from: the product's measured stories, or the method's reference. */
export type EstimateBasis = "history" | "reference";

export interface LaneEstimate extends UsdRange {
  readonly basis: EstimateBasis;
  /** The measured stories of the lane (0 for a reference). */
  readonly stories: number;
}

export interface Estimates {
  readonly standard: LaneEstimate;
  readonly fast: LaneEstimate;
  /** The widest range a story's budget may take before the guard flags it: three times off the ranges. */
  readonly guard: { readonly low: number; readonly high: number; readonly factor: number };
}

/**
 * The method's reference without any history: a prudent range for one story, all
 * its agents together (building, independent review, security), in US dollars at the API's public
 * prices. It was read on 13 stories of a real product built with the method (a showcase site,
 * 2026-10-06): from $1.9 to $13.0 in the full lane, a median near $6.3, with Opus 5.5 reviewing
 * and Sonnet 5.5 building (a dearer model costs more). The fast lane has no measure yet: its
 * range is a guess, said as such by `basis: reference`.
 */
export const REFERENCE_ESTIMATES: Readonly<Record<StoryLane, UsdRange>> = {
  standard: { low: 2, expected: 6, high: 14 },
  fast: { low: 0.3, expected: 1, high: 4 },
};

/** How far a story's budget may sit from the measured range or the reference: a factor 3, each way. */
const GUARD_FACTOR = 3;

/** The history needs this many finished stories of a lane to replace the reference. */
const MIN_HISTORY_STORIES = 3;

const round2 = (value: number) => Math.round(value * 100) / 100;

/** The grid, in dollars, the estimates from the history are given on. */
const HISTORY_GRID = 0.5;
const floorTo = (value: number) => Math.floor(value / HISTORY_GRID) * HISTORY_GRID;
const ceilTo = (value: number) => Math.ceil(value / HISTORY_GRID) * HISTORY_GRID;
const roundTo = (value: number) => Math.round(value / HISTORY_GRID) * HISTORY_GRID;

/** A quantile of sorted values, interpolated. */
function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 1) return sorted[0] as number;
  const at = (sorted.length - 1) * q;
  const below = Math.floor(at);
  const above = Math.ceil(at);
  const low = sorted[below] as number;
  const high = sorted[above] as number;
  return low + (high - low) * (at - below);
}

/** A finished story's measured cost: what history is made of. */
export interface FinishedStory {
  readonly story: string;
  readonly lane: StoryLane;
  readonly usd: number;
}

/**
 * The finished stories with a measured cost: merged ones (their lane) whose sessions the table
 * prices completely and that cost something.
 */
export function finishedStories(
  stories: Readonly<Record<string, StoryState>>,
  sessions: readonly UsageSessionState[],
  table: PriceTable = PRICE_TABLE,
): FinishedStory[] {
  const finished: FinishedStory[] = [];
  for (const [id, story] of Object.entries(stories)) {
    if (story.merged === undefined) continue;
    const mine = sessions.filter((session) => session.story === id);
    if (mine.length === 0) continue;
    const figures = figuresOf(mine, table);
    if (!figures.complete || figures.usd <= 0) continue;
    finished.push({
      story: id,
      lane: laneOf(story),
      usd: figures.usd,
    });
  }
  return finished.sort((a, b) => (a.story < b.story ? -1 : 1));
}

/** The estimate of one lane: its history from three stories on (10th, 50th and 90th percentile), else the reference. */
function laneEstimate(lane: StoryLane, finished: readonly FinishedStory[]): LaneEstimate {
  const costs = finished
    .filter((story) => story.lane === lane)
    .map((story) => story.usd)
    .sort((a, b) => a - b);
  if (costs.length < MIN_HISTORY_STORIES) {
    return { ...REFERENCE_ESTIMATES[lane], basis: "reference", stories: costs.length };
  }
  // On a half-dollar grid, the range pushed out: three finished stories would otherwise hand back
  // their real costs to the cent, and the engine shows no real cost.
  return {
    low: Math.max(HISTORY_GRID, floorTo(quantile(costs, 0.1))),
    expected: roundTo(quantile(costs, 0.5)),
    high: ceilTo(quantile(costs, 0.9)),
    basis: "history",
    stories: costs.length,
  };
}

/** The estimates for the next stories, from the history (or the reference), and the guard's range. */
export function estimatesOf(finished: readonly FinishedStory[]): Estimates {
  const standard = laneEstimate("standard", finished);
  const fast = laneEstimate("fast", finished);
  return {
    standard,
    fast,
    guard: {
      low: round2(Math.min(standard.low, fast.low) / GUARD_FACTOR),
      high: round2(Math.max(standard.high, fast.high) * GUARD_FACTOR),
      factor: GUARD_FACTOR,
    },
  };
}

/** What `get_state` shows of the measure: estimates only, never what a story really cost. */
export interface UsageView {
  /** The price table the estimates are computed with: its version and the day its prices were read. */
  readonly table: { readonly version: string; readonly as_of: string; readonly source: string };
  /**
   * The estimates for the next stories, in US dollars at the API's public prices, from the product's
   * own measured history (three finished stories of a lane) or the method's reference. An
   * estimate, never a cost: the real cost of what the engine measured stays in the journal, where a
   * module may read it.
   */
  readonly estimates: Estimates;
}

/**
 * What the creator may see of the measure: the estimates. The sessions the engine
 * measured refine them (the history of finished stories) without ever being shown.
 */
export function usageView(input: {
  readonly state: Readonly<Record<string, unknown>>;
  readonly stories: Readonly<Record<string, StoryState>>;
  readonly table?: PriceTable;
}): UsageView {
  const table = input.table ?? PRICE_TABLE;
  const estimates = estimatesOf(
    finishedStories(input.stories, usageSessionsOf(input.state), table),
  );
  return {
    table: { version: table.version, as_of: table.as_of, source: table.source },
    estimates,
  };
}
