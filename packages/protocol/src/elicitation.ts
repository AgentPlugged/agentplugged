import { z } from "zod";
import { CHAT_DECISIONS, MessageDigestSchema } from "./chat.js";
import {
  CHECKPOINT_RISKS,
  CHECKPOINT_TYPES,
  CheckpointDocumentSchema,
  CheckpointIdSchema,
} from "./checkpoint.js";
import { CreatorActionRecordSchema } from "./creator-action.js";
import { AgentIdSchema } from "./method-config.js";
import { PublicationRecordSchema } from "./publication.js";
import { QuestionProofSchema, QuestionToolViaSchema } from "./question-tool.js";

/**
 * Decisions the engine asks itself: when the AI tool can show a form a
 * MCP server asks for (the protocol's « elicitation », `elicitation/create`), the server presents
 * an open checkpoint to the creator, and the creator's click reaches the engine without passing
 * through the agent. The decision object (`DecisionPrompt`) is the same for every surface that
 * will show it (the AI tool's form, or any other surface).
 */

/** The event type of an answer given in the AI tool's form, at version 1. */
export const ELICITATION_EVENT_TYPES = {
  /** The creator's answer chosen in the AI tool's form (`actor.kind: agent`, the one who asked). */
  answered: "checkpoint.elicited",
} as const;

/** How long the creator has to answer the form before the engine gives up (no answer written). */
export const ELICITATION_TIMEOUT_MS = 10 * 60 * 1000;

/** The longest note the creator types in the form, like a resolution's note. */
export const MAX_ELICITED_NOTE_LENGTH = 2000;

/**
 * Why `ask_creator` recorded nothing (the checkpoint stays open; the agent asks in the chat):
 * - `unavailable`: no form can be shown (the AI tool did not announce the capability);
 * - `declined`: the creator, or the tool on their behalf, refused the form;
 * - `cancelled`: the form was closed without a choice;
 * - `failed`: no answer in time, or the tool failed to show it;
 * - `note_required`: a refusal or a request for changes without a note;
 * - `invalid`: an answer that is none of the choices offered;
 * - `busy`: a form of this session is already open, waiting for the creator;
 * - `tool_hook`: a hook of the AI tool could answer the form in the creator's place
 *   (`Elicitation` or `ElicitationResult` hooks of Claude Code's settings);
 * - `no_choice`: the checkpoint offers no choice the form could show;
 * - `content_too_long`: the definition of an agent to create, or the installation a permission point
 *   asks for (its request is kept cut at 500 characters), is too long to be read in the form
 *: the agent shows it in the chat, and `review` shows it at the terminal;
 * - `none_checked`: a stack's form submitted with every box unticked: nothing is
 *   approved, nothing is written;
 * - `too_many_choices`: the checkpoint offers more choices than the AI tool's question tool can
 *   show (four options at most): the agent asks in the chat.
 */
export const ELICITATION_FALLBACK_REASONS = [
  "unavailable",
  "declined",
  "cancelled",
  "failed",
  "note_required",
  "invalid",
  "busy",
  "tool_hook",
  "no_choice",
  "content_too_long",
  "none_checked",
  "too_many_choices",
] as const;
export type ElicitationFallbackReason = (typeof ELICITATION_FALLBACK_REASONS)[number];

const ShortIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/, {
  message: "expected 1 to 32 letters, digits, dots, hyphens or underscores",
});

/**
 * The AI tool that showed the form, as its MCP client introduced itself (`clientInfo.name`):
 * printable, at most 64 characters. Set by the MCP server from the protocol's handshake, never
 * by a tool's input.
 */
export const ElicitationChannelSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/, {
    message: "expected printable characters",
  });

/** Input of `ask_creator`: the agent and the checkpoint. Nothing of the answer comes from it. */
export const AskCreatorInputSchema = z.strictObject({
  agent: AgentIdSchema.max(64),
  checkpoint: z.string().trim().toUpperCase().pipe(CheckpointIdSchema),
});
export type AskCreatorInput = z.infer<typeof AskCreatorInputSchema>;

