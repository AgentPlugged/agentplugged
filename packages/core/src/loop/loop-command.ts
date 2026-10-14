import {
  CHECKPOINT_EVENT_TYPES,
  HYPOTHESIS_KIND,
  LOOP_EVENT_TYPES,
  type LoopInput,
  LoopInputSchema,
  type LoopStopReason,
  NOAH_AGENT,
  type ProjectionState,
} from "@agentplugged/protocol";
import {
  agentEventCommand,
  agentWriteContext,
  defined,
  invalidInput,
} from "../agent-activity/agent-commands.js";
import { currentDeveloper } from "../agents/agent-aliases.js";
import { roleForbidden } from "../agents/noah-role.js";
import { truncate } from "../checkpoints/checkpoint-rules.js";
import {
  type Command,
  type CommandContext,
  type CommandResult,
  defineCommand,
  fail,
  ok,
} from "../command.js";
import { criteriaTrace, unprovenCriteria } from "../criteria/criterion-trace.js";
import { currentState } from "../deferred/deferred-commands.js";
import { openDeferred } from "../deferred/deferred-rules.js";
import { AgentPluggedError } from "../errors.js";
import type { NextStep } from "../next/next.js";
import { nextCommand } from "../next/next-command.js";
import { storyIn } from "../projection/agent-reducers.js";
import { budgetThresholdsOf } from "../projection/budget-reducers.js";
import { checkpointsOf } from "../projection/checkpoint-reducers.js";
import { invalid } from "../requirements/requirement-commands.js";
import {
  type AttemptRecord,
  type AttemptsView,
  attemptLimitCheckpoint,
  attemptsView,
  hypothesisProblem,
  loopStateOf,
  loopVerdict,
  parseHypothesis,
  ruledOutLines,
  triedLines,
  tryProblem,
  turnEvent,
} from "./loop-rules.js";

/**
 * `loop`: the bounded loop, three gestures of one action. Noah's turn asks what comes
 * next: the engine reads `next`, says to run the step (the story that is ready, the agent that
 * owns it) or to stop (at which point of the creator's, or why else), and inscribes the stop or the
 * resumption after the creator's gesture. The story's developer declares the approach they are about
 * to try (refused when it is one that already failed, or when the story reached its limit), then how
 * it ended; the failure that reaches the limit opens a point for the creator in the same write. It
 * starts nothing, merges nothing, spends nothing: the work, the merge and every gate stay where they
 * were.
 */

type State = ProjectionState["state"];

/** What `loop` answers. */
export interface LoopView {
  /** `run`: do the step; `stop`: the loop is stopped; `done`: nothing is left; `recorded`: an attempt. */
  readonly verdict: "run" | "stop" | "done" | "recorded";
  readonly step?: string;
  readonly agent?: string;
  readonly story?: string;
  readonly reason?: LoopStopReason;
  /** What the stop is about: a point (`G-…`), a story, a step. */
  readonly subject?: string;
  /** Points that wait for the creator. */
  readonly waiting?: number;
  /** The loop went on after a stop it had inscribed. */
  readonly resumed?: true;
  /** The attempts of the story: failed since the last limit, and the limit. */
  readonly attempts?: { readonly failed: number; readonly limit: number };
  /** The approaches that failed (the latest three): never to be tried again. */
  readonly tried?: readonly string[];
  /** The hypotheses ruled out on the story (the latest three) and the cause confirmed. */
  readonly ruled_out?: readonly string[];
  readonly cause?: string;
  /** At a stop or at the end: stories done, points the agents decided, deferred items open. */
  readonly point?: { readonly done: number; readonly decided: number; readonly deferred: number };
  /** The success condition of the story: its criteria and where each stands, one line. */
  readonly until?: string;
  /** The one line to say. */
  readonly line: string;
}

const refuse = (field: string, reason: string): AgentPluggedError => invalid("loop", field, reason);

/**
 * What a developer's call says, from the three published fields (`story`, `seen`, `note`: no new
 * name on the list every request pays for): with `story` and `note` alone, the approach about to be
 * tried; with `seen` (`failed`, `green`), how the approach in progress ended, `note` saying why.
 */
interface Call {
  readonly agent: string;
  readonly story?: string | undefined;
  readonly approach?: string | undefined;
  readonly result?: "failed" | "green" | undefined;
  readonly note?: string | undefined;
  /** The call is about the cause of a bug, not a fix: `approach` is the hypothesis. */
  readonly hypothesis?: { readonly confidence?: number } | undefined;
}

