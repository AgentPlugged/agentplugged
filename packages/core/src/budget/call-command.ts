import {
  AGENT_EVENT_TYPES,
  BUDGET_EVENT_TYPES,
  CHECKPOINT_EVENT_TYPES,
  CheckCallInputSchema,
  MAIN_SESSION_AGENT,
} from "@agentplugged/protocol";
import { type CommandContext, defineCommand, ok } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import type { EventDraft } from "../journal/state-store.js";
import type { StoryState } from "../projection/agent-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import type { SprintState } from "../sprints/sprint-rules.js";
import { openPause } from "../team/team-rules.js";
import type { HookAnswer } from "../trust/trust-commands.js";
import {
  absolutePath,
  type GuardIndex,
  guardIndex,
  productRootOf,
} from "../write-guard/write-index.js";
import {
  type BudgetContext,
  budgetCheckpoint,
  gateOf,
  storyCeiling,
  type ThresholdEntry,
  type ThresholdPlan,
  thresholdPlan,
} from "./budget-rules.js";
import { budgetSettings } from "./budget-settings.js";
import { storyCostUsd } from "./call-cost.js";
import { budgetMessage, OWN_TOOL_PREFIX, pausedMessage, pauseHolds } from "./call-rules.js";

/**
 * `check_call`: the hook of Claude Code before every tool. It refuses a call in two cases and lets
 * every other through:
 *
 * - the story the call belongs to reached its budget: the engine reads what the story has cost (its
 *   own measure, never an agent's word), and refuses this call and the next ones until the creator
 *   answers the budget checkpoint it opens. A call already under way is never cut: the stop is at
 *   the nearest call, not at the nearest instant.
 * - the team is paused and an agent of a story would write, run a command or start an agent.
 *
 * The story is placed by the working copy the call runs in (`cwd`), like the guard before a write.
 * In doubt (no product, no journal, an error, a delay) the call goes through: the guard never
 * blocks without a proof, and never breaks a session.
 */

// Core has no platform types: the two timer functions it needs are declared here.
declare function setTimeout(handler: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;

/** How long the guard waits for the journal and the traces before it lets the call through. */
export const CALL_GUARD_BUDGET_MS = 1500;

/** A value the hook left as it was written (`${tool_name}`): the hook's input has no such field. */
const UNFILLED = /^\$\{[^}]*\}$/;

function given(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" || UNFILLED.test(trimmed) ? undefined : trimmed;
}

