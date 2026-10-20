import {
  BUDGET_OPTIONS,
  BUDGET_RECOMMENDATION,
  BUDGET_TITLE_PREFIX,
  type BudgetExceedMode,
  type BudgetLevel,
  type BudgetOption,
  type CheckpointOpenedPayload,
  type CheckpointOption,
  MAX_BUDGET_USD,
} from "@agentplugged/protocol";
import { checkpointPayload } from "../checkpoints/checkpoint-rules.js";
import { statusAt } from "../checkpoints/resolution-rules.js";
import { approvedAt } from "../phases/phases.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import type { SprintState } from "../sprints/sprint-rules.js";

/**
 * Story budgets, as pure rules over what the journal holds: the ceiling in force for a story, where
 * a cost stands against it, which threshold a cost reaches, and the checkpoint that asks the
 * creator what to do when it is gone over. A ceiling comes from the latest sprint approved that
 * holds the story, or from the creator's answer to a budget checkpoint. A threshold counts only for
 * the ceiling it names (its source and its amount), never by a date.
 */

/** The budget settings in force: the alert ratio, and what going over the ceiling does. */
export interface BudgetSettingsInForce {
  readonly alert_ratio: number;
  readonly on_exceed: BudgetExceedMode;
}

/** Where a ceiling comes from: an approved sprint, or the creator's answer to a budget checkpoint. */
export interface CeilingSource {
  readonly kind: "sprint" | "checkpoint";
  readonly id: string;
}

/**
 * A story's ceiling: `usd` in US dollars, or null without one (the creator let it go on); `stop`
 * when the creator stopped the story (`usd` is then the ceiling it went over). The latest answer
 * wins: by its date, then by the identifier of the event that gave it.
 */
export interface BudgetCeiling {
  readonly usd: number | null;
  readonly stop: boolean;
  readonly source: CeilingSource;
  readonly at: string;
  readonly order: string;
}

/** A threshold the journal records for a story (the fields these rules read). */
export interface ThresholdEntry {
  readonly level: BudgetLevel;
  readonly budget_usd: number;
  readonly ceiling: string;
  readonly on_exceed: BudgetExceedMode;
  readonly checkpoint: string | null;
}

/** What the rules read of the projection. */
export interface BudgetContext {
  readonly sprints: Readonly<Record<string, SprintState>>;
  readonly checkpoints: Readonly<Record<string, CheckpointState>>;
  /** `state.budget_thresholds`: the thresholds recorded, by story. */
  readonly thresholds: Readonly<Record<string, readonly ThresholdEntry[]>>;
  /** The clock (milliseconds): the status of a checkpoint. */
  readonly now: number;
}

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Dollars rounded to the micro-dollar. */
const dollars = (value: number) => Math.round(value * 1e6) / 1e6;

const USD = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  useGrouping: false,
});

/** `$1.50` for 1.5 US dollars. */
function formatUsd(value: number): string {
  return `$${USD.format(value)}`;
}

/** A ceiling raised by an option: by half (at least $1) or double (at least $2), at most the max. */
export function raisedBudget(budget: number, option: BudgetOption): number | null {
  if (option === "no-limit" || option === "stop") return null;
  const [factor, floor] = option === "raise-50" ? [1.5, 1] : [2, 2];
  return Math.min(MAX_BUDGET_USD, Math.max(dollars(budget * factor), floor));
}

/** The raises worth offering on `budget`: each changes the ceiling, and differs from the others. */
export function offeredRaises(budget: number): ("raise-50" | "raise-100")[] {
  const half = raisedBudget(budget, "raise-50") as number;
  const double = raisedBudget(budget, "raise-100") as number;
  const offered: ("raise-50" | "raise-100")[] = [];
  if (half > budget) offered.push("raise-50");
  if (double > budget && double !== half) offered.push("raise-100");
  return offered;
}

/** The thresholds a story reached, in projection order. */
function thresholdsOf(context: BudgetContext, story: string): readonly ThresholdEntry[] {
  return own(context.thresholds, story) ?? [];
}

/** The option an answer chose: the option itself, the recommendation for an approval, or none. */
function chosenOption(checkpoint: CheckpointState): BudgetOption | undefined {
  const resolution = checkpoint.resolution;
  if (resolution === null) return undefined;
  const option =
    resolution.decision === "option_chosen"
      ? resolution.option
      : resolution.decision === "approved" || resolution.decision === "approved_with_reservations"
        ? checkpoint.recommendation
        : null;
  return option !== null && (BUDGET_OPTIONS as readonly string[]).includes(option)
    ? (option as BudgetOption)
    : undefined;
}

