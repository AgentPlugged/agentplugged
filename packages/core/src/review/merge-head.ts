import type { ProjectionState } from "@agentplugged/protocol";
import { branchHead } from "../ci/ci-check.js";
import type { CommandContext } from "../command.js";
import type { StoryState } from "../projection/agent-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";

/**
 * The head of a story's branch, read when the creator answers its merge checkpoint:
 * the gate then checks that the CI and the review cover that very commit, not an older one the
 * branch has moved on from. Undefined for another checkpoint, or when Git cannot read it here
 * (the gate then stands on the projection alone).
 */
export async function mergeHead(
  context: CommandContext,
  state: ProjectionState["state"],
  checkpoint: Pick<CheckpointState, "type" | "story"> | undefined,
): Promise<string | undefined> {
  if (checkpoint?.type !== "story" || checkpoint.story === null) return undefined;
  const stories = state.stories as Record<string, StoryState> | undefined;
  const story =
    stories !== undefined && Object.hasOwn(stories, checkpoint.story)
      ? stories[checkpoint.story]
      : undefined;
  const workspace = context.storyWorkspace;
  if (story?.started === undefined || workspace === undefined) return undefined;
  const head = await branchHead(workspace, checkpoint.story, story.started.branch).catch(
    () => undefined,
  );
  return typeof head === "string" ? head : undefined;
}
