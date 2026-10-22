import {
  AGENT_EVENT_TYPES,
  type AgentResult,
  type AgentStatus,
  type AgentStoryStatus,
  type EventEnvelope,
  type FastTrackDeclaration,
  type FastTrackEngineReason,
  type FastTrackLeaver,
  type FastTrackReason,
  type ResultStatus,
} from "@agentplugged/protocol";
import type { CriterionRecord } from "../criteria/criterion-rules.js";
import type { AttemptRecord } from "../loop/loop-rules.js";
import { nextStall, progressMark, type StallRecord } from "../loop/repeat-rules.js";
import { type ArchitectureReview, parseReviewLine } from "../phases/design-review.js";
import type { QaRecord } from "../qa/qa-rules.js";
import type { StoryReview } from "../review/review-rules.js";
import { storyDoneAt } from "../sprints/sprint-rules.js";
import type { CheckpointState } from "./checkpoint-reducers.js";
import type { StoryCi } from "./ci-reducers.js";
import type { ProjectionDraft, Reducer } from "./reducers.js";
import type { WriteGuardCounts } from "./write-guard-reducers.js";

/** `state.agents[agent]`: what an agent last declared. */
export interface AgentState {
  /** Its last status (`report_status`), or null when it never gave one. */
  status: AgentStatus | null;
  /** The task of its last status, or null. */
  task: string | null;
  /** The story of its last status, or null. */
  story: string | null;
  /** Date (`at`) of its last event of any kind. */
  last_signal_at: string;
  /** Its last result (`submit_result`), with or without a story, or null. */
  last_result: ResultEntry | null;
  /**
   * Its reviews of the architecture: each result without a story whose summary starts
   * with the review line, by the Git object id of the review document. Absent until the first one.
   */
  architecture_reviews?: Record<string, ArchitectureReview>;
}

/**
 * `state.instances[<agent>/<story>]`: one run of an agent on one story,
 * named by the pair ("Sam · story 4-2"). Two stories given to the same developer are two
 * instances; a story never has two developers. What the instance last declared, and when.
 */
export interface InstanceState {
  readonly agent: string;
  readonly story: string;
  /** Its last status (`report_status` on this story), or null. */
  status: AgentStatus | null;
  /** The task of that status, or null. */
  task: string | null;
  /** Date (`at`) of its last event on this story. */
  last_signal_at: string;
}

/** The key of an instance in `state.instances`: `<agent>/<story>`. */
export function instanceKey(agent: string, story: string): string {
  return `${agent}/${story}`;
}

/** `state.instances[<agent>/<story>]`, created when the journal never named it before. */
export function instanceOf(
  draft: ProjectionDraft,
  agent: string,
  story: string,
  at: string,
): InstanceState {
  let instances = draft.state.instances as Record<string, InstanceState> | undefined;
  if (instances === undefined) {
    instances = dictionary<InstanceState>();
    draft.state.instances = instances;
  }
  const key = instanceKey(agent, story);
  const instance = Object.hasOwn(instances, key)
    ? (instances[key] as InstanceState)
    : { agent, story, status: null, task: null, last_signal_at: at };
  instance.last_signal_at = at;
  instances[key] = instance;
  return instance;
}

/** A result recorded by `submit_result`. */
export interface ResultEntry {
  readonly agent: string;
  readonly story: string | null;
  readonly status: ResultStatus;
  readonly summary: string;
  readonly assumptions: readonly string[];
  readonly open_questions: readonly string[];
  readonly conflicts: readonly string[];
  readonly at: string;
}

