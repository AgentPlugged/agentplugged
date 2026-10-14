import {
  type ActionRequest,
  ANTICIPATED_ANSWER_WINDOW_MS,
  CHAT_EVENT_TYPES,
  CHECKPOINT_CLOSED_EVENT_TYPES,
  CHECKPOINT_DECIDED_EVENT_TYPES,
  CHECKPOINT_EVENT_TYPES,
  type ChatMessageRef,
  type ChatProof,
  type CheckpointAnsweredPayload,
  type CheckpointAutoAppliedPayload,
  type CheckpointBlock,
  type CheckpointClosedPayload,
  type CheckpointCloseReason,
  type CheckpointCriterion,
  type CheckpointDecidedPayload,
  type CheckpointDocument,
  type CheckpointElicitedPayload,
  type CheckpointMeasuredPayload,
  type CheckpointOpenedPayload,
  type CheckpointOption,
  type CheckpointReopenedPayload,
  type CheckpointResolvedPayload,
  type CheckpointRisk,
  type CheckpointSource,
  type CheckpointStatus,
  type CheckpointType,
  type CheckpointVerdict,
  CONFIRMATION_MODES,
  type ConfirmationMode,
  type CreatorActionRecord,
  type CreatorActionSource,
  checkpointIdOf,
  ELICITATION_EVENT_TYPES,
  type EventEnvelope,
  engineUpdateRisk,
  MACHINE_DEVICE_PATTERN,
  type MemoryRecord,
  NOTE_REQUIRED,
  type PhaseId,
  type Provenance,
  type PublicationRecord,
  proofCommandsRisk,
  type RecipientRole,
  type ResolutionDecision,
  type UntrustedMark,
  type ValidationAssurance,
  type ValidationDecision,
  type ValidationSource,
} from "@agentplugged/protocol";
import { autoOption } from "../chat/auto-apply.js";
import { citedKey } from "../chat/chat-proof.js";
import { quoteDigest } from "../chat/chat-text.js";
import {
  blockScope,
  byOpening,
  confirmationFor,
  recipientFor,
  truncate,
  verdictOf,
} from "../checkpoints/checkpoint-rules.js";
import { delegationVerdict } from "../checkpoints/point-rules.js";
import {
  answerable,
  assuranceOf,
  liftsBlocks,
  resolutionProblem,
} from "../checkpoints/resolution-rules.js";
import { reasonHolds } from "../checkpoints/settled-rules.js";
import { mergeHold } from "../ci/ci-rules.js";
import { JOURNEY_CATALOG } from "../journey/journey-catalog.js";
import { agentOf, dictionary, type StoryState, section, storyById } from "./agent-reducers.js";
import { releaseExecutions } from "./creator-action-reducers.js";
import { untrustedAnswer } from "./human-reducers.js";
import type { ProjectionDraft, Reducer } from "./reducers.js";

/** The last value of a metric, who reported it and when. */
export interface MeasureEntry {
  readonly value: number;
  /** The agent that reported it, or null for another actor. */
  readonly measured_by: string | null;
  readonly measured_at: string;
}

/**
 * The creator's answer to a checkpoint: at the terminal, relayed from the chat, or
 * applied by the engine at the `auto` level.
 */
export interface CheckpointResolution {
  readonly decision: ResolutionDecision;
  readonly option: string | null;
  readonly note: string | null;
  /** The waiver's deadline, or null. */
  readonly waiver_until: string | null;
  /**
   * The device that signed it: the creator's (`human:...`) at the terminal, the machine's for an
   * answer relayed from the chat or applied by the engine.
   */
  readonly by: string;
  readonly at: string;
  /**
   * Drawn from the event, never declared: `presence` (WebAuthn with UV) or `locale` at the
   * terminal, `chat` when the hook proved the quote, `chat_unverified` without, `system` at `auto`.
   */
  readonly assurance: ValidationAssurance;
  readonly source: ValidationSource;
  /** The ULID of the event that answered. */
  readonly event: string;
  /** The creator's words an agent relayed from the chat, or null. */
  readonly quote: string | null;
  /** The creator's confirmation of an irreversible action, quoted from the chat, or null. */
  readonly confirmation_quote: string | null;
  /** The agent that relayed a chat answer, or null. */
  readonly relayed_by: string | null;
  /** What the hook proved of the quoted messages (digests and dates), or null. */
  readonly proof: ChatProof | null;
  /**
   * The AI tool whose form the creator answered in (`source: elicitation`), as its MCP
   * client introduced itself; null for another source.
   */
  readonly channel?: string | null;
  /**
   * How the creator answered in the AI tool: `question_tool` when they chose in its
   * question tool and the tool's hook proved it (`proof` then holds the questions' fingerprint and
   * the record's date); absent for the form and every other source.
   */
  readonly via?: "question_tool";
  /** The stack of points the creator answered together, or absent. */
  readonly stack?: string;
}

/** `state.validations[]`: one answer of the creator, in projection order. */
export interface ValidationEntry {
  readonly checkpoint: string;
  /** A resolution, or `reopened`: an automatic application cancelled. */
  readonly decision: ValidationDecision;
  readonly option: string | null;
  /** The device that signed it (`human:...` at the terminal, `machine:...` otherwise). */
  readonly author: string;
  readonly at: string;
  readonly source: ValidationSource;
  readonly assurance: ValidationAssurance;
  readonly event: string;
  /** The creator's words quoted from the chat, or null. */
  readonly quote: string | null;
  /** The agent that relayed a chat answer, or null. */
  readonly relayed_by: string | null;
  /** The AI tool whose form the creator answered in, or null. */
  readonly channel?: string | null;
  /** `question_tool` when the creator chose in the AI tool's question tool. */
  readonly via?: "question_tool";
  /** The stack of points the creator answered together, or absent. */
  readonly stack?: string;
}

