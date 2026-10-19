import {
  bridgeNeedsUpgrade,
  PRIMARY_ERROR_CODES,
  type PrimaryChangedPayload,
  type PrimaryErrorCode,
} from "@agentplugged/protocol";

/**
 * Choosing a product's main bridge (several machines, one account). Pure rules: the caller reads
 * the facts (the journal's trust registry, the heads of the journal each bridge holds) and writes
 * the `bridge.primary_changed` event the plan returns. The switch is manual: nothing here is called
 * on its own, and a bridge that goes offline never moves the main role.
 */

/** What is known of a bridge that could become the main one. */
export interface PrimaryCandidate {
  readonly bridge: string;
  /** A trusted machine of the product's journal (never the relay's word alone). */
  readonly trusted: boolean;
  /** The bridge serves this product. */
  readonly serves: boolean;
  /** The bridge answers now (fresh signed beat): an offline bridge would publish nothing. */
  readonly online: boolean;
  /** The protocol version the bridge speaks. */
  readonly protocol: number;
  /** The hashes of the journal events the bridge holds. */
  readonly known: ReadonlySet<string>;
}

export interface PrimaryChangeInput {
  /** The product's current main bridge, or null when none was chosen yet. */
  readonly current: string | null;
  readonly candidate: PrimaryCandidate;
  /**
   * The head of each writer's chain in the journal as the creator's device sees it, by writer.
   * The candidate must hold every one of them: no event is lost by the switch.
   */
  readonly heads: Readonly<Record<string, string>>;
  /** The current protocol version. */
  readonly protocol: number;
}

export type PrimaryChangePlan =
  /** `payload` is null when the candidate already is the main bridge: nothing to write. */
  | { readonly ok: true; readonly payload: PrimaryChangedPayload | null }
  | {
      readonly ok: false;
      readonly code: PrimaryErrorCode;
      /** For `PRIMARY_BRIDGE_NOT_SYNCED`: the writers whose latest events the candidate lacks. */
      readonly missing?: readonly string[];
    };

/** Whether the main bridge may change to `input.candidate`, and the event that records it. */
export function planPrimaryChange(input: PrimaryChangeInput): PrimaryChangePlan {
  const { candidate } = input;
  if (!candidate.trusted)
    return { ok: false, code: PRIMARY_ERROR_CODES.PRIMARY_BRIDGE_NOT_TRUSTED };
  if (bridgeNeedsUpgrade(candidate.protocol, input.protocol))
    return { ok: false, code: PRIMARY_ERROR_CODES.PRIMARY_BRIDGE_UPGRADE_REQUIRED };
  if (!candidate.online) return { ok: false, code: PRIMARY_ERROR_CODES.PRIMARY_BRIDGE_OFFLINE };
  if (!candidate.serves) return { ok: false, code: PRIMARY_ERROR_CODES.PRIMARY_BRIDGE_NOT_SERVING };
  // No head to compare with: the caller has not read the journal, so nothing is proven.
  if (Object.keys(input.heads).length === 0)
    return { ok: false, code: PRIMARY_ERROR_CODES.PRIMARY_BRIDGE_NOT_SYNCED, missing: [] };
  const missing = Object.entries(input.heads)
    .filter(([, head]) => !candidate.known.has(head))
    .map(([writer]) => writer)
    .sort();
  if (missing.length > 0)
    return { ok: false, code: PRIMARY_ERROR_CODES.PRIMARY_BRIDGE_NOT_SYNCED, missing };
  if (input.current === candidate.bridge) return { ok: true, payload: null };
  return { ok: true, payload: { bridge: candidate.bridge, previous: input.current } };
}

/** True when `self` publishes the product's projection: only the main bridge does. */
export function publishesProjection(self: string, primary: string | null): boolean {
  return primary !== null && self === primary;
}

/**
 * Whether `self` publishes the product's state to the views. The main bridge does. While no main
 * bridge was chosen, the only trusted machine of the journal does (a creator with one machine has
 * nothing to choose); with several trusted machines and no choice, nobody does.
 */
export function publishesFor(
  self: string,
  primary: string | null,
  trustedMachines: readonly string[],
): boolean {
  if (primary !== null) return publishesProjection(self, primary);
  return trustedMachines.length === 1 && trustedMachines[0] === self;
}

/**
 * The machine that is the main bridge when the creator chose none: the trusted machine that wrote
 * the latest event of the journal (the one in use), the smallest identifier breaking a tie. It
 * reads the journal only, so that every machine reaches the same answer. A machine that never
 * wrote counts as the least recent. Null without any trusted machine. Choosing a main bridge
 * explicitly always wins over this.
 */
export function electPrimary(
  trustedMachines: readonly string[],
  lastWrite: ReadonlyMap<string, string>,
): string | null {
  let best: { machine: string; at: string } | undefined;
  for (const machine of trustedMachines) {
    const at = lastWrite.get(machine) ?? "";
    if (best === undefined || at > best.at || (at === best.at && machine < best.machine)) {
      best = { machine, at };
    }
  }
  return best?.machine ?? null;
}

/** An order for a product: it names a story, or it does not. */
export interface RoutedOrder {
  readonly story?: string;
}

/**
 * The bridge an order is addressed to: the one that owns the story when the order names a story,
 * the product's main bridge otherwise. Undefined when there is nobody to address (no main bridge
 * chosen, or no bridge owns that story): the order is not sent anywhere else.
 */
export function routeOrder(
  order: RoutedOrder,
  primary: string | null,
  storyOwners: ReadonlyMap<string, string>,
): string | undefined {
  if (order.story !== undefined) return storyOwners.get(order.story);
  return primary ?? undefined;
}
