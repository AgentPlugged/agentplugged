import {
  AGENT_EVENT_TYPES,
  type BlockableAction,
  CHAT_EVENT_TYPES,
  CHECKPOINT_EVENT_TYPES,
  type CheckpointAutoAppliedPayload,
  type CheckpointOpenedPayload,
  CREATOR_ACTION_EVENT_TYPES,
  type CreatorActionExecutedPayload,
  type CreatorActionRecord,
  checkpointIdOf,
  DEFERRED_EVENT_TYPES,
  DEVIATION_EVENT_TYPES,
  deferredIdOf,
  deviationIdOf,
  ErrorCode,
  GetStateInputSchema,
  type InstallMode,
  LIFTING_DECISIONS,
  MAIN_SESSION_AGENT,
  type MethodConfig,
  OpenCheckpointInputSchema,
  type PhaseId,
  PlanSprintInputSchema,
  type ProjectionState,
  REQUIREMENT_EVENT_TYPES,
  ReportCostInputSchema,
  ReportMeasuresInputSchema,
  ReportProgressInputSchema,
  ReportStatusInputSchema,
  type RequirementEntry,
  SPRINT_EVENT_TYPES,
  SPRINT_TITLE_PREFIX,
  SubmitResultInputSchema,
  sprintIdOf,
  UpdateStoryInputSchema,
  type ValidationMode,
} from "@agentplugged/protocol";
import type { z } from "zod";
import { autoOption } from "../chat/auto-apply.js";
import { type DecisionChannels, decisionChannels } from "../chat/channels.js";
import { chatClientOf, isHookedClient } from "../chat/chat-proof.js";
import { hooksUntrustedOf } from "../chat/hook-trust.js";
import {
  type ResolvedValidationSettings,
  resolveValidationSettings,
} from "../chat/validation-settings.js";
import {
  blockedResultCheckpoint,
  blockingCheckpoint,
  blockScope,
  checkpointPayload,
  openBlockedResultCheckpoint,
} from "../checkpoints/checkpoint-rules.js";
import { type PointsView, pointsView } from "../checkpoints/point-rules.js";
import { relativizeCheckpointText } from "../checkpoints/product-paths.js";
import { answerable, statusAt, waiverExpired } from "../checkpoints/resolution-rules.js";
import { reasonHolds } from "../checkpoints/settled-rules.js";
import { type Command, type CommandContext, defineCommand, fail, ok } from "../command.js";
import { type CourseView, courseView } from "../course/course-rules.js";
import { criteriaProblem } from "../criteria/criterion-trace.js";
import { type CritiqueView, critiqueView } from "../critique/critique-rules.js";
import { type DeferredView, deferredView, storyLockProblem } from "../deferred/deferred-rules.js";
import { engineUpdatedOf, engineUpdateOf, updateAvailableOf } from "../engine-update.js";
import { AgentPluggedError } from "../errors.js";
import { type GitView, gitView } from "../git/git-view.js";
import { repositoryOnForge } from "../git/git-workflow.js";
import { METHOD_CONFIG_PATH } from "../init/layout.js";
import { loadMethodConfig, productOf } from "../init/method-config.js";
import { journalProduct } from "../journal/prepare-event.js";
import { forgetProductKey, projectionKey } from "../journal/product-key.js";
import type { JournalListing, StateStore } from "../journal/state-store.js";
import { isSkipped, skippedPhases } from "../journey/journey-rules.js";
import { type JourneyView, journeyView } from "../journey/journey-view.js";
import {
  ARCHITECTURE_PATH,
  ARCHITECTURE_SECURITY_REVIEW_PATH,
  type DesignWorkingCopy,
  designSecurityReviewGap,
  readWorkingBytes,
  SECURITY_REVIEWER,
} from "../phases/design-review.js";
import { uncommittedDocuments } from "../phases/phase-documents.js";
import {
  activePhases,
  openDocumentReview,
  PHASE_CLOSERS,
  type PhaseProgress,
  phaseProgress,
} from "../phases/phases.js";
import { methodNotInstalled } from "../profile/profile-command.js";
import type {
  AgentState,
  InstanceState,
  ResultEntry,
  StoryState,
} from "../projection/agent-reducers.js";
import { storyIn } from "../projection/agent-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { checkpointsOf } from "../projection/checkpoint-reducers.js";
import { computeProjection, computeProjectionDetailed } from "../projection/compute-projection.js";
import { type DelegationEntry, delegationsOf } from "../projection/delegation-reducers.js";
import { type InstallEntry, installsOf } from "../projection/install-reducers.js";
import type { LocalWarning } from "../projection/project-state.js";
import { stacksOf } from "../projection/stack-reducers.js";
import type { ExternalReadEntry } from "../projection/trust-reducers.js";
import { publicationOpenProblem } from "../publications/publication-rules.js";
import { readRegistry } from "../requirements/requirement-files.js";
import {
  type RequirementsView,
  requirementsView,
  sameRegistry,
} from "../requirements/requirement-rules.js";
import { reviewSummaryOf } from "../review/review-rules.js";
import {
  checkSprint,
  citesStoryFile,
  currentSprint,
  firstSprintProblem,
  latestSprint,
  type SprintProblem,
  type SprintStory,
  type SprintView,
  sprintBudget,
  sprintCheckpointSummary,
  sprintEntries,
  sprintGeneratedLines,
  sprintStatus,
  sprintsOf,
  sprintView,
  storyDoneAt,
  validationOf,
} from "../sprints/sprint-rules.js";
import { readSprintStories } from "../sprints/sprint-stories.js";
import { instrumentationProblem } from "../stories/story-instrumentation.js";
import {
  branchIntentProblem,
  readBranchIntent,
  resultMovesToReview,
} from "../stories/story-review.js";
import { activeAgentNames, loadDefinitions } from "../sync/sync-command.js";
import { type DeviationView, deviationView } from "../trace/deviation-rules.js";
import { type ResolvedInstallSettings, resolveInstallSettings } from "../trust/install-settings.js";
import { plannedDependencies } from "../trust/planned-dependencies.js";
import { type SessionTrust, sessionTrust } from "../trust/session.js";
import { measureProduct } from "../usage/measure-product.js";
import {
  estimatesOf,
  finishedStories,
  type UsageView,
  usageSessionsOf,
  usageView,
} from "../usage/usage-rules.js";
import { fitState, type GetStateResult, stateDetail, summarizeState } from "./state-view.js";

/** What a write tool returns: the event recorded in the journal. */
export interface RecordedEvent {
  readonly id: string;
  readonly type: string;
  readonly at: string;
  /** The checkpoint the call opened (`open_checkpoint`, `submit_result` with `blocked`). */
  readonly checkpoint?: string;
  /** The sprint the call planned (`plan_sprint`). */
  readonly sprint?: string;
  /** The item of deferred work the call recorded (`defer_work`). */
  readonly deferred?: string;
  /** The deviation the call reported (`report_deviation`). */
  readonly deviation?: string;
  /**
   * The checkpoint the call opened was answered at once by the engine (`auto` level, story
   * 2.15): its recommended option applied. Tell the creator, who can reopen it.
   */
  readonly auto_applied?: { readonly checkpoint: string; readonly option: string };
  /**
   * The creator's action the call's approval carried out in the journal (
   * `creator_action.executed`): its checkpoint and the action as recorded.
   */
  readonly creator_action?: {
    readonly checkpoint: string;
    readonly action: CreatorActionRecord;
  };
}

/** An open question or a conflict of a last result, as `get_state` lists them. */
export interface OpenPoint {
  readonly kind: "question" | "conflict";
  readonly text: string;
  readonly agent: string;
  readonly story: string | null;
}

/**
 * The clock of the creator's machine: the journal and `get_state` carry UTC
 * instants (ending in `Z`), but the creator reads local time. Agents show every time in
 * `time_zone`, never in UTC.
 */
export interface ClockView {
  /** Now, as the engine reads it (ISO 8601, UTC). */
  readonly now: string;
  /** Now in the creator's time zone: `2026-10-03 14:05:09 +02:00`. */
  readonly now_local: string;
  /** The IANA name of the machine's time zone (`Europe/Paris`). */
  readonly time_zone: string;
  /** The machine's offset from UTC now (`+02:00`): it changes with daylight saving time. */
  readonly utc_offset: string;
}

const pad2 = (value: number) => String(value).padStart(2, "0");

/** The machine's clock at `now` (milliseconds): the instant, its local form and the zone. */
export function clockView(now: number): ClockView {
  const date = new Date(now);
  const offset = -date.getTimezoneOffset();
  const abs = Math.abs(offset);
  const utcOffset = `${offset < 0 ? "-" : "+"}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
  let zone = "";
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    zone = "";
  }
  return {
    now: date.toISOString(),
    now_local:
      `${String(date.getFullYear()).padStart(4, "0")}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
      `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())} ${utcOffset}`,
    time_zone: zone === "" ? `UTC${utcOffset}` : zone,
    utc_offset: utcOffset,
  };
}

/**
 * The complete state of the product, as the engine computes it from the journal:
 * `get_state` returns it abridged (`AgentStateView`, in `state-view.ts`) and reads any part of it
 * in full through its options.
 */
