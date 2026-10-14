import { sha256Hex } from "@agentplugged/crypto";
import {
  type ChatDecision,
  type DecisionChoice,
  type DecisionPrompt,
  type ElicitationFallbackReason,
  MAX_ELICITED_NOTE_LENGTH,
  NOTE_REQUIRED,
  type StackPrompt,
} from "@agentplugged/protocol";
import { type ResolvableCheckpoint, resolutionProblem } from "../checkpoints/resolution-rules.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";

/**
 * The decision object of a checkpoint and the reading of the creator's answer to it:
 * what the engine presents itself when the AI tool can show a form (`ask_creator`), and what it
 * accepts back. Built from the checkpoint only, never from anything the agent gives.
 */

/**
 * The fields of the form, the same on every surface: `choice` (one of the decision's choices) in the
 * first question, `note` (the creator's words) in the second, asked only for a refusal or a request
 * for changes (corrections B: approving is one gesture). No confirmation
 * box; the question itself names an irreversible action.
 */
export const DECISION_FORM_FIELDS = {
  choice: "choice",
  note: "note",
} as const;

/** What the AI tool answered to the form, as the surface read it from the protocol. */
export type CreatorReply =
  /** The creator submitted the form: its content, untrusted until `readReply` checked it. */
  | { readonly action: "accept"; readonly content: Readonly<Record<string, unknown>> }
  /**
   * The creator (or the tool on their behalf) refused, or closed the form without a choice.
   * `quick`: the refusal came back before a person could have read the form (the
   * client refuses at once: the VS Code extension of Claude Code), measured by the port that sent it.
   */
  | { readonly action: "decline" | "cancel"; readonly quick?: boolean }
  /**
   * No answer in time, or the tool failed while showing the form. `timedOut`: the port
   * waited only a short probe delay (Cursor, whose form may stay pending without ever showing) and
   * nothing came back.
   */
  | { readonly action: "failed"; readonly timedOut?: true }
  /**
   * Nothing was asked in this exchange: the connection cannot carry the form, or (protocol
   * revision 2026-07-28) the form leaves with the first round of the call, answered at the next.
   */
  | { readonly action: "unavailable" }
  /**
   * A hook of the AI tool could answer the form in the creator's place (Claude Code's
   * `Elicitation` and `ElicitationResult` hooks): the form is never shown.
   */
  | { readonly action: "tool_hook" };

/**
 * The port through which the engine asks the creator itself: given by the MCP server
 * only, and only when its client announced that it shows forms (`elicitation.form`). `channel`
 * is the AI tool, as its MCP client introduced itself.
 */
export interface CreatorPrompt {
  readonly channel: string;
  ask(prompt: DecisionPrompt): Promise<CreatorReply>;
  /**
   * Asks a stack of points in one form, a box per point: the content of an accepted
   * reply holds a boolean for each point shown (`stackField`), read by `readStackReply`.
   */
  askStack?(prompt: StackPrompt): Promise<CreatorReply>;
  /**
   * The second question (corrections B): the note a refusal or a request for changes
   * needs, asked after the creator chose it, in a form of one required field (`note`). A port that
   * cannot chain two forms (the stateless protocol) leaves it out: the engine then asks the agent
   * to collect the note in the chat.
   */
  askNote?(prompt: DecisionPrompt, choice: DecisionChoice): Promise<CreatorReply>;
}

/** The creator's answer read from the form: what `checkpoint.elicited` records. */
export interface ElicitedAnswer {
  readonly decision: ChatDecision;
  readonly option?: string;
  readonly note?: string;
}

/** A value as JSON with its keys sorted: the same digest whatever the keys' order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The gate of a held merge checkpoint (`mergeHold`), or nothing. */
export type MergeHold = Pick<ResolvableCheckpoint, "merge" | "release">;

/** The SHA-256 of the decision object shown (`form` of `checkpoint.elicited`). */
export function formDigest(prompt: DecisionPrompt): string {
  return sha256Hex(canonicalJson(prompt));
}

/** A choice of the form, unless the resolution rules refuse it on this checkpoint. */
function choiceOf(
  checkpoint: CheckpointState,
  merge: MergeHold,
  id: string,
  decision: ChatDecision,
  now: number,
  option?: string,
): DecisionChoice | undefined {
  const needsNote = NOTE_REQUIRED.has(decision);
  // The note is the creator's to type: the rules are asked whether the choice fits, note aside.
  const problem = resolutionProblem(
    { ...checkpoint, ...merge },
    {
      decision,
      ...(option === undefined ? {} : { option }),
      ...(needsNote ? { note: "-" } : {}),
    },
    now,
  );
  if (problem !== undefined) return undefined;
  return {
    id,
    decision,
    ...(option === undefined ? {} : { option }),
    recommended: option !== undefined && option === checkpoint.recommendation,
    needs_note: needsNote,
  };
}