function callOf(input: LoopInput): Call {
  if (input.seen === undefined) {
    return { agent: input.agent, story: input.story, approach: input.note };
  }
  if (input.seen === "hypothesis") {
    const parsed = parseHypothesis(input.note);
    return {
      agent: input.agent,
      story: input.story,
      approach: parsed?.statement ?? input.note ?? "",
      hypothesis: parsed === undefined ? {} : { confidence: parsed.confidence },
      note: input.note,
    };
  }
  if (input.seen === "ruled_out" || input.seen === "confirmed") {
    return {
      agent: input.agent,
      story: input.story,
      result: input.seen === "confirmed" ? "green" : "failed",
      note: input.note,
      hypothesis: {},
    };
  }
  return {
    agent: input.agent,
    story: input.story,
    result: input.seen as "failed" | "green",
    note: input.note,
  };
}

/** The attempts of a story in a projection. */
function viewOf(state: State, story: string): AttemptsView {
  return attemptsView(storyIn(state, story)?.attempts, Object.values(checkpointsOf(state)), story);
}

/** What stops the developer's call: the story is theirs, started, not merged. */
function builderProblem(state: State, story: string, agent: string): AgentPluggedError | undefined {
  const started = storyIn(state, story)?.started;
  if (started === undefined) return refuse("story", "not_started");
  if (storyIn(state, story)?.merged !== undefined) return refuse("story", "done");
  if (currentDeveloper(agent) !== currentDeveloper(started.agent)) {
    return refuse("story", `not_builder (the developer is ${started.agent})`);
  }
  return undefined;
}

/** Why a hypothesis may not be put forward, as the refusal says it. */
function hypothesisStartProblem(state: State, input: Call): AgentPluggedError | undefined {
  const story = input.story ?? "";
  const refused = builderProblem(state, story, input.agent);
  if (refused !== undefined) return refused;
  const view = viewOf(state, story);
  const problem = hypothesisProblem(view, input.note);
  if (problem === undefined) return undefined;
  if (problem === "confidence_missing") {
    return refuse(
      "note",
      "confidence_missing (write `7/10 the hypothesis`: a confidence from 1 to 10, then the hypothesis)",
    );
  }
  if (problem === "attempts_exhausted") {
    return refuse(
      "story",
      `attempts_exhausted (${view.failed} approaches failed${view.open_point === null ? "" : `, the creator is asked: ${view.open_point}`}): stop and say so`,
    );
  }
  if (problem === "attempt_open") {
    return refuse("hypothesis", `attempt_open (report how "${view.in_progress}" ended first)`);
  }
  if (problem === "hypothesis_open") {
    return refuse(
      "hypothesis",
      `hypothesis_open (say how "${view.hypotheses.testing?.approach}" ended first: ruled_out or confirmed)`,
    );
  }
  return refuse(
    "hypothesis",
    `hypothesis_ruled_out (already ruled out: ${view.hypotheses.ruled_out
      .map((record) => `"${record.approach}"`)
      .slice(-3)
      .join(", ")}): put forward another cause, or say what differs`,
  );
}

/** Why the hypothesis under test may not be closed, or undefined. */
function hypothesisReportProblem(state: State, input: Call): AgentPluggedError | undefined {
  const story = input.story ?? "";
  const refused = builderProblem(state, story, input.agent);
  if (refused !== undefined) return refused;
  if (viewOf(state, story).hypotheses.testing === null) {
    return refuse(
      "result",
      "no_hypothesis_open (put it forward first: story, seen hypothesis, note `7/10 the hypothesis`)",
    );
  }
  if (input.note === undefined) {
    return refuse(
      "note",
      "evidence_missing (say what you saw that rules the hypothesis out or confirms it)",
    );
  }
  return undefined;
}

/** Why an approach may not start, as the refusal says it. */
function startProblem(state: State, input: Call): AgentPluggedError | undefined {
  if (input.hypothesis !== undefined) return hypothesisStartProblem(state, input);
  const story = input.story ?? "";
  const refused = builderProblem(state, story, input.agent);
  if (refused !== undefined) return refused;
  const view = viewOf(state, story);
  const problem = tryProblem(view, input.approach ?? "");
  if (problem === undefined) return undefined;
  if (problem === "cause_unconfirmed") {
    return refuse(
      "approach",
      "cause_unconfirmed (the cause of this bug is not confirmed: test your hypotheses first, seen hypothesis then confirmed)",
    );
  }
  if (problem === "attempts_exhausted") {
    return refuse(
      "story",
      `attempts_exhausted (${view.failed} approaches failed${view.open_point === null ? "" : `, the creator is asked: ${view.open_point}`}): stop and say so`,
    );
  }
  if (problem === "attempt_open") {
    return refuse("approach", `attempt_open (report how "${view.in_progress}" ended first)`);
  }
  return refuse(
    "approach",
    `approach_failed (already tried and failed: ${view.failures
      .map((record) => `"${record.approach}"`)
      .slice(-3)
      .join(", ")}): find another way`,
  );
}

