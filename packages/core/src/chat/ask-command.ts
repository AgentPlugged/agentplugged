import {
  AskCreatorInputSchema,
  CHAT_DECISIONS,
  type CheckpointRisk,
  contentSize,
  type DecisionPrompt,
  ELICITATION_EVENT_TYPES,
  ElicitationChannelSchema,
  type ElicitationFallbackReason,
  ErrorCode,
  FORM_CONTENT_MAX_CHARS,
  MAX_ELICITED_NOTE_LENGTH,
  MessageDigestSchema,
  type MethodConfig,
  type ProjectionState,
  QUESTION_TOOL_NAME,
  QUESTION_TOOL_VIA,
  type QuestionProof,
  QuestionProofSchema,
  type QuestionToolAnswerInput,
  QuestionToolViaSchema,
  type ValidationMode,
} from "@agentplugged/protocol";
import { z } from "zod";
import {
  agentEventCommand,
  agentWriteContext,
  defined,
  type EventSpec,
  invalidInput,
  planned,
  project,
  type RecordedEvent,
} from "../agent-activity/agent-commands.js";
import {
  answerable,
  CREATOR_ACTION_DECISIONS,
  resolutionProblem,
  statusAt,
} from "../checkpoints/resolution-rules.js";
import { mergeHold } from "../ci/ci-rules.js";
import { type CommandContext, type CommandResult, defineCommand, fail, ok } from "../command.js";
import {
  type ActionExecuted,
  currentRisk,
  executionEvent,
  executionProblem,
  executionStateProblem,
  higherRisk,
} from "../creator-actions/creator-action-execution.js";
import { isEngineUpdatePoint } from "../engine-update.js";
import { AgentPluggedError } from "../errors.js";
import {
  type MergeDone,
  type MergeResult,
  mergedEvent,
  mergeFailed,
  mergeStory,
  mergesOn,
  notePendingMerge,
  notRecorded,
  pendingMergeOf,
  takePendingMerge,
} from "../merge/story-merge.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { checkpointsOf } from "../projection/checkpoint-reducers.js";
import { mergeHead } from "../review/merge-head.js";
import { finishAnswer } from "./answer-finish.js";
import { decisionChannels } from "./channels.js";
import { proofSessionOf, sameProject } from "./chat-proof.js";
import {
  DECISION_FORM_FIELDS,
  decisionPrompt,
  type ElicitedAnswer,
  formDigest,
  readReply,
  withNote,
} from "./decision-prompt.js";
import { askOnce, noteFormReply } from "./form-session.js";
import {
  type DecisionRecord,
  dictationOf,
  freeRecords,
  MAX_DICTATIONS,
  noteDictation,
  noteRefused,
  type QuestionToolAccess,
  questionsDigest,
  readToolAnswer,
  refOfRecord,
  refusedKeys,
  screenFallback,
  screenProblem,
  type ToolQuestion,
} from "./question-tool.js";
import { reviewRequired } from "./review-rules.js";
import { resolveValidationSettings } from "./validation-settings.js";

/**
 * `ask_creator`: the engine presents an open checkpoint to the creator itself,
 * in the AI tool's form (the MCP protocol's elicitation), and records the answer the creator
 * clicked without it passing through the agent. Without a form, or without a choice, nothing is
 * written and the agent asks in the chat (`answer_checkpoint`).
 */

/** The internal input of the write: the answer as the engine read it, never the agent's input. */
const ElicitedInputSchema = z.strictObject({
  agent: z.string(),
  checkpoint: z.string(),
  answer: z.strictObject({
    decision: z.enum(CHAT_DECISIONS),
    option: z.string().optional(),
    note: z.string().max(MAX_ELICITED_NOTE_LENGTH).optional(),
  }),
  channel: ElicitationChannelSchema,
  form: MessageDigestSchema,
  via: QuestionToolViaSchema.optional(),
  proof: QuestionProofSchema.optional(),
});
type ElicitedInput = z.infer<typeof ElicitedInputSchema>;

/**
 * The AI tool's name as the form's channel: its printable characters, at most 64, or `mcp-client`
 * when it gave none (the MCP client's own word, recorded as information, never as a proof).
 */
