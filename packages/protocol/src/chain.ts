import { z } from "zod";
import { MAX_BUDGET_USD } from "./budget.js";
import { AgentIdSchema } from "./method-config.js";

/**
 * The chain: the bridge runs the product's agents one after the other, between two validations of
 * the creator. The creator starts it with one signed order; the bridge stops at every validation
 * that waits for the creator, and goes on when it is given.
 */

/** The order the creator gives to run the next agents of a product. */
export const ORDER_TYPE_CHAIN_START = "chain.start";

/**
 * The orders the creator gives to keep the hand on the agents of a product, each in one gesture:
 * pause them, take them up again, stop them, or give them an instruction. Without an `agent` an
 * order is for the whole team of the product.
 */
export const ORDER_TYPE_CHAIN_PAUSE = "chain.pause";
export const ORDER_TYPE_CHAIN_RESUME = "chain.resume";
export const ORDER_TYPE_CHAIN_STOP = "chain.stop";
export const ORDER_TYPE_CHAIN_INSTRUCT = "chain.instruct";
/** One message of the creator to the agent they took the hand on, in a conversation. */
export const ORDER_TYPE_CHAIN_SAY = "chain.say";
/** One message of the creator to Noah, who answers and routes: the same Noah as in the AI tool's chat. */
export const ORDER_TYPE_NOAH_SAY = "noah.say";

/** The event the bridge writes when it takes an instruction of the creator for an agent. */
export const CHAIN_EVENT_TYPES = { instructionGiven: "agent.instruction_given" } as const;

/**
 * The first engine version that knows `agent.instruction_given`. An older engine answers
 * `UPGRADE_REQUIRED` to every call once the journal holds an event it does not know, so the bridge
 * refuses an instruction for a product that runs an older engine rather than lock its agents out.
 */
export const CHAIN_INSTRUCTION_MIN_ENGINE = "1.1.0";

/** The longest instruction, in characters, and how many wait for an agent that is not working. */
export const CHAIN_INSTRUCTION_MAX_CHARS = 4000;
export const CHAIN_INSTRUCTIONS_QUEUE_MAX = 5;

/** How many runs a chain does by default, and the most a creator may ask for. */
export const CHAIN_MAX_STEPS_DEFAULT = 20;
export const CHAIN_MAX_STEPS_LIMIT = 100;

/**
 * `chain.start` parameters. `budget_usd` is the most the runs of this chain may cost together (the
 * tool's own report; an estimate on a subscription): the chain stops before the run that would
 * pass it. `max_steps` is the most runs it does.
 */
export const ChainStartParamsSchema = z.strictObject({
  budget_usd: z.number().finite().positive().max(MAX_BUDGET_USD).optional(),
  max_steps: z.number().int().min(1).max(CHAIN_MAX_STEPS_LIMIT).optional(),
});
export type ChainStartParams = z.infer<typeof ChainStartParamsSchema>;

const AgentTargetSchema = AgentIdSchema.max(64);

/**
 * `chain.pause` parameters. A pause is a clean stop of the agent that works, which keeps its
 * session so that it goes on with its context (`now`, the default); `after_step` lets the agent
 * finish the step it is on and pauses the team after it.
 */
export const ChainPauseParamsSchema = z
  .strictObject({
    agent: AgentTargetSchema.optional(),
    when: z.enum(["now", "after_step"]).optional(),
    /**
     * The creator takes the hand on the agent. The agent is stopped cleanly at once (never after
     * its step), its session is kept, and the team stays in the creator's hands until they take it
     * up again. `chat`: the creator talks to the agent from their device, one message at a time
     * (`chain.say`); `terminal`: they reopen the session in their own terminal on the machine.
     */
    hand: z.enum(["chat", "terminal"]).optional(),
  })
  .refine((value) => value.hand === undefined || value.when !== "after_step", {
    message: "the creator takes the session over at once, not after the step",
  });
export type ChainPauseParams = z.infer<typeof ChainPauseParamsSchema>;

/**
 * `chain.resume` parameters. `close_session` closes the program of the tool that was left open on
 * the session in a terminal of the machine (and only it), so that the creator does not have to be
 * in front of the machine to give the hand back.
 */
export const ChainResumeParamsSchema = z.strictObject({
  agent: AgentTargetSchema.optional(),
  close_session: z.boolean().optional(),
});
export type ChainResumeParams = z.infer<typeof ChainResumeParamsSchema>;

/**
 * `chain.say` parameters: one message of the creator to the agent they hold the hand on. The text
 * is passed to the tool as it is, on the same session. `close_session` as for `chain.resume`.
 */
export const ChainSayParamsSchema = z.strictObject({
  text: z
    .string()
    .min(1)
    .max(CHAIN_INSTRUCTION_MAX_CHARS)
    .refine((value) => value.trim().length > 0, { message: "the message is empty" }),
  close_session: z.boolean().optional(),
});
export type ChainSayParams = z.infer<typeof ChainSayParamsSchema>;

