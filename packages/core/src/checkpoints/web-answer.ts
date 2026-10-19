import {
  ANSWER_ORDER_CODES,
  type AnswerCheckpointParams,
  type AnswerOrderCode,
  type AnswerSource,
  answerSourceOf,
  ErrorCode,
  type EventEnvelope,
  holdsAnswer,
  type ProjectionState,
  type UndoCheckpointAnswerParams,
  WEB_ANSWER_EVENT_TYPES,
} from "@agentplugged/protocol";
import { mergeHold } from "../ci/ci-rules.js";
import { AgentPluggedError } from "../errors.js";
import type { EventDraft, JournalListing, StateStore } from "../journal/state-store.js";
import { type MergeDone, mergedEvent, mergesOn } from "../merge/story-merge.js";
import { type CheckpointState, checkpointsOf, heldNow } from "../projection/checkpoint-reducers.js";
import { computeProjection } from "../projection/compute-projection.js";
import { isMergeCheckpoint } from "../projection/merge-reducers.js";
import { answerable, answeredElsewhere, resolutionProblem } from "./resolution-rules.js";

/**
 * The creator's answer to a checkpoint, given from the web view. The browser signs an order, the
 * bridge checks it like any order, and this writes the answer in the journal as the machine
 * (a system actor), with the order and the device that gave it. One gesture is the whole answer,
 * whatever the risk: nothing confirms it. The projection applies it only to a point the web answers
 * by itself; the same rules are checked here, on the journal as it is when written, so that nothing
 * is written for a point answered meanwhile.
 *
 * A point that can be undone (low or medium risk, reversible) is not decided at once: the answer is
 * first held (`checkpoint.web_held`) for the undo window while the point stays open for everyone,
 * agents included. The machine then carries it out (`checkpoint.web_answered`) when the window is
 * over, or writes that the creator took it back (`checkpoint.web_hold_cancelled`). Any other point
 * is decided at once. The journal is the only place a held answer lives: a closed tab, a second
 * browser or a restarted machine all see and settle the same one.
 *
 * The approval of a story's merge is always held, whatever the point's risk (a merge is undone by
 * a revert), and the machine merges the story's pull request only when the window is over: an undo
 * never has a merge to take back. It does so through the `WebMerging` port, the engine's own
 * `mergeStory`, and writes the answer and `story.merged` in one write. When the merge cannot be done
 * the held answer is released (`checkpoint.web_hold_failed`) and the point says why.
 */

/**
 * What carrying out the approval of a story's merge needs of the machine: the engine's merge at the
 * forge, with the forge's tool the creator logged in on this machine. Absent where the machine
 * cannot merge: the approval is then never decided (the point comes back after its window).
 */
export interface WebMerging {
  /** The head of the story's branch as Git reads it here, for the merge gate; undefined if unreadable. */
  head(point: CheckpointState, state: ProjectionState["state"]): Promise<string | undefined>;
  /** Merges the story of the approved merge point at the forge, or says why not. Never throws. */
  merge(
    point: CheckpointState,
    state: ProjectionState["state"],
    head: string | undefined,
  ): Promise<MergeDone | AgentPluggedError>;
  /** Once the merge is written: what the engine does after it (it removes the story's worktree). */
  merged?(merge: MergeDone): Promise<void>;
}

/** The answer, and the order that carried it. */
export interface WebAnswer {
  readonly params: AnswerCheckpointParams;
  /** The identifier of the signed order. */
  readonly order: string;
  /** The browser or phone device that signed it. */
  readonly device: string;
}

/** What a write of a web answer did: held for the undo window, or decided at once. */
export type WebAnswerWrite =
  | { readonly ok: true; readonly event: EventEnvelope; readonly held: boolean }
  | { readonly ok: false; readonly code: AnswerOrderCode };

export { answeredElsewhere };

/** What the journal says of an answer: the code that refuses it, or the story of its point. */
export type WebAnswerCheck =
  | { readonly code: AnswerOrderCode }
  | { readonly code?: undefined; readonly story: string | null; readonly hold: boolean };