export function channelOf(name: string | undefined): string {
  const clean = (name ?? "")
    .replace(/[^\x20-\x7e]/g, "")
    .trim()
    .slice(0, 64)
    .trim();
  return clean === "" ? "mcp-client" : clean;
}

/** What the write reads before the journal lock: the level, and for a creator's action its risk. */
interface ElicitedPrepared {
  readonly mode: ValidationMode;
  /** A creator's action: its risk now; the higher of it and the request's counts. */
  readonly risk?: CheckpointRisk;
  /** An approval of a creator's action: why it cannot be carried out now, or null. */
  readonly execution?: AgentPluggedError | null;
  /** The head of the story's branch, for its merge checkpoint, when Git reads it. */
  readonly head?: string;
  /** An approval of a story's merge checkpoint: the merge done, or why not. */
  readonly merge?: MergeDone | AgentPluggedError;
}

function notFound(id: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.CHECKPOINT_NOT_FOUND, "error.checkpoint_not_found", {
    checkpoint: id,
  });
}

function notOpen(checkpoint: CheckpointState, now: number): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.CHECKPOINT_NOT_OPEN, "error.checkpoint_not_open", {
    checkpoint: checkpoint.id,
    status: statusAt(checkpoint, now),
  });
}

/**
 * Why the form is never offered on this checkpoint, or undefined: unknown (`CHECKPOINT_NOT_FOUND`),
 * not waiting for an answer (`CHECKPOINT_NOT_OPEN`), or a high risk at the `strict` level, the
 * creator's action's risk now counting when higher (`REVIEW_REQUIRED`: the terminal, `strict` only).
 */
function askProblem(
  id: string,
  state: ProjectionState["state"],
  mode: ValidationMode,
  risk: CheckpointRisk | undefined,
  now: number,
): AgentPluggedError | undefined {
  const checkpoints = checkpointsOf(state);
  if (!Object.hasOwn(checkpoints, id)) return notFound(id);
  const checkpoint = checkpoints[id] as CheckpointState;
  if (!answerable(checkpoint, now)) return notOpen(checkpoint, now);
  const action = checkpoint.creator_action ?? undefined;
  const level =
    action !== undefined && risk !== undefined
      ? higherRisk(checkpoint.risk, risk)
      : checkpoint.risk;
  if (mode === "strict" && level === "high") return reviewRequired(checkpoint, "strict_high_risk");
  return undefined;
}

/**
 * True for a checkpoint the form never answers: the permission point of an installation whose request
 * the point keeps cut (500 characters). The end of a long line could hide what
 * it does: it is read whole in the chat. Nothing a session has read changes what a form answers
 *.
 */
export function formBlocked(checkpoint: CheckpointState): boolean {
  return (
    checkpoint.source === "untrusted_action" && (checkpoint.request?.detail.length ?? 0) >= 500
  );
}

/**
 * The forms open in this process, by session (one MCP server's), and the checkpoints they ask:
 * one form at a time per session, never two forms for one checkpoint.
 */
const openForms = new WeakSet<object>();
const askedCheckpoints = new Set<string>();
/**
 * The checkpoints whose form the creator declined or closed, by session: never asked again in a
 * form there (the creator answers in the chat), so an agent cannot ask until they click.
 */
const dismissed = new WeakMap<object, Set<string>>();

/**
 * The events of an answer clicked in the form, on the state as it is when written: the checkpoint
 * still waits for an answer, the level still lets it be answered there, the answer still fits
 * (the merge gate, a creator's action's decisions); an approved creator's action is carried out in
 * the same write. One click is the whole answer, whatever the risk.
 */
