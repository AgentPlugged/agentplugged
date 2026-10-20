import {
  type CheckpointRisk,
  type CheckpointType,
  compareStoryIds,
  type DocumentKind,
  type DomainId,
  type JourneyStep,
  MAX_STACK_ITEMS,
  type PhaseId,
  type RetroScope,
  StoryIdSchema,
  type ToolId,
  type ValidationMode,
} from "@agentplugged/protocol";
import { currentDeveloper } from "../agents/agent-aliases.js";
import { stackProblem } from "../chat/stack-rules.js";
import { byOpening, truncate } from "../checkpoints/checkpoint-rules.js";
import {
  type Delegation,
  deciderFor,
  delegationVerdict,
  type PointKind,
  pointKindOf,
} from "../checkpoints/point-rules.js";
import { blocksInForce, statusAt, waiverExpired } from "../checkpoints/resolution-rules.js";
import { reasonHolds } from "../checkpoints/settled-rules.js";
import { ciGreen, heldMergeCheckpoint, type StoryCiStatus, storyCiStatus } from "../ci/ci-rules.js";
import { deferredLocks } from "../deferred/deferred-rules.js";
import { KNOWLEDGE_BASE_INDEX_PATH, KNOWLEDGE_BASE_WRITER } from "../docs/knowledge-base.js";
import {
  type KnowledgePage,
  type MergedStoryRef,
  mergedStoriesOf,
  pathKey,
  staleKnowledgeSources,
  staleKnowledgeStories,
} from "../docs/knowledge-freshness.js";
import { POSITIONING_PATH } from "../docs/launch-documents.js";
import { fastTrackHold } from "../fast-track/fast-track-rules.js";
import type { GitView } from "../git/git-view.js";
import { METHOD_DIR } from "../init/layout.js";
import { isSkipped, skippedPhases } from "../journey/journey-rules.js";
import type { JourneyView } from "../journey/journey-view.js";
import {
  dueScopes,
  lessonStatuses,
  approved as memoryApproved,
  memoryOf,
  refusedRetro,
} from "../memory/memory-rules.js";
import { queueOrder } from "../merge/merge-order.js";
import { designSecurityReviewGap, SECURITY_REVIEWER } from "../phases/design-review.js";
import {
  activePhases,
  approvedAt,
  isDocumentReview,
  openDocumentReview,
  PHASE_CLOSERS,
  type PhaseProgress,
  phaseProgress,
  refusedDocumentReview,
  STORY_BUILDERS,
  type StrayPhaseEnd,
} from "../phases/phases.js";
import type { AgentState, StoryState } from "../projection/agent-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import type { HumanState } from "../projection/human-reducers.js";
import { openConflict } from "../projection/merge-order-reducers.js";
import { isMergeCheckpoint } from "../projection/merge-reducers.js";
import { sentBackPublications } from "../publications/publication-rules.js";
import {
  currentPass,
  isStoryDeveloper,
  needsSecurity,
  openMergeCheckpoint,
  passNumberFor,
  reviewOf,
  storyReviewDone,
  untriagedFindings,
} from "../review/review-rules.js";
import { SPEC_PATH } from "../spec/spec-grow.js";
import { specSecurityGate } from "../spec/spec-security.js";
import {
  currentSprint,
  latestSprint,
  type SprintState,
  sprintStatus,
  sprintStories,
  storyDoneAt,
} from "../sprints/sprint-rules.js";
import { openPause } from "../team/team-rules.js";

/**
 * Where the product stands: what blocks first (a checkpoint, a creator's key to
 * endorse, a method not synced), else the work of the current phase, drawn from the
 * journal, the documents, the stories and the active agents.
 */
export const NEXT_STEPS = [
  "validation",
  "changes_requested",
  "key_endorsement",
  "sync",
  "framing",
  "planning",
  "design",
  "breakdown",
  "build",
  "review",
  "story_blocked",
  "sprint_planning",
  "none",
  "phase_end",
  "phase_review",
  "delivery",
  "launch",
  "ux_spec",
  /** Chloé reviews the architecture before the end of the design phase. */
  "security_review",
  /** Zoé writes the first knowledge base of an existing product. */
  "knowledge_base",
  /** The knowledge base waits for the creator's review: Zoé's open `document` checkpoint. */
  "knowledge_base_review",
  /** Zoé waits for the creator's answer to a `decision` checkpoint about the base. */
  "knowledge_base_decision",
  /** Zoé updates the pages of the base behind a document the creator validated. */
  "knowledge_base_update",
  /** An open item of deferred work locks the story to start or to merge first. */
  "deferred_work",
  /** The product has no CI: Omar writes the base workflows before the first story. */
  "setup_ci",
  /** A story's CI failed: its agent fixes it on the same branch. */
  "ci_failed",
  /** A started story in review whose CI is not green and read since: read it. */
  "ci_check",
  /** Findings of a story's closed review passes wait for its developer's triage. */
  "review_triage",
  /**
   * The creator refused a story's merge or asked for changes: its developer takes the
   * creator's note up in the story's worktree.
   */
  "merge_changes",
  /**
   * The story's developer qualified a conflict with the main branch: they resolve it on
   * the story's branch (a textual conflict, or the creator's answer to one of substance).
   */
  "merge_conflict",
  /** An epic or a sprint is finished: its retrospective is due, to Izzy. */
  "retrospective",
  /** The creator approved a change of the memory; its agent records it. */
  "memory_record",
  /** The launch has no positioning yet: Julien writes it first, from the knowledge base. */
  "positioning",
  /**
   * A release the creator approved has merged stories the release notes do not cover yet: Zoé
   * writes the notes of the version and updates the user guides.
   */
  "release_notes",
  /**
   * A point the creator did not keep for themselves waits for the agent responsible for it to
   * decide it, with its reason: `decide_checkpoint`.
   */
  "point_decision",
  /**
   * The short path: the creator skipped the full path, and one spec stands for the
   * brief, the PRD and the architecture; its author writes it, then opens its `document` point.
   */
  "spec",
  /**
   * The creator paused the team: nothing starts, the agents finish the step they are on, sum up
   * and wait for the creator to resume. Replaces whatever the method would propose.
   */
  "paused",
] as const;

export type NextStepId = (typeof NEXT_STEPS)[number];

/** An open checkpoint that waits for the creator, as `next` shows it. */
export interface WaitingCheckpoint {
  readonly id: string;
  readonly title: string;
  readonly type: CheckpointType;
  readonly risk: CheckpointRisk;
}

/** Why the method needs a `sync`. */
export type SyncNeed =
  /** No manifest: `sync` never ran here. */
  | "never"
  /** No AI tool is targeted. */
  | "no_tool"
  /** A targeted tool lacks its files. */
  | "tool_missing"
  /** What `sync` generates from changed since it ran (agents, skills, customisations, settings). */
  | "stale";

/** Where the generated files of the AI tools stand (read by `next`, decided here). */
export interface SyncFreshness {
  /** The manifest of the last `sync` exists. */
  readonly manifest: boolean;
  /** Targeted tools whose files are missing, in catalog order. */
  readonly missing: readonly ToolId[];
  /** The fingerprint of the inputs the last `sync` recorded, or null (none, or an older one). */
  readonly recorded: string | null;
  /** The fingerprint of the inputs now (`syncInputsFingerprint`). */
  readonly current: string;
}

/** The product's state as `next` reads it. */
export interface NextState {
  /** What the reducers built (`ProjectionState["state"]`). */
  readonly projection: Readonly<Record<string, unknown>>;
  /** The clock (milliseconds): expiry of waivers. */
  readonly now: number;
  readonly sync: SyncFreshness;
}

/** The documents of `.agentplugged/`, as `next` reads them. */
export interface NextDocs {
  /** Kinds of the documents present (by their header, else by their file name). */
  readonly kinds: readonly DocumentKind[];
  /** Story ids (`2-3`) of the `.agentplugged/stories/*.md` files. */
  readonly stories: readonly string[];
  /**
   * The bytes of `.agentplugged/docs/architecture.md`, when it exists: a
   * review of another version is stale, and Chloé is called again.
   */
  readonly architecture?: Uint8Array;
  /**
   * The bytes of the short path's `.agentplugged/docs/spec.md`, when it exists: the
   * security review of its design must cover this very version.
   */
  readonly spec?: Uint8Array;
  /** The bytes of Chloé's review of that spec, `security-reviews/spec.md`, when it exists. */
  readonly spec_review?: Uint8Array;
  /**
   * The stories a sprint may take: `docs check` finds nothing in them and an
   * approved `document` checkpoint lists them at their current content. Absent: every story.
   */
  readonly plannable?: readonly string[];
  /**
   * The map of the knowledge base, `.agentplugged/docs/index.md`, is a non-empty file of the
   * working copy or of the main branch.
   */
  readonly knowledge_base?: boolean;
  /**
   * The pages of the knowledge base, each with the documents of the method it builds on and the
   * versions it recorded.
   */
  readonly knowledge_pages?: readonly KnowledgePage[];
  /**
   * The product has a CI (`existingCi`): false proposes `setup_ci` to Omar before the
   * first story starts; absent, nothing is proposed.
   */
  readonly ci?: boolean;
  /**
   * False when `ci setup` cannot run here (no repository, or the method below the repository's
   * top): `setup_ci` is never proposed then. Absent: it can.
   */
  readonly ci_setup?: boolean;
  /**
   * The positioning of the launch (`.agentplugged/docs/launch/positioning.md`) exists:
   * false proposes `positioning` to Julien at the start of the launch; absent, nothing is proposed.
   */
  readonly positioning?: boolean;
}