/** `state.checkpoints[id]`: a checkpoint, its status, its last measures and their verdict. */
export interface CheckpointState {
  /** `G-` then the last 10 characters of the ULID of the event that opened it. */
  readonly id: string;
  readonly type: CheckpointType;
  readonly risk: CheckpointRisk;
  readonly irreversible: boolean;
  readonly recipient_role: RecipientRole;
  readonly confirmation: readonly ConfirmationMode[];
  readonly title: string;
  /** Replaced for a merge checkpoint refreshed by a new review pass. */
  summary: string;
  readonly story: string | null;
  readonly documents: readonly CheckpointDocument[];
  readonly blocks: readonly CheckpointBlock[];
  readonly options: readonly CheckpointOption[] | null;
  readonly recommendation: string | null;
  readonly criteria: readonly CheckpointCriterion[] | null;
  /**
   * `blocked_result` when a `blocked` result opened it, `untrusted_action` when an installation to
   * validate did (the name is kept, the journals hold it), else null.
   */
  readonly source: CheckpointSource | null;
  status: CheckpointStatus;
  /** The agent that opened it, or null for another actor. */
  readonly opened_by: string | null;
  readonly opened_at: string;
  /** The ULID of the event that opened it: the opening order. */
  readonly opened_event: string;
  /** The last value reported for each metric. */
  measures: Record<string, MeasureEntry>;
  /** The verdict of its criteria on its measures, or null without criteria. */
  verdict: CheckpointVerdict | null;
  /** The creator's last answer, or null while it was never answered. */
  resolution: CheckpointResolution | null;
  /** A refused checkpoint of the same story this one supersedes, or null. */
  readonly supersedes: string | null;
  /** The phase a `phase_end` checkpoint closes, else null. */
  readonly phase: PhaseId | null;
  /**
   * Its blocks no longer apply: answered with a lifting decision, or superseded by a checkpoint
   * answered so. False while open, and after a refusal.
   */
  blocks_lifted: boolean;
  /** Milliseconds waived in all, renewals included (capped at 90 days). */
  waived_ms: number;
  /** The installation an `untrusted_action` checkpoint asks for, or null. */
  readonly request: ActionRequest | null;
  /**
   * Why the session that opened it was untrusted, or null. Written by the journals
   * only, kept for the history: it blocks nothing.
   */
  readonly untrusted: UntrustedMark | null;
  /** The provenance of the event that opened it. */
  readonly provenance: Provenance;
  /**
   * When the creator reopened a point an agent had decided: the point then waits for
   * their own answer, whatever they chose to keep; absent otherwise.
   */
  reopened_at?: string | null;
  /**
   * The agent responsible handed the point back to the creator (`escalate`): who, why
   * and when. The point then waits for the creator's own answer; absent otherwise.
   */
  escalated?: {
    readonly by: string | null;
    readonly reason: string;
    readonly at: string;
    readonly event: string;
  } | null;
  /** The action a `creator_action` checkpoint asks the creator for, else null. */
  readonly creator_action?: CreatorActionRecord | null;
  /** When the engine carried out that action once approved, else null. */
  executed?: CreatorActionExecution | null;
  /** What a `memory` checkpoint is about, in clear and without content. */
  readonly memory?: MemoryRecord | null;
  /** The `lessons.recorded` or `lessons.promoted` that carried a memory checkpoint out, or null. */
  memory_done?: { readonly event: string; readonly at: string } | null;
  /** The angle, audience and short version of a `publication` checkpoint, else null. */
  readonly publication?: PublicationRecord | null;
  /**
   * Why the engine closed it, when it did (status `closed`): its object was settled,
   * nobody answered it. `ref` is the newer point that replaced it (`replaced`), else null.
   */
  closed?: {
    readonly reason: CheckpointCloseReason;
    readonly ref: string | null;
    readonly at: string;
    readonly event: string;
  } | null;
}

/** The checkpoints of a projection's state, by id (an empty dictionary when there are none). */
export function checkpointsOf(
  state: Readonly<Record<string, unknown>>,
): Record<string, CheckpointState> {
  return (state.checkpoints as Record<string, CheckpointState> | undefined) ?? {};
}

/** A creator's action carried out: the event, its date and where it was approved. */
export interface CreatorActionExecution {
  readonly event: string;
  readonly at: string;
  readonly source: CreatorActionSource;
}

/** The modes the rules require, plus any stronger one the payload asked, in the modes' order. */
function confirmation(
  required: readonly ConfirmationMode[],
  asked: readonly ConfirmationMode[],
): ConfirmationMode[] {
  return CONFIRMATION_MODES.filter((mode) => required.includes(mode) || asked.includes(mode));
}

function applyMeasures(checkpoint: CheckpointState, event: EventEnvelope): void {
  const payload = event.payload as CheckpointMeasuredPayload;
  const measured_by = event.actor.kind === "agent" ? (event.actor.agent ?? null) : null;
  for (const [metric, value] of Object.entries(payload.measures)) {
    checkpoint.measures[metric] = { value, measured_by, measured_at: event.at };
  }
  if (checkpoint.criteria !== null) {
    const values = dictionary<number>();
    for (const [metric, entry] of Object.entries(checkpoint.measures)) values[metric] = entry.value;
    checkpoint.verdict = verdictOf(checkpoint.criteria, values);
  }
}

/** Lists `id` in `waiting_on` of `story`, in opening order. */
function wait(
  draft: ProjectionDraft,
  checkpoints: Record<string, CheckpointState>,
  story: string,
  id: string,
): void {
  const waiting = storyById(draft, story).waiting_on;
  if (waiting.includes(id)) return;
  waiting.push(id);
  waiting.sort((a, b) =>
    byOpening(checkpoints[a] as CheckpointState, checkpoints[b] as CheckpointState),
  );
}

