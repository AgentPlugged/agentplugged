import { compareStoryIds, type MergeWaitReason } from "@agentplugged/protocol";

export { compareStoryIds };

/**
 * The order of the merges. Among the stories ready to merge, the order follows
 * the dependency graph of the stories, then the sprint in force, then the opening of the merge
 * checkpoint, then the story's number. It is total and deterministic: it depends only on what the
 * creator validated (the stories' headers, the sprint) and on the journal. No tool takes an order.
 * Pure.
 */

/** A story ready to merge: its merge checkpoint is open and its merge gate is open. */
export interface ReadyStory {
  readonly id: string;
  /** The ULID of the event that opened its merge checkpoint: the opening order. */
  readonly opened: string;
  /** Its dependencies, from its header. */
  readonly depends_on: readonly string[];
}

/** One ready story in the order. */
export interface OrderEntry {
  readonly story: string;
  /** 1-based; 0 for a story in a dependency cycle (it has no place). */
  readonly position: number;
  /** Its dependencies that are ready too: they merge first. */
  readonly after: readonly string[];
  /** Its dependencies that are neither done nor ready: it cannot merge yet. */
  readonly unmerged: readonly string[];
  /** It belongs to a dependency cycle, or depends on a story that does. */
  readonly cycle: boolean;
}

/**
 * The order of the ready stories. `done` holds the stories already delivered; `sprint` the
 * sprint in force's stories in its order (the others come after). Stories whose dependencies loop
 * have `position` 0 and come last, by number.
 */
export function mergeOrder(input: {
  readonly ready: readonly ReadyStory[];
  readonly done: ReadonlySet<string>;
  readonly sprint: readonly string[];
}): OrderEntry[] {
  const byId = new Map(input.ready.map((story) => [story.id, story]));
  const sprintIndex = new Map(input.sprint.map((id, index) => [id, index]));
  const rank = (a: ReadyStory, b: ReadyStory) => {
    const ia = sprintIndex.get(a.id) ?? Number.POSITIVE_INFINITY;
    const ib = sprintIndex.get(b.id) ?? Number.POSITIVE_INFINITY;
    if (ia !== ib) return ia < ib ? -1 : 1;
    if (a.opened !== b.opened) return a.opened < b.opened ? -1 : 1;
    return compareStoryIds(a.id, b.id);
  };
  const readyDeps = (story: ReadyStory) =>
    [...new Set(story.depends_on)].filter(
      (id) => byId.has(id) && id !== story.id && !input.done.has(id),
    );
  const unmergedDeps = (story: ReadyStory) =>
    [...new Set(story.depends_on)].filter((id) => !byId.has(id) && !input.done.has(id));
  const placed: ReadyStory[] = [];
  const remaining = new Set(input.ready.map((story) => story.id));
  for (;;) {
    const available = [...remaining]
      .map((id) => byId.get(id) as ReadyStory)
      .filter((story) => readyDeps(story).every((id) => !remaining.has(id)))
      .sort(rank);
    const next = available[0];
    if (next === undefined) break;
    placed.push(next);
    remaining.delete(next.id);
  }
  const looped = [...remaining]
    .map((id) => byId.get(id) as ReadyStory)
    .sort((a, b) => compareStoryIds(a.id, b.id));
  const entry = (story: ReadyStory, position: number, cycle: boolean): OrderEntry => ({
    story: story.id,
    position,
    after: readyDeps(story).sort(compareStoryIds),
    unmerged: unmergedDeps(story).sort(compareStoryIds),
    cycle,
  });
  return [
    ...placed.map((story, index) => entry(story, index + 1, false)),
    ...looped.map((story) => entry(story, 0, true)),
  ];
}

/** What holds a story back: the earlier story, and why. */
export interface MergeWait {
  readonly story: string;
  readonly why: MergeWaitReason;
}

/**
 * The stories that must merge before `story`: its ready dependencies (always), and every ready
 * story earlier in the order that shares a file with it. A story whose files are unknown
 * (`undefined`) overlaps every other one. `files` gives, by story, the paths it changes.
 */
export function mergeWaits(
  order: readonly OrderEntry[],
  story: string,
  files: ReadonlyMap<string, ReadonlySet<string> | undefined>,
): MergeWait[] {
  const mine = order.find((entry) => entry.story === story);
  if (mine === undefined || mine.position === 0) return [];
  const own = files.get(story);
  const waits: MergeWait[] = [];
  for (const earlier of order) {
    if (earlier.position === 0 || earlier.position >= mine.position) continue;
    if (mine.after.includes(earlier.story)) {
      waits.push({ story: earlier.story, why: "dependency" });
      continue;
    }
    const other = files.get(earlier.story);
    const overlap =
      own === undefined || other === undefined || [...own].some((path) => other.has(path));
    if (overlap) waits.push({ story: earlier.story, why: "overlap" });
  }
  return waits;
}

/**
 * Merge checkpoints in the order they are presented to the creator when the dependencies and the
 * files are not known (`next`, from the journal alone): the sprint in force's order, then the
 * opening of the checkpoint, then the story's number. The engine's own order (`mergeOrder`) also
 * reads the dependencies and refuses a merge out of it.
 */
export function queueOrder<
  T extends { readonly story: string | null; readonly opened_event: string },
>(items: readonly T[], sprint: readonly string[]): T[] {
  const index = new Map(sprint.map((id, position) => [id, position]));
  const rank = (item: T) => index.get(item.story ?? "") ?? Number.POSITIVE_INFINITY;
  return [...items].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra < rb ? -1 : 1;
    if (a.opened_event !== b.opened_event) return a.opened_event < b.opened_event ? -1 : 1;
    return compareStoryIds(a.story ?? "", b.story ?? "");
  });
}
