import {
  type Assurance,
  type CheckpointOption,
  type CheckpointResolvedPayload,
  type CheckpointRisk,
  type CheckpointStatus,
  type CheckpointType,
  type ConfirmationMode,
  ErrorCode,
  LIFTING_DECISIONS,
  MAX_WAIVED_TOTAL_DAYS,
  MAX_WAIVER_DAYS,
  NOTE_REQUIRED,
  type RecipientRole,
  type ResolutionDecision,
  type SignatureAlg,
  type VerdictResult,
} from "@agentplugged/protocol";
import { AgentPluggedError } from "../errors.js";
import type { ReleaseHold } from "../requirements/requirement-rules.js";

/**
 * The rules of answering a checkpoint, pure functions: the actions the terminal
 * offers, the waiver's limits, the explicit confirmation, when a checkpoint can still be answered,
 * and the assurance a signature gives.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** What answering needs to know of a checkpoint. */
export interface ResolvableCheckpoint {
  readonly id: string;
  readonly type: CheckpointType;
  readonly risk: CheckpointRisk;
  readonly recipient_role: RecipientRole;
  readonly confirmation: readonly ConfirmationMode[];
  readonly options: readonly CheckpointOption[] | null;
  readonly verdict: { readonly result: VerdictResult } | null;
  readonly status: CheckpointStatus;
  readonly resolution?: {
    readonly decision: ResolutionDecision;
    readonly waiver_until: string | null;
  } | null;
  /** Its blocks no longer apply: answered with a lifting decision, or superseded so. */
  readonly blocks_lifted?: boolean;
  /**
   * It submits a sprint to the creator: never waived, like the end of a phase. Set
   * by `review` from the sprints of the projection.
   */
  readonly sprint?: boolean;
  /**
   * It asks for a story's budget: never waived. Set by `review` from the budget
   * thresholds of the projection.
   */
  readonly budget?: boolean;
  /**
   * A story's merge checkpoint held back (`heldMergeCheckpoint`): its CI is not green
   * on the branch's head or its review is not done. Set by `review` and by the projection.
   */
  readonly merge?: {
    readonly story: string;
    readonly ci: string;
    readonly review: boolean;
    /** Its open deviations. */
    readonly deviations?: number;
    /** The decisions of an open correction of course it waits for. */
    readonly course?: number;
    /** Findings of its closed review passes not sorted yet. */
    readonly untriaged?: number;
    /** What the fast track holds back, when it does. */
    readonly fast_track?: string;
  };
  /**
   * An open release point held back: a non-functional requirement has no valid proof
   * or a failed one, and the creator did not settle the gap. Set by `review` and by the projection.
   */
  readonly release?: ReleaseHold;
  /** Milliseconds waived in all, renewals included (from each waiver's answer to its deadline). */
  readonly waived_ms?: number;
}

/** What expiry and blocks need of a checkpoint. */
export type ExpiringCheckpoint = Pick<
  ResolvableCheckpoint,
  "status" | "resolution" | "blocks_lifted"
>;

/** One numbered action of the terminal. */
export type ReviewAction =
  | { readonly kind: "approve" }
  | { readonly kind: "approve_with_reservations" }
  | { readonly kind: "reject" }
  | { readonly kind: "request_changes" }
  | { readonly kind: "choose"; readonly option: string }
  | { readonly kind: "waive" }
  | { readonly kind: "quit" };

/** The decision each action records (`quit` records none). */
export const ACTION_DECISIONS: Readonly<
  Record<Exclude<ReviewAction["kind"], "quit">, ResolutionDecision>
> = {
  approve: "approved",
  approve_with_reservations: "approved_with_reservations",
  reject: "rejected",
  request_changes: "changes_requested",
  choose: "option_chosen",
  waive: "waived",
};

/**
 * The decisions a creator's action takes: approved (the engine carries it out),
 * rejected or changes requested (nothing is carried out).
 */
