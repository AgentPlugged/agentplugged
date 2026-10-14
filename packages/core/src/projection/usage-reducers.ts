import {
  type EventEnvelope,
  MACHINE_DEVICE_PATTERN,
  USAGE_EVENT_TYPES,
  type UsageMeasuredPayload,
} from "@agentplugged/protocol";
import type { UsageSessionState, UsageState } from "../usage/usage-rules.js";
import { dictionary } from "./agent-reducers.js";
import type { ProjectionDraft, Reducer } from "./reducers.js";

/**
 * Records that the engine measured a session of `event.story` (`state.usage_signals[story]`),
 * from the envelope only (its type, its story and its engine author are in clear): counted with
 * or without the product key, so that a story the engine measured is never reported as a story
 * nobody measured. Only the engine's own events count.
 */
export function noteUsageSignal(draft: ProjectionDraft, event: EventEnvelope): void {
  if (event.story === undefined || event.actor.kind !== "system") return;
  const signals =
    (draft.state.usage_signals as Record<string, number> | undefined) ?? dictionary<number>();
  signals[event.story] =
    (Object.hasOwn(signals, event.story) ? (signals[event.story] as number) : 0) + 1;
  draft.state.usage_signals = signals;
}

/**
 * The reducer of the engine's measure of the AI tools' sessions:
 * `state.usage.sessions[<source>:<session>]`. Only the engine writes it (`actor.kind: system`,
 * signed by a machine of the product): a measure written by an agent, or by anyone else, is
 * ignored (`invalid`), so that an agent can never write the cost it is measured at. A later
 * measure of the same session replaces the earlier one, whatever story it names: measuring a
 * session again never counts it twice.
 */
export const USAGE_REDUCERS: Readonly<Record<string, Reducer>> = {
  [USAGE_EVENT_TYPES.measured]: (draft, event) => {
    if (event.actor.kind !== "system" || !MACHINE_DEVICE_PATTERN.test(event.actor.device)) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    noteUsageSignal(draft, event);
    const payload = event.payload as unknown as UsageMeasuredPayload;
    let usage = draft.state.usage as UsageState | undefined;
    if (usage === undefined) {
      usage = { sessions: dictionary<UsageSessionState>() };
      draft.state.usage = usage;
    }
    usage.sessions[`${payload.source}:${payload.session}`] = {
      source: payload.source,
      session: payload.session,
      story: event.story ?? null,
      agent: payload.agent,
      basis: payload.basis,
      started_at: payload.started_at,
      ended_at: payload.ended_at,
      active_ms: payload.active_ms,
      models: payload.models,
      ...(payload.parts === undefined ? {} : { parts: payload.parts }),
      at: event.at,
      event: event.id,
    };
  },
};