export interface FullStateView {
  /**
   * The clock of the creator's machine: show every time to the creator in its
   * `time_zone`, never in UTC; the instants of this state end in `Z` (UTC).
   */
  readonly clock: ClockView;
  /**
   * Noah's handovers, oldest first, the latest `DELEGATIONS_KEPT`: to whom, in which
   * mode, on which story, with which brief.
   */
  readonly delegations: readonly DelegationEntry[];
  readonly product: string | null;
  /** The journal position the state was computed at, or null for an empty journal. */
  readonly journal_head: string | null;
  readonly agents: Readonly<Record<string, AgentState>>;
  /**
   * The instances at work, by `<agent>/<story>`: one run of an agent on one
   * story, named by the pair ("Sam · story 4-2"); two stories of one developer are two instances.
   */
  readonly instances: Readonly<Record<string, InstanceState>>;
  readonly stories: Readonly<Record<string, StoryState>>;
  /** The checkpoints, by id: each one's status, last measures and verdict. */
  readonly checkpoints: Readonly<Record<string, CheckpointState>>;
  /**
   * Open questions and conflicts of the last results: each agent's on each story, and each
   * agent's last one without a story.
   */
  readonly open_points: readonly OpenPoint[];
  /**
   * Warnings of this machine: sensitive content it cannot read, or a keychain it could
   * not use. Never written anywhere.
   */
  readonly warnings: readonly LocalWarning[];
  /**
   * The phases, drawn from the journal: the current one and its status, when it began,
   * and each phase's status. Work only on the current phase.
   */
  readonly phase: AgentPhaseView;
  /**
   * The steps of the journey the creator skipped: their choice, with who said it and
   * why. Shown as skipped, never as errors, and never proposed again; the creator may take them up
   * again at any time.
   */
  readonly journey: JourneyView;
  /**
   * The creator's Git workflow: what they chose or the recommendation, and with a staging
   * branch (`main` + `dev`) what waits there and whether it is time to put it into production.
   */
  readonly git: GitView;
  /**
   * The calling session: the external reads it is known to have made, and whether it made
   * any (`trusted`: none). A trace, nothing is blocked for it: what an untrusted session
   * writes only carries its provenance.
   */
  readonly session: {
    readonly trusted: boolean;
    readonly reads: readonly { readonly tool: string; readonly source: string }[];
  };
  /**
   * The external reads the journal holds for the product, whatever the session: how many
   * (`total`), and the latest ones with who read (`agent`, `main` for the tool's main session),
   * when (`at`) and from what (`source`). The history of what was read, never a block.
   */
  readonly external_reads: {
    readonly total: number;
    readonly recent: readonly ExternalReadView[];
  };
  /**
   * The sprints: the one in force (its checkpoint approved, answered last), and the
   * one planned last, whatever its status (`proposed`, `in_force`, `superseded`, `refused`), each
   * with the status of its stories in order.
   */
  readonly sprint: {
    readonly current: SprintView | null;
    readonly latest: SprintView | null;
  };
  /**
   * The register of deferred work: the open items in recording order, each with the
   * stories it locks, and how many were done or dropped.
   */
  readonly deferred: DeferredView;
  /**
   * The deviations: the open ones in reporting order, each with its story, the
   * requirements it drifts from and the pull request it was reported on, and how many were
   * resolved. A story with an open deviation is not merged.
   */
  readonly deviations: DeviationView;
  /**
   * The non-functional requirements: how many are proven, failed or without a valid
   * proof, and the gaps by id (at most 8). Absent while no register was ever written.
   */
  readonly requirements?: RequirementsView;
  /** The hypotheses open and the critiques not sorted yet; absent when there is none. */
  readonly critique?: CritiqueView;
  /** The correction of course that is open, what is left to decide; absent when none. */
  readonly course?: CourseView;
  /**
   * The estimates of the next stories, in US dollars at the API's public prices:
   * from the product's own finished stories or the method's reference. Estimates only: what the
   * engine measured of the sessions stays in the journal and is never shown here.
   */
  readonly usage: UsageView;
  /**
   * How the creator answers checkpoints: the validation level in force and where it
   * was read, how this session's chat answers are proved (`hook`: the AI tool records the
   * creator's messages; `unverified`: they are recorded « non vérifiée »), and the open
   * checkpoints only the terminal answers now: those of a high risk at the `strict` level.
   */
  readonly validation: AgentValidationView;
  /**
   * The stacks that still have a point waiting: each with the points left, to present
   * together (`open_stack`, `ask_stack`, `answer_stack`).
   */
  readonly stacks: readonly AgentStackView[];
  /**
   * The installations: the mode in force (`visible` or `validate`), where it was read,
   * what the approved architecture declares (the number of packages by ecosystem, none when no
   * approved architecture declares any), and the latest installations let through without asking.
   */
  readonly installs: AgentInstallsView;
}

/** One external read of the journal, as `get_state` shows it. */
export interface ExternalReadView {
  readonly tool: string;
  readonly source: string;
  readonly agent: string | null;
  readonly at: string;
}

/** A stack with points still waiting, as `get_state` shows it. */
export interface AgentStackView {
  readonly id: string;
  readonly opened_by: string | null;
  readonly opened_at: string;
  readonly remaining: readonly { readonly n: number; readonly checkpoint: string }[];
  readonly total: number;
}

/** The installations as `get_state` shows them. */
export interface AgentInstallsView {
  readonly mode: InstallMode;
  readonly source: "main" | "working_copy";
  readonly warning: ResolvedInstallSettings["warning"];
  readonly declared: Readonly<Record<string, number>>;
  readonly recent: readonly InstallEntry[];
}

/** The latest installations `get_state` shows. */
const INSTALLS_SHOWN = 20;

/** The validation level as `get_state` shows it. */
export interface AgentValidationView {
  readonly mode: ValidationMode;
  readonly source: "main" | "working_copy";
  /**
   * The main branch's `validation` section could not be read: `strict` applies until the
   * creator fixes it (`main_validation_invalid`), else null.
   */
  readonly warning: ResolvedValidationSettings["warning"];
  /**
   * The local main branch holds commits not published to the remote (the creator's
   * settings among them, which apply anyway): Noah offers to publish them, one « oui », with
   * `request_creator_action` `forge_push_main` (a fast-forward, never forced). Null when none.
   */
  readonly unpublished: ResolvedValidationSettings["unpublished"];
  readonly proof: "hook" | "unverified";
  readonly review: readonly string[];
  /**
   * The AI tool of this session shows the engine's forms: `ask_creator` presents a
   * checkpoint there, and the creator clicks the answer. False: the form is not used (the tool
   * shows none, or refused one at once: see `channels`).
   */
  readonly elicitation: boolean;
  /**
   * How the creator can be asked a decision right now, read at this call: the channels
   * the engine can use in the order it tries them (`elicitation`: the tool's MCP form,
   * `question_tool`: the tool's question tool, `chat`), what the form did in this session
   * (`works`, `untested`, `declined_by_client`: refused at once, `unavailable`), and the question
   * tool's state (`available`, `hook_missing`: run `sync`, `unavailable`).
   */
  readonly channels: DecisionChannels;
  /**
   * The points the creator keeps for themselves and those the agents decide: `fixed`
   * waits for the creator; any other point is decided by the agent responsible, with
   * `decide_checkpoint`. `configured: false`: the creator has not chosen, every point waits for
   * them, and Noah offers them to choose (`proposed`).
   */
  readonly points: PointsView;
}

/** The phases as `get_state` shows them. */
export interface AgentPhaseView {
  readonly current: PhaseProgress["current"];
  /** `in_progress`, `in_review` (its end is open), or null without a current phase. */
  readonly status: "in_progress" | "in_review" | null;
  readonly since: string | null;
  readonly phases: PhaseProgress["phases"];
  /**
   * Ends of phase left aside: open for another phase than the current one, or approved out of
   * turn (an earlier profile, an old journal). The creator decides what to do with them.
   */
  readonly stray: PhaseProgress["stray"];
}

/** The phases of the product as agents see them. */
function phaseView(
  checkpoints: Readonly<Record<string, CheckpointState>>,
  config: MethodConfig,
  now: number,
  /** The phases the creator skipped: shown as skipped, never proposed. */
  skipped: ReadonlySet<PhaseId> = new Set(),
): AgentPhaseView {
  const progress = phaseProgress(
    Object.values(checkpoints),
    activePhases(config.profile, skipped),
    now,
  );
  return {
    current: progress.current,
    status: progress.current === null ? null : progress.open === null ? "in_progress" : "in_review",
    since: progress.since,
    phases: progress.phases.map((entry) => ({ ...entry })),
    stray: progress.stray.map((entry) => ({ ...entry })),
  };
}

/** `INVALID_ARGUMENTS` for the first issue of an input: `details: { field, reason }`. */
export function invalidInput(command: string, error: z.ZodError): AgentPluggedError {
  const issue = error.issues[0];
  const path = [...(issue?.path ?? [])].map(String);
  if (issue?.code === "unrecognized_keys" && issue.keys[0] !== undefined) path.push(issue.keys[0]);
  const field = path.length > 0 ? path.join(".") : "(root)";
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
    command,
    field,
    reason: `${command}: ${field}: ${issue?.message ?? "invalid"}`,
  });
}

