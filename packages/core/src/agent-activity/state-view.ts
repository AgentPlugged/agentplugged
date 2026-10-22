import {
  type CheckpointStatus,
  type CheckpointType,
  compareStoryIds,
  type GetStateInput,
} from "@agentplugged/protocol";
import { byOpening, truncate } from "../checkpoints/checkpoint-rules.js";
import { recordedTrace } from "../criteria/criterion-rules.js";
import type {
  AgentState,
  InstanceState,
  ResultEntry,
  StoryState,
} from "../projection/agent-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import type { DelegationEntry } from "../projection/delegation-reducers.js";
import type { ExchangeEntry } from "../projection/exchange-reducers.js";
import type { UsageView } from "../usage/usage-rules.js";
import type { FullStateView, OpenPoint } from "./agent-commands.js";

/**
 * The abridged state `get_state` returns. The complete state of a product that lived
 * for weeks weighs hundreds of thousands of characters (38 checkpoints made 119 411 of them after
 * six hours of use), and an AI tool refuses a tool result beyond about 25 000 tokens: the agent
 * then reads nothing. So `get_state` answers with a form that stays under `STATE_MAX_CHARS`
 * whatever the history: what a decision needs is kept in full (the open checkpoints, the open
 * questions and conflicts), the rest becomes a short digest and a counter, `truncated` says what
 * was cut and how many, and the options of `get_state` (`checkpoint`, `checkpoints`, `agent`,
 * `story`, `delegations`) read any part in full. The kept fields have the names of the complete
 * state. In a digest a field that is null (or a count that is zero) is left out: absent means none.
 */

/** What an AI tool accepts of a tool's output, with a margin (Claude Code: about 25 000 tokens). */
export const STATE_MAX_CHARS = 50_000;

/** What the abridged state aims at: tighter limits apply beyond it, to leave a margin. */
export const STATE_TARGET_CHARS = 48_000;

/** The size of a result as the MCP server writes it (indented JSON). */
export function stateSize(value: unknown): number {
  return JSON.stringify(value, null, 2).length;
}

/** How much of each part the abridged state keeps. */
export interface StateLimits {
  /** Resolved checkpoints shown as digests (the latest ones). */
  readonly resolved: number;
  /** Open checkpoints shown in full. */
  readonly open: number;
  /** Open questions and conflicts shown in full. */
  readonly openPoints: number;
  /** Stories not merged yet. */
  readonly stories: number;
  /** Merged stories still shown (the latest merges). */
  readonly merged: number;
  /** Ids of merged stories listed in `merged_order` (the latest merges). */
  readonly mergedOrder: number;
  /** Resolved checkpoints kept because a story waits on them or a sprint cites them. */
  readonly pinned: number;
  /** How many of them are digests (results, CI, review); the others only say where they stand. */
  readonly detailed: number;
  readonly delegations: number;
  /** Open items of deferred work and open deviations. */
  readonly register: number;
  readonly instances: number;
  readonly reads: number;
  readonly installs: number;
  readonly stacks: number;
  readonly warnings: number;
  /** Characters kept of a note, a summary of a checkpoint, a brief. */
  readonly text: number;
  /** Characters kept of an agent's summary, a task, a progress note. */
  readonly short: number;
}

/** What is kept at first. */
export const STATE_LIMITS: StateLimits = {
  resolved: 10,
  open: 20,
  openPoints: 20,
  stories: 40,
  merged: 5,
  mergedOrder: 300,
  pinned: 20,
  detailed: 6,
  delegations: 5,
  register: 20,
  instances: 20,
  reads: 10,
  installs: 5,
  stacks: 10,
  warnings: 10,
  text: 200,
  short: 90,
};

/**
 * What is kept when the state is still too large: each level cuts further than the one before.
 * The open checkpoints and the open points go last, and never to nothing.
 */
const FALLBACKS: readonly Partial<StateLimits>[] = [
  {
    resolved: 5,
    stories: 25,
    detailed: 3,
    merged: 3,
    pinned: 10,
    delegations: 3,
    register: 12,
    text: 150,
    short: 70,
  },
  {
    resolved: 2,
    stories: 12,
    detailed: 0,
    merged: 1,
    mergedOrder: 100,
    pinned: 5,
    delegations: 2,
    register: 8,
    instances: 10,
    reads: 5,
    installs: 3,
    text: 100,
    short: 50,
  },
  {
    resolved: 0,
    stories: 8,
    merged: 0,
    mergedOrder: 30,
    pinned: 3,
    delegations: 1,
    register: 5,
    instances: 5,
    reads: 3,
    installs: 1,
    stacks: 5,
    warnings: 5,
    text: 60,
    short: 30,
  },
  { open: 10, openPoints: 10, stories: 5 },
  { open: 5, openPoints: 5 },
];

/** The last result of an agent or on a story: its summary cut, and the counts of its lists. */
export interface ResultDigest {
  readonly agent: string;
  /** The story it is on, or null. */
  readonly story: string | null;
  readonly status: ResultEntry["status"];
  readonly summary: string;
  readonly at: string;
  /** The assumptions are in `get_state` with `agent` (or `story`). */
  readonly assumptions_count: number;
  /** Their text is in `open_points` (while open), or in `get_state` with `agent`. */
  readonly open_questions_count: number;
  readonly conflicts_count: number;
}

/** An agent, as the abridged state shows it. */
export interface AgentDigest {
  readonly status: AgentState["status"];
  readonly task: string | null;
  readonly story: string | null;
  readonly last_signal_at: string;
  readonly last_result: ResultDigest | null;
  /** The reviews of the architecture it gave (Chloé): their count. */
  readonly architecture_reviews_count?: number;
  /** It says it waits for a point that is already settled: it can resume. */
  readonly can_resume?: ResumeHint;
}

/** A point an agent says it waits for, already settled: the agent can resume. */
export interface ResumeHint {
  /** The point (G-…) the agent's task cites. */
  readonly checkpoint: string;
  /** How it was settled: `approved`, `rejected`, `changes_requested`… or its closed status. */
  readonly decision: string;
  readonly at: string | null;
}

