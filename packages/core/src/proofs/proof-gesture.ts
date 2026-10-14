import {
  type AcceptedProofCommand,
  type CreatorAction,
  type CreatorActionRecord,
  ErrorCode,
  MAX_PROOF_COMMANDS_PER_REQUEST,
} from "@agentplugged/protocol";
import type { CommandContext } from "../command.js";
import {
  creatorActionSummary,
  MAX_CHECKPOINT_SUMMARY,
} from "../creator-actions/creator-action-rules.js";
import { currentState } from "../deferred/deferred-commands.js";
import { AgentPluggedError } from "../errors.js";
import { commandsToAccept, proofDecisions, proofRequestOpen } from "./proof-accord.js";
import { acceptedForm, PROOFS_PATH, readProofDeclaration } from "./proof-declaration.js";
import { proofCommandLine } from "./proof-gesture-text.js";

/**
 * The request for the accord to the project's proof commands, as `request_creator_action`
 * records it. The agent names the commands (or none: every new or modified one) and what the creator
 * demands; the lines come from `.agentplugged/proofs.yaml`, read by the engine now, and are what the
 * creator reads. As many commands as the checkpoint's summary can show whole are asked at once: a
 * line is never cut, and the rest is asked next.
 */

type ProofCommandsAction = Extract<CreatorAction, { kind: "proof_commands" }>;
type ProofCommandsRecord = Extract<CreatorActionRecord, { kind: "proof_commands" }>;

function invalid(field: string, reason: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
    command: "request_creator_action",
    field: `action.${field}`,
    reason: `request_creator_action: action.${field}: ${reason}`,
  });
}

function unchanged(): AgentPluggedError {
  return new AgentPluggedError(
    ErrorCode.CREATOR_ACTION_UNCHANGED,
    "error.creator_action_unchanged",
    { kind: "proof_commands" },
  );
}

/**
 * The record of the request, or the error that says why there is nothing to ask: no declaration,
 * a name the file does not hold, a request already open, nothing new or modified (unchanged).
 */
export async function proofCommandsRecordOf(
  context: CommandContext,
  action: ProofCommandsAction,
  reason: string,
): Promise<ProofCommandsRecord | AgentPluggedError> {
  const declaration = await readProofDeclaration(context.files);
  if (declaration.kind === "invalid") {
    return invalid("commands", `${PROOFS_PATH} is not valid: ${declaration.problems.join("; ")}`);
  }
  const declared = declaration.kind === "commands" ? declaration.commands : [];
  const state = await currentState(context);
  const open = proofRequestOpen(state);
  if (open !== undefined) {
    return invalid("commands", `proof_request_open:${open.id} (wait for the creator's answer)`);
  }
  const decisions = proofDecisions(state);
  // The demand alone (`require` without `commands`) asks for no line.
  const { commands, unknown } =
    action.commands === undefined && action.require !== undefined
      ? { commands: [], unknown: [] }
      : commandsToAccept(declared, decisions, action.commands);
  if (unknown.length > 0) {
    return invalid(
      "commands",
      `not declared in ${PROOFS_PATH}: ${unknown.join(", ")} (declared: ${declared.map((command) => command.name).join(", ") || "none"})`,
    );
  }
  const demandChanged = action.require !== undefined && action.require !== decisions.require;
  if (commands.length === 0 && !demandChanged) {
    if (action.commands === undefined && action.require === undefined && declared.length === 0) {
      return invalid("commands", `no command declared: write ${PROOFS_PATH} first`);
    }
    return unchanged();
  }
  // As many lines as the summary shows whole.
  const demand = demandChanged && action.require !== undefined ? { require: action.require } : {};
  const chosen: AcceptedProofCommand[] = [];
  for (const command of commands.slice(0, MAX_PROOF_COMMANDS_PER_REQUEST)) {
    const candidate: ProofCommandsRecord = {
      kind: "proof_commands",
      commands: [...chosen, acceptedForm(command)],
      ...demand,
      reason,
    };
    if (creatorActionSummary(candidate).length > MAX_CHECKPOINT_SUMMARY) break;
    chosen.push(acceptedForm(command));
  }
  if (commands.length > 0 && chosen.length === 0) {
    return invalid("commands", "the line is too long to be shown whole to the creator");
  }
  return {
    kind: "proof_commands",
    ...(chosen.length === 0 ? {} : { commands: chosen }),
    ...demand,
    reason,
  };
}

/**
 * What the answer to a request adds: the lines the creator reads (`preview`, to show as they are)
 * and how many declared commands did not fit and are asked next (`later`).
 */
export async function proofCommandsAsked(
  context: CommandContext,
  record: ProofCommandsRecord,
): Promise<{ preview?: string; later?: number }> {
  const declaration = await readProofDeclaration(context.files);
  const decisions = proofDecisions(await currentState(context));
  const asked = new Set((record.commands ?? []).map((command) => command.name));
  const later =
    declaration.kind === "commands"
      ? commandsToAccept(declaration.commands, decisions, undefined).commands.filter(
          (command) => !asked.has(command.name),
        ).length
      : 0;
  const lines = (record.commands ?? []).map(proofCommandLine);
  return {
    ...(lines.length === 0 ? {} : { preview: lines.join("\n") }),
    ...(later === 0 ? {} : { later }),
  };
}