/** What `next` needs of `method.yaml` and of the installed agents. */
export interface NextConfig {
  /** Active domains (every domain without a profile). */
  readonly domains: readonly DomainId[];
  /** The phases the profile lists (every phase without a profile). */
  readonly phases: readonly PhaseId[];
  /** Targeted tools, in catalog order. */
  readonly tools: readonly ToolId[];
  /** The preferred tool of each agent (`agents.settings.<id>.tool`). */
  readonly preferred: Readonly<Record<string, ToolId>>;
  /** The active agents (installed, not inactive nor disabled), by id, with their display name. */
  readonly agents: Readonly<Record<string, string>>;
  /** The product existed before the method (`isExistingProduct`). */
  readonly existing?: boolean;
  /**
   * The active reviewers of each kind, by their domain: `quality` for `qa`, `security`
   * for `security`. Absent: the method's own (`quentin`, `chloe`) when active.
   */
  readonly reviewers?: { readonly qa: readonly string[]; readonly security: readonly string[] };
  /**
   * The points the creator keeps for themselves, as their settings give them; absent
   * while they have not chosen: every point waits for them and the agents stop at each one.
   */
  readonly delegation?: Delegation;
}

/**
 * Where a story's review stands, on a `review` or `review_triage` step: the pass,
 * each kind (`pending`: to give; `done`; `not_required`: the story does not concern security;
 * `unknown`: known once the quality review is in; `unavailable`: no active reviewer of that
 * kind), the reviewers to launch now, in parallel, and the findings left to sort.
 */
export interface NextReview {
  readonly pass: number;
  readonly qa: "pending" | "done" | "unavailable";
  readonly security: "pending" | "done" | "not_required" | "unknown" | "unavailable" | "skipped";
  readonly reviewers: readonly string[];
  readonly untriaged: number;
}

/**
 * The fast track of the step's story: `active` for a small change built without
 * framing nor design; `left` once it went back to the full lane, with who sent it back and why.
 */
export interface NextFastTrack {
  readonly status: "active" | "left";
  readonly left_by: "engine" | "agent" | null;
  readonly reasons: readonly string[];
}

/** The next step: what to do, who does it, where, and what waits for the creator. */
/**
 * Work that goes on beside the step, in the background: Zoé's update of the pages
 * behind a document or a merged story while a story is under way. It never replaces the step and
 * never holds a developer.
 */
export interface NextBackground {
  readonly step: "knowledge_base_update";
  readonly agent: string;
  readonly agent_name: string;
  readonly tool: ToolId | null;
  /** The pages behind, sorted. */
  readonly pages: readonly string[];
}

export interface NextStep {
  readonly step: NextStepId;
  /** True when the step is the creator's (« toi »). */
  readonly you: boolean;
  /** The active agent to call, or null (the creator's step, or nothing to do). */
  readonly agent: string | null;
  /** The agent's display name, or null. */
  readonly agent_name: string | null;
  /** The tool to call the agent in: its preferred tool when targeted, else the first one. */
  readonly tool: ToolId | null;
  /**
   * Pages of the knowledge base that are behind and carry no late notice, because the creator's Git
   * settings do not let the engine commit one: the agents take them as late pages.
   */
  readonly late_pages?: readonly {
    readonly path: string;
    readonly stories: readonly string[];
    readonly documents: readonly string[];
    readonly paths: readonly string[];
  }[];
  /** Zoé's update of the base beside a story under way, when pages are behind. */
  readonly background?: NextBackground;
  /**
   * Open checkpoints (a waiver past its deadline is open again): the blocking one first, then in
   * opening order.
   */
  readonly waiting: readonly WaitingCheckpoint[];
  /** The command that handles the step, or null. */
  readonly command: string | null;
  /** The story of the step, or null. */
  readonly story: string | null;
  /** The checkpoint of a `validation` or `changes_requested` step, or null. */
  readonly checkpoint: string | null;
  /** Why a `sync` step, or null. */
  readonly sync: SyncNeed | null;
  /** The tools lacking their files, for a `sync` step (else empty). */
  readonly missing_tools: readonly ToolId[];
  /** Creator's keys waiting for an endorsement (`human:…`), sorted. */
  readonly pending_keys: readonly string[];
  /** The current phase, or null (no active phase, or every phase closed for good). */
  readonly phase: PhaseId | null;
  /** Every phase of the method, in order, with its status. */
  readonly phases: PhaseProgress["phases"];
  /** The `phase_end` checkpoints left aside (another phase's, approved out of turn): warnings. */
  readonly stray: readonly StrayPhaseEnd[];
  /** The sprint in force and how many of its stories are done, or null. */
  readonly sprint: NextSprint | null;
  /**
   * The open item of deferred work that locks a story: the one a `deferred_work` step
   * treats, or the lock of a story the step went past to propose a free one; else null.
   */
  readonly deferred: NextDeferred | null;
  /**
   * The story's CI, on a `ci_failed` or `ci_check` step only: its status (`stale`: read
   * before the story's last status, `unknown`: never read), the failed checks and the pull request.
   */
  readonly ci?: NextCi;
  /** The story's review, on a `review` or `review_triage` step only. */
  readonly review?: NextReview;
  /** The story's fast track, on a step that names a story in or out of the fast track. */
  readonly fast_track?: NextFastTrack;
  /** The epic or sprint a `retrospective` step looks back on, on that step only. */
  readonly scope?: RetroScope;
  /** What a `memory_record` step carries out: `record_lessons` or `promote_lesson`. */
  readonly memory_kind?: "retrospective" | "promotion";
  /**
   * The creator's refusal of the story's merge, on a `merge_changes` step only: the
   * merge checkpoint, the decision and the creator's note.
   */
  readonly merge_feedback?: {
    readonly checkpoint: string;
    readonly decision: "rejected" | "changes_requested";
    readonly note: string | null;
  };
  /**
   * The creator's instruction for a deliverable they sent back, on a `changes_requested` step of a
   * `publication` checkpoint only: the checkpoint, its title, the creator's note, and
   * `agent_inactive` when the agent that produced it is not active (the creator's step then).
   */
  readonly publication_feedback?: {
    readonly checkpoint: string;
    readonly title: string;
    readonly agent: string | null;
    readonly note: string | null;
    readonly agent_inactive: boolean;
  };
  /**
   * The conflict with the main branch to resolve, on a `merge_conflict` step only: its
   * kind, the creator's `decision` checkpoint and answer for a conflict of substance, their note
   * when they refused every option, and the files.
   */
  readonly merge_conflict?: {
    readonly kind: "textual" | "substantive";
    readonly phase: "decided" | "refused" | "to_resolve";
    readonly checkpoint: string | null;
    readonly option: string | null;
    readonly note: string | null;
    readonly files: readonly string[];
  };
  /**
   * The merge checkpoints waiting for the creator, in the order to present them, when
   * there are at least two: the sprint's order, then their opening. The engine also reads the
   * stories' dependencies and files, and refuses a merge out of its order (`get_merge_order`).
   */
  readonly merge_queue?: readonly {
    readonly position: number;
    readonly story: string;
    readonly checkpoint: string;
  }[];
  /**
   * Where the creator answers the step's checkpoint: `chat` (in the AI tool's chat,
   * typed or dictated, or its form), `terminal` (a high risk at the `strict` level only: `review`,
   * signed by the creator's key), or null when the step answers no checkpoint. Set by
   * the `next` command.
   */
  readonly answer?: "chat" | "terminal" | null;
  /**
   * Why `answer` is `terminal`: always `strict` (a high risk at the `strict`
   * level, the only case the `strict` level is spoken of). Absent when `answer` is not `terminal`.
   */
  readonly answer_reason?: "strict";
  /**
   * The decisions waiting for the creator, in the order Noah presents them one at a time (story
   * 3.12): by risk (high first), then by the actions they block (most first), then by age
   * (oldest first). Set by the `next` command.
   */
  readonly decisions?: readonly DecisionItem[];
  /**
   * The point an agent decides, on a `point_decision` step only: its kind, and who
   * opened it.
   */
  readonly point?: { readonly kind: PointKind; readonly opened_by: string | null };
  /**
   * The step is work that does not depend on the points waiting for the creator: the
   * agents go on with it while those points wait.
   */
  readonly independent?: true;
  /**
   * Nothing independent is left: the points the creator kept wait for them, and the
   * agents stop here: they sum up the night (`morning`) and wait for the creator's answer.
   */
  readonly stop?: true;
  /**
   * On a `paused` step only: since when the creator holds the team and why (`creator`, or
   * `emergency_stop` after the bridge cut what it had started). Start nothing until they resume.
   */
  readonly paused?: { readonly since: string; readonly reason: "creator" | "emergency_stop" };
  /**
   * The single stack of everything waiting for the creator: the points to open
   * together with `open_stack`, in the order to present them, and those that keep their own
   * presentation. Set by the `next` command.
   */
  readonly pile?: Pile;
  /** What happened since the creator last answered. Set by the `next` command. */
  readonly morning?: Morning;
  /**
   * The steps of the journey the creator skipped: their choice, with who said it and
   * why, shown as skipped (never as errors) and not proposed again; they may take them up again.
   * Set by the `next` command.
   */
  readonly journey?: JourneyView;
  /**
   * The creator's Git workflow: what they chose or the recommendation, and with a
   * staging branch what waits there and whether to put it into production. Set by the `next`
   * command.
   */
  readonly git?: GitView;
}

/**
 * The single stack of the points waiting for the creator: `stack` the points to
 * present together (`open_stack`, at most 16), `apart` those that keep their own presentation (an
 * action of the creator's, a memory change, a decision without a recommendation, a conflict…), and
 * `more` how many points did not fit in the stack (a second stack follows the creator's answer).
 */
export interface Pile {
  readonly stack: readonly string[];
  readonly apart: readonly string[];
  readonly more: number;
}

/** A story done while the creator was away, as the morning summary lists it. */
export interface MorningDone {
  readonly story: string;
  readonly at: string;
  /** `creator` (their answer), `agent` (decided), `forge` (merged by hand there). */
  readonly by: "creator" | "agent" | "forge";
}

