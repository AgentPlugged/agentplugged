import {
  CREATOR_OWNER,
  canonicalStoryId,
  type DeferredOrigin,
  type DeferredOutcome,
  ErrorCode,
  type LockedAction,
  type PhaseId,
  StoryIdSchema,
} from "@agentplugged/protocol";
import { AgentPluggedError } from "../errors.js";
import { isSkipped } from "../journey/journey-rules.js";
import { byEvent, recordById, recordsOf } from "../registers.js";

/**
 * The register of deferred work, as the projection builds it: pure rules, read by
 * `get_state`, `next`, `update_story`, and by the start and the merge of
 * a story. Every helper returns copies: the projection's own objects never leave this module.
 */

/** How an item was closed, by whom and why. */
export interface DeferredClosing {
  readonly outcome: DeferredOutcome;
  readonly reason: string;
  /** The agent, or the creator's device (`human:…`). */
  readonly by: string;
  readonly at: string;
  /** The ULID of the `deferred.closed` event. */
  readonly event: string;
}

/** `state.deferred[id]`: one item of the register. */
export interface DeferredItem {
  /** `D-` then the last 10 characters of the ULID of the event that recorded it. */
  readonly id: string;
  readonly title: string;
  readonly detail: string | null;
  readonly origin: DeferredOrigin;
  /** The story it comes from, or null. */
  readonly story: string | null;
  /** Who treats it: an agent, or `creator`. */
  readonly owner: string;
  /** The stories it locks while open. */
  readonly locks: readonly string[];
  /** The phase to treat it in (a hint), or null. */
  readonly phase: PhaseId | null;
  readonly status: "open" | DeferredOutcome;
  /** The agent that recorded it. */
  readonly recorded_by: string;
  readonly recorded_at: string;
  /** The ULID of the `deferred.recorded` event: the recording order. */
  readonly event: string;
  readonly closed: DeferredClosing | null;
}

/** A copy of an item, its lists and its closing copied too. */
function copyOf(item: DeferredItem): DeferredItem {
  return {
    ...item,
    locks: [...item.locks],
    closed: item.closed === null ? null : { ...item.closed },
  };
}

const itemsOf = (state: Readonly<Record<string, unknown>>) =>
  recordsOf<DeferredItem>(state, "deferred");

/** Every item of a projection's state, copied, in recording order. */
export function deferredItems(state: Readonly<Record<string, unknown>>): DeferredItem[] {
  return Object.values(itemsOf(state)).sort(byEvent).map(copyOf);
}

/** The open items, copied, in recording order. */
export function openDeferred(state: Readonly<Record<string, unknown>>): DeferredItem[] {
  return deferredItems(state).filter((item) => item.status === "open");
}

/** A story id in its canonical form, when it is one (`02-06` → `2-6`); else as given. */
function storyKey(storyId: string): string {
  return StoryIdSchema.safeParse(storyId).success ? canonicalStoryId(storyId) : storyId;
}

/**
 * The open items that lock `storyId` (any form: `02-06` is `2-6`), copied, in recording order:
 * while any is, the story neither starts nor merges.
 */
export function deferredLocks(
  state: Readonly<Record<string, unknown>>,
  storyId: string,
): DeferredItem[] {
  const key = storyKey(storyId);
  return openDeferred(state).filter((item) => item.locks.includes(key));
}

/**
 * `STORY_LOCKED` when an open item locks `storyId` and the story would `start` or `merge`, else
 * undefined. The start and the merge call it on the state read under
 * the journal lock.
 */
export function storyLockProblem(
  state: Readonly<Record<string, unknown>>,
  storyId: string,
  action: LockedAction,
): AgentPluggedError | undefined {
  // The creator skipped the lock of open deferred work (for this story or all).
  if (isSkipped(state, "story_deferred", storyKey(storyId))) return undefined;
  const locks = deferredLocks(state, storyId);
  const [first] = locks;
  if (first === undefined) return undefined;
  return new AgentPluggedError(
    ErrorCode.STORY_LOCKED,
    locks.length === 1 ? "error.story_locked.one" : "error.story_locked.other",
    {
      story: storyKey(storyId),
      action,
      count: locks.length,
      items: locks.map((item) => item.id),
      first: first.id,
      title: first.title,
    },
  );
}

/**
 * True when `agent` may close `item` (`complete_deferred`): its owner when the owner is an agent,
 * or the agent that recorded it. An item the creator owns closes only at the creator's terminal.
 * The reducer applies the same rule.
 */
export function agentMayClose(
  item: Pick<DeferredItem, "owner" | "recorded_by">,
  agent: string,
): boolean {
  if (item.owner === CREATOR_OWNER) return false;
  return agent === item.owner || agent === item.recorded_by;
}

/** What `get_state` shows of the register. */
export interface DeferredView {
  /** The open items, in recording order. */
  readonly open: readonly DeferredItem[];
  /** How many items were done. */
  readonly done: number;
  /** How many items were dropped. */
  readonly dropped: number;
}

/** The register as `get_state` and `deferred list` show it: copies. */
export function deferredView(state: Readonly<Record<string, unknown>>): DeferredView {
  const all = deferredItems(state);
  return {
    open: all.filter((item) => item.status === "open"),
    done: all.filter((item) => item.status === "done").length,
    dropped: all.filter((item) => item.status === "dropped").length,
  };
}

/** The item `id` (canonical: `D-` and upper case), copied: else `DEFERRED_NOT_FOUND`. */
export function findItem(
  state: Readonly<Record<string, unknown>>,
  id: string,
): DeferredItem | AgentPluggedError {
  const items = itemsOf(state);
  const item = recordById(items, id);
  if (item === undefined) {
    return new AgentPluggedError(ErrorCode.DEFERRED_NOT_FOUND, "error.deferred_not_found", {
      item: id,
    });
  }
  return copyOf(item);
}

/** The open item `id` (canonical), copied: else `DEFERRED_NOT_FOUND`, or `DEFERRED_NOT_OPEN`. */
export function openItem(
  state: Readonly<Record<string, unknown>>,
  id: string,
): DeferredItem | AgentPluggedError {
  const item = findItem(state, id);
  if (item instanceof AgentPluggedError) return item;
  if (item.status !== "open") {
    return new AgentPluggedError(ErrorCode.DEFERRED_NOT_OPEN, "error.deferred_not_open", {
      item: id,
      status: item.status,
    });
  }
  return item;
}

/**
 * `DEFERRED_CLOSING_IGNORED` unless the projection applied the closing `event` to item `id`: the
 * check a closing runs once written (another machine's clock may order it before the item).
 */
export function closingProblem(
  state: Readonly<Record<string, unknown>>,
  id: string,
  event: string,
): AgentPluggedError | undefined {
  const item = findItem(state, id);
  if (!(item instanceof AgentPluggedError) && item.closed?.event === event) return undefined;
  return new AgentPluggedError(
    ErrorCode.DEFERRED_CLOSING_IGNORED,
    "error.deferred_closing_ignored",
    { item: id, event },
  );
}