function unavailableJournal(): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
    reason: "no journal is available here",
  });
}

/** What an agent's write needs: the product and its journal, once the agent is known active. */
export async function agentWriteContext(
  context: CommandContext,
  agent: string,
): Promise<
  | {
      product: string;
      journal: StateStore;
      config: MethodConfig;
      /** The active agents of the product, by id. */
      agents: ReadonlySet<string>;
    }
  | AgentPluggedError
> {
  const { files } = context;
  if (!(await files.exists(METHOD_CONFIG_PATH))) return methodNotInstalled();
  const loaded = await loadMethodConfig(files);
  if (loaded instanceof AgentPluggedError) return loaded;
  const definitions = await loadDefinitions(files);
  if (definitions instanceof AgentPluggedError) return definitions;
  const agents = activeAgentNames(definitions, loaded.config);
  if (agent !== MAIN_SESSION_AGENT && !agents.has(agent)) {
    return new AgentPluggedError(ErrorCode.AGENT_NOT_FOUND, "error.agent_not_active", {
      id: agent,
    });
  }
  const journal = context.journal;
  if (journal === undefined) return unavailableJournal();
  const product = await productOf(loaded.config, journal);
  if (product instanceof AgentPluggedError) return product;
  return { product, journal, config: loaded.config, agents };
}

/**
 * The projection of a journal listing, with the product `method.yaml` pins. Without the product
 * key: the checks of a write never need the sensitive content (`get_state` decrypts it).
 */
export async function project(
  context: CommandContext,
  config: MethodConfig,
  listing: JournalListing,
): Promise<ProjectionState> {
  return computeProjection(listing.events, {
    problems: listing.problems,
    head: listing.head,
    ...(config.product_id === undefined ? {} : { product: config.product_id }),
    allowTestTypes: context.allowTestTypes === true,
  });
}

/**
 * The projection `get_state` shows: with the sensitive content when this machine holds the
 * product key (in memory only), and the warnings of this machine (`sensitive_unreadable`, a
 * keychain that could not be read).
 */
export async function projectWithKey(
  context: CommandContext,
  config: MethodConfig,
  listing: JournalListing,
): Promise<{ projection: ProjectionState; warnings: LocalWarning[] }> {
  const access = await projectionKey(
    context,
    config.product_id ?? journalProduct(listing.events)?.product,
    {
      events: listing.events,
      problems: listing.problems,
      allowTestTypes: context.allowTestTypes === true,
    },
  );
  try {
    const detailed = await computeProjectionDetailed(listing.events, {
      problems: listing.problems,
      head: listing.head,
      ...(config.product_id === undefined ? {} : { product: config.product_id }),
      allowTestTypes: context.allowTestTypes === true,
      ...(access.key === undefined ? {} : { productKey: access.key }),
    });
    const warnings: LocalWarning[] = [];
    if (access.keychainError !== undefined) {
      warnings.push({ code: "keychain_unavailable", reason: access.keychainError });
    }
    if (detailed.unreadable > 0) {
      warnings.push({ code: "sensitive_unreadable", count: detailed.unreadable });
    }
    return { projection: detailed.projection, warnings };
  } finally {
    await forgetProductKey(access.key);
  }
}

/** One event a command writes: its type, story and payload. */
export interface EventSpec {
  readonly type: string;
  readonly story?: string | undefined;
  readonly payload: Record<string, unknown>;
  /** The payload field the journal sets to the checkpoint the previous event opens. */
  readonly checkpointField?: string;
  /** Written by the engine itself (`actor.kind: system`), not the agent: the `auto` level. */
  readonly actor?: "system";
}

/** An action a command takes, which an open checkpoint may block. */
export interface CommandAction {
  readonly action: BlockableAction;
  readonly story?: string | undefined;
}

/** The checkpoint a call reuses instead of opening one. */
export interface Planned {
  readonly events: EventSpec[];
  readonly checkpoint?: string;
  /** The index of the command's own event, whose id the command returns (0 when absent). */
  readonly own?: number;
}

/** The events a command planned no longer match the journal under the lock: plan again. */
class StalePlan extends Error {}

/** How many times a command whose plan depends on the journal plans again. */
const MAX_PLAN_ATTEMPTS = 3;

export interface AgentCommandSpec<S extends z.ZodType, P = undefined> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: S;
  /**
   * The events to write, from the checked input, in one append (all or none): the first is the
   * command's own (unless `own` says otherwise), whose id the command returns. `state` is the
   * state of the product read before the write, given only when `needsState` says so; `prepared`
   * is what `prepare` read; `now` the clock (milliseconds), read again when planned again.
   */
  events(
    input: z.infer<S>,
    state: ProjectionState["state"] | undefined,
    prepared: P | undefined,
    now: number,
  ): Planned;
  /** True when `events` needs the state of the product. */
  needsState?(input: z.infer<S>): boolean;
  /** The action the call takes, when an open checkpoint may block it. */
  action?(input: z.infer<S>): CommandAction | undefined;
  /**
   * What `check` needs of the working copy, read once before the write (files are not under the
   * journal lock): given to `check` as `env.prepared`.
   */
  prepare?(
    input: z.infer<S>,
    context: CommandContext,
    agents: ReadonlySet<string>,
    config: MethodConfig,
  ): Promise<P>;
  /**
   * The state given to `events` is computed with the product key, in memory only (
   * the costs), and `events` is planned again under the journal lock: when the plan differs, the
   * command starts over (`MAX_PLAN_ATTEMPTS`), so what is written always follows the journal as
   * it is when written.
   */
  readonly keyed?: boolean;
  /**
   * `events` is planned again under the journal lock from the state without the key, and the
   * command starts over when the plan differs, like `keyed` (a result that moves its
   * story to review).
   */
  readonly replanned?: boolean;
  /**
   * What the engine does once the events are written (it measures the sessions when an
   * agent ends its run). Best effort: a failure here never fails the command.
   */
  after?(
    context: CommandContext,
    input: z.infer<S>,
    target: { product: string; journal: StateStore; config: MethodConfig },
  ): Promise<void>;
  /**
   * A check against the state of the product as it is when written: an error refuses. `env` gives
   * the method's settings, the clock (milliseconds) and the command's context, for a check that
   * reads Git under the lock.
   */
  check?(
    input: z.infer<S>,
    state: ProjectionState["state"],
    env: {
      readonly config: MethodConfig;
      readonly now: number;
      readonly agents: ReadonlySet<string>;
      readonly prepared: P | undefined;
      readonly context: CommandContext;
    },
  ): AgentPluggedError | undefined | Promise<AgentPluggedError | undefined>;
}

/**
 * The `events` and `check` of a command whose plan can be refused: one `plan` serves both, its
 * refusal thrown before the write and returned by the check under the journal lock. `fallback`
 * stands for a preparation that is missing.
 */
export function planned<I, P>(
  plan: (
    input: I,
    state: ProjectionState["state"],
    prepared: P,
    now: number,
  ) => EventSpec[] | AgentPluggedError,
  fallback?: P,
): {
  events(
    input: I,
    state: ProjectionState["state"] | undefined,
    prepared: P | undefined,
    now: number,
  ): Planned;
  check(
    input: I,
    state: ProjectionState["state"],
    env: { readonly prepared: P | undefined; readonly now: number },
  ): AgentPluggedError | undefined;
} {
  return {
    events(input, state, prepared, now) {
      const events = plan(input, state ?? {}, (prepared ?? fallback) as P, now);
      if (events instanceof AgentPluggedError) throw events;
      return { events };
    },
    check(input, state, env) {
      const events = plan(input, state, (env.prepared ?? fallback) as P, env.now);
      return events instanceof AgentPluggedError ? events : undefined;
    },
  };
}

/** `CHECKPOINT_OPEN`: the call takes an action an open checkpoint blocks. */
function checkpointOpen(checkpoint: string, action: BlockableAction): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.CHECKPOINT_OPEN, "error.checkpoint_open", {
    checkpoint,
    action,
  });
}

/**
 * A command reserved to agents that writes its events: the input is checked by its `protocol`
 * schema (strict: an `actor` or `kind` is refused), the agent must be an active agent of the
 * product, and the events are signed by the machine key with `actor.kind = agent`, set here and
 * never read from the input. The action the call takes must not be blocked by an open checkpoint
 * (`CHECKPOINT_OPEN`): that check, and the command's own, run under the journal lock on the
 * journal as it is when written (`appendAll` precondition), so a checkpoint another process
 * opened meanwhile is seen. Nothing is written on a refusal.
 */
export function agentEventCommand<S extends z.ZodType<{ agent: string }>, P = undefined>(
  spec: AgentCommandSpec<S, P>,
): Command<RecordedEvent> {
  return defineCommand<RecordedEvent>({
    name: spec.name,
    audience: "agent",
    description: spec.description,
    inputSchema: spec.inputSchema,
    async run(context, input) {
      const parsed = spec.inputSchema.safeParse(input);
      if (!parsed.success) return fail(invalidInput(spec.name, parsed.error));
      const value = parsed.data as z.infer<S>;
      const target = await agentWriteContext(context, value.agent);
      if (target instanceof AgentPluggedError) return fail(target);
      for (let attempt = 1; ; attempt += 1) {
        try {
          const recorded = await writeOnce(spec, context, value, target);
          if (spec.after !== undefined) {
            await spec.after(context, value, target).catch(() => undefined);
          }
          return ok(recorded);
        } catch (error) {
          if (error instanceof StalePlan) {
            if (attempt < MAX_PLAN_ATTEMPTS) continue;
            return fail(
              new AgentPluggedError(ErrorCode.JOURNAL_BUSY, "error.journal_busy_replanned", {
                command: spec.name,
                attempts: attempt,
              }),
            );
          }
          if (error instanceof AgentPluggedError) return fail(error);
          throw error;
        }
      }
    },
  });
}

