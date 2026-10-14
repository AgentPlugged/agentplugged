import {
  type AuditReportedPayload,
  type GapSettledPayload,
  REQUIREMENT_EVENT_TYPES,
  type RequirementProvedPayload,
  type RequirementsRegisteredPayload,
} from "@agentplugged/protocol";
import { proofDecisions } from "../proofs/proof-accord.js";
import {
  type AuditRecord,
  gapPointProblem,
  proofIsStale,
  type RequirementItem,
  type RequirementsState,
} from "../requirements/requirement-rules.js";
import { actingAgent, dictionary } from "./agent-reducers.js";
import type { ProjectionDraft, Reducer } from "./reducers.js";

function registerOf(draft: ProjectionDraft): RequirementsState | undefined {
  return draft.state.requirements as RequirementsState | undefined;
}

/**
 * The reducers of the non-functional requirements: `state.requirements`, the register
 * as the last `requirements.registered` wrote it, with each requirement's latest proof and the
 * creator's decision on its gap; `state.audits`, the latest audit of each pillar.
 * - `requirements.registered`, by an agent: replaces the register. An entry whose digest did not
 *   change keeps its proof and its gap; a new or changed one starts without (`since` = this
 *   event), so no earlier proof counts for what the requirement now says.
 * - `requirement.proved`, by an agent, for a requirement of the register and the digest it holds
 *   (a proof made for an older wording is ignored). The latest proof wins.
 * - `requirement.gap_settled`, by an agent relaying the creator's answer: the checkpoint must be
 *   resolved by the creator (terminal, chat or form, never an agent nor `auto`) with the option
 *   that is the decision. Ignored (`invalid`) otherwise.
 * - `audit.reported`, by an agent: the verdict of each audited pillar.
 */
export const REQUIREMENT_REDUCERS: Readonly<Record<string, Reducer>> = {
  [REQUIREMENT_EVENT_TYPES.registered]: (draft, event) => {
    if (actingAgent(event) === undefined) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    const payload = event.payload as RequirementsRegisteredPayload;
    const before = registerOf(draft);
    const items = dictionary<RequirementItem>();
    for (const entry of payload.items) {
      const known =
        before !== undefined && Object.hasOwn(before.items, entry.id)
          ? before.items[entry.id]
          : undefined;
      const same = known !== undefined && known.digest === entry.digest;
      items[entry.id] = {
        id: entry.id,
        pillar: entry.pillar,
        proof: entry.proof,
        text: entry.text,
        budget: entry.budget ?? null,
        commands: [...entry.commands],
        stories: [...entry.stories],
        digest: entry.digest,
        since: same ? known.since : event.at,
        proved: same ? known.proved : null,
        gap: same ? known.gap : null,
      };
    }
    draft.state.requirements = { at: event.at, items } satisfies RequirementsState;
  },
  [REQUIREMENT_EVENT_TYPES.proved]: (draft, event) => {
    const payload = event.payload as RequirementProvedPayload;
    const by = actingAgent(event);
    const register = registerOf(draft);
    const item =
      register !== undefined && Object.hasOwn(register.items, payload.requirement)
        ? register.items[payload.requirement]
        : undefined;
    if (by === undefined || item === undefined || item.digest !== payload.entry) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    // A proof marked as the engine's carries the run of a command the creator
    // accepted (its fingerprint is in the journal's decisions); any other proof carries no run.
    const engine = payload.origin === "engine";
    const run = payload.run;
    const accepted =
      run === undefined ? undefined : proofDecisions(draft.state).accepted.get(run.fingerprint);
    if (
      engine !== (run !== undefined) ||
      (run !== undefined &&
        (accepted === undefined ||
          accepted.name !== run.command ||
          !accepted.proves.includes(payload.requirement)))
    ) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    // An engine's failure stands until the engine runs again, or until the code it covers changed:
    // a proof an agent reports does not wipe it out.
    const standing = item.proved;
    if (
      !engine &&
      payload.kind !== "ci" &&
      standing !== null &&
      standing.origin === "engine" &&
      standing.result === "fail" &&
      standing.at >= item.since &&
      !proofIsStale(draft.state, item, standing.at)
    ) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    (register as RequirementsState).items[item.id] = {
      ...item,
      proved: {
        kind: payload.kind,
        result: payload.result,
        source: payload.source,
        measured: payload.measured ?? null,
        budget: payload.budget ?? null,
        note: payload.note ?? null,
        at: event.at,
        by,
        event: event.id,
        // A CI the engine read itself counts as the engine's.
        origin: engine || payload.kind === "ci" ? "engine" : "reported",
        run:
          run === undefined
            ? null
            : {
                command: run.command,
                ended: run.ended,
                exit: run.exit,
                ms: run.ms,
                commit: run.commit ?? null,
                clean: run.clean ?? null,
              },
      },
    };
  },
  [REQUIREMENT_EVENT_TYPES.gapSettled]: (draft, event) => {
    const payload = event.payload as GapSettledPayload;
    const by = actingAgent(event);
    const register = registerOf(draft);
    const item =
      register !== undefined && Object.hasOwn(register.items, payload.requirement)
        ? register.items[payload.requirement]
        : undefined;
    if (
      by === undefined ||
      item === undefined ||
      gapPointProblem(draft.state, payload.requirement, payload.decision, payload.checkpoint) !==
        undefined
    ) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    (register as RequirementsState).items[item.id] = {
      ...item,
      gap: {
        decision: payload.decision,
        reason: payload.reason,
        version: payload.version ?? null,
        checkpoint: payload.checkpoint,
        at: event.at,
        by,
        event: event.id,
      },
    };
  },
  [REQUIREMENT_EVENT_TYPES.audited]: (draft, event) => {
    const by = actingAgent(event);
    if (by === undefined) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    const payload = event.payload as AuditReportedPayload;
    let audits = draft.state.audits as Record<string, AuditRecord> | undefined;
    if (audits === undefined) {
      audits = dictionary<AuditRecord>();
      draft.state.audits = audits;
    }
    for (const entry of payload.pillars) {
      audits[entry.pillar] = {
        at: event.at,
        verdict: entry.verdict,
        findings: entry.findings,
        by,
      };
    }
  },
};
