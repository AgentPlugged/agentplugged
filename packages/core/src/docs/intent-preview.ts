import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import type { DocsBase } from "./docs-base.js";
import { approvedStoryDocuments, readApprovedStory, storyDocumentsOf } from "./frozen-intents.js";
import type { ApprovedStory } from "./story-rules.js";

/** Lines of an intent shown on the card of a checkpoint. */
export const PREVIEW_LINES = 3;

/**
 * What approving a `document` checkpoint would freeze, story by story, for the card
 * of `review`: the first lines of the intent, and how it stands against the intent frozen now.
 * `new`: no intent of this story is frozen yet; `same`: the frozen intent is the same; `changes`:
 * it replaces a different frozen intent (`frozen_by`); `no_intent`: the blob holds no story with
 * an intent section; `unreadable`: Git does not hold the blob.
 */
export interface IntentPreview {
  readonly path: string;
  readonly story: string | null;
  readonly intent: readonly string[];
  /** True when the intent has more lines than shown. */
  readonly more: boolean;
  readonly status: "new" | "same" | "changes" | "no_intent" | "unreadable";
  /** The approved checkpoint whose intent is frozen now, for `same` and `changes`. */
  readonly frozen_by: string | null;
}

/**
 * The previews of the `document` checkpoints of `listed` that list stories, by checkpoint id;
 * `all` gives the approvals in force at `now`. Reads every blob through Git once; throws when Git
 * fails (the caller shows the card without previews).
 */
export async function intentPreviews(
  docsBase: DocsBase,
  listed: readonly CheckpointState[],
  all: Iterable<CheckpointState>,
  now: number,
): Promise<Record<string, IntentPreview[]>> {
  const asked = listed
    .filter((checkpoint) => checkpoint.type === "document")
    .map((checkpoint) => ({ id: checkpoint.id, stories: storyDocumentsOf(checkpoint).stories }))
    .filter((entry) => entry.stories.length > 0);
  if (asked.length === 0) return {};
  const { approved } = approvedStoryDocuments(all, now);
  const ids = new Set([
    ...approved.map((entry) => entry.blob),
    ...asked.flatMap((entry) => entry.stories.map((story) => story.blob)),
  ]);
  const blobs = await docsBase.readBlobs([...ids]);
  // The intent frozen now for each story: its last approval Git can read.
  const frozen = new Map<string, ApprovedStory>();
  for (const entry of approved) {
    const read = readApprovedStory(entry, blobs.get(entry.blob));
    if (read.state === "read" && read.story !== undefined) frozen.set(read.story, read);
  }
  const previews: Record<string, IntentPreview[]> = {};
  for (const { id, stories } of asked) {
    previews[id] = stories.map((entry) => {
      const read = readApprovedStory(entry, blobs.get(entry.blob));
      const lines = (read.intent ?? "").split("\n").filter((line) => line.trim() !== "");
      const current = read.story === undefined ? undefined : frozen.get(read.story);
      const status: IntentPreview["status"] =
        read.state === "missing"
          ? "unreadable"
          : read.state === "no_intent"
            ? "no_intent"
            : current === undefined
              ? "new"
              : current.intent === read.intent
                ? "same"
                : "changes";
      return {
        path: entry.path,
        story: read.story ?? null,
        intent: lines.slice(0, PREVIEW_LINES),
        more: lines.length > PREVIEW_LINES,
        status,
        frozen_by: status === "same" || status === "changes" ? (current?.checkpoint ?? null) : null,
      };
    });
  }
  return previews;
}