/**
 * One attempt of an agent's write (see `agentEventCommand`): read, plan, then write under the
 * journal lock. Throws `StalePlan` when a `keyed` command's plan changed under the lock.
 */
async function writeOnce<S extends z.ZodType<{ agent: string }>, P>(
  spec: AgentCommandSpec<S, P>,
  context: CommandContext,
  value: z.infer<S>,
  target: {
    product: string;
    journal: StateStore;
    config: MethodConfig;
    agents: ReadonlySet<string>;
  },
): Promise<RecordedEvent> {
  // One read of the journal, only when the state or the session's reads need it.
  const needsState = spec.needsState?.(value) === true;
  const needsReads = (context.session?.ids.length ?? 0) > 0;
  const listing = needsState || needsReads ? await target.journal.list() : undefined;
  const stateOf = async (read: JournalListing) =>
    spec.keyed === true
      ? (await projectWithKey(context, target.config, read)).projection.state
      : (await project(context, target.config, read)).state;
  const before = needsState && listing !== undefined ? await stateOf(listing) : undefined;
  const prepared = await spec.prepare?.(value, context, target.agents, target.config);
  const clock = context.now ?? Date.now;
  // The `auto` level: read from the main branch only when a checkpoint qualifies.
  // The session's trust: the provenance of its events, for the audit.
  const trust = await sessionTrust(
    context,
    target.config,
    needsReads ? (listing?.events ?? []) : [],
  );
  const firstPlan = spec.events(value, before, prepared, clock());
  const autoMode = autoCandidates(firstPlan)
    ? (await resolveValidationSettings(target.config, context.mainBranch)).mode
    : undefined;
  const planned = withAutoApplied(firstPlan, autoMode);
  const action = spec.action?.(value);
  const replan = (spec.keyed === true || spec.replanned === true) && needsState;
  const precondition =
    action === undefined && spec.check === undefined && !replan
      ? undefined
      : async (listing: JournalListing) => {
          const now = clock();
          // One projection under the lock: with the key for a `keyed` command planned again (its
          // decrypted state holds everything the other checks read), else without it.
          const plannedState = replan ? await stateOf(listing) : undefined;
          const state = plannedState ?? (await project(context, target.config, listing)).state;
          if (action !== undefined) {
            const blocking = blockingCheckpoint(
              Object.values(checkpointsOf(state)),
              action.action,
              action.story,
              now,
            );
            if (blocking !== undefined) throw checkpointOpen(blocking.id, action.action);
          }
          const refused = await spec.check?.(value, state, {
            config: target.config,
            now,
            agents: target.agents,
            prepared,
            context,
          });
          if (refused !== undefined) throw refused;
          // The plan follows the journal as it is when written.
          if (replan) {
            const again = withAutoApplied(
              spec.events(value, plannedState, prepared, now),
              autoMode,
            );
            if (JSON.stringify(again) !== JSON.stringify(planned)) throw new StalePlan();
          }
        };
  const events = await target.journal.appendAll(
    planned.events.map(({ type, story, payload, checkpointField, actor }) => ({
      type,
      actor:
        actor === "system"
          ? { kind: "system" as const }
          : { kind: "agent" as const, agent: value.agent },
      product: target.product,
      ...(story === undefined ? {} : { story }),
      // Everything an untrusted session writes carries its provenance.
      provenance: provenanceOf(trust),
      payload,
      ...(checkpointField === undefined ? {} : { checkpointField }),
    })),
    precondition === undefined ? {} : { precondition },
  );
  const event = events[planned.own ?? 0];
  if (event === undefined) throw new Error(`${spec.name}: nothing was written`);
  const opened = events.find((entry) => entry.type === CHECKPOINT_EVENT_TYPES.opened);
  const checkpoint = opened === undefined ? planned.checkpoint : checkpointIdOf(opened.id);
  const sprint = events.find((entry) => entry.type === SPRINT_EVENT_TYPES.planned);
  const deferred = events.find((entry) => entry.type === DEFERRED_EVENT_TYPES.recorded);
  const deviation = events.find((entry) => entry.type === DEVIATION_EVENT_TYPES.reported);
  const auto = events.find((entry) => entry.type === CHAT_EVENT_TYPES.autoApplied);
  const autoPayload = auto?.payload as CheckpointAutoAppliedPayload | undefined;
  const executed = events.find((entry) => entry.type === CREATOR_ACTION_EVENT_TYPES.executed)
    ?.payload as CreatorActionExecutedPayload | undefined;
  return {
    id: event.id,
    type: event.type,
    at: event.at,
    ...(checkpoint === undefined ? {} : { checkpoint }),
    ...(sprint === undefined ? {} : { sprint: sprintIdOf(sprint.id) }),
    ...(deferred === undefined ? {} : { deferred: deferredIdOf(deferred.id) }),
    ...(deviation === undefined ? {} : { deviation: deviationIdOf(deviation.id) }),
    ...(autoPayload === undefined
      ? {}
      : { auto_applied: { checkpoint: autoPayload.checkpoint, option: autoPayload.option } }),
    ...(executed === undefined
      ? {}
      : { creator_action: { checkpoint: executed.checkpoint, action: executed.action } }),
  };
}

/** The option the engine would apply to a planned `checkpoint.opened`. */
function plannedAutoOption(event: EventSpec): string | undefined {
  if (event.type !== CHECKPOINT_EVENT_TYPES.opened) return undefined;
  return autoOption(event.payload as CheckpointOpenedPayload);
}

/** True when a planned `checkpoint.opened` could be answered by the engine at the `auto` level. */
function autoCandidates(planned: Planned): boolean {
  return planned.events.some((event) => plannedAutoOption(event) !== undefined);
}

/**
 * The plan with, at the `auto` level, the recommended option of each qualifying checkpoint
 * applied by the engine (`checkpoint.auto_applied`, `actor.kind: system`), right after the
 * `checkpoint.opened` of the same write, which it names (`checkpointField`). Pure: planned again
 * under the journal lock, it gives the same events.
 */
export function withAutoApplied(planned: Planned, mode: ValidationMode | undefined): Planned {
  if (mode !== "auto") return planned;
  const events: EventSpec[] = [];
  let own = planned.own ?? 0;
  planned.events.forEach((event, index) => {
    events.push(event);
    // Never between an opening and the event of the same write that names it (a sprint).
    if (planned.events[index + 1]?.checkpointField !== undefined) return;
    const option = plannedAutoOption(event);
    if (option === undefined) return;
    events.push({
      type: CHAT_EVENT_TYPES.autoApplied,
      story: event.story,
      payload: { decision: "option_chosen", option },
      checkpointField: "checkpoint",
      actor: "system",
    });
    if (index < (planned.own ?? 0)) own += 1;
  });
  return { ...planned, events, ...(planned.own === undefined ? {} : { own }) };
}

/** `trusted` only for a session known to be trusted. */
export function provenanceOf(trust: SessionTrust): "trusted" | "untrusted" {
  return trust.trusted ? "trusted" : "untrusted";
}

/** Removes the keys whose value is undefined: the payload is canonical JSON. */
export function defined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

export const reportStatusCommand = agentEventCommand({
  name: "report_status",
  description:
    "Declare what you are doing: call it when you start a task (working), when you wait for someone (waiting), when you are blocked (blocked) and when you are done (idle). `agent` is your own agent id, or `main` for the tool's main session. `story` is `<epic>-<story>`, for example `2-6`. `skill` names the skill you start (with `working`): your next report without it ends it, and the measure tells the creator what the skill consumed. A blocked status opens no checkpoint: end with submit_result `blocked`, or call open_checkpoint, for the creator to answer.",
  inputSchema: ReportStatusInputSchema,
  events: ({ status, task, story, skill }) => ({
    events: [
      { type: AGENT_EVENT_TYPES.statusReported, story, payload: defined({ status, task, skill }) },
    ],
  }),
});

export const reportProgressCommand = agentEventCommand({
  name: "report_progress",
  description:
    "Report your progress on a story: a short note and, when you know it, a percentage (0 to 100).",
  inputSchema: ReportProgressInputSchema,
  events: ({ story, percent, note }) => ({
    events: [
      { type: AGENT_EVENT_TYPES.progressReported, story, payload: defined({ percent, note }) },
    ],
  }),
});

