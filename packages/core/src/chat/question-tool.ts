import { sha256Hex } from "@agentplugged/crypto";
import {
  CHAT_RETENTION_MS,
  type ChatMessageRef,
  type DecisionPrompt,
  type ElicitationFallbackReason,
  QUESTION_TOOL_HEADER_MAX,
  QUESTION_TOOL_MAX_OPTIONS,
  QUESTION_TOOL_MAX_QUESTIONS,
  QUESTION_TOOL_MIN_OPTIONS,
  type StackPrompt,
} from "@agentplugged/protocol";
import { citedKey } from "./chat-proof.js";
import { canonicalJson, type ElicitedAnswer, formDigest, readReply } from "./decision-prompt.js";

/**
 * The AI tool's question tool as a channel of the engine's decisions. The
 * engine dictates the exact questions (`QuestionScreen`) and keeps their fingerprint; the agent asks
 * them with the tool; a hook of the tool (written by `sync`) records the creator's answer in a store
 * of the machine (`DecisionRecord`), and the engine reads the answer from that record alone. Pure
 * rules and the per-session memory of what was dictated: no input/output here.
 */

/** One option of a question, as the tool shows it. */
export interface ToolOption {
  readonly label: string;
  readonly description: string;
}

/** One question, exactly as the tool receives it (`questions[]` of the tool's input). */
export interface ToolQuestion {
  readonly question: string;
  readonly header: string;
  readonly multiSelect: boolean;
  readonly options: readonly ToolOption[];
}

/**
 * How the engine reads the answer to the question at the same index:
 * - `choice`: one of the decision's choices, by the label of the option clicked (one
 *   question, one click, whatever the risk: there is no confirmation question);
 * - `point`: one point of a stack (`yes` approves it, the other option leaves it open).
 */
export type QuestionReader =
  | {
      readonly kind: "choice";
      readonly choices: readonly { readonly label: string; readonly choice: string }[];
    }
  | { readonly kind: "point"; readonly n: number; readonly yes: string };

/** The questions of one screen (one call of the tool) and how to read their answers. */
export interface QuestionScreen {
  readonly questions: readonly ToolQuestion[];
  readonly readers: readonly QuestionReader[];
}

/**
 * What the engine gets to render its decisions in the question tool: given by the MCP server only
 * (it holds the creator's language), and only when the AI tool has the question tool in this session.
 */
export interface QuestionToolAccess {
  /** The AI tool has the question tool here (Claude Code in a session with a person at it). */
  readonly available: boolean;
  /** The questions of one decision, or undefined when it has more choices than the tool shows. */
  render(prompt: DecisionPrompt): QuestionScreen | undefined;
  /** The screens of a stack, four points at most each, in order. */
  renderStack(prompt: StackPrompt): readonly QuestionScreen[];
}

/**
 * One answer the tool's hook recorded: the questions' fingerprint (the digest of the questions the
 * tool was asked, as the hook computes it), the answers by question, and when it was recorded.
 */
export interface DecisionRecord {
  readonly session: string;
  readonly project?: string;
  /** When the hook recorded it (ISO 8601, UTC). */
  readonly at: string;
  readonly fingerprint: string;
  /**
   * True when the tool was given fields the fingerprint does not cover (a `preview`, a `kind`…): the
   * creator may have seen more than the engine dictated, so the record is never read.
   */
  readonly extra?: true;
  readonly answers: readonly {
    readonly question: string;
    readonly answer: string;
    readonly notes?: string;
  }[];
}

/**
 * Port through which the engine reads the creator's answers to the question tool of one session: the
 * store the hook writes (`~/.agentplugged/chat/`). Read only: nothing in the engine writes it, and
 * no MCP tool reaches it.
 */
export interface DecisionLog {
  records(session: string): Promise<readonly DecisionRecord[]>;
}

/* ------------------------------------------------------------------------------------------ */
/* The fingerprint                                                                            */
/* ------------------------------------------------------------------------------------------ */

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * The questions of the tool's input as the fingerprint sees them: only the fields the tool shows
 * (question, header, whether several can be ticked, each option's label and description), whatever
 * else the tool's input carries. Undefined when `questions` is not a list of one to four. The hook's
 * script computes the same (`DECISION_HOOK_HELPERS`); a test runs the script against this.
 */
export function normalizeToolQuestions(raw: unknown): ToolQuestion[] | undefined {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > QUESTION_TOOL_MAX_QUESTIONS) {
    return undefined;
  }
  return raw.map((entry): ToolQuestion => {
    const question = (typeof entry === "object" && entry !== null ? entry : {}) as Record<
      string,
      unknown
    >;
    const options = Array.isArray(question.options) ? question.options : [];
    return {
      question: text(question.question),
      header: text(question.header),
      multiSelect: question.multiSelect === true,
      options: options.map((option) => {
        const value = (typeof option === "object" && option !== null ? option : {}) as Record<
          string,
          unknown
        >;
        return { label: text(value.label), description: text(value.description) };
      }),
    };
  });
}

