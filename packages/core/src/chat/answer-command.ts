import {
  type AnswerCheckpointInput,
  AnswerCheckpointInputSchema,
  CHAT_EVENT_TYPES,
  type ChatProof,
  type CheckpointRisk,
  ErrorCode,
  type ProjectionState,
  type QuestionToolAnswerInput,
  type ValidationMode,
} from "@agentplugged/protocol";
import type { z } from "zod";
import {
  agentEventCommand,
  defined,
  type EventSpec,
  planned,
  project as projectListing,
  type RecordedEvent,
} from "../agent-activity/agent-commands.js";
import {
  answerable,
  CREATOR_ACTION_DECISIONS,
  liftsBlocks,
  resolutionProblem,
  statusAt,
} from "../checkpoints/resolution-rules.js";
import { mergeHold } from "../ci/ci-rules.js";
import { defineCommand, fail } from "../command.js";
import {
  type ActionExecuted,
  currentRisk,
  executionEvent,
  executionProblem,
  executionStateProblem,
  higherRisk,
} from "../creator-actions/creator-action-execution.js";
import { isForgeAction } from "../creator-actions/forge-gestures.js";
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
} from "../merge/story-merge.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { checkpointsOf } from "../projection/checkpoint-reducers.js";
import { mergeHead } from "../review/merge-head.js";
import { finishAnswer, withPendingMerge } from "./answer-finish.js";
import {
  answerFromQuestionTool,
  type QuestionToolNotRecorded,
  type Recorded,
} from "./ask-command.js";
import { isReopenable } from "./auto-apply.js";
import {
  type ChatMessage,
  chatClientOf,
  chatHookPath,
  isHookedClient,
  matchQuote,
  proofSessionOf,
  type QuoteMatch,
  refOf,
  sameProject,
} from "./chat-proof.js";
import { error, reviewRequired } from "./review-rules.js";

export { reviewRequired };

import { selectionOutsideStack } from "./stack-rules.js";
import { resolveValidationSettings } from "./validation-settings.js";

/** What `answer_checkpoint` reads before the journal lock: the level, the hook, the messages. */
interface AnswerPrepared {
  readonly mode: ValidationMode;
  /** The AI tool records the creator's messages (its hook): the quote must be proved. */
  readonly hooked: boolean;
  /** The creator's messages of the session given, as the hook recorded them, of this project. */
  readonly messages: readonly ChatMessage[];
  /** The project holds the hook's script. */
  readonly installed: boolean;
  /**
   * An approval of a creator's action: why it cannot be carried out, checked
   * outside the journal before the write (the branch's head, the files), or null when it can.
   * Absent for any other answer.
   */
  readonly execution?: AgentPluggedError | null;
  /**
   * An answer to a creator's action: its risk in the product as it is now
   * (`currentRisk`); the higher of it and the request's counts.
   */
  readonly risk?: CheckpointRisk;
  /** The head of the story's branch, for its merge checkpoint, when Git reads it. */
  readonly head?: string;
  /**
   * An approval of a story's merge checkpoint: the merge the engine did at the forge
   * once everything else allowed the answer, or why it could not. Absent for any other answer.
   */
  readonly merge?: MergeDone | AgentPluggedError;
}

/** The messages already cited by an answer the projection accepted (`citedKey`). */
function citedOf(state: ProjectionState["state"]): ReadonlySet<string> {
  const cited = state.chat_cited;
  return new Set(Array.isArray(cited) ? (cited as string[]) : []);
}

/** `CHAT_QUOTE_NOT_FOUND`: the quote proves no message of the session. */
function quoteNotFound(checkpoint: string, reason: string): AgentPluggedError {
  return error(ErrorCode.CHAT_QUOTE_NOT_FOUND, `error.chat_quote_not_found.${reason}`, {
    checkpoint,
    field: "quote",
    reason,
  });
}

