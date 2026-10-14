import { z } from "zod";
import {
  ChatProofSchema,
  MAX_QUOTE_LENGTH,
  MessageDigestSchema,
  ToolSessionIdSchema,
} from "./chat.js";
import {
  CHECKPOINT_RISKS,
  CHECKPOINT_TYPES,
  CheckpointDocumentSchema,
  CheckpointIdSchema,
} from "./checkpoint.js";
import { ElicitationChannelSchema } from "./elicitation.js";
import { AgentIdSchema } from "./method-config.js";
import { QuestionStackProofSchema, QuestionToolViaSchema } from "./question-tool.js";

/**
 * The stack to validate: several open checkpoints presented together, numbered
 * 1, 2, 3…, which the creator answers in one message (« j'approuve les 3 », « j'approuve 1, 2 et 4 »)
 * or in one form, a box per point. The engine opens the stack (`open_stack`, `stack.opened`), reads
 * the creator's message itself (`answer_stack`) or asks the form itself (`ask_stack`), and records
 * the answer as one event (`stack.answered`) that the projection turns into one answer per point
 * approved, and those alone. A point at a high risk or irreversible never enters a stack: it is
 * presented alone, its question naming the action. The same structure serves any surface.
 */

/** Event types of the stack, each at version 1. */
export const STACK_EVENT_TYPES = {
  /** The engine opens a stack of open checkpoints (`actor.kind: agent`, the one that presents). */
  opened: "stack.opened",
  /** The creator's answer to a stack: the points approved (`actor.kind: agent`, on a machine). */
  answered: "stack.answered",
} as const;

/** A stack holds at least this many points (one point is answered on its own). */
export const MIN_STACK_ITEMS = 2;

/**
 * A stack holds at most this many points: the creator reads and decides them all at once. Story
 * 3.29: 16, so that a night's points wait in one stack in the morning.
 */
export const MAX_STACK_ITEMS = 16;

/** `P-` then the last 10 characters of the ULID of the event that opened the stack. */
export const StackIdSchema = z.string().regex(/^P-[0-9A-HJKMNP-TV-Z]{10}$/, {
  message: "expected P- then 10 characters, for example P-7M2K9QX4TB",
});

/** A stack id as typed (`p-7m2k9qx4tb`): trimmed, upper case, then checked. */
export const StackIdInputSchema = z.string().trim().toUpperCase().pipe(StackIdSchema);

/** The id of the stack opened by the event `eventId`: stable, never renumbered. */
export function stackIdOf(eventId: string): string {
  return `P-${eventId.slice(-10)}`;
}

/**
 * Why `open_stack` refuses a checkpoint or a list (`STACK_INVALID`, nothing written):
 * - `too_few`, `too_many`: not 2 to 8 points; `duplicate`: a point listed twice;
 * - `unknown_checkpoint`: no such checkpoint; `not_open`: it does not wait for an answer;
 * - `high_risk`, `irreversible`: such a point is presented alone, its question naming the action
 *   (never in a stack);
 * - `type`, `source`: a kind of point a stack never holds (an action of the creator's, a memory
 *   change, a publication, a release, a merge, a review loop, the fast track, a conflict…);
 * - `needs_choice`: a decision with options and no recommendation: the creator must choose one;
 * - `cannot_approve`: the resolution rules would refuse an approval now (a held merge gate…).
 */
export const STACK_INVALID_REASONS = [
  "too_few",
  "too_many",
  "duplicate",
  "unknown_checkpoint",
  "not_open",
  "high_risk",
  "irreversible",
  "type",
  "source",
  "needs_choice",
  "cannot_approve",
  "stack_open",
] as const;
export type StackInvalidReason = (typeof STACK_INVALID_REASONS)[number];

/**
 * Why a message is not an approval of the stack's points (`STACK_REPLY_UNCLEAR`, nothing written):
 * - `not_a_selection`: not exactly an approval of numbers of the stack (a bare « oui », a
 *   negation, a reservation, a question, any word the grammar does not know);
 * - `out_of_range`: a number that is not a point of the stack;
 * - `ambiguous_count`: « les 3 » when the stack does not hold 3 points;
 * - `not_selected`: `answer_checkpoint` of a point of an open stack with a message that selects
 *   other numbers: a message answers the points it names, and those alone;
 * - `nothing_open`: every point the message names is already answered, while others still wait.
 */
export const STACK_REPLY_REASONS = [
  "not_a_selection",
  "out_of_range",
  "ambiguous_count",
  "not_selected",
  "nothing_open",
] as const;
export type StackReplyReason = (typeof STACK_REPLY_REASONS)[number];

const agent = AgentIdSchema.max(64);

/** Input of `open_stack`: the agent and the checkpoints to present together, in this order. */
export const OpenStackInputSchema = z.strictObject({
  agent,
  checkpoints: z.array(z.string().trim().toUpperCase().pipe(CheckpointIdSchema)).min(1).max(50),
});
export type OpenStackInput = z.infer<typeof OpenStackInputSchema>;

/** Input of `ask_stack`: the agent and the stack. Nothing of the answer comes from it. */
export const AskStackInputSchema = z.strictObject({ agent, stack: StackIdInputSchema });
export type AskStackInput = z.infer<typeof AskStackInputSchema>;

/** The creator's words, as quoted: 1 to 4000 characters, never only blanks. */
const QuoteSchema = z.string().max(MAX_QUOTE_LENGTH).trim().min(1);