/**
 * The decision object of an open checkpoint: its title, summary, risk, documents, options with
 * their consequence and the recommendation, the creator's action it asks for, the
 * choices the creator may click, and the irreversible action the question names. Choices: each option
 * then « none, ask for changes » for a checkpoint with options; approve, refuse or ask for
 * changes for a creator's action; approve or ask for changes otherwise. Only the choices the
 * resolution rules accept are offered (`merge`: the gate of a held merge checkpoint).
 * `risk` is the risk the creator decides on: for a creator's action, the higher of the request's
 * and the one it has now.
 */
export function decisionPrompt(
  checkpoint: CheckpointState,
  now: number,
  merge: MergeHold = {},
  risk: DecisionPrompt["risk"] = checkpoint.risk,
): DecisionPrompt {
  const options = checkpoint.options ?? [];
  const action = checkpoint.creator_action ?? null;
  const candidates: (DecisionChoice | undefined)[] =
    options.length > 0
      ? [
          ...options.map((option, index) =>
            choiceOf(checkpoint, merge, `option-${index + 1}`, "option_chosen", now, option.id),
          ),
          choiceOf(checkpoint, merge, "changes", "changes_requested", now),
        ]
      : action !== null || checkpoint.type === "publication"
        ? [
            choiceOf(checkpoint, merge, "approve", "approved", now),
            choiceOf(checkpoint, merge, "reject", "rejected", now),
            choiceOf(checkpoint, merge, "changes", "changes_requested", now),
          ]
        : [
            choiceOf(checkpoint, merge, "approve", "approved", now),
            choiceOf(checkpoint, merge, "changes", "changes_requested", now),
          ];
  return {
    checkpoint: checkpoint.id,
    type: checkpoint.type,
    title: checkpoint.title,
    summary: checkpoint.summary,
    risk,
    irreversible: checkpoint.irreversible,
    opened_by: checkpoint.opened_by,
    documents: checkpoint.documents.map((document) => ({ ...document })),
    options: options.map((option) => ({
      id: option.id,
      label: option.label,
      consequence: option.consequence,
      recommended: option.id === checkpoint.recommendation,
    })),
    recommendation: checkpoint.recommendation,
    creator_action: action === null ? null : (JSON.parse(JSON.stringify(action)) as never),
    publication: checkpoint.publication ? { ...checkpoint.publication } : null,
    choices: candidates.filter((choice): choice is DecisionChoice => choice !== undefined),
    external_action: checkpoint.irreversible ? { action: checkpoint.title } : null,
  };
}

/**
 * The first reply (the creator's choice) completed with the note of the second question: the
 * content `readReply` reads. Anything but an accepted note is the second question's own reply,
 * read as it is (a refusal to answer is a refusal, nothing is recorded).
 */
export function withNote(
  first: Extract<CreatorReply, { action: "accept" }>,
  second: CreatorReply,
): CreatorReply {
  if (second.action !== "accept") return second;
  return {
    action: "accept",
    content: {
      ...first.content,
      [DECISION_FORM_FIELDS.note]: second.content[DECISION_FORM_FIELDS.note],
    },
  };
}

/** The creator's note, or undefined: a string of at most 2000 characters, once trimmed. */
function noteOf(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return null;
  const note = value.trim();
  if (note === "") return undefined;
  if (note.length <= MAX_ELICITED_NOTE_LENGTH) return note;
  // The form counts characters as code points, the journal as UTF-16 units: a note the form
  // accepted is cut, never lost, and never split in the middle of a character.
  let cut = "";
  for (const character of note) {
    if (cut.length + character.length > MAX_ELICITED_NOTE_LENGTH) break;
    cut += character;
  }
  return cut.trimEnd();
}

/**
 * The creator's answer read from the form's content, or why nothing can be recorded. Only a
 * choice the decision object offered counts; a refusal or a request for changes needs a note.
 * Anything else is `invalid`: never a choice guessed, never a default taken.
 */
export function readReply(
  prompt: DecisionPrompt,
  reply: CreatorReply,
): ElicitedAnswer | ElicitationFallbackReason {
  if (reply.action === "decline") return "declined";
  if (reply.action === "cancel") return "cancelled";
  if (reply.action === "unavailable") return "unavailable";
  if (reply.action === "tool_hook") return "tool_hook";
  if (reply.action !== "accept") return "failed";
  const content = reply.content;
  const picked = content[DECISION_FORM_FIELDS.choice];
  const choice =
    typeof picked === "string" ? prompt.choices.find((entry) => entry.id === picked) : undefined;
  if (choice === undefined) return "invalid";
  const note = noteOf(content[DECISION_FORM_FIELDS.note]);
  if (note === null) return "invalid";
  if (choice.needs_note && note === undefined) return "note_required";
  return {
    decision: choice.decision,
    ...(choice.option === undefined ? {} : { option: choice.option }),
    ...(note === undefined ? {} : { note }),
  };
}