/** `state.stories[story]`: what the agents last declared about a story. */
export interface StoryState {
  /** Its last status given by an agent (`update_story`), or null. */
  status: AgentStoryStatus | null;
  /** Who gave that status and when, or null. */
  status_by: { readonly agent: string; readonly at: string } | null;
  /** Its last progress (`report_progress`), or null. */
  progress: {
    readonly agent: string;
    readonly percent: number | null;
    readonly note: string;
    readonly at: string;
  } | null;
  /**
   * The last result of each agent on this story (`submit_result` with this story), by agent:
   * one agent's result never erases another's open questions and conflicts.
   */
  results: Record<string, ResultEntry>;
  /**
   * The checkpoints that block an action on this story, in opening order: open ones,
   * and waived ones whose deadline is past. Answering one lifts its blocks.
   */
  waiting_on: string[];
  /**
   * How it started (`story.started`): who builds it, its branch, base commit, main
   * branch read, worktree (relative to the main repository's folder), the machine that started
   * it, when, and the event. Absent until it starts.
   */
  started?: StoryStarted;
  /**
   * The last CI read of its pull request (`story.ci_reported`): forge, status, checks,
   * failed ones, pull request, when and by whom. Absent until the first read.
   */
  ci?: StoryCi;
  /**
   * Its pull request (`story.pr_opened`): the last one opened or updated. Absent until
   * the first one.
   */
  pull_request?: StoryPullRequest;
  /**
   * Its independent review (`story.reviewed`, `story.review_triaged`,
   * `story.review_published`): the passes, their reviews, findings and triage. Absent until the
   * first review.
   */
  review?: StoryReview;
  /** Its merge by the engine once the creator approved it (`story.merged`). */
  merged?: StoryMerged;
  /**
   * The files and folders the creator added to its scope (`scope_widen`), in the order
   * they were added.
   */
  scope_widened?: string[];
  /** The writes the guard refused or let through in doubt for this story. */
  write_guard?: WriteGuardCounts;
  /**
   * The creator's refusal of its merge checkpoint: rejected or changes requested,
   * with their note; the story went back to its developer.
   */
  merge_feedback?: StoryMergeFeedback;
  /**
   * Its fast track (`story.fast_track_*`): entered when it started, the engine's last
   * reading of its changes, and its way back to the full lane. Absent for a story of the full lane
   * from the start.
   */
  fast_track?: StoryFastTrack;
  /**
   * What the engine saw of its acceptance criteria (`story.criterion_recorded`): by
   * criterion number, the failing run, the passing run after it, or the declaration that it cannot
   * be tested. Absent until the first.
   */
  criteria?: Record<string, CriterionRecord>;
  /**
   * The latest acceptance QA of the story in a browser (`story.qa_reported`): by
   * criterion, the verdict and the proofs; the criteria outside the interface. Absent until the first.
   */
  qa?: QaRecord;
  /**
   * The approaches tried on it by the bounded loop (`story.attempt_recorded`), the
   * latest ones in order. Absent until the first.
   */
  attempts?: AttemptRecord[];
  /**
   * The conflicts of its branch with the main branch its developer qualified (
   * `story.conflict_qualified`), in order. Absent until the first.
   */
  conflicts?: StoryConflict[];
  /**
   * The last refresh of its open merge checkpoint after a new review pass (
   * `story.merge_refreshed`).
   */
  merge_refresh?: StoryMergeRefresh;
  /**
   * The same agent handing the story back (partial or blocked) without moving it, counted from its
   * results; gone at its complete result. Absent until the first.
   */
  stall?: StallRecord;
}

/** A conflict with the main branch, as its developer qualified it. */
export interface StoryConflict {
  readonly main: string;
  readonly head: string;
  readonly base_ref: string;
  readonly kind: "textual" | "substantive";
  readonly files: readonly { readonly path: string; readonly class: string }[];
  readonly files_truncated: boolean;
  readonly rationale: string;
  readonly recommendation: "keep_story" | "keep_main" | "combine" | null;
  /** The `decision` checkpoint of a conflict of substance, else null. */
  readonly checkpoint: string | null;
  readonly by: string;
  readonly at: string;
  readonly event: string;
}

/** A story's merge checkpoint refreshed for a new review pass. */
export interface StoryMergeRefresh {
  readonly checkpoint: string;
  readonly pass: number;
  readonly commit: string;
  readonly at: string;
  readonly event: string;
}

/** A story's fast track: the mode the story carries, and what the engine read. */
export interface StoryFastTrack {
  /** `active`: a small change in the fast track; `left`: back to the full lane, for good. */
  status: "active" | "left";
  /** The developer who entered it (the story's). */
  readonly agent: string;
  /** The change restated in one sentence. */
  readonly summary: string;
  readonly declared: FastTrackDeclaration;
  readonly entered_at: string;
  readonly entered_event: string;
  /** The engine's last reading of the changes of a commit. */
  checked?: {
    readonly commit: string;
    readonly count: number;
    readonly files: readonly string[];
    readonly files_truncated: boolean;
    readonly ok: boolean;
    readonly reasons: readonly FastTrackEngineReason[];
    readonly at: string;
    readonly event: string;
  };
  /** How and why it went back to the full lane. */
  left?: {
    readonly by: FastTrackLeaver;
    readonly reasons: readonly FastTrackReason[];
    readonly detail: string | null;
    readonly commit: string | null;
    readonly at: string;
    readonly event: string;
  };
}