/** A point an agent decided, as the morning summary lists it: with its reason. */
export interface MorningDecided {
  readonly checkpoint: string;
  readonly title: string;
  readonly kind: PointKind | null;
  /** The agent that decided it. */
  readonly by: string | null;
  readonly decision: string;
  readonly option: string | null;
  readonly reason: string;
  readonly at: string;
}

/** A point the engine closed alone because its object was settled, with the reason. */
export interface MorningClosed {
  readonly checkpoint: string;
  readonly title: string;
  readonly reason: string;
  readonly at: string;
}

/** A point an agent handed back to the creator, with its reason: it waits for them. */
export interface MorningEscalated {
  readonly checkpoint: string;
  readonly title: string;
  readonly by: string | null;
  readonly reason: string;
  readonly at: string;
}

/**
 * What happened since the creator last answered a point: what was done, what the
 * agents decided alone (each with its reason, reopenable), what the engine closed alone, and what
 * waits for them. Every list is cut to `MORNING_LIMIT` entries, newest first; `*_total` counts all.
 */
export interface Morning {
  /** The creator's last answer (their gesture), or null when they never answered one. */
  readonly since: string | null;
  readonly done: readonly MorningDone[];
  readonly done_total: number;
  readonly decided: readonly MorningDecided[];
  readonly decided_total: number;
  readonly closed: readonly MorningClosed[];
  readonly closed_total: number;
  /** The points an agent handed back to the creator, with the reason: they answer them. */
  readonly escalated: readonly MorningEscalated[];
  /** The points waiting for the creator: the ids, in the order of `decisions`. */
  readonly waiting: readonly string[];
}

/** One decision waiting for the creator, as Noah presents it. */
export interface DecisionItem {
  readonly id: string;
  readonly title: string;
  readonly type: CheckpointType;
  readonly risk: CheckpointRisk;
  /** How many actions it blocks. */
  readonly blocks: number;
  readonly opened_at: string;
  /** The option the agent that opened it recommends, or null. */
  readonly recommendation: string | null;
  /**
   * Where the creator answers it: `chat`, or `terminal` (`review`) for a high risk at
   * the `strict` level only.
   */
  readonly answer: "chat" | "terminal";
  /** The kind of point: what the creator chose to keep, or null for an escalation. */
  readonly kind: PointKind | null;
  /** The story it concerns (a merge, a review…), or null. */
  readonly story: string | null;
  /** What it asks, in a line: its summary cut short, for the line of the stack. */
  readonly line: string;
  /** What approving it does when it has an outside effect: a merge, a release, a publication. */
  readonly action: "merge" | "release" | "publication" | null;
}

const RISK_ORDER: Readonly<Record<CheckpointRisk, number>> = { high: 0, medium: 1, low: 2 };

/**
 * The open checkpoints that wait for the creator, in the order of priority: risk,
 * then what they block, then age. A story's merge checkpoint held for its CI and review (story
 * 4.5) is not the creator's to answer yet, and is left out. Pure: the caller gives the clock.
 */
export function decisionQueue(
  projection: Readonly<Record<string, unknown>>,
  now: number,
  mode: ValidationMode = "chat",
  /** What the creator keeps: the points the agents decide are not theirs to answer. */
  delegation?: Delegation,
): DecisionItem[] {
  // A waiver past its deadline is open again, for the merge gate too.
  const open = (checkpoint: CheckpointState) => ({
    ...checkpoint,
    status: statusAt(checkpoint, now),
  });
  return Object.values(recordOf<CheckpointState>(projection, "checkpoints"))
    .filter(
      (checkpoint) =>
        statusAt(checkpoint, now) === "open" &&
        !heldMergeCheckpoint(projection, open(checkpoint)) &&
        !delegationVerdict(checkpoint, delegation).delegated &&
        // A point about a step the creator skipped is no one's to answer.
        !reasonHolds(projection, checkpoint, "step_skipped"),
    )
    .sort(
      (a, b) =>
        RISK_ORDER[a.risk] - RISK_ORDER[b.risk] ||
        b.blocks.length - a.blocks.length ||
        byOpening(a, b),
    )
    .map((checkpoint) => ({
      id: checkpoint.id,
      title: checkpoint.title,
      type: checkpoint.type,
      risk: checkpoint.risk,
      blocks: checkpoint.blocks.length,
      opened_at: checkpoint.opened_at,
      recommendation: checkpoint.recommendation,
      answer:
        mode === "strict" && checkpoint.risk === "high" ? ("terminal" as const) : ("chat" as const),
      kind: pointKindOf(checkpoint) ?? null,
      story: checkpoint.story,
      line: truncate(checkpoint.summary.replace(/\s+/g, " "), 160),
      action: outsideAction(checkpoint),
    }));
}

/** What approving a point does outside the journal, when it does something. */
function outsideAction(checkpoint: CheckpointState): DecisionItem["action"] {
  if (isMergeCheckpoint(checkpoint)) return "merge";
  if (checkpoint.type === "release") return "release";
  if (checkpoint.type === "publication") return "publication";
  return null;
}

/**
 * The single stack of everything waiting for the creator, from `decisionQueue`: the
 * points a stack may hold, in the order to present them, up to its limit; the others keep their own
 * presentation. Pure.
 */
export function pileOf(
  projection: Readonly<Record<string, unknown>>,
  now: number,
  mode: ValidationMode,
  queue: readonly DecisionItem[],
): Pile {
  const checkpoints = recordOf<CheckpointState>(projection, "checkpoints");
  const stackable: string[] = [];
  const apart: string[] = [];
  for (const item of queue) {
    const checkpoint = own(checkpoints, item.id);
    if (
      checkpoint !== undefined &&
      stackProblem(checkpoint, projection, now, mode === "strict") === undefined
    ) {
      stackable.push(item.id);
    } else {
      apart.push(item.id);
    }
  }
  return {
    stack: stackable.slice(0, MAX_STACK_ITEMS),
    apart,
    more: Math.max(0, stackable.length - MAX_STACK_ITEMS),
  };
}

/**
 * Where the creator answers the checkpoint of a step that asks them to (`review <G-id>`), at the
 * validation level `mode`: the chat, but the terminal for a high risk at `strict`.
 */
export function answerChannel(
  step: Pick<NextStep, "you" | "checkpoint" | "command">,
  checkpoints: Readonly<Record<string, CheckpointState>>,
  mode: ValidationMode,
): "chat" | "terminal" | null {
  if (!step.you || step.checkpoint === null || step.command === null) return null;
  if (!step.command.startsWith(`${COMMAND} review `)) return null;
  const checkpoint = own(checkpoints, step.checkpoint);
  if (checkpoint === undefined) return null;
  // The chat answers every point; the terminal only for a
  // high risk at the `strict` level.
  return mode === "strict" && checkpoint.risk === "high" ? "terminal" : "chat";
}

/**
 * Why a step's checkpoint is answered at the terminal: `strict` (the level is `strict` and the risk
 * high: the level is then true to say); undefined when the chat answers it.
 */
export function answerReason(
  step: Pick<NextStep, "you" | "checkpoint" | "command">,
  checkpoints: Readonly<Record<string, CheckpointState>>,
  mode: ValidationMode,
): "strict" | undefined {
  return answerChannel(step, checkpoints, mode) === "terminal" ? "strict" : undefined;
}

/** A story's CI, as `next` shows it. */
export interface NextCi {
  readonly status: StoryCiStatus;
  readonly failed: readonly string[];
  readonly pr: number | null;
  readonly url: string | null;
  /**
   * Why the CI cannot be read here, on a `ci_check` step: `no_ci` (the product has none, and Omar
   * cannot set it up: inactive, the `delivery` domain off, or the method below the repository's
   * top), else null.
   */
  readonly cause: "no_ci" | null;
  /**
   * The way out when the CI cannot be read (`ci_check` only): the creator accepts the story
   * without it, by an answer in the chat (`request_creator_action`, `ci_waive`), for the branch's
   * current commit; else false.
   */
  readonly waive: boolean;
}

/** A story locked by an open item of deferred work, as `next` shows it. */
export interface NextDeferred {
  /** The first open item that locks it (`D-…`). */
  readonly item: string;
  readonly title: string;
  readonly story: string;
  /** The command that lists the items locking it. */
  readonly command: string;
}

/** The sprint in force, as `next` shows it. */
export interface NextSprint {
  readonly id: string;
  readonly goal: string;
  /** Its stories done. */
  readonly done: number;
  /** Its stories. */
  readonly total: number;
}

const COMMAND = "npx agentplugged";

function recordOf<T>(state: Readonly<Record<string, unknown>>, key: string): Record<string, T> {
  const value = state[key];
  return typeof value === "object" && value !== null ? (value as Record<string, T>) : {};
}

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Story ids in reading order: `2-10` after `2-9`. */
export const byStoryId = compareStoryIds;

/** Why `sync` is needed, or undefined when the generated files are up to date. */
export function syncNeed(sync: SyncFreshness, tools: readonly ToolId[]): SyncNeed | undefined {
  if (tools.length === 0) return "no_tool";
  if (!sync.manifest) return "never";
  if (sync.missing.length > 0) return "tool_missing";
  if (sync.recorded !== sync.current) return "stale";
  return undefined;
}

/** `history --story <id>`, or `history` without a story: what the creator decided. */
function historyCommand(story: string | null): string {
  return story === null ? `${COMMAND} history` : `${COMMAND} history --story ${story}`;
}

/** True when `at` (an ISO date) is at or after `since` (null: the beginning). */
function atOrAfter(at: string, since: string | null): boolean {
  return since === null || Date.parse(at) >= Date.parse(since);
}

/** True when a story not done yet is in progress, in review or blocked. */
function storiesUnderWay(
  checkpoints: readonly CheckpointState[],
  stories: Readonly<Record<string, StoryState>>,
): boolean {
  return Object.keys(stories).some((id) => {
    const story = own(stories, id);
    return (
      (story?.status === "in_progress" ||
        story?.status === "in_review" ||
        story?.status === "blocked") &&
      storyDoneAt(checkpoints, id, story) === undefined
    );
  });
}