function elicitedPlan(
  input: ElicitedInput,
  state: ProjectionState["state"],
  prepared: ElicitedPrepared,
  now: number,
  /** `dry`: everything but the merge of an approved story (checked before the forge merges). */
  options: { readonly dry?: boolean } = {},
): EventSpec[] | AgentPluggedError {
  const refused = askProblem(input.checkpoint, state, prepared.mode, prepared.risk, now);
  if (refused !== undefined) return refused;
  const checkpoint = checkpointsOf(state)[input.checkpoint] as CheckpointState;
  const { answer } = input;
  const action = checkpoint.creator_action ?? undefined;
  if (action !== undefined && !CREATOR_ACTION_DECISIONS.has(answer.decision)) {
    return invalidInput(
      "ask_creator",
      new z.ZodError([
        { code: "custom", path: ["decision"], message: "not a creator's action's decision" },
      ]),
    );
  }
  const problem = resolutionProblem(
    {
      ...checkpoint,
      ...mergeHold(state, checkpoint, prepared.head === undefined ? {} : { head: prepared.head }),
    },
    {
      decision: answer.decision,
      ...(answer.option === undefined ? {} : { option: answer.option }),
      ...(answer.note === undefined ? {} : { note: answer.note }),
    },
    now,
  );
  if (problem !== undefined) return problem;
  const elicited: EventSpec = {
    type: ELICITATION_EVENT_TYPES.answered,
    story: checkpoint.story ?? undefined,
    payload: defined({
      checkpoint: checkpoint.id,
      decision: answer.decision,
      option: answer.option,
      note: answer.note,
      source: "elicitation",
      channel: input.channel,
      form: input.form,
      via: input.via,
      proof: input.proof,
    }),
  };
  // An approved story's merge checkpoint: merged at the forge before this write.
  if (mergesOn(checkpoint, answer.decision)) {
    if (options.dry === true) return [elicited];
    const merge =
      prepared.merge ??
      mergeFailed(checkpoint.story ?? "", checkpoint.id, "forge_failed", {
        message: "the merge was not prepared",
      });
    if (merge instanceof AgentPluggedError) return merge;
    return [elicited, mergedEvent(merge, "elicitation")];
  }
  if (action === undefined || answer.decision !== "approved") return [elicited];
  const blocked = executionStateProblem(action, state) ?? prepared.execution ?? undefined;
  if (blocked !== undefined) return blocked;
  return [elicited, executionEvent(checkpoint.id, action, "elicitation")];
}

/** The level, and a creator's action's risk now, read before the journal lock. */
async function readLevel(
  context: CommandContext,
  config: MethodConfig,
  state: ProjectionState["state"],
  id: string,
): Promise<Pick<ElicitedPrepared, "mode" | "risk">> {
  const settings = await resolveValidationSettings(config, context.mainBranch);
  const record = checkpointsOf(state)[id]?.creator_action ?? undefined;
  return {
    mode: settings.mode,
    ...(record === undefined ? {} : { risk: await currentRisk(context, state, record) }),
  };
}

/**
 * The write of an answer clicked in the form (internal: never a tool of its own). Written as the
 * agent that asked (`actor.kind: agent`), signed by the machine key, with `source: elicitation`;
 * planned again under the journal lock, so nothing is written when the checkpoint was answered
 * meanwhile.
 */
const elicitedEvents = agentEventCommand<typeof ElicitedInputSchema, ElicitedPrepared>({
  name: "ask_creator",
  description: "Records the answer the creator chose in the AI tool's form (internal).",
  inputSchema: ElicitedInputSchema,
  needsState: () => true,
  replanned: true,
  async prepare(input, context, _agents, config): Promise<ElicitedPrepared> {
    const journal = context.journal;
    // A pull request the creator already merged on the forge is recorded first (dynamic import: no cycle).
    await (await import("../merge/forge-follow.js")).followForge(context, { force: true });
    const state =
      journal === undefined ? {} : (await project(context, config, await journal.list())).state;
    const read = await readLevel(context, config, state, input.checkpoint);
    const checkpoint = checkpointsOf(state)[input.checkpoint];
    const head = await mergeHead(context, state, checkpoint);
    const level: ElicitedPrepared = head === undefined ? read : { ...read, head };
    // An approval of a story's merge checkpoint: once everything else allows it, the
    // engine merges at the forge; the write follows.
    if (checkpoint !== undefined && mergesOn(checkpoint, input.answer.decision)) {
      const plan = elicitedPlan(input, state, level, (context.now ?? Date.now)(), { dry: true });
      if (plan instanceof AgentPluggedError) return { ...level, merge: plan };
      const merge =
        pendingMergeOf(checkpoint.id, context.mergeToken) ??
        (await mergeStory(context, config, state, checkpoint, head));
      if (!(merge instanceof AgentPluggedError)) notePendingMerge(merge, context.mergeToken);
      return { ...level, merge };
    }
    const record = checkpoint?.creator_action ?? undefined;
    if (checkpoint === undefined || record === undefined || input.answer.decision !== "approved") {
      return level;
    }
    // What lies outside the journal (the branch's head, the files) is checked before the write.
    return {
      ...level,
      execution: (await executionProblem(context, state, checkpoint.id, record)) ?? null,
    };
  },
  ...planned(elicitedPlan),
});