/** A story's merge, as `story.merged` recorded it. */
export interface StoryMerged {
  /** The merge checkpoint approved; the one that was open (or null) for a merge seen on the forge. */
  readonly checkpoint: string | null;
  /** The pull request's forge, number and address; null for a merge without one (`into` is then set). */
  readonly forge: string | null;
  readonly pr: number | null;
  readonly url: string | null;
  /** The branch a merge without a pull request reached, else null. */
  readonly into: string | null;
  readonly commit: string;
  readonly merge_commit: string | null;
  readonly method: string;
  readonly files: readonly string[];
  readonly files_truncated: boolean;
  /** The weight of its code (lines added and removed, duplicates added), when recorded. */
  readonly weight?: {
    readonly added: number;
    readonly removed: number;
    /** Absent when the engine could not look for them. */
    readonly duplicates?: number;
  };
  readonly source: string;
  readonly already: boolean;
  /** The forge account that merged it, for a merge recorded from the forge, else null. */
  readonly merged_by: string | null;
  /** The agent that relayed the approval, or null for the creator at the terminal. */
  readonly by: string | null;
  readonly at: string;
  readonly event: string;
  /** Its rank among the product's merges, in projection order: 1, 2… */
  readonly seq: number;
}

/** The creator's refusal of a story's merge checkpoint. */
export interface StoryMergeFeedback {
  readonly checkpoint: string;
  readonly decision: "rejected" | "changes_requested";
  readonly note: string | null;
  readonly at: string;
}

/** `state.stories[id].pull_request`: a story's pull request, as `story.pr_opened` recorded it. */
export interface StoryPullRequest {
  readonly forge: string;
  readonly number: number;
  readonly url: string;
  readonly branch: string;
  readonly base: string;
  readonly head: string;
  readonly criteria: readonly boolean[];
  readonly tests: string;
  readonly tests_summary: string | null;
  readonly body_sha256: string;
  /** The agent that opened it, or null for the engine of a machine (the CLI). */
  readonly by: string | null;
  readonly at: string;
  readonly event: string;
}

/** `state.stories[id].started`: the story's start, as `story.started` recorded it. */
export interface StoryStarted {
  readonly agent: string;
  readonly branch: string;
  readonly base: string;
  readonly base_ref: string;
  readonly worktree: string;
  readonly device: string;
  readonly at: string;
  readonly event: string;
}

/** Costs added up: real and estimated dollars apart, tokens, number of reports. */
export interface CostTotals {
  /** Real cost, in US dollars. */
  usd: number;
  /** Estimated cost, in US dollars. */
  usd_estimated: number;
  tokens_in: number;
  tokens_out: number;
  reports: number;
  /** The share of the tools' quotas used, in percent, when they gave it. */
  quota_percent: number;
}

/**
 * `state.costs`: the totals of the product, and of each story. `runs` keeps the last cumulative
 * report of each task (agent, story, run), which the next one of the same task replaces (story
 * 4.3): never shown, only the totals are.
 */
export interface CostsState {
  readonly total: CostTotals;
  readonly by_story: Record<string, CostTotals>;
  /** The totals of each agent that reported a cost, all its stories together (absent until one does). */
  readonly by_agent?: Record<string, CostTotals>;
  readonly runs?: Record<string, CostPayload>;
}

/**
 * `state.cost_signals[story][agent]`: how many costs each agent declared on each story, drawn
 * from the envelopes only (type, story, agent are in clear): counted with or without the product
 * key, so that a story moving without any cost is seen everywhere.
 */
export type CostSignals = Record<string, Record<string, number>>;

/**
 * A dictionary keyed by identifiers read from the journal: without a prototype, so that no
 * identifier (`constructor`, `__proto__`) can reach `Object.prototype`.
 */
