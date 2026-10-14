import {
  type AnswerStackInput,
  AnswerStackInputSchema,
  type AnswerStackToolInput,
  AskStackInputSchema,
  type CheckpointRisk,
  ElicitationChannelSchema,
  type ElicitationFallbackReason,
  ErrorCode,
  MAX_STACK_ITEMS,
  MessageDigestSchema,
  type MethodConfig,
  MIN_STACK_ITEMS,
  OpenStackInputSchema,
  type ProjectionState,
  QUESTION_TOOL_NAME,
  QUESTION_TOOL_VIA,
  type QuestionStackProof,
  QuestionStackProofSchema,
  QuestionToolViaSchema,
  STACK_EVENT_TYPES,
  type StackInvalidReason,
  type StackReplyReason,
  stackIdOf,
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
} from "../agent-activity/agent-commands.js";
import { answerable } from "../checkpoints/resolution-rules.js";
import { type CommandContext, type CommandResult, defineCommand, fail, ok } from "../command.js";
import { currentState } from "../deferred/deferred-commands.js";
import { AgentPluggedError } from "../errors.js";
import { afterMerge, type MergeResult, mergedEvent, mergeFailed } from "../merge/story-merge.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { checkpointsOf } from "../projection/checkpoint-reducers.js";
import { isMergeCheckpoint } from "../projection/merge-reducers.js";
import { type StackState, stacksOf } from "../projection/stack-reducers.js";
import { channelOf } from "./ask-command.js";
import { decisionChannels } from "./channels.js";
import {
  type ChatMessage,
  chatClientOf,
  chatHookPath,
  isHookedClient,
  matchQuote,
  proofSessionOf,
  refOf,
  sameProject,
} from "./chat-proof.js";
import { askOnce, noteFormReply } from "./form-session.js";
import {
  type DecisionRecord,
  freeRecords,
  MAX_DICTATIONS,
  noteRefused,
  noteStackDictation,
  type QuestionToolAccess,
  questionsDigest,
  readStackScreen,
  refOfRecord,
  refusedKeys,
  screenFallback,
  screenProblem,
  stackDictationOf,
  type ToolQuestion,
} from "./question-tool.js";
import { mergeStackPoints, NO_MERGES, type StackMerges } from "./stack-merges.js";
import {
  parseStackReply,
  readStackReply,
  stackItems,
  stackProblem,
  stackPrompt,
  stackPromptDigest,
  stackPromptItem,
} from "./stack-rules.js";
import { resolveValidationSettings } from "./validation-settings.js";

/**
 * The tools of the stack to validate: `open_stack` (the engine opens a stack of
 * open checkpoints it checked), `ask_stack` (one form, a box per point, in an AI tool that shows
 * forms) and `answer_stack` (the creator's message, read by the engine). The agent never gives a
 * number, a decision, a risk or a channel: a stack answer approves the points the creator's own
 * message or ticks name, and those alone.
 */

function stackError(
  code: (typeof ErrorCode)[keyof typeof ErrorCode],
  key: string,
  details: Record<string, unknown>,
): AgentPluggedError {
  return new AgentPluggedError(code, key, details);
}

/** `STACK_INVALID`: the list cannot form a stack; nothing is written. */
function stackInvalid(reason: StackInvalidReason, checkpoint?: string): AgentPluggedError {
  return stackError(ErrorCode.STACK_INVALID, `error.stack_invalid.${reason}`, {
    reason,
    ...(checkpoint === undefined ? {} : { checkpoint }),
    min: MIN_STACK_ITEMS,
    max: MAX_STACK_ITEMS,
  });
}

function stackNotFound(stack: string): AgentPluggedError {
  return stackError(ErrorCode.STACK_NOT_FOUND, "error.stack_not_found", { stack });
}

function stackClosed(stack: string): AgentPluggedError {
  return stackError(ErrorCode.STACK_CLOSED, "error.stack_closed", { stack });
}

/** `STACK_REPLY_UNCLEAR`: the message is no approval of numbers of the stack. */
function stackReplyUnclear(stack: string, reason: StackReplyReason): AgentPluggedError {
  return stackError(ErrorCode.STACK_REPLY_UNCLEAR, `error.stack_reply_unclear.${reason}`, {
    stack,
    reason,
  });
}

/** The stack, or `STACK_NOT_FOUND`. */
function found(state: ProjectionState["state"], id: string): StackState | AgentPluggedError {
  const stacks = stacksOf(state);
  return Object.hasOwn(stacks, id) ? (stacks[id] as StackState) : stackNotFound(id);
}

/* ------------------------------------------------------------------------------------------ */
/* open_stack                                                                                 */
/* ------------------------------------------------------------------------------------------ */

/** The checkpoints to stack, or why not: the count, each point (`stackProblem`), nothing twice. */
function openedPoints(
  ids: readonly string[],
  state: ProjectionState["state"],
  now: number,
  strict: boolean,
): CheckpointState[] | AgentPluggedError {
  // One stack at a time: a message of the creator names no stack, so two open stacks
  // could let a stack never presented be answered by the words said for another.
  const checkpointsNow = checkpointsOf(state);
  for (const stack of Object.values(stacksOf(state))) {
    const pending = stack.items.some(
      (item) =>
        item.answer === null &&
        Object.hasOwn(checkpointsNow, item.checkpoint) &&
        answerable(checkpointsNow[item.checkpoint] as CheckpointState, now),
    );
    if (pending) {
      return stackError(ErrorCode.STACK_INVALID, "error.stack_invalid.stack_open", {
        reason: "stack_open",
        stack: stack.id,
        min: MIN_STACK_ITEMS,
        max: MAX_STACK_ITEMS,
      });
    }
  }
  if (ids.length < MIN_STACK_ITEMS) return stackInvalid("too_few");
  if (ids.length > MAX_STACK_ITEMS) return stackInvalid("too_many");
  const checkpoints = checkpointsOf(state);
  const points: CheckpointState[] = [];
  for (const id of ids) {
    if (points.some((point) => point.id === id)) return stackInvalid("duplicate", id);
    if (!Object.hasOwn(checkpoints, id)) return stackInvalid("unknown_checkpoint", id);
    const point = checkpoints[id] as CheckpointState;
    const problem = stackProblem(point, state, now, strict);
    if (problem !== undefined) return stackInvalid(problem, id);
    points.push(point);
  }
  return points;
}