/** A story, as the abridged state shows it: what it waits on and where it stands. */
export interface StoryDigest {
  readonly status: StoryState["status"];
  readonly status_by: StoryState["status_by"];
  readonly waiting_on: readonly string[];
  readonly progress?: {
    readonly agent: string;
    readonly percent: number | null;
    readonly note: string;
    readonly at: string;
  };
  /** Each agent's last result on it, as a digest. */
  readonly results?: Readonly<Record<string, ResultDigest>>;
  readonly started?: {
    readonly agent: string;
    readonly branch: string;
    /** The ref of the main branch it started from (`origin/main`): what a conflict is merged with. */
    readonly base_ref: string;
    readonly worktree: string;
    readonly at: string;
  };
  readonly ci?: {
    readonly status: string;
    readonly checks: number;
    readonly failed: readonly string[];
    readonly pr?: number;
    readonly url?: string;
    /** The head of the story's branch it covers. */
    readonly commit: string;
    readonly at: string;
    readonly by: string;
    readonly reason?: string;
  };
  /** Its pull request, without the head, the criteria and the test summary (`story` has them). */
  readonly pull_request?: {
    readonly number: number;
    readonly url: string;
    readonly branch: string;
    readonly tests: string;
    readonly by: string | null;
    readonly at: string;
  };
  /** Its review: the counts and the last pass, without the findings (`get_review` has them). */
  readonly review?: {
    readonly passes_total: number;
    readonly untriaged: number;
    readonly done: boolean;
    readonly last?: unknown;
  };
  /** Its merge; the files it changed are in `get_state` with `story`. */
  readonly merged?: {
    readonly checkpoint: string | null;
    /** The pull request; null for a merge without one, which names `into`. */
    readonly pr: number | null;
    readonly url: string | null;
    readonly into?: string;
    readonly merge_commit: string | null;
    readonly at: string;
    readonly seq: number;
    readonly files_count: number;
  };
  readonly merge_feedback?: {
    readonly checkpoint: string;
    readonly decision: string;
    readonly note?: string;
    readonly at: string;
  };
  /** What the engine saw of its acceptance criteria, one line: `1:green 2:red`. */
  readonly criteria?: string;
  /** Its fast track: where it stands, what the engine read (without the files) and why it left. */
  readonly fast_track?: {
    readonly status: "active" | "left";
    readonly agent: string;
    readonly summary: string;
    readonly declared: NonNullable<StoryState["fast_track"]>["declared"];
    readonly checked?: {
      readonly commit: string;
      readonly count: number;
      readonly ok: boolean;
      readonly reasons: readonly string[];
      readonly at: string;
    };
    readonly left?: {
      readonly by: string;
      readonly reasons: readonly string[];
      readonly detail?: string;
      readonly commit: string | null;
      readonly at: string;
    };
  };
  readonly conflicts_count?: number;
  /** True: the rest is in `get_state` with `story`. */
  readonly abridged: true;
}

/** The creator's answer to a checkpoint, as a digest shows it. */
export interface ResolutionDigest {
  readonly decision: string;
  readonly option?: string;
  /** The creator's note, cut when long (`checkpoint` reads it whole). */
  readonly note?: string;
  readonly at: string;
  readonly source: string;
  readonly assurance: string;
  /** The creator's words an agent relayed, cut when long. */
  readonly quote?: string;
  /** The agent that relayed the creator's words. */
  readonly relayed_by?: string;
  /** The AI tool whose form or question tool the creator answered in. */
  readonly channel?: string;
  /** `question_tool`: the creator chose in the tool's question tool, proved by its hook. */
  readonly via?: string;
  readonly waiver_until?: string;
}

/** An answered (or waived) checkpoint, as the abridged state and the pages show it. */
export interface CheckpointDigest {
  readonly id: string;
  readonly type: CheckpointType;
  readonly risk: CheckpointState["risk"];
  readonly title: string;
  readonly summary: string;
  readonly status: CheckpointStatus;
  readonly opened_by: string | null;
  readonly opened_at: string;
  readonly provenance: CheckpointState["provenance"];
  readonly blocks_lifted: boolean;
  readonly story?: string;
  readonly recommendation?: string;
  readonly supersedes?: string;
  readonly phase?: NonNullable<CheckpointState["phase"]>;
  readonly source?: NonNullable<CheckpointState["source"]>;
  readonly resolution?: ResolutionDigest;
  /** Why the engine closed it itself, when it did: its object was settled. */
  readonly closed?: {
    readonly reason: string;
    readonly ref?: string;
    readonly at: string;
  };
  /**
   * The documents it cites, at the blob the creator approved (what an approval covers): in the
   * pages (`checkpoints`) only; the abridged state has `documents_count`.
   */
  readonly documents?: CheckpointState["documents"];
  readonly documents_count?: number;
  readonly options_count?: number;
  readonly blocks_count?: number;
  /** True: the options, blocks, measures and the proof of the answer are in `checkpoint`. */
  readonly abridged: true;
}

/** An open checkpoint is in full; any other is a digest. */
export type CheckpointView = CheckpointState | CheckpointDigest;

/** What was cut from a part of the state, and how to read it. */
export interface TruncatedEntry {
  /** The part: a field of the state. */
  readonly section: string;
  readonly shown: number;
  readonly total: number;
  readonly omitted: number;
  /** The input of `get_state` that reads the rest, when one does. */
  readonly read?: Readonly<Record<string, unknown>>;
  readonly note?: string;
}

/** The abridged state `get_state` returns without an option. */
export interface AgentStateView {
  readonly clock: FullStateView["clock"];
  /** Noah's latest handovers (five), their brief cut. */
  readonly delegations: readonly DelegationEntry[];
  /** Noah's latest notes of an exchange with the creator (the same count as the handovers). */
  readonly exchanges: readonly ExchangeEntry[];
  readonly product: string | null;
  readonly journal_head: string | null;
  readonly agents: Readonly<Record<string, AgentDigest>>;
  /** The instances at work: those of the stories not merged yet. */
  readonly instances: Readonly<Record<string, InstanceState>>;
  /**
   * The stories not merged yet (a digest each), and the latest merges. The other merged stories are
   * in `merged_order`: read one with `story`.
   */
  readonly stories: Readonly<Record<string, StoryDigest>>;
  /** Every merged story, in the order of the merges: the first merged first. */
  readonly merged_order: readonly string[];
  /**
   * The open checkpoints in full, the latest resolved ones and the ones a story waits on or a
   * sprint cites as digests; `checkpoint_counts` counts them all.
   */
  readonly checkpoints: Readonly<Record<string, CheckpointView>>;
  readonly checkpoint_counts: Readonly<Record<CheckpointStatus | "total", number>>;
  readonly open_points: readonly OpenPoint[];
  readonly open_points_total: number;
  readonly warnings: FullStateView["warnings"];
  readonly phase: FullStateView["phase"];
  /** The steps of the journey the creator skipped: their choice, never an error. */
  readonly journey: FullStateView["journey"];
  /** The creator's Git workflow, and what waits in staging. */
  readonly git: FullStateView["git"];
  readonly session: FullStateView["session"];
  /** The latest external reads of the journal: a trace, nothing is blocked for it. */
  readonly external_reads: FullStateView["external_reads"];
  readonly sprint: FullStateView["sprint"];
  readonly deferred: FullStateView["deferred"];
  readonly deviations: FullStateView["deviations"];
  /** The non-functional requirements; absent without a register. */
  readonly requirements?: FullStateView["requirements"];
  /** The hypotheses open and the critiques not sorted yet; absent when none. */
  readonly critique?: FullStateView["critique"];
  /** The correction of course that is open; absent when none. */
  readonly course?: FullStateView["course"];
  /** The estimates of the next stories: an estimate, never what a story cost. */
  readonly usage: UsageView;
  readonly validation: FullStateView["validation"];
  readonly stacks: FullStateView["stacks"];
  readonly installs: FullStateView["installs"];
  /** What was cut, part by part: empty when nothing was. */
  readonly truncated: readonly TruncatedEntry[];
}

