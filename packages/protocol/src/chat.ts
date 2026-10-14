import { z } from "zod";
import { CheckpointIdSchema, type ResolutionDecision } from "./checkpoint.js";
import { AgentIdSchema } from "./method-config.js";
import { QuestionToolViaSchema } from "./question-tool.js";

/**
 * Answering a checkpoint in the chat of an AI tool: the agent relays the
 * creator's answer (`answer_checkpoint`), quoting the creator's own message word for word. The
 * engine accepts it only when a hook of the tool recorded that message in the session after the
 * checkpoint opened (`proof`); in a tool without hooks, it is accepted unverified. At the `auto`
 * level, the engine itself applies the recommended option of a low-risk checkpoint, and the
 * creator can reopen it.
 */

/** Event types of the chat and of the `auto` level, each at version 1. */
export const CHAT_EVENT_TYPES = {
  /** The creator's answer relayed by an agent (`actor.kind: agent`, `source: chat`). */
  answered: "checkpoint.answered",
  /** The recommended option applied by the engine at the `auto` level (`actor.kind: system`). */
  autoApplied: "checkpoint.auto_applied",
  /** An automatic application cancelled: the checkpoint is open again. */
  reopened: "checkpoint.reopened",
} as const;

/**
 * The decisions the chat records: those of the terminal but the waiver, which stays at the
 * terminal.
 */
export const CHAT_DECISIONS = [
  "approved",
  "approved_with_reservations",
  "rejected",
  "changes_requested",
  "option_chosen",
] as const satisfies readonly ResolutionDecision[];
export type ChatDecision = (typeof CHAT_DECISIONS)[number];

/** What `answer_checkpoint` may ask: a chat decision, or `reopen` (cancel an automatic one). */
export const ANSWER_DECISIONS = [...CHAT_DECISIONS, "reopen"] as const;
export type AnswerDecision = (typeof ANSWER_DECISIONS)[number];

/** The longest quote of the creator's words. */
export const MAX_QUOTE_LENGTH = 4000;

/** The SHA-256 of a normalised message, in lowercase hexadecimal. */
export const MessageDigestSchema = z.string().regex(/^[0-9a-f]{64}$/, {
  message: "expected 64 lowercase hexadecimal characters",
});

/** A message of the creator the hook recorded: its digest and when it was typed or dictated. */
export const ChatMessageRefSchema = z.strictObject({
  digest: MessageDigestSchema,
  at: z.iso.datetime(),
});
export type ChatMessageRef = z.infer<typeof ChatMessageRefSchema>;

/**
 * What the hook proved, set by the engine only (never given by the agent): the quoted message.
 * `confirmation` is only read from journals written, which retired the second
 * message that confirmed an irreversible action: the engine writes none any more.
 */
export const ChatProofSchema = z.strictObject({
  message: ChatMessageRefSchema,
  confirmation: ChatMessageRefSchema.optional(),
});
export type ChatProof = z.infer<typeof ChatProofSchema>;

/** The creator's words, as quoted: 1 to 4000 characters, never only blanks. */
const QuoteSchema = z.string().max(MAX_QUOTE_LENGTH).trim().min(1);

const ShortIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/, {
  message: "expected 1 to 32 letters, digits, dots, hyphens or underscores",
});

/** A tool session id as a hook gives it: printable, at most 200 characters. */
export const ToolSessionIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\x21-\x7e]+$/, { message: "expected printable characters without spaces" });

/**
 * Input of `answer_checkpoint`. `quote` is the creator's whole message, word for word, never a
 * rewording; `session` the AI tool's session id the hook gave. `option` goes with `option_chosen`
 * only. One message of the creator answers one point, whatever its type or its risk:
 * there is no confirmation to send after it.
 *
 * `via: "question_tool"` records the creator's click in the AI tool's question tool
 * instead (`ask_creator` dictated the questions): the agent then gives the checkpoint and the
 * session only. The engine reads the choice and the note from what the tool's hook recorded,
 * never from the agent: no `decision`, `option`, `note` nor `quote` goes with it.
 */
export const AnswerCheckpointInputSchema = z
  .strictObject({
    agent: AgentIdSchema.max(64),
    checkpoint: z.string().trim().toUpperCase().pipe(CheckpointIdSchema),
    decision: z.enum(ANSWER_DECISIONS).optional(),
    option: ShortIdSchema.optional(),
    note: z.string().trim().min(1).max(2000).optional(),
    quote: QuoteSchema.optional(),
    session: ToolSessionIdSchema.optional(),
    via: QuestionToolViaSchema.optional(),
    /**
     * The quoted message was sent in this session just before the point opened, in
     * agreement with exactly the decision it then asks (the creator said « c'est validé » to what
     * the agent announced): the engine accepts a message up to `ANTICIPATED_ANSWER_WINDOW_MS`
     * before the opening, and the journal says so.
     */
    anticipated: z
      .literal(true)
      .describe(
        "true when the creator agreed, in this session and at most 30 minutes before the point opened, to exactly the decision it asks: quote that message",
      )
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.via !== undefined) {
      for (const field of ["decision", "option", "note", "quote", "anticipated"] as const) {
        if (value[field] !== undefined) {
          context.addIssue({
            code: "custom",
            path: [field],
            message: "the question tool's answer is read from what its hook recorded",
          });
        }
      }
      return;
    }
    if (value.decision === undefined) {
      context.addIssue({ code: "custom", path: ["decision"], message: "a decision is required" });
    }
    if (value.quote === undefined) {
      context.addIssue({ code: "custom", path: ["quote"], message: "a quote is required" });
    }
    if ((value.decision === "option_chosen") !== (value.option !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["option"],
        message: "an option goes with option_chosen, and only with it",
      });
    }
    if (value.decision === "reopen" && value.anticipated !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["anticipated"],
        message: "an agreement given before the opening cannot reopen a point",
      });
    }
    if (value.decision === "reopen" && value.note !== undefined) {
      context.addIssue({ code: "custom", path: ["note"], message: "reopening takes no note" });
    }
  });
