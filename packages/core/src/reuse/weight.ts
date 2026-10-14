import type { CommandContext } from "../command.js";
import { mergedStoriesOf } from "../docs/knowledge-freshness.js";
import { parseDiff } from "../review/review-rules.js";
import { addedLinesOf, codeLines, reuseOf, type StoryWeight } from "./reuse.js";

/**
 * The weight of the code a story leaves. The journal keeps, for each
 * merged story, the lines of code it added and removed and the duplicates it added; the engine says
 * to the creator, in one line, when the last stories only add: a cleanup story is then proposed.
 */

/** Longest the merge waits for the detector (milliseconds). */
const MERGE_MAX_MS = 10_000;

/**
 * The weight of a story's diff: its code lines, and the duplicates in what it added (when the
 * repository can be read at `commit`; else none are counted, 0). Undefined without a diff.
 */
export async function storyWeight(
  context: CommandContext,
  diff: string | undefined,
  commit: string,
): Promise<StoryWeight | undefined> {
  if (diff === undefined) return undefined;
  try {
    const files = parseDiff(diff);
    if (addedLinesOf(files).size === 0) return { ...codeLines(files), duplicates: 0 };
    const report = await reuseOf(context, files, commit, { maxMs: MERGE_MAX_MS });
    // Duplicates are counted only when the engine really looked: unknown is not zero.
    return {
      ...codeLines(files),
      ...(report === undefined || report.partial ? {} : { duplicates: report.duplicates.length }),
    };
  } catch {
    return undefined;
  }
}

/** A merged story with its weight, in the order of the merges. */
export interface WeighedStory {
  readonly story: string;
  readonly seq: number;
  readonly weight: Required<StoryWeight>;
}

/** Stories looked at to tell a drift. */
export const DRIFT_WINDOW = 5;
/** Stories needed in the window (with a weight recorded) before saying anything. */
export const DRIFT_MIN_STORIES = 3;
/** The window added this many duplicates, or this many lines of code with hardly any removed. */
export const DRIFT_DUPLICATES = 5;
export const DRIFT_NET_LINES = 2_000;
export const DRIFT_REMOVED_RATIO = 0.15;

/** The merged stories whose weight the journal kept, in the order of the merges. */
export function weighedStoriesOf(state: Readonly<Record<string, unknown>>): WeighedStory[] {
  return mergedStoriesOf(state).flatMap((merged) =>
    merged.weight === undefined
      ? []
      : [
          {
            story: merged.story,
            seq: merged.seq,
            weight: {
              added: merged.weight.added,
              removed: merged.weight.removed,
              duplicates: merged.weight.duplicates ?? 0,
            },
          },
        ],
  );
}

/**
 * The one line told to the creator when the weight of the code drifts, else undefined: over the
 * last `DRIFT_WINDOW` weighed stories (at least `DRIFT_MIN_STORIES`), `DRIFT_DUPLICATES` duplicates
 * added, or `DRIFT_NET_LINES` lines of code more with fewer than `DRIFT_REMOVED_RATIO` of what
 * was added removed. It proposes a cleanup story.
 */
export function weightDrift(stories: readonly WeighedStory[]): string | undefined {
  const window = stories.slice(-DRIFT_WINDOW);
  if (window.length < DRIFT_MIN_STORIES) return undefined;
  const added = window.reduce((sum, story) => sum + story.weight.added, 0);
  const removed = window.reduce((sum, story) => sum + story.weight.removed, 0);
  const duplicates = window.reduce((sum, story) => sum + story.weight.duplicates, 0);
  const heavy = added - removed >= DRIFT_NET_LINES && removed < added * DRIFT_REMOVED_RATIO;
  if (duplicates < DRIFT_DUPLICATES && !heavy) return undefined;
  return `Code weight: the last ${window.length} merged stories added ${added} lines of code (${removed} removed) and ${duplicates} duplicate(s); a cleanup story is proposed (merge the copies, remove what is unused).`;
}