/** Checks the answer against the journal as it is: why it is refused, or the story of its point. */
export async function webAnswerCheck(
  listing: JournalListing,
  product: string,
  params: AnswerCheckpointParams,
  now: number,
  options: {
    /** True to carry out a held answer: the point may hold it, nothing else may. */
    readonly carryingOut?: boolean;
    /** The head of the story's branch, for the merge gate of a story's merge point. */
    readonly head?: string;
  } = {},
): Promise<WebAnswerCheck> {
  const carryingOut = options.carryingOut === true;
  const { state } = await computeProjection(listing.events, {
    problems: listing.problems,
    head: listing.head,
    product,
  });
  const checkpoints = checkpointsOf(state);
  if (!Object.hasOwn(checkpoints, params.checkpoint)) return { code: ANSWER_ORDER_CODES.notFound };
  const checkpoint = checkpoints[params.checkpoint] as CheckpointState;
  if (!answerable(checkpoint, now)) return { code: ANSWER_ORDER_CODES.notOpen };
  // An answer already held is the answer: a second one, from another tab, is never held beside it.
  if (!carryingOut && heldNow(checkpoint, now)) {
    return { code: ANSWER_ORDER_CODES.notOpen };
  }
  if (answeredElsewhere(checkpoint, params.decision)) return { code: ANSWER_ORDER_CODES.elsewhere };
  if (params.decision === "option_chosen") {
    const ids = (checkpoint.options ?? []).map((option) => option.id);
    if (params.option === undefined || !ids.includes(params.option)) {
      return { code: ANSWER_ORDER_CODES.refused };
    }
  }
  const held = resolutionProblem(
    {
      ...checkpoint,
      ...mergeHold(state, checkpoint, options.head === undefined ? {} : { head: options.head }),
    },
    {
      decision: params.decision,
      ...(params.option === undefined ? {} : { option: params.option }),
      ...(params.note === undefined ? {} : { note: params.note }),
    },
    now,
  );
  if (held !== undefined) {
    return {
      code:
        held.code === ErrorCode.MERGE_NOT_READY
          ? ANSWER_ORDER_CODES.mergeNotReady
          : ANSWER_ORDER_CODES.refused,
    };
  }
  // Any answer to a story's merge point is held, whatever the risk: a merge is undone by a revert,
  // and it is done at the window's end.
  return {
    story: checkpoint.story ?? null,
    hold: holdsAnswer(checkpoint) || isMergeCheckpoint(checkpoint),
  };
}

/** Thrown under the journal lock to abort a write the journal no longer allows. */
class WebAnswerRefused extends Error {
  constructor(readonly code: AnswerOrderCode) {
    super(code);
  }
}

/**
 * The source of an answer, drawn from the kind of the device that signed the order (the journal's
 * registry of devices gave the bridge that kind), never from anything the device declared.
 */
function sourceOfAnswer(device: string): AnswerSource {
  const source = answerSourceOf(device);
  if (source === undefined) throw new Error("Only a browser or a phone answers a checkpoint.");
  return source;
}

function answerPayload(answer: WebAnswer): Record<string, unknown> {
  const { params } = answer;
  return {
    checkpoint: params.checkpoint,
    decision: params.decision,
    ...(params.option === undefined ? {} : { option: params.option }),
    ...(params.note === undefined ? {} : { note: params.note }),
    source: sourceOfAnswer(answer.device),
    order: answer.order,
    device: answer.device,
  };
}

/**
 * Writes the answer for `answer`, or says why not (nothing is written then). For a point that can
 * be undone it is `checkpoint.web_held` (the point stays open for the undo window); for any other,
 * `checkpoint.web_answered` at once. The rules are read again under the journal's lock: a point
 * answered, held or closed meanwhile is refused with `CHECKPOINT_NOT_OPEN`, never answered twice.
 */
export async function writeWebAnswer(
  journal: StateStore,
  product: string,
  answer: WebAnswer,
  now: () => number,
): Promise<WebAnswerWrite> {
  const { params } = answer;
  const first = await webAnswerCheck(await journal.list(), product, params, now());
  if (first.code !== undefined) return { ok: false, code: first.code };
  const held = first.hold;
  try {
    const [event] = await journal.appendAll(
      [
        {
          type: held ? WEB_ANSWER_EVENT_TYPES.held : WEB_ANSWER_EVENT_TYPES.answered,
          actor: { kind: "system" },
          product,
          provenance: "trusted",
          ...(first.story === null ? {} : { story: first.story }),
          payload: answerPayload(answer),
        },
      ],
      {
        precondition: async (listing) => {
          const again = await webAnswerCheck(listing, product, params, now());
          if (again.code !== undefined) throw new WebAnswerRefused(again.code);
        },
      },
    );
    if (event === undefined) throw new Error("no event was written");
    return { ok: true, event, held };
  } catch (error) {
    if (error instanceof WebAnswerRefused) return { ok: false, code: error.code };
    if (error instanceof AgentPluggedError) return { ok: false, code: ANSWER_ORDER_CODES.notSaved };
    throw error;
  }
}

/** The order that takes back a held answer, and the device that signed it. */
export interface WebUndo {
  readonly params: UndoCheckpointAnswerParams;
  readonly order: string;
  readonly device: string;
}