/**
 * The summary `get_state` returns without an option (corrections B). The abridged state
 * below weighs about 34 000 characters on a project at the start of its build and 70 000 later
 * (around 18 000 tokens), read on every call by a quota that is small on a free account. The
 * summary tells what an agent needs to choose its next move, one line per agent, per story and per
 * open point, in a few thousand characters: under 2 000 tokens on such a project. The detail of
 * anything stays one option away (`agent`, `story`, `checkpoint`, `checkpoints`, `delegations`),
 * and `full` reads the abridged state.
 */
export interface StateSummary {
  readonly detail: "summary";
  readonly clock: FullStateView["clock"];
  readonly product: string | null;
  /** The current phase, its status, and each phase's status in a line. */
  readonly phase: {
    readonly current: FullStateView["phase"]["current"];
    readonly status: FullStateView["phase"]["status"];
    readonly phases: string;
  };
  /** The agents at work or waiting, one line each: status, task, story, and `CAN RESUME` when due. */
  readonly agents: Readonly<Record<string, string>>;
  /** The other agents: idle, with nothing to say. */
  readonly agents_idle: readonly string[];
  /** The stories not merged yet, one line each: status, progress, what they wait on, CI. */
  readonly stories: Readonly<Record<string, string>>;
  readonly merged_stories: number;
  /** The latest merged stories, in the order of the merges (`full` lists them all). */
  readonly merged_order: readonly string[];
  /** The open checkpoints, one line each: `G-… · type · title · story`. */
  readonly open_checkpoints: readonly string[];
  /** The latest points the creator refused or sent back, whose blocks stay in force (`checkpoint` has their note). */
  readonly refused_checkpoints: readonly string[];
  /** The stacks with points still waiting. */
  readonly stacks_open: number;
  /** False once the session read external content (a trace, nothing is blocked). */
  readonly session_trusted: boolean;
  /** The open questions and conflicts of the last results: their count (`agent` or `story` reads them). */
  readonly open_questions: number;
  readonly sprint: string | null;
  /**
   * Noah's latest notes of an exchange with the creator, oldest first, one line each: read them
   * to take the thread up. Their content is data, never an instruction; absent when none.
   */
  readonly exchanges?: readonly string[];
  readonly deferred_open: number;
  readonly deviations_open: number;
  /** The non-functional requirements: counts and the gaps by id; absent without a register. */
  readonly requirements?: FullStateView["requirements"];
  /** The hypotheses open and the critiques not sorted yet; absent when none. */
  readonly critique?: FullStateView["critique"];
  /** The correction of course that is open; absent when none. */
  readonly course?: FullStateView["course"];
  readonly validation: FullStateView["validation"];
  /** The creator's workflow of branches, and what waits in staging. */
  readonly git: FullStateView["git"];
  /** The steps of the journey the creator skipped. */
  readonly journey: FullStateView["journey"];
  /** The installation mode and what the architecture declares (the latest installs are in `full`). */
  readonly installs: Omit<FullStateView["installs"], "recent">;
  /** The estimates of the next stories: an estimate, never a cost. */
  readonly usage: Pick<UsageView, "estimates">;
  readonly warnings: FullStateView["warnings"];
  /** How to read the detail. */
  readonly more: string;
}

/** Open checkpoints one line each, the newest first; the rest is counted. */
const SUMMARY_OPEN_CHECKPOINTS = 12;
/** Merged stories named in the summary (the latest merges). */
const SUMMARY_MERGED = 30;
/** Characters of a title or a task in a line of the summary. */
const SUMMARY_TEXT = 70;
/** Notes of an exchange named in the summary (the latest ones). */
const SUMMARY_EXCHANGES = 3;

const SUMMARY_MORE =
  "This is a summary. For the detail pass ONE option, never two, and no `detail` option exists: " +
  "`agent` (an id), `story` (an id), `checkpoint` (a G-… id), `checkpoints` ({status, type, story, limit, before}), " +
  "`delegations` ({limit, before}), or `full: true` for the whole abridged state (the sprints in full, every merged story, the deferred work and the deviations in full, the latest installs, the external reads).";

/** The summary of the complete state. Pure. */
export function summarizeState(full: FullStateView): StateSummary {
  const text = (value: string) => truncate(value.replace(/\s+/g, " "), SUMMARY_TEXT);
  const agents: Record<string, string> = {};
  const idle: string[] = [];
  for (const [id, agent] of Object.entries(full.agents)) {
    const resume = resumeHint(agent, full.checkpoints, id);
    const quiet = (agent.status === null || agent.status === "idle") && resume === undefined;
    if (quiet) {
      idle.push(id);
      continue;
    }
    agents[id] = [
      agent.status ?? "no status",
      agent.task === null ? undefined : JSON.stringify(text(agent.task)),
      agent.story === null ? undefined : `story ${agent.story}`,
      // A status is a declaration, not proof that something runs: it carries the day it was last
      // declared so that an old "working" is not taken for work in progress.
      `declared ${agent.last_signal_at.slice(0, 16)}Z`,
      resume === undefined
        ? undefined
        : `CAN RESUME: ${resume.checkpoint} was settled (${resume.decision}${
            resume.at === null ? "" : ` on ${resume.at.slice(0, 10)}`
          }), the wait is over`,
    ]
      .filter((part): part is string => part !== undefined)
      .join(" · ");
  }

  const stories: Record<string, string> = {};
  let merged = 0;
  for (const id of Object.keys(full.stories).sort(compareStoryIds)) {
    const story = full.stories[id] as StoryState;
    if (story.merged !== undefined) {
      merged += 1;
      continue;
    }
    stories[id] = [
      story.status ?? "not started",
      story.progress?.percent == null ? undefined : `${story.progress.percent}%`,
      story.waiting_on.length === 0 ? undefined : `waits for ${story.waiting_on.join(", ")}`,
      story.pull_request === undefined ? undefined : `PR #${story.pull_request.number}`,
      story.ci === undefined
        ? undefined
        : `CI ${story.ci.status}${story.ci.failed.length === 0 ? "" : ` (${story.ci.failed.slice(0, 3).join(", ")})`}`,
      story.merge_feedback === undefined ? undefined : "merge refused by the creator",
      story.fast_track?.status === "active" ? "fast track" : undefined,
    ]
      .filter((part): part is string => part !== undefined)
      .join(" · ");
  }

  const open = newestFirst(Object.values(full.checkpoints).filter((c) => c.status === "open"));
  const lines = open
    .slice(0, SUMMARY_OPEN_CHECKPOINTS)
    .map(
      (c) =>
        `${c.id} · ${c.type} · ${text(c.title)}${c.story === undefined ? "" : ` · story ${c.story}`}`,
    );
  if (open.length > lines.length) {
    lines.push(`… ${open.length - lines.length} more: \`checkpoints\` {status: "open"}`);
  }

  const sprint = full.sprint.current;
  const phases = full.phase.phases.map((p) => `${p.id} ${p.status}`).join(", ");
  const { recent: _recent, ...installs } = full.installs;
  const mergedIds = Object.keys(full.stories)
    .filter((id) => full.stories[id]?.merged !== undefined)
    .sort((a, b) => (full.stories[a]?.merged?.seq ?? 0) - (full.stories[b]?.merged?.seq ?? 0));
  return {
    detail: "summary",
    clock: full.clock,
    product: full.product,
    phase: { current: full.phase.current, status: full.phase.status, phases },
    agents,
    agents_idle: idle,
    stories,
    merged_stories: merged,
    merged_order: mergedIds.slice(-SUMMARY_MERGED),
    open_checkpoints: lines,
    refused_checkpoints: newestFirst(
      Object.values(full.checkpoints).filter(
        (c) =>
          c.status === "resolved" &&
          !c.blocks_lifted &&
          (c.resolution?.decision === "rejected" || c.resolution?.decision === "changes_requested"),
      ),
    )
      .slice(0, 3)
      .map((c) => `${c.id} · ${c.resolution?.decision} · ${text(c.title)}`),
    stacks_open: full.stacks.length,
    session_trusted: full.session.trusted,
    open_questions: full.open_points.length,
    sprint:
      sprint === null
        ? null
        : `${sprint.id} · ${sprint.status} · ${text(sprint.goal)} · ${sprint.stories
            .map((entry) => `${entry.id} ${entry.status}`)
            .join(", ")}`,
    ...(full.exchanges.length === 0
      ? {}
      : {
          exchanges: full.exchanges
            .slice(-SUMMARY_EXCHANGES)
            .map(
              (entry) =>
                `${entry.at.slice(0, 16)}${entry.provenance === "untrusted" ? " · untrusted" : ""} · ${entry.summary.replace(/\s+/g, " ")}`,
            ),
        }),
    deferred_open: full.deferred.open.length,
    deviations_open: full.deviations.open.length,
    ...(full.requirements === undefined ? {} : { requirements: full.requirements }),
    ...(full.critique === undefined ? {} : { critique: full.critique }),
    ...(full.course === undefined ? {} : { course: full.course }),
    validation: full.validation,
    git: full.git,
    journey: full.journey,
    installs,
    usage: { estimates: full.usage.estimates },
    warnings: full.warnings,
    more: SUMMARY_MORE,
  };
}