/** What `open_stack` reads before the journal lock: whether the level is `strict`. */
interface OpenStackPrepared {
  readonly strict: boolean;
}

const openEvents = agentEventCommand<typeof OpenStackInputSchema, OpenStackPrepared>({
  name: "open_stack",
  description: "Opens a stack of checkpoints to validate together (internal).",
  inputSchema: OpenStackInputSchema,
  needsState: () => true,
  replanned: true,
  async prepare(_input, context, _agents, config): Promise<OpenStackPrepared> {
    return {
      strict: (await resolveValidationSettings(config, context.mainBranch)).mode === "strict",
    };
  },
  events(input, state, prepared, now) {
    const points = openedPoints(input.checkpoints, state ?? {}, now, prepared?.strict === true);
    if (points instanceof AgentPluggedError) throw points;
    return { events: [{ type: STACK_EVENT_TYPES.opened, payload: { items: stackItems(points) } }] };
  },
  check(input, state, env) {
    const points = openedPoints(input.checkpoints, state, env.now, env.prepared?.strict === true);
    return points instanceof AgentPluggedError ? points : undefined;
  },
});

/** One point of a stack as `open_stack` returns it, for the agent to present. */
export interface StackPointShown {
  readonly n: number;
  readonly checkpoint: string;
  readonly type: string;
  readonly title: string;
  readonly summary: string;
  readonly risk: CheckpointRisk;
  /** What approving it records when it is a decision: the recommended option's label, or null. */
  readonly recommendation: string | null;
}

/** What `open_stack` returns: the stack, its points numbered, and what comes next. */
export interface StackOpened {
  readonly stack: string;
  readonly at: string;
  readonly items: readonly StackPointShown[];
}

/**
 * `open_stack`: the engine opens the stack of the open checkpoints listed, which it
 * checked one by one, and numbers them 1, 2, 3… in this order. Written as the agent that presents
 * (`actor.kind: agent`), signed by the machine key; nothing is answered.
 */
export const openStackCommand = defineCommand<StackOpened>({
  name: "open_stack",
  audience: "agent",
  description:
    "Present two or more open checkpoints to the creator together, as one numbered stack to validate, instead of asking for each one: documents, decisions that carry your recommendation, merges, releases, publications, ends of phase, planned installations (`pile.stack` in next is the whole list). `checkpoints`: 2 to 16 ids (G-…), in the order to present. The engine checks each one and refuses (STACK_INVALID, its `reason`, nothing written) a point that is not open, an action of the creator's, a memory change, a decision with options and no recommendation, a point opened for help (conflict, review loop), and, at the strict level only, a high risk. A merge, a release or a publication enters it: name its action in its line. It returns the stack (P-…) with every point numbered, titled, summarised and its risk. Then call ask_stack: the creator ticks the points they validate in one form, or approves them in the tool's question tool, and the engine records one answer for each. Otherwise (`answered: false`, `channel: \"chat\"`) present the stack in the chat: each point numbered with its title and a short summary, and tell the creator they can approve all (« j'approuve tout »), some (« j'approuve 1, 2 et 4 ») or ask to read one first; then record their message with answer_stack (the engine then merges the approved stories itself, in the order of the graph). A stack never grows: open another for other points. Never present a point of a stack as approved yourself.",
  inputSchema: OpenStackInputSchema,
  async run(context, input) {
    const written = await openEvents.run(context, input);
    if (!written.ok) return fail(written.error);
    const id = stackIdOf(written.value.id);
    const state = await currentState(context);
    const stack = stacksOf(state)[id];
    if (stack === undefined) {
      throw new Error(`open_stack: ${id} was not applied`);
    }
    const checkpoints = checkpointsOf(state);
    return ok({
      stack: id,
      at: written.value.at,
      items: stack.items.map((item) => {
        const shown = stackPromptItem(item.n, checkpoints[item.checkpoint] as CheckpointState);
        return {
          n: item.n,
          checkpoint: item.checkpoint,
          type: shown.type,
          title: shown.title,
          summary: shown.summary,
          risk: shown.risk,
          recommendation: shown.recommendation?.label ?? null,
        };
      }),
    });
  },
});

/* ------------------------------------------------------------------------------------------ */
/* What a stack answer returns                                                                */
/* ------------------------------------------------------------------------------------------ */

/** Where each point of the stack stands once an answer is written. */
export interface StackStanding {
  /** The points the answer approved, with what was recorded. */
  readonly approved: readonly {
    readonly n: number;
    readonly checkpoint: string;
    readonly decision: string;
    readonly option?: string;
  }[];
  /**
   * The points the message named that were left open, with why: `already_answered` (answered
   * meanwhile), `not_allowed` (the stack may no longer hold it).
   */
  readonly skipped: readonly {
    readonly n: number;
    readonly checkpoint: string;
    readonly reason: "already_answered" | "not_allowed";
  }[];
  /** The points still waiting for an answer. */
  readonly remaining: readonly {
    readonly n: number;
    readonly checkpoint: string;
    readonly title: string;
  }[];
}

