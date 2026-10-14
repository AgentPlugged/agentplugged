import {
  type AttemptResult,
  BUDGET_TITLE_PREFIX,
  type CreatorActionKind,
  HYPOTHESIS_CONFIDENCES,
  HYPOTHESIS_KIND,
  LOOP_EVENT_TYPES,
  LOOP_MAX_ATTEMPTS,
  LOOP_MAX_RECORDED,
  LOOP_MAX_SHOWN,
  type LoopStopReason,
} from "@agentplugged/protocol";
import { checkpointPayload, truncate } from "../checkpoints/checkpoint-rules.js";
import type { DecisionItem, NextStep, NextStepId } from "../next/next.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";

/**
 * The rules of the bounded loop, pure: what comes next, why the loop stops, how many
 * approaches a story may fail before the creator is asked, and which approach is the same as one
 * that already failed. Nothing here reads a file, a clock or a process; the command feeds it the
 * step `next` computed and the projection.
 */

/** One approach tried on a story, as the projection keeps it (`state.stories.<id>.attempts`). */
export interface AttemptRecord {
  readonly approach: string;
  readonly result: AttemptResult;
  readonly note?: string;
  /** The record is a hypothesis about a bug's cause, with its confidence (1 to 10). */
  readonly kind?: typeof HYPOTHESIS_KIND;
  readonly confidence?: number;
  readonly at: string;
  /** The ULID of the event: the order, and the place of the attempt against a point's answer. */
  readonly event: string;
}

/** A hypothesis, not an approach: the records of a cause being searched are kept apart. */
export const isHypothesis = (record: AttemptRecord): boolean => record.kind === HYPOTHESIS_KIND;

/** `state.loop`: the stop the loop is at, or null when it runs. */
export interface LoopState {
  stopped: {
    readonly reason: LoopStopReason;
    readonly subject: string | null;
    readonly at: string;
    readonly event: string;
  } | null;
}

/* ------------------------------------------------------------------------------------------ */
/* Approaches already tried                                                                    */
/* ------------------------------------------------------------------------------------------ */

/** The words too common to tell two approaches apart. */
const COMMON = new Set([
  "the",
  "and",
  "in",
  "on",
  "of",
  "to",
  "at",
  "by",
  "an",
  "or",
  "le",
  "la",
  "de",
  "du",
  "en",
  "et",
  "un",
  "au",
  "for",
  "with",
  "use",
  "using",
  "try",
  "again",
  "instead",
  "les",
  "des",
  "une",
  "pour",
  "avec",
  "par",
  "dans",
  "sur",
  "essayer",
  "utiliser",
]);

/** The words of an approach: lowercase, accents and punctuation gone, common words left out. */
export function approachWords(text: string): ReadonlySet<string> {
  const plain = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const words = plain.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 2);
  // A plural is the same word (`tests`, `test`).
  const stems = words.map((word) =>
    word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word,
  );
  return new Set(stems.filter((word) => !COMMON.has(word)));
}

/** Two approaches count as the same from this share of common words (of all their words). */
export const SAME_APPROACH = 0.7;

/**
 * True when `candidate` is the approach `earlier` again: the same words, in any order, or all but a
 * small part of them. Two approaches that share no word are different ones, however they are put.
 */
export function sameApproach(earlier: string, candidate: string): boolean {
  const a = approachWords(earlier);
  const b = approachWords(candidate);
  if (a.size === 0 || b.size === 0) {
    return earlier.trim().toLowerCase() === candidate.trim().toLowerCase();
  }
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared) >= SAME_APPROACH;
}

/* ------------------------------------------------------------------------------------------ */
/* Attempts of a story                                                                         */
/* ------------------------------------------------------------------------------------------ */

/** The checkpoints the engine opened when a story's attempts reached the limit. */
export function limitCheckpoints(
  checkpoints: readonly CheckpointState[],
  story: string,
): CheckpointState[] {
  return checkpoints.filter(
    (checkpoint) => checkpoint.story === story && checkpoint.source === "attempt_limit",
  );
}

/**
 * The creator's answers to the limit point that give the story a new round: an approval, with or
 * without reservations. A refusal keeps it stopped; a waiver is never allowed on a permission.
 */