/** Removes `id` from `waiting_on` of `story`. */
function unwait(draft: ProjectionDraft, story: string, id: string): void {
  const waiting = storyById(draft, story).waiting_on;
  const index = waiting.indexOf(id);
  if (index !== -1) waiting.splice(index, 1);
}

/** The stories a checkpoint's blocks apply to. */
function scopes(checkpoint: CheckpointState): string[] {
  const found = new Set<string>();
  for (const block of checkpoint.blocks) {
    const scope = blockScope(block, checkpoint.story);
    if (scope !== undefined) found.add(scope);
  }
  return [...found];
}

/**
 * The point a `blocked` result opened is closed by the start of its story, when it was
 * opened before: it was refused before (not validated, not in the sprint), and the cause is gone.
 * Nothing waits for the creator's answer any more, and the review of the story never waits for it.
 * The reason, `block_lifted`, is in the projection (`closed`) with the event that started the story.
 */
export function closeLiftedBlocks(
  draft: ProjectionDraft,
  story: string,
  event: EventEnvelope,
): void {
  const checkpoints = section<CheckpointState>(draft, "checkpoints");
  for (const checkpoint of Object.values(checkpoints)) {
    if (
      checkpoint.status !== "open" ||
      checkpoint.source !== "blocked_result" ||
      checkpoint.story !== story
    ) {
      continue;
    }
    checkpoint.status = "closed";
    checkpoint.closed = { reason: "block_lifted", ref: null, at: event.at, event: event.id };
    lift(draft, checkpoint);
  }
}

/** Lifts a checkpoint's blocks: its stories no longer wait for it. */
function lift(draft: ProjectionDraft, checkpoint: CheckpointState): void {
  checkpoint.blocks_lifted = true;
  for (const story of scopes(checkpoint)) unwait(draft, story, checkpoint.id);
}

/** An answer as every source gives it: the terminal, the chat, or the engine at `auto`. */
export interface Answer {
  readonly decision: ResolutionDecision;
  readonly option?: string | undefined;
  readonly note?: string | undefined;
  readonly waiver_until?: string | undefined;
  readonly source: ValidationSource;
  readonly assurance: ValidationAssurance;
  readonly quote: string | null;
  readonly confirmation_quote: string | null;
  readonly relayed_by: string | null;
  readonly proof: ChatProof | null;
  readonly channel: string | null;
  /** The answer was chosen in the AI tool's question tool, proved by its hook. */
  readonly via?: "question_tool";
}

/**
 * The answer an event gives (its type checked by its reducer): a `checkpoint.resolved` signed by
 * the creator (the assurance from its signature), a `checkpoint.answered` relayed by an agent
 * (`chat` with the hook's proof, `chat_unverified` without), a `checkpoint.auto_applied` of the
 * engine (`system`).
 */
function answerOf(event: EventEnvelope): Answer {
  if (event.type === ELICITATION_EVENT_TYPES.answered) {
    // Clicked by the creator in the AI tool's form the engine asked for: the
    // assurance comes from the event's type, never from a declaration.
    const payload = event.payload as CheckpointElicitedPayload;
    return {
      decision: payload.decision,
      option: payload.option,
      note: payload.note,
      source: "elicitation",
      assurance: "elicitation",
      quote: null,
      confirmation_quote: null,
      relayed_by: event.actor.kind === "agent" ? (event.actor.agent ?? null) : null,
      // The question tool: what its hook recorded, cited once like a message.
      proof: payload.proof === undefined ? null : { message: { ...payload.proof.question } },
      channel: payload.channel,
      ...(payload.via === undefined ? {} : { via: payload.via }),
    };
  }
  if (event.type === CHAT_EVENT_TYPES.answered) {
    const payload = event.payload as CheckpointAnsweredPayload;
    return {
      decision: payload.decision,
      option: payload.option,
      // The creator's words as the note a decision needs, cut to a note's length.
      note:
        payload.note ??
        (NOTE_REQUIRED.has(payload.decision) ? truncate(payload.quote, 2000) : undefined),
      source: "chat",
      assurance: payload.proof === undefined ? "chat_unverified" : "chat",
      quote: payload.quote,
      confirmation_quote: payload.confirmation_quote ?? null,
      relayed_by: event.actor.kind === "agent" ? (event.actor.agent ?? null) : null,
      proof:
        payload.proof === undefined
          ? null
          : {
              message: { ...payload.proof.message },
              ...(payload.proof.confirmation === undefined
                ? {}
                : { confirmation: { ...payload.proof.confirmation } }),
            },
      channel: null,
    };
  }
  if (event.type === CHECKPOINT_DECIDED_EVENT_TYPES.decided) {
    // Decided by the agent responsible for the point: never the creator's answer.
    const payload = event.payload as CheckpointDecidedPayload;
    return {
      // `escalate` never reaches here: it answers nothing (`applyEscalation`).
      decision: payload.decision as ResolutionDecision,
      option: payload.option,
      note: payload.reason,
      source: "agent",
      assurance: "agent",
      quote: null,
      confirmation_quote: null,
      relayed_by: event.actor.kind === "agent" ? (event.actor.agent ?? null) : null,
      proof: null,
      channel: null,
    };
  }
  if (event.type === CHAT_EVENT_TYPES.autoApplied) {
    const payload = event.payload as CheckpointAutoAppliedPayload;
    return {
      decision: payload.decision,
      option: payload.option,
      source: "auto",
      assurance: "system",
      quote: null,
      confirmation_quote: null,
      relayed_by: null,
      proof: null,
      channel: null,
    };
  }
  const payload = event.payload as CheckpointResolvedPayload;
  return {
    decision: payload.decision,
    option: payload.option,
    note: payload.note,
    waiver_until: payload.waiver_until,
    source: payload.source,
    assurance: assuranceOf(event.alg),
    quote: null,
    confirmation_quote: null,
    relayed_by: null,
    proof: null,
    channel: null,
  };
}