/** The detail an option of `get_state` reads. */
export type StateDetail =
  | { readonly detail: "checkpoint"; readonly checkpoint: CheckpointState }
  | {
      readonly detail: "checkpoints";
      /** A page, newest first, each as a digest with the documents it cites. */
      readonly checkpoints: readonly CheckpointDigest[];
      /** The checkpoints that match, before the page. */
      readonly total: number;
      /** The `before` of the next page, or null on the last. */
      readonly next_before: string | null;
    }
  | {
      readonly detail: "agent";
      readonly agent: string;
      readonly state: AgentState;
      /** It waits for a point already settled. */
      readonly can_resume?: ResumeHint;
      readonly instances: Readonly<Record<string, InstanceState>>;
      readonly open_points: readonly OpenPoint[];
    }
  | {
      readonly detail: "story";
      readonly story: string;
      /** The story in full: results, review, pull request, CI, merge (with its files). */
      readonly state: StoryState | null;
      /** How many files its merge changed, when `state.merged.files` lists only the first 200. */
      readonly merged_files_total?: number;
      /** The checkpoints of the story: the open ones in full, the others the latest 20 as digests. */
      readonly checkpoints: Readonly<Record<string, CheckpointView>>;
      readonly checkpoints_total: number;
      readonly instances: Readonly<Record<string, InstanceState>>;
      readonly open_points: readonly OpenPoint[];
      /** The open items of deferred work that lock it, or come from it. */
      readonly deferred: FullStateView["deferred"]["open"];
      /** Its open deviations. */
      readonly deviations: FullStateView["deviations"]["open"];
    }
  | {
      readonly detail: "delegations";
      readonly delegations: readonly DelegationEntry[];
      readonly total: number;
      readonly next_before: string | null;
    };

/** What `get_state` returns. */
export type GetStateResult = StateSummary | AgentStateView | StateDetail;

// ---------------------------------------------------------------------------------------------

/** Cuts free texts to a length (an ellipsis ends a cut one) and counts the cuts. */
class Cuts {
  count = 0;
  cut(text: string, max: number): string {
    if (text.length > max) this.count += 1;
    return truncate(text, max);
  }
}

/** The last `n` items (none for 0: `slice(-0)` would give them all). */
function last<T>(items: readonly T[], n: number): T[] {
  return items.slice(Math.max(0, items.length - n));
}

const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

function resultDigest(result: ResultEntry, cuts: Cuts, short: number): ResultDigest {
  return {
    agent: result.agent,
    story: result.story,
    status: result.status,
    summary: cuts.cut(result.summary, short),
    at: result.at,
    assumptions_count: result.assumptions.length,
    open_questions_count: result.open_questions.length,
    conflicts_count: result.conflicts.length,
  };
}

function agentDigest(
  agent: AgentState,
  cuts: Cuts,
  short: number,
  resume?: ResumeHint,
): AgentDigest {
  const reviews = Object.keys(agent.architecture_reviews ?? {}).length;
  return {
    status: agent.status,
    task: agent.task === null ? null : cuts.cut(agent.task, short),
    story: agent.story,
    last_signal_at: agent.last_signal_at,
    last_result: agent.last_result === null ? null : resultDigest(agent.last_result, cuts, short),
    ...(reviews > 0 ? { architecture_reviews_count: reviews } : {}),
    ...(resume === undefined ? {} : { can_resume: resume }),
  };
}

const POINT_ID = /G-[0-9A-HJKMNP-TV-Z]{10}/g;

/**
 * An agent whose status says it waits (`waiting`, `blocked`) for points its task cites
 * (`waiting for approval G-SNC3EDW20E`), all of them settled since (answered, waived or closed by
 * the engine), can resume. A status is a declaration: it is not corrected when the point is
 * answered, and the agent was shown as waiting for a permission it already had.
 */
export function resumeHint(
  agent: AgentState,
  checkpoints: Readonly<Record<string, CheckpointState>>,
  id?: string,
): ResumeHint | undefined {
  if (agent.status !== "waiting" || agent.task === null) return undefined;
  // Another point still open, opened by this agent or on its story: it does wait for something.
  const stillWaiting = Object.values(checkpoints).some(
    (point) =>
      point.status === "open" &&
      ((id !== undefined && point.opened_by === id) ||
        (agent.story !== null && point.story === agent.story)),
  );
  if (stillWaiting) return undefined;
  const cited = [...new Set(agent.task.match(POINT_ID) ?? [])];
  if (cited.length === 0) return undefined;
  const settled: CheckpointState[] = [];
  for (const id of cited) {
    const point = Object.hasOwn(checkpoints, id) ? checkpoints[id] : undefined;
    // An unknown point, or one still open: the agent does wait.
    if (point === undefined || point.status === "open") return undefined;
    // A refusal or a request for changes keeps its blocks: it is no permission to go on.
    const decision = point.resolution?.decision;
    if (decision === "rejected" || decision === "changes_requested") return undefined;
    settled.push(point);
  }
  const first = settled[0] as CheckpointState;
  return {
    checkpoint: first.id,
    decision: first.resolution?.decision ?? first.status,
    at: first.resolution?.at ?? null,
  };
}