/**
 * True when a checkpoint of `type` was approved at or after `since`: a lifting decision other
 * than a waiver, still standing at `now` (`approvedAt`).
 */
function approvedSince(
  checkpoints: readonly CheckpointState[],
  type: CheckpointType,
  since: string | null,
  now: number,
): boolean {
  return checkpoints.some(
    (checkpoint) =>
      checkpoint.type === type &&
      approvedAt(checkpoint, now) &&
      checkpoint.resolution !== null &&
      atOrAfter(checkpoint.resolution.at, since),
  );
}

const RELEASE_NOTES_FOLDER = `${METHOD_DIR}/docs/release-notes/`;

/**
 * True when a release the creator approved has merged stories (merged before it) that no page of
 * the release notes took in: the notes' `last_story` is the newest story they cover.
 */
function releaseNotesDue(
  checkpoints: readonly CheckpointState[],
  pages: readonly KnowledgePage[],
  merges: readonly MergedStoryRef[],
  now: number,
): boolean {
  const released = checkpoints
    .filter(
      (checkpoint) =>
        checkpoint.type === "release" && approvedAt(checkpoint, now) && checkpoint.resolution,
    )
    .map((checkpoint) => Date.parse(checkpoint.resolution?.at ?? ""))
    .filter((at) => Number.isFinite(at));
  if (released.length === 0) return false;
  const releasedAt = Math.max(...released);
  const covered = merges
    .filter((merge) => merge.at !== undefined && Date.parse(merge.at) <= releasedAt)
    .map((merge) => merge.seq);
  if (covered.length === 0) return false;
  const rank = new Map(merges.map((merge) => [merge.story, merge.seq]));
  const notes = pages
    .filter((page) => pathKey(page.path).startsWith(RELEASE_NOTES_FOLDER))
    .map((page) => (page.last_story === undefined ? 0 : (rank.get(page.last_story) ?? 0)));
  return Math.max(0, ...notes) < Math.max(...covered);
}

/** The step the creator skips to skip a structuring document. */
const DOCUMENT_STEPS: Partial<Record<DocumentKind, JourneyStep>> = {
  brief: "brief",
  prfaq: "brief",
  prd: "prd",
  ux: "ux",
  architecture: "architecture",
};

/** The documents each document phase delivers: domain, kind, step and agent. */
const PHASE_DOCUMENTS: Partial<
  Record<PhaseId, ReadonlyArray<readonly [DomainId, DocumentKind, NextStepId, string]>>
> = {
  framing: [["product", "brief", "framing", "iris"]],
  planning: [
    ["product", "prd", "planning", "maya"],
    ["ux", "ux", "ux_spec", "stella"],
  ],
  design: [["architecture", "architecture", "design", "alex"]],
};

/**
 * The next step of the product, by the first rule that applies:
 * 1. a checkpoint whose blocks apply: open (`review <G-id>`), its waiver past (`review`), or
 *    refused and not superseded yet (`changes_requested`, to its agent);
 * 2. a creator's key waiting for an endorsement: `key endorse`;
 * 3. the method not synced (no tool, a targeted tool without its files, or inputs changed since
 *    the last `sync`): `sync`;
 * 4. the end of the current phase open: `phase_review` (`review <G-id>`);
 * 4b. the `docs` domain on and Zoé active, unless the current phase's end was refused, a story
 *    is under way (in progress, in review, blocked) or the phase is the delivery:
 *    Zoé's review of the base open (a `document` checkpoint citing the map or a
 *    page), `knowledge_base_review` (`review <G-id>`); her last review refused and not
 *    superseded, `changes_requested`, to Zoé; an open `decision` of Zoé,
 *    `knowledge_base_decision` (`review <G-id>`); on a product that existed before the method,
 *    without the map, `knowledge_base`, to Zoé;
 * 4c. then a page of the base behind a document the creator validated, that this branch holds
 *: `knowledge_base_update`, to Zoé;
 * 5. the work of the current phase: its first missing document (framing, planning, design) and,
 *    in design, Chloé's security review while she is active (`security_review`), its
 *    stories (build: breakdown, in progress, in review, blocked, then the sprints:
 *    a proposal waiting for the creator, the next story of the sprint in force to its owner, a
 *    refused proposal back to its planner, sprint planning; a story to start or in review that
 *    an open item of deferred work locks gives `deferred_work` first), a release
 *    (delivery) or a publication (launch; first, while the positioning is missing and Julien is
 *    active, `positioning`);
 * 6. the current phase ready, its end refused and none opened since: `changes_requested`, to the
 *    agent that opened it (else the creator);
 * 7. the current phase ready: `phase_end`, to the agent that opens its end (else the creator);
 * 8. else nothing to do.
 * Without a current phase, the stories alone are looked at. Only active agents are proposed.
 * Every step carries the `phase_end` checkpoints left aside (`stray`). Pure: the caller reads the
 * journal, the files and the clock.
 */
