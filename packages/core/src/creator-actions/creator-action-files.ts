import {
  type CreatorActionRecord,
  ErrorCode,
  FILE_CREATOR_ACTIONS,
  FORGE_CREATOR_ACTIONS,
  REQUIRED_CONTENT_FIELDS,
} from "@agentplugged/protocol";
import { type AgentCommandResult, agentCommand } from "../agents/agent-command.js";
import type { CommandContext, CommandResult } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { recordGitWorkflow, type WorkflowRecorded } from "../git/record-workflow.js";
import { type ProfileResult, profileCommand } from "../profile/profile-command.js";
import { syncCommand } from "../sync/sync-command.js";
import type { WorkspaceFiles } from "../workspace-files.js";
import { DryRunFiles } from "./dry-run-files.js";

/**
 * The creator's actions that change files: `profile` and `agent create|edit|enable|
 * disable`, carried out by the very commands of the terminal, never by code of their own. Tried
 * first on `DryRunFiles` (the request, then the approval), then run on the product's files once
 * the approval is recorded, followed by `sync`.
 */

/** What a file action changed: the files written, or nothing (`changed: false`). */
export interface FileOutcome {
  readonly changed: boolean;
  readonly paths: readonly string[];
  /** A `profile` that carried the Git workflow: what the engine records in the journal. */
  readonly workflow?: {
    readonly workflow: NonNullable<ProfileResult["workflow"]>["workflow"];
    readonly previous: NonNullable<ProfileResult["workflow"]>["previous"];
  };
}

/** True for an action carried out on files, not in the journal. */
export function isFileAction(record: CreatorActionRecord): boolean {
  return FILE_CREATOR_ACTIONS.has(record.kind);
}

/** The terminal command's input for a file action. */
function commandInput(record: CreatorActionRecord): Readonly<Record<string, unknown>> {
  const defined = (entries: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));
  switch (record.kind) {
    case "profile":
      return defined({
        profile: record.profile,
        validation: record.validation,
        installs: record.installs,
        points: record.points,
        workflow: record.workflow,
      });
    case "agent_create":
      return defined({
        action: "create",
        kind: record.definition,
        id: record.id,
        name: record.name,
        title: record.title,
        description: record.description,
        domain: record.domain,
        phase: record.phase,
        icon: record.icon,
        role: record.role,
        content: record.content,
      });
    case "agent_edit":
      return defined({
        action: "edit",
        id: record.id,
        tier: record.tier,
        tool: record.tool,
        content: record.content,
        layer: record.layer,
      });
    case "agent_enable":
      return { action: "enable", id: record.id };
    case "agent_disable":
      return { action: "disable", id: record.id };
    default:
      throw new Error(`creator action ${record.kind} changes no file`);
  }
}

/** Whether the command's result changed anything. */
function changedBy(result: ProfileResult | AgentCommandResult): boolean {
  if ("previous" in result) return result.action === "updated";
  switch (result.action) {
    case "create":
      return true;
    case "edit":
      return (result.settings ?? result.content)?.status === "updated";
    default:
      return result.status === "updated";
  }
}

/**
 * `INVALID_ARGUMENTS` for a creation without the complete definition: a request of the
 * old form, or one that forgot it. The message says what to add. A skeleton is only written by the
 * terminal's `agent create`, never by a request.
 */
export function contentProblem(record: CreatorActionRecord): AgentPluggedError | undefined {
  if (record.kind !== "agent_create" || record.content !== undefined) return undefined;
  const kind = record.definition === "skill" ? "skill" : "agent";
  return new AgentPluggedError(
    ErrorCode.INVALID_ARGUMENTS,
    "error.creator_action.content_required",
    {
      kind,
      id: record.id,
      missing: REQUIRED_CONTENT_FIELDS[kind].map((field) => `content.${field}`).join(", "),
    },
  );
}

/**
 * Runs the terminal command of a file action on `files`, once the creator asked for it (its own
 * checks: `METHOD_CONFIG_INVALID`, `AGENT_EXISTS`, `AGENT_NOT_FOUND`, `INVALID_ARGUMENTS`…).
 */
async function runOn(
  context: CommandContext,
  record: CreatorActionRecord,
  files: WorkspaceFiles,
): Promise<FileOutcome | AgentPluggedError> {
  // The command itself, unchanged; the actor stays the surface's (the creator approved it).
  const own: CommandContext = { ...context, files };
  // A request carries the complete definition: no skeleton is ever written for it.
  const missing = contentProblem(record);
  if (missing !== undefined) return missing;
  const input = commandInput(record);
  const result: CommandResult<ProfileResult | AgentCommandResult> =
    record.kind === "profile"
      ? await profileCommand.run(own, input)
      : await agentCommand.run(own, input);
  if (!result.ok) return result.error;
  const paths = "paths" in result.value ? [...result.value.paths] : [".agentplugged/method.yaml"];
  const given = "workflow" in result.value ? result.value.workflow : undefined;
  return {
    changed: changedBy(result.value),
    paths,
    ...(given?.given === true
      ? { workflow: { workflow: given.workflow, previous: given.previous } }
      : {}),
  };
}