function deny(reason: string): HookAnswer {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

async function within<T>(ms: number, work: Promise<T>): Promise<T | undefined> {
  let timer: unknown;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** What the budget rules read of a projection. */
function budgetContextOf(index: GuardIndex, now: number): BudgetContext {
  const state = index.state as Record<string, unknown>;
  return {
    sprints: (state.sprints as Record<string, SprintState> | undefined) ?? {},
    checkpoints: (state.checkpoints as Record<string, CheckpointState> | undefined) ?? {},
    thresholds:
      (state.budget_thresholds as Record<string, readonly ThresholdEntry[]> | undefined) ?? {},
    now,
  };
}

/** The agent a story belongs to: whoever started it, else the main session. */
function agentOf(index: GuardIndex, story: string): string {
  const stories = (index.state as Record<string, unknown>).stories as
    | Record<string, StoryState>
    | undefined;
  return stories?.[story]?.started?.agent ?? MAIN_SESSION_AGENT;
}

/** A cost run's name. */
function runOf(story: string): string {
  // One run per story: the cost written is the story's whole cost, so a later report replaces it.
  return `hook-${story}`.slice(0, 64);
}

/**
 * What the journal records when a cost reaches a threshold, in one write and in the order the
 * projection reads it: the cost the engine measured (cumulative for its run, an equivalent at
 * public prices, never a billed amount), the budget checkpoint when one opens, the threshold.
 */
function drafts(
  index: GuardIndex,
  story: string,
  plan: ThresholdPlan,
  costUsd: number,
): EventDraft[] {
  const agent = agentOf(index, story);
  const settings = budgetSettings(index.config);
  const base = {
    actor: { kind: "agent" as const, agent },
    product: index.product,
    story,
    provenance: "trusted" as const,
  };
  const list: EventDraft[] = [
    {
      ...base,
      type: AGENT_EVENT_TYPES.costReported,
      payload: { usd: costUsd, estimated: true, run: runOf(story), cumulative: true },
    },
  ];
  if (plan.checkpoint) {
    list.push({
      ...base,
      type: CHECKPOINT_EVENT_TYPES.opened,
      payload: budgetCheckpoint(story, plan) as unknown as Record<string, unknown>,
    });
  }
  list.push({
    ...base,
    type: BUDGET_EVENT_TYPES.thresholdReached,
    ...(plan.checkpoint ? { checkpointField: "checkpoint" } : {}),
    payload: {
      level: plan.level,
      budget_usd: plan.budget_usd,
      ceiling: plan.source.id,
      alert_ratio: settings.alert_ratio,
      on_exceed: settings.on_exceed,
    },
  });
  return list;
}

interface Request {
  readonly tool: string;
  readonly cwd: string | undefined;
  readonly session: string | undefined;
  readonly agent: string | undefined;
}

/** The verdict on one call. Reads the journal (kept); writes only when a budget threshold is reached. */
async function judge(
  context: CommandContext,
  request: Request,
  root: string,
  waitMs: number,
): Promise<HookAnswer> {
  const got = await guardIndex(context);
  // A refusal rests on the journal as it is now: a ceiling the creator just raised must let go.
  const index = await got.fresh;
  if (index instanceof AgentPluggedError) return {};
  const productRoot = productRootOf(root);
  const place =
    request.cwd === undefined ? undefined : absolutePath(request.cwd, undefined, productRoot);
  const owner = place === undefined ? ({ kind: "outside" } as const) : index.ownerOf(place);
  // Outside the product and its stories' working copies: not the guard's business.
  if (owner.kind === "outside") return {};
  const story = owner.kind === "story" ? owner.id : undefined;
  const bound =
    request.agent !== undefined || (owner.kind === "story" && owner.root !== productRoot);
  const now = (context.now ?? Date.now)();
  const pause = openPause(index.state);
  if (pause !== undefined && pauseHolds(request.tool, bound)) {
    return deny(pausedMessage(pause.reason));
  }
  if (story === undefined) return {};
  // A session in the product's own folder is the main session unless it says it is an agent: the budget never holds it.
  if (owner.kind === "story" && owner.root === productRoot && request.agent === undefined)
    return {};
  const budget = budgetContextOf(index, now);
  const gate = gateOf(story, budget);
  if (gate.kind !== "open") {
    if (request.tool.startsWith(OWN_TOOL_PREFIX)) return {};
    return deny(budgetMessage(story, gate.kind, storyCeiling(story, budget)));
  }
  if (request.tool.startsWith(OWN_TOOL_PREFIX)) return {};
  const ceiling = storyCeiling(story, budget);
  if (ceiling === undefined || ceiling.usd === null || ceiling.stop) return {};
  const settings = budgetSettings(index.config);
  const cost = await storyCostUsd(context, index, story, waitMs);
  const plan = thresholdPlan(story, budget, settings, cost);
  if (plan === undefined) return {};
  await index.journal.appendAll(drafts(index, story, plan, cost));
  if (plan.level === "exceeded" && settings.on_exceed === "block") {
    return deny(budgetMessage(story, "reached", ceiling));
  }
  return {};
}

/** Calls are judged one at a time per journal: two calls never write the same threshold twice. */
const chains = new WeakMap<object, Promise<unknown>>();

export const checkCallCommand = defineCommand<HookAnswer>({
  name: "check_call",
  audience: "agent",
  description:
    "Called by Claude Code's PreToolUse hook before every tool; you do not need to call it. Answers nothing, or a denial: the story reached its budget (a checkpoint is open for the creator), or the team is paused. In doubt the call goes through.",
  inputSchema: CheckCallInputSchema,
  async run(context, input) {
    const parsed = CheckCallInputSchema.safeParse(input);
    // An input the guard cannot read is a doubt: the call goes through.
    if (!parsed.success) return ok({});
    const request: Request = {
      tool: given(parsed.data.tool) ?? "",
      cwd: given(parsed.data.cwd),
      session: given(parsed.data.session),
      agent: given(parsed.data.agent),
    };
    const root = context.projectRoot ?? context.chat?.project;
    if (root === undefined || context.journal === undefined || request.tool === "") return ok({});
    const budget = context.callGuardBudgetMs ?? CALL_GUARD_BUDGET_MS;
    const journal = context.journal;
    const previous = chains.get(journal) ?? Promise.resolve();
    const judging = previous
      .then(() => judge(context, request, root, Math.max(0, budget - 300)))
      .catch((): HookAnswer => ({}));
    chains.set(
      journal,
      judging.then(() => undefined),
    );
    const answer = await within(budget, judging);
    return ok(answer ?? {});
  },
});