function standing(
  state: ProjectionState["state"],
  stack: StackState,
  event: string,
  /** The numbers the message named (the chat), to say which of them were left open. */
  named: readonly number[] = [],
): StackStanding {
  const checkpoints = checkpointsOf(state);
  const approved: StackStanding["approved"][number][] = [];
  const remaining: StackStanding["remaining"][number][] = [];
  const skipped: StackStanding["skipped"][number][] = [];
  for (const item of stack.items) {
    const point = Object.hasOwn(checkpoints, item.checkpoint)
      ? (checkpoints[item.checkpoint] as CheckpointState)
      : undefined;
    if (item.answer?.event === event && point?.resolution != null) {
      approved.push({
        n: item.n,
        checkpoint: item.checkpoint,
        decision: point.resolution.decision,
        ...(point.resolution.option === null ? {} : { option: point.resolution.option }),
      });
    } else if (item.answer === null && point !== undefined && point.status === "open") {
      remaining.push({ n: item.n, checkpoint: item.checkpoint, title: point.title });
    }
    if (named.includes(item.n) && item.answer?.event !== event) {
      skipped.push({
        n: item.n,
        checkpoint: item.checkpoint,
        reason:
          item.answer !== null || (point !== undefined && point.status !== "open")
            ? "already_answered"
            : "not_allowed",
      });
    }
  }
  return { approved, skipped, remaining };
}

/** The points of the stack that still wait: `answerable` and not answered by the stack. */
function waiting(
  stack: StackState,
  state: ProjectionState["state"],
  now: number,
): StackState["items"] {
  const checkpoints = checkpointsOf(state);
  return stack.items.filter(
    (item) =>
      item.answer === null &&
      Object.hasOwn(checkpoints, item.checkpoint) &&
      answerable(checkpoints[item.checkpoint] as CheckpointState, now),
  );
}

/* ------------------------------------------------------------------------------------------ */
/* answer_stack                                                                               */
/* ------------------------------------------------------------------------------------------ */

/** What `answer_stack` reads before the journal lock: the hook, the messages, the merges. */
interface AnswerStackPrepared {
  /** The AI tool records the creator's messages (its hook): the quote must be proved. */
  readonly hooked: boolean;
  readonly installed: boolean;
  readonly messages: readonly ChatMessage[];
  /** The level is `strict`: a high risk or irreversible point is never stacked. */
  readonly strict: boolean;
  /** The merges the engine did at the forge for the merge points of the answer. */
  readonly merges: StackMerges;
}

/** The numbers of `stack` named that can be approved now: still waiting, still stackable. */
function targetsOf(
  state: ProjectionState["state"],
  stack: StackState,
  named: readonly number[],
  now: number,
  strict: boolean,
): number[] {
  const checkpoints = checkpointsOf(state);
  return waiting(stack, state, now)
    .filter((item) => named.includes(item.n))
    .filter(
      (item) =>
        stackProblem(checkpoints[item.checkpoint] as CheckpointState, state, now, strict) ===
        undefined,
    )
    .map((item) => item.n);
}

/**
 * The merges noted by the call that holds a token (`CommandContext.mergeToken`): what the forge did
 * for the merge points of its answer, read again once written to say what was merged and what
 * failed. Never another call's.
 */
const noted = new Map<symbol, StackMerges>();

/** Notes the merges of the call that holds `token`. */
function noteMerges(token: symbol | undefined, merges: StackMerges): void {
  if (token !== undefined && merges !== NO_MERGES) noted.set(token, merges);
}

/** The merges a call noted, forgotten once read. */
function takeMerges(token: symbol): StackMerges {
  const merges = noted.get(token) ?? NO_MERGES;
  noted.delete(token);
  return merges;
}

/**
 * The merge points of the points `numbers` name, merged at the forge by the engine in the order of
 * the graph before the write: nothing is written here. An empty answer when no merge
 * point is named.
 */
async function mergesOfAnswer(
  context: CommandContext,
  config: MethodConfig,
  stack: StackState,
  numbers: readonly number[],
  now: number,
  strict: boolean,
): Promise<StackMerges> {
  if (context.journal === undefined) return NO_MERGES;
  const state = (await project(context, config, await context.journal.list())).state;
  const checkpoints = checkpointsOf(state);
  const points = targetsOf(state, stack, numbers, now, strict).flatMap((n) => {
    const item = stack.items.find((entry) => entry.n === n);
    return item === undefined ? [] : [checkpoints[item.checkpoint] as CheckpointState];
  });
  return mergeStackPoints(context, config, state, points);
}

/**
 * What an answer of a stack writes once the forge has merged its merge points: the
 * numbers approved (a merge that failed leaves its point open), and the `story.merged` of each
 * merge done, in the order of the graph, right after the answer. `AgentPluggedError` when every
 * point named was a merge that failed: nothing is written, the agent says why.
 */
function settleMerges(
  stack: StackState,
  numbers: readonly number[],
  state: ProjectionState["state"],
  merges: StackMerges,
  source: "chat" | "elicitation",
): { readonly approve: number[]; readonly merged: EventSpec[] } | AgentPluggedError {
  const checkpoints = checkpointsOf(state);
  const approve: number[] = [];
  const kept = new Set<string>();
  let refusal: AgentPluggedError | undefined;
  for (const n of numbers) {
    const item = stack.items.find((entry) => entry.n === n);
    const point = item === undefined ? undefined : checkpoints[item.checkpoint];
    if (point === undefined || !isMergeCheckpoint(point)) {
      approve.push(n);
      continue;
    }
    const failure = merges.failed.get(point.id);
    if (failure !== undefined) {
      refusal ??= failure;
      continue;
    }
    if (!merges.done.has(point.id)) {
      refusal ??= mergeFailed(point.story ?? "", point.id, "forge_failed", {
        message: "the merge was not prepared",
      });
      continue;
    }
    kept.add(point.id);
    approve.push(n);
  }
  if (approve.length === 0) {
    return refusal ?? stackReplyUnclear(stack.id, "nothing_open");
  }
  const merged = [...merges.done.entries()]
    .filter(([checkpoint]) => kept.has(checkpoint))
    .map(([, done]) => mergedEvent(done, source));
  return { approve, merged };
}