export const reportCostCommand = agentEventCommand({
  name: "report_cost",
  description:
    "Report what your tool itself shows of your consumption on a story: the share of its quota (`quota_percent`), tokens when it gives them. Never write a dollar amount: the engine measures what your session consumed itself, in the AI tool's traces, when you submit your result, and nothing of it is shown to the creator here. It is an indication kept in the journal, with no effect on your work: no budget pauses a story.",
  inputSchema: ReportCostInputSchema,
  events: ({
    story,
    usd,
    estimated,
    tokens_in,
    tokens_out,
    billing,
    quota_percent,
    run,
    cumulative,
  }) => {
    const payload = defined({
      usd,
      estimated,
      tokens_in,
      tokens_out,
      billing,
      quota_percent,
      run,
      cumulative,
    });
    return { events: [{ type: AGENT_EVENT_TYPES.costReported, story, payload }] };
  },
});

export const updateStoryCommand = agentEventCommand({
  name: "update_story",
  description:
    "Change the status of a story you work on: in_progress, in_review or blocked. Only the creator validates a story. Moving a story to in_review is refused with CHECKPOINT_OPEN while an open checkpoint blocks its review: work on something else meanwhile. Marking a story blocked opens no checkpoint: end with submit_result `blocked`, or call open_checkpoint, for the creator to answer. Starting a story (any status while it has none yet) is refused with STORY_LOCKED while an open item of deferred work locks it (get_state `deferred`): treat that item first, then call complete_deferred. Moving a story to in_review is refused with STORY_INTENT_CHANGED while the last commit of its branch no longer holds the intent the creator approved: put the approved text of the intent back and commit it, or ask the creator to approve the new intent through a `document` checkpoint on the story.",
  inputSchema: UpdateStoryInputSchema,
  events: ({ story, status }) => ({
    events: [{ type: AGENT_EVENT_TYPES.storyStatusChanged, story, payload: { status } }],
  }),
  action: ({ story, status }) =>
    status === "in_review" ? { action: "story.review", story } : undefined,
  // Its start: a story leaves « no status » (to any status) only when no open deferred
  // item locks it. Its review: its branch still holds its frozen intent, read under
  // the journal's lock.
  check: async ({ story, status }, state, { context }) => {
    if ((storyIn(state, story)?.status ?? null) === null) {
      const locked = storyLockProblem(state, story, "start");
      if (locked !== undefined) return locked;
    }
    if (status !== "in_review") return undefined;
    return reviewProblem(context, state, story);
  },
});

/**
 * What stops a story going to review, read under the journal's lock: its branch no longer holds the
 * intent the creator approved (not asked when the creator skipped the story's contract),
 * or an acceptance criterion has no test seen failing then passing and is not declared
 * untestable.
 */
async function reviewProblem(
  context: CommandContext,
  state: ProjectionState["state"],
  story: string,
): Promise<AgentPluggedError | undefined> {
  if (!isSkipped(state, "story_contract", story)) {
    const intent = branchIntentProblem(await readBranchIntent(context, state, story));
    if (intent !== undefined) return intent;
  }
  const left = await instrumentationProblem(context, state, story);
  if (left !== undefined) return left;
  return criteriaProblem(context, state, story);
}

export const submitResultCommand = agentEventCommand({
  name: "submit_result",
  description:
    "Always end your run with it: how it ended (complete, partial or blocked), a short summary the creator can read (800 characters at most: what is done, what is proven, what remains, what you expect from them, starting with the outcome; the long account goes in story.progress notes and the pull request), and the lists of your assumptions, open questions and conflicts (empty lists when there are none; each item 400 characters at most, 10 items at most). The summary never hides a failure: a partial or blocked result says so first. A blocked result opens a checkpoint on its story (or reuses the one your last blocked result opened there, while it is open), unlike report_status or update_story `blocked`. A complete result is refused with CHECKPOINT_OPEN while an open checkpoint blocks completing the story; without a story, while any open checkpoint blocks completing a story. Your complete result on a story you started (start_story) and that is in_progress also moves it to in_review, recorded in the same write: it is then refused with CHECKPOINT_OPEN while an open checkpoint blocks its review, and with STORY_INTENT_CHANGED while the last commit of its branch no longer holds the intent the creator approved.",
  inputSchema: SubmitResultInputSchema,
  needsState: ({ status, story }) =>
    status === "blocked" || (status === "complete" && story !== undefined),
  // The move to review is decided from the journal as it is when written.
  replanned: true,
  events: ({ agent, story, status, summary, assumptions, open_questions, conflicts }, state) => {
    const result: EventSpec = {
      type: AGENT_EVENT_TYPES.resultRecorded,
      story,
      payload: { status, summary, assumptions, open_questions, conflicts },
    };
    // The builder's complete result moves its story to review, explicitly.
    if (story !== undefined && resultMovesToReview(storyIn(state ?? {}, story), agent, status)) {
      return {
        events: [
          result,
          {
            type: AGENT_EVENT_TYPES.storyStatusChanged,
            story,
            payload: { status: "in_review" },
          },
        ],
      };
    }
    if (status !== "blocked") return { events: [result] };
    // The checkpoint this agent's last blocked result opened on the story, while still open.
    const reused = openBlockedResultCheckpoint(
      Object.values(checkpointsOf(state ?? {})),
      agent,
      story,
    );
    if (reused !== undefined) return { events: [result], checkpoint: reused.id };
    // Else a checkpoint in the same write: the story waits for the creator.
    return {
      events: [
        result,
        {
          type: CHECKPOINT_EVENT_TYPES.opened,
          story,
          payload: blockedResultCheckpoint(agent, story, { summary, open_questions }),
        },
      ],
    };
  },
  action: ({ story, status }) =>
    status === "complete" ? { action: "story.complete", story } : undefined,
  // The end of an agent's run is when the engine reads what its session consumed.
  after: async (context, _input, target) => {
    await measureProduct(context, target);
  },
  // Moving to review: what update_story `in_review` checks, on the journal and the
  // story's branch as they are when written.
  check: async ({ agent, story, status }, state, { now, context }) => {
    if (story === undefined || !resultMovesToReview(storyIn(state, story), agent, status)) {
      return undefined;
    }
    const blocking = blockingCheckpoint(
      Object.values(checkpointsOf(state)),
      "story.review",
      story,
      now,
    );
    if (blocking !== undefined) return checkpointOpen(blocking.id, "story.review");
    return reviewProblem(context, state, story);
  },
});

/**
 * Why `agent` may not open the end of `phase` now, or undefined: only an active agent of
 * `PHASE_CLOSERS[phase]` closes it (`AGENT_NOT_CLOSER`; the main session only when none of them
 * is active), and only while it is the current phase without an end already open
 * (`PHASE_NOT_CURRENT`: `not_current`, `none_current`, `already_open`).
 */
function phaseEndProblem(
  agent: string,
  phase: PhaseId,
  state: ProjectionState["state"],
  config: MethodConfig,
  now: number,
  agents: ReadonlySet<string>,
  documents: readonly { readonly path: string; readonly blob_sha: string }[],
  workingCopy: DesignWorkingCopy | undefined,
): AgentPluggedError | undefined {
  const closers = PHASE_CLOSERS[phase];
  const activeClosers = closers.filter((closer) => agents.has(closer));
  const allowed =
    activeClosers.includes(agent) || (agent === MAIN_SESSION_AGENT && activeClosers.length === 0);
  if (!allowed) {
    return new AgentPluggedError(ErrorCode.AGENT_NOT_CLOSER, "error.agent_not_closer", {
      agent,
      phase,
      closers: activeClosers.length === 0 ? [MAIN_SESSION_AGENT] : activeClosers,
    });
  }
  const progress = phaseProgress(
    Object.values(checkpointsOf(state)),
    activePhases(config.profile, skippedPhases(state)),
    now,
  );
  if (progress.current === null) {
    return new AgentPluggedError(ErrorCode.PHASE_NOT_CURRENT, "error.phase_none_current", {
      phase,
      current: null,
      reason: "none_current",
    });
  }
  if (progress.current !== phase) {
    return new AgentPluggedError(ErrorCode.PHASE_NOT_CURRENT, "error.phase_not_current", {
      phase,
      current: progress.current,
      reason: "not_current",
    });
  }
  if (progress.open !== null) {
    return new AgentPluggedError(ErrorCode.PHASE_NOT_CURRENT, "error.phase_end_already_open", {
      phase,
      current: progress.current,
      checkpoint: progress.open.id,
      reason: "already_open",
    });
  }
  // A structuring document of this phase still waits for the creator: they answer
  // that point first, then the end of the phase opens.
  const waiting = openDocumentReview(
    Object.values(checkpointsOf(state)).filter(
      (point) => !reasonHolds(state, point, "step_skipped"),
    ),
    progress.since,
    now,
  );
  if (waiting !== undefined) {
    return new AgentPluggedError(ErrorCode.DOCUMENT_REVIEW_OPEN, "error.document_review_open", {
      phase,
      checkpoint: waiting.id,
    });
  }
  // The end of the design carries Chloé's security review, while she is active, unless
  // the creator skipped it, or the architecture it reviews.
  if (
    phase === "design" &&
    !isSkipped(state, "architecture_security") &&
    !isSkipped(state, "architecture")
  ) {
    const gap = designSecurityReviewGap({
      active: agents,
      agents: (state.agents as Record<string, AgentState> | undefined) ?? {},
      since: progress.since,
      documents,
      ...(workingCopy === undefined ? {} : { workingCopy }),
    });
    if (gap !== undefined) {
      return new AgentPluggedError(
        ErrorCode.SECURITY_REVIEW_MISSING,
        `error.security_review_${gap}`,
        {
          phase,
          reason: gap,
          agent: SECURITY_REVIEWER,
          document: ARCHITECTURE_SECURITY_REVIEW_PATH,
          architecture: ARCHITECTURE_PATH,
        },
      );
    }
  }
  return undefined;
}