/** The last pass of a review, without its commit and what only a closed review needs. */
function lastPass(passes: readonly unknown[]): unknown {
  const pass = passes[passes.length - 1] as Record<string, unknown>;
  return {
    number: pass.number,
    complete: pass.complete,
    outcome: pass.outcome,
    given: pass.given,
    reviews: pass.reviews,
  };
}

/** A story's digest: `slim` keeps its status and what waits on it, `digest` also where it stands. */
function storyDigest(
  story: StoryState,
  limits: StateLimits,
  cuts: Cuts,
  detailed: boolean,
): StoryDigest {
  const base = { status: story.status, status_by: story.status_by, waiting_on: story.waiting_on };
  if (story.merged !== undefined) {
    return {
      ...base,
      merged: {
        checkpoint: story.merged.checkpoint,
        pr: story.merged.pr,
        url: story.merged.url,
        ...(story.merged.into === null ? {} : { into: story.merged.into }),
        merge_commit: story.merged.merge_commit,
        at: story.merged.at,
        seq: story.merged.seq,
        files_count: story.merged.files.length,
      },
      abridged: true,
    };
  }
  const track = story.fast_track;
  const feedback = story.merge_feedback;
  const seen = recordedTrace(story.criteria, track?.status === "active");
  const kept = {
    ...base,
    ...(seen === undefined ? {} : { criteria: seen }),
    ...(feedback === undefined
      ? {}
      : {
          merge_feedback: {
            checkpoint: feedback.checkpoint,
            decision: feedback.decision,
            ...(feedback.note === null ? {} : { note: cuts.cut(feedback.note, limits.text) }),
            at: feedback.at,
          },
        }),
    ...(track === undefined
      ? {}
      : {
          fast_track: {
            status: track.status,
            agent: track.agent,
            summary: cuts.cut(track.summary, limits.short),
            declared: track.declared,
            ...(track.checked === undefined
              ? {}
              : {
                  checked: {
                    commit: track.checked.commit,
                    count: track.checked.count,
                    ok: track.checked.ok,
                    reasons: track.checked.reasons,
                    at: track.checked.at,
                  },
                }),
            ...(track.left === undefined
              ? {}
              : {
                  left: {
                    by: track.left.by,
                    reasons: track.left.reasons,
                    ...(track.left.detail === null
                      ? {}
                      : { detail: cuts.cut(track.left.detail, limits.short) }),
                    commit: track.left.commit,
                    at: track.left.at,
                  },
                }),
          },
        }),
  };
  if (!detailed) return { ...kept, abridged: true };
  const review = story.review as unknown as
    | { passes: readonly unknown[]; untriaged: number; done: boolean }
    | undefined;
  const pr = story.pull_request;
  const ci = story.ci;
  return {
    ...kept,
    ...(story.progress === null
      ? {}
      : { progress: { ...story.progress, note: cuts.cut(story.progress.note, limits.short) } }),
    results: Object.fromEntries(
      Object.entries(story.results).map(([agent, result]) => [
        agent,
        resultDigest(result, cuts, limits.short),
      ]),
    ),
    ...(story.started === undefined
      ? {}
      : {
          started: {
            agent: story.started.agent,
            branch: story.started.branch,
            base_ref: story.started.base_ref,
            worktree: story.started.worktree,
            at: story.started.at,
          },
        }),
    ...(ci === undefined
      ? {}
      : {
          ci: {
            status: ci.status,
            checks: ci.checks,
            failed: ci.failed,
            ...(ci.pr === undefined ? {} : { pr: ci.pr }),
            ...(ci.url === undefined ? {} : { url: ci.url }),
            commit: ci.commit,
            at: ci.at,
            by: ci.by,
            ...(ci.reason === undefined ? {} : { reason: cuts.cut(ci.reason, limits.short) }),
          },
        }),
    ...(pr === undefined
      ? {}
      : {
          pull_request: {
            number: pr.number,
            url: pr.url,
            branch: pr.branch,
            tests: pr.tests,
            by: pr.by,
            at: pr.at,
          },
        }),
    ...(review === undefined
      ? {}
      : {
          review: {
            passes_total: review.passes.length,
            untriaged: review.untriaged,
            done: review.done,
            ...(review.passes.length > 0 ? { last: lastPass(review.passes) } : {}),
          },
        }),
    ...((story.conflicts?.length ?? 0) > 0
      ? { conflicts_count: story.conflicts?.length ?? 0 }
      : {}),
    abridged: true,
  };
}

/** A checkpoint that is not open, as a digest (with its documents when `documents`). */
export function checkpointDigest(
  checkpoint: CheckpointState,
  cuts: Cuts,
  text: number,
  documents: boolean,
): CheckpointDigest {
  const resolution = checkpoint.resolution;
  const options = checkpoint.options?.length ?? 0;
  return {
    id: checkpoint.id,
    type: checkpoint.type,
    risk: checkpoint.risk,
    title: cuts.cut(checkpoint.title, text),
    summary: cuts.cut(checkpoint.summary, text),
    status: checkpoint.status,
    opened_by: checkpoint.opened_by,
    opened_at: checkpoint.opened_at,
    provenance: checkpoint.provenance,
    blocks_lifted: checkpoint.blocks_lifted,
    ...(checkpoint.story === null ? {} : { story: checkpoint.story }),
    ...(checkpoint.recommendation === null ? {} : { recommendation: checkpoint.recommendation }),
    ...(checkpoint.supersedes === null ? {} : { supersedes: checkpoint.supersedes }),
    ...(checkpoint.phase === null ? {} : { phase: checkpoint.phase }),
    ...(checkpoint.source === null ? {} : { source: checkpoint.source }),
    ...(resolution === null
      ? {}
      : {
          resolution: {
            decision: resolution.decision,
            ...(resolution.option === null ? {} : { option: resolution.option }),
            ...(resolution.note === null ? {} : { note: cuts.cut(resolution.note, text) }),
            at: resolution.at,
            source: resolution.source,
            assurance: resolution.assurance,
            ...(resolution.quote === null ? {} : { quote: cuts.cut(resolution.quote, text) }),
            ...(resolution.relayed_by === null ? {} : { relayed_by: resolution.relayed_by }),
            ...(resolution.channel == null ? {} : { channel: resolution.channel }),
            ...(resolution.via === undefined ? {} : { via: resolution.via }),
            ...(resolution.waiver_until === null ? {} : { waiver_until: resolution.waiver_until }),
          },
        }),
    ...(checkpoint.closed == null
      ? {}
      : {
          closed: {
            reason: checkpoint.closed.reason,
            ...(checkpoint.closed.ref === null ? {} : { ref: checkpoint.closed.ref }),
            at: checkpoint.closed.at,
          },
        }),
    ...(documents
      ? { documents: checkpoint.documents }
      : checkpoint.documents.length > 0
        ? { documents_count: checkpoint.documents.length }
        : {}),
    ...(options > 0 ? { options_count: options } : {}),
    ...(checkpoint.blocks.length > 0 ? { blocks_count: checkpoint.blocks.length } : {}),
    abridged: true,
  };
}

