import {
  BUDGET_EVENT_TYPES,
  type BudgetExceedMode,
  type BudgetLevel,
  type BudgetThresholdReachedPayload,
} from "@agentplugged/protocol";
import { dictionary } from "./agent-reducers.js";
import type { CheckpointState } from "./checkpoint-reducers.js";
import type { ProjectionDraft, Reducer } from "./reducers.js";

/** One threshold a story's cost reached, as its event recorded it. */
export interface BudgetThresholdEntry {
  readonly story: string;
  readonly level: BudgetLevel;
  /** The ceiling it was measured against, in US dollars (never the cost). */
  readonly budget_usd: number;
  /** The source of that ceiling: the sprint (`S-…`) or the budget checkpoint (`G-…`). */
  readonly ceiling: string;
  readonly alert_ratio: number;
  readonly on_exceed: BudgetExceedMode;
  /** The budget checkpoint opened in the same write (`exceeded` under `block`), or null. */
  readonly checkpoint: string | null;
  /** The agent whose declared cost reached it. */
  readonly agent: string;
  readonly at: string;
  /** The ULID of its event. */
  readonly event: string;
}

/** `state.budget_thresholds[story]`: the thresholds each story reached, in projection order. */
export type BudgetThresholds = Record<string, BudgetThresholdEntry[]>;

/** The thresholds of a projection, by story (an empty dictionary when there are none). */
export function budgetThresholdsOf(state: Readonly<Record<string, unknown>>): BudgetThresholds {
  const value = state.budget_thresholds;
  return typeof value === "object" && value !== null ? (value as BudgetThresholds) : {};
}

/** True when `eventId` is a cost declared by `agent` on `story` (read or not). */
function costOf(
  draft: ProjectionDraft,
  eventId: string | undefined,
  agent: string,
  story: string,
): boolean {
  const cost = eventId === undefined ? undefined : draft.costEvents.get(eventId);
  return cost !== undefined && cost.agent === agent && cost.story === story;
}

/**
 * True when `id` is the budget checkpoint the event's own write opened: a `decision` checkpoint
 * of the same story, opened by the same agent, by the event this one chains on, right after a cost
 * of that agent on that story, and named by no other threshold.
 */
function ownCheckpoint(
  draft: ProjectionDraft,
  thresholds: BudgetThresholds,
  parent: string | undefined,
  agent: string,
  story: string,
  id: string,
): boolean {
  const checkpoints = draft.state.checkpoints as Record<string, CheckpointState> | undefined;
  const checkpoint =
    checkpoints !== undefined && Object.hasOwn(checkpoints, id) ? checkpoints[id] : undefined;
  const claimed = Object.values(thresholds).some((entries) =>
    entries.some((entry) => entry.checkpoint === id),
  );
  return (
    checkpoint !== undefined &&
    checkpoint.type === "decision" &&
    checkpoint.story === story &&
    checkpoint.opened_by === agent &&
    parent !== undefined &&
    parent === checkpoint.opened_event &&
    costOf(draft, draft.parents.get(checkpoint.opened_event), agent, story) &&
    !claimed
  );
}

/**
 * The reducer of budget thresholds: `state.budget_thresholds[story]`, each threshold
 * as its event recorded it. Accepted only in the write of the cost that reached it: right after a
 * `cost.reported` of the same agent on the same story, or right after the budget checkpoint that
 * write opened (a `decision` of that story, by that agent, right after that cost, named by no
 * other threshold). Anything else is ignored (`invalid`).
 */
export const BUDGET_REDUCERS: Readonly<Record<string, Reducer>> = {
  [BUDGET_EVENT_TYPES.thresholdReached]: (draft: ProjectionDraft, event) => {
    const agent = event.actor.kind === "agent" ? event.actor.agent : undefined;
    const story = event.story;
    let thresholds = draft.state.budget_thresholds as BudgetThresholds | undefined;
    if (thresholds === undefined) {
      thresholds = dictionary<BudgetThresholdEntry[]>();
      draft.state.budget_thresholds = thresholds;
    }
    const payload = event.payload as BudgetThresholdReachedPayload;
    const parent = draft.parents.get(event.id);
    const linked =
      agent !== undefined &&
      story !== undefined &&
      (payload.checkpoint === undefined
        ? costOf(draft, parent, agent, story)
        : ownCheckpoint(draft, thresholds, parent, agent, story, payload.checkpoint));
    if (!linked || agent === undefined || story === undefined) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    const entries = Object.hasOwn(thresholds, story)
      ? (thresholds[story] as BudgetThresholdEntry[])
      : [];
    entries.push({
      story,
      level: payload.level,
      budget_usd: payload.budget_usd,
      ceiling: payload.ceiling,
      alert_ratio: payload.alert_ratio,
      on_exceed: payload.on_exceed,
      checkpoint: payload.checkpoint ?? null,
      agent,
      at: event.at,
      event: event.id,
    });
    thresholds[story] = entries;
  },
};
