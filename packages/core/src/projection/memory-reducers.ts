import {
  actionIdOf,
  commonIdOf,
  LESSON_EVENT_TYPES,
  type LessonsPromotedPayload,
  type LessonsRecordedPayload,
  lessonIdOf,
  MEMORY_EVENT_TYPES,
  type RetrospectiveProposedPayload,
  retroIdOf,
} from "@agentplugged/protocol";
import {
  type LessonAnchor,
  type LessonBatch,
  type RetroState,
  retrosOf,
} from "../memory/memory-rules.js";
import { dictionary, section } from "./agent-reducers.js";
import type { CheckpointState } from "./checkpoint-reducers.js";
import type { ProjectionDraft, Reducer } from "./reducers.js";

/** A checkpoint of the projection, by id. */
function checkpointOf(draft: ProjectionDraft, id: string): CheckpointState | undefined {
  const checkpoints = draft.state.checkpoints as Record<string, CheckpointState> | undefined;
  return checkpoints !== undefined && Object.hasOwn(checkpoints, id) ? checkpoints[id] : undefined;
}

function invalid(draft: ProjectionDraft, id: string): void {
  draft.ignored.push({ id, reason: "invalid" });
}

/** `state.lessons`, created when needed. */
const anchors = (draft: ProjectionDraft) => section<LessonAnchor>(draft, "lessons");

/**
 * The reducers of the memory. They check the shape of what was written (who wrote it,
 * which checkpoint it names), never the creator's approval: that is read when a lesson is served,
 * like a sprint in force. `state.memory.retros` holds decrypted content, so it exists only in a
 * projection computed with the product key (never written to `state.json`).
 */
export const MEMORY_REDUCERS: Readonly<Record<string, Reducer>> = {
  /**
   * A retrospective proposed: by an agent, naming the `memory` checkpoint of its own write (opened
   * by the same agent, by the event this one chains on), of the same scope, named by no other.
   */
  [MEMORY_EVENT_TYPES.retrospectiveProposed]: (draft, event) => {
    const agent = event.actor.kind === "agent" ? event.actor.agent : undefined;
    const payload = event.payload as RetrospectiveProposedPayload;
    const id = retroIdOf(event.id);
    const checkpoint = checkpointOf(draft, payload.checkpoint);
    const known = retrosOf(draft.state);
    const record = checkpoint?.memory ?? undefined;
    if (
      agent === undefined ||
      checkpoint === undefined ||
      checkpoint.type !== "memory" ||
      record?.kind !== "retrospective" ||
      record.scope.kind !== payload.scope.kind ||
      record.scope.id !== payload.scope.id ||
      checkpoint.opened_by !== agent ||
      draft.parents.get(event.id) !== checkpoint.opened_event ||
      Object.hasOwn(known, id) ||
      Object.values(known).some((retro) => retro.checkpoint === payload.checkpoint)
    ) {
      invalid(draft, event.id);
      return;
    }
    let memory = draft.state.memory as { retros?: Record<string, RetroState> } | undefined;
    if (memory === undefined) {
      memory = {};
      draft.state.memory = memory;
    }
    memory.retros ??= dictionary<RetroState>();
    memory.retros[id] = {
      id,
      event: event.id,
      at: event.at,
      proposed_by: agent,
      checkpoint: payload.checkpoint,
      scope: payload.scope,
      summary: payload.summary,
      lessons: payload.lessons.map((lesson, index) => ({
        ...lesson,
        id: lessonIdOf(id, index + 1),
      })),
      retire: payload.retire,
      actions: payload.actions.map((action, index) => ({
        ...action,
        id: actionIdOf(id, index + 1),
      })),
    };
  },
  /**
   * The lessons of an approved retrospective recorded (clear event): anchors and a batch, the
   * checkpoint marked done. Ignored (`invalid`) for a checkpoint that is no retrospective's, one
   * already done, a lesson id not drawn from the retrospective named, or one already anchored.
   */
  [LESSON_EVENT_TYPES.recorded]: (draft, event) => {
    const payload = event.payload as LessonsRecordedPayload;
    const checkpoint = checkpointOf(draft, payload.checkpoint);
    const known = anchors(draft);
    const prefix = `L-${payload.retro.slice(2)}-`;
    if (
      event.actor.kind !== "agent" ||
      checkpoint === undefined ||
      checkpoint.type !== "memory" ||
      checkpoint.memory?.kind !== "retrospective" ||
      (checkpoint.memory_done ?? null) !== null ||
      payload.lessons.some(
        (lesson) => !lesson.id.startsWith(prefix) || Object.hasOwn(known, lesson.id),
      )
    ) {
      invalid(draft, event.id);
      return;
    }
    for (const lesson of payload.lessons) {
      known[lesson.id] = {
        id: lesson.id,
        retro: payload.retro,
        checkpoint: payload.checkpoint,
        digest: lesson.digest,
        at: event.at,
        event: event.id,
        promoted: [],
      };
    }
    const log = (draft.state.lessons_log as LessonBatch[] | undefined) ?? [];
    log.push({
      event: event.id,
      at: event.at,
      checkpoint: payload.checkpoint,
      retro: payload.retro,
      retired: payload.retired.map((entry) => ({ ...entry })),
      excepted: [...payload.excepted],
    });
    draft.state.lessons_log = log;
    checkpoint.memory_done = { event: event.id, at: event.at };
  },
  /** A lesson promoted to the common memory (clear event): marked on the lesson and the checkpoint. */
  [LESSON_EVENT_TYPES.promoted]: (draft, event) => {
    const payload = event.payload as LessonsPromotedPayload;
    const checkpoint = checkpointOf(draft, payload.checkpoint);
    const anchor = Object.hasOwn(anchors(draft), payload.lesson)
      ? anchors(draft)[payload.lesson]
      : undefined;
    if (
      event.actor.kind !== "agent" ||
      checkpoint === undefined ||
      checkpoint.type !== "memory" ||
      checkpoint.memory?.kind !== "promotion" ||
      checkpoint.memory.lesson !== payload.lesson ||
      payload.common !== commonIdOf(payload.checkpoint) ||
      (checkpoint.memory_done ?? null) !== null ||
      anchor === undefined
    ) {
      invalid(draft, event.id);
      return;
    }
    anchor.promoted.push({ common: payload.common, checkpoint: payload.checkpoint, at: event.at });
    checkpoint.memory_done = { event: event.id, at: event.at };
  },
};