const GIVES_A_NEW_ROUND: ReadonlySet<string> = new Set(["approved", "approved_with_reservations"]);

/** Where a story's attempts stand. */
export interface AttemptsView {
  /** Approaches that failed since the last limit the creator lifted. */
  readonly failed: number;
  readonly limit: number;
  /** The limit is reached and the creator has not lifted it. */
  readonly exhausted: boolean;
  /** The point asking the creator about it, when it is open. */
  readonly open_point: string | null;
  /** The approach started and not yet reported, when there is one. */
  readonly in_progress: string | null;
  /** The approaches that failed, all of them, in order (never to be tried again). */
  readonly failures: readonly AttemptRecord[];
  /** The search for the cause of a bug. */
  readonly hypotheses: HypothesesView;
}

/**
 * Where the search for a bug's cause stands: the hypotheses ruled out (never to be put forward
 * again), the one under test, and the cause confirmed. The latest hypothesis decides: a new one put
 * forward after a confirmed cause takes its place (the fix showed it wrong).
 */
export interface HypothesesView {
  readonly total: number;
  readonly ruled_out: readonly AttemptRecord[];
  readonly testing: AttemptRecord | null;
  readonly confirmed: AttemptRecord | null;
}

export function hypothesesView(records: readonly AttemptRecord[]): HypothesesView {
  const all = records.filter(isHypothesis);
  const last = all.at(-1);
  return {
    total: all.length,
    ruled_out: all.filter((record) => record.result === "failed"),
    testing: last?.result === "started" ? last : null,
    confirmed: last?.result === "green" ? last : null,
  };
}

/** `7/10 the statement` → the confidence and the statement; undefined when the note is not that. */
export function parseHypothesis(
  note: string | undefined,
): { readonly confidence: number; readonly statement: string } | undefined {
  const match = /^\s*(\d{1,2})\s*\/\s*10\s*[:\-–—]?\s*(\S.*)$/u.exec(note ?? "");
  if (match === null) return undefined;
  const confidence = Number(match[1]);
  if (confidence < HYPOTHESIS_CONFIDENCES.min || confidence > HYPOTHESIS_CONFIDENCES.max) {
    return undefined;
  }
  return { confidence, statement: (match[2] ?? "").trim() };
}

/** Why a hypothesis may not be put forward now, or undefined. */
export type HypothesisProblem =
  | "attempts_exhausted"
  | "attempt_open"
  | "hypothesis_open"
  | "hypothesis_ruled_out"
  | "confidence_missing";

export function hypothesisProblem(
  view: AttemptsView,
  note: string | undefined,
): HypothesisProblem | undefined {
  const parsed = parseHypothesis(note);
  if (parsed === undefined) return "confidence_missing";
  if (view.exhausted) return "attempts_exhausted";
  // A fix under way is reported first: its cause was not searched for, or it is not this one.
  if (view.in_progress !== null) return "attempt_open";
  if (view.hypotheses.testing !== null) return "hypothesis_open";
  if (view.hypotheses.ruled_out.some((record) => sameApproach(record.approach, parsed.statement))) {
    return "hypothesis_ruled_out";
  }
  return undefined;
}

/** The hypotheses ruled out, to give the developer so that none is put forward again (latest first). */
export function ruledOutLines(view: AttemptsView): string[] {
  return view.hypotheses.ruled_out
    .slice(-LOOP_MAX_SHOWN)
    .reverse()
    .map((record) => truncate(record.approach, 120));
}

/**
 * The attempts of a story. The window of the count opens at the last limit point the creator
 * approved: their gesture is what gives the story a new round. A refusal, or no answer yet, keeps
 * the story stopped. The approaches that failed stay failed whatever the round.
 */