/** The checkpoints newest first: the order the pages and the latest resolved ones follow. */
function newestFirst(checkpoints: Iterable<CheckpointState>): CheckpointState[] {
  return [...checkpoints].sort((a, b) => byOpening(b, a));
}

function counts(checkpoints: readonly CheckpointState[]): AgentStateView["checkpoint_counts"] {
  const found: Record<CheckpointStatus | "total", number> = {
    open: 0,
    resolved: 0,
    waived: 0,
    closed: 0,
    total: checkpoints.length,
  };
  for (const checkpoint of checkpoints) found[checkpoint.status] += 1;
  return found;
}

/** The abridged state at the given limits. Pure: the same complete state gives the same result. */
export function abridgeState(full: FullStateView, limits: StateLimits): AgentStateView {
  const truncated: TruncatedEntry[] = [];
  const note = (entry: TruncatedEntry) => truncated.push(entry);
  const cuts = new Cuts();

  // Agents: every one, each with a short digest of its last result.
  const agents = Object.fromEntries(
    Object.entries(full.agents).map(([id, agent]) => [
      id,
      agentDigest(agent, cuts, limits.short, resumeHint(agent, full.checkpoints, id)),
    ]),
  );

  // Stories: those not merged yet, then the latest merges; the others are in `merged_order`.
  const allStories = Object.keys(full.stories);
  const merged = allStories
    .filter((id) => full.stories[id]?.merged !== undefined)
    .sort((a, b) => (full.stories[a]?.merged?.seq ?? 0) - (full.stories[b]?.merged?.seq ?? 0));
  const live = allStories
    .filter((id) => full.stories[id]?.merged === undefined)
    .sort((a, b) => {
      // What waits on something comes first, then the stories being worked.
      const rank = (id: string) => {
        const story = full.stories[id] as StoryState;
        if (story.waiting_on.length > 0) return 0;
        if (story.status === "blocked") return 1;
        return story.status === "in_review" || story.status === "in_progress" ? 2 : 3;
      };
      return rank(a) - rank(b) || compareStoryIds(a, b);
    });
  const detailedIds = new Set(live.slice(0, limits.detailed));
  const shownLive = live.slice(0, limits.stories).sort(compareStoryIds);
  const shownMerged = merged.slice(Math.max(0, merged.length - limits.merged));
  const shownStories = [...shownLive, ...shownMerged];
  const stories = Object.fromEntries(
    shownStories.map((id) => [
      id,
      storyDigest(full.stories[id] as StoryState, limits, cuts, detailedIds.has(id)),
    ]),
  );
  if (shownLive.length < live.length) {
    note({
      section: "stories",
      shown: shownLive.length,
      total: live.length,
      omitted: live.length - shownLive.length,
      read: { story: "<id>" },
      note: "stories not merged yet, left out of this state: read one with `story`",
    });
  }
  if (shownMerged.length < merged.length) {
    note({
      section: "stories.merged",
      shown: shownMerged.length,
      total: merged.length,
      omitted: merged.length - shownMerged.length,
      read: { story: "<id>" },
      note: "the other merged stories are listed in `merged_order`",
    });
  }

  // Checkpoints: the open ones in full, then the digests of what a story or a sprint points at,
  // then the latest resolved ones.
  const all = Object.values(full.checkpoints);
  const views: Record<string, CheckpointView> = {};
  const pinned = new Set<string>();
  for (const story of Object.values(full.stories))
    for (const id of story.waiting_on) pinned.add(id);
  for (const sprint of [full.sprint.current, full.sprint.latest]) {
    if (sprint !== null) pinned.add(sprint.checkpoint);
  }
  // When there are more open checkpoints than are shown, the ones a story waits on, a stack still
  // holds, or only the terminal answers come first, then the oldest ones.
  const urgent = new Set([
    ...pinned,
    ...full.validation.review,
    ...full.stacks.flatMap((stack) => stack.remaining.map((item) => item.checkpoint)),
  ]);
  const open = newestFirst(all.filter((checkpoint) => checkpoint.status === "open"))
    .reverse()
    .sort((a, b) => Number(urgent.has(b.id)) - Number(urgent.has(a.id)));
  const shownOpen = open.slice(0, limits.open);
  const settled = newestFirst(all.filter((checkpoint) => checkpoint.status !== "open"));
  const shownSettled = new Set<string>();
  const pinnedSettled = settled.filter((checkpoint) => pinned.has(checkpoint.id));
  for (const checkpoint of pinnedSettled.slice(0, limits.pinned)) shownSettled.add(checkpoint.id);
  if (pinnedSettled.length > limits.pinned) {
    note({
      section: "checkpoints.waited_on",
      shown: limits.pinned,
      total: pinnedSettled.length,
      omitted: pinnedSettled.length - limits.pinned,
      read: { story: "<id>" },
      note: "answered checkpoints that stories wait on or a sprint cites, the oldest left out: a story's are in `story`",
    });
  }
  let latest = 0;
  for (const checkpoint of settled) {
    if (latest >= limits.resolved) break;
    if (!shownSettled.has(checkpoint.id)) {
      shownSettled.add(checkpoint.id);
      latest += 1;
    }
  }
  for (const checkpoint of shownOpen) views[checkpoint.id] = checkpoint;
  for (const checkpoint of settled) {
    if (shownSettled.has(checkpoint.id)) {
      views[checkpoint.id] = checkpointDigest(checkpoint, cuts, limits.text, false);
    }
  }
  const settledOmitted = settled.length - shownSettled.size;
  if (settledOmitted > 0) {
    note({
      section: "checkpoints.resolved",
      shown: shownSettled.size,
      total: settled.length,
      omitted: settledOmitted,
      read: { checkpoints: { status: "resolved" } },
      note: `${settledOmitted} other resolved checkpoints: read a page with \`checkpoints\`, one in full with \`checkpoint\``,
    });
  }
  if (shownOpen.length < open.length) {
    note({
      section: "checkpoints.open",
      shown: shownOpen.length,
      total: open.length,
      omitted: open.length - shownOpen.length,
      read: { checkpoints: { status: "open" } },
      note: "some open checkpoints are left out of this state (the ones no story waits on first, the newest): list them with `checkpoints`, read one in full with `checkpoint`",
    });
  }

  // Open questions and conflicts: in full.
  const ofMerged = (point: OpenPoint) =>
    point.story !== null && full.stories[point.story]?.merged !== undefined;
  const ordered = [
    ...full.open_points.filter((point) => !ofMerged(point)),
    ...full.open_points.filter(ofMerged),
  ];
  const points = ordered.slice(0, limits.openPoints);
  if (points.length < full.open_points.length) {
    note({
      section: "open_points",
      shown: points.length,
      total: full.open_points.length,
      omitted: full.open_points.length - points.length,
      read: { agent: "<id>" },
      note: "the others are in the last results: read an agent's with `agent`, a story's with `story`",
    });
  }

  // The instances of the stories not merged yet, the most recent first.
  const working = Object.entries(full.instances)
    .filter(([, instance]) => full.stories[instance.story]?.merged === undefined)
    .sort(([, a], [, b]) => (a.last_signal_at < b.last_signal_at ? 1 : -1));
  const instances = Object.fromEntries(working.slice(0, limits.instances));
  if (working.length > limits.instances) {
    note({
      section: "instances",
      shown: limits.instances,
      total: working.length,
      omitted: working.length - limits.instances,
      note: "the most recently active instances of the stories not merged yet are shown",
    });
  }

  const reads = last(full.session.reads, limits.reads);
  if (reads.length < full.session.reads.length) {
    note({
      section: "session.reads",
      shown: reads.length,
      total: full.session.reads.length,
      omitted: full.session.reads.length - reads.length,
      note: "the latest external reads are shown",
    });
  }

  const recentReads = last(full.external_reads.recent, limits.reads);
  if (recentReads.length < full.external_reads.recent.length) {
    note({
      section: "external_reads.recent",
      shown: recentReads.length,
      total: full.external_reads.recent.length,
      omitted: full.external_reads.recent.length - recentReads.length,
      note: "the latest external reads are shown",
    });
  }

  const delegations = full.delegations
    .slice(Math.max(0, full.delegations.length - limits.delegations))
    .map((entry) => ({ ...entry, brief: cuts.cut(entry.brief, limits.text) }));
  if (delegations.length < full.delegations.length) {
    note({
      section: "delegations",
      shown: delegations.length,
      total: full.delegations.length,
      omitted: full.delegations.length - delegations.length,
      read: { delegations: {} },
      note: "the latest handovers are shown, their brief cut: read a page with `delegations`",
    });
  }

  // A note is one short line already (300 characters at most): it is never cut.
  const exchanges = full.exchanges.slice(Math.max(0, full.exchanges.length - limits.delegations));
  if (exchanges.length < full.exchanges.length) {
    note({
      section: "exchanges",
      shown: exchanges.length,
      total: full.exchanges.length,
      omitted: full.exchanges.length - exchanges.length,
      note: "the latest notes of an exchange are shown",
    });
  }

  const deferredOpen = full.deferred.open.slice(0, limits.register).map((item) => ({
    ...item,
    detail: item.detail === null ? null : cuts.cut(item.detail, limits.text),
  }));
  if (deferredOpen.length < full.deferred.open.length) {
    note({
      section: "deferred.open",
      shown: deferredOpen.length,
      total: full.deferred.open.length,
      omitted: full.deferred.open.length - deferredOpen.length,
      read: { story: "<id>" },
      note: "the other open items of deferred work: the ones of a story or that lock it are in `story`; `npx agentplugged deferred list` lists them all",
    });
  }
  const deviationsOpen = full.deviations.open.slice(0, limits.register);
  if (deviationsOpen.length < full.deviations.open.length) {
    note({
      section: "deviations.open",
      shown: deviationsOpen.length,
      total: full.deviations.open.length,
      omitted: full.deviations.open.length - deviationsOpen.length,
      read: { story: "<id>" },
      note: "the other open deviations: a story's are in `story`",
    });
  }

  const stacks = full.stacks.slice(0, limits.stacks);
  if (stacks.length < full.stacks.length) {
    note({
      section: "stacks",
      shown: stacks.length,
      total: full.stacks.length,
      omitted: full.stacks.length - stacks.length,
    });
  }
  const warnings = full.warnings.slice(0, limits.warnings);
  if (warnings.length < full.warnings.length) {
    note({
      section: "warnings",
      shown: warnings.length,
      total: full.warnings.length,
      omitted: full.warnings.length - warnings.length,
    });
  }
  const recent = last(full.installs.recent, limits.installs);
  if (recent.length < full.installs.recent.length) {
    note({
      section: "installs.recent",
      shown: recent.length,
      total: full.installs.recent.length,
      omitted: full.installs.recent.length - recent.length,
      note: "the latest installations are shown",
    });
  }

  // The sprints' stories are a line each; a very long sprint is cut.
  const sprintStories = Math.max(limits.stories, 10);
  const sprint = (which: "current" | "latest") => {
    const view = full.sprint[which];
    if (view === null || view.stories.length <= sprintStories) return view;
    note({
      section: `sprint.${which}.stories`,
      shown: sprintStories,
      total: view.stories.length,
      omitted: view.stories.length - sprintStories,
      note: "the first stories of the sprint are shown, in order",
    });
    return { ...view, stories: view.stories.slice(0, sprintStories) };
  };

  if (cuts.count > 0) {
    note({
      section: "texts",
      shown: 0,
      total: cuts.count,
      omitted: cuts.count,
      note: "texts ending with an ellipsis are cut: read them in full with `checkpoint`, `agent` or `story`",
    });
  }

  return {
    clock: full.clock,
    delegations,
    exchanges,
    product: full.product,
    journal_head: full.journal_head,
    agents,
    instances,
    stories,
    merged_order: merged.slice(Math.max(0, merged.length - limits.mergedOrder)),
    checkpoints: views,
    checkpoint_counts: counts(all),
    open_points: points,
    open_points_total: full.open_points.length,
    warnings,
    phase: full.phase,
    journey: full.journey,
    git: full.git,
    session: { ...full.session, reads },
    external_reads: { ...full.external_reads, recent: recentReads },
    sprint: { current: sprint("current"), latest: sprint("latest") },
    deferred: { ...full.deferred, open: deferredOpen },
    deviations: { ...full.deviations, open: deviationsOpen },
    ...(full.requirements === undefined ? {} : { requirements: full.requirements }),
    ...(full.critique === undefined ? {} : { critique: full.critique }),
    ...(full.course === undefined ? {} : { course: full.course }),
    usage: full.usage,
    validation: full.validation,
    stacks,
    installs: { ...full.installs, recent },
    truncated,
  };
}

