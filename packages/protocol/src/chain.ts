import { z } from "zod";
import { AgentIdSchema } from "./method-config.js";

/**
 * The orders that keep the hand on a product's team, and the messages to Noah. Noah is the only
 * conductor: the bridge runs no agent one by one and queues no instruction. What a device can ask
 * of the team is to hold it (pause, resume, stop) or to talk to Noah.
 */

/**
 * Retired orders. They once made the bridge run the next agents (`chain.start`), pass an
 * instruction to an agent (`chain.instruct`) or talk to the agent the creator had taken the hand
 * on (`chain.say`). A machine answers them `CHAIN_ORDER_RETIRED`, whatever their parameters.
 */
export const ORDER_TYPE_CHAIN_START = "chain.start";
export const ORDER_TYPE_CHAIN_INSTRUCT = "chain.instruct";
export const ORDER_TYPE_CHAIN_SAY = "chain.say";

/**
 * The parameters of a retired order: any object, none of it is read. An older device keeps being
 * answered with the reason instead of a refusal of its parameters.
 */
export const RetiredChainOrderParamsSchema = z.record(z.string(), z.unknown());
export type RetiredChainOrderParams = z.infer<typeof RetiredChainOrderParamsSchema>;

/**
 * The orders the creator gives to hold the team of a product, each in one gesture. Pausing lets
 * the agents finish their step, resuming lets them go on, stopping is the emergency stop. They are
 * the gestures of the whole team: an `agent` is accepted and does not tell agents apart.
 */
export const ORDER_TYPE_CHAIN_PAUSE = "chain.pause";
export const ORDER_TYPE_CHAIN_RESUME = "chain.resume";
export const ORDER_TYPE_CHAIN_STOP = "chain.stop";
/** One message of the creator to Noah, who answers and routes: the same Noah as in the AI tool's chat. */
export const ORDER_TYPE_NOAH_SAY = "noah.say";

/** The event Noah writes when he takes a message of the creator. */
export const CHAIN_EVENT_TYPES = { instructionGiven: "agent.instruction_given" } as const;

/**
 * The first engine version that knows `agent.instruction_given`. An older engine answers
 * `UPGRADE_REQUIRED` to every call once the journal holds an event it does not know, so the bridge
 * refuses a message for a product that runs an older engine rather than lock its agents out.
 */
export const CHAIN_INSTRUCTION_MIN_ENGINE = "1.1.0";

/** The longest message, in characters. */
export const CHAIN_INSTRUCTION_MAX_CHARS = 4000;

const AgentTargetSchema = AgentIdSchema.max(64);

/**
 * Fields that devices older than this version still send with a pause or a resumption. They are
 * read and ignored, so that an older phone keeps its buttons; no view sends them any more.
 */
const IGNORED_OLD_FIELDS = {
  when: z.enum(["now", "after_step"]).optional(),
  hand: z.enum(["chat", "terminal"]).optional(),
  close_session: z.boolean().optional(),
};

/** `chain.pause` parameters. The pause is the team's: the agents finish their step. */
export const ChainPauseParamsSchema = z.strictObject({
  agent: AgentTargetSchema.optional(),
  ...IGNORED_OLD_FIELDS,
});
export type ChainPauseParams = z.infer<typeof ChainPauseParamsSchema>;

/** `chain.resume` parameters. */
export const ChainResumeParamsSchema = z.strictObject({
  agent: AgentTargetSchema.optional(),
  ...IGNORED_OLD_FIELDS,
});
export type ChainResumeParams = z.infer<typeof ChainResumeParamsSchema>;

/** `chain.stop` parameters. */
export const ChainControlParamsSchema = z.strictObject({
  agent: AgentTargetSchema.optional(),
});
export type ChainControlParams = z.infer<typeof ChainControlParamsSchema>;

/** The pages a message can be written from. */
export const NOAH_VIEW_PAGES = [
  "portfolio",
  "portfolio_costs",
  "overview",
  "gates",
  "agents",
  "salle",
  "sprint",
  "code",
  "docs",
  "costs",
  "profile",
  "autonomy",
  "machines",
  "settings",
  "briefing",
  "other",
] as const;

