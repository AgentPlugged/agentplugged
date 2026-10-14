import {
  CRITERION_EVENT_TYPES,
  type CriterionResult,
  criterionId,
  type ProjectionState,
  QA_COMMAND,
  RecordCriterionInputSchema,
} from "@agentplugged/protocol";
import {
  agentEventCommand,
  agentWriteContext,
  defined,
  invalidInput,
} from "../agent-activity/agent-commands.js";
import { currentDeveloper } from "../agents/agent-aliases.js";
import { type Command, type CommandContext, defineCommand, fail, ok } from "../command.js";
import { currentState } from "../deferred/deferred-commands.js";
import { AgentPluggedError } from "../errors.js";
import { storiesIn } from "../projection/agent-reducers.js";
import { proofDecisions, standingOf } from "../proofs/proof-accord.js";
import { type DeclaredProofCommand, readProofDeclaration } from "../proofs/proof-declaration.js";
import { lineForCriterion, runsCriteria } from "../proofs/proof-line.js";
import { usefulLines } from "../proofs/proof-output.js";
import { execute, type Outcome, passed, runOf } from "../proofs/proof-run-command.js";
import type { ProofRunner, WorkingCopy } from "../proofs/proof-runner.js";
import { invalid } from "../requirements/requirement-commands.js";
import { storyText } from "../stories/story-text.js";
import { type CriterionStatus, criterionStatus } from "./criterion-rules.js";
import { criteriaTrace } from "./criterion-trace.js";

/**
 * `record_criterion`: the test of an acceptance criterion, seen failing before the
 * code and passing after it, and the engine saw it. When the project has a test command the creator
 * accepted whose line holds `{criterion}` (the proof commands), the engine starts it, filtered on
 * the criterion, in the story's working copy, and inscribes the run itself: exit code, duration,
 * commit, whether the copy was clean, a short masked summary. Without one, the agent says what it
 * saw and the result is marked `reported`. A criterion with no result to observe through the
 * interface is declared untestable, with its reason; the review looks at it.
 */

type State = ProjectionState["state"];

/** What `record_criterion` answers. */
export interface CriterionView {
  readonly story: string;
  readonly criterion: number;
  /** What was recorded; `none` when the run said nothing (stopped at its time limit, never started). */
  readonly result: CriterionResult | "none";
  readonly origin: "engine" | "reported";
  /** Where the criterion stands now (`never_red`: it passes and was never seen failing). */
  readonly status: CriterionStatus;
  /** The engine's run, when it made one. */
  readonly ended?: "exit" | "timeout" | "error";
  readonly exit?: number | null;
  readonly seconds?: number;
  /** What the agent expected (`seen`) when the run said otherwise. */
  readonly expected?: CriterionResult;
  /** The working copy had changes not committed. */
  readonly unclean?: true;
  /** The lines that matter when the test fails, at most 12 of 160 characters. */
  readonly lines?: readonly string[];
  /** The local file that keeps the whole output (secrets masked), outside the journal. */
  readonly log?: string;
  /** Why the result is the agent's word, not the engine's, when a command is declared. */
  readonly hint?: string;
  /** The trace of the story's criteria, one bounded line. */
  readonly trace?: string;
}

/** How the result will be obtained. */
type Mode =
  | { readonly kind: "run"; readonly command: DeclaredProofCommand; readonly runner: ProofRunner }
  | { readonly kind: "report"; readonly seen: CriterionResult; readonly hint?: string };

/** What was found out before anything is written. */
interface Plan {
  readonly story: string;
  readonly n: number;
  readonly mode: Mode;
  /** The story's working copy: where the tests are, as `story.started` recorded it. */
  readonly workspace: string | undefined;
}

const refuse = (field: string, reason: string): AgentPluggedError =>
  invalid("record_criterion", field, reason);

/** The accepted command that runs the tests of a criterion, and a declared one that is not accepted. */
export async function criterionCommand(
  context: CommandContext,
  state: State,
): Promise<{ accepted?: DeclaredProofCommand; waiting?: DeclaredProofCommand }> {
  const declaration = await readProofDeclaration(context.files);
  if (declaration.kind !== "commands") return {};
  const decisions = proofDecisions(state);
  // The command named `qa` plays a criterion in a browser: it is not the tests of the cycle.
  const mine = declaration.commands.filter(
    (command) => runsCriteria(command.run) && command.name !== QA_COMMAND,
  );
  const accepted = mine.find((command) => standingOf(command, decisions) === "accepted");
  const waiting = mine.find((command) => standingOf(command, decisions) !== "accepted");
  return {
    ...(accepted === undefined ? {} : { accepted }),
    ...(waiting === undefined ? {} : { waiting }),
  };
}