/**
 * The AI tool's question tool as the channel of this call: the questions the engine
 * dictates, which the agent asks with the tool exactly as given. The creator's click is read by the
 * engine from the tool's hook (`answer_checkpoint` with `via: "question_tool"`), never from the agent.
 */
export interface QuestionToolDictation {
  readonly checkpoint: string;
  readonly asked: false;
  readonly answered: false;
  /** Why the form was not used: it cannot be shown here (`unavailable`), or the client refused it. */
  readonly reason: ElicitationFallbackReason;
  readonly channel: "question_tool";
  readonly via: "question_tool";
  /** The tool to ask them with. */
  readonly tool: typeof QUESTION_TOOL_NAME;
  /** The digest of the questions the engine dictated: a record of other questions proves nothing. */
  readonly fingerprint: string;
  /** The `questions` of the tool's input, word for word: never reworded, never completed. */
  readonly questions: readonly ToolQuestion[];
  /** What to do once the creator answered in the tool. */
  readonly next_step: string;
}

/** What `ask_creator` returns. */
export type AskCreatorResult =
  /**
   * Nothing recorded: the checkpoint stays open, and the agent asks in the chat
   * (`channel: "chat"`). `asked` says whether the form was shown.
   */
  | {
      readonly checkpoint: string;
      readonly asked: boolean;
      readonly answered: false;
      readonly reason: ElicitationFallbackReason;
      readonly channel: "chat";
      /** A deliverable's presentation to show in the chat, as recorded. */
      readonly presentation?: {
        readonly title: string;
        readonly angle: string;
        readonly audience: string;
        readonly short_version: string;
        readonly full_text_command: string;
      };
    }
  /** The questions to ask with the AI tool's question tool. */
  | QuestionToolDictation
  /** The creator's answer, recorded: what they chose, and the action carried out. */
  | Recorded;

/** The creator's answer, recorded (a form's click, or a question tool's answer proved by its hook). */
export type Recorded = RecordedEvent & {
  readonly checkpoint: string;
  readonly asked: true;
  readonly answered: true;
  readonly channel: "elicitation" | "question_tool";
  readonly tool: string;
  readonly decision: ElicitedAnswer["decision"];
  readonly option?: string;
  readonly note?: string;
  readonly executed?: ActionExecuted;
  /** The story the engine merged once its merge checkpoint was approved. */
  readonly merged?: MergeResult;
};

/** The checkpoint's decision object as the creator is asked it: facts the engine reads once. */
async function promptOf(
  context: CommandContext,
  state: ProjectionState["state"],
  checkpoint: CheckpointState,
  level: Pick<ElicitedPrepared, "mode" | "risk">,
  now: number,
): Promise<DecisionPrompt> {
  const record = checkpoint.creator_action ?? undefined;
  const risk =
    record !== undefined && level.risk !== undefined
      ? higherRisk(checkpoint.risk, level.risk)
      : checkpoint.risk;
  const head = await mergeHead(context, state, checkpoint);
  return decisionPrompt(
    checkpoint,
    now,
    mergeHold(state, checkpoint, head === undefined ? {} : { head }),
    risk,
  );
}