/** The messages already cited by an answer the projection accepted. */
function cited(state: ProjectionState["state"]): ReadonlySet<string> {
  const list = state.chat_cited;
  return new Set(Array.isArray(list) ? (list as string[]) : []);
}

/**
 * The event `answer_stack` writes, or why it is refused. In this order, on the state
 * as it is when written:
 * 1. the stack exists (`STACK_NOT_FOUND`) and a point still waits (`STACK_CLOSED`);
 * 2. the message is an approval of numbers of the stack, from the closed grammar
 *    (`STACK_REPLY_UNCLEAR`), the engine's reading and never the agent's;
 * 3. with the hook, the session is given and the message is a whole one of it, after the stack
 *    opened, never cited (`CHAT_SESSION_REQUIRED`, `CHAT_QUOTE_NOT_FOUND`); without the hook, the
 *    answer is « unverified » (`chat_unverified`, traced as such), an installation included;
 * 4. each point named still waits and a stack may still hold it (`stackProblem`); the others are
 *    skipped, not refused, and the answer approves the rest.
 */
export function answerStackPlan(
  input: AnswerStackInput,
  state: ProjectionState["state"],
  prepared: AnswerStackPrepared,
  now: number,
): EventSpec[] | AgentPluggedError {
  const stack = found(state, input.stack);
  if (stack instanceof AgentPluggedError) return stack;
  const open = waiting(stack, state, now);
  if (open.length === 0) return stackClosed(stack.id);
  const reading = parseStackReply(input.quote, stack.items.length);
  if (!reading.ok) return stackReplyUnclear(stack.id, reading.reason);
  let proof: ReturnType<typeof refOf> | undefined;
  if (prepared.hooked) {
    if (!prepared.installed) {
      return stackError(ErrorCode.CHAT_QUOTE_NOT_FOUND, "error.chat_quote_not_found.hook_missing", {
        checkpoint: stack.id,
        field: "quote",
        reason: "hook_missing",
      });
    }
    if (input.session === undefined) {
      return stackError(ErrorCode.CHAT_SESSION_REQUIRED, "error.chat_session_required", {
        checkpoint: stack.id,
      });
    }
    const match = matchQuote(prepared.messages, input.quote, {
      after: Date.parse(stack.opened_at),
      now,
      cited: cited(state),
    });
    if (!match.ok) {
      return stackError(
        ErrorCode.CHAT_QUOTE_NOT_FOUND,
        `error.chat_quote_not_found.${match.reason}`,
        { checkpoint: stack.id, field: "quote", reason: match.reason },
      );
    }
    proof = refOf(match.message);
  }
  const targets = targetsOf(state, stack, reading.numbers, now, prepared.strict);
  if (targets.length === 0) {
    // Every point named was answered meanwhile (or may not be stacked any more).
    return stackReplyUnclear(stack.id, "nothing_open");
  }
  // The merge points are merged by the engine, in the order of the graph, in this write.
  const settled = settleMerges(stack, targets, state, prepared.merges, "chat");
  if (settled instanceof AgentPluggedError) return settled;
  return [
    {
      type: STACK_EVENT_TYPES.answered,
      payload: defined({
        stack: stack.id,
        source: "chat",
        approve: settled.approve,
        quote: input.quote,
        proof: proof === undefined ? undefined : { message: proof },
      }),
    },
    ...settled.merged,
  ];
}

const answerEvents = agentEventCommand<z.ZodType<AnswerStackInput>, AnswerStackPrepared>({
  name: "answer_stack",
  description: "Records the creator's answer to a stack, from the chat (internal).",
  // The chat's answer: the loosened schema already refuses a call without a quote
  // when `via` is absent.
  inputSchema: AnswerStackInputSchema as unknown as z.ZodType<AnswerStackInput>,
  needsState: () => true,
  replanned: true,
  async prepare(input, context, _agents, config): Promise<AnswerStackPrepared> {
    const chat = context.chat;
    const client = chatClientOf(context);
    const hooked = chat?.hooked === true || isHookedClient(client);
    const installed = chat?.hookInstalled ?? (await context.files.exists(chatHookPath(client)));
    const project_ = chat?.project;
    const session = proofSessionOf(context, input.session);
    const messages = (
      hooked && session !== undefined && chat?.log !== undefined
        ? await chat.log.messages(session)
        : []
    ).filter(
      (message) =>
        project_ === undefined ||
        (message.project !== undefined && sameProject(message.project, project_)),
    );
    const strict = (await resolveValidationSettings(config, context.mainBranch)).mode === "strict";
    // The merge points the message names are merged at the forge, in the order of the
    // graph, before the write (the same call writes the answer and each `story.merged`).
    let merges = NO_MERGES;
    if (context.journal !== undefined) {
      const now = (context.now ?? Date.now)();
      const state = (await project(context, config, await context.journal.list())).state;
      const stack = stacksOf(state)[input.stack];
      const reading = parseStackReply(input.quote, stack?.items.length ?? 0);
      if (stack !== undefined && reading.ok) {
        merges = await mergesOfAnswer(context, config, stack, reading.numbers, now, strict);
      }
    }
    noteMerges(context.mergeToken, merges);
    return { hooked, installed, messages, strict, merges };
  },
  ...planned(answerStackPlan),
});

