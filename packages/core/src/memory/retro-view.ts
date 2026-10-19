import {
  DOCS_LESSONS_MAX,
  DOCS_RETROS_MAX,
  DOCS_TEXT_MAX_CHARS,
  DOCS_TITLE_MAX_CHARS,
  type DocsRetro,
  type DocsRetrosData,
  type RetroLessonStatus,
  type RetroStatus,
} from "@agentplugged/protocol";
import { statusAt } from "../checkpoints/resolution-rules.js";
import { type CheckpointState, checkpointsOf } from "../projection/checkpoint-reducers.js";
import {
  anchorsOf,
  approved,
  lessonStatuses,
  memoryOf,
  type RetroState,
  retrosOf,
} from "./memory-rules.js";

/**
 * The retrospectives of a product and the lessons in force, as the web view reads them: pure rules
 * over the projection's state. The content of a retrospective is encrypted with the product key,
 * so it is in the state only when the projection was computed with the key; a retrospective whose
 * content is not there is counted, never guessed. Nothing is written anywhere.
 */

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Where a retrospective stands: the creator's answer to its checkpoint decides. */
export function retroStatus(checkpoint: CheckpointState | undefined, now: number): RetroStatus {
  if (checkpoint === undefined) return "open";
  if (statusAt(checkpoint, now) === "open") return "open";
  if (approved(checkpoint, now)) return "approved";
  return checkpoint.resolution?.decision === "changes_requested"
    ? "changes_requested"
    : "dismissed";
}

function retroOf(
  retro: RetroState,
  status: RetroStatus,
  lessonStates: ReadonlyMap<string, string>,
): DocsRetro {
  const lessonStatus = (id: string): RetroLessonStatus => {
    const known = lessonStates.get(id);
    if (known === "active" || known === "retired" || known === "superseded") return known;
    return status === "changes_requested" || status === "dismissed" ? "not_kept" : "proposed";
  };
  return {
    id: retro.id,
    scope: { kind: retro.scope.kind, id: retro.scope.id },
    at: retro.at,
    proposed_by: retro.proposed_by,
    status,
    summary: cut(retro.summary, DOCS_TEXT_MAX_CHARS),
    lessons: retro.lessons.map((lesson) => ({
      id: lesson.id,
      title: cut(lesson.title, DOCS_TITLE_MAX_CHARS),
      text: cut(lesson.text, DOCS_TEXT_MAX_CHARS),
      tags: [...(lesson.tags ?? [])],
      agents: [...(lesson.agents ?? [])],
      status: lessonStatus(lesson.id),
    })),
    retire: retro.retire.map((entry) => ({
      lesson: entry.lesson,
      reason: cut(entry.reason, DOCS_TEXT_MAX_CHARS),
    })),
    actions: retro.actions.map((action) => ({
      id: action.id,
      text: cut(action.text, DOCS_TEXT_MAX_CHARS),
      ...(action.owner === undefined ? {} : { owner: action.owner }),
    })),
  };
}

export function retrospectivesView(
  state: Readonly<Record<string, unknown>>,
  now: number,
): Omit<DocsRetrosData, "op"> {
  const checkpoints = checkpointsOf(state);
  const lessonStates = lessonStatuses(state, checkpoints, now);
  const retros = Object.values(retrosOf(state)).sort((a, b) =>
    a.event < b.event ? 1 : a.event > b.event ? -1 : 0,
  );
  const read = new Set(retros.map((retro) => retro.checkpoint));
  const unreadable = Object.values(checkpoints).filter(
    (checkpoint) => memoryOf(checkpoint)?.kind === "retrospective" && !read.has(checkpoint.id),
  ).length;
  const byId = new Map(retros.map((retro) => [retro.id, retro]));
  const memory = Object.values(anchorsOf(state))
    .filter((anchor) => lessonStates.get(anchor.id) === "active")
    .sort((a, b) => (a.event < b.event ? 1 : a.event > b.event ? -1 : a.id < b.id ? -1 : 1))
    .flatMap((anchor) => {
      const lesson = byId.get(anchor.retro)?.lessons.find((entry) => entry.id === anchor.id);
      if (lesson === undefined) return [];
      return [
        {
          id: anchor.id,
          title: cut(lesson.title, DOCS_TITLE_MAX_CHARS),
          text: cut(lesson.text, DOCS_TEXT_MAX_CHARS),
          tags: [...(lesson.tags ?? [])],
          agents: [...(lesson.agents ?? [])],
          at: anchor.at,
          retro: anchor.retro,
          promoted: anchor.promoted.length > 0,
        },
      ];
    })
    .slice(0, DOCS_LESSONS_MAX);
  return {
    retrospectives: retros
      .slice(0, DOCS_RETROS_MAX)
      .map((retro) =>
        retroOf(retro, retroStatus(checkpoints[retro.checkpoint], now), lessonStates),
      ),
    memory,
    unreadable,
  };
}