/**
 * Why an answer of the chat or of the engine cannot count on this checkpoint, or undefined. A
 * chat answer (`checkpoint.answered`) comes from an agent and never waives (one answer
 * validates a point whatever its risk, with the hook's proof or, without the hook, as
 * `chat_unverified`; an answer clicked in the engine's form is not a chat answer). An automatic application (`checkpoint.auto_applied`) comes from the
 * engine (`system`, a machine), in the very write that opened the checkpoint, on a checkpoint the
 * `auto` level answers, with its recommended option.
 */
function answerProblem(
  draft: ProjectionDraft,
  checkpoint: CheckpointState,
  event: EventEnvelope,
): "invalid" | undefined {
  if (event.type === ELICITATION_EVENT_TYPES.answered) {
    // From the agent that asked (the engine wrote it in that call), on a machine.
    const payload = event.payload as CheckpointElicitedPayload;
    if (event.actor.kind !== "agent" || !MACHINE_DEVICE_PATTERN.test(event.actor.device)) {
      return "invalid";
    }
    if (payload.via !== undefined) {
      // The question tool: the hook's record proves the click as the chat's proof does
      // a message: recorded after the checkpoint opened, never used for another answer.
      // One click is the whole answer, whatever the risk (no second question).
      const proof = payload.proof;
      if (proof === undefined) return "invalid";
      if (!(Date.parse(proof.question.at) > Date.parse(checkpoint.opened_at))) return "invalid";
      if (citedOf(draft).has(citedKey(proof.question))) return "invalid";
    }
    return undefined;
  }
  if (event.type === CHAT_EVENT_TYPES.answered) {
    const payload = event.payload as CheckpointAnsweredPayload;
    if (event.actor.kind !== "agent") return "invalid";
    // One message answers the point, whatever its risk; nothing confirms it, and an
    // answer without the hook's proof counts as `chat_unverified` (the assurance says so).
    const proof = payload.proof;
    if (proof === undefined) return undefined;
    // The engine checked the proof against the hook's store; the journal checks it holds
    // together: the quote's digest, a message after the opening, never cited already. A
    // confirmation proof, written, is checked as it was.
    const message = Date.parse(proof.message.at);
    if (proof.message.digest !== quoteDigest(payload.quote)) return "invalid";
    // An agreement given just before the point opened, for exactly its decision.
    const early =
      payload.anticipated === true &&
      checkpoint.risk !== "high" &&
      checkpoint.type !== "release" &&
      checkpoint.type !== "publication" &&
      checkpoint.type !== "creator_action";
    const from = Date.parse(checkpoint.opened_at) - (early ? ANTICIPATED_ANSWER_WINDOW_MS : 0);
    if (!(message > from)) return "invalid";
    if (citedOf(draft).has(citedKey(proof.message))) return "invalid";
    const confirmation = proof.confirmation;
    if (confirmation !== undefined) {
      if (confirmation.digest !== quoteDigest(payload.confirmation_quote ?? "")) return "invalid";
      if (!(Date.parse(confirmation.at) > message)) return "invalid";
      if (citedOf(draft).has(citedKey(confirmation))) return "invalid";
    }
    return undefined;
  }
  if (event.type === CHECKPOINT_DECIDED_EVENT_TYPES.decided) {
    // An agent on a machine, on a point the creator can leave to the agents: never an escalation,
    // an action of the creator's, a memory change, nor a point the creator reopened. Whether they
    // kept this kind of point is read by the engine when it writes (the main branch's settings).
    if (event.actor.kind !== "agent" || !MACHINE_DEVICE_PATTERN.test(event.actor.device)) {
      return "invalid";
    }
    if (!delegationVerdict(checkpoint, { fixed: [], strict: false }).delegated) return "invalid";
    return undefined;
  }
  if (event.type === CHAT_EVENT_TYPES.autoApplied) {
    const payload = event.payload as CheckpointAutoAppliedPayload;
    if (event.actor.kind !== "system" || !MACHINE_DEVICE_PATTERN.test(event.actor.device)) {
      return "invalid";
    }
    if (draft.parents.get(event.id) !== checkpoint.opened_event) return "invalid";
    if (autoOption(checkpoint) !== payload.option) return "invalid";
    return undefined;
  }
  return undefined;
}

/**
 * Applies the creator's answer, or refuses it: `already_resolved` when the checkpoint was already
 * answered (a waiver whose deadline is past at the answer's date can be answered again),
 * `invalid` when the answer does not fit it (an option it does not have, a waiver it does not
 * allow, beyond 30 days, or beyond 90 days waived in all; and `answerProblem` for the chat and
 * the engine). A lifting decision (approved, with reservations, option chosen, waived) lifts its
 * blocks, and those of the checkpoint it supersedes when that one was refused; a refusal
 * (rejected, changes requested) closes it and keeps its blocks. The assurance comes from the
 * event (`answerOf`), and a `high` risk answered in `locale` is flagged (`locale_on_high_risk`).
 * False when refused.
 *
 * `forced`: the answer of one point of a stack, which the stack's own reducer built
 * and checked as a whole (the message, the proof, the points): it replaces what `answerOf` and
 * `answerProblem` read from the event, and the resolution keeps the stack it came from.
 */