/** What the engine merged for the points a stack approved, and what it could not. */
export interface StackMergeReport {
  /** The stories merged at the forge, in the order of the graph. */
  readonly merged?: readonly MergeResult[];
  /** The merges that failed: their point stays open, nothing else is lost. */
  readonly merge_failed?: readonly {
    readonly checkpoint: string;
    readonly story: string;
    readonly code: string;
    readonly reason: string | null;
  }[];
}

/** The merges a call made, as it returns them once written (the worktrees removed). */
async function mergeReport(
  context: CommandContext,
  merges: StackMerges,
): Promise<StackMergeReport> {
  const merged: MergeResult[] = [];
  for (const done of merges.done.values()) merged.push(await afterMerge(context, done));
  const failed = [...merges.failed.entries()].map(([checkpoint, error]) => {
    const { code, details } = error.toPayload();
    const reason = (details as Record<string, unknown>).reason;
    return {
      checkpoint,
      story: String((details as Record<string, unknown>).story ?? ""),
      code,
      reason: typeof reason === "string" ? reason : null,
    };
  });
  return {
    ...(merged.length === 0 ? {} : { merged }),
    ...(failed.length === 0 ? {} : { merge_failed: failed }),
  };
}

/** What `answer_stack` returns: the event, and where each point of the stack stands. */
export type StackAnswered = StackStanding &
  StackMergeReport & {
    readonly id: string;
    readonly type: string;
    readonly at: string;
    readonly stack: string;
  };

/**
 * `answer_stack`: records the creator's answer to a stack given in the chat, in their
 * own words: « j'approuve les 3 », « j'approuve 1, 2 et 4 », « j'approuve tout sauf le 2 ». The
 * engine reads the message, the agent only quotes it; each point named is approved, and those
 * alone. See `answerStackPlan` for what it refuses; nothing is written on a refusal.
 */
export const answerStackCommand = defineCommand<StackAnswered | StackRecorded | StackNotRecorded>({
  name: "answer_stack",
  audience: "agent",
  description:
    "Record the creator's answer to a stack (open_stack). After ask_stack dictated screens (`channel: \"question_tool\"`) and the creator answered them in the AskUserQuestion tool: pass `via: \"question_tool\"` and `session` only (no quote); the engine reads the approved points from the tool's hook. Otherwise the answer was given in this chat, when the engine could not ask it in the AI tool (ask_stack answered `answered: false`): call it with the creator's whole message, word for word, in `quote` (never a rewording, never a part), and `session`, the session id the hook gives you (`agentplugged chat session: …`). You give no number and no decision: the engine reads the message, in French or English: « j'approuve tout », « j'approuve les 3 » (the count of the stack), « j'approuve 1, 2 et 4 », « j'approuve tout sauf le 2 ». Each point it names is approved (a document, a story, an end of phase: approved; a decision: its recommendation chosen), and those alone; the others stay open. A message that is not such an approval (« oui » alone, a negation, a reservation, a question) is refused, STACK_REPLY_UNCLEAR, nothing written: use answer_checkpoint for one point, or ask again. The message must be one the creator sent after the stack opened and no other answer cited (CHAT_QUOTE_NOT_FOUND). It returns `approved` (each point and what was recorded), `skipped` (a point the message named and that was left open, with why: answered meanwhile, or no longer allowed in a stack) and `remaining`: tell the creator in one line what was approved and what was left open, and present what remains. The merge points it approved are merged by the engine, in the order of the graph, in the same write: `merged` lists the stories merged, `merge_failed` those that failed (their point stays open): say so.",
  inputSchema: AnswerStackInputSchema,
  async run(context, input) {
    // The creator's answers to the question tool, read from its hook's records.
    const viaTool = AnswerStackInputSchema.safeParse(input);
    if (viaTool.success && viaTool.data.via !== undefined) {
      return answerStackFromTool(context, viaTool.data);
    }
    const token = Symbol("stack-merge");
    let written: Awaited<ReturnType<typeof answerEvents.run>>;
    let merges: StackMerges;
    try {
      written = await answerEvents.run({ ...context, mergeToken: token }, input);
    } finally {
      merges = takeMerges(token);
    }
    if (!written.ok) return fail(written.error);
    const parsed = AnswerStackInputSchema.parse(input) as AnswerStackInput;
    const state = await currentState(context);
    const stack = stacksOf(state)[parsed.stack];
    if (stack === undefined) throw new Error(`answer_stack: ${parsed.stack} vanished`);
    return ok({
      id: written.value.id,
      type: written.value.type,
      at: written.value.at,
      stack: stack.id,
      ...standing(
        state,
        stack,
        written.value.id,
        (() => {
          const reading = parseStackReply(parsed.quote, stack.items.length);
          return reading.ok ? reading.numbers : [];
        })(),
      ),
      ...(await mergeReport(context, merges)),
    });
  },
});

/* ------------------------------------------------------------------------------------------ */
/* ask_stack                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/** The internal write of a form's answer: the points ticked, as the engine read them. */
const StackElicitedInputSchema = z.strictObject({
  agent: z.string(),
  stack: z.string(),
  approve: z.array(z.int().min(1).max(MAX_STACK_ITEMS)).min(1).max(MAX_STACK_ITEMS),
  channel: ElicitationChannelSchema,
  form: MessageDigestSchema,
  via: QuestionToolViaSchema.optional(),
  proof: QuestionStackProofSchema.optional(),
});

/**
 * The event of a form's answer, on the state as it is when written: the points ticked that still
 * wait, which a stack may still hold; the others are skipped. Never a point of an untrusted
 * session's installation (the chat's rules apply to it).
 */