function computeStep(
  state: NextState,
  docs: NextDocs,
  config: NextConfig,
  /**
   * The points waiting for the creator that the work looked for must not depend on:
   * left out as if they were not open, and so are the stories they concern.
   */
  alsoParked: ReadonlySet<string> = new Set(),
): NextStep {
  const checkpoints = Object.values(recordOf<CheckpointState>(state.projection, "checkpoints"));
  // What the creator skipped is never proposed; a step skipped for a story is looked up
  // by that story. The points about a skipped step are no one's to answer: left out like a parked one.
  const skip = (step: JourneyStep, story?: string | null) =>
    isSkipped(state.projection, step, story);
  const aboutSkipped = new Set(
    checkpoints
      .filter(
        (checkpoint) =>
          statusAt(checkpoint, state.now) === "open" &&
          reasonHolds(state.projection, checkpoint, "step_skipped"),
      )
      .map((checkpoint) => checkpoint.id),
  );
  const parked = new Set([...alsoParked, ...aboutSkipped]);
  const parkedStories = new Set(
    checkpoints
      .filter((checkpoint) => parked.has(checkpoint.id))
      .flatMap((checkpoint) => [
        checkpoint.story,
        ...checkpoint.blocks.map((block) => block.story ?? checkpoint.story),
      ])
      .filter((story): story is string => story !== null && story !== undefined),
  );
  // A story's merge checkpoint waits for a green CI and a done review: never shown.
  // A story's merge checkpoint waits for a green CI and a done review: never asked of
  // the creator; one that blocks stays in `waiting`, so nothing is held silently.
  const held = (checkpoint: CheckpointState) => heldMergeCheckpoint(state.projection, checkpoint);
  const ordered = checkpoints
    .filter(
      (checkpoint) =>
        (!held(checkpoint) || checkpoint.blocks.length > 0) && !parked.has(checkpoint.id),
    )
    .sort(byOpening);
  // The merge checkpoints are presented in the order of the merges, in the places the
  // merge checkpoints take in the opening order.
  const sprintsEarly = recordOf<SprintState>(state.projection, "sprints");
  const sprintEarly = currentSprint(
    sprintsEarly,
    recordOf<CheckpointState>(state.projection, "checkpoints"),
    state.now,
  );
  const mergeSlots = ordered.flatMap((checkpoint, index) =>
    isMergeCheckpoint(checkpoint) && statusAt(checkpoint, state.now) === "open" ? [index] : [],
  );
  const mergeQueued = queueOrder(
    mergeSlots.map((index) => ordered[index] as CheckpointState),
    sprintEarly?.stories.map((entry) => entry.id) ?? [],
  );
  mergeSlots.forEach((slot, index) => {
    ordered[slot] = mergeQueued[index] as CheckpointState;
  });
  const open = ordered.filter((checkpoint) => statusAt(checkpoint, state.now) === "open");
  const waitingOf = (list: readonly CheckpointState[]): WaitingCheckpoint[] =>
    list.map((checkpoint) => ({
      id: checkpoint.id,
      title: checkpoint.title,
      type: checkpoint.type,
      risk: checkpoint.risk,
    }));
  const pending = Object.values(recordOf<HumanState>(state.projection, "humans"))
    .filter((human) => human.trust === "pending")
    .map((human) => human.device)
    .sort();
  // The short path's spec, validated by a `document` point the creator approved.
  const specApproved = checkpoints.some(
    (checkpoint) =>
      isDocumentReview(checkpoint) &&
      approvedAt(checkpoint, state.now) &&
      checkpoint.documents.some((cited) => pathKey(cited.path) === SPEC_PATH),
  );
  const progress = phaseProgress(
    checkpoints.filter((checkpoint) => !aboutSkipped.has(checkpoint.id)),
    activePhases(
      { domains: config.domains, phases: config.phases },
      skippedPhases(state.projection),
    ),
    state.now,
  );
  // The sprints: the one in force, and the one proposed last.
  const sprints = recordOf<SprintState>(state.projection, "sprints");
  const checkpointsById = recordOf<CheckpointState>(state.projection, "checkpoints");
  const sprint = currentSprint(sprints, checkpointsById, state.now);
  const sprintProgress =
    sprint === undefined
      ? undefined
      : sprintStories(sprint, recordOf<StoryState>(state.projection, "stories"), checkpoints);
  const base = {
    you: false,
    agent: null,
    agent_name: null,
    tool: null,
    waiting: waitingOf(open),
    command: null,
    story: null,
    checkpoint: null,
    sync: null,
    missing_tools: [],
    pending_keys: pending,
    phase: progress.current,
    phases: progress.phases,
    stray: progress.stray,
    sprint:
      sprint === undefined || sprintProgress === undefined
        ? null
        : {
            id: sprint.id,
            goal: sprint.goal,
            done: sprintProgress.filter((story) => story.status === "done").length,
            total: sprintProgress.length,
          },
    deferred: null,
    ...(mergeQueued.length >= 2
      ? {
          merge_queue: mergeQueued.map((checkpoint, index) => ({
            position: index + 1,
            story: checkpoint.story ?? "",
            checkpoint: checkpoint.id,
          })),
        }
      : {}),
  } satisfies Partial<NextStep>;
  const active = (agent: string | null | undefined): agent is string =>
    typeof agent === "string" && own(config.agents, agent) !== undefined;
  const call = (step: NextStepId, agent: string, story: string | null = null): NextStep => {
    const preferred = own(config.preferred, agent);
    return {
      ...base,
      step,
      agent,
      agent_name: own(config.agents, agent) ?? agent,
      tool:
        preferred !== undefined && config.tools.includes(preferred)
          ? preferred
          : (config.tools[0] ?? null),
      story,
    };
  };
  const yours = (step: NextStepId, extra: Partial<NextStep> = {}): NextStep => ({
    ...base,
    step,
    you: true,
    ...extra,
  });
  /** The first active agent of `agents`, called for `step`; else the creator's step. */
  const firstOf = (
    step: NextStepId,
    agents: readonly string[],
    story: string | null = null,
  ): NextStep => {
    const agent = agents.find((candidate) => active(candidate));
    return agent === undefined ? yours(step, { story }) : call(step, agent, story);
  };

  // 0. A point the creator did not keep for themselves: the agent responsible for it
  // decides it, with its reason, before anything else: it is quick, and the work waits on it.
  const activeIds = Object.keys(config.agents);
  for (const checkpoint of ordered) {
    if (statusAt(checkpoint, state.now) !== "open" || held(checkpoint)) continue;
    const verdict = delegationVerdict(checkpoint, config.delegation);
    if (!verdict.delegated) continue;
    const decider = deciderFor(verdict.kind, checkpoint.opened_by, activeIds);
    if (decider === null) continue;
    return {
      ...call("point_decision", decider, checkpoint.story),
      checkpoint: checkpoint.id,
      point: { kind: verdict.kind, opened_by: checkpoint.opened_by },
    };
  }

  // 1. What blocks the agents: always first.
  // An installation the creator validates waits on its open checkpoint, blocks or not
  //, and so does an action the creator asked for in the chat.
  const blocking = ordered.find(
    (checkpoint) =>
      !held(checkpoint) &&
      (checkpoint.blocks.length > 0
        ? statusAt(checkpoint, state.now) === "open" || blocksInForce(checkpoint, state.now)
        : (checkpoint.source === "untrusted_action" ||
            (checkpoint.creator_action ?? null) !== null ||
            (checkpoint.memory ?? null) !== null) &&
          statusAt(checkpoint, state.now) === "open"),
  );
  if (blocking !== undefined) {
    if (statusAt(blocking, state.now) === "open" || waiverExpired(blocking, state.now)) {
      // The checkpoint the command opens is the first one cited.
      const rest = open.filter((checkpoint) => checkpoint.id !== blocking.id);
      return yours("validation", {
        waiting: waitingOf([blocking, ...rest]),
        command: `${COMMAND} review ${blocking.id}`,
        checkpoint: blocking.id,
        story: blocking.story,
      });
    }
    // Refused: its agent addresses the changes, then opens a checkpoint that supersedes it.
    const step = active(blocking.opened_by)
      ? call("changes_requested", blocking.opened_by, blocking.story)
      : yours("changes_requested", { story: blocking.story });
    return { ...step, checkpoint: blocking.id, command: historyCommand(blocking.story) };
  }

  // 2. A creator's key waiting for an endorsement.
  if (pending.length > 0) return yours("key_endorsement", { command: `${COMMAND} key endorse` });

  // 3. The method not synced.
  const need = syncNeed(state.sync, config.tools);
  if (need !== undefined) {
    return yours("sync", {
      command: need === "no_tool" ? null : `${COMMAND} sync`,
      sync: need,
      missing_tools: need === "tool_missing" ? [...state.sync.missing] : [],
    });
  }

  // 4. The end of the current phase waits for the creator.
  const end = progress.open;
  if (end !== null) {
    const rest = open.filter((checkpoint) => checkpoint.id !== end.id);
    return yours("phase_review", {
      waiting: waitingOf([end, ...rest]),
      command: `${COMMAND} review ${end.id}`,
      checkpoint: end.id,
    });
  }

  const { current, since, refused } = progress;

  // 4a. A structuring document waits for the creator: its point first, before the
  // end of the phase that cites it.
  const waitingDocument = openDocumentReview(
    checkpoints.filter((checkpoint) => !parked.has(checkpoint.id)),
    since,
    state.now,
  );
  if (waitingDocument !== undefined) {
    const rest = open.filter((checkpoint) => checkpoint.id !== waitingDocument.id);
    return yours("validation", {
      waiting: waitingOf([waitingDocument, ...rest]),
      command: `${COMMAND} review ${waitingDocument.id}`,
      checkpoint: waitingDocument.id,
    });
  }

  // 4a'. A deliverable waits for the creator: validate, refuse or send it back.
  const waitingPublication = open.find((checkpoint) => checkpoint.type === "publication");
  if (waitingPublication !== undefined) {
    const rest = open.filter((checkpoint) => checkpoint.id !== waitingPublication.id);
    return yours("validation", {
      waiting: waitingOf([waitingPublication, ...rest]),
      command: `${COMMAND} review ${waitingPublication.id}`,
      checkpoint: waitingPublication.id,
    });
  }

  // 4b. The knowledge base before new work, so the agents learn the product from it; never
  // before a refused end, a story under way or the delivery.
  const baseWork =
    config.domains.includes("docs") &&
    active(KNOWLEDGE_BASE_WRITER) &&
    !skip("knowledge_base") &&
    refused === null &&
    current !== "delivery" &&
    !storiesUnderWay(checkpoints, recordOf<StoryState>(state.projection, "stories"));
  if (baseWork) {
    const waitingFor = (step: NextStepId, checkpoint: CheckpointState): NextStep => {
      const rest = open.filter((other) => other.id !== checkpoint.id);
      return yours(step, {
        waiting: waitingOf([checkpoint, ...rest]),
        command: `${COMMAND} review ${checkpoint.id}`,
        checkpoint: checkpoint.id,
      });
    };
    // Zoé's reviews of the base: `document` checkpoints citing the map or a page.
    const pages = new Set([
      pathKey(KNOWLEDGE_BASE_INDEX_PATH),
      ...(docs.knowledge_pages ?? []).map((page) => pathKey(page.path)),
    ]);
    const reviews = ordered.filter(
      (checkpoint) =>
        checkpoint.opened_by === KNOWLEDGE_BASE_WRITER &&
        checkpoint.type === "document" &&
        (checkpoint.documents ?? []).some((cited) => pages.has(pathKey(cited.path))),
    );
    const review = reviews.find((checkpoint) => statusAt(checkpoint, state.now) === "open");
    if (review !== undefined) return waitingFor("knowledge_base_review", review);
    // The last review refused, and none opened since to supersede it: back to Zoé.
    const last = reviews.at(-1);
    const decision = last?.resolution?.decision;
    if (
      last !== undefined &&
      (decision === "rejected" || decision === "changes_requested") &&
      !checkpoints.some((checkpoint) => checkpoint.supersedes === last.id)
    ) {
      return {
        ...call("changes_requested", KNOWLEDGE_BASE_WRITER),
        checkpoint: last.id,
        command: historyCommand(null),
      };
    }
    const question = open.find(
      (checkpoint) =>
        checkpoint.opened_by === KNOWLEDGE_BASE_WRITER && checkpoint.type === "decision",
    );
    if (question !== undefined) return waitingFor("knowledge_base_decision", question);
    // An existing product without its map: Zoé generates the base.
    if (config.existing === true && docs.knowledge_base !== true) {
      return call("knowledge_base", KNOWLEDGE_BASE_WRITER);
    }
    // A new product gets its base (the map, the vision, the conventions) as soon as
    // the architecture is validated and before the first story: short, no question asked.
    if (
      config.existing !== true &&
      docs.knowledge_base === false &&
      (docs.kinds.includes("architecture") || specApproved) &&
      (current === "build" || current === null)
    ) {
      return call("knowledge_base", KNOWLEDGE_BASE_WRITER);
    }
    // 4c. A page behind a document the creator validated: Zoé updates those pages
    // first, so the agents never take their context from a version the creator replaced.
    if (staleKnowledgeSources(docs.knowledge_pages ?? [], checkpoints, state.now).length > 0) {
      return call("knowledge_base_update", KNOWLEDGE_BASE_WRITER);
    }
    // A page behind a merged story that changed the code it describes.
    const merges = mergedStoriesOf(state.projection);
    if (staleKnowledgeStories(docs.knowledge_pages ?? [], merges).length > 0) {
      return call("knowledge_base_update", KNOWLEDGE_BASE_WRITER);
    }
  }

  // 4c'. A released version whose notes are not written: Zoé writes the notes and
  // brings the user guides up to date, in any phase, never over a story under way.
  if (
    config.domains.includes("docs") &&
    active(KNOWLEDGE_BASE_WRITER) &&
    !skip("knowledge_base") &&
    docs.knowledge_base !== false &&
    refused === null &&
    !open.some((checkpoint) => checkpoint.opened_by === KNOWLEDGE_BASE_WRITER) &&
    !storiesUnderWay(checkpoints, recordOf<StoryState>(state.projection, "stories")) &&
    releaseNotesDue(
      checkpoints,
      docs.knowledge_pages ?? [],
      mergedStoriesOf(state.projection),
      state.now,
    )
  ) {
    return call("release_notes", KNOWLEDGE_BASE_WRITER);
  }

  // 4d. A structuring document the creator refused, and no new point supersedes it:
  // back to its author, who reads the note, corrects the document and reopens it.
  const refusedDocument = refusedDocumentReview(checkpoints, since, state.now);
  if (refusedDocument !== undefined) {
    const step = active(refusedDocument.opened_by)
      ? call("changes_requested", refusedDocument.opened_by)
      : yours("changes_requested");
    return { ...step, checkpoint: refusedDocument.id, command: historyCommand(null) };
  }

  // 4d'. A deliverable the creator sent back with an instruction, and no new point
  // supersedes it: back to the agent that produced it, with the instruction. A refusal
  // (`rejected`) sends nothing back.
  const sentBackPublication = sentBackPublications(checkpoints, since)[0];
  if (sentBackPublication !== undefined) {
    const agent = sentBackPublication.opened_by;
    const inactive = !active(agent);
    const step = active(agent) ? call("changes_requested", agent) : yours("changes_requested");
    return {
      ...step,
      checkpoint: sentBackPublication.id,
      command:
        inactive && agent !== null ? `${COMMAND} agent enable ${agent}` : historyCommand(null),
      publication_feedback: {
        checkpoint: sentBackPublication.id,
        title: sentBackPublication.title,
        agent: agent,
        note: sentBackPublication.resolution?.note ?? null,
        agent_inactive: inactive,
      },
    };
  }

  // 4e. The memory: a change the creator approved is recorded by its agent, and a
  // retrospective sent back for changes returns to the agent that proposed it.
  const lessonsNow = lessonStatuses(state.projection, checkpointsById, state.now);
  const toRecord = ordered.find((checkpoint) => {
    const memory = memoryOf(checkpoint);
    if (
      memory === undefined ||
      (checkpoint.memory_done ?? null) !== null ||
      !memoryApproved(checkpoint, state.now)
    ) {
      return false;
    }
    // A promotion of a lesson retired since can never be carried out: it stops nothing.
    return memory.kind !== "promotion" || lessonsNow.get(memory.lesson) === "active";
  });
  if (toRecord !== undefined) {
    // Its author, else Izzy, else the creator: someone who can call the tool that carries it out.
    const step = firstOf("memory_record", [toRecord.opened_by ?? "", "izzy"]);
    return {
      ...step,
      checkpoint: toRecord.id,
      memory_kind: memoryOf(toRecord)?.kind ?? "retrospective",
    };
  }
  const refusedRetrospective = ordered
    .map((checkpoint) => memoryOf(checkpoint))
    .flatMap((memory) => (memory?.kind === "retrospective" ? [memory.scope] : []))
    .map((scope) => refusedRetro(checkpoints, scope, state.now))
    .find((checkpoint) => checkpoint !== undefined);
  if (refusedRetrospective !== undefined) {
    const step = active(refusedRetrospective.opened_by)
      ? call("changes_requested", refusedRetrospective.opened_by)
      : yours("changes_requested");
    return { ...step, checkpoint: refusedRetrospective.id, command: historyCommand(null) };
  }

  /**
   * 6. and 7. The current phase is ready: a refused end goes back to its agent (who addresses the
   * changes, then opens another), else the agent that closes the phase opens its end.
   */
  const ready = (): NextStep => {
    if (refused !== null) {
      const step = active(refused.opened_by)
        ? call("changes_requested", refused.opened_by)
        : yours("changes_requested");
      return { ...step, checkpoint: refused.id, command: historyCommand(null) };
    }
    return firstOf("phase_end", current === null ? [] : PHASE_CLOSERS[current]);
  };

  // 5. The work of the current phase, then its end.
  const domain = (id: DomainId) => config.domains.includes(id);
  const has = (kind: DocumentKind) => docs.kinds.includes(kind);
  /** A structuring document the creator skipped: not asked for, not waited for. */
  const skippedDocument = (kind: DocumentKind) => {
    const step = DOCUMENT_STEPS[kind];
    return step !== undefined && skip(step);
  };
  // The creator skipped the full path, so the framing, planning and
  // design phases are skipped and one spec stands for them. Its author writes it and opens its
  // point; nothing is built (no breakdown, no story) before the creator approved it.
  if (skip("full_path") && (!has("spec") || !specApproved)) {
    return firstOf("spec", ["maya"]);
  }
  // The short path has no architecture, so Chloé reviews the design part of the
  // spec (the same skill, the same result line) once it is validated, before any story is cut or
  // while none is under way; a spec changed since her review is reviewed again, blocking findings
  // wait for the creator's answer. Never skipped: the review may be short, it is always there.
  if (
    skip("full_path") &&
    docs.spec !== undefined &&
    !storiesUnderWay(checkpoints, recordOf<StoryState>(state.projection, "stories"))
  ) {
    const gate = specSecurityGate({
      active: Object.keys(config.agents).filter((agent) => active(agent)),
      agents: recordOf<AgentState>(state.projection, "agents"),
      spec: docs.spec,
      review: docs.spec_review ?? null,
      checkpoints: ordered,
      now: state.now,
    });
    if (gate?.kind === "invalid_date") return yours("security_review");
    if (gate?.kind === "call") return call("security_review", SECURITY_REVIEWER);
    if (gate?.kind === "wait") {
      const rest = open.filter((checkpoint) => checkpoint.id !== gate.checkpoint.id);
      return yours("validation", {
        waiting: waitingOf([gate.checkpoint, ...rest]),
        command: `${COMMAND} review ${gate.checkpoint.id}`,
        checkpoint: gate.checkpoint.id,
      });
    }
  }
  if (current !== null && current !== "build") {
    const deliverables = PHASE_DOCUMENTS[current];
    if (deliverables !== undefined) {
      // The design: the architecture first, by Alex, else by the creator.
      if (
        current === "design" &&
        domain("architecture") &&
        !has("architecture") &&
        !skip("architecture")
      ) {
        return firstOf("design", ["alex"]);
      }
      for (const [id, kind, step, agent] of deliverables) {
        if (domain(id) && !has(kind) && active(agent) && !skippedDocument(kind)) {
          return call(step, agent);
        }
      }
      // The architecture written, Chloé reviews it before its end is opened.
      const review =
        current === "design" && !skip("architecture_security") && !skip("architecture")
          ? designSecurityReviewGap({
              active: Object.keys(config.agents).filter((agent) => active(agent)),
              agents: recordOf<AgentState>(state.projection, "agents"),
              since,
              ...(docs.architecture === undefined ? {} : { architecture: docs.architecture }),
            })
          : undefined;
      if (review === "invalid_date") return yours("security_review");
      if (review !== undefined) return call("security_review", SECURITY_REVIEWER);
      return ready();
    }
    if (current === "delivery") {
      return approvedSince(checkpoints, "release", since, state.now)
        ? ready()
        : firstOf("delivery", ["omar"]);
    }
    // Launch: a publication the creator approved during the phase.
    if (approvedSince(checkpoints, "publication", since, state.now)) return ready();
    // No positioning yet, and Julien is there: it comes first, the pages build on it.
    // It is drawn from the knowledge base: without one, Zoé writes it first when she can; else
    // Julien is called as usual and tells the creator what is missing. A positioning already
    // submitted (a `publication` citing it, on a branch this copy does not hold) is not asked again.
    const submitted = checkpoints.some(
      (checkpoint) =>
        checkpoint.type === "publication" &&
        (checkpoint.documents ?? []).some((cited) => pathKey(cited.path) === POSITIONING_PATH) &&
        (statusAt(checkpoint, state.now) === "open" || approvedAt(checkpoint, state.now)),
    );
    if (
      docs.positioning === false &&
      !submitted &&
      domain("marketing") &&
      active("julien") &&
      !skip("positioning")
    ) {
      if (docs.knowledge_base !== false) return call("positioning", "julien");
      if (domain("docs") && active(KNOWLEDGE_BASE_WRITER) && !skip("knowledge_base")) {
        return call("knowledge_base", KNOWLEDGE_BASE_WRITER);
      }
    }
    return firstOf("launch", [
      ...(domain("marketing") ? ["julien"] : []),
      ...(domain("sales") ? ["milo"] : []),
    ]);
  }

  // The stories: the build phase, or no phase at all. Done ones left out.
  const planner = domain("product") && active("izzy");
  if (current === "build" && planner && !has("epic") && !skip("breakdown")) {
    return call("breakdown", "izzy");
  }
  const stories = recordOf<StoryState>(state.projection, "stories");
  const notDone = (id: string) =>
    storyDoneAt(checkpoints, id, own(stories, id)) === undefined && !parkedStories.has(id);
  const withStatus = (status: StoryState["status"]) =>
    Object.keys(stories)
      .filter((id) => own(stories, id)?.status === status)
      .filter(notDone)
      .sort(byStoryId);
  const byDeclarer = (step: NextStepId, id: string) => {
    const agent = own(stories, id)?.status_by?.agent;
    return active(agent) ? call(step, agent, id) : yours(step, { story: id });
  };
  // No CI during the build: Omar sets it up first, whatever stories are under way.
  const ciMissing = docs.ci === false;
  const canSetupCi =
    ciMissing &&
    docs.ci_setup !== false &&
    domain("delivery") &&
    active("omar") &&
    !skip("ci_setup");
  if (canSetupCi && (current === "build" || current === null)) {
    return { ...call("setup_ci", "omar"), command: `${COMMAND} ci setup` };
  }
  /**
   * Of the stories to start or to merge, in order, the first one no open item of
   * deferred work locks gets its step, with the lock of the first story it went past; when every
   * one is locked, `deferred_work` for the first, to the item's owner (else the creator), with the
   * command that lists its items.
   */
  const lockOf = (id: string): NextDeferred | undefined => {
    // The creator skipped the lock of open deferred work (for this story or all).
    if (skip("story_deferred", id)) return undefined;
    const [item] = deferredLocks(state.projection, id);
    return item === undefined
      ? undefined
      : { item: item.id, title: item.title, story: id, command: `${COMMAND} deferred list ${id}` };
  };
  const firstFree = (ids: readonly string[], stepFor: (id: string) => NextStep): NextStep => {
    let skipped: NextDeferred | undefined;
    for (const id of ids) {
      const lock = lockOf(id);
      if (lock === undefined) {
        const step = stepFor(id);
        return skipped === undefined ? step : { ...step, deferred: skipped };
      }
      skipped ??= lock;
    }
    const [id] = ids;
    const item = id === undefined ? undefined : deferredLocks(state.projection, id)[0];
    if (id === undefined || item === undefined || skipped === undefined) {
      throw new Error("next: no story to propose");
    }
    const handled =
      item.owner !== "creator" && active(item.owner)
        ? call("deferred_work", item.owner, id)
        : yours("deferred_work", { story: id });
    return { ...handled, deferred: skipped, command: skipped.command };
  };
  /** A story's CI status, the creator's skip of it included. */
  const ciOf = (id: string): StoryCiStatus =>
    storyCiStatus(own(stories, id), undefined, skip("story_ci", id));
  /** A step on a story's CI: to the agent that declared the story, with its CI. */
  const ciStep = (step: NextStepId, id: string, command: string): NextStep => {
    const story = own(stories, id);
    const ci = story?.ci;
    // The CI cannot be read: only the creator can let the story go on without it.
    const unreadable = step === "ci_check" && ciMissing;
    return {
      ...(unreadable ? yours(step, { story: id }) : byDeclarer(step, id)),
      // The CI cannot be read: no command for the creator, who accepts the story in the chat.
      command: unreadable ? null : command,
      ci: {
        status: ciOf(id),
        failed: [...(ci?.failed ?? [])],
        pr: ci?.pr ?? null,
        url: ci?.url ?? null,
        cause: unreadable ? "no_ci" : null,
        // Never while the CI runs (or has not started): wait and read it again.
        waive: step === "ci_check" && (unreadable || !["pending", "stale"].includes(ciOf(id))),
      },
    };
  };
  const started = (id: string) => own(stories, id)?.started !== undefined;
  // The independent review: the reviewers of each kind, active and of their domain.
  const reviewersOf = (kind: "qa" | "security"): string[] =>
    (config.reviewers?.[kind] ?? [kind === "qa" ? "quentin" : "chloe"]).filter(
      (agent) => active(agent) && domain(kind === "qa" ? "quality" : "security"),
    );
  /** A story never started: the quality reviewer as before. */
  const legacyReview = (id: string): NextStep =>
    domain("quality") && active("quentin")
      ? call("review", "quentin", id)
      : yours("review", { story: id, command: historyCommand(id) });
  /** The developer sorts the findings of the story's closed passes. */
  const triageStep = (id: string): NextStep => {
    const story = own(stories, id);
    const developer =
      story?.started === undefined ? undefined : currentDeveloper(story.started.agent);
    const step = active(developer)
      ? call("review_triage", developer, id)
      : yours("review_triage", { story: id });
    return { ...step, review: reviewInfo(id) };
  };
  const reviewInfo = (id: string): NextReview => {
    const story = own(stories, id);
    // With the story's CI skipped no CI read names the commit: the last pass's does.
    const commit =
      story?.ci?.commit ??
      (skip("story_ci", id) ? reviewOf(story)?.passes.at(-1)?.commit : undefined) ??
      "";
    const pass = currentPass(story, commit);
    // Never the story's developer, nor the agent that gave the pass's other review.
    const eligible = (agent: string) =>
      !isStoryDeveloper(story, agent) &&
      !Object.values(pass?.reviews ?? {}).some((given) => given?.by === agent);
    const qaReviewers = reviewersOf("qa").filter(eligible);
    const securityReviewers = reviewersOf("security").filter(eligible);
    const qa =
      pass?.reviews.qa !== undefined ? "done" : qaReviewers.length > 0 ? "pending" : "unavailable";
    let security: NextReview["security"];
    if (pass?.reviews.security !== undefined) security = "done";
    else if (skip("story_security", id) || skip("story_review", id)) security = "skipped";
    else if (pass?.reviews.qa !== undefined) {
      security = needsSecurity(pass.security)
        ? securityReviewers.length > 0
          ? "pending"
          : "unavailable"
        : pass.security.reasons.length > 0
          ? "unavailable"
          : "not_required";
    } else security = securityReviewers.length > 0 ? "unknown" : "unavailable";
    const reviewers = [
      ...(qa === "pending" ? qaReviewers.slice(0, 1) : []),
      ...(security === "pending" || security === "unknown" ? securityReviewers.slice(0, 1) : []),
    ];
    return {
      pass: passNumberFor(story, commit),
      qa,
      security,
      reviewers,
      untriaged: untriagedFindings(story).length,
    };
  };
  /** A started story in review, its CI green: its review, its triage, then its merge checkpoint. */
  const reviewStep = (id: string): NextStep => {
    const story = own(stories, id);
    // With the review skipped by the creator, the story goes straight to its merge point
    // (the engine opens it); its findings, if any, are not sorted.
    const reviewSkipped = skip("story_review", id);
    if (!reviewSkipped && untriagedFindings(story).length > 0) return triageStep(id);
    if (reviewSkipped || storyReviewDone(story, undefined, skip("story_ci", id))) {
      const merge = openMergeCheckpoint(checkpoints, id);
      if (merge !== undefined && !held(merge)) {
        const rest = open.filter((checkpoint) => checkpoint.id !== merge.id);
        return yours("validation", {
          waiting: waitingOf([merge, ...rest]),
          command: `${COMMAND} review ${merge.id}`,
          checkpoint: merge.id,
          story: id,
        });
      }
      return {
        ...yours("review", { story: id, command: historyCommand(id) }),
        review: reviewInfo(id),
      };
    }
    const review = reviewInfo(id);
    const [first] = review.reviewers;
    if (first === undefined) {
      return { ...yours("review", { story: id, command: historyCommand(id) }), review };
    }
    return { ...call("review", first, id), review };
  };
  const inProgressIds = withStatus("in_progress");
  // A failed CI first: its agent fixes it in the story's worktree, on the same branch.
  const failedCi = inProgressIds.find((id) => started(id) && ciOf(id) === "fail");
  if (failedCi !== undefined) {
    return ciStep("ci_failed", failedCi, `${COMMAND} story start ${failedCi}`);
  }
  // The creator refused the story's merge or asked for changes: its developer takes
  // the note up, in the story's worktree, before any other story under way.
  const sentBack = inProgressIds.find((id) => {
    const story = own(stories, id);
    const feedback = story?.merge_feedback;
    return started(id) && feedback !== undefined && feedback.at === story?.status_by?.at;
  });
  if (sentBack !== undefined) {
    const feedback = own(stories, sentBack)?.merge_feedback;
    return {
      ...byDeclarer("merge_changes", sentBack),
      command: `${COMMAND} story start ${sentBack}`,
      ...(feedback === undefined
        ? {}
        : {
            merge_feedback: {
              checkpoint: feedback.checkpoint,
              decision: feedback.decision,
              note: feedback.note,
            },
          }),
    };
  }
  // A conflict with the main branch its developer qualified: they resolve it in the
  // story's worktree (the open `decision` of a conflict of substance waits for the creator above).
  const conflicted = inProgressIds.find((id) => {
    const found = openConflict(own(stories, id), checkpointsById);
    return started(id) && found !== undefined && found.phase !== "awaiting";
  });
  if (conflicted !== undefined) {
    const found = openConflict(own(stories, conflicted), checkpointsById);
    if (found !== undefined && found.phase !== "awaiting") {
      return {
        ...byDeclarer("merge_conflict", conflicted),
        command: `${COMMAND} story start ${conflicted}`,
        merge_conflict: {
          kind: found.conflict.kind,
          phase: found.phase,
          checkpoint: found.conflict.checkpoint,
          option: found.option,
          note: found.note,
          files: found.conflict.files.map((file) => file.path).slice(0, 20),
        },
      };
    }
  }
  // Findings of a closed review pass first: its developer sorts them.
  const toSort = inProgressIds.find(
    (id) =>
      started(id) && !skip("story_review", id) && untriagedFindings(own(stories, id)).length > 0,
  );
  if (toSort !== undefined) return triageStep(toSort);
  const inProgress = inProgressIds[0];
  if (inProgress !== undefined) return byDeclarer("build", inProgress);
  const inReview = withStatus("in_review");
  // A started story is reviewed on a green CI read since its last status.
  const unchecked = inReview.find((id) => started(id) && !ciGreen(ciOf(id)));
  if (unchecked !== undefined) {
    return ciStep("ci_check", unchecked, `${COMMAND} story ci ${unchecked}`);
  }
  if (inReview.length > 0) {
    // The stories whose merge checkpoint waits come in the order of the merges.
    const place = (id: string) => {
      const at = mergeQueued.findIndex((checkpoint) => checkpoint.story === id);
      return at === -1 ? Number.POSITIVE_INFINITY : at;
    };
    const inOrder = [...inReview].sort((a, b) => place(a) - place(b));
    return firstFree(inOrder, (id) => (started(id) ? reviewStep(id) : legacyReview(id)));
  }
  // A story the creator stopped on its way back from the fast track is left aside:
  // it must not hold up the rest of the work.
  const blocked = withStatus("blocked").find(
    (id) => fastTrackHold(own(stories, id), checkpoints, id) !== "stopped",
  );
  if (blocked !== undefined) return byDeclarer("story_blocked", blocked);
  // Any other status not done yet is still open: its agent goes on with it.
  const other = Object.keys(stories)
    .filter((id) => (own(stories, id)?.status ?? null) !== null)
    .filter(notDone)
    .sort(byStoryId)[0];
  if (other !== undefined) return byDeclarer("build", other);
  // A finished epic or sprint owes its retrospective, before the next sprint is planned.
  if (domain("product") && !skip("retrospective")) {
    const [due] = dueScopes({
      storyIds: docs.stories,
      stories,
      checkpoints: checkpointsById,
      sprints,
      now: state.now,
    });
    if (due !== undefined) return { ...firstOf("retrospective", ["izzy"]), scope: due };
  }
  // The sprints, in this order: the next story of the sprint in force (a proposal
  // waiting for the creator stays in `waiting`, never in its way); a proposal waiting for the
  // creator; then, with stories left to plan, a refused proposal back to its planner, or a new
  // sprint; with stories left that cannot be planned, their breakdown or its validation.
  const latest = latestSprint(sprints);
  const latestStatus =
    latest === undefined ? undefined : sprintStatus(latest, sprints, checkpointsById, state.now);
  // A story of the sprint whose file is gone is left aside.
  const toStart = (sprintProgress ?? []).filter(
    (story) =>
      story.status === "todo" && docs.stories.includes(story.id) && !parkedStories.has(story.id),
  );
  if (sprint !== undefined && toStart.length > 0) {
    // Its owner as the sprint recorded it; inactive, the first active agent of the approved
    // capacity; else the creator.
    // Its branch and worktree come first: the step carries `story start`.
    const owners = new Map(toStart.map((story) => [story.id, story.owner]));
    return firstFree(
      toStart.map((story) => story.id),
      (id) => {
        const owner = owners.get(id) ?? "creator";
        const command = `${COMMAND} story start ${id}`;
        if (owner === "creator") return yours("build", { story: id, command });
        // A developer the renaming retired gives way to its successor.
        const builder = [owner, ...sprint.capacity.agents]
          .map(currentDeveloper)
          .find((agent) => active(agent));
        return builder === undefined
          ? yours("build", { story: id, command })
          : { ...call("build", builder, id), command };
      },
    );
  }
  if (latest !== undefined && latestStatus === "proposed" && !skip("sprint_planning")) {
    const proposal = own(checkpointsById, latest.checkpoint);
    const rest = open.filter((checkpoint) => checkpoint.id !== latest.checkpoint);
    return yours("validation", {
      waiting: waitingOf(proposal === undefined ? rest : [proposal, ...rest]),
      command: `${COMMAND} review ${latest.checkpoint}`,
      checkpoint: latest.checkpoint,
    });
  }
  const unplanned = docs.stories
    .filter(
      (id) => StoryIdSchema.safeParse(id).success && (own(stories, id)?.status ?? null) === null,
    )
    .filter(notDone)
    .sort(byStoryId);
  if (planner && unplanned.length > 0) {
    const plannable =
      docs.plannable === undefined
        ? unplanned
        : unplanned.filter((id) => docs.plannable?.includes(id) === true);
    if (plannable.length > 0) {
      // Sprint planning skipped by the creator: the developers take the stories as they
      // come, in the order of their files.
      if (skip("sprint_planning")) {
        return firstFree(plannable, (id) =>
          firstOf("build", domain("code") ? STORY_BUILDERS : [], id),
        );
      }
      // The last proposal refused, and none since: its planner addresses the creator's note.
      const refused =
        latest !== undefined && latestStatus === "refused"
          ? own(checkpointsById, latest.checkpoint)
          : undefined;
      if (
        latest !== undefined &&
        refused !== undefined &&
        refused.opened_by === latest.planned_by
      ) {
        const step = active(latest.planned_by)
          ? call("changes_requested", latest.planned_by)
          : yours("changes_requested");
        return { ...step, checkpoint: refused.id, command: historyCommand(null) };
      }
      return call("sprint_planning", "izzy");
    }
    // Only stories that are not validated, or that `docs check` refuses: their breakdown waits
    // for the creator's review when a `document` checkpoint is open, else Izzy fixes it (never
    // proposed once the creator skipped the breakdown).
    if (!skip("breakdown")) {
      const review = open.find((checkpoint) => checkpoint.type === "document");
      if (review !== undefined) {
        const rest = open.filter((checkpoint) => checkpoint.id !== review.id);
        return yours("validation", {
          waiting: waitingOf([review, ...rest]),
          command: `${COMMAND} review ${review.id}`,
          checkpoint: review.id,
        });
      }
      return call("breakdown", "izzy");
    }
  }
  if (current === "build") {
    // Without a planner, a developer takes the first story.
    if (unplanned.length > 0) {
      return firstFree(unplanned, (id) =>
        firstOf("build", domain("code") ? STORY_BUILDERS : [], id),
      );
    }
    const builtInPhase = Object.keys(stories).some((id) => {
      const at = storyDoneAt(checkpoints, id, own(stories, id));
      return at !== undefined && atOrAfter(at, since);
    });
    if (builtInPhase) return ready();
    // Nothing built yet in this phase: the planner writes the next stories.
    if (planner && !skip("breakdown")) return call("breakdown", "izzy");
  }

  // 8. Nothing to do.
  return { ...base, step: "none" };
}