export function applyResolution(
  draft: ProjectionDraft,
  checkpoints: Record<string, CheckpointState>,
  checkpoint: CheckpointState,
  event: EventEnvelope,
  forced?: { readonly answer: Answer; readonly stack: string },
): boolean {
  const answer = forced?.answer ?? answerOf(event);
  const at = Date.parse(event.at);
  if (!answerable(checkpoint, at)) {
    draft.ignored.push({ id: event.id, reason: "already_resolved" });
    return false;
  }
  // A story's merge checkpoint held back by its gate is never approved, whatever
  // the channel of the answer.
  const merge = mergeHold(draft.state, checkpoint);
  if (
    (forced === undefined && answerProblem(draft, checkpoint, event) !== undefined) ||
    resolutionProblem({ ...checkpoint, ...merge }, answer, at) !== undefined
  ) {
    draft.ignored.push({ id: event.id, reason: "invalid" });
    return false;
  }
  const resolution: CheckpointResolution = {
    decision: answer.decision,
    option: answer.option ?? null,
    note: answer.note ?? null,
    waiver_until: answer.waiver_until ?? null,
    by: event.actor.device,
    at: event.at,
    assurance: answer.assurance,
    source: answer.source,
    event: event.id,
    quote: answer.quote,
    confirmation_quote: answer.confirmation_quote,
    relayed_by: answer.relayed_by,
    proof: answer.proof,
    ...(answer.channel === null ? {} : { channel: answer.channel }),
    ...(answer.via === undefined ? {} : { via: answer.via }),
    ...(forced === undefined ? {} : { stack: forced.stack }),
  };
  checkpoint.resolution = resolution;
  checkpoint.status = answer.decision === "waived" ? "waived" : "resolved";
  if (answer.waiver_until !== undefined) {
    checkpoint.waived_ms += Date.parse(answer.waiver_until) - at;
  }
  if (liftsBlocks(answer.decision)) {
    lift(draft, checkpoint);
    const superseded = supersededOf(checkpoints, checkpoint);
    if (superseded !== undefined) lift(draft, superseded);
  } else {
    // A refusal keeps the action blocked, until a superseding checkpoint is approved.
    checkpoint.blocks_lifted = false;
    for (const story of scopes(checkpoint)) wait(draft, checkpoints, story, checkpoint.id);
  }
  cite(draft, resolution.proof);
  pushValidation(draft, {
    checkpoint: checkpoint.id,
    decision: resolution.decision,
    option: resolution.option,
    author: resolution.by,
    at: resolution.at,
    source: resolution.source,
    assurance: resolution.assurance,
    event: event.id,
    quote: resolution.quote,
    relayed_by: resolution.relayed_by,
    ...(answer.channel === null ? {} : { channel: answer.channel }),
    ...(answer.via === undefined ? {} : { via: answer.via }),
    ...(forced === undefined ? {} : { stack: forced.stack }),
  });
  if (checkpoint.risk === "high" && answer.assurance === "locale") {
    draft.warnings.push({ code: "locale_on_high_risk", checkpoint: checkpoint.id, id: event.id });
  }
  return true;
}

/**
 * The refused checkpoint of the same story `checkpoint` supersedes, whose blocks its approval
 * lifts too, or undefined.
 */
function supersededOf(
  checkpoints: Record<string, CheckpointState>,
  checkpoint: CheckpointState,
): CheckpointState | undefined {
  const superseded =
    checkpoint.supersedes === null || !Object.hasOwn(checkpoints, checkpoint.supersedes)
      ? undefined
      : (checkpoints[checkpoint.supersedes] as CheckpointState);
  return superseded !== undefined &&
    superseded.status === "resolved" &&
    superseded.story === checkpoint.story &&
    superseded.resolution !== null &&
    !liftsBlocks(superseded.resolution.decision)
    ? superseded
    : undefined;
}

/**
 * Records the messages a chat answer cited (`state.chat_cited`, `citedKey`): one message of the
 * creator answers one checkpoint at most.
 */
/** The messages chat answers cited so far (`citedKey`). */
export function citedOf(draft: ProjectionDraft): ReadonlySet<string> {
  return new Set((draft.state.chat_cited as string[] | undefined) ?? []);
}

/** Records references the question tool's hook proved as cited: each answers once. */
export function citeRefs(draft: ProjectionDraft, refs: readonly ChatMessageRef[]): void {
  const cited = (draft.state.chat_cited as string[] | undefined) ?? [];
  for (const ref of refs) if (!cited.includes(citedKey(ref))) cited.push(citedKey(ref));
  draft.state.chat_cited = cited;
}

function cite(draft: ProjectionDraft, proof: ChatProof | null | undefined): void {
  if (proof === null || proof === undefined) return;
  const cited = (draft.state.chat_cited as string[] | undefined) ?? [];
  for (const ref of [proof.message, proof.confirmation]) {
    if (ref !== undefined && !cited.includes(citedKey(ref))) cited.push(citedKey(ref));
  }
  draft.state.chat_cited = cited;
}

function pushValidation(draft: ProjectionDraft, entry: ValidationEntry): void {
  const validations = (draft.state.validations as ValidationEntry[] | undefined) ?? [];
  validations.push(entry);
  draft.state.validations = validations;
}

/**
 * An agent handing a point back to the creator: the point stays open and waits for
 * their own answer, with the agent's reason. Written by an agent on a machine, on an open point the
 * creator could have left to the agents; anything else is ignored.
 */
function applyEscalation(
  draft: ProjectionDraft,
  event: EventEnvelope,
  payload: CheckpointDecidedPayload,
): void {
  const checkpoints = section<CheckpointState>(draft, "checkpoints");
  const checkpoint = Object.hasOwn(checkpoints, payload.checkpoint)
    ? (checkpoints[payload.checkpoint] as CheckpointState)
    : undefined;
  if (
    checkpoint === undefined ||
    event.actor.kind !== "agent" ||
    !MACHINE_DEVICE_PATTERN.test(event.actor.device) ||
    !answerable(checkpoint, Date.parse(event.at)) ||
    !delegationVerdict(checkpoint, { fixed: [], strict: false }).delegated
  ) {
    draft.ignored.push({ id: event.id, reason: "invalid" });
    return;
  }
  checkpoint.escalated = {
    by: event.actor.agent ?? null,
    reason: payload.reason,
    at: event.at,
    event: event.id,
  };
  agentOf(draft, event);
}

