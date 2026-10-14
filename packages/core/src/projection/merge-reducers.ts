import {
  CHAT_EVENT_TYPES,
  CHECKPOINT_DECIDED_EVENT_TYPES,
  CHECKPOINT_EVENT_TYPES,
  ELICITATION_EVENT_TYPES,
  type EventEnvelope,
  MACHINE_DEVICE_PATTERN,
  MERGE_EVENT_TYPES,
  type StoryMergedPayload,
} from "@agentplugged/protocol";
import { liftsBlocks } from "../checkpoints/resolution-rules.js";
import { type StoryState, section } from "./agent-reducers.js";
import type { CheckpointState } from "./checkpoint-reducers.js";
import { untrustedAnswer } from "./human-reducers.js";
import type { ProjectionDraft, Reducer } from "./reducers.js";

/**
 * The reducers of a story's merge. `story.merged` records the merge the engine did
 * once the creator approved the story's merge checkpoint, in the same write as that approval; a
 * refusal of the merge checkpoint sends the story back to its developer with the creator's note.
 */

/** True for a story's merge checkpoint: a `story` checkpoint the engine opened (`source: merge`). */
export function isMergeCheckpoint(
  checkpoint: Pick<CheckpointState, "type" | "story"> & {
    readonly source?: CheckpointState["source"];
  },
): boolean {
  return checkpoint.type === "story" && checkpoint.story !== null && checkpoint.source === "merge";
}

/** The answer's event type each merge source follows. */
const SOURCE_OF_ANSWER: Readonly<Record<string, string>> = {
  chat: "chat",
  elicitation: "elicitation",
  terminal: "terminal",
  // A merge the agent responsible decided, the creator not keeping the merges.
  agent: "agent",
};

/**
 * True when the event written just before `eventId` by the same writer is the answer `answer`, or
 * the merge of another story that followed that same answer: a stack answered once
 * merges its stories one after the other, in the order of the graph, in the same write.
 */
function followsAnswer(draft: ProjectionDraft, eventId: string, answer: string): boolean {
  const stories = section<StoryState>(draft, "stories");
  const checkpoints = section<CheckpointState>(draft, "checkpoints");
  let parent = draft.parents.get(eventId);
  for (let steps = 0; parent !== undefined && steps < 50; steps += 1) {
    if (parent === answer) return true;
    const previous = Object.values(stories).find((story) => story.merged?.event === parent);
    const named = previous?.merged?.checkpoint ?? null;
    const resolution =
      named !== null && Object.hasOwn(checkpoints, named)
        ? (checkpoints[named] as CheckpointState).resolution
        : null;
    if (resolution === null || resolution.event !== answer || resolution.stack === undefined) {
      return false;
    }
    parent = draft.parents.get(parent);
  }
  return false;
}

function storyOf(draft: ProjectionDraft, id: string): StoryState | undefined {
  const stories = section<StoryState>(draft, "stories");
  return Object.hasOwn(stories, id) ? stories[id] : undefined;
}

/** The number of merges recorded so far in the product (the next one's `seq` is one more). */
function mergesSoFar(draft: ProjectionDraft): number {
  const stories = section<StoryState>(draft, "stories");
  return Object.values(stories).filter((story) => story.merged !== undefined).length;
}

/**
 * Why a `story.merged` is refused, or undefined. It must follow, in its writer's chain, the
 * approval (a decision that lifts the blocks) of the story's merge checkpoint, written by the
 * same actor with the same source: the agent that relayed it from the chat or asked in the AI
 * tool's form, on the same machine; the creator's trusted key at the terminal. Once
 * per story, on the pull request the story recorded.
 *
 * A merge the creator did on the forge (`source: forge`) follows no approval: the
 * forge's own event is the proof (who merged and when, in the payload). The engine writes it as the
 * machine (`system`), once per story, on the pull request the story recorded; the merge
 * checkpoint it names, if any, must be the story's own.
 */
function mergedRefusal(draft: ProjectionDraft, event: EventEnvelope): string | undefined {
  const payload = event.payload as StoryMergedPayload;
  if (event.story === undefined) return "invalid";
  const checkpoints = section<CheckpointState>(draft, "checkpoints");
  const named = payload.checkpoint;
  const checkpoint =
    named === undefined || !Object.hasOwn(checkpoints, named) ? undefined : checkpoints[named];
  const story = storyOf(draft, event.story);
  if (story?.started === undefined || story.merged !== undefined) return "invalid";
  // A merge without a pull request (the creator chose it) follows no pull request, only
  // the creator's approval below; a merge seen on the forge always follows one.
  const pr = story.pull_request;
  if (payload.direct === true) {
    if (payload.source === "forge") return "invalid";
  } else if (pr === undefined || pr.number !== payload.pr || pr.forge !== payload.forge) {
    return "invalid";
  }
  if (payload.source === "forge") {
    if (event.actor.kind !== "system" || !MACHINE_DEVICE_PATTERN.test(event.actor.device)) {
      return "invalid";
    }
    if (named === undefined) return undefined;
    return checkpoint !== undefined &&
      isMergeCheckpoint(checkpoint) &&
      checkpoint.story === event.story
      ? undefined
      : "invalid";
  }
  if (checkpoint === undefined || !isMergeCheckpoint(checkpoint)) return "invalid";
  if (checkpoint.story !== event.story) return "invalid";
  const resolution = checkpoint.resolution ?? null;
  if (checkpoint.status !== "resolved" || resolution === null) return "invalid";
  if (!liftsBlocks(resolution.decision)) return "invalid";
  if (!followsAnswer(draft, event.id, resolution.event)) return "invalid";
  if (SOURCE_OF_ANSWER[resolution.source ?? "terminal"] !== payload.source) return "invalid";
  if (payload.source === "terminal") {
    if (event.actor.kind !== "human" || event.actor.device !== resolution.by) return "invalid";
    return untrustedAnswer(draft, event);
  }
  // From the chat, with or without the hook's proof: the merge is undone by a
  // `git revert`, and the answer's assurance (`chat` or `chat_unverified`) says how it was proved.
  const relayed =
    event.actor.kind === "agent" &&
    event.actor.agent === resolution.relayed_by &&
    event.actor.device === resolution.by;
  return relayed ? undefined : "invalid";
}

