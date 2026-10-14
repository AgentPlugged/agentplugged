import {
  READINESS_EVENT_TYPES,
  type ReadinessReportedPayload,
  type ReadinessSettledPayload,
  readinessIdOf,
} from "@agentplugged/protocol";
import { isJudgedKey, type ReadinessState, readinessOf } from "../readiness/readiness-record.js";
import { actingAgent } from "./agent-reducers.js";
import type { Reducer } from "./reducers.js";

function stateOf(state: Record<string, unknown>): ReadinessState {
  const known = readinessOf(state);
  if (known !== undefined) return known;
  const fresh: ReadinessState = { report: null, accepted: Object.create(null) };
  state.readiness = fresh;
  return fresh;
}

/**
 * The reducers of the readiness gate: `state.readiness` keeps the latest judged
 * report (a new one replaces it) and what the creator accepted, by finding key. A finding of the
 * engine keeps its key from one report to the next, so that an acceptance stands as long as the
 * finding does; the keys of the judged findings (`J<n>`) belong to their report and are dropped
 * with it. Every event is an agent's, relaying the creator's words, which the event keeps; one that
 * does not fit the state is ignored as `invalid`.
 */
export const READINESS_REDUCERS: Readonly<Record<string, Reducer>> = {
  [READINESS_EVENT_TYPES.reported]: (draft, event) => {
    const by = actingAgent(event);
    if (by === undefined) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    const payload = event.payload as ReadinessReportedPayload;
    const readiness = stateOf(draft.state);
    for (const key of Object.keys(readiness.accepted)) {
      if (isJudgedKey(key)) delete readiness.accepted[key];
    }
    readiness.report = {
      id: readinessIdOf(event.id),
      at: event.at,
      by,
      mark: payload.mark,
      stage: payload.stage,
      path: payload.path,
      verdict: payload.verdict,
      summary: payload.summary,
      engine: payload.engine,
      findings: payload.findings.map((finding, index) => ({
        n: index + 1,
        severity: finding.severity,
        kind: finding.kind,
        claim: finding.claim,
        passages: finding.passages,
        proposal: finding.proposal ?? null,
        owner: finding.owner,
      })),
      waivable: payload.waivable ?? [],
      checkpoint: payload.checkpoint ?? null,
    };
  },
  [READINESS_EVENT_TYPES.settled]: (draft, event) => {
    const by = actingAgent(event);
    if (by === undefined) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    const payload = event.payload as ReadinessSettledPayload;
    const readiness = stateOf(draft.state);
    for (const decision of payload.decisions) {
      if (decision.gesture !== "accept") continue;
      readiness.accepted[decision.id] = { reason: decision.reason ?? "", at: event.at, by };
    }
  },
};
