import { projectWithKey } from "../agent-activity/agent-commands.js";
import type { CommandContext } from "../command.js";
import {
  journalFacts,
  type MeasuredSession,
  measureTraces,
  WINDOW_SLACK_MS,
} from "../usage/measure-usage.js";
import { figuresOf, type UsageSessionState, usageSessionsOf } from "../usage/usage-rules.js";
import type { GuardIndex } from "../write-guard/write-index.js";

/**
 * What a story has cost so far, as the engine measures it itself: the measures the journal holds
 * (read with the product key, kept a short while), replaced, session by session, by the reading of
 * the traces of the sessions still open (the tool keeps them on this machine). Dollars at the
 * public prices; a model without a price counts for nothing, so the figure is a lower bound.
 * Nothing an agent says enters it. Reading the traces can take longer than a call may wait: the
 * reading goes on after the guard gave up, and the next call finds its result.
 */

// Core has no platform types: the two timer functions it needs are declared here.
declare function setTimeout(handler: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;

/** How long the measures read from the journal are kept, in milliseconds. */
export const HELD_TTL_MS = 30_000;

interface Held {
  readonly at: number;
  readonly sessions: Map<string, UsageSessionState>;
}

interface Live {
  /** When the engine read the trace (milliseconds): a file not modified since is not read again. */
  readonly readAt: number;
  readonly session: MeasuredSession;
}

const heldCache = new WeakMap<object, Held>();
const liveCache = new WeakMap<object, Map<string, Live>>();
const reading = new WeakMap<object, Promise<void>>();

const keyOf = (source: string, session: string) => `${source}:${session}`;

/** The measures the journal holds, by session; empty when this machine cannot read them. */
async function heldSessions(
  context: CommandContext,
  index: GuardIndex,
  now: number,
): Promise<Map<string, UsageSessionState>> {
  const kept = heldCache.get(index.journal);
  if (kept !== undefined && now - kept.at < HELD_TTL_MS) return kept.sessions;
  const listing = await index.journal.list();
  const { projection } = await projectWithKey(context, index.config, listing);
  const sessions = new Map(
    usageSessionsOf(projection.state).map((one) => [keyOf(one.source, one.session), one] as const),
  );
  heldCache.set(index.journal, { at: now, sessions });
  return sessions;
}

/** Reads the traces that changed since the last reading and keeps what they measure. */
async function refreshLive(
  context: CommandContext,
  index: GuardIndex,
  held: ReadonlyMap<string, UsageSessionState>,
  now: number,
): Promise<void> {
  const traces = context.usageTraces;
  if (traces === undefined) return;
  const cache = liveCache.get(index.journal) ?? new Map<string, Live>();
  liveCache.set(index.journal, cache);
  const { folders } = journalFacts(index.events);
  const files = await traces.read(
    [...new Set(folders.map((folder) => folder.worktree))],
    (session) => {
      const seen = cache.get(session);
      if (seen !== undefined) return seen.readAt;
      const measured = held.get(session);
      return measured === undefined ? undefined : Date.parse(measured.at) - WINDOW_SLACK_MS / 2;
    },
  );
  const { sessions } = measureTraces(files, index.events);
  for (const session of sessions) {
    const key = keyOf(session.payload.source, session.payload.session);
    cache.set(key, { readAt: now, session });
  }
}

/** One reading at a time per journal: parallel calls share it. */
function refreshOnce(
  context: CommandContext,
  index: GuardIndex,
  held: ReadonlyMap<string, UsageSessionState>,
  now: number,
): Promise<void> {
  const running = reading.get(index.journal);
  if (running !== undefined) return running;
  const work = refreshLive(context, index, held, now)
    .catch(() => undefined)
    .finally(() => reading.delete(index.journal));
  reading.set(index.journal, work);
  return work;
}

const tokensOf = (session: Pick<UsageSessionState, "models">) =>
  session.models.reduce(
    (total, usage) =>
      total + usage.tokens_in + usage.tokens_out + usage.cache_read + usage.cache_write,
    0,
  );

/**
 * The cost of `story` in US dollars. Waits for the reading of the traces at most `waitMs`; past
 * that it answers with what it knows (a cost only grows, so a lower bound still proves a ceiling
 * gone over).
 */
export async function storyCostUsd(
  context: CommandContext,
  index: GuardIndex,
  story: string,
  waitMs: number,
): Promise<number> {
  const now = (context.now ?? Date.now)();
  const held = await heldSessions(context, index, now).catch(
    () => new Map<string, UsageSessionState>(),
  );
  const reader = refreshOnce(context, index, held, now);
  let timer: unknown;
  await Promise.race([
    reader,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  const merged = new Map<string, UsageSessionState>();
  for (const [key, one] of held) if (one.story === story) merged.set(key, one);
  for (const [key, { session }] of liveCache.get(index.journal) ?? []) {
    if (session.story !== story) continue;
    const current = merged.get(key);
    // A session's cost only grows: the larger reading wins.
    if (current !== undefined && tokensOf(current) >= tokensOf(session.payload)) continue;
    merged.set(key, {
      source: session.payload.source,
      session: session.payload.session,
      story,
      agent: session.payload.agent,
      basis: session.payload.basis,
      started_at: session.payload.started_at,
      ended_at: session.payload.ended_at,
      active_ms: session.payload.active_ms,
      models: session.payload.models,
      at: "",
      event: "",
    });
  }
  return figuresOf([...merged.values()]).usd;
}

/** Forgets what was kept (tests). */
export function forgetCallCosts(context: CommandContext): void {
  if (context.journal === undefined) return;
  heldCache.delete(context.journal);
  liveCache.delete(context.journal);
  reading.delete(context.journal);
}
