import {
  type AgentDelegatedPayload,
  DELEGATION_EVENT_TYPES,
  type DelegationMode,
  type DelegationTargetKind,
  NOAH_AGENT,
} from "@agentplugged/protocol";
import { agentOf } from "./agent-reducers.js";
import type { Reducer } from "./reducers.js";

/** How many handovers the projection keeps, the latest ones. */
export const DELEGATIONS_KEPT = 100;

/** `state.delegations[]`: one handover of Noah's, in projection order. */
export interface DelegationEntry {
  /** The event's ULID. */
  readonly id: string;
  readonly at: string;
  /** The agent that handed the work over: Noah. */
  readonly from: string;
  readonly to: string;
  readonly kind: DelegationTargetKind;
  readonly mode: DelegationMode;
  /** The story the work is on, or null. */
  readonly story: string | null;
  readonly brief: string;
  /** `untrusted` when the session that wrote it may have read external content. */
  readonly provenance: "trusted" | "untrusted";
}

/** The handovers of the projection, in order (an empty list when there are none). */
export function delegationsOf(state: Readonly<Record<string, unknown>>): DelegationEntry[] {
  return (state.delegations as DelegationEntry[] | undefined) ?? [];
}

/**
 * The reducers of the handovers: Noah's `agent.delegated` is kept in
 * `state.delegations`, the latest `DELEGATIONS_KEPT` only, and Noah's status becomes `waiting`
 *; another actor's, another agent's included, is refused (`invalid`): only Noah
 * delegates.
 */
export const DELEGATION_REDUCERS: Readonly<Record<string, Reducer>> = {
  [DELEGATION_EVENT_TYPES.delegated]: (draft, event) => {
    if (event.actor.kind !== "agent" || event.actor.agent !== NOAH_AGENT) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    const payload = event.payload as AgentDelegatedPayload;
    const list = delegationsOf(draft.state);
    list.push({
      id: event.id,
      at: event.at,
      from: event.actor.agent,
      to: payload.to,
      kind: payload.kind,
      mode: payload.mode,
      story: event.story ?? null,
      brief: payload.brief,
      provenance: event.provenance === "untrusted" ? "untrusted" : "trusted",
    });
    draft.state.delegations = list.slice(-DELEGATIONS_KEPT);
    // Noah waits while the work is out; `report_status` `working` puts him back to
    // work when the hand returns to him.
    const noah = agentOf(draft, event);
    // A `blocked` Noah stays blocked: that is something the creator must see.
    if (noah !== undefined) {
      if (noah.status !== "blocked") noah.status = "waiting";
      noah.task = null;
    }
  },
};