/**
 * `ask_creator`: checks the checkpoint can be answered there (open, not a high risk
 * at the `strict` level), builds its decision object, asks the creator through the MCP server's
 * form (outside the journal lock), reads the answer, then writes it (`checkpoint.elicited`). The
 * agent gives the checkpoint only: never the choice, the note, the confirmation nor the channel.
 *
 * The engine does not guess the channel. It uses, in this order, the form (unless the
 * client refused one at once in this session), then the AI tool's question tool (it dictates the
 * questions; the answer is read from the tool's hook by `answer_checkpoint` with `via:
 * "question_tool"`), then the chat. A form the client refuses at once is remembered for the session,
 * and the questions are dictated in the same call instead of a failure.
 */
export const askCreatorCommand = defineCommand<AskCreatorResult>({
  name: "ask_creator",
  audience: "agent",
  description:
    'Ask the creator to decide an open checkpoint the way the AI tool lets them answer with a click, instead of asking in text: call it right after the checkpoint is open (open_checkpoint, request_creator_action, or one listed in `decisions` of `next`). The engine builds the question (summary, options with their consequence, your recommendation marked, risk; approve or ask for changes for a document or a phase end; for an action with an effect outside the product that cannot be undone, the question names the action itself) and picks the channel itself. One question, one answer, whatever the risk: approving or choosing an option records at once with no note; only a refusal or a request for changes asks the creator for a note, in a second question of the same form. Either the tool\'s form: the creator\'s click is recorded with no quote and you get `answered: true` with the decision (`approved`, `option_chosen` and `option`, `changes_requested` and the creator\'s `note`…): tell the creator in one line what was recorded and never ask the same question again. Or `channel: "question_tool"`: the exact `questions` to ask with the AskUserQuestion tool, word for word, in ONE call, nothing added; once the creator answered, call answer_checkpoint with `via: "question_tool"` and `session` (no quote, no decision). Or `answered: false` and `channel: "chat"`: nothing was recorded, the checkpoint stays open; ask in the chat as usual and record the answer with `answer_checkpoint`; for a `publication` (a deliverable), that result also carries `presentation` (title, angle, audience, short_version, full_text_command): show them to the creator exactly as recorded, in that order, then the command for the full text. `REVIEW_REQUIRED` only comes at the `strict` level (a high risk): the creator then answers at the terminal, with the command it gives.',
  inputSchema: AskCreatorInputSchema,
  // The form of the point of the engine's update.
  allowsOlderEngine: (context, input) => isEngineUpdatePoint(context, input.checkpoint),
  async run(context, input) {
    const parsed = AskCreatorInputSchema.safeParse(input);
    if (!parsed.success) return fail(invalidInput("ask_creator", parsed.error));
    const { agent, checkpoint: id } = parsed.data;
    const target = await agentWriteContext(context, agent);
    if (target instanceof AgentPluggedError) return fail(target);
    const now = (context.now ?? Date.now)();
    const state = (await project(context, target.config, await target.journal.list())).state;
    const level = await readLevel(context, target.config, state, id);
    const refused = askProblem(id, state, level.mode, level.risk, now);
    if (refused !== undefined) return fail(refused);
    const checkpoint = checkpointsOf(state)[id] as CheckpointState;
    // A deliverable: when the creator is asked in the chat, the engine hands the agent
    // the presentation to show as recorded, with the command of the full text.
    const presentation =
      checkpoint.type === "publication" && checkpoint.publication
        ? {
            presentation: {
              title: checkpoint.title,
              ...checkpoint.publication,
              full_text_command: `npx agentplugged publication ${id}`,
            },
          }
        : {};
    const fallback = (asked: boolean, reason: ElicitationFallbackReason) =>
      ok({
        checkpoint: id,
        asked,
        answered: false as const,
        reason,
        channel: "chat" as const,
        ...presentation,
      });
    const port = context.creatorPrompt;
    // The channels, as this session shows them now. Neither the form nor the question
    // tool: the agent asks in the chat.
    const channels = await decisionChannels(context);
    const formOpen = port !== undefined && channels.available.includes("elicitation");
    const toolOpen = channels.available.includes("question_tool");
    if (!formOpen && !toolOpen) {
      return fallback(false, port === undefined ? "unavailable" : "declined");
    }
    // A permission point whose request is kept cut is read whole in the chat.
    const record = checkpoint.creator_action ?? undefined;
    if (formBlocked(checkpoint)) return fallback(false, "content_too_long");
    // A change of the memory is asked in the chat: its content is encrypted, so the
    // form would show counts only, and it cannot carry reservations nor a refusal.
    if (checkpoint.type === "memory") return fallback(false, "no_choice");
    const prompt = await promptOf(context, state, checkpoint, level, now);
    if (prompt.choices.length === 0) return fallback(false, "no_choice");
    // A definition too long for the form is read in the chat or in `review`, never half
    // of it in a form. The question tool shows no definition at all: the same way.
    const hasContent = record !== undefined && "content" in record && record.content !== undefined;
    const tooLong =
      record !== undefined &&
      "content" in record &&
      record.content !== undefined &&
      contentSize(record.content) > FORM_CONTENT_MAX_CHARS;
    if (tooLong || (!formOpen && hasContent)) return fallback(false, "content_too_long");
    // An approval that could not be carried out now (the branch moved, the files no
    // longer change anything) is said before the creator is asked, never after their click.
    if (record !== undefined && prompt.choices.some((choice) => choice.decision === "approved")) {
      const problem = await executionProblem(context, state, checkpoint.id, record);
      if (problem !== undefined) return fail(problem);
    }
    const session: object = context.session ?? port ?? context;
    // The question tool: the engine dictates the questions, the agent asks them.
    const dictate = (why: ElicitationFallbackReason) => {
      const access = context.questionTool as QuestionToolAccess;
      // A creator who closed the form on purpose is not asked another way behind their back, and an
      // agent cannot dictate the same questions for ever: the chat takes over.
      if (dismissed.get(session)?.has(id) === true) return fallback(false, "declined");
      if ((dictationOf(session, id)?.count ?? 0) >= MAX_DICTATIONS) {
        return fallback(false, "declined");
      }
      // The definition of an agent is never shown by the question tool (a reason that also covers a
      // short one: the creator reads it whole in the chat or in `review`).
      if (hasContent) return fallback(false, "content_too_long");
      const screen = access.render(prompt);
      const problem = screen === undefined ? "too_many_options" : screenProblem(screen);
      if (screen === undefined || problem !== undefined) {
        return fallback(false, screenFallback(problem ?? "too_many_options"));
      }
      const fingerprint = questionsDigest(screen.questions);
      noteDictation(session, id, {
        fingerprint,
        form: formDigest(prompt),
        at: (context.now ?? Date.now)(),
        screen,
      });
      return ok<QuestionToolDictation>({
        checkpoint: id,
        asked: false,
        answered: false,
        reason: why,
        channel: "question_tool",
        via: "question_tool",
        tool: QUESTION_TOOL_NAME,
        fingerprint,
        questions: screen.questions,
        next_step: `Ask these questions with the ${QUESTION_TOOL_NAME} tool, in one call, exactly as given. Once the creator answered, call answer_checkpoint with agent, checkpoint ${id}, via "question_tool" and the session id the hook gives you; then tell the creator in one line what was recorded.`,
      });
    };
    if (!formOpen) return dictate(port === undefined ? "unavailable" : "declined");
    if (dismissed.get(session)?.has(id) === true) return fallback(false, "declined");
    if (openForms.has(session) || askedCheckpoints.has(id)) return fallback(false, "busy");
    const reply = await askOnce(openForms, askedCheckpoints, session, id, () => port.ask(prompt));
    const quick = noteFormReply(context, reply);
    let answer = readReply(prompt, reply);
    let secondAsked = false;
    // Approving is one gesture. A refusal or a request for changes needs
    // the creator's words: a second question, of one field, asked only then.
    if (answer === "note_required" && reply.action === "accept" && port.askNote !== undefined) {
      const picked = prompt.choices.find(
        (choice) => choice.id === reply.content[DECISION_FORM_FIELDS.choice],
      );
      if (picked !== undefined) {
        secondAsked = true;
        const second = await askOnce(openForms, askedCheckpoints, session, id, () =>
          (port.askNote as NonNullable<typeof port.askNote>)(prompt, picked),
        );
        answer = readReply(prompt, withNote(reply, second));
      }
    }
    // A creator who backs out of the second question (a refusal clicked by mistake) is not shut out
    // of the form for the session: only a closed first question is remembered.
    if ((answer === "declined" || answer === "cancelled") && !quick && !secondAsked) {
      const seen = dismissed.get(session) ?? new Set<string>();
      seen.add(id);
      dismissed.set(session, seen);
    }
    if (typeof answer === "string") {
      // The form was refused at once and the question tool is there: the questions, not a failure.
      if (quick && toolOpen) return dictate(answer);
      return fallback(answer !== "unavailable" && answer !== "tool_hook", answer);
    }
    return recordAnswer(context, {
      agent,
      checkpoint: id,
      answer,
      channel: channelOf(port.channel),
      form: formDigest(prompt),
      tool: channelOf(port.channel),
      via: "elicitation",
    });
  },
});

