import { z } from "zod";
import { CHAT_DECISIONS } from "./chat.js";
import { CheckpointIdSchema, NOTE_REQUIRED, type ResolutionDecision } from "./checkpoint.js";
import { PAIRED_DEVICE_ID_PATTERN } from "./device-trust.js";
import { UlidSchema } from "./event-envelope.js";

/**
 * Answering a checkpoint from the creator's own views (the web view or the phone): one gesture,
 * one signed order. The device signs `product.answer_checkpoint`; the main machine checks it like
 * any order, and the engine records the answer (`checkpoint.web_answered`, written by the machine
 * as a system actor) with the identifier of the order and of the device that gave it, so that the
 * journal says where the decision came from (`source: web` for a browser, `source: mobile` for a
 * phone) and anyone can match it with the signed order the machine keeps (`order.applied`). The
 * source is never the client's word: it is the kind of the device the journal trusts, and the
 * payload is refused when the two disagree. Nothing confirms it: the order is the whole answer,
 * whatever the risk.
 */

/** The order a browser or a phone signs to answer a checkpoint. */
export const ORDER_TYPE_ANSWER_CHECKPOINT = "product.answer_checkpoint";

/** The order a browser or a phone signs to take back an answer it gave, while the machine still holds it. */
export const ORDER_TYPE_UNDO_CHECKPOINT_ANSWER = "product.undo_checkpoint_answer";

/**
 * Event types of the answers given from the web view, at version 1. A reversible point's answer
 * is first held (`held`) for the length of the undo window, with the point still open for everyone;
 * then it is either taken back (`holdCancelled`) or carried out (`answered`). An answer to a point
 * that cannot be undone is carried out at once. A held answer whose carrying out the machine could
 * not do (the merge of a story that the forge refuses) is released (`holdFailed`): the point stays
 * open and says why.
 */
export const WEB_ANSWER_EVENT_TYPES = {
  answered: "checkpoint.web_answered",
  held: "checkpoint.web_held",
  holdCancelled: "checkpoint.web_hold_cancelled",
  holdFailed: "checkpoint.web_hold_failed",
} as const;

/** How long the machine holds a reversible answer before it carries it out: the creator may undo it. */
export const WEB_ANSWER_WINDOW_MS = 10_000;

/**
 * How long after its window a held answer is still waited for. Past it, the machine did not carry
 * the answer out (it is off, or the journal refuses it): the point is open again for a new answer.
 */
export const WEB_ANSWER_STALE_MS = 15_000;

/** The longest note the creator types with a decision, like a resolution's note. */
export const MAX_WEB_ANSWER_NOTE_LENGTH = 2000;

/** Where an answer carried by a signed order came from: a browser (`web`) or a phone (`mobile`). */
export const ANSWER_SOURCES = ["web", "mobile"] as const;
export type AnswerSource = (typeof ANSWER_SOURCES)[number];

/**
 * The source of an answer given by `device`, drawn from the kind of its identifier (a browser's
 * `browser:`, a phone's `phone:`), which the journal registered when the device was paired. Undefined
 * for any other device: a machine never answers this way.
 */
export function answerSourceOf(device: string): AnswerSource | undefined {
  if (device.startsWith("browser:")) return "web";
  if (device.startsWith("phone:")) return "mobile";
  return undefined;
}

const ShortIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/, {
  message: "expected 1 to 32 letters, digits, dots, hyphens or underscores",
});

function checkAnswer(
  value: {
    readonly decision: ResolutionDecision;
    readonly option?: string | undefined;
    readonly note?: string | undefined;
  },
  context: z.RefinementCtx,
): void {
  if ((value.decision === "option_chosen") !== (value.option !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["option"],
      message: "an option goes with option_chosen, and only with it",
    });
  }
  if (NOTE_REQUIRED.has(value.decision) && value.note === undefined) {
    context.addIssue({ code: "custom", path: ["note"], message: "this decision needs a note" });
  }
}

/**
 * Parameters of `product.answer_checkpoint`: the point and the decision (the chat's: never a
 * waiver), its option for `option_chosen`, a note for the decisions that need one.
 */
