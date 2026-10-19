import {
  type EventEnvelope,
  ORDER_EVENT_TYPES,
  type OrderAppliedPayload,
  OrderAppliedPayloadSchema,
  type OrderRejectedPayload,
} from "@agentplugged/protocol";
import type { StateStore } from "../journal/state-store.js";

/**
 * The record of an applied order: `order.applied`, written by the bridge as a system actor, keeps
 * the order with the signature of the device that gave it. Whoever reads the journal can check
 * that signature with the key the registry of trusted devices gives, without the bridge.
 */

class AlreadyApplied extends Error {}

/** The orders the journal records as applied, in the order of the events. */
export function appliedOrders(events: readonly EventEnvelope[]): OrderAppliedPayload[] {
  const found: OrderAppliedPayload[] = [];
  for (const event of events) {
    if (event.type !== ORDER_EVENT_TYPES.applied) continue;
    const parsed = OrderAppliedPayloadSchema.safeParse(event.payload);
    if (parsed.success) found.push(parsed.data);
  }
  return found;
}

/** The highest sequence number of an applied order, per device. */
export function lastAppliedSequences(events: readonly EventEnvelope[]): Map<string, number> {
  const last = new Map<string, number>();
  for (const { order } of appliedOrders(events)) {
    if ((last.get(order.device) ?? 0) < order.seq) last.set(order.device, order.seq);
  }
  return last;
}

/** What a write of `order.applied` did: the event, and whether this call wrote it. */
export interface OrderAppliedWrite {
  readonly written: boolean;
  readonly event: EventEnvelope;
}

function recordOf(events: readonly EventEnvelope[], order: string): EventEnvelope | undefined {
  return events.find(
    (event) =>
      event.type === ORDER_EVENT_TYPES.applied &&
      (event.payload as { order?: { id?: unknown } } | undefined)?.order?.id === order,
  );
}

/** The event that records the order as applied, or undefined. */
export async function findOrderApplied(
  journal: StateStore,
  order: string,
): Promise<EventEnvelope | undefined> {
  return recordOf((await journal.list()).events, order);
}

function rejectionOf(events: readonly EventEnvelope[], order: string): EventEnvelope | undefined {
  return events.find(
    (event) =>
      (event.type === ORDER_EVENT_TYPES.rejected || event.type === ORDER_EVENT_TYPES.applied) &&
      (event.payload as { order?: { id?: unknown } | string } | undefined)?.order !== undefined &&
      ((event.payload as { order: { id?: unknown } | string }).order === order ||
        (event.payload as { order: { id?: unknown } }).order.id === order),
  );
}

/**
 * Writes `order.rejected` once per order, unless the journal already records the order as applied
 * or rejected: the refusal of an order the machine did not apply is a fact the journal keeps, and
 * every view then shows it. A second call returns the first event.
 */
export async function writeOrderRejected(
  journal: StateStore,
  product: string,
  payload: OrderRejectedPayload,
): Promise<OrderAppliedWrite> {
  try {
    const [event] = await journal.appendAll(
      [
        {
          type: ORDER_EVENT_TYPES.rejected,
          actor: { kind: "system" },
          product,
          provenance: "trusted",
          payload,
        },
      ],
      {
        precondition: (listing) => {
          if (rejectionOf(listing.events, payload.order) !== undefined) throw new AlreadyApplied();
        },
      },
    );
    if (event === undefined) throw new Error("no event was written");
    return { written: true, event };
  } catch (error) {
    if (!(error instanceof AlreadyApplied)) throw error;
    const existing = rejectionOf((await journal.list()).events, payload.order);
    if (existing === undefined) throw error;
    return { written: false, event: existing };
  }
}

/** Writes `order.applied` once per order: a second call (a restart) returns the first event. */
export async function writeOrderApplied(
  journal: StateStore,
  product: string,
  payload: OrderAppliedPayload,
): Promise<OrderAppliedWrite> {
  try {
    const [event] = await journal.appendAll(
      [
        {
          type: ORDER_EVENT_TYPES.applied,
          actor: { kind: "system" },
          product,
          provenance: "trusted",
          payload,
        },
      ],
      {
        // Under the journal's lock, on the listing the event is written on: a second run (after
        // a cut between the effect and the record) never writes the same order twice.
        precondition: (listing) => {
          if (recordOf(listing.events, payload.order.id) !== undefined) throw new AlreadyApplied();
        },
      },
    );
    if (event === undefined) throw new Error("no event was written");
    return { written: true, event };
  } catch (error) {
    if (!(error instanceof AlreadyApplied)) throw error;
    const existing = recordOf((await journal.list()).events, payload.order.id);
    if (existing === undefined) throw error;
    return { written: false, event: existing };
  }
}