/** The steps where the creator is asked for a point: the agents have nothing more to do there. */
const ASKS_THE_CREATOR: ReadonlySet<NextStepId> = new Set([
  "validation",
  "phase_review",
  "knowledge_base_review",
  "knowledge_base_decision",
]);

/**
 * The steps that never depend on a point waiting for the creator: the stories under
 * way (building, reviewing, fixing the CI, answering a refusal, a conflict, the retrospective),
 * the planning of the next ones, the knowledge base. What comes after a document or a phase waits
 * for its approval (the next phase, the next document), and is not independent.
 */
const INDEPENDENT_STEPS: ReadonlySet<NextStepId> = new Set([
  "build",
  "review",
  "review_triage",
  "ci_failed",
  "ci_check",
  "merge_changes",
  "merge_conflict",
  "story_blocked",
  "changes_requested",
  "retrospective",
  "memory_record",
  "knowledge_base",
  "knowledge_base_update",
  "release_notes",
  "deferred_work",
  "setup_ci",
  "breakdown",
  "sprint_planning",
]);

/**
 * The next step of the product (see `computeStep` for the rules). Once the creator
 * chose the points that wait for them (`config.delegation`), a point they keep that is open does
 * not stop the agents: when the first step asks the creator, the work is looked for again as if
 * those points were not there (`independent`: the agents go on with it, the points staying in
 * `waiting`); when nothing independent is left, the step stays and says `stop`: the agents sum up
 * (`morning`) and wait for the creator's answer. Without a choice, nothing changes.
 */