function elicitedPlan(
  input: z.infer<typeof StackElicitedInputSchema>,
  state: ProjectionState["state"],
  prepared: ElicitedPrepared,
  now: number,
): EventSpec[] | AgentPluggedError {
  const stack = found(state, input.stack);
  if (stack instanceof AgentPluggedError) return stack;
  const targets = targetsOf(state, stack, input.approve, now, prepared.strict);
  if (targets.length === 0) return stackClosed(stack.id);
  // The merge points ticked are merged by the engine, in the order of the graph.
  const settled = settleMerges(stack, targets, state, prepared.merges, "elicitation");
  if (settled instanceof AgentPluggedError) return settled;
  return [
    {
      type: STACK_EVENT_TYPES.answered,
      payload: {
        stack: stack.id,
        source: "elicitation",
        approve: settled.approve,
        channel: input.channel,
        form: input.form,
        ...(input.via === undefined ? {} : { via: input.via, proof: input.proof }),
      },
    },
    ...settled.merged,
  ];
}

/** Without a preparation (never in practice): nothing merged, the level not strict. */
const NOT_PREPARED: ElicitedPrepared = { strict: false, merges: NO_MERGES };

/** What a form's answer reads before the journal lock: the level and the merges. */
interface ElicitedPrepared {
  readonly strict: boolean;
  readonly merges: StackMerges;
}

const elicitedEvents = agentEventCommand<typeof StackElicitedInputSchema, ElicitedPrepared>({
  name: "ask_stack",
  description: "Records the points the creator ticked in the stack's form (internal).",
  inputSchema: StackElicitedInputSchema,
  needsState: () => true,
  replanned: true,
  async prepare(input, context, _agents, config): Promise<ElicitedPrepared> {
    const strict = (await resolveValidationSettings(config, context.mainBranch)).mode === "strict";
    let merges = NO_MERGES;
    if (context.journal !== undefined) {
      const now = (context.now ?? Date.now)();
      const state = (await project(context, config, await context.journal.list())).state;
      const stack = stacksOf(state)[input.stack];
      if (stack !== undefined) {
        merges = await mergesOfAnswer(context, config, stack, input.approve, now, strict);
      }
    }
    noteMerges(context.mergeToken, merges);
    return { strict, merges };
  },
  ...planned(elicitedPlan, NOT_PREPARED),
});

/** The forms open in this process, by session, and the stacks they ask: one at a time. */
const openForms = new WeakSet<object>();
const askedStacks = new Set<string>();
/** The stacks whose form the creator declined or closed, by session: never asked again there. */
const dismissed = new WeakMap<object, Set<string>>();

/** The screens of a stack to ask with the AI tool's question tool. */
export interface StackQuestionToolDictation {
  readonly stack: string;
  readonly asked: false;
  readonly answered: false;
  readonly reason: ElicitationFallbackReason;
  readonly channel: "question_tool";
  readonly via: "question_tool";
  readonly tool: typeof QUESTION_TOOL_NAME;
  /**
   * The screens, in order: ask each one in its own call of the tool, its `questions` word for word.
   * A stack of more than four points is split in several screens.
   */
  readonly screens: readonly {
    readonly screen: number;
    readonly fingerprint: string;
    readonly questions: readonly ToolQuestion[];
  }[];
  /** The points still waiting. */
  readonly remaining: StackStanding["remaining"];
  readonly next_step: string;
}

/** What `ask_stack` returns. */
export type AskStackResult =
  /**
   * Nothing recorded: the stack stays open and the agent asks in the chat (`answer_stack`).
   * `asked` says whether the form was shown.
   */
  | {
      readonly stack: string;
      readonly asked: boolean;
      readonly answered: false;
      readonly reason: ElicitationFallbackReason;
      readonly channel: "chat";
      /** The points still waiting, to present in the chat. */
      readonly remaining: StackStanding["remaining"];
    }
  /** The questions to ask with the AI tool's question tool. */
  | StackQuestionToolDictation
  /** The points the creator ticked, recorded, and what remains. */
  | StackRecorded;

/** The points the creator approved, recorded, and what remains. */
export type StackRecorded = StackStanding &
  StackMergeReport & {
    readonly id: string;
    readonly type: string;
    readonly at: string;
    readonly stack: string;
    readonly asked: true;
    readonly answered: true;
    readonly channel: "elicitation" | "question_tool";
    readonly tool: string;
  };

/**
 * `ask_stack`: the engine shows the stack in the AI tool's form itself, one form with
 * a box per point still waiting (ticked at first: the creator unticks what they do not validate),
 * and records one answer per point left ticked, without it passing through the agent. Without a
 * form, a refusal or nothing ticked, nothing is written and the agent presents the stack in the
 * chat (`answer_stack`).
 *
 * When the client refuses forms at once, or shows none, the engine dictates the screens
 * of the AI tool's question tool instead (four points at most each, one question a point); the
 * answers are read from the tool's hook by `answer_stack` with `via: "question_tool"`.
 */