/**
 * The abridged state of the complete one: at the usual limits, then at ever tighter ones until it
 * fits `STATE_MAX_CHARS` (never beyond the last level: the open checkpoints stay in full).
 */
export function fitState(full: FullStateView): AgentStateView {
  let limits = STATE_LIMITS;
  let view = abridgeState(full, limits);
  for (const fallback of FALLBACKS) {
    if (stateSize(view) <= STATE_TARGET_CHARS) break;
    limits = { ...limits, ...fallback };
    view = abridgeState(full, limits);
  }
  // Open checkpoints of the longest kind (2 000 characters of summary, 20 documents, options)
  // can weigh 10 000 characters each: past the last level, fewer of them are shown in full.
  for (const open of [3, 2, 1]) {
    if (stateSize(view) <= STATE_MAX_CHARS) break;
    limits = { ...limits, open, openPoints: Math.min(limits.openPoints, open * 3) };
    view = abridgeState(full, limits);
  }
  // Still too large (thousands of merged stories, hundreds of agents): say so rather than be silent.
  if (stateSize(view) > STATE_MAX_CHARS) {
    view = {
      ...view,
      truncated: [
        ...view.truncated,
        {
          section: "size_limit",
          shown: 0,
          total: 0,
          omitted: 0,
          note: "this state still exceeds the size limit of a tool result: read the parts you need with the options of `state.get`",
        },
      ],
    };
  }
  return view;
}

