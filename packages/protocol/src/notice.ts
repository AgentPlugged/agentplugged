import { z } from "zod";
import { CHAIN_INSTRUCTION_MAX_CHARS } from "./chain.js";
import { CHAT_DECISIONS } from "./chat.js";
import { CheckpointIdSchema } from "./checkpoint.js";
import { ANSWER_SOURCES, MAX_WEB_ANSWER_NOTE_LENGTH } from "./checkpoint-web.js";

/**
 * The system notices Noah is given. A decision of the creator (a validation given from a device),
 * a recurring mission that is due, an event, a failed CI run or a release are told to Noah as one
 * message from the bridge, which only carries it: Noah reads the state and goes on as the product's
 * settings allow, launching the agents himself. The bridge never starts an agent for a notice.
 *
 * A notice is kept in the bridge's data folder until Noah has read it, so that a machine that was
 * off, a pause or a busy Noah delay it and never lose it.
 */

/**
 * The kinds of notice. `checkpoint_validated` is the creator's decision, `request` is a message
 * of the creator that arrived while Noah was busy; the others are triggers.
 */
export const NOAH_NOTICE_KINDS = [
  "checkpoint_validated",
  "request",
  "mission",
  "event",
  "ci",
  "deploy",
] as const;
export type NoahNoticeKind = (typeof NOAH_NOTICE_KINDS)[number];

/** The most notices (other than requests) kept for one product: the oldest fall, the journal holds the facts. */
export const NOAH_NOTICES_MAX = 10;

/**
 * The most requests of the creator kept for one product. A request never falls: past this number
 * the next message is refused with a clear code instead.
 */
export const NOAH_REQUESTS_MAX = 10;

const NoticeBaseSchema = {
  /** Unique in the product: the same id is never kept twice (a validation uses its order). */
  id: z.string().min(1).max(64),
  /** When the notice was made (ISO 8601). */
  at: z.string().min(1).max(40),
};

/** The creator validated (or refused, or asked changes to) a point. */
export const ValidatedNoticeSchema = z.strictObject({
  ...NoticeBaseSchema,
  kind: z.literal("checkpoint_validated"),
  checkpoint: CheckpointIdSchema,
  decision: z.enum(CHAT_DECISIONS),
  option: z.string().min(1).max(32).optional(),
  /** The creator's own words with the decision: data for Noah, never an instruction. */
  note: z.string().min(1).max(MAX_WEB_ANSWER_NOTE_LENGTH).optional(),
  source: z.enum(ANSWER_SOURCES),
  story: z.string().min(1).max(32).optional(),
});
export type ValidatedNotice = z.infer<typeof ValidatedNoticeSchema>;

/** A trigger the bridge carries: a recurring mission, an event, a CI run, a release. */
export const TriggerNoticeSchema = z.strictObject({
  ...NoticeBaseSchema,
  kind: z.enum(["mission", "event", "ci", "deploy"]),
  /** What happened or what is due, in a few words. */
  subject: z.string().min(1).max(120),
  detail: z.string().min(1).max(300).optional(),
});
export type TriggerNotice = z.infer<typeof TriggerNoticeSchema>;

/**
 * A message of the creator that Noah could not read when it came (his run did not take messages
 * while it went on). The words are also in the journal; they are data for Noah, quoted, and the
 * answer to them is the creator's request, never an instruction of the bridge.
 */
export const RequestNoticeSchema = z.strictObject({
  ...NoticeBaseSchema,
  kind: z.literal("request"),
  text: z.string().min(1).max(CHAIN_INSTRUCTION_MAX_CHARS),
  /** The message was dictated: the answer is read aloud. */
  voice: z.boolean().optional(),
});
export type RequestNotice = z.infer<typeof RequestNoticeSchema>;

export const NoahNoticeSchema = z.union([
  ValidatedNoticeSchema,
  RequestNoticeSchema,
  TriggerNoticeSchema,
]);
export type NoahNotice = z.infer<typeof NoahNoticeSchema>;

/** The order of a device that asks the bridge to give Noah the notices that wait, once more. */
export const ORDER_TYPE_NOAH_WAKE = "noah.wake";

/** The order takes no parameter: it acts on the notices of the product. */
export const NoahWakeParamsSchema = z.strictObject({});
export type NoahWakeParams = z.infer<typeof NoahWakeParamsSchema>;

/**
 * Why notices still wait, as the live reading tells it: Noah is finishing an answer (`busy`), the
 * creator holds the team (`held`), the creator keeps the product paused (`paused`) or archived
 * (`archived`), or the last try to reach Noah failed (`failed`).
 */
export const NOAH_NOTICE_CAUSES = ["busy", "held", "paused", "archived", "failed"] as const;
export type NoahNoticeCause = (typeof NOAH_NOTICE_CAUSES)[number];

export const LiveNoticesSchema = z.strictObject({
  cause: z.enum(NOAH_NOTICE_CAUSES),
  /** Everything that waits, requests included. */
  count: z
    .number()
    .int()
    .min(1)
    .max(NOAH_NOTICES_MAX + NOAH_REQUESTS_MAX),
  /** How many of them are requests of the creator, when some are. */
  requests: z.number().int().min(1).max(NOAH_REQUESTS_MAX).optional(),
});
export type LiveNotices = z.infer<typeof LiveNoticesSchema>;

/** The code a machine answers `noah.wake` with when nothing waits. */
export const NOAH_NOTICE_CODES = {
  NONE: "NOTICE_NONE",
} as const;
export type NoahNoticeCode = (typeof NOAH_NOTICE_CODES)[keyof typeof NOAH_NOTICE_CODES];