/** What a write of the creator's answer is given (the form's click, or the question tool's record). */
interface RecordInput {
  readonly agent: string;
  readonly checkpoint: string;
  readonly answer: ElicitedAnswer;
  readonly channel: string;
  readonly form: string;
  readonly tool: string;
  readonly via: "elicitation" | "question_tool";
  readonly proof?: QuestionProof;
}

/**
 * Writes the creator's answer (`checkpoint.elicited`), then what it lets happen: the story's merge
 *, the creator's action it approves. The same for the form and for the
 * question tool: only the proof differs.
 */
async function recordAnswer(
  context: CommandContext,
  input: RecordInput,
): Promise<CommandResult<Recorded>> {
  // A merge done at the forge by this call, never one another call did.
  const token = Symbol("merge");
  let written: Awaited<ReturnType<typeof elicitedEvents.run>>;
  let merge: MergeDone | undefined;
  try {
    written = await elicitedEvents.run(
      { ...context, mergeToken: token },
      {
        agent: input.agent,
        checkpoint: input.checkpoint,
        answer: input.answer,
        channel: input.channel,
        form: input.form,
        ...(input.via === "question_tool"
          ? { via: QUESTION_TOOL_VIA, proof: input.proof as QuestionProof }
          : {}),
      },
    );
  } finally {
    merge = takePendingMerge(input.checkpoint, token);
  }
  if (!written.ok) return merge === undefined ? written : fail(notRecorded(merge, written.error));
  const { creator_action: carried, ...recorded } = written.value;
  const { answer } = input;
  const result: Recorded = {
    ...recorded,
    checkpoint: input.checkpoint,
    asked: true as const,
    answered: true as const,
    channel: input.via === "question_tool" ? "question_tool" : "elicitation",
    tool: input.tool,
    decision: answer.decision,
    ...(answer.option === undefined ? {} : { option: answer.option }),
    ...(answer.note === undefined ? {} : { note: answer.note }),
  };
  return finishAnswer(context, result, merge, carried);
}