export function attemptsView(
  attempts: readonly AttemptRecord[] | undefined,
  checkpoints: readonly CheckpointState[],
  story: string,
): AttemptsView {
  const everything = attempts ?? [];
  const records = everything.filter((record) => !isHypothesis(record));
  const points = limitCheckpoints(checkpoints, story);
  const lifted = points
    .filter((point) => GIVES_A_NEW_ROUND.has(point.resolution?.decision ?? "rejected"))
    .map((point) => point.resolution?.event ?? "")
    .sort()
    .at(-1);
  const failures = records.filter((record) => record.result === "failed");
  const failed = failures.filter((record) => lifted === undefined || record.event > lifted).length;
  const last = records.at(-1);
  const open = points.find((point) => point.status === "open");
  return {
    failed,
    limit: LOOP_MAX_ATTEMPTS,
    exhausted: failed >= LOOP_MAX_ATTEMPTS,
    open_point: open?.id ?? null,
    in_progress: last?.result === "started" ? last.approach : null,
    failures,
    hypotheses: hypothesesView(everything),
  };
}

/** Why an approach may not be started now, or undefined. */
export type TryProblem =
  | "attempts_exhausted"
  | "attempt_open"
  | "approach_failed"
  | "cause_unconfirmed";

export function tryProblem(view: AttemptsView, approach: string): TryProblem | undefined {
  if (view.exhausted) return "attempts_exhausted";
  if (view.in_progress !== null) return "attempt_open";
  // A story whose bug's cause is being searched gets no fix before the cause is confirmed.
  if (view.hypotheses.total > 0 && view.hypotheses.confirmed === null) return "cause_unconfirmed";
  if (view.failures.some((record) => sameApproach(record.approach, approach))) {
    return "approach_failed";
  }
  return undefined;
}

/**
 * The records kept after one more, `LOOP_MAX_RECORDED` at most. What goes first is what is no more
 * use: the oldest approaches that went green or only started, then the hypotheses of a diagnosis
 * that was settled; the approaches that failed are the ones that must never come back, they go
 * last, oldest first. The latest record, and the latest hypothesis, always stay.
 */
export function keptAttempts(records: readonly AttemptRecord[]): AttemptRecord[] {
  const kept = [...records];
  const dropAt = (predicate: (record: AttemptRecord) => boolean) => {
    const index = kept.findIndex((record, i) => i < kept.length - 1 && predicate(record));
    if (index === -1) return false;
    kept.splice(index, 1);
    return true;
  };
  while (kept.length > LOOP_MAX_RECORDED) {
    // Then the hypotheses no longer of use (a start its end follows, a cause a newer hypothesis
    // replaced), then the causes ruled out, and last the fixes that failed: they are the count that
    // asks the creator, and what must never come back.
    const latest = kept.findLast(isHypothesis);
    const steps: Array<(record: AttemptRecord) => boolean> = [
      (record) => record.result !== "failed" && !isHypothesis(record),
      (record) => isHypothesis(record) && record.result !== "failed" && record !== latest,
      (record) => isHypothesis(record) && record !== latest,
      (record) => record.result === "failed" && !isHypothesis(record),
      () => true,
    ];
    if (!steps.some((step) => dropAt(step))) break;
  }
  return kept;
}

/** The approaches that failed, to give the developer so that none is tried again (latest first). */
export function triedLines(view: AttemptsView): string[] {
  return view.failures
    .slice(-LOOP_MAX_SHOWN)
    .reverse()
    .map((record) => truncate(record.approach, 120));
}

