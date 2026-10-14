import {
  type ChatProof,
  type EventEnvelope,
  MACHINE_DEVICE_PATTERN,
  STACK_EVENT_TYPES,
  type StackAnsweredPayload,
  type StackOpenedPayload,
  stackIdOf,
} from "@agentplugged/protocol";
import { citedKey } from "../chat/chat-proof.js";
import { quoteDigest } from "../chat/chat-text.js";
import {
  parseStackReply,
  stackApproval,
  stackItemDigest,
  stackProblem,
} from "../chat/stack-rules.js";
import { answerable } from "../checkpoints/resolution-rules.js";
import { agentOf, section } from "./agent-reducers.js";
import {
  type Answer,
  applyResolution,
  type CheckpointState,
  citedOf,
  citeRefs,
} from "./checkpoint-reducers.js";
import type { ProjectionDraft, Reducer } from "./reducers.js";

/**
 * The stack to validate: `stack.opened` records the points the engine presented
 * together, numbered 1, 2, 3…; `stack.answered` records the creator's answer to them in one event,
 * which the projection turns into one answer per point approved, and those alone. Everything an
 * agent could write is checked against the same rules the commands use (`stack-rules.ts`): the
 * points a stack may hold, what an approval records, what the creator's message says.
 */

/** One point of a stack in the projection, with its answer once it has one. */
export interface StackItemState {
  readonly n: number;
  readonly checkpoint: string;
  /** What the stack showed of the point (`stackItemDigest`). */
  readonly digest: string;
  /** The answer the stack gave it, or null while it waits. */
  answer: { readonly event: string; readonly at: string; readonly source: string } | null;
}

/** `state.stacks[id]`: a stack and where each of its points stands. */
export interface StackState {
  /** `P-` then the last 10 characters of the ULID of the event that opened it. */
  readonly id: string;
  readonly opened_by: string | null;
  readonly opened_at: string;
  readonly opened_event: string;
  readonly items: StackItemState[];
}

/** The stacks of a projection, by id. */
export function stacksOf(state: Readonly<Record<string, unknown>>): Record<string, StackState> {
  return (state.stacks as Record<string, StackState> | undefined) ?? {};
}

const stacksSection = (draft: ProjectionDraft) => section<StackState>(draft, "stacks");

/** True for an event an agent wrote on a machine (`machine:` device), as the engine writes them. */
function writtenByAnAgent(event: EventEnvelope): boolean {
  return event.actor.kind === "agent" && MACHINE_DEVICE_PATTERN.test(event.actor.device);
}

/**
 * Opens a stack, or ignores it (`invalid`): written by an agent on a machine, its points known,
 * each still open and one a stack may hold, with the digest of what the stack showed of it.
 */
function applyOpening(draft: ProjectionDraft, event: EventEnvelope): void {
  const payload = event.payload as StackOpenedPayload;
  const id = stackIdOf(event.id);
  if (!writtenByAnAgent(event) || Object.hasOwn(stacksOf(draft.state), id)) {
    draft.ignored.push({ id: event.id, reason: "invalid" });
    return;
  }
  const checkpoints = section<CheckpointState>(draft, "checkpoints");
  const at = Date.parse(event.at);
  for (const item of payload.items) {
    const checkpoint = Object.hasOwn(checkpoints, item.checkpoint)
      ? (checkpoints[item.checkpoint] as CheckpointState)
      : undefined;
    if (
      checkpoint === undefined ||
      stackProblem(checkpoint, draft.state, at) !== undefined ||
      stackItemDigest(checkpoint) !== item.digest
    ) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
  }
  agentOf(draft, event);
  stacksSection(draft)[id] = {
    id,
    opened_by: event.actor.kind === "agent" ? (event.actor.agent ?? null) : null,
    opened_at: event.at,
    opened_event: event.id,
    items: payload.items.map((item) => ({
      n: item.n,
      checkpoint: item.checkpoint,
      digest: item.digest,
      answer: null,
    })),
  };
}

/**
 * Applies the creator's answer to a stack, all or nothing, or ignores it. Checked as a whole before
 * any point is answered:
 * - written by an agent on a machine, after the stack opened, on points of that stack that still
 *   wait, which a stack may still hold (`stackProblem`: a risk raised since is refused);
 * - from the chat: the creator's message read again (`parseStackReply`) names every number the
 *   event approves (an agent never approves more than the message says), and the hook's proof,
 *   when there is one, holds together (the quote's digest, a message after the stack opened,
 *   never cited); without the proof the answer counts as `chat_unverified`, an installation
 *   (`untrusted_action`) included.
 * Then one answer per point (`applyResolution`), the approval its checkpoint gives (`stackApproval`).
 */