/** What `open_checkpoint` reads of the working copy before the write. */
interface OpenPrepared {
  /** The review and the architecture of the working copy, for the end of the design. */
  readonly design?: DesignWorkingCopy;
  /** The requirements the documents say, for a release point. */
  readonly registry?: RequirementEntry[];
  /** The product's folder, to write an absolute path of a file of the product as a relative one. */
  readonly root?: string;
}

export const openCheckpointCommand = agentEventCommand<
  typeof OpenCheckpointInputSchema,
  OpenPrepared
>({
  name: "open_checkpoint",
  description:
    "Ask for a decision: open a checkpoint (document, decision, story, permission, release, publication or phase_end) with its risk, a title, a summary, the documents to read (cite each file in `documents`, by its path from the product root; never an absolute path in any text) and the actions it blocks until the creator answers. A blocked action targets its own `story`, else the checkpoint's. story.review and story.complete are enforced; the other actions are recorded. A decision needs 2 to 4 options and the id of the one you recommend. Give a `card`, what the creator reads first, in plain words and without jargon: `effect` (one or two sentences, 300 characters at most, on what changes for the people who use the product, before anything about the code), `risks` (up to 3 sentences, only the real ones) and `opinions` (up to 4: `agent` and one sentence `view` of the agents you consulted, such as the review or the security check), and `why` (`reason`: one sentence on why you propose this; `rejected`: one sentence on the alternative you set aside and why; 200 characters each); the `summary` keeps the detail. Criteria are judged on report_measures. Returns the checkpoint id (G-…). A checkpoint the creator refused or sent back for changes keeps its blocks: address it, then open a new one with `supersedes` set to the refused one's id (same story; a document has none); once the creator approves the new one, both stop blocking. A phase_end checkpoint closes the current phase (`phase`, from get_state): no story, no blocks; only the agent that closes that phase opens it (AGENT_NOT_CLOSER); refused with PHASE_NOT_CURRENT, while the phase's end is already open, and with DOCUMENT_REVIEW_OPEN while a structuring `document` checkpoint of the phase still waits. Every document an end of phase cites is committed first (DOCUMENT_NOT_COMMITTED); while Chloé is active, the end of design cites the architecture and her security review (SECURITY_REVIEW_MISSING). The constitution gives the rules. Only the creator, or the agent responsible for a point they did not keep (decide_checkpoint), resolves a checkpoint. A `publication` checkpoint presents a deliverable of launch, marketing or sales: it needs `publication` (`angle`, `audience`, `short_version`: 80 words at most, one paragraph) and 1 to 20 `documents` (the full text under `.agentplugged/docs/`, at their current blob); no options, no criteria; it replaces a sent-back one only with `supersedes` set to a `publication` you produced. Nothing publishes, sends or pays. Then call next: it says whether to decide the point (step point_decision), ask the creator (ask_creator when `validation.channels.available` holds more than chat) or go on with other work.",
  inputSchema: OpenCheckpointInputSchema,
  needsState: ({ type }) => type === "story" || type === "release",
  events: ({ agent: _agent, story, ...given }, state, prepared) => {
    const fields = relativizeCheckpointText(given, prepared?.root);
    // A `story` point on a story nobody started, citing its file, validates the file: a
    // `document` point, which is what makes it startable. As a `story` point it ended the story.
    const retyped =
      fields.type === "story" &&
      neverStarted(state, story) &&
      citesStoryFile(fields.documents ?? []);
    const opened: EventSpec = {
      type: CHECKPOINT_EVENT_TYPES.opened,
      story,
      payload: { ...checkpointPayload(retyped ? { ...fields, type: "document" } : fields) },
    };
    // A release point first brings the register of requirements up to date with the
    // documents, so that its gate reads what they say now.
    const registry = prepared?.registry;
    if (
      fields.type === "release" &&
      registry !== undefined &&
      state !== undefined &&
      !sameRegistry(registry, state)
    ) {
      return {
        events: [
          { type: REQUIREMENT_EVENT_TYPES.registered, payload: { items: registry } },
          opened,
        ],
        own: 1,
      };
    }
    return { events: [opened] };
  },
  // The end of the design reads the review and the architecture of the working copy;
  // a release reads the requirements of the documents.
  prepare: async ({ type, phase }, context, agents): Promise<OpenPrepared> => {
    const root = context.projectRoot === undefined ? {} : { root: context.projectRoot };
    if (type === "release") return { ...root, registry: await readRegistry(context.files) };
    if (type !== "phase_end" || phase !== "design" || !agents.has(SECURITY_REVIEWER)) {
      return root;
    }
    const workingCopy: DesignWorkingCopy = {
      review: await readWorkingBytes(context.files, ARCHITECTURE_SECURITY_REVIEW_PATH),
      architecture: await readWorkingBytes(context.files, ARCHITECTURE_PATH),
    };
    return { ...root, design: workingCopy };
  },
  check: async (
    { agent, supersedes, story, type, phase, documents, publication, title },
    state,
    { config, now, agents, prepared, context },
  ) => {
    // A deliverable: its full text is the file cited, byte for byte.
    if (type === "publication") {
      const unusable = await publicationOpenProblem(
        { documents, publication, title },
        context.files,
      );
      if (unusable !== undefined) return unusable;
    }
    if (type === "phase_end" && phase !== undefined) {
      const refused = phaseEndProblem(
        agent,
        phase,
        state,
        config,
        now,
        agents,
        documents ?? [],
        prepared?.design,
      );
      if (refused !== undefined) return refused;
      // Every document the end of a phase cites is committed on its branch first.
      const missing = await uncommittedDocuments(documents ?? [], context.docsBase);
      if (missing.length > 0) {
        return new AgentPluggedError(
          ErrorCode.DOCUMENT_NOT_COMMITTED,
          "error.document_not_committed",
          { phase, documents: missing.join(", "), count: missing.length },
        );
      }
    }
    if (supersedes === undefined) return undefined;
    const known = checkpointsOf(state);
    if (!Object.hasOwn(known, supersedes)) {
      return new AgentPluggedError(ErrorCode.CHECKPOINT_NOT_FOUND, "error.checkpoint_not_found", {
        checkpoint: supersedes,
      });
    }
    const superseded = known[supersedes] as CheckpointState;
    const decision = superseded.resolution?.decision;
    const refused =
      superseded.status === "resolved" &&
      decision !== undefined &&
      !LIFTING_DECISIONS.has(decision) &&
      !superseded.blocks_lifted;
    // A deliverable replaces a deliverable the same agent produced, and only one:
    // otherwise a replacement could silence the creator's instruction or lift another point's blocks.
    const crossed =
      (type === "publication" || superseded.type === "publication") &&
      (type !== superseded.type || superseded.opened_by !== agent);
    if (superseded.story !== (story ?? null) || !refused || crossed) {
      return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
        command: "open_checkpoint",
        field: "supersedes",
        reason: `open_checkpoint: supersedes: ${supersedes} is not a checkpoint of the same story the creator refused (rejected or changes_requested)`,
      });
    }
    return undefined;
  },
});

/** True when the journal holds no start of the story `id`. */
function neverStarted(
  state: Readonly<Record<string, unknown>> | undefined,
  id: string | undefined,
) {
  if (id === undefined) return false;
  const stories = (state?.stories as Record<string, StoryState> | undefined) ?? {};
  return (
    !Object.hasOwn(stories, id) ||
    (stories[id]?.started === undefined && stories[id]?.status_by == null)
  );
}

function invalidMeasures(reason: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
    command: "report_measures",
    field: "measures",
    reason: `report_measures: measures: ${reason}`,
  });
}

export const reportMeasuresCommand = agentEventCommand({
  name: "report_measures",
  description:
    "Report measures for the criteria of an open checkpoint, `{ <metric>: number }` (for example tests_failed or coverage), only metrics its criteria name: each metric keeps its last value, who reported it and when, and get_state shows the verdict (pass, pass_with_reservations or fail; a missing measure fails).",
  inputSchema: ReportMeasuresInputSchema,
  events: ({ checkpoint, measures }) => ({
    events: [
      {
        type: CHECKPOINT_EVENT_TYPES.measured,
        payload: { checkpoint, measures: { ...measures } },
      },
    ],
  }),
  check: ({ checkpoint, measures }, state) => {
    const known = checkpointsOf(state);
    if (!Object.hasOwn(known, checkpoint)) {
      return new AgentPluggedError(ErrorCode.CHECKPOINT_NOT_FOUND, "error.checkpoint_not_found", {
        checkpoint,
      });
    }
    const target = known[checkpoint] as CheckpointState;
    if (target.status !== "open") {
      return new AgentPluggedError(ErrorCode.CHECKPOINT_NOT_OPEN, "error.checkpoint_not_open", {
        checkpoint,
        status: target.status,
      });
    }
    if (target.criteria === null) return invalidMeasures(`${checkpoint} has no criteria`);
    const metrics = new Set(target.criteria.map((criterion) => criterion.metric));
    const unknown = Object.keys(measures).filter((metric) => !metrics.has(metric));
    if (unknown.length > 0) {
      return invalidMeasures(`no criterion of ${checkpoint} measures ${unknown.join(", ")}`);
    }
    return undefined;
  },
});

