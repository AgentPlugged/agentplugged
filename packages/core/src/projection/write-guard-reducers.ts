import {
  type EventEnvelope,
  WRITE_GUARD_EVENT_TYPES,
  type WriteDoubtedPayload,
  type WriteRefusedPayload,
  type WriteRule,
} from "@agentplugged/protocol";
import { nextRefusal, type RefusalRepeat } from "../loop/repeat-rules.js";
import type { StoryState } from "./agent-reducers.js";
import { openStory } from "./ci-reducers.js";
import type { ProjectionDraft, Reducer } from "./reducers.js";

/**
 * What the guard before a write did: the writes it refused, by rule, and the writes it
 * let through in doubt. Counts only: the journal holds the events, the review reads the counts.
 */
export interface WriteGuardCounts {
  refused: Record<WriteRule, number>;
  doubted: number;
  /** The files of a story the guard refused a write on (distinct, bounded). */
  paths?: string[];
  /** The latest refused write of a story and how many times in a row it was refused. */
  repeat?: RefusalRepeat;
}

/** The files of a story whose refused writes are kept, at most. */
export const MAX_GUARD_PATHS = 20;

const empty = (): WriteGuardCounts => ({
  refused: { secret: 0, scope: 0, decision: 0, test: 0 },
  doubted: 0,
});

/** `state.write_guard`: the counts of the whole product (a write outside any story counts here only). */
function totalOf(draft: ProjectionDraft): WriteGuardCounts {
  const existing = draft.state.write_guard as WriteGuardCounts | undefined;
  if (existing !== undefined) return existing;
  const created = empty();
  draft.state.write_guard = created;
  return created;
}

/** The counts of the story the event names, when it is a story of the journal. */
function storyCounts(draft: ProjectionDraft, event: EventEnvelope): WriteGuardCounts | undefined {
  const stories = draft.state.stories as Record<string, StoryState> | undefined;
  const id = event.story;
  if (id === undefined || stories === undefined || !Object.hasOwn(stories, id)) return undefined;
  const story = stories[id] as StoryState;
  story.write_guard ??= empty();
  return story.write_guard;
}

/** The reducers of the guard before a write: the counts, in projection order. */
export const WRITE_GUARD_REDUCERS: Readonly<Record<string, Reducer>> = {
  [WRITE_GUARD_EVENT_TYPES.refused]: (draft, event) => {
    const payload = event.payload as WriteRefusedPayload;
    totalOf(draft).refused[payload.rule]++;
    const story = storyCounts(draft, event);
    if (story !== undefined) {
      story.refused[payload.rule]++;
      const paths = story.paths ?? [];
      if (paths.length < MAX_GUARD_PATHS && !paths.includes(payload.path)) paths.push(payload.path);
      story.paths = paths;
      story.repeat = nextRefusal(story.repeat, payload.rule, payload.path, event.at);
    }
  },
  [WRITE_GUARD_EVENT_TYPES.doubted]: (draft, event) => {
    void (event.payload as WriteDoubtedPayload);
    totalOf(draft).doubted++;
    const story = storyCounts(draft, event);
    if (story !== undefined) story.doubted++;
  },
};

/**
 * Carries out a `scope_widen` the creator approved: the paths join the story's scope.
 * False when the story is not started or is done (nothing to widen).
 */
export function applyScopeWidening(
  draft: ProjectionDraft,
  story: string,
  paths: readonly string[],
): boolean {
  const open = openStory(draft, { story } as EventEnvelope);
  if (open === undefined) return false;
  const widened = open.scope_widened ?? [];
  for (const path of paths) if (!widened.includes(path)) widened.push(path);
  open.scope_widened = widened;
  return true;
}
