import { pointKindOf } from "../checkpoints/point-rules.js";
import type { StoryState } from "../projection/agent-reducers.js";
import type { CheckpointState, ValidationEntry } from "../projection/checkpoint-reducers.js";
import type {
  DecisionItem,
  Morning,
  MorningClosed,
  MorningDecided,
  MorningDone,
  MorningEscalated,
} from "./next.js";

/**
 * The short summary of a night's work, from the journal alone, pure: what was done,
 * what the agents decided alone (with their reasons, reopenable), what the engine closed alone, what
 * an agent handed back, and what waits for the creator. It starts at the creator's last answer (their
 * own gesture: the chat, the AI tool's form, the terminal), so it empties once they answer the pile.
 */

/** The most entries of each list: the newest ones; the totals say how many there are. */
export const MORNING_LIMIT = 20;

/** The sources of an answer that are the creator's own gesture. */
const CREATOR_SOURCES: ReadonlySet<string> = new Set(["terminal", "chat", "elicitation"]);

function recordOf<T>(state: Readonly<Record<string, unknown>>, key: string): Record<string, T> {
  const value = state[key];
  return typeof value === "object" && value !== null ? (value as Record<string, T>) : {};
}

/** The creator's last answer, or null when they never gave one. */
export function creatorLastAnswer(projection: Readonly<Record<string, unknown>>): string | null {
  const entries = projection.validations;
  if (!Array.isArray(entries)) return null;
  let last: string | null = null;
  for (const entry of entries as readonly ValidationEntry[]) {
    if (!CREATOR_SOURCES.has(entry.source)) continue;
    if (last === null || Date.parse(entry.at) > Date.parse(last)) last = entry.at;
  }
  return last;
}

/** True when `at` is after `since` (always when there is no `since`). */
function after(at: string, since: string | null): boolean {
  return since === null || Date.parse(at) > Date.parse(since);
}

/** The newest first, cut to the limit, with the total. */
function newest<T extends { readonly at: string }>(
  list: readonly T[],
): { readonly shown: readonly T[]; readonly total: number } {
  const sorted = [...list].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { shown: sorted.slice(0, MORNING_LIMIT), total: sorted.length };
}

/** What happened since the creator last answered, and what waits for them (`queue`). */
export function morningSummary(
  projection: Readonly<Record<string, unknown>>,
  queue: readonly DecisionItem[],
): Morning {
  const since = creatorLastAnswer(projection);
  const checkpoints = Object.values(recordOf<CheckpointState>(projection, "checkpoints"));
  const stories = recordOf<StoryState>(projection, "stories");

  const done: MorningDone[] = [];
  for (const [story, state] of Object.entries(stories)) {
    const merged = state.merged;
    if (merged === undefined || !after(merged.at, since)) continue;
    done.push({
      story,
      at: merged.at,
      by: merged.source === "agent" ? "agent" : merged.source === "forge" ? "forge" : "creator",
    });
  }

  const decided: MorningDecided[] = [];
  for (const checkpoint of checkpoints) {
    const resolution = checkpoint.resolution;
    if (resolution === null || resolution.source !== "agent" || !after(resolution.at, since)) {
      continue;
    }
    decided.push({
      checkpoint: checkpoint.id,
      title: checkpoint.title,
      kind: pointKindOf(checkpoint) ?? null,
      by: resolution.relayed_by,
      decision: resolution.decision,
      option: resolution.option,
      reason: resolution.note ?? "",
      at: resolution.at,
    });
  }

  const closed: MorningClosed[] = [];
  for (const checkpoint of checkpoints) {
    const settled = checkpoint.closed;
    if (checkpoint.status !== "closed" || settled == null || !after(settled.at, since)) continue;
    closed.push({
      checkpoint: checkpoint.id,
      title: checkpoint.title,
      reason: settled.reason,
      at: settled.at,
    });
  }

  const escalated: MorningEscalated[] = [];
  for (const checkpoint of checkpoints) {
    const handed = checkpoint.escalated;
    if (checkpoint.status !== "open" || handed == null) continue;
    escalated.push({
      checkpoint: checkpoint.id,
      title: checkpoint.title,
      by: handed.by,
      reason: handed.reason,
      at: handed.at,
    });
  }

  const doneList = newest(done);
  const decidedList = newest(decided);
  const closedList = newest(closed);
  return {
    since,
    done: doneList.shown,
    done_total: doneList.total,
    decided: decidedList.shown,
    decided_total: decidedList.total,
    closed: closedList.shown,
    closed_total: closedList.total,
    escalated: newest(escalated).shown,
    waiting: queue.map((item) => item.id),
  };
}