/**
 * The event `answer_checkpoint` writes, or why it is refused. Checked in
 * this order, on the state as it is when written:
 * 1. the checkpoint exists (`CHECKPOINT_NOT_FOUND`); `reopen` needs one the engine applied on its
 *    own (`CHECKPOINT_NOT_REOPENABLE`); any other decision an open one (`CHECKPOINT_NOT_OPEN`);
 * 2. only the terminal answers a high risk at the `strict` level, and at that level a merge, a
 *    gesture of the forge without the hook's proof
 *    (`REVIEW_REQUIRED`): never at the `chat` or `auto` level;
 * 3. the decision fits it (an option it has: `INVALID_ARGUMENTS`); nothing confirms it, whatever its
 *    risk or its irreversibility: one message of the creator is the whole answer;
 * 4. with the hook (whose script the project must hold: `hook_missing`), the session is given
 *    (`CHAT_SESSION_REQUIRED`) and the quote is a whole
 *    message of it, after the opening (after the automatic application for `reopen`), recent and
 *    never cited (`CHAT_QUOTE_NOT_FOUND`). Without the hook, the answer is written without
 *    `proof`: `chat_unverified`, traced as such in the journal.
 */
export function answerPlan(
  input: AnswerCheckpointInput,
  state: ProjectionState["state"],
  prepared: AnswerPrepared,
  now: number,
  /** `dry`: everything but the merge of an approved story (checked before the forge merges). */
  options: { readonly dry?: boolean } = {},
): EventSpec[] | AgentPluggedError {
  const checkpoints = checkpointsOf(state);
  const id = input.checkpoint;
  if (!Object.hasOwn(checkpoints, id)) {
    return error(ErrorCode.CHECKPOINT_NOT_FOUND, "error.checkpoint_not_found", { checkpoint: id });
  }
  const checkpoint = checkpoints[id] as CheckpointState;
  const story = checkpoint.story ?? undefined;
  const cited = citedOf(state);
  const prove = (after: string): QuoteMatch | AgentPluggedError | undefined => {
    if (!prepared.hooked) return undefined;
    // Claude Code without the hook's script (`sync` did not target it): never unverified there.
    if (!prepared.installed) return quoteNotFound(id, "hook_missing");
    if (input.session === undefined) {
      return error(ErrorCode.CHAT_SESSION_REQUIRED, "error.chat_session_required", {
        checkpoint: id,
      });
    }
    return matchQuote(prepared.messages, input.quote, {
      after: Date.parse(after),
      now,
      cited,
      ...(input.anticipated === true ? { anticipated: true } : {}),
    });
  };

  if (input.decision === "reopen") {
    const resolution = checkpoint.resolution;
    // A merge already done is undone by a `git revert`, never by reopening its point.
    const stories = (state.stories as Record<string, { merged?: unknown }> | undefined) ?? {};
    const mergeDone =
      checkpoint.source === "merge" &&
      story !== undefined &&
      Object.hasOwn(stories, story) &&
      stories[story]?.merged !== undefined;
    if (!isReopenable(checkpoint) || resolution === null || mergeDone) {
      return error(ErrorCode.CHECKPOINT_NOT_REOPENABLE, "error.checkpoint_not_reopenable", {
        checkpoint: id,
        status: statusAt(checkpoint, now),
      });
    }
    const match = prove(resolution.at);
    if (match instanceof AgentPluggedError) return match;
    if (match !== undefined && !match.ok) return quoteNotFound(id, match.reason);
    return [
      {
        type: CHAT_EVENT_TYPES.reopened,
        story,
        payload: defined({
          checkpoint: id,
          source: "chat",
          quote: input.quote,
          proof: match === undefined ? undefined : { message: refOf(match.message) },
        }),
      },
    ];
  }

  if (!answerable(checkpoint, now)) {
    return error(ErrorCode.CHECKPOINT_NOT_OPEN, "error.checkpoint_not_open", {
      checkpoint: id,
      status: statusAt(checkpoint, now),
    });
  }
  // A message that selects numbers of a stack (« j'approuve 1 et 2 ») answers the
  // points it names, and those alone: it never approves another point of that stack, nor is
  // it a single point's answer.
  if (liftsBlocks(input.decision as never)) {
    const outside = selectionOutsideStack(state, id, input.quote);
    if (outside !== undefined) {
      return error(ErrorCode.STACK_REPLY_UNCLEAR, "error.stack_reply_unclear.not_selected", {
        stack: outside,
        reason: "not_selected",
        checkpoint: id,
      });
    }
  }
  const action = checkpoint.creator_action ?? undefined;
  // A creator's action is approved, refused or sent back: never another decision.
  if (action !== undefined && !CREATOR_ACTION_DECISIONS.has(input.decision as never)) {
    return error(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
      command: "answer_checkpoint",
      field: "decision",
      reason:
        "answer_checkpoint: decision: expected approved, rejected or changes_requested for a creator's action",
    });
  }
  // A creator's action: its risk now counts too, when higher (a level raised since the request).
  const risk =
    action !== undefined && prepared.risk !== undefined
      ? higherRisk(checkpoint.risk, prepared.risk)
      : checkpoint.risk;
  if (prepared.mode === "strict" && risk === "high") {
    return reviewRequired(checkpoint, "strict_high_risk");
  }
  const proved = prepared.hooked && prepared.installed;
  // An accord to proof commands (or to what the release demands of the proofs) is
  // never taken on a word the hook cannot prove, at any level: the creator answers in the tool's
  // form or at the terminal.
  if (action?.kind === "proof_commands" && input.decision === "approved" && !proved) {
    return reviewRequired(checkpoint, "unverified_commands");
  }
  // An agreement given before the opening is for the decisions that are announced and
  // answered at once; never for a high risk, a release, a publication or an action of the creator's.
  if (
    input.anticipated === true &&
    (risk === "high" ||
      checkpoint.type === "release" ||
      checkpoint.type === "publication" ||
      checkpoint.type === "creator_action")
  ) {
    return quoteNotFound(id, "before_opening");
  }
  // At the `chat` and `auto` levels, an answer the hook cannot prove (a tool without
  // it) is recorded as `chat_unverified` for any point: a merge (undone by a `git revert`), a
  // gesture of the forge; the journal says how it was proved. Only the `strict` level keeps the
  // proof (or the terminal) for those. What a session has read changes nothing.
  const merging = mergesOn(checkpoint, input.decision);
  if (prepared.mode === "strict" && !proved) {
    if (merging) return reviewRequired(checkpoint, "unverified_merge");
    if (action !== undefined && isForgeAction(action) && input.decision === "approved") {
      return reviewRequired(checkpoint, "unverified_forge");
    }
    // A repair installs or sets something on the machine: same rule.
    if (action?.kind === "environment_fix" && input.decision === "approved") {
      return reviewRequired(checkpoint, "unverified_environment");
    }
    // At the strict level, a step is skipped on a proved answer or at the terminal.
    if (action?.kind === "step_skip" && input.decision === "approved") {
      return reviewRequired(checkpoint, "unverified_skip");
    }
  }
  // A story's merge checkpoint held back by its gate is only refused before its review (story
  // 4.5), whatever the channel: `MERGE_NOT_READY`.
  const held = resolutionProblem(
    {
      ...checkpoint,
      ...mergeHold(state, checkpoint, prepared.head === undefined ? {} : { head: prepared.head }),
    },
    {
      decision: input.decision,
      ...(input.option === undefined ? {} : { option: input.option }),
      note: input.note ?? input.quote,
    },
    now,
  );
  if (held?.code === ErrorCode.MERGE_NOT_READY || held?.code === ErrorCode.RELEASE_NOT_READY) {
    return held;
  }
  if (input.decision === "option_chosen") {
    const ids = (checkpoint.options ?? []).map((option) => option.id);
    if (input.option === undefined || !ids.includes(input.option)) {
      return error(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
        command: "answer_checkpoint",
        field: "option",
        reason: `answer_checkpoint: option: expected one of ${ids.join(", ") || "(no option)"}`,
      });
    }
  }
  let proof: ChatProof | undefined;
  const match = prove(checkpoint.opened_at);
  if (match instanceof AgentPluggedError) return match;
  if (match !== undefined) {
    if (!match.ok) return quoteNotFound(id, match.reason);
    proof = { message: refOf(match.message) };
  }
  const answered: EventSpec = {
    type: CHAT_EVENT_TYPES.answered,
    story,
    payload: defined({
      checkpoint: id,
      decision: input.decision,
      option: input.option,
      note: input.note,
      source: "chat",
      quote: input.quote,
      proof,
      anticipated: input.anticipated,
    }),
  };
  // An approved story's merge checkpoint: merged by the engine at the forge before
  // this write, `story.merged` in it right after the answer.
  if (merging) {
    if (options.dry === true) return [answered];
    const merge =
      prepared.merge ??
      mergeFailed(story ?? "", id, "forge_failed", { message: "the merge was not prepared" });
    if (merge instanceof AgentPluggedError) return merge;
    return [answered, mergedEvent(merge, "chat")];
  }
  if (action === undefined || input.decision !== "approved") return [answered];
  // An approved creator's action: carried out by the engine in the same write,
  // once the journal and what lies outside it still allow it. Nothing is written otherwise.
  const problem = executionStateProblem(action, state) ?? prepared.execution ?? undefined;
  if (problem !== undefined) return problem;
  return [answered, executionEvent(id, action, "chat", input.quote)];
}

