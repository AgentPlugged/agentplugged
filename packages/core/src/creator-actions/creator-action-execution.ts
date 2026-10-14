import {
  type CheckpointRisk,
  CREATOR_ACTION_EVENT_TYPES,
  type CreatorActionRecord,
  type CreatorActionSource,
  ErrorCode,
  resolveGitWorkflow,
  VALIDATION_POINTS,
  type ValidationMode,
  type ValidationPoint,
} from "@agentplugged/protocol";
import { canonicalJson } from "../chat/decision-prompt.js";
import { resolveValidationSettings } from "../chat/validation-settings.js";
import { branchHead, journalProblem } from "../ci/ci-check.js";
import type { CommandContext } from "../command.js";
import { currentState } from "../deferred/deferred-commands.js";
import { findItem } from "../deferred/deferred-rules.js";
import { AgentPluggedError } from "../errors.js";
import { workflowOf } from "../git/git-workflow.js";
import { recordGitRelease } from "../git/record-workflow.js";
import { loadMethodConfig } from "../init/method-config.js";
import type { StoryState } from "../projection/agent-reducers.js";
import { storyIn } from "../projection/agent-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { commitHookFiles, traceSkipsOf } from "../stories/commit-hook.js";
import { loadDefinitions } from "../sync/sync-command.js";
import {
  actionFailed,
  applyFileAction,
  dryRunFileAction,
  type FileExecution,
  isFileAction,
} from "./creator-action-files.js";
import { actionRisk, actionStory, journalActionProblem } from "./creator-action-rules.js";
import {
  carryOutEngineUpdate,
  type EngineUpdateDone,
  engineUpdateProblem,
} from "./engine-update-gesture.js";
import {
  carryOutEnvironmentFix,
  type EnvironmentFixDone,
  environmentFixProblem,
} from "./environment-fix-gesture.js";
import {
  carryOutForgeGesture,
  forgeGestureCheck,
  type GestureDone,
  isForgeAction,
} from "./forge-gestures.js";

/**
 * Carrying out an approved creator's action: what is checked again before the
 * approval is written (the state under the journal lock, the branch and the files before it), the
 * event that carries it out (`creator_action.executed`, in the same write as the approval), and
 * the files written afterwards.
 */

/** `CREATOR_ACTION_STALE`: the target moved since the request; nothing is written. */
function stale(checkpoint: string, record: CreatorActionRecord, reason: string, extra = {}) {
  return new AgentPluggedError(
    ErrorCode.CREATOR_ACTION_STALE,
    `error.creator_action_stale.${reason}`,
    { checkpoint, kind: record.kind, reason, ...extra },
  );
}

/**
 * What the approval checks outside the journal, before it is written: a CI waiver covers the head
 * of the story's branch read at the request (`CREATOR_ACTION_STALE` `head_moved` once another
 * commit is there); a file action still passes its command on `DryRunFiles`. Undefined when it
 * can be carried out.
 */
export async function executionProblem(
  context: CommandContext,
  state: Readonly<Record<string, unknown>>,
  checkpoint: string,
  record: CreatorActionRecord,
): Promise<AgentPluggedError | undefined> {
  if (record.kind === "ci_waive") {
    const problem = journalProblem(state, record.story);
    if (problem !== undefined) return problem;
    const workspace = context.storyWorkspace;
    if (workspace === undefined) {
      return new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
        reason: "no Git workspace is available here",
      });
    }
    const started = (storyIn(state, record.story) as StoryState).started as NonNullable<
      StoryState["started"]
    >;
    const head = await branchHead(workspace, record.story, started.branch);
    if (head instanceof AgentPluggedError) return head;
    if (head !== record.commit) {
      return stale(checkpoint, record, "head_moved", { commit: record.commit, head });
    }
    return undefined;
  }
  if (isFileAction(record)) {
    const outcome = await dryRunFileAction(context, record);
    if (outcome instanceof AgentPluggedError) return outcome;
    // Already so (another request, the terminal): nothing to carry out; it can still be refused.
    if (!outcome.changed) return actionUnchanged(record, checkpoint);
  }
  if (record.kind === "engine_update") {
    // The version is still the one the engine reads, or nothing is installed.
    return await engineUpdateProblem(context, checkpoint, record);
  }
  if (record.kind === "environment_fix") {
    // The check still needs the repair, and the command is still the one the creator read.
    return await environmentFixProblem(context, checkpoint, record);
  }
  if (isForgeAction(record)) {
    // The repository still allows the gesture, and the commit and the repository the
    // request named are still the ones; already done is nothing to carry out.
    const checked = await forgeGestureCheck(context, checkpoint, record);
    if (checked instanceof AgentPluggedError) return checked;
    if (checked.already) return actionUnchanged(record, checkpoint);
  }
  return undefined;
}

