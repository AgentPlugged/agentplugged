import {
  DEFERRED_EVENT_TYPES,
  type DeferredClosedPayload,
  type DeferredRecordedPayload,
  deferredIdOf,
} from "@agentplugged/protocol";
import { agentMayClose, type DeferredItem } from "../deferred/deferred-rules.js";
import { recordById } from "../registers.js";
import { section } from "./agent-reducers.js";
import { closerOf } from "./human-reducers.js";
import type { ProjectionDraft, Reducer } from "./reducers.js";

const itemsOf = (draft: ProjectionDraft) => section<DeferredItem>(draft, "deferred");

/**
 * The reducers of the register of deferred work: `state.deferred[id]`, each item as
 * its `deferred.recorded` event wrote it, then its closing. Ignored (`invalid`): an item recorded
 * by another actor than an agent, an id already taken, a review finding without a story; a
 * closing of an unknown or closed item, an agent's drop, or an agent's closing of an item it may
 * not close (`agentMayClose`: neither its owner nor its recorder, or an item the creator owns). A
 * creator's closing follows the rules of an answer (`unknown_signer`, `unendorsed_human`).
 */
export const DEFERRED_REDUCERS: Readonly<Record<string, Reducer>> = {
  [DEFERRED_EVENT_TYPES.recorded]: (draft, event) => {
    const items = itemsOf(draft);
    const agent = event.actor.kind === "agent" ? event.actor.agent : undefined;
    const id = deferredIdOf(event.id);
    const payload = event.payload as DeferredRecordedPayload;
    const story = event.story ?? null;
    if (
      agent === undefined ||
      Object.hasOwn(items, id) ||
      (payload.origin === "review" && story === null)
    ) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    items[id] = {
      id,
      title: payload.title,
      detail: payload.detail ?? null,
      origin: payload.origin,
      story,
      owner: payload.owner,
      locks: [...payload.locks],
      phase: payload.phase ?? null,
      status: "open",
      recorded_by: agent,
      recorded_at: event.at,
      event: event.id,
      closed: null,
    };
  },
  [DEFERRED_EVENT_TYPES.closed]: (draft, event) => {
    const items = itemsOf(draft);
    const payload = event.payload as DeferredClosedPayload;
    const item = recordById(items, payload.item);
    const closer = closerOf(
      draft,
      event,
      (agent) => payload.outcome === "done" && item !== undefined && agentMayClose(item, agent),
    );
    if (closer.refusal !== undefined) {
      draft.ignored.push({ id: event.id, reason: closer.refusal });
      return;
    }
    const by = closer.by;
    if (by === undefined || item === undefined || item.status !== "open") {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    applyDeferredClosing(draft, payload.item, {
      outcome: payload.outcome,
      reason: payload.reason,
      by,
      at: event.at,
      event: event.id,
    });
  },
};

/**
 * Closes an open item of deferred work: the effect of `deferred.closed` and of a
 * `deferred_resolve` or `deferred_drop` the creator approved from the chat. False,
 * nothing changed, when the item is unknown or closed.
 */
export function applyDeferredClosing(
  draft: ProjectionDraft,
  id: string,
  closing: DeferredItem["closed"] & {},
): boolean {
  const items = itemsOf(draft);
  const item = recordById(items, id);
  if (item === undefined || item.status !== "open") return false;
  items[id] = {
    ...item,
    status: closing.outcome,
    closed: {
      outcome: closing.outcome,
      reason: closing.reason,
      by: closing.by,
      at: closing.at,
      event: closing.event,
    },
  };
  return true;
}