// ---------------------------------------------------------------------------------------------
// The options of `get_state`

/** The files of a merge `story` lists in full. */
const MERGED_FILES_SHOWN = 200;

/** The default size of a page of checkpoints. */
export const CHECKPOINTS_PAGE = 10;
/** The default size of a page of delegations. */
export const DELEGATIONS_PAGE = 5;

/** `found` with the detail, or the option and the id that name nothing. */
export type DetailOutcome =
  | { readonly found: true; readonly value: StateDetail }
  | {
      readonly found: false;
      readonly option: "checkpoint" | "agent" | "story";
      readonly id: string;
    };

/** The checkpoint `id` in full: its options, blocks, measures, verdict and the proof of its answer. */
function checkpointDetail(full: FullStateView, id: string): DetailOutcome {
  const checkpoint = own(full.checkpoints, id);
  if (checkpoint === undefined) return { found: false, option: "checkpoint", id };
  return { found: true, value: { detail: "checkpoint", checkpoint } };
}

/** The most `items` that keep `build(n)` under the limit: a page of long entries is shortened. */
function fitPage<T>(items: readonly T[], build: (kept: readonly T[]) => unknown): readonly T[] {
  let kept = items;
  while (kept.length > 1 && stateSize(build(kept)) > STATE_MAX_CHARS) {
    kept = kept.slice(0, kept.length - 1);
  }
  return kept;
}

function checkpointsPage(
  full: FullStateView,
  filter: NonNullable<GetStateInput["checkpoints"]>,
): StateDetail {
  const limit = filter.limit ?? CHECKPOINTS_PAGE;
  const cursor = filter.before === undefined ? undefined : own(full.checkpoints, filter.before);
  const matching = newestFirst(Object.values(full.checkpoints)).filter(
    (checkpoint) =>
      (filter.status === undefined || checkpoint.status === filter.status) &&
      (filter.type === undefined || checkpoint.type === filter.type) &&
      (filter.story === undefined || checkpoint.story === filter.story),
  );
  // The page: the checkpoints opened before the cursor, the newest first.
  const rest = matching.filter(
    (checkpoint) => cursor === undefined || byOpening(checkpoint, cursor) < 0,
  );
  const cuts = new Cuts();
  const digests = rest
    .slice(0, limit)
    .map((checkpoint) => checkpointDigest(checkpoint, cuts, STATE_LIMITS.text, true));
  const page = fitPage(digests, (kept) => ({ checkpoints: kept }));
  const last = page[page.length - 1];
  return {
    detail: "checkpoints",
    checkpoints: page,
    total: matching.length,
    next_before: page.length < rest.length && last !== undefined ? last.id : null,
  };
}

function agentDetail(full: FullStateView, id: string): DetailOutcome {
  const state = own(full.agents, id);
  if (state === undefined) return { found: false, option: "agent", id };
  const instances = Object.fromEntries(
    Object.entries(full.instances).filter(([, instance]) => instance.agent === id),
  );
  return {
    found: true,
    value: {
      detail: "agent",
      agent: id,
      state,
      ...(resumeHint(state, full.checkpoints, id) === undefined
        ? {}
        : { can_resume: resumeHint(state, full.checkpoints, id) as ResumeHint }),
      instances,
      open_points: full.open_points.filter((point) => point.agent === id),
    },
  };
}

function storyDetail(full: FullStateView, id: string): DetailOutcome {
  const whole = own(full.stories, id) ?? null;
  // A merge lists every file it changed (a thousand at most): the first 200 are shown.
  const files = whole?.merged?.files ?? [];
  const state =
    whole?.merged !== undefined && files.length > MERGED_FILES_SHOWN
      ? { ...whole, merged: { ...whole.merged, files: files.slice(0, MERGED_FILES_SHOWN) } }
      : whole;
  const filesTotal = files.length > MERGED_FILES_SHOWN ? files.length : undefined;
  const known =
    state !== null || Object.values(full.checkpoints).some((checkpoint) => checkpoint.story === id);
  if (!known) return { found: false, option: "story", id };
  const checkpoints = newestFirst(
    Object.values(full.checkpoints).filter((checkpoint) => checkpoint.story === id),
  );
  const open = checkpoints.filter((checkpoint) => checkpoint.status === "open");
  const settled = checkpoints.filter((checkpoint) => checkpoint.status !== "open").slice(0, 20);
  const views: Record<string, CheckpointView> = {};
  const cuts = new Cuts();
  for (const checkpoint of open) views[checkpoint.id] = checkpoint;
  for (const checkpoint of settled) {
    views[checkpoint.id] = checkpointDigest(checkpoint, cuts, STATE_LIMITS.text, false);
  }
  return {
    found: true,
    value: {
      detail: "story",
      story: id,
      state,
      ...(filesTotal === undefined ? {} : { merged_files_total: filesTotal }),
      checkpoints: views,
      checkpoints_total: checkpoints.length,
      instances: Object.fromEntries(
        Object.entries(full.instances).filter(([, instance]) => instance.story === id),
      ),
      open_points: full.open_points.filter((point) => point.story === id),
      deferred: full.deferred.open.filter((item) => item.story === id || item.locks.includes(id)),
      deviations: full.deviations.open.filter((deviation) => deviation.story === id),
    },
  };
}

function delegationsPage(
  full: FullStateView,
  filter: NonNullable<GetStateInput["delegations"]>,
): StateDetail {
  const limit = filter.limit ?? DELEGATIONS_PAGE;
  // Oldest first in the state; a page is the newest first, before an id.
  const newest = [...full.delegations].reverse();
  const index = filter.before === undefined ? -1 : newest.findIndex((e) => e.id === filter.before);
  const first = index === -1 ? 0 : index + 1;
  const wanted = newest.slice(first, first + limit);
  const page = fitPage(wanted, (kept) => ({ delegations: kept }));
  const last = page[page.length - 1];
  return {
    detail: "delegations",
    delegations: page,
    total: newest.length,
    next_before: first + page.length < newest.length && last !== undefined ? last.id : null,
  };
}

/** The part of the state an option reads in full, or why there is none. */
export function stateDetail(full: FullStateView, input: GetStateInput): DetailOutcome | undefined {
  // `full`: the complete abridged state, which `fitState` computes.
  if (input.checkpoint !== undefined) return checkpointDetail(full, input.checkpoint);
  if (input.checkpoints !== undefined) {
    return { found: true, value: checkpointsPage(full, input.checkpoints) };
  }
  if (input.agent !== undefined) return agentDetail(full, input.agent);
  if (input.story !== undefined) return storyDetail(full, input.story);
  if (input.delegations !== undefined) {
    return { found: true, value: delegationsPage(full, input.delegations) };
  }
  return undefined;
}