/** What `answer_checkpoint` returns when the question tool's answer is not a choice to record. */
export interface QuestionToolNotRecorded {
  readonly checkpoint: string;
  readonly answered: false;
  readonly reason: ElicitationFallbackReason;
  readonly channel: "chat";
  /** The creator's own words, when they typed their answer in the tool's « Other » field. */
  readonly creator_words?: string;
}

/** `CHAT_QUOTE_NOT_FOUND` for the question tool: the hook's record proves no answer. */
function recordNotFound(checkpoint: string, reason: string): AgentPluggedError {
  // The chat's own « already cited » speaks of a message: the question tool has its own words.
  const named = reason === "already_cited" ? "question_already_cited" : reason;
  return new AgentPluggedError(
    ErrorCode.CHAT_QUOTE_NOT_FOUND,
    `error.chat_quote_not_found.${named}`,
    { checkpoint, field: "question", reason: named },
  );
}

/**
 * `answer_checkpoint` with `via: "question_tool"`: records the creator's answer
 * to the questions the engine dictated, read from what the tool's hook recorded. Refused when:
 * the checkpoint cannot be answered (`CHECKPOINT_NOT_FOUND`, `CHECKPOINT_NOT_OPEN`, `strict` at a high
 * risk: `REVIEW_REQUIRED`); the engine dictated nothing for it in this session, or the point changed
 * since (`CHAT_QUOTE_NOT_FOUND`, `not_dictated`, `question_changed`); the project lacks the hook
 * (`hook_missing`), the session is not given (`CHAT_SESSION_REQUIRED`), or no recorded answer to
 * exactly those questions, after they were dictated and never used before, exists
 * (`no_answer`, `before_dictation`, `already_cited`). An answer that is no choice (the creator's own
 * words, a refusal without a note) writes nothing and says why.
 * The agent gives the checkpoint and the session: never the choice or the note.
 */