/**
 * Input of `answer_stack`: the creator's whole message, word for word, and the AI tool's session id
 * the hook gave. The agent gives neither the numbers nor the decision: the engine reads them from
 * the message. `via: "question_tool"` and the session, without a quote: the engine reads
 * the answers the tool's hook recorded for the screens it dictated.
 */
export const AnswerStackInputSchema = z
  .strictObject({
    agent,
    stack: StackIdInputSchema,
    quote: QuoteSchema.optional(),
    session: ToolSessionIdSchema.optional(),
    via: QuestionToolViaSchema.optional(),
  })
  .superRefine((value, context) => {
    if ((value.via !== undefined) === (value.quote !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["quote"],
        message: "give the creator's quote, or via the question tool without a quote",
      });
    }
  });
/** What `answer_stack` is given: a quote (the chat), or `via: "question_tool"`. */
export type AnswerStackToolInput = z.infer<typeof AnswerStackInputSchema>;
/** An answer from the chat: the creator's whole message. */
export type AnswerStackInput = Omit<AnswerStackToolInput, "quote" | "via"> & {
  readonly quote: string;
  readonly via?: undefined;
};

/** One point of a stack as `stack.opened` records it: its number, the checkpoint, what was shown. */
export const StackItemSchema = z.strictObject({
  n: z.int().min(1).max(MAX_STACK_ITEMS),
  checkpoint: CheckpointIdSchema,
  /** The SHA-256 of what the stack shows of the point (`stackItemDigest`). */
  digest: MessageDigestSchema,
});
export type StackItem = z.infer<typeof StackItemSchema>;

/** `payload` of `stack.opened`: the points, numbered 1, 2, 3… without a gap, all distinct. */
export const StackOpenedPayloadSchema = z
  .strictObject({
    items: z.array(StackItemSchema).min(MIN_STACK_ITEMS).max(MAX_STACK_ITEMS),
  })
  .superRefine((value, context) => {
    value.items.forEach((item, index) => {
      if (item.n !== index + 1) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "n"],
          message: "points are numbered 1, 2, 3… in order",
        });
      }
    });
    if (new Set(value.items.map((item) => item.checkpoint)).size !== value.items.length) {
      context.addIssue({ code: "custom", path: ["items"], message: "a point is listed once" });
    }
  });
export type StackOpenedPayload = z.infer<typeof StackOpenedPayloadSchema>;

/** The numbers approved: 1 to 8, strictly increasing. */
const ApprovedSchema = z
  .array(z.int().min(1).max(MAX_STACK_ITEMS))
  .min(1)
  .max(MAX_STACK_ITEMS)
  .refine(
    (numbers) =>
      numbers.every((number, index) => index === 0 || number > (numbers[index - 1] ?? 0)),
    {
      message: "numbers are strictly increasing",
    },
  );

/**
 * `payload` of `stack.answered`: the points of a stack the creator approved, and where. From the
 * chat: the creator's whole message (`quote`) and, when the hook proved it, its digest and date
 * (`proof`); the projection reads the message again and accepts only the numbers it names. From the
 * AI tool's form (`elicitation`): the tool that showed it (`channel`) and the digest of the form
 * (`form`). The assurance (`chat`, `chat_unverified`, `elicitation`) is drawn from the event by the
 * projection, never declared.
 */
export const StackAnsweredPayloadSchema = z.discriminatedUnion("source", [
  z.strictObject({
    stack: StackIdSchema,
    source: z.literal("chat"),
    approve: ApprovedSchema,
    quote: QuoteSchema,
    proof: ChatProofSchema.optional(),
  }),
  z
    .strictObject({
      stack: StackIdSchema,
      source: z.literal("elicitation"),
      approve: ApprovedSchema,
      channel: ElicitationChannelSchema,
      form: MessageDigestSchema,
      /** Version 2: the answers chosen in the question tool, and what its hook proved. */
      via: QuestionToolViaSchema.optional(),
      proof: QuestionStackProofSchema.optional(),
    })
    .superRefine((value, context) => {
      if ((value.via !== undefined) !== (value.proof !== undefined)) {
        context.addIssue({
          code: "custom",
          path: ["proof"],
          message: "a proof goes with the question tool, and only with it",
        });
      }
    }),
]);
export type StackAnsweredPayload = z.infer<typeof StackAnsweredPayloadSchema>;

/**
 * One point of the stack as a surface shows it (the AI tool's form, or any other
 * surface): built by the engine from the checkpoint, never by the agent.
 */
export const StackPromptItemSchema = z.strictObject({
  n: z.int().min(1).max(MAX_STACK_ITEMS),
  checkpoint: CheckpointIdSchema,
  type: z.enum(CHECKPOINT_TYPES),
  title: z.string(),
  summary: z.string(),
  risk: z.enum(CHECKPOINT_RISKS),
  /** The agent that opened the checkpoint (its texts are that agent's), or null. */
  opened_by: z.string().nullable(),
  documents: z.array(CheckpointDocumentSchema),
  /** What an approval chooses: the recommended option of a decision, or null. */
  recommendation: z.strictObject({ label: z.string(), consequence: z.string() }).nullable(),
});
export type StackPromptItem = z.infer<typeof StackPromptItemSchema>;

/** The stack to show: its points still waiting for an answer, with their original numbers. */
export const StackPromptSchema = z.strictObject({
  stack: StackIdSchema,
  items: z.array(StackPromptItemSchema).min(1).max(MAX_STACK_ITEMS),
});
export type StackPrompt = z.infer<typeof StackPromptSchema>;