/** The fingerprint of questions: the SHA-256 of their canonical JSON. */
export function questionsDigest(questions: readonly ToolQuestion[]): string {
  return sha256Hex(canonicalJson(normalizeToolQuestions(questions) ?? []));
}

/**
 * Why a screen cannot be shown by the tool, or undefined: one to four questions, each with two to
 * four options (the tool adds « Other » itself), a header of at most 12 characters, nothing empty,
 * no question twice (the answers are keyed by the question's text), no label twice in a question,
 * as many readers as questions. `too_many_…` says there are more than the tool shows: the decision
 * goes to the chat (`screenFallback`).
 */
export function screenProblem(screen: QuestionScreen): string | undefined {
  const { questions, readers } = screen;
  if (questions.length > QUESTION_TOOL_MAX_QUESTIONS) return "too_many_questions";
  if (questions.length < 1) return "questions";
  if (readers.length !== questions.length) return "readers";
  const seen = new Set<string>();
  for (const question of questions) {
    if (question.question.trim() === "" || seen.has(question.question)) return "question";
    seen.add(question.question);
    if (question.header.trim() === "" || [...question.header].length > QUESTION_TOOL_HEADER_MAX) {
      return "header";
    }
    if (question.options.length > QUESTION_TOOL_MAX_OPTIONS) return "too_many_options";
    if (question.options.length < QUESTION_TOOL_MIN_OPTIONS) return "too_few_options";
    const labels = new Set(question.options.map((option) => option.label));
    if (
      labels.size !== question.options.length ||
      [...labels].some((label) => label.trim() === "")
    ) {
      return "labels";
    }
  }
  return undefined;
}

/**
 * The reason `ask_creator` gives when a screen cannot be shown: `too_many_choices` when the tool
 * shows fewer than the decision has, else `no_choice` (too few options, a label twice…).
 */
export function screenFallback(problem: string): "too_many_choices" | "no_choice" {
  return problem.startsWith("too_many") ? "too_many_choices" : "no_choice";
}

/* ------------------------------------------------------------------------------------------ */
/* What was dictated, by session                                                              */
/* ------------------------------------------------------------------------------------------ */

/** The questions the engine dictated for one checkpoint in a session. */
export interface Dictation {
  /** How many times the engine dictated these questions in the session (an agent cannot ask for ever). */
  readonly count?: number;
  readonly fingerprint: string;
  /** The digest of the decision object they were built from (`formDigest`). */
  readonly form: string;
  /** When they were dictated (milliseconds): no answer recorded before counts. */
  readonly at: number;
  readonly screen: QuestionScreen;
}

/** The screens the engine dictated for one stack in a session. */
export interface StackDictation {
  readonly count?: number;
  /** The digest of the stack's prompt (`stackPromptDigest`). */
  readonly form: string;
  readonly at: number;
  readonly screens: readonly (QuestionScreen & { readonly fingerprint: string })[];
  /** The points each screen asks, by number (`n`) and checkpoint. */
  readonly items: readonly { readonly n: number; readonly checkpoint: string }[];
}

const dictations = new WeakMap<object, Map<string, Dictation>>();
const stackDictations = new WeakMap<object, Map<string, StackDictation>>();

/** At most this many dictations of the same questions in a session: then the chat takes over. */
export const MAX_DICTATIONS = 3;

/** Remembers what was dictated for a checkpoint; the first dictation of the same questions stays. */
export function noteDictation(session: object, checkpoint: string, dictation: Dictation): void {
  const map = dictations.get(session) ?? new Map<string, Dictation>();
  const known = map.get(checkpoint);
  // The same questions again (the agent asked twice): the first time stays, so an answer given
  // between the two still counts, and the count goes up. Other questions (the point changed)
  // replace them.
  if (known === undefined || known.fingerprint !== dictation.fingerprint) {
    map.set(checkpoint, { ...dictation, count: 1 });
  } else {
    map.set(checkpoint, { ...known, count: (known.count ?? 1) + 1 });
  }
  dictations.set(session, map);
}

/** What was dictated for a checkpoint in this session, or undefined. */
export function dictationOf(session: object, checkpoint: string): Dictation | undefined {
  return dictations.get(session)?.get(checkpoint);
}

/** Remembers what was dictated for a stack (one entry per stack: the same rule as a checkpoint). */
export function noteStackDictation(session: object, stack: string, value: StackDictation): void {
  const map = stackDictations.get(session) ?? new Map<string, StackDictation>();
  const known = map.get(stack);
  if (known === undefined || known.form !== value.form) map.set(stack, { ...value, count: 1 });
  else map.set(stack, { ...known, count: (known.count ?? 1) + 1 });
  stackDictations.set(session, map);
}

/**
 * The records the engine read and could not turn into a choice (the creator's own words, a request
 * for changes without a note, every point left open), by session:
 * the next call reads the next record, so the creator's second click is not lost behind the first.
 * Lost with the process, like the dictations.
 */
const refused = new WeakMap<object, Set<string>>();

