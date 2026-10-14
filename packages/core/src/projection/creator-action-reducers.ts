import {
  CREATOR_ACTION_EVENT_TYPES,
  CREATOR_OWNER,
  type CreatorActionExecutedPayload,
  type EventEnvelope,
} from "@agentplugged/protocol";
import { canonicalJson } from "../chat/decision-prompt.js";
import { section } from "./agent-reducers.js";
import type { CheckpointState } from "./checkpoint-reducers.js";
import { applyCiWaiver } from "./ci-reducers.js";
import { applyDeferredClosing } from "./deferred-reducers.js";
import { applyDeviationResolution } from "./deviation-reducers.js";
import { untrustedAnswer } from "./human-reducers.js";
import { applyStepResume, applyStepSkip } from "./journey-reducers.js";
import type { ProjectionDraft, Reducer } from "./reducers.js";
import { applyScopeWidening } from "./write-guard-reducers.js";

/**
 * Why a `creator_action.executed` cannot carry its action out, or undefined. It must follow, in
 * its writer's chain, the approval (`approved`) of a `creator_action` checkpoint not carried out
 * yet, and carry the action that checkpoint recorded, exactly. From the chat: the agent that
 * relayed that approval, with the same quote; from the AI tool's form: the agent
 * that asked, on the same machine; from the terminal: the creator's trusted key that
 * signed it.
 */
function executionRefusal(
  draft: ProjectionDraft,
  checkpoint: CheckpointState | undefined,
  event: EventEnvelope,
): string | undefined {
  const payload = event.payload as CreatorActionExecutedPayload;
  const record = checkpoint?.creator_action ?? undefined;
  const resolution = checkpoint?.resolution ?? null;
  if (checkpoint === undefined || checkpoint.type !== "creator_action" || record === undefined) {
    return "invalid";
  }
  if ((checkpoint.executed ?? null) !== null) return "invalid";
  if (checkpoint.status !== "resolved" || resolution === null) return "invalid";
  if (resolution.decision !== "approved") return "invalid";
  if (draft.parents.get(event.id) !== resolution.event) return "invalid";
  if (canonicalJson(payload.action) !== canonicalJson(record)) return "invalid";
  if (payload.source === "chat") {
    const relayed =
      event.actor.kind === "agent" &&
      resolution.source === "chat" &&
      event.actor.agent === resolution.relayed_by &&
      event.actor.device === resolution.by &&
      payload.quote === resolution.quote;
    return relayed ? undefined : "invalid";
  }
  if (payload.source === "elicitation") {
    // The approval clicked in the AI tool's form, written by the agent that asked,
    // on the same machine, in the same write.
    const asked =
      event.actor.kind === "agent" &&
      resolution.source === "elicitation" &&
      event.actor.agent === resolution.relayed_by &&
      event.actor.device === resolution.by;
    return asked ? undefined : "invalid";
  }
  if (event.actor.kind !== "human" || resolution.source !== "terminal") return "invalid";
  if (event.actor.device !== resolution.by) return "invalid";
  return untrustedAnswer(draft, event);
}

/**
 * Carries out an approved creator's action, or refuses it (`invalid`, or the
 * refusal of an untrusted creator's key): the effect of the terminal command's own event (the
 * story's CI waived for the commit, the item of deferred work closed, the deviation lifted; none
 * for a file action, whose files the engine writes), then the checkpoint keeps when and where it
 * was carried out. False when refused or when the target no longer allows it.
 */
function applyExecution(draft: ProjectionDraft, event: EventEnvelope): boolean {
  const payload = event.payload as CreatorActionExecutedPayload;
  const checkpoints = section<CheckpointState>(draft, "checkpoints");
  const checkpoint = Object.hasOwn(checkpoints, payload.checkpoint)
    ? (checkpoints[payload.checkpoint] as CheckpointState)
    : undefined;
  const refusal = executionRefusal(draft, checkpoint, event);
  if (refusal !== undefined || checkpoint === undefined) {
    draft.ignored.push({ id: event.id, reason: (refusal ?? "invalid") as "invalid" });
    return false;
  }
  const record = payload.action;
  // The creator decided it: from the chat or the AI tool's form, `creator`; at the terminal, the
  // creator's device.
  const by = payload.source === "terminal" ? event.actor.device : CREATOR_OWNER;
  const target = { reason: record.reason, by, at: event.at, event: event.id };
  let applied = true;
  switch (record.kind) {
    case "ci_waive":
      applied = applyCiWaiver(draft, record.story, { ...target, commit: record.commit });
      break;
    case "deferred_resolve":
    case "deferred_drop":
      applied = applyDeferredClosing(draft, record.item, {
        ...target,
        outcome: record.kind === "deferred_drop" ? "dropped" : "done",
      });
      break;
    case "trace_resolve":
      applied = applyDeviationResolution(draft, record.deviation, target);
      break;
    // A step of the journey skipped, or taken up again.
    case "step_skip":
      applied = applyStepSkip(draft, record, target, payload.source, payload.checkpoint);
      break;
    case "step_resume":
      applied = applyStepResume(draft, record);
      break;
    // Files and folders added to a story's scope.
    case "scope_widen":
      applied = applyScopeWidening(draft, record.story, record.paths);
      break;
    default:
      break;
  }
  if (!applied) {
    draft.ignored.push({ id: event.id, reason: "invalid" });
    return false;
  }
  checkpoint.executed = { event: event.id, at: event.at, source: payload.source };
  return true;
}

/**
 * Executions whose approval was held (its checkpoint not open yet in projection order, two
 * machines' clocks apart), by the approval's id: applied once it is.
 */
function pendingOf(draft: ProjectionDraft): Map<string, EventEnvelope[]> {
  return draft.pendingExecutions;
}

/** True while the answer `id` waits for its checkpoint to open (`pendingResolutions`). */
function answerHeld(draft: ProjectionDraft, id: string): boolean {
  for (const answers of draft.pendingResolutions.values()) {
    if (answers.some((answer) => answer.id === id)) return true;
  }
  return false;
}

/** Applies the executions that waited for the approval `answer`, once it is applied. */
export function releaseExecutions(draft: ProjectionDraft, answer: string): void {
  const pending = pendingOf(draft);
  const waiting = pending.get(answer);
  if (waiting === undefined) return;
  pending.delete(answer);
  for (const event of waiting) {
    if (applyExecution(draft, event)) draft.released.push(event);
  }
}

/** Once every event is applied: an execution whose approval never applied is ignored. */
export function settleHeldExecutions(draft: ProjectionDraft): void {
  const pending = pendingOf(draft);
  for (const waiting of pending.values()) {
    for (const event of waiting) draft.ignored.push({ id: event.id, reason: "invalid" });
  }
  pending.clear();
}

/** The reducer of the creator's actions carried out. */
export const CREATOR_ACTION_REDUCERS: Readonly<Record<string, Reducer>> = {
  [CREATOR_ACTION_EVENT_TYPES.executed]: (draft, event) => {
    const parent = draft.parents.get(event.id);
    if (parent !== undefined && answerHeld(draft, parent)) {
      const pending = pendingOf(draft);
      const waiting = pending.get(parent) ?? [];
      waiting.push(event);
      pending.set(parent, waiting);
      draft.held.add(event.id);
      return;
    }
    applyExecution(draft, event);
  },
};
