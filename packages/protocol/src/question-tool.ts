import { z } from "zod";

/**
 * The AI tool's own question tool: in the VS Code extension of Claude Code the
 * MCP form (elicitation) is refused at once, while the tool's built-in question tool
 * (`AskUserQuestion`: choices to click, up to four questions, shown in the conversation window)
 * works. The engine dictates the exact questions, the agent asks them with the tool, and a hook of
 * the tool (`PostToolUse`, written by `sync`) records the creator's answer in a store of the
 * machine: the engine learns the answer from that record alone, never from the agent.
 */

/** The name of the tool, as Claude Code's hooks and rules name it. */
export const QUESTION_TOOL_NAME = "AskUserQuestion";

/** The tool takes one to four questions in a call. */
export const QUESTION_TOOL_MAX_QUESTIONS = 4;

/** Each question of the tool holds two to four options (the tool adds « Other » itself). */
export const QUESTION_TOOL_MIN_OPTIONS = 2;
export const QUESTION_TOOL_MAX_OPTIONS = 4;

/** The tool's short label above a question: 12 characters at most. */
export const QUESTION_TOOL_HEADER_MAX = 12;

/** The value of `via` for an answer chosen in the question tool. */
export const QUESTION_TOOL_VIA = "question_tool";
export const QuestionToolViaSchema = z.literal(QUESTION_TOOL_VIA);

/**
 * A record of the hook as the journal cites it: the fingerprint of the questions asked (a SHA-256,
 * lowercase hexadecimal) and when it was recorded. The same shape as a message of the chat
 * (`ChatMessageRefSchema`), declared here so that this file imports nothing (`chat.ts` imports it).
 */
const RecordRefSchema = z.strictObject({
  digest: z
    .string()
    .regex(/^[0-9a-f]{64}$/, { message: "expected 64 lowercase hexadecimal characters" }),
  at: z.iso.datetime(),
});

/**
 * What the hook proved of an answer chosen in the question tool, set by the engine only: the
 * digest of the questions the tool asked (the fingerprint the engine dictated) and when the
 * creator's answer was recorded. One record answers once: its reference is cited like a message of
 * the chat (`citedKey`).
 */
export const QuestionProofSchema = z.strictObject({ question: RecordRefSchema });
export type QuestionProof = z.infer<typeof QuestionProofSchema>;

/** One screen of a stack: the proof of its record. A stack of 8 points holds two screens. */
export const QuestionStackProofSchema = z.strictObject({
  questions: z.array(RecordRefSchema).min(1).max(2),
});
export type QuestionStackProof = z.infer<typeof QuestionStackProofSchema>;
