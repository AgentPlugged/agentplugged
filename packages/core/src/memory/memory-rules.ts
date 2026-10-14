import { canonicalBytes, sha256Hex } from "@agentplugged/crypto";
import {
  type ActionDraft,
  MAX_ACTIVE_LESSONS,
  MEMORY_APPROVING_DECISIONS,
  type MemoryRecord,
  type ProposedLesson,
  type RetireDraft,
  type RetiredLesson,
  type RetroScope,
  scopeLabel,
} from "@agentplugged/protocol";
import { statusAt } from "../checkpoints/resolution-rules.js";
import type { StoryState } from "../projection/agent-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import {
  type SprintState,
  sprintStatus,
  sprintStories,
  storyDoneAt,
} from "../sprints/sprint-rules.js";

/**
 * The rules of the memory of the product, pure functions over the projection: which
 * lessons are in force (an approved retrospective, recorded, not retired since), what a
 * retrospective's scope is and whether it is finished, and the record and digest of a lesson.
 * Approval is read when a lesson is served, never when it is projected (like a sprint in force).
 */

/** A lesson as the clear journal anchors it: identifiers and digest, never a text. */
export interface LessonAnchor {
  readonly id: string;
  readonly retro: string;
  readonly checkpoint: string;
  readonly digest: string;
  readonly at: string;
  readonly event: string;
  /** The common-memory entries made from it, by `lessons.promoted`. */
  readonly promoted: Array<{ common: string; checkpoint: string; at: string }>;
}

/** One `lessons.recorded`, in projection order: what it retired decides what stays in force. */
export interface LessonBatch {
  readonly event: string;
  readonly at: string;
  readonly checkpoint: string;
  readonly retro: string;
  readonly retired: readonly RetiredLesson[];
  readonly excepted: readonly string[];
}

/** A proposed action with its id. */
export type RetroAction = ActionDraft & { readonly id: string };

/** A proposed lesson with its id. */
export type RetroLesson = ProposedLesson & { readonly id: string };

/** A retrospective's content, as the key-holding projection decrypts it (memory only). */
export interface RetroState {
  readonly id: string;
  readonly event: string;
  readonly at: string;
  readonly proposed_by: string;
  readonly checkpoint: string;
  readonly scope: RetroScope;
  readonly summary: string;
  /** The proposed lessons, each with the id its rank and the retrospective give it. */
  readonly lessons: readonly RetroLesson[];
  readonly retire: readonly RetireDraft[];
  /** The proposed actions, each with the id its rank and the retrospective give it. */
  readonly actions: readonly RetroAction[];
}

/** An own property of a dictionary (projection dictionaries have no prototype). */
function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

type StateBag = Readonly<Record<string, unknown>>;

/** `state.lessons`: the anchors by lesson id (none when nothing was recorded). */
export function anchorsOf(state: StateBag): Record<string, LessonAnchor> {
  return (state.lessons as Record<string, LessonAnchor> | undefined) ?? {};
}

/** `state.lessons_log`: the batches in projection order. */
export function batchesOf(state: StateBag): readonly LessonBatch[] {
  return (state.lessons_log as LessonBatch[] | undefined) ?? [];
}

/** `state.memory.retros`: the decrypted retrospectives (only with the product key). */
export function retrosOf(state: StateBag): Record<string, RetroState> {
  const memory = state.memory as { retros?: Record<string, RetroState> } | undefined;
  return memory?.retros ?? {};
}

/** The retrospective a checkpoint submitted, when this projection could decrypt it. */
export function retroOfCheckpoint(state: StateBag, checkpoint: string): RetroState | undefined {
  return Object.values(retrosOf(state)).find((retro) => retro.checkpoint === checkpoint);
}

/** What a `memory` checkpoint is about, or undefined for any other checkpoint. */
export function memoryOf(checkpoint: CheckpointState | undefined): MemoryRecord | undefined {
  return checkpoint?.type === "memory" ? (checkpoint.memory ?? undefined) : undefined;
}

/** True when the creator approved the checkpoint (answered with an approving decision). */
export function approved(checkpoint: CheckpointState, now: number): boolean {
  const decision = checkpoint.resolution?.decision;
  return (
    statusAt(checkpoint, now) === "resolved" &&
    decision !== undefined &&
    MEMORY_APPROVING_DECISIONS.has(decision)
  );
}

export type LessonStatus = "active" | "retired" | "superseded";

/**
 * The lessons whose retrospective the creator approved, with what became of them: `active`, `retired`
 * (by a retirement), `superseded` (replaced by another lesson). Batches are applied in projection
 * order; a batch of a checkpoint not approved (any more) counts for nothing.
 */
