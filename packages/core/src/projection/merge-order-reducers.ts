import {
  type ConflictOption,
  type EventEnvelope,
  MERGE_ORDER_EVENT_TYPES,
  type StoryConflictQualifiedPayload,
  type StoryMergeRefreshedPayload,
} from "@agentplugged/protocol";
import { creatorStack, stackText } from "../review/review-lenses.js";
import { isStoryDeveloper, stackEntriesOf } from "../review/review-rules.js";
import { type StoryConflict, type StoryState, section } from "./agent-reducers.js";
import type { CheckpointState } from "./checkpoint-reducers.js";
import { isMergeCheckpoint } from "./merge-reducers.js";
import type { ProjectionDraft, Reducer } from "./reducers.js";

/**
 * The reducers of the conflicts of a story's branch with the main branch and of the refresh of its
 * merge checkpoint. `story.conflict_qualified` records what the story's developer
 * declared of a conflict (and, for a conflict of substance, the `decision` checkpoint opened in the
 * same write) and sends the story back to its developer; `story.merge_refreshed` replaces the
 * summary of the merge checkpoint left open once the story was reviewed again on a new commit.
 */

function storyOf(draft: ProjectionDraft, id: string): StoryState | undefined {
  const stories = section<StoryState>(draft, "stories");
  return Object.hasOwn(stories, id) ? stories[id] : undefined;
}

/** The last conflict a story's developer qualified, or undefined. */
export function lastConflict(story: StoryState | undefined): StoryConflict | undefined {
  return story?.conflicts?.at(-1);
}

/**
 * Where an open conflict stands: `awaiting` the creator's choice (its `decision` checkpoint is
 * open), `decided` (the creator chose an option), `refused` (the creator refused every option, with
 * a note) or `to_resolve` (a textual conflict). Open while the story has not left its developer
 * since: it is `in_progress` and its status is the one the qualification (or the answer) set.
 */
export type ConflictPhase = "awaiting" | "decided" | "refused" | "to_resolve";

export interface OpenConflict {
  readonly phase: ConflictPhase;
  readonly conflict: StoryConflict;
  /** The option the creator chose, for `decided`. */
  readonly option: ConflictOption | null;
  /** The creator's note, for `refused`. */
  readonly note: string | null;
}

export function openConflict(
  story: StoryState | undefined,
  checkpoints: Readonly<Record<string, CheckpointState>>,
): OpenConflict | undefined {
  const conflict = lastConflict(story);
  if (story === undefined || conflict === undefined || story.merged !== undefined) return undefined;
  const decision =
    conflict.checkpoint !== null && Object.hasOwn(checkpoints, conflict.checkpoint)
      ? (checkpoints[conflict.checkpoint] as CheckpointState)
      : undefined;
  if (conflict.kind === "substantive" && decision?.status === "open") {
    return { phase: "awaiting", conflict, option: null, note: null };
  }
  if (story.status !== "in_progress") return undefined;
  const resolution = decision?.resolution ?? null;
  const since =
    resolution !== null && Date.parse(resolution.at) > Date.parse(conflict.at)
      ? resolution.at
      : conflict.at;
  if (story.status_by !== null && Date.parse(story.status_by.at) > Date.parse(since)) {
    return undefined;
  }
  if (conflict.kind === "textual")
    return { phase: "to_resolve", conflict, option: null, note: null };
  if (resolution === null) return undefined;
  if (resolution.decision === "option_chosen") {
    return {
      phase: "decided",
      conflict,
      option: resolution.option as ConflictOption,
      note: resolution.note,
    };
  }
  return { phase: "refused", conflict, option: null, note: resolution.note };
}