export const AnswerCheckpointParamsSchema = z
  .strictObject({
    checkpoint: CheckpointIdSchema,
    decision: z.enum(CHAT_DECISIONS),
    option: ShortIdSchema.optional(),
    note: z.string().trim().min(1).max(MAX_WEB_ANSWER_NOTE_LENGTH).optional(),
  })
  .superRefine(checkAnswer);
export type AnswerCheckpointParams = z.infer<typeof AnswerCheckpointParamsSchema>;

/** The codes a refused answer order answers with. */
export const ANSWER_ORDER_CODES = {
  /** The machine does not serve this product. */
  notServed: "PRODUCT_NOT_SERVED",
  /** The point does not exist (any more) on this machine. */
  notFound: "CHECKPOINT_NOT_FOUND",
  /** The point was answered, closed or is not waiting any more: nothing was written. */
  notOpen: "CHECKPOINT_NOT_OPEN",
  /** The decision does not fit the point (an option it does not have, a gate not open). */
  refused: "ANSWER_REFUSED",
  /** This kind of point is answered elsewhere (the chat, the terminal): the web only reads it. */
  elsewhere: "ANSWER_ELSEWHERE",
  /** The answer could not be written. */
  notSaved: "ANSWER_NOT_SAVED",
  /** Answering needs the machine on: nothing waits in a queue for it. */
  needsMachine: "ANSWER_NEEDS_MACHINE",
  /** Nothing is held for this point (any more): the window is over or the point was answered. */
  notHeld: "ANSWER_NOT_HELD",
  /** A story's merge is held back by its gate (CI not green on its head, review not done, a deviation). */
  mergeNotReady: "MERGE_NOT_READY",
} as const;
export type AnswerOrderCode = (typeof ANSWER_ORDER_CODES)[keyof typeof ANSWER_ORDER_CODES];

/** Refuses a source that is not the one the device's kind gives. */
function checkSource(
  value: { readonly source: AnswerSource; readonly device: string },
  context: z.RefinementCtx,
): void {
  if (answerSourceOf(value.device) !== value.source) {
    context.addIssue({
      code: "custom",
      path: ["source"],
      message: "the source is the one the device's kind gives",
    });
  }
}

/**
 * `payload` of `checkpoint.web_answered`: the point, the decision, the order that carried it and
 * the browser or phone device that signed it. The assurance (`device`) is drawn from the event's
 * type by the projection, never declared; the source must be the one the device's kind gives.
 */
export const CheckpointWebAnsweredPayloadSchema = z
  .strictObject({
    checkpoint: CheckpointIdSchema,
    decision: z.enum(CHAT_DECISIONS),
    option: ShortIdSchema.optional(),
    note: z.string().trim().min(1).max(MAX_WEB_ANSWER_NOTE_LENGTH).optional(),
    source: z.enum(ANSWER_SOURCES),
    order: UlidSchema,
    device: z.string().regex(PAIRED_DEVICE_ID_PATTERN),
  })
  .superRefine(checkAnswer)
  .superRefine(checkSource);
export type CheckpointWebAnsweredPayload = z.infer<typeof CheckpointWebAnsweredPayloadSchema>;

/** Parameters of `product.undo_checkpoint_answer`: the point whose held answer is taken back. */
export const UndoCheckpointAnswerParamsSchema = z.strictObject({
  checkpoint: CheckpointIdSchema,
});
export type UndoCheckpointAnswerParams = z.infer<typeof UndoCheckpointAnswerParamsSchema>;

/**
 * `payload` of `checkpoint.web_held`: an answer the machine holds for `WEB_ANSWER_WINDOW_MS`. It
 * is the answer of `checkpoint.web_answered`, which the machine writes when the window is over; the
 * point stays open until then.
 */
export const CheckpointWebHeldPayloadSchema = CheckpointWebAnsweredPayloadSchema;
export type CheckpointWebHeldPayload = CheckpointWebAnsweredPayload;

/**
 * `payload` of `checkpoint.web_hold_cancelled`: the held answer of the order `held` taken back by
 * the order `order`, signed by the browser device `device`. The point was never answered.
 */