/** Why a result may not be reported, or undefined. */
function reportProblem(state: State, input: Call): AgentPluggedError | undefined {
  if (input.hypothesis !== undefined) return hypothesisReportProblem(state, input);
  const story = input.story ?? "";
  const refused = builderProblem(state, story, input.agent);
  if (refused !== undefined) return refused;
  if (viewOf(state, story).in_progress === null) {
    return refuse("result", "no_attempt_open (declare the approach first: story, approach)");
  }
  return undefined;
}

/** The events of an attempt: its record, and the point for the creator when the limit is reached. */
function attemptEvents(state: State, input: Call) {
  const story = input.story ?? "";
  const view = viewOf(state, story);
  if (input.hypothesis !== undefined) {
    const testing = view.hypotheses.testing;
    const [approach, confidence] =
      input.approach !== undefined
        ? [input.approach, input.hypothesis.confidence ?? 5]
        : [testing?.approach ?? "", testing?.confidence ?? 5];
    return [
      {
        type: LOOP_EVENT_TYPES.attempt,
        story,
        payload: defined({
          approach,
          result:
            input.approach !== undefined
              ? "started"
              : input.result === "green"
                ? "green"
                : "failed",
          note: input.approach !== undefined ? undefined : input.note,
          kind: HYPOTHESIS_KIND,
          confidence,
        }),
      },
    ];
  }
  if (input.approach !== undefined) {
    return [
      {
        type: LOOP_EVENT_TYPES.attempt,
        story,
        payload: { approach: input.approach, result: "started" },
      },
    ];
  }
  const approach = view.in_progress ?? "";
  const result = input.result === "green" ? "green" : "failed";
  const events: Array<{ type: string; story: string; payload: Record<string, unknown> }> = [
    {
      type: LOOP_EVENT_TYPES.attempt,
      story,
      payload: defined({ approach, result, note: input.note }),
    },
  ];
  if (result === "failed" && view.failed + 1 >= view.limit && view.open_point === null) {
    const last: AttemptRecord = {
      approach,
      result,
      ...(input.note === undefined ? {} : { note: input.note }),
      at: "",
      event: "",
    };
    events.push({
      type: CHECKPOINT_EVENT_TYPES.opened,
      story,
      payload: attemptLimitCheckpoint(story, [...view.failures, last]) as unknown as Record<
        string,
        unknown
      >,
    });
  }
  return events;
}

/** The line of an attempt's answer, from the attempts as they stand once it is written. */
function attemptLine(input: Call, after: AttemptsView): string {
  if (input.hypothesis !== undefined) {
    const { ruled_out: out, confirmed } = after.hypotheses;
    if (input.approach !== undefined) {
      return `Hypothesis put forward on story ${input.story}: ${out.length} ruled out so far. Test it, then say ruled_out or confirmed.`;
    }
    return confirmed !== null
      ? `Cause confirmed on story ${input.story}: ${confirmed.approach}. Fix it with a minimal change.`
      : `Hypothesis ruled out on story ${input.story} (${out.length} so far). Put forward another one.`;
  }
  if (input.approach !== undefined) {
    return `Approach started on story ${input.story}: ${after.failed} of ${after.limit} failed so far.`;
  }
  if (input.result === "green") return `Approach went green on story ${input.story}.`;
  return after.exhausted
    ? `Story ${input.story}: ${after.limit} approaches failed. The creator is asked before another one.`
    : `Approach failed on story ${input.story}: ${after.failed} of ${after.limit}. Try another way.`;
}

/**
 * Why an attempt is refused. The success condition is the engine's: an approach goes green only
 * when each acceptance criterion of the story holds, whatever the agent says.
 */