/** What a page can single out: a story, a document, a requirement, a retrospective, a point, an agent, a pull request. */
export const NOAH_VIEW_ITEM_KINDS = [
  "story",
  "document",
  "requirement",
  "retrospective",
  "point",
  "agent",
  "pull_request",
] as const;

/** The longest identifier and title of what a page singles out, in characters. */
export const NOAH_VIEW_ID_MAX = 160;
export const NOAH_VIEW_TITLE_MAX = 120;

/**
 * What the creator has in front of them when they write to Noah: the kind of page and, when the
 * page singles one out, what it is (its identifier and title). Never the content of the page:
 * Noah reads what he needs himself through the engine. The product is the one the order names.
 */
export const NoahViewSchema = z.strictObject({
  page: z.enum(NOAH_VIEW_PAGES),
  /** The part of the page, when it has several (the tab of the documents). */
  section: z
    .string()
    .regex(/^[a-z][a-z_-]{0,39}$/u)
    .optional(),
  item: z
    .strictObject({
      kind: z.enum(NOAH_VIEW_ITEM_KINDS),
      id: z.string().min(1).max(NOAH_VIEW_ID_MAX),
      title: z.string().min(1).max(NOAH_VIEW_TITLE_MAX).optional(),
    })
    .optional(),
});
export type NoahView = z.infer<typeof NoahViewSchema>;

/**
 * `noah.say` parameters: one message of the creator to Noah, typed or dictated. The text is passed
 * to Noah as it is. `input` says how Noah's answer will reach the creator, not how the message was
 * entered: `voice` means the answer will be read aloud on their device (the Vocal and Hands-free
 * modes of the talk window, whether the message was typed or dictated; the audio never reaches the
 * bridge), so Noah answers briefly, to be listened to. `text` (or nothing) means it is only read.
 * The field keeps its name so that a bridge older than the modes still understands the order.
 */
export const NoahSayParamsSchema = z.strictObject({
  text: z
    .string()
    .min(1)
    .max(CHAIN_INSTRUCTION_MAX_CHARS)
    .refine((value) => value.trim().length > 0, { message: "the message is empty" }),
  input: z.enum(["text", "voice"]).optional(),
  /** The page the creator was looking at, so that "summarize this" needs no name; absent if they took it off. */
  view: NoahViewSchema.optional(),
});
export type NoahSayParams = z.infer<typeof NoahSayParamsSchema>;

/** `payload` of `agent.instruction_given`: the creator's message, kept encrypted in the journal. */
export const InstructionGivenPayloadSchema = z.strictObject({
  /** Who the creator spoke to. */
  to: AgentTargetSchema,
  /** The agent the message went to when Noah routed it (events of earlier versions). */
  routed_to: AgentTargetSchema.optional(),
  text: z.string().min(1).max(CHAIN_INSTRUCTION_MAX_CHARS),
  /** How the message was delivered (events of earlier versions use `now` and `queued`). */
  delivery: z.enum(["now", "queued", "chat"]),
});
export type InstructionGivenPayload = z.infer<typeof InstructionGivenPayloadSchema>;

/** The codes a machine answers the orders of the team and of Noah with when it does not do what they ask. */
export const CHAIN_ORDER_CODES = {
  /** This machine does not drive agents, or does not serve the product. */
  UNAVAILABLE: "CHAIN_UNAVAILABLE",
  /** The order was retired: the bridge no longer runs agents one by one, the creator talks to Noah. */
  ORDER_RETIRED: "CHAIN_ORDER_RETIRED",
  /** The product runs an engine older than the one that knows the creator's messages. */
  ENGINE_TOO_OLD: "CHAIN_ENGINE_TOO_OLD",
  /** Ten requests of the creator already wait for Noah: none is dropped, the next one is refused. */
  REQUESTS_FULL: "CHAIN_REQUESTS_FULL",
  /** The tool of Noah cannot continue a session with a new message. */
  CONVERSATION_UNAVAILABLE: "CHAIN_CONVERSATION_UNAVAILABLE",
  /** The creator keeps the product paused or archived: no agent starts until they say otherwise. */
  PRODUCT_PAUSED: "CHAIN_PRODUCT_PAUSED",
  /** The creator holds the whole team (pause or emergency stop): no agent starts until they resume it. */
  TEAM_PAUSED: "CHAIN_TEAM_PAUSED",
} as const;