export function nextStep(state: NextState, docs: NextDocs, config: NextConfig): NextStep {
  const step = withIndependence(state, docs, config);
  // The creator holds the team: whatever the method would propose, nothing starts.
  const pause = openPause(state.projection);
  if (pause !== undefined) return heldStep(step, pause);
  // Zoé's update beside a story under way, never in its place.
  const background = backgroundUpdate(state, docs, config);
  return background === undefined || step.step === "knowledge_base_update"
    ? step
    : { ...step, background };
}

/**
 * The step of a team the creator paused. It keeps what the creator still needs to see (the points
 * that wait, the phases, the sprint) and drops everything that names work to start.
 */
function heldStep(step: NextStep, pause: NonNullable<ReturnType<typeof openPause>>): NextStep {
  return {
    step: "paused",
    you: true,
    agent: null,
    agent_name: null,
    tool: null,
    waiting: step.waiting,
    command: null,
    story: null,
    checkpoint: null,
    sync: null,
    missing_tools: [],
    pending_keys: step.pending_keys,
    phase: step.phase,
    phases: step.phases,
    stray: step.stray,
    sprint: step.sprint,
    deferred: null,
    stop: true,
    paused: { since: pause.since, reason: pause.reason },
  };
}

/**
 * Zoé's update of the pages behind a document or a merged story while a story is under way: it
 * goes on beside the developers, who are never made to wait for it. Absent when no page is behind,
 * a story is not under way (the step itself is then the update), Zoé is not active, the base
 * step is skipped or Zoé already has a point open.
 */
