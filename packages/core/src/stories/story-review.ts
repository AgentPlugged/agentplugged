import {
  ErrorCode,
  type ProjectionState,
  type ResultStatus,
  STORY_DOCUMENT_ID_PATTERN,
  type StoryHeader,
} from "@agentplugged/protocol";
import { currentDeveloper } from "../agents/agent-aliases.js";
import type { CommandContext } from "../command.js";
import { type ApprovedStoryDocument, approvedStoryDocuments } from "../docs/frozen-intents.js";
import { parseDocumentFile } from "../docs/parse-document.js";
import { hasIntent, idOfName, intentOf } from "../docs/story-rules.js";
import { AgentPluggedError } from "../errors.js";
import { approvedAt, byAnswer } from "../phases/phases.js";
import type { StoryState } from "../projection/agent-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import type { StoryWorkspace } from "./story-workspace.js";

/**
 * A story going to review. Who moves it: the builder `story.started` records, with a
 * `complete` result that `submit_result` turns into an explicit `story.status_changed`. What may
 * stop it: the last commit of the story's branch no longer holding the intent the creator
 * approved, read as `docs check` rule 10 reads it (the story found by its id, on both sides).
 */

/**
 * Whether an agent's result moves the story to review: a `complete` result on a story
 * `in_progress`, from its builder, the agent `story.started` records. Any other
 * agent's result (a reviewer's, an agent that took the story over with `update_story`), any other
 * status, or a story never started leaves the status as it is.
 */
export function resultMovesToReview(
  story: StoryState | undefined,
  agent: string,
  status: ResultStatus,
): boolean {
  return (
    status === "complete" &&
    story?.status === "in_progress" &&
    story.started !== undefined &&
    currentDeveloper(story.started.agent) === agent
  );
}

/** A story file's path as checkpoints and the working copy are compared: `/`, lowercase. */
function comparable(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/, "")
    .toLowerCase();
}

/**
 * The creator's latest approval of the story at `path`: the approved `document` checkpoint (never
 * waived) listing that path answered last, and the blob it names (lowercased). Undefined when none
 * lists it.
 */
export function latestStoryApproval(
  checkpoints: Iterable<CheckpointState>,
  path: string,
  now: number,
): { readonly checkpoint: string; readonly blob: string } | undefined {
  const wanted = comparable(path);
  let latest: { checkpoint: CheckpointState; blob: string } | undefined;
  for (const checkpoint of checkpoints) {
    if (checkpoint.type !== "document" || !approvedAt(checkpoint, now)) continue;
    const document = checkpoint.documents.find((entry) => {
      const listed = comparable(entry.path);
      return listed === wanted || listed.endsWith(`/${wanted}`);
    });
    if (document === undefined) continue;
    if (latest === undefined || byAnswer(latest.checkpoint, checkpoint) < 0) {
      latest = { checkpoint, blob: document.blob_sha.toLowerCase() };
    }
  }
  return latest === undefined ? undefined : { checkpoint: latest.checkpoint.id, blob: latest.blob };
}

/** What the story's branch says of its frozen intent. */
export interface BranchIntent {
  readonly story: string;
  readonly branch: string;
  /** The approved `document` checkpoint the intent comes from. */
  readonly checkpoint: string;
  /** The approved intent. */
  readonly approved: string;
  /** The story's file on the branch (else the approved one's path, when it is gone). */
  readonly path: string;
  /**
   * The story on the branch: its intent; `no_intent` when its file holds no intent section;
   * `removed` when no file of the branch holds the story.
   */
  readonly onBranch: { readonly intent: string } | "no_intent" | "removed";
}

/** A story's text: its id when it is a `kind: story` document, and its intent, if any. */
function storyIn(path: string, text: string): { id?: string; intent?: string } {
  const parsed = parseDocumentFile(path, text);
  const id = parsed.id;
  if (parsed.kind?.value !== "story" || id === undefined || !STORY_DOCUMENT_ID_PATTERN.test(id)) {
    return {};
  }
  return hasIntent(parsed) ? { id, intent: intentOf(parsed) } : { id };
}

/** Candidates in the order to read them: the files named after the story first. */
function namedFirst<T extends { readonly path: string }>(id: string, entries: readonly T[]): T[] {
  return [
    ...entries.filter((entry) => idOfName(entry.path) === id),
    ...entries.filter((entry) => idOfName(entry.path) !== id),
  ];
}

/**
 * The creator's latest approval of story `id`, found by the story its blob holds (as rule 10 does),
 * never by a path: the last approved `document` checkpoint whose story file is that story.
 * Undefined when none is, or when that latest approval cannot be read or holds no intent.
 */