/** The point the engine opens when a story's approaches have failed up to the limit. */
export function attemptLimitCheckpoint(story: string, failures: readonly AttemptRecord[]) {
  const last = failures.at(-1);
  return {
    ...checkpointPayload({
      type: "permission",
      risk: "medium",
      title: truncate(`Story ${story}: ${LOOP_MAX_ATTEMPTS} approaches failed`, 120),
      summary: truncate(
        `Story ${story} was tried ${LOOP_MAX_ATTEMPTS} times and its tests still fail${last?.note === undefined ? "" : ` (last: ${last.note})`}. Approach after approach: ${failures
          .slice(-LOOP_MAX_ATTEMPTS)
          .map((record) => record.approach)
          .join(
            "; ",
          )}. Approve to allow ${LOOP_MAX_ATTEMPTS} more approaches, none of them one of these; refuse to keep the story stopped while you settle it with its developer.`,
        2000,
      ),
      blocks: [
        { action: "story.review", story },
        { action: "story.complete", story },
      ],
    }),
    source: "attempt_limit" as const,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Why the loop stops                                                                          */
/* ------------------------------------------------------------------------------------------ */

/** The actions of the creator's that command a gate, not a decision: a command to accept. */
const COMMAND_ACTIONS: ReadonlySet<CreatorActionKind> = new Set([
  "proof_commands",
  "environment_fix",
  "engine_update",
]);

/** The actions of the creator's that cannot be taken back. */
const IRREVERSIBLE_ACTIONS: ReadonlySet<CreatorActionKind> = new Set([
  "deferred_drop",
  "forge_repo_create",
  "forge_push_main",
  "forge_merge_ci",
  "release",
]);

/**
 * What a point asks of the creator, as the reason the loop stops at it. The most serious reading
 * wins: a merge, a spend, an irreversible action, a command to accept, a gap of a requirement.
 */
export function stopReasonOf(
  checkpoint: Pick<
    CheckpointState,
    "id" | "type" | "title" | "source" | "irreversible" | "creator_action" | "story" | "blocks"
  >,
  /** The points that are a budget's (`state.budget_thresholds` names them): a spend, whatever their title. */
  budgetPoints: ReadonlySet<string> = new Set(),
): LoopStopReason {
  if (checkpoint.source === "attempt_limit") return "attempts";
  if (checkpoint.source === "merge") return "merge";
  if (budgetPoints.has(checkpoint.id) || checkpoint.title.startsWith(BUDGET_TITLE_PREFIX)) {
    return "spend";
  }
  const action = checkpoint.creator_action?.kind;
  if (action !== undefined && COMMAND_ACTIONS.has(action)) return "command";
  if (action !== undefined && IRREVERSIBLE_ACTIONS.has(action)) return "irreversible";
  if (checkpoint.irreversible) return "irreversible";
  if (checkpoint.type === "release" || checkpoint.type === "publication") return "irreversible";
  // A point that holds back a deploy or a publication is about something that cannot be taken back.
  if (
    checkpoint.blocks.some(
      (block) => block.action === "release.deploy" || block.action === "publication.publish",
    )
  ) {
    return "irreversible";
  }
  if (
    checkpoint.type === "permission" ||
    checkpoint.source === "untrusted_action" ||
    checkpoint.blocks.some((block) => block.action === "permission.use")
  ) {
    return "command";
  }
  if (checkpoint.source === "forge_unlinked") return "command";
  if (/^Gap on /.test(checkpoint.title)) return "gap";
  if (
    checkpoint.type === "document" ||
    checkpoint.type === "phase_end" ||
    checkpoint.type === "memory"
  ) {
    return "validation";
  }
  return "decision";
}

/** The steps the loop runs without the creator: the work of the stories under way, and what follows. */
export const LOOP_STEPS: ReadonlySet<NextStepId> = new Set([
  "build",
  "review",
  "review_triage",
  "ci_failed",
  "ci_check",
  "merge_changes",
  "merge_conflict",
  "deferred_work",
  "point_decision",
  "memory_record",
  "knowledge_base_update",
  "release_notes",
  "retrospective",
  "setup_ci",
]);

/** The stops that no setting lifts: the creator's own gesture is needed, the loop never goes round. */
export const ALWAYS_THE_CREATORS: ReadonlySet<LoopStopReason> = new Set([
  "spend",
  "irreversible",
  "command",
]);

/** What the loop does with the step `next` gave. */
export type LoopVerdict =
  | {
      readonly verdict: "run";
      readonly step: NextStepId;
      readonly agent: string | null;
      readonly story: string | null;
      /** Points that wait for the creator while the loop goes on with work that does not need them. */
      readonly waiting: number;
    }
  | {
      readonly verdict: "stop";
      readonly reason: LoopStopReason;
      readonly subject: string | null;
      readonly waiting: number;
    }
  | { readonly verdict: "done" };

/** What the loop reads of `next`. */
export type LoopStepInput = Pick<
  NextStep,
  "step" | "you" | "agent" | "story" | "checkpoint" | "stop" | "waiting" | "independent"
> & { readonly decisions?: readonly Pick<DecisionItem, "id">[] };

/**
 * What comes next. The creator's step, a point the agents may not decide, a step outside the
 * stories' work, a story blocked or whose attempts reached the limit: the loop stops, with the
 * reason of the first point to present; so does any point that waits, unless `next` calls the step
 * independent of it. Nothing is left and nothing waits: it is done. Else it runs the step `next`
 * gave (the story that is ready, the agent that owns it).
 */
export function loopVerdict(
  next: LoopStepInput,
  checkpoints: Readonly<Record<string, CheckpointState>>,
  attemptsOf: (story: string) => AttemptsView,
  budgetPoints: ReadonlySet<string> = new Set(),
): LoopVerdict {
  const decisions = next.decisions ?? [];
  const waiting = decisions.length;
  const pointId = next.checkpoint ?? decisions[0]?.id ?? next.waiting[0]?.id ?? null;
  const point = pointId === null ? undefined : checkpoints[pointId];
  const stopAtPoint = (): LoopVerdict => ({
    verdict: "stop",
    reason: point === undefined ? "creator_step" : stopReasonOf(point, budgetPoints),
    subject: point?.id ?? next.step,
    waiting,
  });
  if (next.you || next.stop === true) return stopAtPoint();
  if (next.step === "none") {
    return waiting > 0 || next.waiting.length > 0 ? stopAtPoint() : { verdict: "done" };
  }
  // A point that waits for the creator stops the loop, unless `next` itself calls the step
  // independent of it (the creator chose which points they keep, the agents go on with
  // the rest while those wait).
  if (waiting > 0 && next.independent !== true) return stopAtPoint();
  // A point the creator's settings leave to an agent is decided by it, but never a spend, an action
  // that cannot be undone or a command to accept: the loop stops before, whatever was delegated.
  if (next.step === "point_decision" && point !== undefined) {
    const reason = stopReasonOf(point, budgetPoints);
    if (ALWAYS_THE_CREATORS.has(reason)) {
      return { verdict: "stop", reason, subject: point.id, waiting };
    }
  }
  if (next.step === "story_blocked") {
    return { verdict: "stop", reason: "blocked", subject: next.story ?? next.step, waiting };
  }
  if (!LOOP_STEPS.has(next.step)) {
    return { verdict: "stop", reason: "outside", subject: next.step, waiting };
  }
  if (next.story !== null) {
    const attempts = attemptsOf(next.story);
    if (attempts.exhausted) {
      return {
        verdict: "stop",
        reason: "attempts",
        subject: attempts.open_point ?? next.story,
        waiting,
      };
    }
  }
  return { verdict: "run", step: next.step, agent: next.agent, story: next.story, waiting };
}

/** `state.loop` of a projection, when the journal holds a stop or a resumption. */
export function loopStateOf(state: Readonly<Record<string, unknown>>): LoopState | undefined {
  return state.loop as LoopState | undefined;
}

/** The event a turn writes: the stop it reaches, or the resumption after a stop, else none. */
export interface TurnEvent {
  readonly type: typeof LOOP_EVENT_TYPES.stopped | typeof LOOP_EVENT_TYPES.resumed;
  readonly payload: Readonly<Record<string, string>>;
}

/**
 * What a turn writes, from the verdict and the stop the journal holds: a stop once (the same reason
 * for the same subject is not written again), the resumption once (only after a stop), nothing else.
 */
export function turnEvent(
  verdict: LoopVerdict,
  before: LoopState | undefined,
): TurnEvent | undefined {
  if (verdict.verdict === "run") {
    const stopped = before?.stopped;
    if (stopped == null) return undefined;
    return {
      type: LOOP_EVENT_TYPES.resumed,
      payload: {
        after: stopped.reason,
        ...(stopped.subject === null ? {} : { subject: stopped.subject }),
      },
    };
  }
  const reason: LoopStopReason = verdict.verdict === "done" ? "done" : verdict.reason;
  const subject = verdict.verdict === "done" ? null : verdict.subject;
  if (sameStop(before, reason, subject)) return undefined;
  return {
    type: LOOP_EVENT_TYPES.stopped,
    payload: { reason, ...(subject === null ? {} : { subject }) },
  };
}

/** True when the stop to write is the one the loop is already at. */
export function sameStop(
  state: LoopState | undefined,
  reason: LoopStopReason,
  subject: string | null,
): boolean {
  const stopped = state?.stopped;
  return stopped != null && stopped.reason === reason && stopped.subject === subject;
}