export const askStackCommand = defineCommand<AskStackResult>({
  name: "ask_stack",
  audience: "agent",
  description:
    'Ask the creator to validate a stack (open_stack) the way the AI tool lets them answer with a click: call it right after open_stack. The engine picks the channel itself. Either the tool\'s form: one form from the stack (a box per point still waiting: number, title, summary, risk, all ticked: the creator unticks what they do not validate and submits); it records one answer for each point left ticked, with no quote and nothing for you to relay, and returns `answered: true` with `approved` and `remaining`: tell the creator in one line what was recorded, then present what remains. Or `channel: "question_tool"`: `screens`, each with the exact `questions` to ask with the AskUserQuestion tool, word for word, one call per screen, nothing added; once the creator answered all of them, call answer_stack with `via: "question_tool"` and `session` (no quote). Or `answered: false`, `channel: "chat"` and `remaining`: nothing was recorded; present the stack in the chat and record their message with answer_stack. Never ask again a stack the creator declined. An installation of an untrusted session is never in the form: it goes through the chat.',
  inputSchema: AskStackInputSchema,
  async run(context, input) {
    const parsed = AskStackInputSchema.safeParse(input);
    if (!parsed.success) return fail(invalidInput("ask_stack", parsed.error));
    const { agent, stack: id } = parsed.data;
    const target = await agentWriteContext(context, agent);
    if (target instanceof AgentPluggedError) return fail(target);
    const now = (context.now ?? Date.now)();
    const state = (await project(context, target.config, await target.journal.list())).state;
    const stack = found(state, id);
    if (stack instanceof AgentPluggedError) return fail(stack);
    const checkpoints = checkpointsOf(state);
    const shown = stackPrompt(stack, checkpoints, now);
    if (shown === undefined) return fail(stackClosed(id));
    const remaining = shown.items.map((item) => ({
      n: item.n,
      checkpoint: item.checkpoint,
      title: item.title,
    }));
    const fallback = (asked: boolean, reason: ElicitationFallbackReason) =>
      ok({
        stack: id,
        asked,
        answered: false as const,
        reason,
        channel: "chat" as const,
        remaining,
      });
    const port = context.creatorPrompt;
    // The channels, as this session shows them now.
    const channels = await decisionChannels(context);
    const formOpen = port?.askStack !== undefined && channels.available.includes("elicitation");
    const toolOpen = channels.available.includes("question_tool");
    if (!formOpen && !toolOpen) {
      return fallback(false, port?.askStack === undefined ? "unavailable" : "declined");
    }
    const strict =
      (await resolveValidationSettings(target.config, context.mainBranch)).mode === "strict";
    const items = shown.items.filter((item) => {
      const point = checkpoints[item.checkpoint] as CheckpointState;
      return stackProblem(point, state, now, strict) === undefined;
    });
    if (items.length === 0) return fallback(false, "no_choice");
    const prompt = { stack: id, items };
    const session: object = context.session ?? port ?? context;
    // The question tool: the engine dictates the screens, the agent asks them.
    const dictate = (why: ElicitationFallbackReason) => {
      const access = context.questionTool as QuestionToolAccess;
      // The chat takes over once the creator closed the form on purpose, or after three dictations.
      if (dismissed.get(session)?.has(id) === true) return fallback(false, "declined");
      if ((stackDictationOf(session, id)?.count ?? 0) >= MAX_DICTATIONS) {
        return fallback(false, "declined");
      }
      const screens = access.renderStack(prompt);
      const problem =
        screens.length === 0
          ? "questions"
          : screens.map((screen) => screenProblem(screen)).find((entry) => entry !== undefined);
      if (problem !== undefined) return fallback(false, screenFallback(problem));
      const dictated = screens.map((screen) => ({
        ...screen,
        fingerprint: questionsDigest(screen.questions),
      }));
      noteStackDictation(session, id, {
        form: stackPromptDigest(prompt),
        at: (context.now ?? Date.now)(),
        screens: dictated,
        items: items.map((item) => ({ n: item.n, checkpoint: item.checkpoint })),
      });
      return ok<StackQuestionToolDictation>({
        stack: id,
        asked: false,
        answered: false,
        reason: why,
        channel: "question_tool",
        via: "question_tool",
        tool: QUESTION_TOOL_NAME,
        screens: dictated.map((screen, index) => ({
          screen: index + 1,
          fingerprint: screen.fingerprint,
          questions: screen.questions,
        })),
        remaining,
        next_step: `Ask each screen with the ${QUESTION_TOOL_NAME} tool, one call per screen, exactly as given. Once the creator answered them all, call answer_stack with agent, stack ${id}, via "question_tool" and the session id the hook gives you; then tell the creator in one line what was approved and present what remains.`,
      });
    };
    if (!formOpen) return dictate(port?.askStack === undefined ? "unavailable" : "declined");
    if (dismissed.get(session)?.has(id) === true) return fallback(false, "declined");
    if (openForms.has(session) || askedStacks.has(id)) return fallback(false, "busy");
    const reply = await askOnce(openForms, askedStacks, session, id, () =>
      (port as { askStack: NonNullable<typeof port.askStack> }).askStack(prompt),
    );
    const quick = noteFormReply(context, reply);
    const answer = readStackReply(prompt, reply);
    if ((answer === "declined" || answer === "cancelled") && !quick) {
      const seen = dismissed.get(session) ?? new Set<string>();
      seen.add(id);
      dismissed.set(session, seen);
    }
    if (typeof answer === "string") {
      if (quick && toolOpen) return dictate(answer);
      return fallback(answer !== "unavailable" && answer !== "tool_hook", answer);
    }
    const channel = channelOf(port?.channel);
    return stackRecorded(context, {
      agent,
      stack: id,
      approve: answer.approve,
      channel,
      form: stackPromptDigest(prompt),
      tool: channel,
      via: "elicitation",
    });
  },
});

/** What a write of a stack's answer is given. */
interface StackRecordInput {
  readonly agent: string;
  readonly stack: string;
  readonly approve: readonly number[];
  readonly channel: string;
  readonly form: string;
  readonly tool: string;
  readonly via: "elicitation" | "question_tool";
  readonly proof?: QuestionStackProof;
}