/** A sentence about the conflict a story's branch settled, for the merge checkpoint; or "". */
export function conflictNote(
  story: StoryState | undefined,
  checkpoints: Readonly<Record<string, CheckpointState>>,
): string {
  const conflict = lastConflict(story);
  if (conflict === undefined) return "";
  const names = conflict.files.slice(0, 5).map((file) => file.path);
  const more =
    conflict.files.length > names.length ? ` and ${conflict.files.length - names.length} more` : "";
  const files = names.length === 0 ? "" : ` (${names.join(", ")}${more})`;
  if (conflict.kind === "textual") {
    return ` Its developer qualified a textual conflict with the main branch${files}, resolved on the story's branch; the engine checks that both sides were kept when it merges.`;
  }
  const decision =
    conflict.checkpoint !== null && Object.hasOwn(checkpoints, conflict.checkpoint)
      ? checkpoints[conflict.checkpoint]
      : undefined;
  const option = decision?.resolution?.option;
  return ` Its developer qualified a conflict of substance with the main branch${files}${option === undefined || option === null ? "" : `, and you chose: ${option}`}; the engine checks that the branch applies the choice when it merges.`;
}

/**
 * The summary of a story's merge checkpoint refreshed for a new review pass: composed by the engine
 * from the pass, the commit and the conflict the story settled; the reducer composes it again and
 * refuses any other text. `legacy` is the text written (when a merge was said
 * irreversible), which a journal written then still holds.
 */
export function refreshedMergeSummary(
  input: {
    readonly story: string;
    readonly pass: number;
    readonly commit: string;
    readonly note: string;
    /** What the creator is shown of the review's findings (`stackText`). */
    readonly stack?: string;
    /** The walk through the change the engine composed (`walkthroughText`). */
    readonly walkthrough?: string;
  },
  legacy = false,
): string {
  const undo = legacy ? "(irreversible)" : "(a git revert of the merge undoes it)";
  return `The independent review of story ${input.story} is done again on a new commit (pass ${input.pass}, commit ${input.commit.slice(0, 12)}), on a green CI.${input.stack ?? ""}${input.walkthrough === undefined || input.walkthrough === "" ? "" : ` ${input.walkthrough}`}${input.note} Approve and the engine merges its pull request into the main branch with your forge's tool, then removes its worktree ${undo}; ask for changes to send it back to its developer with your note.`.slice(
    0,
    2000,
  );
}

function qualifiedRefusal(
  draft: ProjectionDraft,
  event: EventEnvelope,
  story: StoryState | undefined,
): string | undefined {
  const payload = event.payload as StoryConflictQualifiedPayload;
  if (event.story === undefined || story?.started === undefined || story.merged !== undefined) {
    return "invalid";
  }
  if (event.actor.kind !== "agent" || event.actor.agent === undefined) return "invalid";
  if (!isStoryDeveloper(story, event.actor.agent)) return "invalid";
  if (payload.kind === "textual") return undefined;
  // A conflict of substance names the `decision` checkpoint its developer opened in the same write.
  const checkpoints = section<CheckpointState>(draft, "checkpoints");
  const checkpoint =
    payload.checkpoint !== undefined && Object.hasOwn(checkpoints, payload.checkpoint)
      ? checkpoints[payload.checkpoint]
      : undefined;
  if (
    checkpoint === undefined ||
    checkpoint.type !== "decision" ||
    checkpoint.source !== "merge_conflict" ||
    checkpoint.story !== event.story ||
    checkpoint.opened_by !== event.actor.agent ||
    draft.parents.get(event.id) !== checkpoint.opened_event
  ) {
    return "invalid";
  }
  const named = (story.conflicts ?? []).some((entry) => entry.checkpoint === checkpoint.id);
  return named ? "invalid" : undefined;
}

function applyQualified(draft: ProjectionDraft, event: EventEnvelope): void {
  const story = event.story === undefined ? undefined : storyOf(draft, event.story);
  const refusal = qualifiedRefusal(draft, event, story);
  if (refusal !== undefined || story?.started === undefined) {
    draft.ignored.push({ id: event.id, reason: "invalid" });
    return;
  }
  const payload = event.payload as StoryConflictQualifiedPayload;
  const conflict: StoryConflict = {
    main: payload.main,
    head: payload.head,
    base_ref: payload.base_ref,
    kind: payload.kind,
    files: payload.files,
    files_truncated: payload.files_truncated === true,
    rationale: payload.rationale,
    recommendation: payload.recommendation ?? null,
    checkpoint: payload.checkpoint ?? null,
    by: event.actor.agent as string,
    at: event.at,
    event: event.id,
  };
  story.conflicts = [...(story.conflicts ?? []), conflict].slice(-50);
  // Back to its developer, as a refusal of its merge checkpoint does: never dated before the
  // status it replaces. A story blocked meanwhile stays blocked.
  // (A creator's note of a refused merge, current, stays the one `next` shows.)
  const refused =
    story.merge_feedback !== undefined && story.merge_feedback.at === story.status_by?.at;
  if (story.status === "in_review" || (story.status === "in_progress" && !refused)) {
    const since = story.status_by?.at;
    const at = since !== undefined && Date.parse(since) > Date.parse(event.at) ? since : event.at;
    story.status = "in_progress";
    story.status_by = { agent: story.started.agent, at };
  }
}