/**
 * The ceiling the creator's answer to a budget checkpoint sets, or undefined while it is open:
 * a raise or `no-limit` as chosen (an approval stands for the recommendation); anything else
 * (`stop`, a refusal, a waiver, an option the rules do not know) stops the story.
 */
function answeredCeiling(
  entry: ThresholdEntry,
  checkpoint: CheckpointState,
  now: number,
): BudgetCeiling | undefined {
  const resolution = checkpoint.resolution;
  if (resolution === null || statusAt(checkpoint, now) === "open") return undefined;
  const base = {
    source: { kind: "checkpoint" as const, id: checkpoint.id },
    at: resolution.at,
    order: resolution.event,
  };
  const option = chosenOption(checkpoint);
  const offered =
    option !== undefined && (checkpoint.options ?? []).some((item) => item.id === option);
  if (option === undefined || option === "stop" || !offered) {
    return { ...base, usd: entry.budget_usd, stop: true };
  }
  return { ...base, usd: raisedBudget(entry.budget_usd, option), stop: false };
}

/** True when ceiling `a` was set after `b`: the date of its answer, then its event identifier. */
function laterThan(a: BudgetCeiling, b: BudgetCeiling): boolean {
  const diff = Date.parse(a.at) - Date.parse(b.at);
  if (diff !== 0 && !Number.isNaN(diff)) return diff > 0;
  return a.order > b.order;
}

/**
 * A story's ceiling: the latest of the sprints approved (a lifting decision, never a waiver) that
 * hold it, each with the budget it recorded for the story, and of the creator's answers to its
 * budget checkpoints. Undefined without any: the story has no budget.
 */
export function storyCeiling(story: string, context: BudgetContext): BudgetCeiling | undefined {
  let latest: BudgetCeiling | undefined;
  const consider = (candidate: BudgetCeiling | undefined) => {
    if (candidate !== undefined && (latest === undefined || laterThan(candidate, latest))) {
      latest = candidate;
    }
  };
  for (const sprint of Object.values(context.sprints)) {
    const entry = sprint.stories.find((item) => item.id === story);
    const checkpoint = own(context.checkpoints, sprint.checkpoint);
    if (
      entry === undefined ||
      checkpoint === undefined ||
      checkpoint.opened_by !== sprint.planned_by ||
      checkpoint.resolution === null ||
      !approvedAt(checkpoint, context.now)
    ) {
      continue;
    }
    consider({
      usd: entry.budget_usd,
      stop: false,
      source: { kind: "sprint", id: sprint.id },
      at: checkpoint.resolution.at,
      order: checkpoint.resolution.event,
    });
  }
  for (const entry of thresholdsOf(context, story)) {
    const checkpoint =
      entry.checkpoint === null ? undefined : own(context.checkpoints, entry.checkpoint);
    if (checkpoint !== undefined) consider(answeredCeiling(entry, checkpoint, context.now));
  }
  return latest;
}

/** The thresholds recorded for `ceiling`: those naming its source, at its amount. */
function thresholdsForCeiling(
  entries: readonly ThresholdEntry[],
  ceiling: BudgetCeiling,
): ThresholdEntry[] {
  return entries.filter(
    (entry) => entry.ceiling === ceiling.source.id && entry.budget_usd === ceiling.usd,
  );
}

/** The budget checkpoint of the story still waiting for the creator, or undefined. */
function openBudgetCheckpoint(story: string, context: BudgetContext): string | undefined {
  for (const entry of thresholdsOf(context, story)) {
    const checkpoint =
      entry.checkpoint === null ? undefined : own(context.checkpoints, entry.checkpoint);
    if (checkpoint !== undefined && statusAt(checkpoint, context.now) === "open") {
      return checkpoint.id;
    }
  }
  return undefined;
}

/**
 * Whether work on a story may start: `open`; `pending`, a budget checkpoint of the story waits for
 * the creator; `stopped`, the creator stopped the story at its budget (a sprint approved since
 * that takes it again gives it a new ceiling and lifts it).
 */
export type BudgetGate =
  | { readonly kind: "open" }
  | { readonly kind: "pending"; readonly checkpoint: string }
  | { readonly kind: "stopped"; readonly checkpoint: string };

export function gateOf(story: string, context: BudgetContext): BudgetGate {
  const open = openBudgetCheckpoint(story, context);
  if (open !== undefined) return { kind: "pending", checkpoint: open };
  const ceiling = storyCeiling(story, context);
  if (ceiling?.stop === true) return { kind: "stopped", checkpoint: ceiling.source.id };
  return { kind: "open" };
}