/**
 * `noah.say` parameters: one message of the creator to Noah, typed or dictated. The text is passed
 * to Noah as it is. `input: voice` says the text was transcribed on the creator's own device (the
 * audio never reaches the bridge): Noah then answers briefly, to be listened to.
 */
export const NoahSayParamsSchema = z.strictObject({
  text: z
    .string()
    .min(1)
    .max(CHAIN_INSTRUCTION_MAX_CHARS)
    .refine((value) => value.trim().length > 0, { message: "the message is empty" }),
  input: z.enum(["text", "voice"]).optional(),
});
export type NoahSayParams = z.infer<typeof NoahSayParamsSchema>;

/** `chain.resume` and `chain.stop` parameters. */
export const ChainControlParamsSchema = z.strictObject({
  agent: AgentTargetSchema.optional(),
});
export type ChainControlParams = z.infer<typeof ChainControlParamsSchema>;

/**
 * `chain.instruct` parameters: the creator's own words, to an agent by its name or to Noah, who
 * routes them. The text is passed to the agent as it is.
 */
export const ChainInstructParamsSchema = z.strictObject({
  agent: AgentTargetSchema,
  text: z
    .string()
    .min(1)
    .max(CHAIN_INSTRUCTION_MAX_CHARS)
    .refine((value) => value.trim().length > 0, { message: "the instruction is empty" }),
});
export type ChainInstructParams = z.infer<typeof ChainInstructParamsSchema>;

/** `payload` of `agent.instruction_given`: the creator's instruction, kept encrypted in the journal. */
export const InstructionGivenPayloadSchema = z.strictObject({
  /** Who the creator spoke to (an agent, or Noah). */
  to: AgentTargetSchema,
  /** The agent the instruction goes to when Noah routed it. */
  routed_to: AgentTargetSchema.optional(),
  text: z.string().min(1).max(CHAIN_INSTRUCTION_MAX_CHARS),
  /** `now`: the agent that works is redirected; `queued`: the agent gets it when it next starts. */
  delivery: z.enum(["now", "queued", "chat"]),
});
export type InstructionGivenPayload = z.infer<typeof InstructionGivenPayloadSchema>;

/** The codes a machine answers the orders of the chain with when it does not do what they ask. */
export const CHAIN_ORDER_CODES = {
  /** A chain is already running for this product: nothing was lost, nothing was started twice. */
  ALREADY_RUNNING: "CHAIN_ALREADY_RUNNING",
  /** This machine does not drive agents, or does not serve the product. */
  UNAVAILABLE: "CHAIN_UNAVAILABLE",
  /** Nothing works for this product: there is nothing to pause or stop. */
  NOT_RUNNING: "CHAIN_NOT_RUNNING",
  /** The team is already paused. */
  ALREADY_PAUSED: "CHAIN_ALREADY_PAUSED",
  /** The team is not paused: there is nothing to take up again. */
  NOT_PAUSED: "CHAIN_NOT_PAUSED",
  /** The team is paused: it must be taken up again before it is started. */
  PAUSED: "CHAIN_PAUSED",
  /** The agent named is not the one that works on this product. */
  AGENT_NOT_WORKING: "CHAIN_AGENT_NOT_WORKING",
  /** Too many instructions already wait for agents that are not working. */
  QUEUE_FULL: "CHAIN_QUEUE_FULL",
  /** The agent named is not an agent of this product (or the display name of one). */
  AGENT_UNKNOWN: "CHAIN_AGENT_UNKNOWN",
  /** The product runs an engine older than the one that knows the creator's instructions. */
  ENGINE_TOO_OLD: "CHAIN_ENGINE_TOO_OLD",
  /** The session of the agent is not known (yet): there is nothing to reopen in a terminal. */
  NO_SESSION: "CHAIN_NO_SESSION",
  /** The tool of the agent has no command to reopen a session in its terminal program. */
  TERMINAL_UNAVAILABLE: "CHAIN_TERMINAL_UNAVAILABLE",
  /** The session handed to the creator's terminal is still open there: it must be closed first. */
  TERMINAL_STILL_OPEN: "CHAIN_TERMINAL_STILL_OPEN",
  /** The creator does not hold the hand in a conversation: there is nobody to talk to. */
  NOT_IN_CONVERSATION: "CHAIN_NOT_IN_CONVERSATION",
  /** The agent is still answering the last message: one message at a time. */
  REPLY_PENDING: "CHAIN_REPLY_PENDING",
  /** The tool of the agent cannot continue a session with a new message. */
  CONVERSATION_UNAVAILABLE: "CHAIN_CONVERSATION_UNAVAILABLE",
  /** The budget checkpoint of the story still waits for the creator: answer it first. */
  BUDGET_PENDING: "CHAIN_BUDGET_PENDING",
  /** The creator stopped the story at its budget: it goes on only when a later sprint takes it again. */
  BUDGET_STOPPED: "CHAIN_BUDGET_STOPPED",
  /** The creator keeps the product paused or archived: no agent starts until they say otherwise. */
  PRODUCT_PAUSED: "CHAIN_PRODUCT_PAUSED",
} as const;