/** `CREATOR_ACTION_UNCHANGED`: the action would change nothing; nothing is written. */
export function actionUnchanged(
  record: CreatorActionRecord,
  checkpoint?: string,
): AgentPluggedError {
  return new AgentPluggedError(
    ErrorCode.CREATOR_ACTION_UNCHANGED,
    "error.creator_action_unchanged",
    {
      kind: record.kind,
      ...(checkpoint === undefined ? {} : { checkpoint }),
    },
  );
}

const RISKS: readonly CheckpointRisk[] = ["low", "medium", "high"];

/** The higher of two risks. */
export function higherRisk(a: CheckpointRisk, b: CheckpointRisk): CheckpointRisk {
  return RISKS.indexOf(a) >= RISKS.indexOf(b) ? a : b;
}

/** Words that say an item of deferred work is about security, once normalised. */
const SECURITY_WORDS = /secur|sécu|vulnerab|vulnérab|\bcve\b|exploit|password|mot de passe|secret/;

/** The domain of the agent `id` among the product's definitions; `unreadable` when they are not. */
async function domainOf(
  context: CommandContext,
  id: string,
): Promise<string | undefined | "unreadable"> {
  const definitions = await loadDefinitions(context.files);
  if (definitions instanceof AgentPluggedError) return "unreadable";
  const found = definitions.find((definition) => definition.name === id);
  return (found?.frontmatter.metadata as Record<string, string> | undefined)?.domain;
}

/**
 * The risk of an action in the product as it is now (`actionRisk`): the validation levels in
 * force (main branch) and of the working copy for a profile; whether it weakens security work (an
 * item about security dropped, the security domain turned off, a security agent disabled). Read
 * at the request and again at the approval: the higher one counts, so a level raised since the
 * request still sends a lowering to the terminal at `strict`.
 */
export async function currentRisk(
  context: CommandContext,
  state: Readonly<Record<string, unknown>>,
  record: CreatorActionRecord,
): Promise<CheckpointRisk> {
  let levels: ValidationMode[] | undefined;
  let points: ValidationPoint[][] | undefined;
  let security = false;
  let workflowLoosened = false;
  if (record.kind === "profile") {
    // A workflow that takes a check of the merge away (the CI, the review, the pull
    // request) is a lowering like a lower validation level.
    if (record.workflow !== undefined) {
      const now = workflowOf(state).resolved;
      const asked = resolveGitWorkflow(record.workflow);
      workflowLoosened =
        (now.ci !== "none" && asked.ci === "none") ||
        (now.review && !asked.review) ||
        (now.merge === "pr" && asked.merge === "direct");
    }
    const loaded = await loadMethodConfig(context.files);
    if (loaded instanceof AgentPluggedError) return "high";
    const inForce = await resolveValidationSettings(loaded.config, context.mainBranch);
    levels = [inForce.mode, loaded.config.validation?.mode ?? inForce.mode];
    // The points the creator keeps, in force and in the working copy.
    const every: ValidationPoint[] = [...VALIDATION_POINTS];
    points = [
      [...(inForce.points ?? every)],
      [...(loaded.config.validation?.points ?? inForce.points ?? every)],
    ];
    const before = loaded.config.profile?.domains ?? [];
    security =
      record.profile !== undefined &&
      before.includes("security") &&
      !record.profile.domains.includes("security");
  } else if (record.kind === "deferred_drop") {
    const item = findItem(state, record.item);
    if (item instanceof AgentPluggedError) return "high";
    const words = `${item.title} ${item.detail ?? ""}`.normalize("NFC").toLowerCase();
    const domain = await domainOf(context, item.recorded_by);
    security = SECURITY_WORDS.test(words) || domain === "security" || domain === "unreadable";
  } else if (record.kind === "agent_disable") {
    const domain = await domainOf(context, record.id);
    security = domain === "security" || domain === "unreadable";
  }
  return actionRisk(record, {
    security,
    ...(workflowLoosened ? { workflowLoosened } : {}),
    ...(levels === undefined ? {} : { levels }),
    ...(points === undefined ? {} : { points }),
  });
}

/** What the journal checks again under its lock: the item, the deviation, the story. */
export function executionStateProblem(
  record: CreatorActionRecord,
  state: Readonly<Record<string, unknown>>,
): AgentPluggedError | undefined {
  return journalActionProblem(record, state);
}

/** The `creator_action.executed` that carries the action out, right after its approval. */
export function executionEvent(
  checkpoint: string,
  record: CreatorActionRecord,
  source: CreatorActionSource,
  quote?: string,
): {
  readonly type: string;
  readonly story: string | undefined;
  readonly payload: Record<string, unknown>;
} {
  return {
    type: CREATOR_ACTION_EVENT_TYPES.executed,
    story: actionStory(record),
    payload: {
      checkpoint,
      action: JSON.parse(JSON.stringify(record)) as CreatorActionRecord,
      source,
      ...(quote === undefined ? {} : { quote }),
    },
  };
}