function applyAnswer(draft: ProjectionDraft, event: EventEnvelope): boolean {
  const payload = event.payload as StackAnsweredPayload;
  const ignore = (reason: "invalid" | "already_resolved"): false => {
    draft.ignored.push({ id: event.id, reason });
    return false;
  };
  const stacks = stacksOf(draft.state);
  const stack = Object.hasOwn(stacks, payload.stack)
    ? (stacks[payload.stack] as StackState)
    : undefined;
  if (stack === undefined || !writtenByAnAgent(event)) return ignore("invalid");
  const at = Date.parse(event.at);
  if (!(at >= Date.parse(stack.opened_at))) return ignore("invalid");
  const checkpoints = section<CheckpointState>(draft, "checkpoints");
  const points: Array<{ item: StackItemState; checkpoint: CheckpointState }> = [];
  for (const n of payload.approve) {
    const item = stack.items.find((entry) => entry.n === n);
    if (item === undefined) return ignore("invalid");
    if (item.answer !== null) return ignore("already_resolved");
    const checkpoint = Object.hasOwn(checkpoints, item.checkpoint)
      ? (checkpoints[item.checkpoint] as CheckpointState)
      : undefined;
    if (checkpoint === undefined) return ignore("invalid");
    if (!answerable(checkpoint, at)) return ignore("already_resolved");
    if (stackProblem(checkpoint, draft.state, at) !== undefined) return ignore("invalid");
    // What the creator approves is what the stack said: the point is still the one it showed.
    if (stackItemDigest(checkpoint) !== item.digest) return ignore("invalid");
    points.push({ item, checkpoint });
  }
  let proof: ChatProof | null = null;
  if (payload.source === "chat") {
    const reading = parseStackReply(payload.quote, stack.items.length);
    if (!reading.ok || !payload.approve.every((n) => reading.numbers.includes(n))) {
      return ignore("invalid");
    }
    if (payload.proof !== undefined) {
      const message = Date.parse(payload.proof.message.at);
      if (
        payload.proof.message.digest !== quoteDigest(payload.quote) ||
        !(message > Date.parse(stack.opened_at)) ||
        citedOf(draft).has(citedKey(payload.proof.message))
      ) {
        return ignore("invalid");
      }
      proof = { message: { ...payload.proof.message } };
    }
  } else if (payload.via !== undefined) {
    // The question tool: the hook's records prove the clicks, as the chat's proof does
    // a message: recorded after the stack opened, never used for another answer, once each.
    const refs = payload.proof?.questions ?? [];
    const keys = refs.map(citedKey);
    if (
      refs.length === 0 ||
      new Set(keys).size !== keys.length ||
      refs.some((ref) => !(Date.parse(ref.at) > Date.parse(stack.opened_at))) ||
      keys.some((key) => citedOf(draft).has(key))
    ) {
      return ignore("invalid");
    }
  }
  const relayed = event.actor.kind === "agent" ? (event.actor.agent ?? null) : null;
  for (const { item, checkpoint } of points) {
    const approval = stackApproval(checkpoint);
    if (approval === undefined) return ignore("invalid");
    const answer: Answer = {
      decision: approval.decision,
      option: approval.decision === "option_chosen" ? approval.option : undefined,
      note: undefined,
      source: payload.source,
      assurance:
        payload.source === "elicitation"
          ? "elicitation"
          : proof === null
            ? "chat_unverified"
            : "chat",
      quote: payload.source === "chat" ? payload.quote : null,
      confirmation_quote: null,
      relayed_by: relayed,
      proof,
      channel: payload.source === "elicitation" ? payload.channel : null,
      ...(payload.source === "elicitation" && payload.via !== undefined
        ? { via: payload.via }
        : {}),
    };
    // `stackProblem` said the approval fits: an answer the rules still refuse changes nothing.
    if (!applyResolution(draft, checkpoints, checkpoint, event, { answer, stack: stack.id })) {
      return false;
    }
    item.answer = { event: event.id, at: event.at, source: payload.source };
  }
  if (payload.source === "elicitation" && payload.proof !== undefined) {
    citeRefs(draft, payload.proof.questions);
  }
  agentOf(draft, event);
  return true;
}

/** The reducers of the stack to validate. */
export const STACK_REDUCERS: Readonly<Record<string, Reducer>> = {
  [STACK_EVENT_TYPES.opened]: (draft, event) => applyOpening(draft, event),
  [STACK_EVENT_TYPES.answered]: (draft, event) => {
    applyAnswer(draft, event);
  },
};