function backgroundUpdate(
  state: NextState,
  docs: NextDocs,
  config: NextConfig,
): NextBackground | undefined {
  if (
    docs.knowledge_base !== true ||
    !config.domains.includes("docs") ||
    own(config.agents, KNOWLEDGE_BASE_WRITER) === undefined ||
    isSkipped(state.projection, "knowledge_base")
  ) {
    return undefined;
  }
  const checkpoints = Object.values(recordOf<CheckpointState>(state.projection, "checkpoints"));
  if (!storiesUnderWay(checkpoints, recordOf<StoryState>(state.projection, "stories"))) {
    return undefined;
  }
  if (
    checkpoints.some(
      (checkpoint) =>
        checkpoint.opened_by === KNOWLEDGE_BASE_WRITER &&
        statusAt(checkpoint, state.now) === "open",
    )
  ) {
    return undefined;
  }
  const pages = docs.knowledge_pages ?? [];
  const late = new Set([
    ...staleKnowledgeSources(pages, checkpoints, state.now).map((entry) => entry.page),
    ...staleKnowledgeStories(pages, mergedStoriesOf(state.projection)).map((entry) => entry.page),
  ]);
  if (late.size === 0) return undefined;
  const preferred = own(config.preferred, KNOWLEDGE_BASE_WRITER);
  return {
    step: "knowledge_base_update",
    agent: KNOWLEDGE_BASE_WRITER,
    agent_name: own(config.agents, KNOWLEDGE_BASE_WRITER) ?? KNOWLEDGE_BASE_WRITER,
    tool:
      preferred !== undefined && config.tools.includes(preferred)
        ? preferred
        : (config.tools[0] ?? null),
    pages: [...late].sort(),
  };
}

function withIndependence(state: NextState, docs: NextDocs, config: NextConfig): NextStep {
  const step = computeStep(state, docs, config);
  if (config.delegation === undefined) return step;
  if (step.step === "none" && step.waiting.length > 0) return { ...step, stop: true };
  if (!step.you || !ASKS_THE_CREATOR.has(step.step)) return step;
  const parked = new Set(step.waiting.map((entry) => entry.id));
  const independent = computeStep(state, docs, config, parked);
  if (!independent.you && INDEPENDENT_STEPS.has(independent.step)) {
    return { ...independent, waiting: step.waiting, independent: true };
  }
  return { ...step, stop: true };
}