/** What `plan_sprint` reads of the working copy before the write: its stories, by id. */
interface SprintWorkingCopy {
  readonly stories: ReadonlyMap<string, SprintStory>;
}

const storiesOfCopy = (prepared: SprintWorkingCopy | undefined): ReadonlyMap<string, SprintStory> =>
  prepared?.stories ?? new Map<string, SprintStory>();

/**
 * `SPRINT_INVALID`: every rule the proposed sprint breaks (`problems`), how many (`count`) and a
 * readable line for the first one (`first`, preferring one that names a story).
 */
function sprintInvalid(problems: readonly SprintProblem[]): AgentPluggedError {
  return new AgentPluggedError(
    ErrorCode.SPRINT_INVALID,
    problems.length === 1 ? "error.sprint_invalid.one" : "error.sprint_invalid.other",
    {
      count: problems.length,
      first: firstSprintProblem(problems),
      problems: problems.map((problem) => ({ ...problem })),
    },
  );
}

export const planSprintCommand = agentEventCommand({
  name: "plan_sprint",
  description:
    "Propose a sprint to the creator: a one-line goal (at most 112 characters, so that the checkpoint's title holds it whole), the stories in the order they will be built, the capacity that builds them (`agents`: the active agents who will work on them; `humans`: how many people), an optional budget ceiling in US dollars, and a summary of your reasons and risks. The engine estimates nothing: it reads the stories of `.agentplugged/stories/` and refuses the sprint with SPRINT_INVALID, nothing written, when a story is unknown or unreadable, fails `docs check` (`invalid_story`), was never validated or changed since its validation (`not_validated`: an approved `document` checkpoint must list the file at its current content), or is already done; when a dependency is neither done nor earlier in the sprint; when an agent of the capacity is not active, the capacity is empty, or a story's owner is not in it (`creator` needs a human); when the total of the stories' `budget_usd` exceeds the ceiling or $1,000,000; when your summary does not fit next to the generated lines of the checkpoint (`too_long`, with the room left in `max`), or the stories alone do not; or while your last proposal still waits for the creator. Otherwise it writes, in one go, a `document` checkpoint that shows the sprint to the creator (your summary, then each story with its owner and budget, the total, the ceiling and the capacity, never cut) and the sprint itself, and returns both ids (`sprint`: S-…, `checkpoint`: G-…). The sprint is in force once the creator approves that checkpoint; a sprint approved later replaces it. When the creator asks for changes, address their note and call plan_sprint again.",
  inputSchema: PlanSprintInputSchema,
  // The guard of the estimates reads the measured history, which the key decrypts.
  needsState: () => true,
  keyed: true,
  prepare: async (_input, context): Promise<SprintWorkingCopy> => ({
    stories: await readSprintStories(context.files),
  }),
  events: ({ goal, stories, capacity, budget_limit_usd, summary }, _state, prepared) => {
    const documents = storiesOfCopy(prepared);
    const budget = sprintBudget(stories, documents);
    const generated = sprintGeneratedLines({
      stories,
      documents,
      capacity,
      budget_usd: budget,
      budget_limit_usd,
    });
    // Nothing is cut: `check` refuses (`too_long`) what the checkpoint cannot hold whole.
    return {
      own: 1,
      events: [
        {
          type: CHECKPOINT_EVENT_TYPES.opened,
          payload: {
            ...checkpointPayload({
              type: "document",
              risk: "medium",
              title: `${SPRINT_TITLE_PREFIX}${goal}`,
              summary: sprintCheckpointSummary(summary, generated),
            }),
          },
        },
        {
          type: SPRINT_EVENT_TYPES.planned,
          payload: defined({
            goal,
            stories: sprintEntries(stories, documents),
            capacity: { agents: [...capacity.agents], humans: capacity.humans },
            budget_usd: budget,
            budget_limit_usd,
          }),
          checkpointField: "checkpoint",
        },
      ],
    };
  },
  check: ({ stories, capacity, budget_limit_usd, summary }, state, { now, agents, prepared }) => {
    const documents = storiesOfCopy(prepared);
    const checkpoints = checkpointsOf(state);
    const all = Object.values(checkpoints);
    const known = (state.stories as Record<string, StoryState> | undefined) ?? {};
    const ids = new Set([
      ...documents.keys(),
      ...stories,
      ...[...documents.values()].flatMap((story) => story.depends_on),
    ]);
    const done = new Set(
      [...ids].filter(
        (id) =>
          storyDoneAt(all, id, Object.hasOwn(known, id) ? known[id] : undefined) !== undefined,
      ),
    );
    const sprints = sprintsOf(state);
    const estimates = estimatesOf(
      finishedStories(
        (state.stories as Record<string, StoryState> | undefined) ?? {},
        usageSessionsOf(state),
      ),
    );
    const latest = latestSprint(sprints);
    const openProposal =
      latest !== undefined && sprintStatus(latest, sprints, checkpoints, now) === "proposed"
        ? latest.checkpoint
        : undefined;
    const { problems: found } = checkSprint({
      stories,
      capacity,
      budget_limit_usd,
      summary,
      documents,
      validation: validationOf(documents, all, now),
      done,
      agents,
      openProposal,
      budgetRange: estimates.guard,
    });
    // What the creator skipped is no refusal: a story whose contract they skipped may be
    // planned invalid or not validated, and the order of the stories is theirs to set aside.
    const problems = found.filter(
      (problem) =>
        !(
          problem.story !== undefined &&
          (((problem.reason === "invalid_story" || problem.reason === "not_validated") &&
            isSkipped(state, "story_contract", problem.story)) ||
            ((problem.reason === "dependency_missing" || problem.reason === "dependency_later") &&
              isSkipped(state, "story_order", problem.story)))
        ),
    );
    return problems.length === 0 ? undefined : sprintInvalid(problems);
  },
});

/** The open questions and conflicts of the last results, stories first, in id order. */
function openPoints(
  agents: Readonly<Record<string, AgentState>>,
  stories: Readonly<Record<string, StoryState>>,
): OpenPoint[] {
  const results: ResultEntry[] = [];
  for (const id of Object.keys(stories).sort()) {
    const byAgent = stories[id]?.results ?? {};
    for (const agent of Object.keys(byAgent).sort()) {
      const result = byAgent[agent];
      if (result) results.push(result);
    }
  }
  for (const id of Object.keys(agents).sort()) {
    const result = agents[id]?.last_result;
    if (result && result.story === null) results.push(result);
  }
  return results.flatMap((result) => [
    ...result.open_questions.map((text) => ({
      kind: "question" as const,
      text,
      agent: result.agent,
      story: result.story,
    })),
    ...result.conflicts.map((text) => ({
      kind: "conflict" as const,
      text,
      agent: result.agent,
      story: result.story,
    })),
  ]);
}

/** `INVALID_ARGUMENTS` for an option of `get_state` that names nothing the product knows. */
function unknownOption(option: string, id: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
    command: "get_state",
    field: option,
    reason: `get_state: ${option}: unknown ${id}`,
  });
}

/**
 * `get_state`: the state of the product computed from the journal, read only (nothing is written,
 * not even the cache). It answers abridged: under 50 000 characters whatever the
 * history, with `truncated` for what was cut; an option reads one part in full.
 */