/**
 * `answer_checkpoint`: records the creator's answer given in the chat,
 * relayed by the agent with the creator's own words. Written as the agent (`actor.kind: agent`,
 * `source: chat`), signed by the machine key; never as the creator. See `answerPlan` for what it
 * refuses; nothing is written on a refusal and the checkpoint stays open.
 */
const answerEvents = agentEventCommand({
  name: "answer_checkpoint",
  description:
    'Record the creator\'s answer to a checkpoint. After ask_creator dictated questions (`channel: "question_tool"`) that the creator answered in the AskUserQuestion tool: pass `via: "question_tool"` and `session` only (the engine reads the answer from the tool\'s hook). Otherwise, when ask_creator answered `answered: false`, the answer was given in this chat: present the checkpoint first, then call this with the creator\'s whole message, word for word, in `quote`, the decision it gives (`approved`, `approved_with_reservations`, `rejected`, `changes_requested`, `option_chosen` with `option`), and `session`: the session id the hook gives you (`agentplugged chat session: …`). A plain approval ("ok", "oui", "vas-y", "d\'accord") to a question that carried your recommendation chooses it: `option_chosen` with the recommendation\'s id as `option` (`approved` for a document), and the whole message in `quote`; the engine checks that the message exists, never what it means. One message answers one point whatever its risk: never ask for a confirmation, a sentence to repeat or a second message; for an irreversible action with an outside effect, your question names it, and their answer is their agreement. `reopen` cancels a checkpoint applied at the `auto` level or decided by an agent. A quote that is not a message the creator sent after the checkpoint opened is refused (`CHAT_QUOTE_NOT_FOUND`). `REVIEW_REQUIRED` only comes at the `strict` level (the terminal, with the command it gives).',
  // The chat's answer: the loosened schema already refuses a call without decision or
  // quote when `via` is absent, so the plan reads a chat answer whole.
  inputSchema: AnswerCheckpointInputSchema as unknown as z.ZodType<AnswerCheckpointInput>,
  needsState: () => true,
  replanned: true,
  async prepare(input, context, _agents, config): Promise<AnswerPrepared> {
    const settings = await resolveValidationSettings(config, context.mainBranch);
    const chat = context.chat;
    const client = chatClientOf(context);
    const hooked = chat?.hooked === true || isHookedClient(client);
    const installed = chat?.hookInstalled ?? (await context.files.exists(chatHookPath(client)));
    const log = chat?.log;
    const project = chat?.project;
    // Only the messages of a session of this project: never a message sent for another product.
    const session = proofSessionOf(context, input.session);
    const messages = (
      hooked && session !== undefined && log !== undefined ? await log.messages(session) : []
    ).filter(
      (message) =>
        project === undefined ||
        (message.project !== undefined && sameProject(message.project, project)),
    );
    // An approval of a creator's action: what lies outside the journal is checked
    // before the write (the branch's head, the files through their command).
    // An answer to a creator's action: its risk now and, for an approval, what lies
    // outside the journal (the branch's head, the files).
    let creator: Pick<AnswerPrepared, "execution" | "risk" | "head"> = {};
    if (input.decision !== "reopen" && context.journal !== undefined) {
      // A pull request the creator already merged on the forge is recorded first (dynamic import: no cycle).
      await (await import("../merge/forge-follow.js")).followForge(context, { force: true });
      const listing = await context.journal.list();
      const state = (await projectListing(context, config, listing)).state;
      const checkpoint = checkpointsOf(state)[input.checkpoint];
      const head = await mergeHead(context, state, checkpoint);
      if (head !== undefined) creator = { head };
      const record = checkpoint?.creator_action ?? undefined;
      if (checkpoint !== undefined && record !== undefined) {
        creator = {
          ...creator,
          risk: await currentRisk(context, state, record),
          ...(input.decision === "approved"
            ? { execution: (await executionProblem(context, state, checkpoint.id, record)) ?? null }
            : {}),
        };
      }
    }
    const prepared: AnswerPrepared = {
      mode: settings.mode,
      hooked,
      messages,
      installed,
      ...creator,
    };
    // An approval of a story's merge checkpoint: once the answer passes every other
    // check on the state as it is, the engine merges at the forge; the write follows.
    if (context.journal !== undefined) {
      const state = (await projectListing(context, config, await context.journal.list())).state;
      const checkpoint = checkpointsOf(state)[input.checkpoint];
      if (checkpoint !== undefined && mergesOn(checkpoint, input.decision)) {
        const now = (context.now ?? Date.now)();
        const plan = answerPlan(input, state, prepared, now, { dry: true });
        if (plan instanceof AgentPluggedError) return { ...prepared, merge: plan };
        const merge =
          pendingMergeOf(checkpoint.id, context.mergeToken) ??
          (await mergeStory(context, config, state, checkpoint, prepared.head));
        if (!(merge instanceof AgentPluggedError)) notePendingMerge(merge, context.mergeToken);
        return { ...prepared, merge };
      }
    }
    return prepared;
  },
  ...planned(answerPlan),
});