/** The story is the caller's, started and not merged; the criterion is one it lists. */
async function planCriterion(
  context: CommandContext,
  state: State,
  input: { agent: string; story: string; criterion: number; seen?: string; note?: string },
): Promise<Plan | AgentPluggedError> {
  const story = storiesIn(state)[input.story];
  const started = story?.started;
  if (started === undefined) return refuse("story", "not_started");
  if (story?.merged !== undefined) return refuse("story", "done");
  if (currentDeveloper(started.agent) !== currentDeveloper(input.agent)) {
    return refuse("story", `not_builder (the developer is ${started.agent})`);
  }
  const text = await storyText(context, state, input.story, (context.now ?? Date.now)());
  if (text === undefined)
    return refuse("story", "not_readable (no such story in .agentplugged/stories/)");
  if (input.criterion > text.listed.length) {
    return refuse(
      "criterion",
      `unknown_criterion:${input.criterion} (the story lists ${text.listed.length})`,
    );
  }
  const workspace = started.worktree === "." ? undefined : started.worktree;
  const base = { story: input.story, n: input.criterion, workspace };
  if (input.seen === "untestable") {
    return { ...base, mode: { kind: "report", seen: "untestable" } };
  }
  const { accepted, waiting } = await criterionCommand(context, state);
  if (accepted !== undefined && context.proofRunner !== undefined) {
    return { ...base, mode: { kind: "run", command: accepted, runner: context.proofRunner } };
  }
  const hint =
    waiting === undefined
      ? undefined
      : `${waiting.name} is declared but not accepted: ask the creator once, guard.creator_action {kind: proof_commands}`;
  if (input.seen === undefined || input.note === undefined) {
    return refuse(
      "seen",
      `no_command_to_run: say what you saw (seen: red or green, note: the test you ran), reported as your word${hint === undefined ? "; or declare a test command with {criterion} in .agentplugged/proofs.yaml and ask the creator to accept it" : `; ${hint}`}`,
    );
  }
  return {
    ...base,
    mode: {
      kind: "report",
      seen: input.seen as CriterionResult,
      ...(hint === undefined ? {} : { hint }),
    },
  };
}

/** The payload of the event for the plan and what the engine ran. */
function payloadOf(
  plan: Plan,
  input: { note?: string },
  prepared: { readonly outcome?: Outcome; readonly copy?: WorkingCopy },
): Record<string, unknown> | undefined {
  const { mode } = plan;
  const copy = prepared.outcome?.copy ?? prepared.copy ?? {};
  if (mode.kind === "run") {
    const outcome = prepared.outcome;
    if (outcome === undefined || outcome.result.ended !== "exit") return undefined;
    return defined({
      criterion: plan.n,
      result: passed(outcome.result) ? "green" : "red",
      origin: "engine",
      commit: copy.commit,
      clean: copy.clean,
      run: runOf(mode.command, outcome),
    });
  }
  return defined({
    criterion: plan.n,
    result: mode.seen,
    origin: "reported",
    test: mode.seen === "untestable" ? undefined : input.note,
    reason: mode.seen === "untestable" ? input.note : undefined,
    commit: copy.commit,
    clean: copy.clean,
  });
}

function viewOf(
  plan: Plan,
  prepared: { readonly outcome?: Outcome },
  recorded: CriterionResult | undefined,
  expected: string | undefined,
): Omit<CriterionView, "status" | "trace"> {
  const outcome = prepared.outcome;
  const run = outcome?.result;
  const lines =
    outcome === undefined || run === undefined || passed(run) ? [] : usefulLines(outcome.output);
  return {
    story: plan.story,
    criterion: plan.n,
    result: recorded ?? "none",
    origin: plan.mode.kind === "run" ? "engine" : "reported",
    ...(run === undefined
      ? {}
      : { ended: run.ended, exit: run.exit, seconds: Math.round(run.ms / 100) / 10 }),
    ...(expected !== undefined && expected !== recorded
      ? { expected: expected as CriterionResult }
      : {}),
    ...(outcome?.copy.clean === false ? { unclean: true as const } : {}),
    ...(lines.length === 0 ? {} : { lines }),
    ...(outcome?.log === undefined ? {} : { log: outcome.log }),
    ...(plan.mode.kind === "report" && plan.mode.hint !== undefined
      ? { hint: plan.mode.hint }
      : {}),
  };
}

