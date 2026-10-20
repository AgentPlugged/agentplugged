import {
  EXCHANGE_EVENT_TYPES,
  EXCHANGES_KEPT,
  type ExchangeSummarizedPayload,
  NOAH_AGENT,
} from "@agentplugged/protocol";
import type { Reducer } from "./reducers.js";

/** `state.exchanges[]`: one note of Noah's at the end of an exchange, in projection order. */
export interface ExchangeEntry {
  /** The event's ULID. */
  readonly id: string;
  readonly at: string;
  /** What was asked, decided and promised, in one line. */
  readonly summary: string;
  /** `untrusted` when the session that wrote it may have read external content. */
  readonly provenance: "trusted" | "untrusted";
}

/** The notes of the projection, in order (an empty list when there are none). */
export function exchangesOf(state: Readonly<Record<string, unknown>>): ExchangeEntry[] {
  return (state.exchanges as ExchangeEntry[] | undefined) ?? [];
}

/**
 * The reducers of the exchange notes: only Noah writes them (another actor's note is ignored as
 * `invalid`), and the projection keeps the latest `EXCHANGES_KEPT`. A note identical to the one
 * before it changes nothing, so a session that writes its note twice leaves one.
 */
export const EXCHANGE_REDUCERS: Readonly<Record<string, Reducer>> = {
  [EXCHANGE_EVENT_TYPES.summarized]: (draft, event) => {
    if (event.actor.kind !== "agent" || event.actor.agent !== NOAH_AGENT) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    const { summary } = event.payload as ExchangeSummarizedPayload;
    const list = exchangesOf(draft.state);
    if (list[list.length - 1]?.summary === summary) return;
    list.push({
      id: event.id,
      at: event.at,
      summary,
      provenance: event.provenance === "untrusted" ? "untrusted" : "trusted",
    });
    draft.state.exchanges = list.slice(-EXCHANGES_KEPT);
  },
};