export function lessonStatuses(
  state: StateBag,
  checkpoints: Readonly<Record<string, CheckpointState>>,
  now: number,
): Map<string, LessonStatus> {
  const anchors = anchorsOf(state);
  const status = new Map<string, LessonStatus>();
  for (const batch of batchesOf(state)) {
    const checkpoint = own(checkpoints, batch.checkpoint);
    if (checkpoint === undefined || !approved(checkpoint, now)) continue;
    for (const anchor of Object.values(anchors)) {
      if (anchor.checkpoint === batch.checkpoint && anchor.event === batch.event) {
        status.set(anchor.id, "active");
      }
    }
    for (const retired of batch.retired) {
      if (status.get(retired.lesson) === "active") {
        status.set(retired.lesson, retired.by === undefined ? "retired" : "superseded");
      }
    }
  }
  return status;
}

/** The active lessons' ids, in recording order. */
export function activeLessonIds(
  state: StateBag,
  checkpoints: Readonly<Record<string, CheckpointState>>,
  now: number,
): string[] {
  const status = lessonStatuses(state, checkpoints, now);
  return Object.values(anchorsOf(state))
    .filter((anchor) => status.get(anchor.id) === "active")
    .map((anchor) => anchor.id);
}

/** The file of a lesson, relative to `memory/`. */
export function lessonFile(id: string): string {
  return `lessons/${id}.json`;
}

/** What a lesson's file holds, and what its digest covers. */
export interface LessonRecord {
  readonly v: 1;
  readonly id: string;
  readonly retro: string;
  readonly checkpoint: string;
  readonly title: string;
  readonly text: string;
  readonly tags: readonly string[];
  readonly agents: readonly string[];
  /** Makes the digest of a short lesson unguessable: it only ever lives in encrypted places. */
  readonly salt: string;
}

/** The record of a proposed lesson once its retrospective is recorded. */
export function lessonRecord(
  retro: Pick<RetroState, "id" | "checkpoint">,
  lesson: RetroLesson,
): LessonRecord {
  return {
    v: 1,
    id: lesson.id,
    retro: retro.id,
    checkpoint: retro.checkpoint,
    title: lesson.title,
    text: lesson.text,
    tags: [...(lesson.tags ?? [])],
    agents: [...(lesson.agents ?? [])],
    salt: lesson.salt,
  };
}

/** The SHA-256 (hexadecimal) of the canonical JSON of a record. */
export function recordDigest(record: unknown): string {
  return sha256Hex(canonicalBytes(record));
}

/** A record read back from a file, or undefined when it is not one. */
export function parseLessonRecord(text: string): LessonRecord | undefined {
  try {
    const value = JSON.parse(text) as Partial<LessonRecord>;
    if (
      value.v === 1 &&
      typeof value.id === "string" &&
      typeof value.retro === "string" &&
      typeof value.checkpoint === "string" &&
      typeof value.title === "string" &&
      typeof value.text === "string" &&
      Array.isArray(value.tags) &&
      Array.isArray(value.agents) &&
      typeof value.salt === "string"
    ) {
      return value as LessonRecord;
    }
  } catch {
    // Not JSON.
  }
  return undefined;
}

/**
 * What the checkpoint of a retrospective says in clear: counts, and the ids (never a text) of the
 * existing lessons it replaces or retires, so the creator can see what goes away.
 */
export function retroSummary(counts: {
  readonly lessons: number;
  readonly replaced: readonly string[];
  readonly retired: readonly string[];
  readonly actions: number;
}): string {
  const ids = (list: readonly string[]) => (list.length === 0 ? "" : ` (${list.join(", ")})`);
  return (
    `${counts.lessons} lesson(s) proposed, replacing ${counts.replaced.length}${ids(counts.replaced)} ` +
    `and retiring ${counts.retired.length}${ids(counts.retired)} existing one(s); ` +
    `${counts.actions} action(s). The agent that proposed them presents their content in the chat, ` +
    "nothing is recorded until you approve."
  );
}

/** What the checkpoint of a promotion says in clear. */
export function promotionSummary(replaces: number): string {
  return (
    "One lesson of this product, shared with all your products on this machine" +
    (replaces > 0 ? `, replacing ${replaces} shared lesson(s)` : "") +
    ". The agent presents it in the chat; nothing is shared until you approve."
  );
}

/** The ids a retrospective's proposal replaces or retires, each once. */
export function targetsOf(
  lessons: readonly { readonly replaces?: readonly string[] | undefined }[],
  retire: readonly { readonly lesson: string }[],
): { ids: string[]; duplicate: boolean } {
  const all = [
    ...lessons.flatMap((lesson) => lesson.replaces ?? []),
    ...retire.map((r) => r.lesson),
  ];
  return { ids: [...new Set(all)], duplicate: new Set(all).size !== all.length };
}

/** True when keeping `kept` lessons and the others removed would overflow the memory. */
export function overflows(active: number, removed: number, added: number): boolean {
  return active - removed + added > MAX_ACTIVE_LESSONS;
}