export const CREATOR_ACTION_DECISIONS: ReadonlySet<ResolutionDecision> = new Set([
  "approved",
  "rejected",
  "changes_requested",
]);

/** Why a waiver is refused: none when the checkpoint can be waived. */
export type WaiverRefusal =
  | "no_failed_verdict"
  | "permission"
  | "security"
  | "phase_end"
  | "sprint"
  | "budget";

/**
 * A waiver is for a failed verdict only, never on a permission, never on a security checkpoint
 * (`recipient_role: security`), and never on the end of a phase: a waiver lapses, and a phase,
 * once closed, never reopens; the next phase begins only on a real approval. Nor on
 * a sprint: a sprint is in force only on a real approval. Nor on a budget checkpoint:
 * a waiver would let a story go on past its budget without a decision.
 */
export function waiverRefusal(checkpoint: ResolvableCheckpoint): WaiverRefusal | undefined {
  if (checkpoint.type === "phase_end") return "phase_end";
  if (checkpoint.sprint === true) return "sprint";
  if (checkpoint.budget === true) return "budget";
  if (checkpoint.verdict?.result !== "fail") return "no_failed_verdict";
  if (checkpoint.type === "permission") return "permission";
  if (checkpoint.recipient_role === "security") return "security";
  return undefined;
}

/**
 * The actions the terminal offers, in order: approve, approve with reservations, reject, request
 * changes, one per option of a decision, waive (a failed verdict, not a permission nor the end of
 * a phase; refused when chosen on a security checkpoint), quit.
 */
export function reviewActions(checkpoint: ResolvableCheckpoint): ReviewAction[] {
  // A creator's action: approve (the engine carries it out), reject, send back.
  if (checkpoint.type === "creator_action") {
    return [{ kind: "approve" }, { kind: "reject" }, { kind: "request_changes" }, { kind: "quit" }];
  }
  const waivable =
    checkpoint.verdict?.result === "fail" &&
    checkpoint.type !== "permission" &&
    checkpoint.type !== "phase_end" &&
    checkpoint.sprint !== true &&
    checkpoint.budget !== true;
  return [
    { kind: "approve" },
    { kind: "approve_with_reservations" },
    { kind: "reject" },
    { kind: "request_changes" },
    ...(checkpoint.options ?? []).map((option) => ({ kind: "choose" as const, option: option.id })),
    ...(waivable ? [{ kind: "waive" as const }] : []),
    { kind: "quit" },
  ];
}

/**
 * The deadline a waiver answer gives: a number of days (1 to 30), or a date `YYYY-MM-DD` (the end of
 * that day in the local time of this machine: the creator thinks in local days, the
 * journal keeps the instant in UTC; never beyond `now` + 30 days: the 30th day is accepted).
 * Undefined when the answer is neither.
 */
export function parseWaiverAnswer(answer: string, now: number): string | undefined {
  const text = answer.trim();
  if (/^\d{1,3}$/.test(text)) {
    const days = Number(text);
    return days >= 1 ? new Date(now + days * DAY_MS).toISOString() : undefined;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day, 23, 59, 59, 999);
  date.setFullYear(year);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return undefined;
  }
  const latest = now + MAX_WAIVER_DAYS * DAY_MS;
  // The 30th day itself: its end would pass the limit by a few hours, so it is cut there.
  if (date.getTime() > latest && date.getTime() - latest < DAY_MS) {
    return new Date(latest).toISOString();
  }
  return date.toISOString();
}

/** Why a waiver's deadline is refused: past, or more than 30 days after `at`. */
export function waiverDeadlineProblem(
  until: string,
  at: number,
): "past" | "too_far" | "invalid" | undefined {
  const time = Date.parse(until);
  if (Number.isNaN(time)) return "invalid";
  if (time <= at) return "past";
  if (time > at + MAX_WAIVER_DAYS * DAY_MS) return "too_far";
  return undefined;
}