/** The file action tried without writing anything: what it would change, or why it cannot. */
export async function dryRunFileAction(
  context: CommandContext,
  record: CreatorActionRecord,
): Promise<FileOutcome | AgentPluggedError> {
  const files = new DryRunFiles(context.files);
  let outcome: FileOutcome | AgentPluggedError;
  try {
    outcome = await runOn(context, record, files);
  } catch (error) {
    if (error instanceof AgentPluggedError) return error;
    return new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  if (outcome instanceof AgentPluggedError) return outcome;
  return { changed: outcome.changed && files.written.length > 0, paths: files.written };
}

/** What carrying out a file action did: the files written and the `sync` that followed. */
export interface FileExecution {
  readonly changed: boolean;
  readonly paths: readonly string[];
  /** The Git workflow recorded in the journal, and what it means for the work in progress. */
  readonly workflow?: WorkflowRecorded;
  /** `sync` ran (`done`), or failed with this code (the files stay written). */
  readonly sync: "done" | "skipped" | { readonly code: string };
}

/** `CREATOR_ACTION_FAILED`: the approval is recorded, the files could not be written. */
export function actionFailed(
  checkpoint: string,
  record: CreatorActionRecord,
  cause: AgentPluggedError | string,
  /** The tool's own words (the install's output), when the cause is a word of ours. */
  words?: string,
): AgentPluggedError {
  // A gesture of the forge fails for a reason of its own (`FORGE_GESTURE_FAILED`): it is
  // said, and the creator asks again; there is no terminal command to type.
  const forge = FORGE_CREATOR_ACTIONS.has(record.kind);
  const inner =
    forge && typeof cause !== "string" && typeof cause.details.reason === "string"
      ? cause.details.reason
      : undefined;
  const message =
    forge && typeof cause !== "string" && typeof cause.details.message === "string"
      ? cause.details.message
      : words;
  // The engine's update fails for a reason of its own, said in its own message: once the
  // version is installed, what can still fail is the move of the product (a format to migrate).
  const engine = record.kind === "engine_update";
  const product = engine && cause === "product_update_failed";
  const environment = record.kind === "environment_fix";
  return new AgentPluggedError(
    ErrorCode.CREATOR_ACTION_FAILED,
    forge
      ? "error.creator_action_failed.forge"
      : product
        ? "error.creator_action_failed.engine_product"
        : engine
          ? "error.creator_action_failed.engine"
          : environment
            ? "error.creator_action_failed.environment"
            : "error.creator_action_failed",
    {
      checkpoint,
      kind: record.kind,
      reason: inner ?? (typeof cause === "string" ? cause : cause.code),
      ...(engine && record.version !== undefined ? { version: record.version } : {}),
      ...(message === undefined ? {} : { message }),
      // The command's own error, whole, for the surfaces to say it.
      ...(typeof cause === "string" ? {} : { cause: cause.toPayload() }),
    },
  );
}

/**
 * Carries out an approved file action on the product's files, by the terminal command, then runs
 * `sync` so the AI tools see it (`skipped` when nothing changed). A failure of the command is
 * `CREATOR_ACTION_FAILED` (the approval stays recorded; the creator asks again once the cause is fixed).
 */
export async function applyFileAction(
  context: CommandContext,
  checkpoint: string,
  record: CreatorActionRecord,
): Promise<FileExecution | AgentPluggedError> {
  let outcome: FileOutcome | AgentPluggedError;
  try {
    outcome = await runOn(context, record, context.files);
  } catch (error) {
    return actionFailed(checkpoint, record, error instanceof Error ? error.message : String(error));
  }
  if (outcome instanceof AgentPluggedError) {
    return actionFailed(checkpoint, record, outcome);
  }
  // The creator's Git workflow is recorded in the journal, where the engine reads it.
  let recorded: WorkflowRecorded | undefined;
  if (outcome.workflow !== undefined) {
    const written = await recordGitWorkflow(context, outcome.workflow, "chat").catch(
      (error: unknown) => (error instanceof AgentPluggedError ? error : undefined),
    );
    if (written instanceof AgentPluggedError) return actionFailed(checkpoint, record, written);
    recorded = written;
  }
  const { workflow: _given, ...done } = outcome;
  const result = { ...done, ...(recorded === undefined ? {} : { workflow: recorded }) };
  if (!outcome.changed) return { ...result, sync: "skipped" };
  try {
    const synced = await syncCommand.run(context, {});
    return { ...result, sync: synced.ok ? "done" : { code: synced.error.code } };
  } catch (error) {
    return {
      ...result,
      sync: { code: error instanceof AgentPluggedError ? error.code : "UNEXPECTED" },
    };
  }
}