async function latestApprovalOf(
  workspace: StoryWorkspace,
  checkpoints: readonly CheckpointState[],
  id: string,
  now: number,
): Promise<{ entry: ApprovedStoryDocument; intent: string; branch?: string } | undefined> {
  const approved = approvedStoryDocuments(checkpoints, now).approved;
  const order = new Map(approved.map((entry, index) => [entry, index]));
  let latest: { entry: ApprovedStoryDocument; text: string | undefined } | undefined;
  // Newest first; a file named after another story is read only when it could be newer.
  for (const entry of namedFirst(id, [...approved].reverse())) {
    if (latest !== undefined && (order.get(entry) ?? -1) < (order.get(latest.entry) ?? -1)) {
      continue;
    }
    const text = await workspace.readBlob(entry.blob);
    if (text === undefined) {
      // Git does not hold it: it counts for the story its name gives, unverified.
      if (idOfName(entry.path) === id) latest = { entry, text };
      continue;
    }
    if (storyIn(entry.path, text).id === id) latest = { entry, text };
  }
  if (latest?.text === undefined) return undefined;
  const intent = storyIn(latest.entry.path, latest.text).intent;
  if (intent === undefined) return undefined;
  const header = parseDocumentFile(latest.entry.path, latest.text).header as
    | StoryHeader
    | undefined;
  const branch = typeof header?.branch === "string" ? header.branch : undefined;
  return { entry: latest.entry, intent, ...(branch === undefined ? {} : { branch }) };
}

/**
 * The story's frozen intent and what its branch holds, read through `context.storyWorkspace`: the
 * branch `story.started` recorded (else the one the approved story names), at its last commit, the
 * story found there by its id. Undefined when it cannot be read: no Git workspace, no repository,
 * no such branch, no approval, an approved blob Git does not hold. Only Git's own failures are
 * tolerated (`AgentPluggedError`); anything else is a defect and is thrown.
 */
export async function readBranchIntent(
  context: CommandContext,
  state: ProjectionState["state"],
  id: string,
): Promise<BranchIntent | undefined> {
  const workspace = context.storyWorkspace;
  if (workspace === undefined) return undefined;
  try {
    const checkpoints = Object.values(
      (state.checkpoints as Record<string, CheckpointState> | undefined) ?? {},
    );
    const approval = await latestApprovalOf(
      workspace,
      checkpoints,
      id,
      (context.now ?? Date.now)(),
    );
    if (approval === undefined) return undefined;
    const stories = (state.stories as Record<string, StoryState> | undefined) ?? {};
    const started = Object.hasOwn(stories, id) ? stories[id]?.started : undefined;
    const branch = started?.branch ?? approval.branch;
    if (branch === undefined) return undefined;
    const files = await workspace.storyFilesOn(branch);
    if (files === undefined) return undefined;
    const base = {
      story: id,
      branch,
      checkpoint: approval.entry.checkpoint,
      approved: approval.intent,
    };
    for (const file of namedFirst(id, files)) {
      const text = await workspace.readBlob(file.blob);
      if (text === undefined) continue;
      const found = storyIn(file.path, text);
      if (found.id !== id) continue;
      return {
        ...base,
        path: file.path,
        onBranch: found.intent === undefined ? "no_intent" : { intent: found.intent },
      };
    }
    return { ...base, path: approval.entry.path, onBranch: "removed" };
  } catch (error) {
    // Git could not be read: unverified, never refused. A defect is never hidden.
    if (error instanceof AgentPluggedError) return undefined;
    throw error;
  }
}

/**
 * `STORY_INTENT_CHANGED` (`error.story_intent_changed.on_branch`) when the story's branch no longer
 * holds the approved intent: `changed`, `no_intent` (its file has no intent section) or `removed`
 * (no file of the branch holds the story).
 */
export function branchIntentProblem(
  evidence: BranchIntent | undefined,
): AgentPluggedError | undefined {
  if (evidence === undefined) return undefined;
  const { onBranch } = evidence;
  if (typeof onBranch === "object" && onBranch.intent === evidence.approved) return undefined;
  return new AgentPluggedError(
    ErrorCode.STORY_INTENT_CHANGED,
    "error.story_intent_changed.on_branch",
    {
      story: evidence.story,
      reason: typeof onBranch === "object" ? "changed" : onBranch,
      checkpoint: evidence.checkpoint,
      branch: evidence.branch,
      path: evidence.path,
    },
  );
}