export function dictionary<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** `state[name]`, a dictionary created when needed. */
export function section<T>(draft: ProjectionDraft, name: string): Record<string, T> {
  const existing = draft.state[name] as Record<string, T> | undefined;
  if (existing !== undefined) return existing;
  const created = dictionary<T>();
  draft.state[name] = created;
  return created;
}

/** The stories of a projection's state, by id (an empty dictionary when there are none). */
export function storiesIn(
  state: Readonly<Record<string, unknown>> | undefined,
): Record<string, StoryState> {
  return (state?.stories as Record<string, StoryState> | undefined) ?? {};
}

/** `state.stories[id]`, when the journal names it (never an inherited property). */
export function storyIn(
  state: Readonly<Record<string, unknown>> | undefined,
  id: string,
): StoryState | undefined {
  const stories = storiesIn(state);
  return Object.hasOwn(stories, id) ? stories[id] : undefined;
}

/** The agent that wrote an event, undefined for any other actor. */
export function actingAgent(event: {
  actor: { kind: string; agent?: string | undefined };
}): string | undefined {
  return event.actor.kind === "agent" ? event.actor.agent : undefined;
}

/** The story of the event, when it is started and not done; else undefined. */
export function startedStory(draft: ProjectionDraft, event: EventEnvelope): StoryState | undefined {
  const stories = draft.state.stories as Record<string, StoryState> | undefined;
  const id = event.story;
  if (id === undefined || stories === undefined || !Object.hasOwn(stories, id)) return undefined;
  const story = stories[id] as StoryState;
  const checkpoints = Object.values(
    (draft.state.checkpoints as Record<string, CheckpointState> | undefined) ?? {},
  );
  if (story.started === undefined || storyDoneAt(checkpoints, id, story) !== undefined) {
    return undefined;
  }
  return story;
}

export function agentOf(draft: ProjectionDraft, event: EventEnvelope): AgentState | undefined {
  const id = event.actor.kind === "agent" ? event.actor.agent : undefined;
  if (id === undefined) return undefined;
  const agents = section<AgentState>(draft, "agents");
  const agent = Object.hasOwn(agents, id)
    ? (agents[id] as AgentState)
    : { status: null, task: null, story: null, last_signal_at: event.at, last_result: null };
  agent.last_signal_at = event.at;
  agents[id] = agent;
  // Its instance on the story the event names, when it builds that story.
  if (event.story !== undefined) touchInstance(draft, id, event.story, event.at);
  return agent;
}

/**
 * The instance of `agent` on `story`, when there is one: the agent builds the story (it started
 * it, or the CLI started it for that agent). A reviewer's event on the story is no instance.
 */
function touchInstance(
  draft: ProjectionDraft,
  agent: string,
  story: string,
  at: string,
): InstanceState | undefined {
  const instances = draft.state.instances as Record<string, InstanceState> | undefined;
  if (instances === undefined || !Object.hasOwn(instances, instanceKey(agent, story))) {
    return undefined;
  }
  return instanceOf(draft, agent, story, at);
}

function storyOf(draft: ProjectionDraft, event: EventEnvelope): StoryState | undefined {
  const id = event.story;
  if (id === undefined) return undefined;
  return storyById(draft, id);
}

/** `state.stories[id]`, created empty when the journal never named it before. */
export function storyById(draft: ProjectionDraft, id: string): StoryState {
  const stories = section<StoryState>(draft, "stories");
  const story = Object.hasOwn(stories, id)
    ? (stories[id] as StoryState)
    : {
        status: null,
        status_by: null,
        progress: null,
        results: dictionary<ResultEntry>(),
        waiting_on: [],
      };
  stories[id] = story;
  return story;
}

/** Dollars rounded to the micro-dollar: sums stay readable, and the same on every machine. */
const dollars = (value: number) => Math.round(value * 1e6) / 1e6;

const emptyTotals = (): CostTotals => ({
  usd: 0,
  usd_estimated: 0,
  tokens_in: 0,
  tokens_out: 0,
  reports: 0,
  quota_percent: 0,
});

