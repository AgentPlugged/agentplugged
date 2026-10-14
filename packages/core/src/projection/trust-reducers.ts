import { type ExternalReadPayload, SESSION_EVENT_TYPES } from "@agentplugged/protocol";
import type { Reducer } from "./reducers.js";

/** `state.external_reads[]`: one external read of an untrusted session. */
export interface ExternalReadEntry {
  readonly tool: string;
  readonly source: string;
  /** The AI tool's session id, when its hook gave it. */
  readonly session: string | null;
  /** The agent the read was recorded for (`main` for a hook), or null for another actor. */
  readonly agent: string | null;
  readonly device: string;
  readonly at: string;
  readonly event: string;
}

/** The reducers of untrusted content: the reads, in projection order. */
export const TRUST_REDUCERS: Readonly<Record<string, Reducer>> = {
  [SESSION_EVENT_TYPES.externalRead]: (draft, event) => {
    const payload = event.payload as ExternalReadPayload;
    const reads = (draft.state.external_reads as ExternalReadEntry[] | undefined) ?? [];
    reads.push({
      tool: payload.tool,
      source: payload.source,
      session: payload.session ?? null,
      agent: event.actor.kind === "agent" ? (event.actor.agent ?? null) : null,
      device: event.actor.device,
      at: event.at,
      event: event.id,
    });
    draft.state.external_reads = reads;
  },
};
