import { type CreatorAction, type CreatorActionRecord, ErrorCode } from "@agentplugged/protocol";
import type { CommandContext } from "../command.js";
import { readDoctorCatalog } from "../doctor/catalog.js";
import { diagnoseFailure } from "../doctor/diagnose.js";
import { isAutomatic, type PlannedFix, runFix } from "../doctor/fixes.js";
import { type DoctorItem, runDoctor } from "../doctor/report.js";
import { AgentPluggedError, unexpected } from "../errors.js";
import { actionFailed } from "./creator-action-files.js";
import { notReserved } from "./creator-action-rules.js";

/**
 * The creator's yes to the repair of a point of the machine. The request carries the
 * identifier of a check only; the engine reads its catalogue for the command that repairs it on
 * this machine (the package manager that is really there), records it in the request so the
 * creator reads it, and checks at the approval that it is still exactly that one. It then runs that
 * command, reads the check again and says what it found. Only a repair that needs no terminal, no
 * browser and no typed answer is asked this way; the others are guided in steps. The engine never
 * reads nor writes a login token.
 */

type EnvironmentAction = Extract<CreatorAction, { kind: "environment_fix" }>;
type EnvironmentRecord = Extract<CreatorActionRecord, { kind: "environment_fix" }>;

/** What the approved repair did. */
export interface EnvironmentFixDone {
  readonly check: string;
  /** The commands the engine ran, as shown in the request. */
  readonly ran: string;
  /** The check, read again after the repair. */
  readonly before: "warn" | "fail";
  readonly after: "ok" | "warn" | "fail" | "unknown";
  /** What the check says now, in English. */
  readonly now: string;
  /** The tail of what the command printed. */
  readonly output: string;
}

function unchanged(check: string, checkpoint?: string): AgentPluggedError {
  return new AgentPluggedError(
    ErrorCode.CREATOR_ACTION_UNCHANGED,
    "error.creator_action_unchanged",
    { kind: "environment_fix", check, ...(checkpoint === undefined ? {} : { checkpoint }) },
  );
}

/** What a request or an approval reads of the check, and the repair the engine would run now. */
async function planned(
  context: CommandContext,
  check: string,
): Promise<{ item: DoctorItem; fix: PlannedFix } | AgentPluggedError> {
  const report = await runDoctor(context, { only: [check] });
  if (report instanceof AgentPluggedError) return report;
  const item = report.items[0];
  if (item === undefined) {
    return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
      command: "request_creator_action",
      field: "action.check",
      reason: `request_creator_action: action.check: no check ${check} applies here (check_environment lists them)`,
    });
  }
  if (item.status === "ok") return unchanged(check);
  // Not for the engine to run: it needs the terminal or gives steps only.
  if (item.fix === undefined || !isAutomatic(item.fix)) {
    return notReserved("environment_fix", "not_automatic", { check });
  }
  return { item, fix: item.fix };
}

/** The command as one line, the way the request and the record show it. */
function oneLine(fix: PlannedFix): string {
  return fix.display.split("\n").join(" && ");
}

/**
 * The action as it will be recorded: the exact command the engine reads now. A check that is
 * already fine is `CREATOR_ACTION_UNCHANGED`; one the engine cannot repair by itself is
 * `CREATOR_ACTION_NOT_RESERVED` (`not_automatic`), and the agent gives the steps instead.
 */
export async function environmentFixRecordOf(
  context: CommandContext,
  action: EnvironmentAction,
  reason: string,
): Promise<EnvironmentRecord | AgentPluggedError> {
  if (context.environment === undefined) return unexpected("the machine cannot be repaired here");
  const plan = await planned(context, action.check);
  if (plan instanceof AgentPluggedError) return plan;
  return { kind: "environment_fix", check: action.check, command: oneLine(plan.fix), reason };
}

/** `CREATOR_ACTION_STALE`: the repair is no longer the one the creator saw. */
function stale(checkpoint: string, record: EnvironmentRecord, now: string): AgentPluggedError {
  return new AgentPluggedError(
    ErrorCode.CREATOR_ACTION_STALE,
    "error.creator_action_stale.environment_moved",
    {
      checkpoint,
      kind: record.kind,
      reason: "environment_moved",
      check: record.check,
      command: record.command,
      now,
    },
  );
}

/**
 * What the approval checks outside the journal, before it is written: the check still needs the
 * repair (else nothing to carry out) and the repair is still exactly the command the creator read.
 */
export async function environmentFixProblem(
  context: CommandContext,
  checkpoint: string,
  record: EnvironmentRecord,
): Promise<AgentPluggedError | undefined> {
  if (context.environment === undefined) return unexpected("the machine cannot be repaired here");
  const plan = await planned(context, record.check);
  if (plan instanceof AgentPluggedError) {
    return plan.code === ErrorCode.CREATOR_ACTION_UNCHANGED
      ? unchanged(record.check, checkpoint)
      : plan;
  }
  const now = oneLine(plan.fix);
  return now === record.command ? undefined : stale(checkpoint, record, now);
}

/**
 * Carries out an approved repair: the command the engine reads again (and that must still be the
 * recorded one), run with its output captured, then the check read again. A command that fails is
 * `CREATOR_ACTION_FAILED` with its output; the approval stays recorded.
 */
export async function carryOutEnvironmentFix(
  context: CommandContext,
  checkpoint: string,
  record: EnvironmentRecord,
): Promise<EnvironmentFixDone | AgentPluggedError> {
  const probe = context.environment;
  if (probe === undefined) return actionFailed(checkpoint, record, "not_available");
  const plan = await planned(context, record.check);
  if (plan instanceof AgentPluggedError) return actionFailed(checkpoint, record, plan);
  if (oneLine(plan.fix) !== record.command)
    return actionFailed(checkpoint, record, "command_moved");
  const ran = await runFix(probe, plan.fix.commands, "captured");
  if (ran.status !== 0) {
    const why = ran.missing
      ? "the program could not be started"
      : ran.timedOut
        ? "it took too long"
        : `it exited with ${ran.status ?? "no code"}`;
    // What the machine shows about this failure, apart from what is only supposed.
    const catalog = await readDoctorCatalog(context.method);
    const cause =
      catalog instanceof AgentPluggedError
        ? undefined
        : await diagnoseFailure(context, catalog, {
            ...(ran.status === null ? {} : { exit_code: ran.status }),
            ...(ran.output === "" ? {} : { output: ran.output }),
          });
    const verified =
      cause === undefined || cause.cause === "unknown" ? "" : ` ${cause.headline.en}`;
    return actionFailed(
      checkpoint,
      record,
      "repair_failed",
      `${why}. ${ran.output}${verified}`.trim(),
    );
  }
  const again = await runDoctor(context, { only: [record.check] });
  const item = again instanceof AgentPluggedError ? undefined : again.items[0];
  return {
    check: record.check,
    ran: ran.ran,
    before: plan.item.status as "warn" | "fail",
    after: item?.status ?? "unknown",
    now: item?.text.en ?? "",
    output: ran.output,
  };
}