async function attemptProblem(
  context: CommandContext,
  state: State,
  input: Call,
): Promise<AgentPluggedError | undefined> {
  if (input.approach !== undefined) return startProblem(state, input);
  const refused = reportProblem(state, input);
  if (refused !== undefined || input.result !== "green" || input.hypothesis !== undefined) {
    return refused;
  }
  const trace = await criteriaTrace(context, state, input.story ?? "");
  // A story with no criterion the engine can follow has no condition to meet: nothing is green.
  if (trace === undefined) {
    return refuse(
      "seen",
      "no_condition (the story lists no acceptance criterion the engine can follow, or its text cannot be read): a story without a condition is for the creator to close",
    );
  }
  return unprovenCriteria(trace);
}

async function attempt(
  context: CommandContext,
  input: Readonly<Record<string, unknown>>,
  value: Call,
): Promise<CommandResult<LoopView>> {
  const writer = agentEventCommand({
    name: "loop",
    description: "",
    inputSchema: LoopInputSchema,
    needsState: () => true,
    replanned: true,
    events: (_value, state) => {
      if (state === undefined) return { events: [] };
      const problem =
        value.approach === undefined ? reportProblem(state, value) : startProblem(state, value);
      return { events: problem === undefined ? attemptEvents(state, value) : [] };
    },
    // Under the journal's lock: the story is still the caller's, the approach still new.
    check: (_value, state) => attemptProblem(context, state, value),
  });
  const early = await attemptProblem(context, await currentState(context), value);
  if (early !== undefined) return fail(early);
  const written = await writer.run(context, input);
  if (!written.ok) return fail(written.error);
  const story = value.story ?? "";
  const after = viewOf(await currentState(context), story);
  const reached = after.exhausted;
  const tried = triedLines(after);
  const ruledOut = ruledOutLines(after);
  return ok({
    verdict: "recorded",
    story,
    attempts: { failed: after.failed, limit: after.limit },
    ...(tried.length === 0 ? {} : { tried }),
    ...(ruledOut.length === 0 ? {} : { ruled_out: ruledOut }),
    ...(after.hypotheses.confirmed === null
      ? {}
      : { cause: truncate(after.hypotheses.confirmed.approach, 120) }),
    ...(reached && after.open_point !== null ? { reason: "attempts" as const } : {}),
    ...(reached && after.open_point !== null ? { subject: after.open_point } : {}),
    line: attemptLine(value, after),
  });
}

/** Where things stand when the loop stops: what was done since the creator last answered. */
function pointOf(next: NextStep, state: State): NonNullable<LoopView["point"]> {
  return {
    done: next.morning?.done_total ?? 0,
    decided: next.morning?.decided_total ?? 0,
    deferred: openDeferred(state).length,
  };
}

/** The line of a turn. */
function turnLine(view: Omit<LoopView, "line">): string {
  const waiting =
    view.waiting === undefined || view.waiting === 0
      ? ""
      : ` ${view.waiting} point${view.waiting === 1 ? "" : "s"} wait for the creator.`;
  const point =
    view.point === undefined
      ? ""
      : ` Since you last answered: ${view.point.done} stories done, ${view.point.decided} points decided by the agents, ${view.point.deferred} deferred items open.`;
  if (view.verdict === "done") return `Nothing is left to run.${point}`;
  if (view.verdict === "stop") {
    return `Stopped (${view.reason}) at ${view.subject ?? "the next step"}.${waiting}${point}`;
  }
  return `${view.step}${view.story === undefined ? "" : ` · story ${view.story}`}${view.agent === undefined ? "" : ` · ${view.agent}`}.${waiting}`;
}