/**
 * What an approval carried out: the action, for a file action its files and `sync`, for a gesture
 * of the forge what it did.
 */
export interface ActionExecuted {
  readonly checkpoint: string;
  readonly kind: string;
  readonly files?: FileExecution;
  readonly gesture?: GestureDone;
  /** What the engine's update did. */
  readonly engine?: EngineUpdateDone;
  /** What the repair of the machine did, and what the check says now. */
  readonly environment?: EnvironmentFixDone;
}

/** A value as JSON with its keys sorted: two records compared whatever their keys' order. */
function canonical(value: unknown): string {
  return canonicalJson(JSON.parse(JSON.stringify(value)));
}

/**
 * True when the journal, as the projection reads it now, holds the approval of the request and the
 * execution of exactly its action: the checkpoint resolved `approved`, its `executed` set, the
 * action recorded as asked. A gesture of the forge is done only on that proof: an approval or an
 * execution the projection refused (a forged event, a clock apart) does nothing at the forge.
 */
async function executionAccepted(
  context: CommandContext,
  checkpoint: string,
  record: CreatorActionRecord,
): Promise<boolean> {
  const state = await currentState(context);
  const found = (state.checkpoints as Record<string, CheckpointState> | undefined)?.[checkpoint];
  return (
    found !== undefined &&
    found.type === "creator_action" &&
    found.status === "resolved" &&
    found.resolution?.decision === "approved" &&
    (found.executed ?? null) !== null &&
    canonical(found.creator_action) === canonical(record)
  );
}

/**
 * What the commit hook reads of what the creator skipped: once the creator skips or
 * takes up the PRD, the planning phase or the traceability, the hook of the stories already started
 * is told (best effort: the hook of a story to come is told when it starts).
 */
async function refreshCommitSkips(
  context: CommandContext,
  record: CreatorActionRecord,
): Promise<void> {
  if (record.kind !== "step_skip" && record.kind !== "step_resume") return;
  if (record.step !== "prd" && record.step !== "phase_planning" && record.step !== "story_trace") {
    return;
  }
  const workspace = context.storyWorkspace;
  if (workspace === undefined) return;
  try {
    const state = await currentState(context);
    const stories = (state.stories as Record<string, StoryState> | undefined) ?? {};
    if (!Object.values(stories).some((story) => story.started !== undefined)) return;
    await workspace.installCommitHook(commitHookFiles(undefined, traceSkipsOf(state) ?? []));
  } catch {
    // The hook is not told: its next refresh, or the next story's start, will.
  }
}

/**
 * After the approval and its `creator_action.executed` are written: a file action is carried out
 * on the product's files (`applyFileAction`); a gesture of the forge is done by the
 * engine, but only once the projection holds the approval and the execution; a journal action
 * already took effect.
 */
export async function afterExecution(
  context: CommandContext,
  checkpoint: string,
  record: CreatorActionRecord,
): Promise<ActionExecuted | AgentPluggedError> {
  if (record.kind === "engine_update") {
    // Only on the projection's proof of the approval, like a gesture of the forge.
    if (!(await executionAccepted(context, checkpoint, record))) {
      return actionFailed(checkpoint, record, "not_accepted");
    }
    const engine = await carryOutEngineUpdate(context, checkpoint, record);
    if (engine instanceof AgentPluggedError) return engine;
    return { checkpoint, kind: record.kind, engine };
  }
  if (record.kind === "environment_fix") {
    // Only on the projection's proof of the approval, like a gesture of the forge.
    if (!(await executionAccepted(context, checkpoint, record))) {
      return actionFailed(checkpoint, record, "not_accepted");
    }
    const environment = await carryOutEnvironmentFix(context, checkpoint, record);
    if (environment instanceof AgentPluggedError) return environment;
    return { checkpoint, kind: record.kind, environment };
  }
  if (isForgeAction(record)) {
    if (!(await executionAccepted(context, checkpoint, record))) {
      return actionFailed(checkpoint, record, "not_accepted");
    }
    const gesture = await carryOutForgeGesture(context, checkpoint, record);
    if (gesture instanceof AgentPluggedError) return actionFailed(checkpoint, record, gesture);
    // Staging went into production: the journal says so, once the gesture succeeded.
    if (record.kind === "release") {
      const recorded = await recordGitRelease(context, checkpoint, record, gesture).catch(
        (error: unknown) => (error instanceof AgentPluggedError ? error : undefined),
      );
      if (recorded instanceof AgentPluggedError) {
        return actionFailed(checkpoint, record, recorded);
      }
    }
    return { checkpoint, kind: record.kind, gesture };
  }
  if (!isFileAction(record)) {
    await refreshCommitSkips(context, record);
    return { checkpoint, kind: record.kind };
  }
  const files = await applyFileAction(context, checkpoint, record);
  if (files instanceof AgentPluggedError) return files;
  return { checkpoint, kind: record.kind, files };
}
