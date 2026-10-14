import { fromUtf8 } from "@agentplugged/crypto";
import type { ProjectionState, StoryHeader } from "@agentplugged/protocol";
import type { CommandContext } from "../command.js";
import { parseDocumentFile } from "../docs/parse-document.js";
import { intentOf } from "../docs/story-rules.js";
import { checkpointsOf } from "../projection/checkpoint-reducers.js";
import { readSprintStories } from "../sprints/sprint-stories.js";
import { acceptanceCriteria, listedCriteria } from "./pull-request-body.js";
import { latestApprovedStoryBlob } from "./story-start.js";

/**
 * What is read of a story's approved text: its header and the words it says (a review reads it,
 * and so does the follow-up of its acceptance criteria).
 */
export interface StoryText {
  readonly path: string;
  readonly title: string;
  readonly requirements: readonly string[];
  readonly reviewer: string | null;
  /** Its title, intent and acceptance criteria. */
  readonly text: string;
  /** The whole document, as approved (what the guard before a write reads the files it names from). */
  readonly body: string;
  /** Its acceptance criteria, in order: the lenses and the judge number them from 1. */
  readonly criteria: readonly string[];
  /** The criteria written as a list (the form the engine follows one by one), else empty. */
  readonly listed: readonly string[];
}

/** The story's approved version (else its working copy), as a review reads it. */
export async function storyText(
  context: CommandContext,
  state: ProjectionState["state"],
  id: string,
  now: number,
): Promise<StoryText | undefined> {
  const entry = (await readSprintStories(context.files)).get(id);
  if (entry === undefined) return undefined;
  const checkpoints = Object.values(checkpointsOf(state));
  const blob = latestApprovedStoryBlob(checkpoints, entry.path, now);
  const approved =
    blob === undefined
      ? undefined
      : await context.storyWorkspace?.readBlob(blob).catch(() => undefined);
  const text = approved ?? fromUtf8(entry.bytes) ?? "";
  const parsed = parseDocumentFile(entry.path, text);
  const header = parsed.header as StoryHeader | undefined;
  const title = header?.title ?? id;
  const criteria = acceptanceCriteria(parsed);
  return {
    path: entry.path,
    title,
    requirements: header?.requirements ?? [],
    reviewer: header?.reviewer ?? null,
    text: [title, intentOf(parsed), ...criteria].join("\n"),
    body: text,
    criteria,
    listed: listedCriteria(parsed),
  };
}