/** True for the merge checkpoint of a story (`source: merge`). */
function isMergeSource(checkpoint: Pick<CheckpointState, "type" | "source">): boolean {
  return checkpoint.type === "story" && checkpoint.source === "merge";
}

/**
 * Reopens a checkpoint the engine answered on its own (`auto` level), or refuses it
 * (`not_reopenable`): its status open again, its answer forgotten, its blocks in force again (and
 * those of the refused checkpoint it superseded). From the chat, an agent relays it (the hook's
 * proof gives `chat`, else `chat_unverified`); from the terminal, the creator signs it.
 */
function applyReopening(
  draft: ProjectionDraft,
  checkpoints: Record<string, CheckpointState>,
  event: EventEnvelope,
): boolean {
  const payload = event.payload as CheckpointReopenedPayload;
  const checkpoint = Object.hasOwn(checkpoints, payload.checkpoint)
    ? (checkpoints[payload.checkpoint] as CheckpointState)
    : undefined;
  // An automatic application, or a point an agent decided; never a merge already done.
  const reopenable =
    checkpoint?.status === "resolved" &&
    (checkpoint.resolution?.source === "auto" || checkpoint.resolution?.source === "agent") &&
    !(
      checkpoint.story !== null &&
      isMergeSource(checkpoint) &&
      section<StoryState>(draft, "stories")[checkpoint.story]?.merged !== undefined
    );
  if (checkpoint === undefined || !reopenable) {
    draft.ignored.push({ id: event.id, reason: "not_reopenable" });
    return false;
  }
  const superseded =
    checkpoint.supersedes === null || !Object.hasOwn(checkpoints, checkpoint.supersedes)
      ? undefined
      : (checkpoints[checkpoint.supersedes] as CheckpointState);
  const decidedByAgent = checkpoint.resolution?.source === "agent";
  checkpoint.status = "open";
  checkpoint.resolution = null;
  checkpoint.blocks_lifted = false;
  // The creator reopened a point the agents had decided: it waits for their own answer now.
  if (decidedByAgent) checkpoint.reopened_at = event.at;
  for (const story of scopes(checkpoint)) wait(draft, checkpoints, story, checkpoint.id);
  if (
    superseded !== undefined &&
    superseded.story === checkpoint.story &&
    superseded.blocks_lifted &&
    superseded.resolution !== null &&
    !liftsBlocks(superseded.resolution.decision)
  ) {
    superseded.blocks_lifted = false;
    for (const story of scopes(superseded)) wait(draft, checkpoints, story, superseded.id);
  }
  // The message of a reopening is not cited: « annule et prends B » answers the point next.
  pushValidation(draft, {
    checkpoint: checkpoint.id,
    decision: "reopened",
    option: null,
    author: event.actor.device,
    at: event.at,
    source: payload.source,
    assurance:
      event.actor.kind === "human"
        ? assuranceOf(event.alg)
        : payload.proof === undefined
          ? "chat_unverified"
          : "chat",
    event: event.id,
    quote: payload.quote ?? null,
    relayed_by: event.actor.kind === "agent" ? (event.actor.agent ?? null) : null,
  });
  return true;
}

/**
 * Once every event is applied: an answer whose checkpoint never opened is ignored
 * (`checkpoint_unknown`). Expiry of waivers is never decided here (`waiverExpired`, at read time).
 */
export function settleHeldResolutions(draft: ProjectionDraft): void {
  for (const answers of draft.pendingResolutions.values()) {
    for (const answer of answers) {
      draft.ignored.push({ id: answer.id, reason: "checkpoint_unknown" });
    }
  }
  draft.pendingResolutions.clear();
  // A reopening whose checkpoint never opened, or was never applied automatically.
  for (const reopenings of draft.pendingReopenings.values()) {
    for (const reopening of reopenings) {
      draft.ignored.push({ id: reopening.id, reason: "not_reopenable" });
    }
  }
  draft.pendingReopenings.clear();
}

/**
 * The reducers of checkpoints.
 *
 * `checkpoint.opened` adds an open checkpoint and lists it in `waiting_on` of each story it
 * blocks. Its recipient and confirmation are checked again by the rules: a signed payload weaker
 * than them is raised, with a `checkpoint_weak_payload` warning. A second checkpoint with an id
 * already taken is ignored (`checkpoint_id_collision`), with a warning naming both events.
 *
 * `checkpoint.measured` keeps the last value of each metric (with who and when) and computes the
 * verdict again. Measures of a checkpoint not opened yet in projection order (two devices'
 * clocks apart) wait, and are applied when it opens.
 *
 * `checkpoint.resolved` records the creator's answer (`applyResolution`): only from a
 * trusted creator's key (`not_human`, `unendorsed_human`), and, signed by WebAuthn, by a
 * credential linked to it (`unknown_signer`). An answer to a checkpoint not opened yet in
 * projection order is held, and applied (and counted) when it opens; `checkpoint_unknown` when it
 * never does.
 */
