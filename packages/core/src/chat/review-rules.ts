import { ErrorCode } from "@agentplugged/protocol";
import { terminalCommand } from "../creator-actions/creator-action-rules.js";
import { AgentPluggedError } from "../errors.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";

/**
 * The refusals every channel of the creator's answer shares: the
 * `REVIEW_REQUIRED` that sends the creator to the terminal.
 */

const REVIEW = "npx agentplugged review";

export function error(
  code: string,
  key: string,
  details: Record<string, unknown>,
): AgentPluggedError {
  return new AgentPluggedError(code as ErrorCode, key, details);
}

/**
 * `REVIEW_REQUIRED`: only the terminal answers this checkpoint. A creator's action
 * also gives the terminal command it stands for (`terminal_command`).
 */
export function reviewRequired(checkpoint: CheckpointState, reason: string): AgentPluggedError {
  const record = checkpoint.creator_action ?? undefined;
  return error(
    ErrorCode.REVIEW_REQUIRED,
    `error.review_required.${reason}${record === undefined ? "" : "_action"}`,
    {
      checkpoint: checkpoint.id,
      reason,
      command: `${REVIEW} ${checkpoint.id}`,
      ...(record === undefined ? {} : { terminal_command: terminalCommand(record) }),
    },
  );
}