/** A cost as its event holds it (version 2). */
export interface CostPayload {
  readonly usd?: number;
  readonly estimated: boolean;
  readonly tokens_in?: number;
  readonly tokens_out?: number;
  readonly billing?: "usage" | "subscription";
  readonly quota_percent?: number;
  readonly run?: string;
  readonly cumulative?: boolean;
}

/** Adds a cost to totals (`sign` 1), or takes back one added before (`sign` -1). */
function applyCost(totals: CostTotals, cost: CostPayload, sign: 1 | -1): void {
  if (cost.usd !== undefined) {
    if (cost.estimated) totals.usd_estimated = dollars(totals.usd_estimated + sign * cost.usd);
    else totals.usd = dollars(totals.usd + sign * cost.usd);
  }
  // Each report holds at most a billion tokens each way; totals stop at the largest safe integer.
  const tokens = (total: number, value: number | undefined) =>
    Math.max(0, Math.min(total + sign * (value ?? 0), Number.MAX_SAFE_INTEGER));
  totals.tokens_in = tokens(totals.tokens_in, cost.tokens_in);
  totals.tokens_out = tokens(totals.tokens_out, cost.tokens_out);
  if (cost.quota_percent !== undefined) {
    totals.quota_percent = dollars(totals.quota_percent + sign * cost.quota_percent);
  }
}

/** The key of a task's cumulative reports: its agent, story and run. */
function runKey(agent: string, story: string | undefined, run: string): string {
  return `${agent}\u0000${story ?? ""}\u0000${run}`;
}

/**
 * A story's totals once `cost`, declared by `agent`, is recorded: the reducer's rule applied in
 * memory to a copy (`report_cost` measures the threshold it reaches before writing).
 */
export function storyTotalsAfter(
  costs: CostsState | undefined,
  agent: string,
  story: string,
  cost: CostPayload,
): CostTotals {
  const current =
    costs !== undefined && Object.hasOwn(costs.by_story, story) ? costs.by_story[story] : undefined;
  const totals = current === undefined ? emptyTotals() : { ...current };
  if (cost.cumulative === true && cost.run !== undefined) {
    const key = runKey(agent, story, cost.run);
    const previous =
      costs?.runs !== undefined && Object.hasOwn(costs.runs, key) ? costs.runs[key] : undefined;
    if (previous !== undefined) applyCost(totals, previous, -1);
  }
  applyCost(totals, cost, 1);
  totals.reports += 1;
  return totals;
}

/**
 * Records that `event`, a `cost.reported`, was declared by its agent on its story
 * (`state.cost_signals`, and `draft.costEvents`): from its envelope only, its content read or not
 *. The same conditions on both paths (an agent actor, a story), each event once.
 */
export function noteCostSignal(draft: ProjectionDraft, event: EventEnvelope): void {
  const agent = event.actor.kind === "agent" ? event.actor.agent : undefined;
  if (agent === undefined || event.story === undefined || draft.costEvents.has(event.id)) return;
  draft.costEvents.set(event.id, { agent, story: event.story });
  let signals = draft.state.cost_signals as CostSignals | undefined;
  if (signals === undefined) {
    signals = dictionary<Record<string, number>>();
    draft.state.cost_signals = signals;
  }
  const byAgent = Object.hasOwn(signals, event.story)
    ? (signals[event.story] as Record<string, number>)
    : dictionary<number>();
  byAgent[agent] = (Object.hasOwn(byAgent, agent) ? (byAgent[agent] as number) : 0) + 1;
  signals[event.story] = byAgent;
}

/**
 * The reducers of the agents' events: the state of each agent (status, task, story,
 * date of its last signal, last result), of each story (status, last progress, last result) and
 * the costs (product and story totals, real and estimated apart). An event of another actor than
 * an agent changes no agent.
 */