/**
 * What a chain tells, as a stable code: the journal holds the code and its parameters, never a
 * sentence, so that each view tells it in the creator's language.
 *
 * - `running`: the chain works;
 * - `waiting`: a validation waits for the creator; the chain resumes by itself when it is given;
 * - `your_turn`: the next step is the creator's own (not a validation);
 * - `done`: no agent has anything left to do;
 * - `failed`: an agent's run failed;
 * - `budget`: the budget of the chain is reached;
 * - `no_progress`: runs ended and the product's next step did not move;
 * - `max_steps`: the chain did all the runs it was allowed;
 * - `tool_unavailable`: the AI tool of the step is not available on this machine;
 * - `unreadable`: the product's state could not be read;
 * - `interrupted`: the bridge stopped while an agent worked, and the agent may still be working;
 * - `pausing`: the creator paused the team and the agent finishes its step first;
 * - `paused`: the creator paused the team; it goes on where it stopped when they say so;
 * - `halted`: the creator stopped the team;
 * - `handed_over`: the creator took the session over in their own terminal; the team waits for them;
 * - `conversation`: the creator took the hand and talks to the agent from their device;
 * - `budget_paused`: a story went over its budget; its agent was stopped cleanly and the team is
 *   paused until the creator answers the budget checkpoint and takes it up again.
 */
export const CHAIN_NOTE_CODES = [
  "running",
  "waiting",
  "your_turn",
  "done",
  "failed",
  "budget",
  "no_progress",
  "max_steps",
  "tool_unavailable",
  "unreadable",
  "interrupted",
  "pausing",
  "paused",
  "halted",
  "handed_over",
  "conversation",
  "budget_paused",
] as const;
export type ChainNoteCode = (typeof CHAIN_NOTE_CODES)[number];

/** The prefix of a note about a chain; a note without it is an agent's own text. */
export const CHAIN_NOTE_PREFIX = "chain:";

export type ChainNoteParams = Readonly<Record<string, string | number>>;

export function formatChainNote(code: ChainNoteCode, params: ChainNoteParams = {}): string {
  const query = Object.entries(params)
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`)
    .join("&");
  return `${CHAIN_NOTE_PREFIX}${code}${query === "" ? "" : `?${query}`}`;
}

/** The code and parameters of a chain note, or undefined for any other text. */
export function parseChainNote(
  text: string,
): { code: ChainNoteCode; params: Record<string, string> } | undefined {
  if (!text.startsWith(CHAIN_NOTE_PREFIX)) return undefined;
  const [head = "", query = ""] = text.slice(CHAIN_NOTE_PREFIX.length).split("?", 2);
  const code = CHAIN_NOTE_CODES.find((known) => known === head);
  if (code === undefined) return undefined;
  const params: Record<string, string> = {};
  for (const pair of query.split("&")) {
    if (pair === "") continue;
    const [name = "", value = ""] = pair.split("=", 2);
    try {
      params[decodeURIComponent(name)] = decodeURIComponent(value);
    } catch {
      // A malformed piece is left out.
    }
  }
  return { code, params };
}

/**
 * What the bridge did with a handover Noah recorded, as a stable code the views tell in the
 * creator's language (a line `routed` of the live reading). `started`: the agent that was named
 * works on what comes next; `instructed`: the agent got the creator's instruction; `paused` and
 * `resumed`: the team was paused or taken up again as the creator asked; `refused`: it could not
 * be done, and `code` is the code of the refusal (one of `CHAIN_ORDER_CODES`).
 */
export const NOAH_ROUTE_CODES = ["started", "instructed", "paused", "resumed", "refused"] as const;
export type NoahRouteCode = (typeof NOAH_ROUTE_CODES)[number];

/** The prefix of a line about what Noah's handover became. */
export const NOAH_ROUTE_PREFIX = "noah:";

export function formatNoahRoute(code: NoahRouteCode, params: ChainNoteParams = {}): string {
  const query = Object.entries(params)
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`)
    .join("&");
  return `${NOAH_ROUTE_PREFIX}${code}${query === "" ? "" : `?${query}`}`;
}

/** The code and parameters of a route line, or undefined for any other text. */
export function parseNoahRoute(
  text: string,
): { code: NoahRouteCode; params: Record<string, string> } | undefined {
  if (!text.startsWith(NOAH_ROUTE_PREFIX)) return undefined;
  const [head = "", query = ""] = text.slice(NOAH_ROUTE_PREFIX.length).split("?", 2);
  const code = NOAH_ROUTE_CODES.find((known) => known === head);
  if (code === undefined) return undefined;
  const params: Record<string, string> = {};
  for (const pair of query.split("&")) {
    if (pair === "") continue;
    const [name = "", value = ""] = pair.split("=", 2);
    try {
      params[decodeURIComponent(name)] = decodeURIComponent(value);
    } catch {
      // A malformed piece is left out.
    }
  }
  return { code, params };
}