function refreshedRefusal(draft: ProjectionDraft, event: EventEnvelope): string | undefined {
  const payload = event.payload as StoryMergeRefreshedPayload;
  if (event.story === undefined || event.actor.kind !== "agent") return "invalid";
  const story = storyOf(draft, event.story);
  if (story?.started === undefined || story.merged !== undefined) return "invalid";
  const checkpoints = section<CheckpointState>(draft, "checkpoints");
  const checkpoint = Object.hasOwn(checkpoints, payload.checkpoint)
    ? checkpoints[payload.checkpoint]
    : undefined;
  if (
    checkpoint === undefined ||
    !isMergeCheckpoint(checkpoint) ||
    checkpoint.story !== event.story ||
    checkpoint.status !== "open"
  ) {
    return "invalid";
  }
  // Only for a pass the reviews closed without a failed review, on the commit it names.
  // Only for the pass the story is in now: an older pass never replaces the creator's summary.
  const last = story.review?.passes.at(-1);
  const pass = last?.number === payload.pass ? last : undefined;
  if (
    pass === undefined ||
    !pass.complete ||
    pass.outcome !== "approved" ||
    pass.commit !== payload.commit
  ) {
    return "invalid";
  }
  // The text is the engine's: no other summary replaces the one the creator is shown.
  const input = {
    story: event.story,
    pass: payload.pass,
    commit: payload.commit,
    note: conflictNote(story, checkpoints),
    stack: stackText(creatorStack(stackEntriesOf(story, payload.pass))),
    ...(payload.walkthrough === undefined ? {} : { walkthrough: payload.walkthrough }),
  };
  if (payload.summary === refreshedMergeSummary(input)) return undefined;
  // A journal written holds the summary without the findings' stack. A story
  // reviewed in lenses (its findings name their lens) is read lens by lens: its summary carries the stack.
  const lensed = (story.review?.passes ?? []).some((candidate) =>
    Object.values(candidate.reviews).some((review) =>
      review?.findings.some((finding) => finding.lens !== undefined),
    ),
  );
  if (lensed) return "invalid";
  const before = { ...input, stack: "" };
  return payload.summary === refreshedMergeSummary(before) ||
    payload.summary === refreshedMergeSummary(before, true)
    ? undefined
    : "invalid";
}

function applyRefreshed(draft: ProjectionDraft, event: EventEnvelope): void {
  if (refreshedRefusal(draft, event) !== undefined) {
    draft.ignored.push({ id: event.id, reason: "invalid" });
    return;
  }
  const payload = event.payload as StoryMergeRefreshedPayload;
  const checkpoints = section<CheckpointState>(draft, "checkpoints");
  (checkpoints[payload.checkpoint] as CheckpointState).summary = payload.summary;
  (storyOf(draft, event.story as string) as StoryState).merge_refresh = {
    checkpoint: payload.checkpoint,
    pass: payload.pass,
    commit: payload.commit,
    at: event.at,
    event: event.id,
  };
}

/** The reducers of the order of the merges and the conflicts. */
export const MERGE_ORDER_REDUCERS: Readonly<Record<string, Reducer>> = {
  [MERGE_ORDER_EVENT_TYPES.conflictQualified]: applyQualified,
  [MERGE_ORDER_EVENT_TYPES.mergeRefreshed]: applyRefreshed,
};