export async function answerFromQuestionTool(
  context: CommandContext,
  input: QuestionToolAnswerInput,
): Promise<CommandResult<Recorded | QuestionToolNotRecorded>> {
  const { agent, checkpoint: id } = input;
  const target = await agentWriteContext(context, agent);
  if (target instanceof AgentPluggedError) return fail(target);
  const now = (context.now ?? Date.now)();
  const listing = await target.journal.list();
  const state = (await project(context, target.config, listing)).state;
  const level = await readLevel(context, target.config, state, id);
  const refused = askProblem(id, state, level.mode, level.risk, now);
  if (refused !== undefined) return fail(refused);
  const checkpoint = checkpointsOf(state)[id] as CheckpointState;
  const notRecorded = (reason: ElicitationFallbackReason, words?: string) =>
    ok<QuestionToolNotRecorded>({
      checkpoint: id,
      answered: false,
      reason,
      channel: "chat",
      ...(words === undefined ? {} : { creator_words: words }),
    });
  // The same points the form never answers: the chat's rules apply to them.
  if (formBlocked(checkpoint)) return notRecorded("content_too_long");
  if (checkpoint.type === "memory") return notRecorded("no_choice");
  const session: object = context.session ?? context.creatorPrompt ?? context;
  const dictated = dictationOf(session, id);
  if (dictated === undefined) return fail(recordNotFound(id, "not_dictated"));
  const prompt = await promptOf(context, state, checkpoint, level, now);
  if (formDigest(prompt) !== dictated.form) return fail(recordNotFound(id, "question_changed"));
  const channels = await decisionChannels(context);
  if (channels.question_tool === "hook_missing")
    return fail(recordNotFound(id, "question_hook_missing"));
  if (channels.question_tool !== "available" || context.chat?.decisions === undefined) {
    return notRecorded("unavailable");
  }
  const sessionId = proofSessionOf(context, input.session);
  if (sessionId === undefined) {
    return fail(
      new AgentPluggedError(ErrorCode.CHAT_SESSION_REQUIRED, "error.chat_session_required", {
        checkpoint: id,
      }),
    );
  }
  const folder = context.chat.project;
  const records = (await context.chat.decisions.records(sessionId)).filter(
    (record) =>
      folder === undefined || (record.project !== undefined && sameProject(record.project, folder)),
  );
  const cited = new Set([
    ...(Array.isArray(state.chat_cited) ? (state.chat_cited as string[]) : []),
    ...refusedKeys(session),
  ]);
  const free = freeRecords(records, dictated.fingerprint, { after: dictated.at, now, cited });
  if (typeof free === "string") return fail(recordNotFound(id, free));
  const record = free[0] as DecisionRecord;
  const reading = readToolAnswer(prompt, dictated.screen, record);
  if (!reading.ok) {
    // The creator's click was read and is no choice: the next call reads their next one.
    noteRefused(session, record);
    return notRecorded(reading.reason, reading.words);
  }
  const channel = channelOf(context.session?.client);
  return recordAnswer(context, {
    agent,
    checkpoint: id,
    answer: reading.answer,
    channel,
    form: formDigest(prompt),
    tool: channel,
    via: "question_tool",
    proof: { question: refOfRecord(record) },
  });
}
