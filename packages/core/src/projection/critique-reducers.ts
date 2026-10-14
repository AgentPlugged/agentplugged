import {
  CRITIQUE_EVENT_TYPES,
  type CritiqueProposedPayload,
  type CritiqueReportedPayload,
  type CritiqueSettledPayload,
  critiqueIdOf,
  type HypothesisClosedPayload,
  hypothesisIdOf,
  MAX_REMEMBERED_VERSIONS,
} from "@agentplugged/protocol";
import {
  type CritiqueRecord,
  critiqueById,
  critiquesOf,
  type HypothesisRecord,
  hypothesisById,
  normalizedPath,
  refsOf,
} from "../critique/critique-rules.js";
import { actingAgent, dictionary } from "./agent-reducers.js";
import type { ProjectionDraft, Reducer } from "./reducers.js";

/** The versions of a document offered or criticised, the latest last, at most `MAX_REMEMBERED_VERSIONS`. */
function remember(draft: ProjectionDraft, document: string, versions: readonly string[]): void {
  let marks = draft.state.critiqued as Record<string, string[]> | undefined;
  if (marks === undefined) {
    marks = dictionary<string[]>();
    draft.state.critiqued = marks;
  }
  const known = Object.hasOwn(marks, document) ? (marks[document] as string[]) : [];
  const added = versions.filter((version) => !known.includes(version));
  marks[document] = [...known, ...added].slice(-MAX_REMEMBERED_VERSIONS);
}

/**
 * The reducers of the critique of a deliverable:
 * - `state.critiques`: the latest critique of each document, with what the creator did with each
 *   objection (a new critique of the same document replaces the older one; the hypotheses it
 *   produced live on in `state.hypotheses`);
 * - `state.hypotheses`: the hypotheses open, kept from an objection by the creator's gesture,
 *   until `hypothesis.closed` closes them (`still_open` keeps them and dates the look);
 * - `state.critiqued`: the versions of a document offered or criticised, so that a critique is
 *   offered once per version.
 * Every event is an agent's: the gestures are the creator's, relayed with their words, which the
 * event keeps. An event that does not fit the state (a critique or an objection unknown, one
 * already sorted) is ignored as `invalid`.
 */
export const CRITIQUE_REDUCERS: Readonly<Record<string, Reducer>> = {
  [CRITIQUE_EVENT_TYPES.reported]: (draft, event) => {
    const by = actingAgent(event);
    if (by === undefined) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    const payload = event.payload as CritiqueReportedPayload;
    const document = normalizedPath(payload.document);
    const id = critiqueIdOf(event.id);
    const critiques = critiquesOf(draft.state) as Record<string, CritiqueRecord>;
    if (draft.state.critiques === undefined) draft.state.critiques = dictionary<CritiqueRecord>();
    const store = draft.state.critiques as Record<string, CritiqueRecord>;
    for (const [other, record] of Object.entries(critiques)) {
      if (record.document === document) delete store[other];
    }
    store[id] = {
      id,
      at: event.at,
      document,
      method: payload.method,
      ...(payload.blend === undefined ? {} : { blend: payload.blend }),
      versions: payload.versions,
      by,
      objections: payload.objections.map((objection, index) => ({
        n: index + 1,
        severity: objection.severity,
        claim: objection.claim,
        passage: objection.passage,
        proposal: objection.proposal ?? null,
        proof: objection.proof ?? null,
        status: "open" as const,
      })),
    };
    // A reconciliation of the creator's inputs is no critique of the document: Noah's offer of
    // the critique of this version stays.
    if (payload.method !== "reconcile") remember(draft, document, payload.versions);
  },
  [CRITIQUE_EVENT_TYPES.proposed]: (draft, event) => {
    if (actingAgent(event) === undefined) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    const payload = event.payload as CritiqueProposedPayload;
    remember(draft, normalizedPath(payload.document), payload.versions);
  },
  [CRITIQUE_EVENT_TYPES.settled]: (draft, event) => {
    const by = actingAgent(event);
    const payload = event.payload as CritiqueSettledPayload;
    const critique = critiqueById(draft.state, payload.critique);
    if (by === undefined || critique === undefined) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    let applied = 0;
    for (const decision of payload.decisions) {
      const objection = critique.objections[decision.n - 1];
      if (objection === undefined || objection.status !== "open") continue;
      objection.status = decision.gesture;
      applied += 1;
      if (decision.gesture !== "hypothesis") continue;
      if (draft.state.hypotheses === undefined) {
        draft.state.hypotheses = dictionary<HypothesisRecord>();
      }
      const id = hypothesisIdOf(critique.id, decision.n);
      (draft.state.hypotheses as Record<string, HypothesisRecord>)[id] = {
        id,
        critique: critique.id,
        n: decision.n,
        claim: objection.claim,
        document: critique.document,
        passage: objection.passage,
        refs: refsOf(objection.passage),
        proof: objection.proof,
        severity: objection.severity,
        since: event.at,
        seen: null,
        by,
      };
    }
    if (applied === 0) draft.ignored.push({ id: event.id, reason: "invalid" });
  },
  [CRITIQUE_EVENT_TYPES.closed]: (draft, event) => {
    const payload = event.payload as HypothesisClosedPayload;
    const hypothesis = hypothesisById(draft.state, payload.hypothesis);
    if (actingAgent(event) === undefined || hypothesis === undefined) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    if (payload.outcome === "still_open") hypothesis.seen = event.at;
    else delete (draft.state.hypotheses as Record<string, HypothesisRecord>)[payload.hypothesis];
  },
};