/** The scope's status among the retrospectives of the product, the latest checkpoint deciding. */
export type ScopeStatus = "none" | "open" | "approved" | "dismissed" | "changes_requested";

/** The retrospective checkpoints of a scope, in opening order. */
function scopeCheckpoints(
  checkpoints: readonly CheckpointState[],
  scope: RetroScope,
): CheckpointState[] {
  return checkpoints
    .filter((checkpoint) => {
      const memory = memoryOf(checkpoint);
      return (
        memory?.kind === "retrospective" &&
        memory.scope.kind === scope.kind &&
        memory.scope.id === scope.id
      );
    })
    .sort((a, b) => (a.opened_event < b.opened_event ? -1 : 1));
}

/** Where a scope's retrospective stands: the latest checkpoint for it decides. */
export function scopeStatus(
  checkpoints: readonly CheckpointState[],
  scope: RetroScope,
  now: number,
): ScopeStatus {
  const latest = scopeCheckpoints(checkpoints, scope).at(-1);
  if (latest === undefined) return "none";
  if (statusAt(latest, now) === "open") return "open";
  const decision = latest.resolution?.decision;
  if (approved(latest, now)) return "approved";
  if (decision === "changes_requested") return "changes_requested";
  return "dismissed";
}

/** The latest retrospective checkpoint of a scope, when the creator asked for changes. */
export function refusedRetro(
  checkpoints: readonly CheckpointState[],
  scope: RetroScope,
  now: number,
): CheckpointState | undefined {
  return scopeStatus(checkpoints, scope, now) === "changes_requested"
    ? scopeCheckpoints(checkpoints, scope).at(-1)
    : undefined;
}

/** What `scopeFinished` reads. */
export interface ScopeInputs {
  /** Story ids of the working copy's `.agentplugged/stories/`. */
  readonly storyIds: readonly string[];
  readonly stories: Readonly<Record<string, StoryState>>;
  readonly checkpoints: Readonly<Record<string, CheckpointState>>;
  readonly sprints: Readonly<Record<string, SprintState>>;
  readonly now: number;
}

/** The epic a story id (`4-2`) belongs to. */
export function epicOfStory(id: string): string {
  return id.split("-")[0] ?? "";
}

/**
 * Whether a scope exists and is over: an epic with at least one story file, all done; a sprint
 * the creator put in force, whose stories are all done, or that a later sprint replaced.
 */
export function scopeFinished(
  scope: RetroScope,
  inputs: ScopeInputs,
): "finished" | "unknown" | "running" {
  const all = Object.values(inputs.checkpoints);
  if (scope.kind === "epic") {
    const ids = inputs.storyIds.filter((id) => epicOfStory(id) === scope.id);
    if (ids.length === 0) return "unknown";
    return ids.every((id) => storyDoneAt(all, id, own(inputs.stories, id)) !== undefined)
      ? "finished"
      : "running";
  }
  const sprint = own(inputs.sprints, scope.id);
  if (sprint === undefined) return "unknown";
  const status = sprintStatus(sprint, inputs.sprints, inputs.checkpoints, inputs.now);
  if (status === "superseded") return "finished";
  if (status !== "in_force") return "running";
  return sprintStories(sprint, inputs.stories, all).every((story) => story.status === "done")
    ? "finished"
    : "running";
}

/**
 * The scopes whose retrospective is due, in order: the latest finished epic (older ones were
 * looked back on in their time, or the creator asks for them), then the sprint in force when it is
 * finished; with no retrospective open, approved or set aside. A product that gains this story
 * with a long history is never asked for a dozen retrospectives in a row.
 */
export function dueScopes(inputs: ScopeInputs): RetroScope[] {
  const all = Object.values(inputs.checkpoints);
  const finishedEpics = [...new Set(inputs.storyIds.map(epicOfStory))]
    .filter((id) => /^[1-9][0-9]{0,3}$/.test(id))
    .sort((a, b) => Number(a) - Number(b))
    .map((id): RetroScope => ({ kind: "epic", id }))
    .filter((scope) => scopeFinished(scope, inputs) === "finished");
  const latestEpic = finishedEpics.at(-1);
  const sprints = Object.values(inputs.sprints)
    .filter(
      (sprint) =>
        sprintStatus(sprint, inputs.sprints, inputs.checkpoints, inputs.now) === "in_force",
    )
    .map((sprint): RetroScope => ({ kind: "sprint", id: sprint.id }))
    .filter((scope) => scopeFinished(scope, inputs) === "finished");
  return [...(latestEpic === undefined ? [] : [latestEpic]), ...sprints].filter(
    (scope) => scopeStatus(all, scope, inputs.now) === "none",
  );
}

/** A scope as the checkpoint's title and the agents read it. */
export { scopeLabel };