/** What taking back a held answer did. */
export type WebUndoWrite =
  | { readonly ok: true; readonly event: EventEnvelope }
  | { readonly ok: false; readonly code: AnswerOrderCode };

interface Held {
  readonly story: string | null;
  /** The order of the held answer, and what it was. */
  readonly pending: NonNullable<CheckpointState["pending_answer"]>;
}

async function heldOf(
  listing: JournalListing,
  product: string,
  checkpoint: string,
  now: number,
  /** True to read it for carrying out: the window must be over. */
  due: boolean,
): Promise<Held | undefined> {
  const { state } = await computeProjection(listing.events, {
    problems: listing.problems,
    head: listing.head,
    product,
  });
  const point = checkpointsOf(state)[checkpoint];
  const pending = point?.pending_answer ?? null;
  if (point === undefined || pending === null || !answerable(point, now)) return undefined;
  // Taking back is only allowed while the window lasts; carrying out, only once it is over.
  if (due !== Date.parse(pending.until) <= now) return undefined;
  return { story: point.story ?? null, pending };
}

/**
 * Takes back the answer held for a point: writes `checkpoint.web_hold_cancelled`, and the point
 * goes on as if it had never been answered. Refused (`ANSWER_NOT_HELD`, nothing written) when
 * nothing is held, the window is over, or the point was answered meanwhile; the lock decides between
 * an undo and the end of the window arriving together.
 */
export async function undoWebAnswer(
  journal: StateStore,
  product: string,
  undo: WebUndo,
  now: () => number,
): Promise<WebUndoWrite> {
  const point = undo.params.checkpoint;
  const first = await heldOf(await journal.list(), product, point, now(), false);
  if (first === undefined) return { ok: false, code: ANSWER_ORDER_CODES.notHeld };
  try {
    const [event] = await journal.appendAll(
      [
        {
          type: WEB_ANSWER_EVENT_TYPES.holdCancelled,
          actor: { kind: "system" },
          product,
          provenance: "trusted",
          ...(first.story === null ? {} : { story: first.story }),
          payload: {
            checkpoint: point,
            held: first.pending.order,
            order: undo.order,
            device: undo.device,
          },
        },
      ],
      {
        precondition: async (listing) => {
          const again = await heldOf(listing, product, point, now(), false);
          if (again === undefined || again.pending.order !== first.pending.order) {
            throw new WebAnswerRefused(ANSWER_ORDER_CODES.notHeld);
          }
        },
      },
    );
    if (event === undefined) throw new Error("no event was written");
    return { ok: true, event };
  } catch (error) {
    if (error instanceof WebAnswerRefused) return { ok: false, code: error.code };
    if (error instanceof AgentPluggedError) return { ok: false, code: ANSWER_ORDER_CODES.notSaved };
    throw error;
  }
}

/** How soon a pass looks again after a journal that could not be written. */
const RETRY_MS = 2_000;

/** What carrying out the held answers did. */
export interface WebCarryOut {
  /** How many answers were decided. */
  readonly decided: number;
  /** How many held answers were released because they could not be carried out. */
  readonly failed: number;
  /** When the next window ends (epoch ms), or undefined when no answer is held any more. */
  readonly next: number | undefined;
}

/** A short token for the journal: the engine's code and reason, never a message. */
const TOKEN = /^[A-Za-z][A-Za-z0-9_.]{0,47}$/;

/** The code, and the reason when it has one, a failed carrying out records. */
function failureOf(cause: AgentPluggedError | AnswerOrderCode): {
  readonly code: string;
  readonly reason?: string;
} {
  if (typeof cause === "string") return { code: cause };
  const reason = (cause.details as Record<string, unknown> | undefined)?.reason;
  return {
    code: TOKEN.test(cause.code) ? cause.code : "FAILED",
    ...(typeof reason === "string" && TOKEN.test(reason) ? { reason } : {}),
  };
}

/**
 * Decides the answers whose undo window is over: for each, writes `checkpoint.web_answered` (the
 * answer of the held order, same order and device), unless the point was answered, closed or taken
 * back meanwhile. The approval of a story's merge goes through `merging`: the rules are read first,
 * the engine merges the pull request at the forge, then the answer and `story.merged` are written
 * together; a merge that cannot be done (or a gate that closed) writes
 * `checkpoint.web_hold_failed` instead and decides nothing. Without `merging`, such an approval is
 * left alone. Run by the bridge when a window ends and when it starts, so that a machine that
 * was off at the end of a window decides the answer as soon as it is on. `next` is when the
 * soonest window still running ends.
 */