/** One option of a decision, as the form shows it. */
export const DecisionPromptOptionSchema = z.strictObject({
  id: ShortIdSchema,
  label: z.string(),
  consequence: z.string(),
  recommended: z.boolean(),
});
export type DecisionPromptOption = z.infer<typeof DecisionPromptOptionSchema>;

/**
 * One answer the creator can give: its identifier in the form (`choice`), the decision it
 * records (with its option for `option_chosen`), whether it is the recommendation, and whether it
 * needs a note (a refusal, a request for changes).
 */
export const DecisionChoiceSchema = z.strictObject({
  id: ShortIdSchema,
  decision: z.enum(CHAT_DECISIONS),
  option: ShortIdSchema.optional(),
  recommended: z.boolean(),
  needs_note: z.boolean(),
});
export type DecisionChoice = z.infer<typeof DecisionChoiceSchema>;

/**
 * The decision object: everything the creator needs to decide, built by the engine from the
 * checkpoint (never by the agent). `external_action` names the irreversible action with an effect
 * outside the product (a deployment, a publication, a message sent, a payment) that an approval
 * lets happen, or is null (the question itself names it; there is no second question
 * and nothing to type or tick: the creator's one answer is their agreement).
 */
export const DecisionPromptSchema = z.strictObject({
  checkpoint: CheckpointIdSchema,
  type: z.enum(CHECKPOINT_TYPES),
  title: z.string(),
  summary: z.string(),
  risk: z.enum(CHECKPOINT_RISKS),
  irreversible: z.boolean(),
  /** The agent that opened the checkpoint (its texts are that agent's), or null. */
  opened_by: z.string().nullable(),
  documents: z.array(CheckpointDocumentSchema),
  options: z.array(DecisionPromptOptionSchema),
  recommendation: ShortIdSchema.nullable(),
  creator_action: CreatorActionRecordSchema.nullable(),
  /** The presentation of a `publication`: angle, audience, short version; else null. */
  publication: PublicationRecordSchema.nullable().optional(),
  choices: z.array(DecisionChoiceSchema).min(1),
  external_action: z.strictObject({ action: z.string() }).nullable(),
});
export type DecisionPrompt = z.infer<typeof DecisionPromptSchema>;

/**
 * `payload` of `checkpoint.elicited`: the creator's answer chosen in the AI tool's form. No quote
 * and no hook proof: the answer reached the engine without the agent. `channel` is the AI tool,
 * `confirmed` is only read from journals written (a box ticked for an
 * irreversible action: the engine writes none any more), `form`
 * the SHA-256 of the decision object shown (canonical JSON). The assurance (`elicitation`) is
 * drawn from the event's type by the projection, never declared.
 *
 * Version 2: `via: "question_tool"` says the creator chose in the AI tool's question
 * tool, not in the form; `proof` is then what the tool's hook recorded (the digest of the
 * questions the engine dictated, and when the creator answered). `via` and `proof` go together.
 */
export const CheckpointElicitedPayloadSchema = z
  .strictObject({
    checkpoint: CheckpointIdSchema,
    decision: z.enum(CHAT_DECISIONS),
    option: ShortIdSchema.optional(),
    note: z.string().trim().min(1).max(MAX_ELICITED_NOTE_LENGTH).optional(),
    source: z.literal("elicitation"),
    channel: ElicitationChannelSchema,
    confirmed: z.literal(true).optional(),
    form: MessageDigestSchema,
    via: QuestionToolViaSchema.optional(),
    proof: QuestionProofSchema.optional(),
  })
  .superRefine((value, context) => {
    if ((value.via !== undefined) !== (value.proof !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["proof"],
        message: "a proof goes with the question tool, and only with it",
      });
    }
    if ((value.decision === "option_chosen") !== (value.option !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["option"],
        message: "an option goes with option_chosen, and only with it",
      });
    }
  });
export type CheckpointElicitedPayload = z.infer<typeof CheckpointElicitedPayloadSchema>;
