import { STORY_DOCUMENT_ID_PATTERN } from "@agentplugged/protocol";
import { approvedAt, byAnswer } from "../phases/phases.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { parseDocumentFile } from "./parse-document.js";
import { type ApprovedStory, hasIntent, intentOf } from "./story-rules.js";

/** A story file a `document` checkpoint lists, with the Git blob it names. */
export interface ApprovedStoryDocument {
  readonly checkpoint: string;
  /** The path, normalised: `/` separators, from `.agentplugged/`. */
  readonly path: string;
  /** The blob id, lowercased. */
  readonly blob: string;
}

/** A document of a checkpoint that looks like a story but is not under `.agentplugged/stories/`. */
export interface MismatchedStoryPath {
  readonly checkpoint: string;
  readonly path: string;
}

const STORY_PATH = /(?:^|\/)(\.agentplugged\/stories\/[^/].*\.md)$/;

/**
 * The story files a checkpoint lists: paths with `\` read as `/` and taken from `.agentplugged/`
 * (a product in a sub-folder of its repository lists `<folder>/.agentplugged/stories/…`), blob ids
 * lowercased. A Markdown path naming a `stories` folder elsewhere is returned apart, to be
 * reported rather than freezing nothing in silence.
 */
export function storyDocumentsOf(checkpoint: CheckpointState): {
  stories: ApprovedStoryDocument[];
  mismatched: MismatchedStoryPath[];
} {
  const stories: ApprovedStoryDocument[] = [];
  const mismatched: MismatchedStoryPath[] = [];
  for (const document of checkpoint.documents) {
    const path = document.path.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
    const story = STORY_PATH.exec(path)?.[1];
    if (story !== undefined) {
      stories.push({
        checkpoint: checkpoint.id,
        path: story,
        blob: document.blob_sha.toLowerCase(),
      });
    } else if (/(?:^|\/)stories\//i.test(path) && path.toLowerCase().endsWith(".md")) {
      mismatched.push({ checkpoint: checkpoint.id, path: document.path });
    }
  }
  return { stories, mismatched };
}

/**
 * The story files listed by the `document` checkpoints the creator approved (a lifting decision,
 * never a waiver: `approvedAt`), in the order of the answers. A checkpoint still open, refused or
 * asking for changes freezes nothing.
 */
export function approvedStoryDocuments(
  checkpoints: Iterable<CheckpointState>,
  now: number,
): { approved: ApprovedStoryDocument[]; mismatched: MismatchedStoryPath[] } {
  const approved: ApprovedStoryDocument[] = [];
  const mismatched: MismatchedStoryPath[] = [];
  const answered = [...checkpoints]
    .filter((checkpoint) => checkpoint.type === "document" && approvedAt(checkpoint, now))
    .sort(byAnswer);
  for (const checkpoint of answered) {
    const found = storyDocumentsOf(checkpoint);
    approved.push(...found.stories);
    mismatched.push(...found.mismatched);
  }
  return { approved, mismatched };
}

/** A blob's text as an approved story: `read`, `no_intent` or `missing` (see `ApprovedStory`). */
export function readApprovedStory(
  entry: ApprovedStoryDocument,
  text: string | undefined,
): ApprovedStory {
  if (text === undefined)
    return { ...entry, state: "missing", story: undefined, intent: undefined };
  const parsed = parseDocumentFile(entry.path, text);
  const id = parsed.id;
  const story =
    parsed.kind?.value === "story" && id !== undefined && STORY_DOCUMENT_ID_PATTERN.test(id)
      ? id
      : undefined;
  if (story === undefined || !hasIntent(parsed)) {
    return { ...entry, state: "no_intent", story, intent: undefined };
  }
  return { ...entry, state: "read", story, intent: intentOf(parsed) };
}

/** The approved stories, read from the blobs (`blobs`, by id), in the same order. */
export function frozenIntents(
  approved: readonly ApprovedStoryDocument[],
  blobs: ReadonlyMap<string, string>,
): ApprovedStory[] {
  return approved.map((entry) => readApprovedStory(entry, blobs.get(entry.blob)));
}