export async function carryOutWebAnswers(
  journal: StateStore,
  product: string,
  now: () => number,
  merging?: WebMerging,
): Promise<WebCarryOut> {
  const listing = await journal.list();
  const { state } = await computeProjection(listing.events, {
    problems: listing.problems,
    head: listing.head,
    product,
  });
  let decided = 0;
  let failed = 0;
  let next: number | undefined;
  let retry: number | undefined;
  for (const point of Object.values(checkpointsOf(state))) {
    const pending = point.pending_answer ?? null;
    if (pending === null || !answerable(point, now())) continue;
    const until = Date.parse(pending.until);
    if (until > now()) {
      next = next === undefined ? until : Math.min(next, until);
      continue;
    }
    const answer: WebAnswer = {
      params: {
        checkpoint: point.id,
        decision: pending.decision,
        ...(pending.option === null ? {} : { option: pending.option }),
        ...(pending.note === null ? {} : { note: pending.note }),
      } as AnswerCheckpointParams,
      order: pending.order,
      device: pending.device,
    };
    const base = {
      actor: { kind: "system" },
      product,
      provenance: "trusted",
      ...(point.story === null || point.story === undefined ? {} : { story: point.story }),
    } as const;
    const draft: EventDraft = {
      ...base,
      type: WEB_ANSWER_EVENT_TYPES.answered,
      payload: answerPayload(answer),
    };
    const stillHeld = async (again: JournalListing) => {
      const held = await heldOf(again, product, point.id, now(), true);
      if (held === undefined || held.pending.order !== pending.order) {
        throw new WebAnswerRefused(ANSWER_ORDER_CODES.notHeld);
      }
    };
    /** Releases the held answer: nothing was decided, the point says why. */
    const release = async (cause: AgentPluggedError | AnswerOrderCode): Promise<void> => {
      const why = failureOf(cause);
      await journal.appendAll(
        [
          {
            ...base,
            type: WEB_ANSWER_EVENT_TYPES.holdFailed,
            payload: {
              checkpoint: point.id,
              held: pending.order,
              device: pending.device,
              code: why.code,
              ...(why.reason === undefined ? {} : { reason: why.reason }),
            },
          },
        ],
        { precondition: stillHeld },
      );
      failed += 1;
    };
    try {
      let merge: MergeDone | undefined;
      let head: string | undefined;
      if (mergesOn(point, pending.decision)) {
        if (merging === undefined) continue;
        // The journal as it is now: an earlier merge of this same pass counts for the next one.
        const current = await journal.list();
        const fresh = (
          await computeProjection(current.events, {
            problems: current.problems,
            head: current.head,
            product,
          })
        ).state;
        head = await merging.head(point, fresh);
        // The rules first, on the journal as it is: a gate that closed never reaches the forge.
        const check = await webAnswerCheck(current, product, answer.params, now(), {
          carryingOut: true,
          ...(head === undefined ? {} : { head }),
        });
        if (check.code !== undefined) {
          if (
            check.code === ANSWER_ORDER_CODES.refused ||
            check.code === ANSWER_ORDER_CODES.mergeNotReady
          ) {
            await release(check.code);
          }
          continue;
        }
        const outcome = await merging.merge(point, fresh, head);
        if (outcome instanceof AgentPluggedError) {
          await release(outcome);
          continue;
        }
        merge = outcome;
      }
      const drafts: EventDraft[] = [draft];
      if (merge !== undefined) {
        const recorded = mergedEvent(merge, sourceOfAnswer(answer.device));
        drafts.push({
          ...base,
          type: recorded.type,
          ...(recorded.story === undefined ? {} : { story: recorded.story }),
          payload: recorded.payload,
        });
      }
      await journal.appendAll(drafts, {
        precondition: async (again) => {
          await stillHeld(again);
          const check = await webAnswerCheck(again, product, answer.params, now(), {
            carryingOut: true,
            ...(head === undefined ? {} : { head }),
          });
          if (check.code !== undefined) throw new WebAnswerRefused(check.code);
        },
      });
      decided += 1;
      if (merge !== undefined) await merging?.merged?.(merge).catch(() => undefined);
    } catch (error) {
      // Taken back, answered or closed meanwhile, or a rule that now refuses it: nothing to retry.
      if (error instanceof WebAnswerRefused) continue;
      if (!(error instanceof AgentPluggedError)) throw error;
      // The journal could not be written just now: look again in a moment.
      retry = now() + RETRY_MS;
    }
  }
  return { decided, failed, next: retry === undefined ? next : Math.min(next ?? retry, retry) };
}
