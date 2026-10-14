import { type CreatorAction, type CreatorActionRecord, ErrorCode } from "@agentplugged/protocol";
import type { CommandContext } from "../command.js";
import { type EngineUpdateSettings, engineTargetOf, installAndPin } from "../engine-update.js";
import { AgentPluggedError } from "../errors.js";
import { actionFailed } from "./creator-action-files.js";

/**
 * The creator's yes to an engine update: installing the newer version the engine
 * announced in its own folder and bringing the product to it, and the two settings of the machine
 * (asking the registry, installing without asking). The engine reads the version itself (the
 * product's pin when it is ahead of this session, else the registry's announcement) and records it
 * in the action; the approval is checked against it again, and nothing is installed but that exact
 * version of the package `agentplugged`, from the registry the machine's npm is configured with.
 */

type EngineUpdateAction = Extract<CreatorAction, { kind: "engine_update" }>;
type EngineUpdateRecord = Extract<CreatorActionRecord, { kind: "engine_update" }>;

/** What the approved update did. */
export interface EngineUpdateDone {
  /** The version installed in its own folder (the session moves to it at its next call). */
  readonly installed?: string;
  /** `updated`: the product pins it now; `already`: it did. */
  readonly product?: "updated" | "already";
  /** The settings of the machine after the change. */
  readonly settings?: EngineUpdateSettings;
}

/** `CREATOR_ACTION_UNCHANGED`: no newer version to install, settings already so. */
function unchanged(kind: string, checkpoint?: string): AgentPluggedError {
  return new AgentPluggedError(
    ErrorCode.CREATOR_ACTION_UNCHANGED,
    "error.creator_action_unchanged",
    { kind, ...(checkpoint === undefined ? {} : { checkpoint }) },
  );
}

/** `CREATOR_ACTION_STALE`: the version is not the one the creator saw. */
function stale(
  checkpoint: string,
  version: string,
  current: string | undefined,
): AgentPluggedError {
  return new AgentPluggedError(
    ErrorCode.CREATOR_ACTION_STALE,
    "error.creator_action_stale.engine_moved",
    {
      checkpoint,
      kind: "engine_update",
      reason: "engine_moved",
      version,
      current: current ?? "none",
    },
  );
}

function notAvailable(): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
    reason: "the engine's updates are not available here",
  });
}

/**
 * The action as it will be recorded: an installation carries the version the engine reads now; an
 * action that would change nothing (no newer version, settings already so) is
 * `CREATOR_ACTION_UNCHANGED`.
 */
export async function engineUpdateRecordOf(
  context: CommandContext,
  action: EngineUpdateAction,
  reason: string,
): Promise<EngineUpdateRecord | AgentPluggedError> {
  const updates = context.engineUpdates;
  if (updates === undefined) return notAvailable();
  const settings = await updates.settings();
  const changes =
    (action.check !== undefined && action.check !== settings.check) ||
    (action.auto !== undefined && action.auto !== settings.auto);
  const version = action.install === true ? (await engineTargetOf(context))?.version : undefined;
  // Nothing to install and no setting to change: it is already so.
  if (version === undefined && !changes) return unchanged(action.kind);
  return {
    kind: "engine_update",
    ...(version === undefined ? {} : { install: true as const, version }),
    ...(action.check === undefined ? {} : { check: action.check }),
    ...(action.auto === undefined ? {} : { auto: action.auto }),
    reason,
  };
}

/**
 * What the approval checks outside the journal, before it is written: an installation is still of
 * the version the engine reads (`CREATOR_ACTION_STALE` `engine_moved` otherwise), and settings are
 * still a change. Undefined when it can be carried out.
 */
export async function engineUpdateProblem(
  context: CommandContext,
  checkpoint: string,
  record: EngineUpdateRecord,
): Promise<AgentPluggedError | undefined> {
  if (context.engineUpdates === undefined) return notAvailable();
  if (record.install === true) {
    const target = await engineTargetOf(context);
    if (target === undefined || target.version !== record.version) {
      return stale(checkpoint, record.version ?? "", target?.version);
    }
  }
  return undefined;
}

/**
 * Carries out an approved update: the settings first (a creator who turns the automatic updates on
 * and asks for this one gets both), then the installation of the version in its own folder, then the
 * product's move to it. A failure is `CREATOR_ACTION_FAILED` with the reason; the approval stays
 * recorded, and what was done (a version installed) is found again on the next request.
 */
export async function carryOutEngineUpdate(
  context: CommandContext,
  checkpoint: string,
  record: EngineUpdateRecord,
): Promise<EngineUpdateDone | AgentPluggedError> {
  const updates = context.engineUpdates;
  if (updates === undefined) return actionFailed(checkpoint, record, "not_available");
  const done: { -readonly [K in keyof EngineUpdateDone]: EngineUpdateDone[K] } = {};
  if (record.check !== undefined || record.auto !== undefined) {
    try {
      done.settings = await updates.saveSettings({
        ...(record.check === undefined ? {} : { check: record.check }),
        ...(record.auto === undefined ? {} : { auto: record.auto }),
      });
    } catch (error) {
      return actionFailed(checkpoint, record, "settings_not_saved", errorText(error));
    }
  }
  if (record.install !== true) return done;
  const version = record.version;
  if (version === undefined) return actionFailed(checkpoint, record, "version_not_newer");
  const moved = await installAndPin(context, version);
  if (!moved.ok) return actionFailed(checkpoint, record, moved.reason, moved.message);
  return { ...done, installed: version, product: moved.product };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
