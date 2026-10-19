import {
  type EventEnvelope,
  MACHINE_EVENT_TYPES,
  type PrimaryChangedPayload,
} from "@agentplugged/protocol";
import { hashOf } from "../journal/prepare-event.js";
import type { StateStore } from "../journal/state-store.js";
import { computeProjection } from "../projection/compute-projection.js";

/**
 * The facts a bridge reads from a product's journal before it accepts to become the main bridge:
 * the bridge that is main now (or null), the hashes of the events it holds, and the head of each
 * writer's chain it holds. `planPrimaryChange` decides on them.
 */
export interface PrimaryJournalFacts {
  readonly current: string | null;
  readonly known: ReadonlySet<string>;
  /** The head hash of each writer's chain in this journal. */
  readonly heads: Readonly<Record<string, string>>;
}

export async function readPrimaryFacts(
  journal: StateStore,
  product: string,
): Promise<PrimaryJournalFacts> {
  const listing = await journal.list();
  const projection = await computeProjection(listing.events, {
    problems: listing.problems,
    head: listing.head,
    product,
  });
  const primary = (projection.state as { primary_bridge?: { bridge?: string } }).primary_bridge;
  const known = new Set<string>();
  const heads: Record<string, string> = {};
  for (const event of listing.events) {
    const hash = hashOf(event);
    known.add(hash);
    // Events are sorted by id: the last one of each writer is its head.
    heads[event.actor.device] = hash;
  }
  return { current: primary?.bridge ?? null, known, heads };
}

/** Writes `bridge.primary_changed` as the system actor of the machine that becomes the main bridge. */
export async function writePrimaryChange(
  journal: StateStore,
  product: string,
  payload: PrimaryChangedPayload,
): Promise<EventEnvelope> {
  return await journal.append({
    type: MACHINE_EVENT_TYPES.primaryChanged,
    actor: { kind: "system" },
    product,
    provenance: "trusted",
    payload,
  });
}
