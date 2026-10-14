import { type CommandContext, type CommandResult, fail, ok } from "../command.js";
import {
  type ActionExecuted,
  afterExecution,
} from "../creator-actions/creator-action-execution.js";
import { AgentPluggedError } from "../errors.js";
import {
  afterMerge,
  type MergeDone,
  type MergeResult,
  takePendingMerge,
} from "../merge/story-merge.js";

/**
 * What the commands that record a creator's answer (the chat's, the form's, an agent's decision)
 * do around the write: take back the merge this call alone did at the forge, then finish what the
 * answer set going.
 */

/**
 * Runs `run` with a token of its own: the merge it did at the forge for `checkpoint` is taken back
 * once it ended (recorded with the write, or said not recorded), never one another call did.
 */
export async function withPendingMerge<T>(
  context: CommandContext,
  checkpoint: unknown,
  run: (context: CommandContext) => Promise<T>,
): Promise<{ readonly result: T; readonly merge: MergeDone | undefined }> {
  const token = Symbol("merge");
  let result: T;
  let merge: MergeDone | undefined;
  try {
    result = await run({ ...context, mergeToken: token });
  } finally {
    merge =
      typeof checkpoint === "string"
        ? takePendingMerge(checkpoint.trim().toUpperCase(), token)
        : undefined;
  }
  return { result, merge };
}

/**
 * The answer recorded, once the engine did what it set going: the merge of a story,
 * else the action of the creator it carries out. A refusal of the action is the
 * command's.
 */
export async function finishAnswer<T extends object>(
  context: CommandContext,
  recorded: T,
  merge: MergeDone | undefined,
  carried:
    | { readonly checkpoint: string; readonly action: Parameters<typeof afterExecution>[2] }
    | undefined,
): Promise<CommandResult<T | (T & { merged: MergeResult }) | (T & { executed: ActionExecuted })>> {
  if (merge !== undefined) return ok({ ...recorded, merged: await afterMerge(context, merge) });
  if (carried === undefined) return ok(recorded);
  try {
    const executed = await afterExecution(context, carried.checkpoint, carried.action);
    if (executed instanceof AgentPluggedError) return fail(executed);
    return ok({ ...recorded, executed });
  } catch (error) {
    if (error instanceof AgentPluggedError) return fail(error);
    throw error;
  }
}