/** What `answer_checkpoint` returns: the answer recorded, and the creator's action carried out. */
export type AnswerRecorded = RecordedEvent & {
  /** The creator's action the engine carried out once approved. */
  readonly executed?: ActionExecuted;
  /** The story the engine merged once its merge checkpoint was approved. */
  readonly merged?: MergeResult;
};

/**
 * `answer_checkpoint`: records the creator's answer given in the chat,
 * relayed by the agent with the creator's own words. Written as the agent (`actor.kind: agent`,
 * `source: chat`), signed by the machine key; never as the creator. See `answerPlan` for what it
 * refuses; nothing is written on a refusal and the checkpoint stays open. An approved creator's
 * action is carried out by the engine: its `creator_action.executed` in the same
 * write, then, for a file action, its files and `sync`.
 */
export const answerCheckpointCommand = defineCommand<
  AnswerRecorded | Recorded | QuestionToolNotRecorded
>({
  name: answerEvents.name,
  audience: "agent",
  description: `${answerEvents.description ?? ""} A \`creator_action\` checkpoint (request_creator_action) takes \`approved\` (the engine then carries the action out itself and returns \`executed\`), \`rejected\` or \`changes_requested\`. A \`memory\` checkpoint (propose_retrospective, propose_promotion: its content is encrypted, present it to the creator yourself first) takes \`approved\`, \`approved_with_reservations\` (their words as the note: leave out what they named with \`except\` in record_lessons), \`rejected\` or \`changes_requested\`; once approved, record_lessons or promote_lesson carries it out.`,
  inputSchema: AnswerCheckpointInputSchema,
  // The creator's answer to the point of the engine's update.
  allowsOlderEngine: (context, input) => isEngineUpdatePoint(context, input.checkpoint),
  async run(context, input) {
    // The creator's answer to the question tool, read from its hook's record.
    const parsed = AnswerCheckpointInputSchema.safeParse(input);
    if (parsed.success && parsed.data.via !== undefined) {
      return answerFromQuestionTool(context, parsed.data as QuestionToolAnswerInput);
    }
    // A merge done at the forge by this call: recorded with the answer, or said not
    // recorded; never one another call did.
    const { result, merge } = await withPendingMerge(
      context,
      (input as { checkpoint?: unknown }).checkpoint,
      (merging) => answerEvents.run(merging, input),
    );
    if (!result.ok) {
      return merge === undefined || !(result.error instanceof AgentPluggedError)
        ? result
        : fail(notRecorded(merge, result.error));
    }
    const { creator_action: carried, ...recorded } = result.value;
    return finishAnswer(context, recorded, merge, carried);
  },
});
