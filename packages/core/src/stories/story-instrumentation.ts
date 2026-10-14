import type { ProjectionState } from "@agentplugged/protocol";
import type { CommandContext } from "../command.js";
import type { AgentPluggedError } from "../errors.js";
import { instrumentedFiles } from "../merge/story-files.js";
import { storyIn } from "../projection/agent-reducers.js";
import { invalid } from "../requirements/requirement-commands.js";

/**
 * The gate before the review for the temporary code a diagnosis leaves: a log or a
 * probe written to find a bug's cause carries the marker `agentplugged:debug` in a comment, and the
 * story does not go to review while a line the branch added still carries it. The engine reads the
 * story's own diff at the commit the working copy is at; when it cannot (no Git, no working copy, a
 * diff it cannot read), nothing is refused: no reading is ever invented.
 */
export async function instrumentationProblem(
  context: CommandContext,
  state: ProjectionState["state"],
  story: string,
): Promise<AgentPluggedError | undefined> {
  const started = storyIn(state, story)?.started;
  const source = context.storyDiff;
  const runner = context.proofRunner;
  if (started === undefined || source === undefined || runner === undefined) return undefined;
  const copy = await runner
    .workingCopy(started.worktree === "." ? undefined : started.worktree)
    .catch(() => undefined);
  if (copy?.commit === undefined) return undefined;
  const diff = await source
    .diff(started.base, copy.commit, started.base_ref)
    .catch(() => undefined);
  const files = instrumentedFiles(diff);
  if (files.length === 0) return undefined;
  const named = files.slice(0, 3).join(", ");
  return invalid(
    "update_story",
    "story",
    `debug_instrumentation_left (${files.length} file(s) still carry the marker of temporary diagnostic code: ${named}${files.length > 3 ? ", …" : ""}): take it out, commit, then ask again`,
  );
}