async function turn(
  context: CommandContext,
  input: Readonly<Record<string, unknown>>,
  value: LoopInput,
): Promise<CommandResult<LoopView>> {
  if (value.agent !== NOAH_AGENT) return fail(roleForbidden(value.agent, "loop"));
  const next = await nextCommand.run(context, {});
  if (!next.ok) return fail(next.error);
  const state = await currentState(context);
  const checkpoints = checkpointsOf(state);
  // The points a budget opened are a spend, whatever their title says.
  const budgetPoints = new Set(
    Object.values(budgetThresholdsOf(state))
      .flat()
      .flatMap((entry) => (entry.checkpoint === null ? [] : [entry.checkpoint])),
  );
  const verdict = loopVerdict(
    next.value,
    checkpoints,
    (story) => viewOf(state, story),
    budgetPoints,
  );
  const event = turnEvent(verdict, loopStateOf(state));
  const resumed = event?.type === LOOP_EVENT_TYPES.resumed;
  if (event !== undefined) {
    // Two turns at the same instant could both write the same stop; the reducer takes it twice as
    // once, and the next turn finds it written.
    const writer = agentEventCommand({
      name: "loop",
      description: "",
      inputSchema: LoopInputSchema,
      events: () => ({ events: [event] }),
    });
    const written = await writer.run(context, input);
    if (!written.ok) return fail(written.error);
  }
  const attempts =
    verdict.verdict === "run" && verdict.story !== null ? viewOf(state, verdict.story) : undefined;
  const tried = attempts === undefined ? [] : triedLines(attempts);
  const ruledOut = attempts === undefined ? [] : ruledOutLines(attempts);
  // The success condition of the story: its criteria and where each stands.
  const trace =
    verdict.verdict === "run" && verdict.story !== null
      ? (await criteriaTrace(context, state, verdict.story).catch(() => undefined))?.line
      : undefined;
  const until = trace === undefined ? undefined : truncate(trace, 200);
  const view: Omit<LoopView, "line"> =
    verdict.verdict === "run"
      ? {
          verdict: "run",
          step: verdict.step,
          ...(verdict.agent === null ? {} : { agent: verdict.agent }),
          ...(verdict.story === null ? {} : { story: verdict.story }),
          ...(verdict.waiting === 0 ? {} : { waiting: verdict.waiting }),
          ...(resumed ? { resumed: true as const } : {}),
          ...(attempts === undefined || attempts.failed === 0
            ? {}
            : { attempts: { failed: attempts.failed, limit: attempts.limit } }),
          ...(tried.length === 0 ? {} : { tried }),
          ...(ruledOut.length === 0 ? {} : { ruled_out: ruledOut }),
          ...(until === undefined ? {} : { until }),
        }
      : verdict.verdict === "stop"
        ? {
            verdict: "stop",
            reason: verdict.reason,
            ...(verdict.subject === null ? {} : { subject: verdict.subject }),
            ...(verdict.waiting === 0 ? {} : { waiting: verdict.waiting }),
            point: pointOf(next.value, state),
          }
        : { verdict: "done", point: pointOf(next.value, state) };
  return ok({ ...view, line: turnLine(view) });
}

export const loopCommand: Command<LoopView> = defineCommand<LoopView>({
  name: "loop",
  audience: "agent",
  description:
    "The bounded loop. Noah's turn (`agent: noah`, nothing else): says what comes next from `next` and inscribes it. `verdict` `run` (do `step` for `story` with `agent`; `tried` lists the approaches that already failed on it, to put in the brief), `stop` (`reason`: validation, decision, merge, spend, irreversible, command, gap, creator_step: a point or a step of the creator's, present it; attempts: the story's approaches failed up to the limit; blocked; outside: the step is not the stories' work), `done` (nothing is left). A stop is written once with its reason; the first `run` after it writes the resumption. The developer of a story: `story` + `note` (a line) declares the approach you are about to try, then `story` + `seen` (`failed` with `note` saying why, or `green`) says how it ended. An approach that already failed is refused (INVALID_ARGUMENTS, `approach_failed`), and so is a fourth one: after 3 failed approaches the engine opens a point for the creator, who may allow 3 more. The cause of a bug: `story` + `seen` `hypothesis` + `note` `7/10 the hypothesis` (confidence 1 to 10) puts one forward, then `seen` `ruled_out` or `confirmed` with `note` the evidence closes it; one at a time, a ruled-out one is refused (`hypothesis_ruled_out`), and no approach starts before a cause is confirmed (`cause_unconfirmed`) once hypotheses exist; the answer lists `ruled_out` and the `cause`. It starts, merges and spends nothing. Refused: ROLE_FORBIDDEN (a turn is Noah's), INVALID_ARGUMENTS (`not_started`, `done`, `not_builder`, `approach_failed`, `attempt_open`, `attempts_exhausted`, `no_attempt_open`, `hypothesis_open`, `no_hypothesis_open`, `confidence_missing`, `evidence_missing`, `cause_unconfirmed`).",
  inputSchema: LoopInputSchema,
  async run(context, input) {
    const parsed = LoopInputSchema.safeParse(input);
    if (!parsed.success) return fail(invalidInput("loop", parsed.error));
    const value = parsed.data;
    const target = await agentWriteContext(context, value.agent);
    if (target instanceof AgentPluggedError) return fail(target);
    try {
      if (value.story === undefined) return await turn(context, input, value);
      return await attempt(context, input, callOf(value));
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    }
  },
});

export const loopAgentCommands = [loopCommand] as const;