export const CheckpointWebHoldCancelledPayloadSchema = z.strictObject({
  checkpoint: CheckpointIdSchema,
  held: UlidSchema,
  order: UlidSchema,
  device: z.string().regex(PAIRED_DEVICE_ID_PATTERN),
});
export type CheckpointWebHoldCancelledPayload = z.infer<
  typeof CheckpointWebHoldCancelledPayloadSchema
>;

/** The longest code and reason a failed carrying out records: short tokens, never a message. */
const FAILURE_TOKEN = /^[A-Za-z][A-Za-z0-9_.]{0,47}$/;

/**
 * `payload` of `checkpoint.web_hold_failed`: the held answer of the order `held` that the machine
 * could not carry out (`code` is the engine's error code, `reason` its short reason when it has
 * one, `merge_failed` and `head_moved` for instance). Nothing was decided and the point is open
 * again. Neither a message nor an address nor a token is recorded.
 */
export const CheckpointWebHoldFailedPayloadSchema = z.strictObject({
  checkpoint: CheckpointIdSchema,
  held: UlidSchema,
  device: z.string().regex(PAIRED_DEVICE_ID_PATTERN),
  code: z.string().regex(FAILURE_TOKEN),
  reason: z.string().regex(FAILURE_TOKEN).optional(),
});
export type CheckpointWebHoldFailedPayload = z.infer<typeof CheckpointWebHoldFailedPayloadSchema>;

/**
 * True for a point whose answer can be undone: of low or medium risk and not irreversible. The
 * answer to any other point is carried out at once.
 */
export function holdsAnswer(point: {
  readonly risk: string;
  readonly irreversible: boolean;
}): boolean {
  return !point.irreversible && (point.risk === "low" || point.risk === "medium");
}

type FactRec = Readonly<Record<string, unknown>>;

const isFactRec = (value: unknown): value is FactRec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const factText = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * What a creator judges when they answer a point, as a short, stable text: the facts the answer is
 * bound to. A device signs the hash of it as the `basis` of its order, and the machine reads it
 * again from its own journal when the order arrives, possibly days later: the answer is carried out
 * only when both are the same. One function reads the facts for both, so they cannot drift apart.
 *
 * It reads facts only (identifiers, kinds, dates, the commit the integration was read at), never a
 * text: a text can be masked by the machine's exit guard before it is published without the point
 * having changed. Whether the point is still open is not covered either: a point answered elsewhere
 * is told apart (`CHECKPOINT_NOT_OPEN`), not as a point that changed.
 *
 * `state` is a projection's state (the published one on a device, the journal's on the machine);
 * the result is `undefined` when it does not hold point `id`.
 */
export function answerBasisFacts(state: unknown, id: string): string | undefined {
  if (!isFactRec(state) || !isFactRec(state.checkpoints)) return undefined;
  if (!Object.hasOwn(state.checkpoints, id)) return undefined;
  const point = state.checkpoints[id];
  if (!isFactRec(point)) return undefined;
  const story = factText(point.story);
  const stories = isFactRec(state.stories) ? state.stories : {};
  const entry = story !== null && Object.hasOwn(stories, story) ? stories[story] : undefined;
  const ci = isFactRec(entry) && isFactRec(entry.ci) ? entry.ci : undefined;
  const verdict = isFactRec(point.verdict) ? point.verdict : undefined;
  const escalated = isFactRec(point.escalated) ? point.escalated : undefined;
  // The keys are written in a fixed order: the text is the same wherever it is made.
  return JSON.stringify({
    t: "order.basis.answer/v1",
    id,
    type: factText(point.type),
    risk: factText(point.risk),
    irreversible: point.irreversible === true,
    opened_event: factText(point.opened_event),
    verdict: factText(verdict?.result),
    reopened_at: factText(point.reopened_at),
    escalated_event: factText(escalated?.event),
    story,
    ci_commit: story === null ? null : factText(ci?.commit),
    ci_status: story === null ? null : factText(ci?.status),
  });
}