/** Notes a record as read and refused: it is not read again in this session. */
export function noteRefused(session: object, record: DecisionRecord): void {
  const set = refused.get(session) ?? new Set<string>();
  set.add(citedKey(refOfRecord(record)));
  refused.set(session, set);
}

/** The keys of the records read and refused in this session (`citedKey`). */
export function refusedKeys(session: object): ReadonlySet<string> {
  return refused.get(session) ?? new Set<string>();
}

export function stackDictationOf(session: object, stack: string): StackDictation | undefined {
  return stackDictations.get(session)?.get(stack);
}

/* ------------------------------------------------------------------------------------------ */
/* Reading the records                                                                        */
/* ------------------------------------------------------------------------------------------ */

/** Why no record can be used: none, only older than the dictation, or all already cited. */
export type RecordRefusal = "no_answer" | "before_dictation" | "already_cited" | "question_extra";

/**
 * The records of `fingerprint` that answer a dictation: recorded after it (milliseconds), at most
 * `CHAT_RETENTION_MS` before `now`, and not cited by an answer already accepted (`cited`,
 * `citedKey`). Oldest first: the earliest answer to a question is the creator's.
 */
export function freeRecords(
  records: readonly DecisionRecord[],
  fingerprint: string,
  options: { readonly after: number; readonly now: number; readonly cited: ReadonlySet<string> },
): readonly DecisionRecord[] | RecordRefusal {
  const same = records
    .filter((record) => record.fingerprint === fingerprint)
    .filter((record) => {
      const at = Date.parse(record.at);
      return !Number.isNaN(at) && at <= options.now && options.now - at <= CHAT_RETENTION_MS;
    });
  if (same.length === 0) return "no_answer";
  // Fields the fingerprint does not cover were given to the tool: the creator may have seen more
  // than the engine dictated.
  const plain = same.filter((record) => record.extra !== true);
  if (plain.length === 0) return "question_extra";
  const after = plain.filter((record) => Date.parse(record.at) > options.after);
  if (after.length === 0) return "before_dictation";
  const free = after.filter((record) => !options.cited.has(citedKey(refOfRecord(record))));
  if (free.length === 0) return "already_cited";
  return [...free].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** A record as cited in the journal: its fingerprint and date. */
export const refOfRecord = (record: DecisionRecord): ChatMessageRef => ({
  digest: record.fingerprint,
  at: record.at,
});

/** The creator's answer to a question of a record, or undefined. */
function answerTo(record: DecisionRecord, question: ToolQuestion) {
  return record.answers.find((entry) => entry.question === question.question);
}

/** What a record says of a decision, or why nothing can be recorded. */
export type ToolReading =
  | { readonly ok: true; readonly answer: ElicitedAnswer }
  | {
      readonly ok: false;
      readonly reason: ElicitationFallbackReason;
      /** The creator's own words when they typed their own answer (« Other »), cut to 500. */
      readonly words?: string;
    };

/** The longest words of the creator the engine hands back to the agent. */
const WORDS_MAX = 500;

/**
 * The creator's answer read from a record of a dictated decision. Only a label of the options the
 * engine dictated counts as a choice (an answer typed in the tool's « Other » field is the creator's
 * words, never a choice: `invalid`); a refusal or a request for changes needs a note (the tool's
 * note of the option, when it gives one): the same rules as the form (`readReply`).
 */
export function readToolAnswer(
  prompt: DecisionPrompt,
  screen: QuestionScreen,
  record: DecisionRecord,
): ToolReading {
  const [first] = screen.questions;
  const [choiceReader] = screen.readers;
  if (first === undefined || choiceReader?.kind !== "choice") {
    return { ok: false, reason: "invalid" };
  }
  const given = answerTo(record, first);
  const picked = choiceReader.choices.find((entry) => entry.label === given?.answer);
  if (picked === undefined) {
    const words = given?.answer.trim() ?? "";
    return {
      ok: false,
      reason: "invalid",
      ...(words === "" ? {} : { words: [...words].slice(0, WORDS_MAX).join("") }),
    };
  }
  const reply = readReply(prompt, {
    action: "accept",
    content: {
      choice: picked.choice,
      ...(given?.notes === undefined ? {} : { note: given.notes }),
    },
  });
  if (typeof reply === "string") return { ok: false, reason: reply };
  return { ok: true, answer: reply };
}

/** The digest of the decision object a dictation was built from. */
export const dictationForm = (prompt: DecisionPrompt): string => formDigest(prompt);

/**
 * The points of a stack screen the creator approved in a record: the number of each question whose
 * answer is the label that approves it. Anything else (the other option, an answer typed in
 * « Other », no answer) leaves the point open.
 */
export function readStackScreen(screen: QuestionScreen, record: DecisionRecord): number[] {
  const approved: number[] = [];
  screen.questions.forEach((question, index) => {
    const reader = screen.readers[index];
    if (reader?.kind !== "point") return;
    if (answerTo(record, question)?.answer === reader.yes) approved.push(reader.n);
  });
  return approved.sort((a, b) => a - b);
}