export const getStateCommand = defineCommand<GetStateResult>({
  name: "get_state",
  audience: "agent",
  description:
    "Read the state of the product computed from the journal, as a short summary (a few thousand characters): the clock (`clock`: show every time in the creator's local time zone, never in UTC), the phase, each agent in one line (status, task, story; `CAN RESUME` when it waits for a point already settled), the stories not merged yet in one line (status, progress, what they wait on, CI), the open checkpoints in one line (id, type, title), counts of open questions, deferred work and deviations, the sprint in force, `git`, `journey`, `installs`, `usage.estimates`, `merged_order` (the latest merges), `validation` (the level; `unpublished`: the local main branch holds commits not published, which apply anyway: offer to publish them with request_creator_action `forge_push_main`; `channels`: the ways the creator can click an answer; `points`: who decides each kind of point) and the warnings; also `update_available`, `engine_update` (a newer engine to propose once: request_creator_action `engine_update`), `engine_updated` (say it once) and `journal_backup`. For the detail pass ONE option, never two, and there is no `detail` option: `agent` (an id: its status, its whole last result), `story` (an id: all of it, with its checkpoints, deferred work, deviations), `checkpoint` (a G-… id: in full, with the creator's note), `checkpoints` ({status, type, story, limit, before}: a page, newest first), `delegations` ({limit, before}: Noah's handovers), or `full: true` (the whole abridged state: the sprints in full, every merged story, the deferred work and the deviations in full, the latest installs, the external reads). Never start the work of a later phase: the next phase begins once the creator approves the current phase's phase_end checkpoint.",
  inputSchema: GetStateInputSchema,
  // It says that the session must move to the version the product pins.
  allowsOlderEngine: () => true,
  async run(context, input) {
    const parsed = GetStateInputSchema.safeParse(input);
    if (!parsed.success) return fail(invalidInput("get_state", parsed.error));
    const { files, journal } = context;
    if (!(await files.exists(METHOD_CONFIG_PATH))) return fail(methodNotInstalled());
    const loaded = await loadMethodConfig(files);
    if (loaded instanceof AgentPluggedError) return fail(loaded);
    if (journal === undefined) return fail(unavailableJournal());
    try {
      // What the creator did on the forge is recorded before the state is read.
      await (await import("../merge/forge-follow.js")).followForge(context);
      const listing = await journal.list();
      const { projection, warnings } = await projectWithKey(context, loaded.config, listing);
      const trust = await sessionTrust(context, loaded.config, listing.events);
      const state = projection.state;
      // Plain objects again: the projection's dictionaries have no prototype.
      const agents = { ...((state.agents as Record<string, AgentState> | undefined) ?? {}) };
      const stories = Object.fromEntries(
        Object.entries((state.stories as Record<string, StoryState> | undefined) ?? {}).map(
          ([id, story]) => {
            // A review shows its counts only: its findings go through get_review.
            const review = reviewSummaryOf(story);
            return [
              id,
              (review === undefined ? story : { ...story, review }) as unknown as StoryState,
            ];
          },
        ),
      );
      // Waivers expire by the clock, at read time: shown open again, the stories waiting again.
      const now = (context.now ?? Date.now)();
      const checkpoints = Object.fromEntries(
        Object.entries(checkpointsOf(state)).map(([id, checkpoint]) => [
          id,
          {
            ...checkpoint,
            status: statusAt(checkpoint, now),
            measures: { ...checkpoint.measures },
          },
        ]),
      );
      for (const checkpoint of Object.values(checkpointsOf(state))) {
        if (!waiverExpired(checkpoint, now)) continue;
        for (const block of checkpoint.blocks) {
          const scope = blockScope(block, checkpoint.story);
          const story = scope === undefined ? undefined : stories[scope];
          if (story === undefined || story.waiting_on.includes(checkpoint.id)) continue;
          stories[scope as string] = { ...story, waiting_on: [...story.waiting_on, checkpoint.id] };
        }
      }
      const sprints = sprintsOf(state);
      const sprintContext = {
        sprints,
        checkpoints: checkpointsOf(state),
        stories: (state.stories as Record<string, StoryState> | undefined) ?? {},
        now,
      };
      const current = currentSprint(sprints, sprintContext.checkpoints, now);
      const latest = latestSprint(sprints);
      const full: FullStateView = {
        clock: clockView(now),
        product: projection.product,
        journal_head: projection.journal_head,
        agents,
        instances: (state.instances as Record<string, InstanceState> | undefined) ?? {},
        stories,
        checkpoints,
        open_points: openPoints(agents, stories),
        warnings,
        phase: phaseView(checkpointsOf(state), loaded.config, now, skippedPhases(state)),
        journey: journeyView(state),
        git: gitView(state, now, { forge: await repositoryOnForge(context) }),
        session: {
          trusted: trust.trusted,
          reads: trust.reads.map((read) => ({ ...read })),
        },
        external_reads: externalReadsView(state),
        sprint: {
          current: current === undefined ? null : sprintView(current, sprintContext),
          latest: latest === undefined ? null : sprintView(latest, sprintContext),
        },
        deferred: deferredView(state),
        deviations: deviationView(state),
        ...(requirementsView(state) === undefined
          ? {}
          : { requirements: requirementsView(state) as RequirementsView }),
        ...(critiqueView(state) === undefined
          ? {}
          : { critique: critiqueView(state) as CritiqueView }),
        ...(courseView(state) === undefined ? {} : { course: courseView(state) as CourseView }),
        usage: usageView({
          state,
          stories: (state.stories as Record<string, StoryState> | undefined) ?? {},
        }),
        validation: await validationView(context, loaded.config, Object.values(checkpoints)),
        stacks: stacksView(state, now),
        installs: await installsView(context, loaded.config, state),
        delegations: delegationsOf(state).map((entry) => ({ ...entry })),
      };
      // An option reads one part in full; without one, the abridged state.
      const cursor = parsed.data.checkpoints?.before;
      if (cursor !== undefined && !Object.hasOwn(full.checkpoints, cursor)) {
        return fail(unknownOption("checkpoints.before", cursor));
      }
      const handover = parsed.data.delegations?.before;
      if (handover !== undefined && !full.delegations.some((entry) => entry.id === handover)) {
        return fail(unknownOption("delegations.before", handover));
      }
      const detail = stateDetail(full, parsed.data);
      if (detail === undefined) {
        const update = await engineUpdateOf(context);
        const available = await updateAvailableOf(context, async () => state);
        const updated = await engineUpdatedOf(context);
        // Said only while the journal is not saved; a blocked one is told once.
        const backup = await context.journalBackup
          ?.report({ consume: true })
          .catch(() => undefined);
        // Codex or Cursor with no message ever recorded: the hooks were not approved.
        const untrusted = await hooksUntrustedOf(context);
        const view = parsed.data.full === true ? fitState(full) : summarizeState(full);
        const extra = {
          ...(untrusted === undefined ? {} : { hooks_untrusted: untrusted }),
          // The engine that answers (the session moves between versions between two calls).
          engine_version: context.engineVersion,
          ...(update === undefined ? {} : { engine_update: update }),
          ...(available === undefined ? {} : { update_available: available }),
          ...(updated === undefined ? {} : { engine_updated: updated }),
          ...(backup === undefined ? {} : { journal_backup: backup }),
        };
        return ok({ ...view, ...extra } as typeof view);
      }
      if (!detail.found) return fail(unknownOption(detail.option, detail.id));
      return ok(detail.value);
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    }
  },
});

/** The external reads of the journal, for `get_state`: the latest ones, oldest first. */
function externalReadsView(state: ProjectionState["state"]): FullStateView["external_reads"] {
  const reads = (state.external_reads as ExternalReadEntry[] | undefined) ?? [];
  return {
    total: reads.length,
    recent: reads
      .slice(-EXTERNAL_READS_SHOWN)
      .map(({ tool, source, agent, at }) => ({ tool, source, agent, at })),
  };
}

/** The latest external reads `get_state` shows. */
const EXTERNAL_READS_SHOWN = 20;

/** The stacks with a point still waiting, for `get_state`. */
function stacksView(state: ProjectionState["state"], now: number): AgentStackView[] {
  const checkpoints = checkpointsOf(state);
  return Object.values(stacksOf(state))
    .map((stack) => ({
      id: stack.id,
      opened_by: stack.opened_by,
      opened_at: stack.opened_at,
      remaining: stack.items
        .filter(
          (item) =>
            item.answer === null &&
            Object.hasOwn(checkpoints, item.checkpoint) &&
            answerable(checkpoints[item.checkpoint] as CheckpointState, now),
        )
        .map((item) => ({ n: item.n, checkpoint: item.checkpoint })),
      total: stack.items.length,
    }))
    .filter((stack) => stack.remaining.length > 0);
}

/** The installs mode, what the architecture declares and the latest installations. */
async function installsView(
  context: CommandContext,
  config: MethodConfig,
  state: ProjectionState["state"],
): Promise<AgentInstallsView> {
  const settings = await resolveInstallSettings(config, context.mainBranch);
  const declared = await plannedDependencies(context, state);
  return {
    mode: settings.mode,
    source: settings.source,
    warning: settings.warning,
    declared: Object.fromEntries(
      Object.entries(declared ?? {}).map(([ecosystem, names]) => [ecosystem, names.length]),
    ),
    recent: installsOf(state).slice(-INSTALLS_SHOWN),
  };
}

/**
 * The validation level for `get_state`: the open checkpoints only `review` answers
 * are the high risks at the `strict` level, and only them (the chat answers any other
 * point, with the hook's proof or as `chat_unverified`).
 */
async function validationView(
  context: CommandContext,
  config: MethodConfig,
  checkpoints: readonly CheckpointState[],
): Promise<AgentValidationView> {
  const settings = await resolveValidationSettings(config, context.mainBranch);
  const hooked = context.chat?.hooked === true || isHookedClient(chatClientOf(context));
  const channels = await decisionChannels(context);
  const review = checkpoints
    .filter(
      (checkpoint) =>
        checkpoint.status === "open" && settings.mode === "strict" && checkpoint.risk === "high",
    )
    .map((checkpoint) => checkpoint.id);
  return {
    mode: settings.mode,
    source: settings.source,
    warning: settings.warning,
    unpublished: settings.unpublished,
    proof: hooked ? "hook" : "unverified",
    review,
    elicitation: channels.available.includes("elicitation"),
    channels,
    points: pointsView(settings.points),
  };
}

/** The commands reserved to agents, exposed one for one as MCP tools. */
export const agentActivityCommands: ReadonlyArray<Command> = [
  reportStatusCommand,
  reportProgressCommand,
  reportCostCommand,
  updateStoryCommand,
  submitResultCommand,
  openCheckpointCommand,
  reportMeasuresCommand,
  getStateCommand,
];