/** Writes the points approved (`stack.answered`), then reads where the stack stands. */
async function stackRecorded(
  context: CommandContext,
  input: StackRecordInput,
): Promise<CommandResult<StackRecorded>> {
  const token = Symbol("stack-merge");
  let written: Awaited<ReturnType<typeof elicitedEvents.run>>;
  let merges: StackMerges;
  try {
    written = await elicitedEvents.run(
      { ...context, mergeToken: token },
      {
        agent: input.agent,
        stack: input.stack,
        approve: [...input.approve],
        channel: input.channel,
        form: input.form,
        ...(input.via === "question_tool"
          ? { via: QUESTION_TOOL_VIA, proof: input.proof as QuestionStackProof }
          : {}),
      },
    );
  } finally {
    merges = takeMerges(token);
  }
  if (!written.ok) return fail(written.error);
  const after = await currentState(context);
  const current = stacksOf(after)[input.stack] as StackState;
  return ok({
    id: written.value.id,
    type: written.value.type,
    at: written.value.at,
    stack: input.stack,
    asked: true as const,
    answered: true as const,
    channel: input.via === "question_tool" ? ("question_tool" as const) : ("elicitation" as const),
    tool: input.tool,
    ...standing(after, current, written.value.id),
    ...(await mergeReport(context, merges)),
  });
}

/** `CHAT_QUOTE_NOT_FOUND` for the question tool: the hook's records prove no answer. */
function recordNotFound(stack: string, reason: string): AgentPluggedError {
  const named = reason === "already_cited" ? "question_already_cited" : reason;
  return stackError(ErrorCode.CHAT_QUOTE_NOT_FOUND, `error.chat_quote_not_found.${named}`, {
    checkpoint: stack,
    field: "question",
    reason: named,
  });
}

/** What `answer_stack` returns when the creator approved no point in the question tool. */
export interface StackNotRecorded {
  readonly stack: string;
  readonly answered: false;
  readonly reason: ElicitationFallbackReason;
  readonly channel: "chat";
  readonly remaining: StackStanding["remaining"];
}

/**
 * `answer_stack` with `via: "question_tool"`: the points the creator approved in the
 * screens the engine dictated, read from what the tool's hook recorded. A point the creator left
 * open stays open; a stack never grows (only the points dictated count); each record answers once
 * (`CHAT_QUOTE_NOT_FOUND`: `not_dictated`, `hook_missing`, `no_answer`, `before_dictation`,
 * `already_cited`). The agent gives the stack and the session: never a number or a decision.
 */
async function answerStackFromTool(
  context: CommandContext,
  input: AnswerStackToolInput,
): Promise<CommandResult<StackRecorded | StackNotRecorded>> {
  const target = await agentWriteContext(context, input.agent);
  if (target instanceof AgentPluggedError) return fail(target);
  const now = (context.now ?? Date.now)();
  const state = (await project(context, target.config, await target.journal.list())).state;
  const stack = found(state, input.stack);
  if (stack instanceof AgentPluggedError) return fail(stack);
  const open = waiting(stack, state, now);
  if (open.length === 0) return fail(stackClosed(stack.id));
  const remaining = open.map((item) => ({
    n: item.n,
    checkpoint: item.checkpoint,
    title: (checkpointsOf(state)[item.checkpoint] as CheckpointState).title,
  }));
  const session: object = context.session ?? context.creatorPrompt ?? context;
  const dictated = stackDictationOf(session, stack.id);
  if (dictated === undefined) return fail(recordNotFound(stack.id, "not_dictated"));
  const channels = await decisionChannels(context);
  if (channels.question_tool === "hook_missing") {
    return fail(recordNotFound(stack.id, "question_hook_missing"));
  }
  if (channels.question_tool !== "available" || context.chat?.decisions === undefined) {
    return ok<StackNotRecorded>({
      stack: stack.id,
      answered: false,
      reason: "unavailable",
      channel: "chat",
      remaining,
    });
  }
  const sessionId = proofSessionOf(context, input.session);
  if (sessionId === undefined) {
    return fail(
      stackError(ErrorCode.CHAT_SESSION_REQUIRED, "error.chat_session_required", {
        checkpoint: stack.id,
      }),
    );
  }
  const folder = context.chat.project;
  const records = (await context.chat.decisions.records(sessionId)).filter(
    (record) =>
      folder === undefined || (record.project !== undefined && sameProject(record.project, folder)),
  );
  const alreadyCited = new Set([...cited(state), ...refusedKeys(session)]);
  const used: DecisionRecord[] = [];
  const approved = new Set<number>();
  let refusal: string | undefined;
  for (const screen of dictated.screens) {
    const free = freeRecords(records, screen.fingerprint, {
      after: dictated.at,
      now,
      cited: alreadyCited,
    });
    if (typeof free === "string") {
      refusal ??= free;
      continue;
    }
    const record = free[0] as DecisionRecord;
    used.push(record);
    for (const n of readStackScreen(screen, record)) approved.add(n);
  }
  if (used.length === 0) return fail(recordNotFound(stack.id, refusal ?? "no_answer"));
  // Only the points dictated, still waiting, that a stack may still hold.
  const checkpoints = checkpointsOf(state);
  const dictatedNumbers = new Set(dictated.items.map((item) => item.n));
  const strict =
    (await resolveValidationSettings(target.config, context.mainBranch)).mode === "strict";
  const targets = open
    .filter((item) => approved.has(item.n) && dictatedNumbers.has(item.n))
    .filter((item) => {
      const point = checkpoints[item.checkpoint] as CheckpointState;
      return stackProblem(point, state, now, strict) === undefined;
    })
    .map((item) => item.n);
  if (targets.length === 0) {
    // Every point was left open: those clicks are read, the next call reads the creator's next ones.
    for (const record of used) noteRefused(session, record);
    return ok<StackNotRecorded>({
      stack: stack.id,
      answered: false,
      reason: "none_checked",
      channel: "chat",
      remaining,
    });
  }
  const channel = channelOf(context.session?.client);
  return stackRecorded(context, {
    agent: input.agent,
    stack: stack.id,
    approve: targets,
    channel,
    form: dictated.form,
    tool: channel,
    via: "question_tool",
    proof: { questions: used.map((record) => refOfRecord(record)) },
  });
}
