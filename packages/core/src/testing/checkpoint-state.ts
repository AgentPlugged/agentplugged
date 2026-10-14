import type { CheckpointDocument, ResolutionDecision } from "@agentplugged/protocol";
import type { CheckpointResolution, CheckpointState } from "../projection/checkpoint-reducers.js";

/**
 * A checkpoint as the projection keeps it, for tests: every field of `CheckpointState`, open and
 * low-risk by default, `overrides` on top.
 */
export function checkpointState(
  id: string,
  overrides: Partial<CheckpointState> = {},
): CheckpointState {
  return {
    id,
    type: "document",
    risk: "low",
    irreversible: false,
    recipient_role: "creator",
    confirmation: [],
    title: id,
    summary: id,
    story: null,
    documents: [],
    blocks: [],
    options: null,
    recommendation: null,
    criteria: null,
    source: null,
    status: "open",
    opened_by: "maya",
    opened_at: "2026-10-03T00:00:00.000Z",
    opened_event: `01JZ0000000000000000${id
      .replace(/[^0-9A-Z]/g, "")
      .padStart(6, "0")
      .slice(-6)}`,
    measures: {},
    verdict: null,
    resolution: null,
    supersedes: null,
    phase: null,
    blocks_lifted: false,
    waived_ms: 0,
    request: null,
    untrusted: null,
    provenance: "trusted",
    ...overrides,
  };
}

/** The creator's answer, at `at`, for `checkpointState`. */
export function answer(
  decision: ResolutionDecision,
  at: string,
  extra: Partial<CheckpointResolution> = {},
): CheckpointResolution {
  return {
    decision,
    option: null,
    note: null,
    waiver_until: null,
    by: "human:test",
    at,
    assurance: "locale",
    source: "terminal",
    event: `E-${at}`,
    quote: null,
    confirmation_quote: null,
    relayed_by: null,
    proof: null,
    ...extra,
  };
}

/** A resolved checkpoint citing `documents` (path, blob), answered `decision` at `at`. */
export function answered(
  id: string,
  decision: ResolutionDecision,
  at: string,
  documents: ReadonlyArray<readonly [string, string]>,
  overrides: Partial<CheckpointState> = {},
): CheckpointState {
  const cited: CheckpointDocument[] = documents.map(([path, blob]) => ({
    path,
    branch: "main",
    blob_sha: blob,
  }));
  return checkpointState(id, {
    status: "resolved",
    documents: cited,
    resolution: answer(decision, at),
    blocks_lifted: decision !== "rejected" && decision !== "changes_requested",
    ...overrides,
  });
}