/** The explicit confirmation of replacing the product key (`key import`): its id, or "je confirme". No checkpoint asks it any more. */
export function explicitConfirmed(answer: string, checkpointId: string): boolean {
  const text = answer.trim().replace(/\s+/g, " ");
  return (
    text.toUpperCase() === checkpointId.toUpperCase() ||
    ["je confirme", "i confirm"].includes(text.toLowerCase())
  );
}

/**
 * True when a waived checkpoint's deadline is past at `now` (milliseconds). The one rule of
 * expiry: the projection records the deadline and never decides it; every reader (the block
 * check, `review`, `journal status`, `get_state`) asks this function with the clock.
 */
export function waiverExpired(checkpoint: ExpiringCheckpoint, now: number): boolean {
  const until = checkpoint.resolution?.waiver_until;
  if (checkpoint.status !== "waived" || typeof until !== "string") return false;
  const time = Date.parse(until);
  return !Number.isNaN(time) && time <= now;
}

/** True when the creator can still answer the checkpoint at `now`: open, or its waiver is past. */
export function answerable(checkpoint: ExpiringCheckpoint, now: number): boolean {
  return checkpoint.status === "open" || waiverExpired(checkpoint, now);
}

/**
 * True when the checkpoint's blocks apply at `now`: open; waived with its deadline past; or
 * answered with a refusal (`rejected`, `changes_requested`) and not superseded by a checkpoint
 * answered with a lifting decision.
 */
export function blocksInForce(checkpoint: ExpiringCheckpoint, now: number): boolean {
  if (checkpoint.status === "open") return true;
  if (checkpoint.status === "waived") return waiverExpired(checkpoint, now);
  return checkpoint.blocks_lifted !== true;
}

/** True when a decision lifts the blocks of its checkpoint (and of the one it supersedes). */
export function liftsBlocks(decision: ResolutionDecision): boolean {
  return LIFTING_DECISIONS.has(decision);
}

/** The status a reader shows at `now`: `open` again once a waiver is past. */
export function statusAt(checkpoint: ExpiringCheckpoint, now: number): CheckpointStatus {
  return waiverExpired(checkpoint, now) ? "open" : checkpoint.status;
}

const MAX_WAIVED_MS = MAX_WAIVED_TOTAL_DAYS * DAY_MS;

/** `renewal`: with this waiver, the checkpoint would be waived more than 90 days in all. */
function renewalProblem(
  checkpoint: ResolvableCheckpoint,
  until: string,
  at: number,
): "renewal" | undefined {
  const added = Date.parse(until) - at;
  return (checkpoint.waived_ms ?? 0) + added > MAX_WAIVED_MS ? "renewal" : undefined;
}

/** The assurance a verified signature gives the creator: `presence` for WebAuthn (with UV). */
export function assuranceOf(alg: SignatureAlg): Assurance {
  return alg === "ed25519" ? "locale" : "presence";
}

function invalid(field: string, reason: string, reasonKey: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
    command: "review",
    field,
    reason: `review: ${field}: ${reason}`,
    reason_key: reasonKey,
  });
}

/**
 * The message of `MERGE_NOT_READY`: the gate's own, or, when the fast track holds the story back
 *, the one that says how to go on.
 */
export function mergeNotReadyKey(fastTrack: string | undefined): string {
  return fastTrack === undefined ? "error.merge_not_ready" : `error.merge_not_ready.${fastTrack}`;
}

/**
 * Why an answer does not fit the checkpoint at `at` (milliseconds), or undefined: an option of
 * this decision, a note when the decision needs one, and a waiver only where `waiverRefusal`
 * allows one, until a deadline at most 30 days ahead.
 */