export const recordCriterionCommand: Command<CriterionView> = defineCommand<CriterionView>({
  name: "record_criterion",
  audience: "agent",
  description:
    "Record the test of an acceptance criterion of your story, seen failing before the code (red) and passing after it (green); a test that never failed proves nothing. `story`, `criterion` (its number in the story, from 1), `agent`. The test's name or a comment holds the id of the criterion: AC-<story>-<n> (AC-17-3-2), or AC_17_3_2 where a name takes no dash. When the project declares a test command with {criterion} in its line (.agentplugged/proofs.yaml) and the creator accepted it (guard.creator_action {kind: proof_commands}), the engine runs it itself in your story's working copy, filtered on the criterion, and inscribes the run (exit code, duration, commit, a short masked summary): give nothing else (`seen` is what you expect, the answer says `expected` when the run says otherwise). Without one, give `seen` (red or green) and `note` (the test you ran): your word, marked `reported`. `seen: untestable` with `note` (the reason) declares a criterion with no result to observe through the interface: the review looks at it. Answers `result`, `origin`, `status` (no_test, not_run, never_red, red, green, no_change, covered, untestable), `ended`, `exit`, `seconds`, when it failed `lines` (at most 12), `log` (the whole output, a local file), and `trace`: every criterion of the story in one line. A run stopped at its time limit or never started records nothing (`result: none`). The story goes to review only when each criterion is green or untestable (CRITERIA_NOT_PROVEN); in the quick lane a passing test is enough (`covered`). Refused: INVALID_ARGUMENTS (`not_started`, `done`, `not_builder`, `not_readable`, `unknown_criterion`, `no_command_to_run`, `not_accepted`).",
  inputSchema: RecordCriterionInputSchema,
  async run(context, input) {
    const parsed = RecordCriterionInputSchema.safeParse(input);
    if (!parsed.success) return fail(invalidInput("record_criterion", parsed.error));
    const value = parsed.data;
    const target = await agentWriteContext(context, value.agent);
    if (target instanceof AgentPluggedError) return fail(target);
    try {
      const plan = await planCriterion(context, await currentState(context), value);
      if (plan instanceof AgentPluggedError) return fail(plan);
      const { mode } = plan;
      let outcome: Outcome | undefined;
      let copy: WorkingCopy | undefined;
      if (mode.kind === "run") {
        outcome = await execute(context, mode.command, mode.runner, {
          line: lineForCriterion(mode.command.run, criterionId(plan.story, plan.n)),
          ...(plan.workspace === undefined ? {} : { workspace: plan.workspace }),
        });
      } else if (context.proofRunner !== undefined) {
        copy = await context.proofRunner.workingCopy(plan.workspace).catch((): WorkingCopy => ({}));
      }
      const prepared = {
        ...(outcome === undefined ? {} : { outcome }),
        ...(copy === undefined ? {} : { copy }),
      };
      const payload = payloadOf(plan, value, prepared);
      let recorded: CriterionResult | undefined;
      if (payload !== undefined) {
        const writer = agentEventCommand({
          name: "record_criterion",
          description: "",
          inputSchema: RecordCriterionInputSchema,
          needsState: () => true,
          events: () => ({
            events: [{ type: CRITERION_EVENT_TYPES.recorded, story: plan.story, payload }],
          }),
          // Under the journal's lock: the accord still holds, and the story is still the caller's.
          check: (_value, state) => {
            const started = storiesIn(state)[plan.story]?.started;
            if (started === undefined) return refuse("story", "not_started");
            if (plan.mode.kind === "run") {
              if (standingOf(plan.mode.command, proofDecisions(state)) !== "accepted") {
                return refuse("command", `not_accepted:${plan.mode.command.name}`);
              }
            }
            return undefined;
          },
        });
        const written = await writer.run(context, input);
        if (!written.ok) return fail(written.error);
        recorded = payload.result as CriterionResult;
      }
      const state = await currentState(context);
      const trace = await criteriaTrace(context, state, plan.story);
      const record = storiesIn(state)[plan.story]?.criteria?.[String(plan.n)];
      const cited = trace?.criteria.find((entry) => entry.n === plan.n);
      const status = cited?.status ?? criterionStatus(record, null, false);
      return ok({
        ...viewOf(plan, prepared, recorded, value.seen),
        status,
        ...(trace === undefined ? {} : { trace: trace.line }),
      });
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    }
  },
});

/** The agents' commands of the criteria, exposed as MCP actions after the others. */
export const criterionAgentCommands = [recordCriterionCommand] as const;