export const CHECKPOINT_REDUCERS: Readonly<Record<string, Reducer>> = {
  [CHECKPOINT_EVENT_TYPES.opened]: (draft, event) => {
    const checkpoints = section<CheckpointState>(draft, "checkpoints");
    const id = checkpointIdOf(event.id);
    if (Object.hasOwn(checkpoints, id)) {
      draft.ignored.push({ id: event.id, reason: "checkpoint_id_collision" });
      draft.warnings.push({
        code: "checkpoint_id_collision",
        checkpoint: id,
        ids: [(checkpoints[id] as CheckpointState).opened_event, event.id],
      });
      return;
    }
    const payload = event.payload as CheckpointOpenedPayload;
    // A creator's action is opened by an agent's request, with the risk the engine
    // fixes: a CI waiver is high-risk; the gestures of the forge are as risky as the
    // engine fixes them (the repository's creation is medium, high when public). Its
    // `irreversible` flag is no longer checked (the engine writes none; an older journal holds some,
    // which only keep the point out of a stack and of the automatic level).
    const asked = payload.creator_action;
    if (
      asked !== undefined &&
      (event.actor.kind !== "agent" ||
        (asked.kind === "ci_waive" && payload.risk !== "high") ||
        (asked.kind === "step_skip" && payload.risk !== JOURNEY_CATALOG[asked.step].risk) ||
        (asked.kind === "engine_update" && payload.risk !== engineUpdateRisk(asked)) ||
        (asked.kind === "environment_fix" && payload.risk !== "medium") ||
        (asked.kind === "proof_commands" && payload.risk !== proofCommandsRisk(asked)) ||
        ((asked.kind === "forge_push_main" ||
          asked.kind === "forge_merge_ci" ||
          asked.kind === "release") &&
          payload.risk !== "high") ||
        (asked.kind === "forge_repo_create" &&
          payload.risk !== (asked.visibility === "public" ? "high" : "medium")))
    ) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    // A memory change is opened by an agent's proposal, never by the creator's key.
    if (payload.memory !== undefined && event.actor.kind !== "agent") {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    agentOf(draft, event);
    const story = event.story ?? null;
    const recipient = recipientFor(
      payload.type,
      payload.risk,
      payload.recipient_role,
      payload.phase,
    );
    const required = confirmationFor(payload.risk);
    const raised: Array<"recipient_role" | "confirmation"> = [];
    if (recipient !== payload.recipient_role) raised.push("recipient_role");
    if (!required.every((mode) => payload.confirmation.includes(mode))) {
      raised.push("confirmation");
    }
    if (raised.length > 0) {
      draft.warnings.push({
        code: "checkpoint_weak_payload",
        checkpoint: id,
        id: event.id,
        fields: raised,
      });
    }
    const checkpoint: CheckpointState = {
      id,
      type: payload.type,
      risk: payload.risk,
      irreversible: payload.irreversible,
      recipient_role: recipient,
      confirmation: confirmation(required, payload.confirmation),
      title: payload.title,
      summary: payload.summary,
      story,
      documents: payload.documents.map((document) => ({ ...document })),
      blocks: payload.blocks.map((block) => ({ ...block })),
      options: payload.options?.map((option) => ({ ...option })) ?? null,
      recommendation: payload.recommendation ?? null,
      criteria: payload.criteria?.map((criterion) => ({ ...criterion })) ?? null,
      source: payload.source ?? null,
      status: "open",
      opened_by: event.actor.kind === "agent" ? (event.actor.agent ?? null) : null,
      opened_at: event.at,
      opened_event: event.id,
      measures: dictionary<MeasureEntry>(),
      verdict: payload.criteria === undefined ? null : verdictOf(payload.criteria, {}),
      resolution: null,
      supersedes: payload.supersedes ?? null,
      phase: payload.phase ?? null,
      blocks_lifted: false,
      waived_ms: 0,
      request: payload.request === undefined ? null : { ...payload.request },
      untrusted:
        payload.untrusted === undefined
          ? null
          : {
              ...payload.untrusted,
              reads: payload.untrusted.reads.map((read) => ({ ...read })),
            },
      provenance: event.provenance,
      ...(payload.creator_action === undefined
        ? {}
        : {
            creator_action: JSON.parse(
              JSON.stringify(payload.creator_action),
            ) as CreatorActionRecord,
            executed: null,
          }),
      ...(payload.memory === undefined
        ? {}
        : {
            memory: JSON.parse(JSON.stringify(payload.memory)) as MemoryRecord,
            memory_done: null,
          }),
      ...(payload.publication === undefined
        ? {}
        : { publication: { ...payload.publication } as PublicationRecord }),
    };
    checkpoints[id] = checkpoint;
    for (const block of checkpoint.blocks) {
      const scope = blockScope(block, story);
      if (scope !== undefined) wait(draft, checkpoints, scope, id);
    }
    const pending = draft.pendingMeasures.get(id);
    if (pending !== undefined) {
      draft.pendingMeasures.delete(id);
      for (const measured of pending) applyMeasures(checkpoint, measured);
    }
    const answers = draft.pendingResolutions.get(id);
    if (answers !== undefined) {
      draft.pendingResolutions.delete(id);
      for (const answer of answers) {
        if (!applyResolution(draft, checkpoints, checkpoint, answer)) continue;
        draft.released.push(answer);
        // A creator's action carried out right after this approval.
        releaseExecutions(draft, answer.id);
      }
    }
  },
  [CHECKPOINT_EVENT_TYPES.measured]: (draft, event) => {
    agentOf(draft, event);
    const payload = event.payload as CheckpointMeasuredPayload;
    const checkpoints = section<CheckpointState>(draft, "checkpoints");
    if (!Object.hasOwn(checkpoints, payload.checkpoint)) {
      const pending = draft.pendingMeasures.get(payload.checkpoint) ?? [];
      pending.push(event);
      draft.pendingMeasures.set(payload.checkpoint, pending);
      return;
    }
    applyMeasures(checkpoints[payload.checkpoint] as CheckpointState, event);
  },
  [CHECKPOINT_EVENT_TYPES.resolved]: (draft, event) => {
    if (event.actor.kind !== "human") {
      draft.ignored.push({ id: event.id, reason: "not_human" });
      return;
    }
    const refusal = untrustedAnswer(draft, event);
    if (refusal !== undefined) {
      draft.ignored.push({ id: event.id, reason: refusal });
      return;
    }
    holdOrApply(draft, event, (event.payload as CheckpointResolvedPayload).checkpoint);
  },
  /**
   * The creator's answer relayed from the chat: like a `checkpoint.resolved`, from an
   * agent (`answerProblem`), held while its checkpoint is not open yet in projection order.
   */
  [CHAT_EVENT_TYPES.answered]: (draft, event) => {
    holdOrApply(draft, event, (event.payload as CheckpointAnsweredPayload).checkpoint);
  },
  /**
   * The creator's answer clicked in the AI tool's form: like a chat answer, from the
   * agent that asked (`answerProblem`), held while its checkpoint is not open yet.
   */
  [ELICITATION_EVENT_TYPES.answered]: (draft, event) => {
    holdOrApply(draft, event, (event.payload as CheckpointElicitedPayload).checkpoint);
  },
  /**
   * A point decided by the agent responsible for it: like a chat answer, from an agent
   * on a machine (`answerProblem`), with the reason as its note, held while its checkpoint is not
   * open yet. Never the creator's answer: its source and its assurance are `agent`.
   */
  [CHECKPOINT_DECIDED_EVENT_TYPES.decided]: (draft, event) => {
    const payload = event.payload as CheckpointDecidedPayload;
    const id = payload.checkpoint;
    if (payload.decision === "escalate") {
      applyEscalation(draft, event, payload);
      return;
    }
    holdOrApply(draft, event, id);
    agentOf(draft, event);
    // Reopenings seen before, from a machine whose clock is behind: applied now, in order.
    const checkpoints = section<CheckpointState>(draft, "checkpoints");
    if (!Object.hasOwn(checkpoints, id) || checkpoints[id]?.resolution?.event !== event.id) return;
    const reopenings = draft.pendingReopenings.get(id);
    if (reopenings === undefined) return;
    draft.pendingReopenings.delete(id);
    for (const reopening of reopenings) {
      if (applyReopening(draft, checkpoints, reopening)) draft.released.push(reopening);
    }
  },
  /**
   * The recommended option applied by the engine at the `auto` level: only right
   * after the opening of its checkpoint, in the same write (`answerProblem`).
   */
  [CHAT_EVENT_TYPES.autoApplied]: (draft, event) => {
    const checkpoints = section<CheckpointState>(draft, "checkpoints");
    const id = (event.payload as CheckpointAutoAppliedPayload).checkpoint;
    if (!Object.hasOwn(checkpoints, id)) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    if (!applyResolution(draft, checkpoints, checkpoints[id] as CheckpointState, event)) return;
    // Reopenings seen before, from a machine whose clock is behind: applied now, in order.
    const reopenings = draft.pendingReopenings.get(id);
    if (reopenings === undefined) return;
    draft.pendingReopenings.delete(id);
    for (const reopening of reopenings) {
      if (applyReopening(draft, checkpoints, reopening)) draft.released.push(reopening);
    }
  },
  /**
   * An automatic application cancelled: relayed from the chat by an agent, or signed
   * by a trusted creator's key at the terminal; never by the engine itself. Seen before its
   * checkpoint opened (clocks apart), it is held until the automatic application.
   */
  [CHAT_EVENT_TYPES.reopened]: (draft, event) => {
    const payload = event.payload as CheckpointReopenedPayload;
    const fromChat = event.actor.kind === "agent" && payload.source === "chat";
    const fromTerminal = event.actor.kind === "human" && payload.source === "terminal";
    if (!fromChat && !fromTerminal) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    if (fromTerminal) {
      const refusal = untrustedAnswer(draft, event);
      if (refusal !== undefined) {
        draft.ignored.push({ id: event.id, reason: refusal });
        return;
      }
    }
    const checkpoints = section<CheckpointState>(draft, "checkpoints");
    if (!Object.hasOwn(checkpoints, payload.checkpoint)) {
      const pending = draft.pendingReopenings.get(payload.checkpoint) ?? [];
      pending.push(event);
      draft.pendingReopenings.set(payload.checkpoint, pending);
      draft.held.add(event.id);
      return;
    }
    applyReopening(draft, checkpoints, event);
  },
  /**
   * A point closed by the engine because its object is settled: written by the machine
   * (`system`) only, and only when the journal shows the reason holds (`reasonHolds`: the story
   * merged, the review done again, a newer request asking the same). Nobody answered it: it is
   * `closed`, its blocks lifted, and no validation is recorded.
   */
  [CHECKPOINT_CLOSED_EVENT_TYPES.closed]: (draft, event) => {
    const payload = event.payload as CheckpointClosedPayload;
    if (event.actor.kind !== "system" || !MACHINE_DEVICE_PATTERN.test(event.actor.device)) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    const checkpoints = section<CheckpointState>(draft, "checkpoints");
    const checkpoint = Object.hasOwn(checkpoints, payload.checkpoint)
      ? checkpoints[payload.checkpoint]
      : undefined;
    if (checkpoint === undefined) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    if (checkpoint.status !== "open") {
      draft.ignored.push({ id: event.id, reason: "already_resolved" });
      return;
    }
    if (
      !reasonHolds(draft.state, checkpoint, payload.reason, payload.ref, {
        now: Date.parse(event.at),
      })
    ) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    checkpoint.status = "closed";
    checkpoint.closed = {
      reason: payload.reason,
      ref: payload.ref ?? null,
      at: event.at,
      event: event.id,
    };
    lift(draft, checkpoint);
  },
};

/** Applies an answer to its checkpoint, or holds it until the checkpoint opens. */
function holdOrApply(draft: ProjectionDraft, event: EventEnvelope, id: string): void {
  const checkpoints = section<CheckpointState>(draft, "checkpoints");
  if (!Object.hasOwn(checkpoints, id)) {
    // Held until its checkpoint opens: neither applied nor ignored yet.
    const pending = draft.pendingResolutions.get(id) ?? [];
    pending.push(event);
    draft.pendingResolutions.set(id, pending);
    draft.held.add(event.id);
    return;
  }
  applyResolution(draft, checkpoints, checkpoints[id] as CheckpointState, event);
}