export function resolutionProblem(
  checkpoint: ResolvableCheckpoint,
  payload: Pick<CheckpointResolvedPayload, "decision" | "option" | "note" | "waiver_until">,
  at: number,
): AgentPluggedError | undefined {
  const { decision } = payload;
  // A held merge checkpoint is never approved: only refused, or left open.
  const merge = checkpoint.merge;
  if (merge !== undefined && decision !== "rejected" && decision !== "changes_requested") {
    return new AgentPluggedError(ErrorCode.MERGE_NOT_READY, mergeNotReadyKey(merge.fast_track), {
      checkpoint: checkpoint.id,
      story: merge.story,
      ci: merge.ci,
      review: merge.review,
      deviations: merge.deviations ?? 0,
      course: merge.course ?? 0,
      untriaged: merge.untriaged ?? 0,
      ...(merge.fast_track === undefined ? {} : { fast_track: merge.fast_track }),
    });
  }
  // A release point is never approved while a requirement waits for its proof.
  const release = checkpoint.release;
  if (release !== undefined && decision !== "rejected" && decision !== "changes_requested") {
    return new AgentPluggedError(ErrorCode.RELEASE_NOT_READY, "error.release_not_ready", {
      checkpoint: checkpoint.id,
      open: release.open,
      failed: release.failed,
      engine: release.engine,
      reported: release.reported,
      requirements: release.requirements,
    });
  }
  // A creator's action is approved (and carried out), refused or sent back.
  if (checkpoint.type === "creator_action" && !CREATOR_ACTION_DECISIONS.has(decision)) {
    return invalid(
      "decision",
      "expected approved, rejected or changes_requested for a creator's action",
      "reason.review.creator_action",
    );
  }
  if (decision === "option_chosen") {
    const ids = (checkpoint.options ?? []).map((option) => option.id);
    if (payload.option === undefined || !ids.includes(payload.option)) {
      return invalid(
        "option",
        `expected one of ${ids.join(", ") || "(no option)"}`,
        "reason.review.option",
      );
    }
  } else if (payload.option !== undefined) {
    return invalid("option", "an option goes with option_chosen only", "reason.review.option");
  }
  if (NOTE_REQUIRED.has(decision) && (payload.note ?? "").trim() === "") {
    return invalid("note", "this decision needs a note", "reason.review.note");
  }
  if (decision === "waived") {
    const refusal = waiverRefusal(checkpoint);
    if (refusal !== undefined) {
      return invalid("decision", `no waiver here (${refusal})`, `reason.review.waiver.${refusal}`);
    }
    const problem =
      payload.waiver_until === undefined
        ? "invalid"
        : (waiverDeadlineProblem(payload.waiver_until, at) ??
          renewalProblem(checkpoint, payload.waiver_until, at));
    if (problem !== undefined) {
      return invalid(
        "waiver_until",
        `the deadline is ${problem === "too_far" ? `more than ${MAX_WAIVER_DAYS} days ahead` : problem === "renewal" ? `beyond ${MAX_WAIVED_TOTAL_DAYS} days waived in all` : problem}`,
        `reason.review.deadline.${problem}`,
      );
    }
  } else if (payload.waiver_until !== undefined) {
    return invalid(
      "waiver_until",
      "a deadline goes with waived only",
      "reason.review.deadline.invalid",
    );
  }
  return undefined;
}

/** A permission point whose request the card shows cut: the end could hide what it does. */
const LONG_REQUEST = 500;

/**
 * Why a point is not answered from the web, or undefined: an action of the creator's that the
 * engine carries out on approval (its execution needs the machine's own adapters; refusing or
 * sending it back is still answered from the web), a change of the memory (its content is
 * encrypted: the card cannot show it), a request too long to be read whole. Those wait for the chat
 * or the terminal. A story's merge is answered from the web: the machine merges it before it writes
 * the answer. The write and the projection both ask it.
 */
export function answeredElsewhere(
  checkpoint: {
    readonly type: string;
    readonly source?: string | null;
    readonly request?: { readonly detail: string } | null;
    readonly creator_action?: unknown;
  },
  decision: string,
): boolean {
  if (checkpoint.type === "memory") return true;
  if ((checkpoint.creator_action ?? null) !== null && decision === "approved") return true;
  return (
    checkpoint.source === "untrusted_action" &&
    (checkpoint.request?.detail.length ?? 0) >= LONG_REQUEST
  );
}