export const AGENT_REDUCERS: Readonly<Record<string, Reducer>> = {
  [AGENT_EVENT_TYPES.statusReported]: (draft, event) => {
    const agent = agentOf(draft, event);
    if (agent === undefined) return;
    const payload = event.payload as { status: AgentStatus; task?: string };
    agent.status = payload.status;
    agent.task = payload.task ?? null;
    agent.story = event.story ?? null;
    const id = event.actor.agent;
    const instance =
      event.story !== undefined && id !== undefined
        ? touchInstance(draft, id, event.story, event.at)
        : undefined;
    if (instance !== undefined) {
      instance.status = payload.status;
      instance.task = payload.task ?? null;
    }
  },
  [AGENT_EVENT_TYPES.progressReported]: (draft, event) => {
    const agent = event.actor.agent;
    if (agentOf(draft, event) === undefined || agent === undefined) return;
    const story = storyOf(draft, event);
    if (story === undefined) return;
    const payload = event.payload as { percent?: number; note: string };
    story.progress = { agent, percent: payload.percent ?? null, note: payload.note, at: event.at };
  },
  /**
   * A cost: a delta adds up; a cumulative report replaces the previous
   * cumulative report of its task (agent, story, run), taken back from the totals first. Every
   * report counts in `reports`.
   */
  [AGENT_EVENT_TYPES.costReported]: (draft, event) => {
    const agent = event.actor.kind === "agent" ? event.actor.agent : undefined;
    if (agentOf(draft, event) === undefined || agent === undefined) return;
    noteCostSignal(draft, event);
    const payload = event.payload as unknown as CostPayload;
    let costs = draft.state.costs as CostsState | undefined;
    if (costs === undefined) {
      costs = { total: emptyTotals(), by_story: dictionary<CostTotals>() };
      draft.state.costs = costs;
    }
    const story =
      event.story === undefined
        ? undefined
        : Object.hasOwn(costs.by_story, event.story)
          ? (costs.by_story[event.story] as CostTotals)
          : emptyTotals();
    const byAgent = costs.by_agent ?? dictionary<CostTotals>();
    if (costs.by_agent === undefined)
      (costs as { by_agent?: Record<string, CostTotals> }).by_agent = byAgent;
    const own = Object.hasOwn(byAgent, agent) ? (byAgent[agent] as CostTotals) : emptyTotals();
    byAgent[agent] = own;
    if (payload.cumulative === true && payload.run !== undefined) {
      const runs = costs.runs ?? dictionary<CostPayload>();
      const key = runKey(agent, event.story, payload.run);
      const previous = Object.hasOwn(runs, key) ? runs[key] : undefined;
      if (previous !== undefined) {
        applyCost(costs.total, previous, -1);
        applyCost(own, previous, -1);
        if (story !== undefined) applyCost(story, previous, -1);
      }
      runs[key] = { ...payload };
      if (costs.runs === undefined) (costs as { runs?: Record<string, CostPayload> }).runs = runs;
    }
    applyCost(costs.total, payload, 1);
    costs.total.reports += 1;
    applyCost(own, payload, 1);
    own.reports += 1;
    if (story !== undefined && event.story !== undefined) {
      applyCost(story, payload, 1);
      story.reports += 1;
      costs.by_story[event.story] = story;
    }
  },
  [AGENT_EVENT_TYPES.storyStatusChanged]: (draft, event) => {
    const agent = event.actor.agent;
    if (agentOf(draft, event) === undefined || agent === undefined) return;
    const story = storyOf(draft, event);
    if (story === undefined) return;
    story.status = (event.payload as { status: AgentStoryStatus }).status;
    story.status_by = { agent, at: event.at };
  },
  [AGENT_EVENT_TYPES.resultRecorded]: (draft, event) => {
    const agent = agentOf(draft, event);
    const id = event.actor.agent;
    if (agent === undefined || id === undefined) return;
    const payload = event.payload as AgentResult;
    const entry: ResultEntry = {
      agent: id,
      story: event.story ?? null,
      status: payload.status,
      summary: payload.summary,
      assumptions: [...payload.assumptions],
      open_questions: [...payload.open_questions],
      conflicts: [...payload.conflicts],
      at: event.at,
    };
    agent.last_result = entry;
    const review = event.story === undefined ? parseReviewLine(payload.summary) : undefined;
    if (review !== undefined) {
      const reviews = agent.architecture_reviews ?? dictionary<ArchitectureReview>();
      reviews[review.review] = { ...review, status: payload.status, at: event.at };
      agent.architecture_reviews = reviews;
    }
    const story = storyOf(draft, event);
    if (story !== undefined) {
      story.results[id] = entry;
      const stall = nextStall(story.stall, id, payload.status, progressMark(story), event.at);
      if (stall === undefined) delete story.stall;
      else story.stall = stall;
    }
  },
};