/** Where `cost` stands against `budget` with `ratio`. */
export function statusFor(
  cost: number,
  budget: number,
  ratio: number,
): "ok" | "alert" | "exceeded" {
  if (cost > budget) return "exceeded";
  if (cost > 0 && cost >= dollars(ratio * budget)) return "alert";
  return "ok";
}

/** The threshold a cost reaches. */
export interface ThresholdPlan {
  readonly level: BudgetLevel;
  readonly budget_usd: number;
  /** Open a budget checkpoint before it (`exceeded` under `block`, none open yet). */
  readonly checkpoint: boolean;
  readonly source: CeilingSource;
}

/**
 * The threshold the story's cost reaches once it stands at `costUsd`, or undefined. Over the
 * ceiling: `exceeded`, unless one is recorded for the ceiling that counts under the setting (under
 * `block`, one recorded under `flag` does not); under `block`, a budget checkpoint opens with it
 * unless one is already open. Else at the alert ratio, above 0, with no threshold recorded for
 * the ceiling: `alert`. Nothing without a ceiling, under `no-limit` or once stopped.
 */
export function thresholdPlan(
  story: string,
  context: BudgetContext,
  settings: BudgetSettingsInForce,
  costUsd: number,
): ThresholdPlan | undefined {
  const ceiling = storyCeiling(story, context);
  if (ceiling === undefined || ceiling.usd === null || ceiling.stop) return undefined;
  const recorded = thresholdsForCeiling(thresholdsOf(context, story), ceiling);
  const status = statusFor(costUsd, ceiling.usd, settings.alert_ratio);
  if (status === "exceeded") {
    const handled = recorded.some(
      (entry) =>
        entry.level === "exceeded" &&
        (settings.on_exceed === "flag" || entry.on_exceed === "block"),
    );
    if (handled) return undefined;
    const block = settings.on_exceed === "block";
    const open = block && openBudgetCheckpoint(story, context) !== undefined;
    return {
      level: "exceeded",
      budget_usd: ceiling.usd,
      checkpoint: block && !open,
      source: ceiling.source,
    };
  }
  if (status === "alert" && recorded.length === 0) {
    return { level: "alert", budget_usd: ceiling.usd, checkpoint: false, source: ceiling.source };
  }
  return undefined;
}

/**
 * The budget checkpoint opened on a story gone over its ceiling: a `decision` at `medium` risk,
 * without blocks (the pause follows from it being open), whose options raise the ceiling by half
 * or double it (only when that changes it), let the story go on without one, or stop it. Never the
 * cost: only the ceiling, which the sprint already records in clear.
 */
export function budgetCheckpoint(story: string, plan: ThresholdPlan): CheckpointOpenedPayload {
  const budget = plan.budget_usd;
  const raises = offeredRaises(budget);
  const raise = (id: "raise-50" | "raise-100"): CheckpointOption => {
    const amount = formatUsd(raisedBudget(budget, id) as number);
    return {
      id,
      label: id === "raise-50" ? `Raise the budget to ${amount}` : `Double the budget to ${amount}`,
      consequence: `The story goes on with a budget of ${amount}; a new checkpoint opens if it goes over again.`,
    };
  };
  const from =
    plan.source.kind === "sprint" ? `sprint ${plan.source.id}` : `your answer to ${plan.source.id}`;
  const recommendation: BudgetOption = (raises as readonly BudgetOption[]).includes(
    BUDGET_RECOMMENDATION,
  )
    ? BUDGET_RECOMMENDATION
    : (raises[0] ?? "stop");
  return checkpointPayload({
    type: "decision",
    risk: "medium",
    title: `${BUDGET_TITLE_PREFIX}${story}`,
    summary: [
      `Story ${story} went over its budget of ${formatUsd(budget)}, set by ${from}.`,
      "Its agents stop working on it until you answer.",
      raises.length > 0
        ? "Choose a raise to give it a new budget, no-limit to let it go on without one, or stop."
        : "Its budget is at the largest one: choose no-limit to let it go on without one, or stop.",
      "A stopped story goes on only once a sprint approved later takes it again; any answer other than a raise or no-limit stops it.",
    ].join(" "),
    options: [
      ...raises.map(raise),
      {
        id: "no-limit",
        label: "Go on without a budget",
        consequence:
          "The story is never paused again for its cost, until a later sprint gives it a budget; its cost stays visible.",
      },
      {
        id: "stop",
        label: "Stop the story",
        consequence:
          "Its agents stop working on it; a sprint approved later that takes it again gives it a budget again.",
      },
    ],
    recommendation,
  });
}