/** What `answer_checkpoint` is given, before the form of the answer is known (`via`). */
export type AnswerCheckpointToolInput = z.infer<typeof AnswerCheckpointInputSchema>;
/** An answer relayed from the chat: the decision and the creator's quoted message. */
export type AnswerCheckpointInput = Omit<
  AnswerCheckpointToolInput,
  "decision" | "quote" | "via"
> & {
  readonly decision: AnswerDecision;
  readonly quote: string;
  readonly via?: undefined;
};
/** An answer read from the AI tool's question tool. */
export type QuestionToolAnswerInput = Pick<
  AnswerCheckpointToolInput,
  "agent" | "checkpoint" | "session"
> & { readonly via: "question_tool" };

/**
 * `payload` of `checkpoint.answered`: the creator's answer relayed from the chat, the quote and,
 * when the hook proved it, the digest and date of the quoted message (`proof`). The assurance is
 * drawn from `proof` by the projection: `chat` with it, `chat_unverified` without.
 */
export const CheckpointAnsweredPayloadSchema = z
  .strictObject({
    checkpoint: CheckpointIdSchema,
    decision: z.enum(CHAT_DECISIONS),
    option: ShortIdSchema.optional(),
    note: z.string().trim().min(1).max(2000).optional(),
    source: z.literal("chat"),
    quote: QuoteSchema,
    /** Read from journals written only: the engine writes none any more. */
    confirmation_quote: QuoteSchema.optional(),
    proof: ChatProofSchema.optional(),
    /** The creator agreed just before the point opened (see the input's field). */
    anticipated: z.literal(true).optional(),
  })
  .superRefine((value, context) => {
    if ((value.decision === "option_chosen") !== (value.option !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["option"],
        message: "an option goes with option_chosen, and only with it",
      });
    }
    if (value.proof?.confirmation !== undefined && value.confirmation_quote === undefined) {
      context.addIssue({
        code: "custom",
        path: ["proof", "confirmation"],
        message: "a confirmation proof goes with a confirmation quote",
      });
    }
  });
export type CheckpointAnsweredPayload = z.infer<typeof CheckpointAnsweredPayloadSchema>;

/** `payload` of `checkpoint.auto_applied`: the recommended option, applied by the engine. */
export const CheckpointAutoAppliedPayloadSchema = z.strictObject({
  checkpoint: CheckpointIdSchema,
  decision: z.literal("option_chosen"),
  option: ShortIdSchema,
});
export type CheckpointAutoAppliedPayload = z.infer<typeof CheckpointAutoAppliedPayloadSchema>;

/** Where a reopening comes from: the chat (an agent relays it) or the terminal (the creator). */
export const REOPEN_SOURCES = ["chat", "terminal"] as const;

/**
 * `payload` of `checkpoint.reopened`: an automatic application cancelled. From the chat, it
 * quotes the creator (and carries the hook's proof when there is one); from the terminal, it is
 * signed by the creator's key.
 */
export const CheckpointReopenedPayloadSchema = z
  .strictObject({
    checkpoint: CheckpointIdSchema,
    source: z.enum(REOPEN_SOURCES),
    quote: QuoteSchema.optional(),
    proof: ChatProofSchema.optional(),
  })
  .superRefine((value, context) => {
    if ((value.source === "chat") !== (value.quote !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["quote"],
        message: "a quote goes with the chat, and only with it",
      });
    }
    if (value.source === "terminal" && value.proof !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["proof"],
        message: "a proof goes with the chat only",
      });
    }
  });
export type CheckpointReopenedPayload = z.infer<typeof CheckpointReopenedPayloadSchema>;

/**
 * Where a validation was made: the terminal, the chat, the engine at `auto`, or the AI
 * tool's form the engine asked for itself (`elicitation`), or an agent that decided a
 * point the creator did not keep (`agent`).
 */
export const VALIDATION_SOURCES = ["terminal", "chat", "auto", "elicitation", "agent"] as const;
export type ValidationSource = (typeof VALIDATION_SOURCES)[number];

/**
 * How sure a validation is to come from the creator: `presence` or `locale` at the terminal
 *, `chat` when the hook proved the quote, `chat_unverified` without a hook, `system`
 * for an automatic application, `elicitation` for a choice the creator clicked in the AI tool's
 * form the engine asked for. `agent` for a point the agent responsible
 * for it decided: never the creator's answer.
 */
export const VALIDATION_ASSURANCES = [
  "presence",
  "locale",
  "chat",
  "chat_unverified",
  "system",
  "elicitation",
  "agent",
] as const;
export type ValidationAssurance = (typeof VALIDATION_ASSURANCES)[number];

/** A validation's decision in the history: a resolution, or the reopening of an automatic one. */
export type ValidationDecision = ResolutionDecision | "reopened";

/**
 * How long before a point opened the creator's agreement may have been given, for the
 * decision that point then asks (`anticipated`): a few minutes of the same session, never more.
 */
export const ANTICIPATED_ANSWER_WINDOW_MS = 30 * 60 * 1000;

/** How long the hook keeps the creator's messages, and how recent a quoted one must be. */
export const CHAT_RETENTION_MS = 24 * 60 * 60 * 1000;