function applyMerged(draft: ProjectionDraft, event: EventEnvelope): void {
  const refusal = mergedRefusal(draft, event);
  if (refusal !== undefined) {
    draft.ignored.push({ id: event.id, reason: refusal as "invalid" });
    return;
  }
  const payload = event.payload as StoryMergedPayload;
  const story = storyOf(draft, event.story as string) as StoryState;
  story.merged = {
    checkpoint: payload.checkpoint ?? null,
    forge: payload.forge ?? null,
    pr: payload.pr ?? null,
    url: payload.url ?? null,
    into: payload.into ?? null,
    commit: payload.commit,
    merge_commit: payload.merge_commit ?? null,
    method: payload.method,
    files: payload.files,
    files_truncated: payload.files_truncated === true,
    ...(payload.weight === undefined
      ? {}
      : {
          weight: {
            added: payload.weight.added,
            removed: payload.weight.removed,
            ...(payload.weight.duplicates === undefined
              ? {}
              : { duplicates: payload.weight.duplicates }),
          },
        }),
    source: payload.source,
    already: payload.already === true,
    merged_by: payload.merged_by ?? null,
    by: event.actor.kind === "agent" ? (event.actor.agent ?? null) : null,
    // A merge seen on the forge is dated by the forge, else by the event.
    at: payload.merged_at ?? event.at,
    event: event.id,
    seq: mergesSoFar(draft) + 1,
  };
}

/** The merge checkpoints and their status, before an answer is applied. */
function mergeStatuses(draft: ProjectionDraft): Map<string, string> {
  const checkpoints = section<CheckpointState>(draft, "checkpoints");
  const statuses = new Map<string, string>();
  for (const checkpoint of Object.values(checkpoints)) {
    if (isMergeCheckpoint(checkpoint)) statuses.set(checkpoint.id, checkpoint.status);
  }
  return statuses;
}

/**
 * A merge checkpoint just refused (`rejected`, `changes_requested`): its story, not merged, goes
 * back to its developer (`in_progress`), with the creator's note (`merge_feedback`). Never dated
 * before the status it replaces.
 */
function applyFeedback(draft: ProjectionDraft, checkpoint: CheckpointState): void {
  const resolution = checkpoint.resolution ?? null;
  if (resolution === null || checkpoint.story === null) return;
  const decision = resolution.decision;
  if (decision !== "rejected" && decision !== "changes_requested") return;
  const story = storyOf(draft, checkpoint.story);
  if (story?.started === undefined || story.merged !== undefined) return;
  // A story blocked meanwhile stays blocked: only a story in review (or already back in
  // progress) goes back to its developer.
  if (story.status !== "in_review" && story.status !== "in_progress") return;
  const since = story.status_by?.at;
  const at =
    since !== undefined && Date.parse(since) > Date.parse(resolution.at) ? since : resolution.at;
  story.status = "in_progress";
  story.status_by = { agent: story.started.agent, at };
  story.merge_feedback = {
    checkpoint: checkpoint.id,
    decision,
    note: resolution.note,
    at,
  };
}

/** The event types after which a merge checkpoint may have been answered. */
const ANSWER_TYPES = [
  CHECKPOINT_EVENT_TYPES.opened,
  CHECKPOINT_EVENT_TYPES.resolved,
  CHAT_EVENT_TYPES.answered,
  ELICITATION_EVENT_TYPES.answered,
  CHECKPOINT_DECIDED_EVENT_TYPES.decided,
] as const;

/**
 * The reducers given, with those of the answers wrapped: once a merge checkpoint is refused by
 * the event (or by a held answer it released), its story goes back to its developer.
 */
export function withMergeFeedback(
  reducers: Readonly<Record<string, Reducer>>,
): Readonly<Record<string, Reducer>> {
  const wrapped: Record<string, Reducer> = { ...reducers };
  for (const type of ANSWER_TYPES) {
    const base = reducers[type];
    if (base === undefined) continue;
    wrapped[type] = (draft, event) => {
      const before = mergeStatuses(draft);
      base(draft, event);
      const checkpoints = section<CheckpointState>(draft, "checkpoints");
      for (const checkpoint of Object.values(checkpoints)) {
        if (!isMergeCheckpoint(checkpoint) || checkpoint.status === "open") continue;
        const was = before.get(checkpoint.id);
        if (was !== undefined && was !== "open") continue;
        applyFeedback(draft, checkpoint);
      }
    };
  }
  return wrapped;
}

/** The reducer of a story's merge. */
export const MERGE_REDUCERS: Readonly<Record<string, Reducer>> = {
  [MERGE_EVENT_TYPES.merged]: applyMerged,
};
