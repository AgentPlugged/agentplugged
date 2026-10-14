import {
  CREATOR_OWNER,
  DEFAULT_MUTATION_SECONDS,
  DEFAULT_MUTATIONS,
  DEFERRED_EVENT_TYPES,
  type ProjectionState,
  ReviewTestsInputSchema,
  TEST_REVIEW_EVENT_TYPES,
} from "@agentplugged/protocol";
import {
  agentEventCommand,
  agentWriteContext,
  defined,
  type EventSpec,
  invalidInput,
} from "../agent-activity/agent-commands.js";
import { branchHead } from "../ci/ci-check.js";
import { type Command, type CommandContext, defineCommand, fail, ok } from "../command.js";
import { criterionCommand } from "../criteria/criterion-command.js";
import { criteriaTrace, type StoryTrace } from "../criteria/criterion-trace.js";
import { currentState } from "../deferred/deferred-commands.js";
import { deferredView } from "../deferred/deferred-rules.js";
import { readDocumentFiles } from "../docs/docs-command.js";
import { parseDocumentFile } from "../docs/parse-document.js";
import { AgentPluggedError } from "../errors.js";
import { storiesIn } from "../projection/agent-reducers.js";
import { proofDecisions, standingOf } from "../proofs/proof-accord.js";
import { type DeclaredProofCommand, readProofDeclaration } from "../proofs/proof-declaration.js";
import { lineForCriterion, parseCommandLine, runsCriteria } from "../proofs/proof-line.js";
import { invalid } from "../requirements/requirement-commands.js";
import { parseDiff } from "../review/review-rules.js";
import { storyText } from "../stories/story-text.js";
import { testReferences } from "../trace/test-references.js";
import { traceSummaries } from "../trace/trace-rules.js";
import {
  type ChangedFile,
  type MutationReport,
  mutationCounts,
  runMutationCheck,
} from "./mutation-run.js";
import { addedLines } from "./mutations.js";
import { type Gap, gapLines, MAX_PROPOSED, type RequirementState, testGaps } from "./test-gaps.js";
import { type GridMark, markGrid, validateGrid } from "./test-grid.js";

/**
 * `review_tests`: are the tests of a story, or of the product, good, and not only
 * green. The engine does the work and the agent spends no token on it: it validates and marks the
 * graded review the agent filled, breaks the code the story changed in a throwaway copy and runs
 * the tests the creator accepted (a break no test noticed is a finding), and lists the holes of the
 * coverage tied to the criteria and requirements. The holes can be recorded as work to decide, one
 * gesture each, in the register of deferred work.
 */

type State = ProjectionState["state"];

/** What `review_tests` answers: bounded, the detail is the journal's. */
export interface TestsView {
  /** The story reviewed, or `product`. */
  readonly scope: string;
  readonly commit?: string;
  readonly grid?: {
    readonly score: number;
    readonly grade: string;
    readonly verdict: string;
    /** `active 100, assertions 60, speed n/a`. */
    readonly criteria: string;
    readonly findings: number;
    /** The worst findings, one line each. */
    readonly lines: readonly string[];
  };
  readonly mutation?: {
    readonly status: string;
    readonly reason?: string;
    /** Proposed in the change, run, killed, survived. */
    readonly proposed: number;
    readonly ran: number;
    readonly killed: number;
    readonly survived: number;
    readonly errors?: number;
    readonly seconds?: number;
    /** The copy could not be removed: where it was left. */
    readonly leftover?: string;
  };
  /** The holes, one line each (the breaks no test noticed first), bounded. */
  readonly gaps: readonly string[];
  readonly gapCount: number;
  /** The holes recorded as work to propose to the creator in this call. */
  readonly proposed?: number;
}

const refuse = (field: string, reason: string): AgentPluggedError =>
  invalid("review_tests", field, reason);

/** Criteria of the story and requirements in scope with their tests: the engine reads them, no agent. */
async function requirementStates(
  context: CommandContext,
  state: State,
  workspace: string | undefined,
  only: readonly string[] | undefined,
): Promise<RequirementState[]> {
  try {
    const source = context.testReferences;
    let references: ReturnType<typeof testReferences> | null = null;
    if (source !== undefined) {
      const read = await source.read(workspace);
      references = read.found ? testReferences(read.lines, read.files) : null;
    }
    const files = await readDocumentFiles(context.files, true);
    const documents = files.map((file) => parseDocumentFile(file.path, file.text));
    const summaries = traceSummaries({ documents, state, references });
    return summaries
      .filter((summary) =>
        only === undefined ? summary.status !== "todo" : only.includes(summary.id),
      )
      .map((summary) => ({ id: summary.id, tests: summary.tests }));
  } catch {
    return [];
  }
}

/** The declared command that runs the tests of the check, accepted as it stands, or why not. */
async function acceptedCommand(
  context: CommandContext,
  state: State,
  name: string | undefined,
): Promise<DeclaredProofCommand | AgentPluggedError> {
  if (name === undefined) {
    const { accepted, waiting } = await criterionCommand(context, state);
    if (accepted !== undefined) return accepted;
    return refuse(
      "command",
      waiting === undefined
        ? "no_command_to_run: declare a test command with {criterion} in .agentplugged/proofs.yaml and ask the creator to accept it (guard.creator_action {kind: proof_commands})"
        : `not_accepted:${waiting.name} (ask the creator once: guard.creator_action {kind: proof_commands})`,
    );
  }
  const declaration = await readProofDeclaration(context.files);
  if (declaration.kind !== "commands") {
    return refuse("command", "no_command_declared: write .agentplugged/proofs.yaml");
  }
  const command = declaration.commands.find((entry) => entry.name === name);
  if (command === undefined) return refuse("command", `unknown_command:${name}`);
  if (standingOf(command, proofDecisions(state)) !== "accepted") {
    return refuse(
      "command",
      `not_accepted:${name} (ask the creator: guard.creator_action {kind: proof_commands})`,
    );
  }
  return command;
}

/** The mutation check of a started story, or a report saying why it did not run. */
async function mutationOf(
  context: CommandContext,
  state: State,
  story: string,
  input: { command?: string; max?: number; seconds?: number },
): Promise<MutationReport | AgentPluggedError> {
  const started = storiesIn(state)[story]?.started;
  const refused = (reason: string): MutationReport => ({
    status: "refused",
    reason,
    proposed: 0,
    results: [],
  });
  if (started === undefined) return refuse("story", "not_started");
  if (storiesIn(state)[story]?.merged !== undefined) return refused("story_done");
  const lab = context.mutationLab;
  if (lab === undefined) return refused("no_lab (the check runs in the MCP server)");
  const command = await acceptedCommand(context, state, input.command);
  if (command instanceof AgentPluggedError) return command;
  const line = runsCriteria(command.run)
    ? lineForCriterion(command.run, `AC-${story}-`)
    : command.run;
  const parsed = parseCommandLine(line);
  if (parsed.kind === "invalid") return refused(`command_unreadable:${parsed.reason}`);
  const workspace = context.storyWorkspace;
  const source = context.storyDiff;
  if (workspace === undefined || source === undefined) return refused("no_diff");
  const head = await branchHead(workspace, story, started.branch).catch(
    (error: unknown) => error as AgentPluggedError,
  );
  if (typeof head !== "string") return refused("branch_missing");
  // The lines the diff says were added are those of the branch's head: the tree must be there.
  const tree = await context.proofRunner
    ?.workingCopy(started.worktree === "." ? undefined : started.worktree)
    .catch(() => undefined);
  if (tree !== undefined && (tree.clean === false || (tree.commit ?? head) !== head)) {
    return refused("tree_not_at_the_branch_head (commit or put aside what is not committed)");
  }
  const diff = await source.diff(started.base, head, started.base_ref).catch(() => undefined);
  if (diff === undefined) return refused("no_diff");
  const files: ChangedFile[] = parseDiff(diff)
    .map((file) => ({ path: file.path, added: addedLines(file.lines) }))
    .filter((file) => file.added.size > 0);
  return runMutationCheck(lab, {
    story,
    ...(started.worktree === "." ? {} : { workspace: started.worktree }),
    line,
    argv: parsed.kind === "argv" ? parsed.argv : null,
    cwd: command.cwd,
    commandTimeoutMs: command.timeout * 1000,
    files,
    max: input.max ?? DEFAULT_MUTATIONS,
    seconds: input.seconds ?? DEFAULT_MUTATION_SECONDS,
    now: context.now ?? Date.now,
  });
}

function criteriaText(mark: GridMark): string {
  return mark.criteria
    .map((entry) => `${entry.criterion} ${entry.score === null ? "n/a" : entry.score}`)
    .join(", ");
}

function viewOf(
  scope: string,
  commit: string | undefined,
  mark: GridMark | undefined,
  grid: { findings: number } | undefined,
  mutation: MutationReport | undefined,
  gaps: readonly Gap[],
  proposed: number | undefined,
): TestsView {
  const counts = mutation === undefined ? undefined : mutationCounts(mutation);
  return {
    scope,
    ...(commit === undefined ? {} : { commit }),
    ...(mark === undefined || grid === undefined
      ? {}
      : {
          grid: {
            score: mark.score,
            grade: mark.grade,
            verdict: mark.verdict,
            criteria: criteriaText(mark),
            findings: grid.findings,
            lines: mark.lines,
          },
        }),
    ...(mutation === undefined || counts === undefined
      ? {}
      : {
          mutation: {
            status: mutation.status,
            ...(mutation.reason === undefined ? {} : { reason: mutation.reason }),
            proposed: mutation.proposed,
            ran: counts.ran,
            killed: counts.killed,
            survived: counts.survived,
            ...(counts.errors === 0 ? {} : { errors: counts.errors }),
            ...(mutation.baselineSeconds === undefined
              ? {}
              : { seconds: mutation.baselineSeconds }),
            ...(mutation.leftover === undefined ? {} : { leftover: mutation.leftover }),
          },
        }),
    gaps: gapLines(gaps),
    gapCount: gaps.length,
    ...(proposed === undefined ? {} : { proposed }),
  };
}

/** The events of a review: its record and, on demand, each hole as work to decide. */
function eventsOf(
  scope: string,
  commit: string | undefined,
  mark: GridMark | undefined,
  findings: number | undefined,
  mutation: MutationReport | undefined,
  gaps: readonly Gap[],
  propose: Gap[],
  state: State | undefined,
): EventSpec[] {
  const counts = mutation === undefined ? undefined : mutationCounts(mutation);
  const events: EventSpec[] = [
    {
      type: TEST_REVIEW_EVENT_TYPES.reviewed,
      payload: defined({
        story: scope === "product" ? undefined : scope,
        commit,
        score: mark?.score,
        grade: mark?.grade,
        verdict: mark?.verdict,
        criteria:
          mark === undefined
            ? undefined
            : mark.criteria.flatMap((entry) =>
                entry.score === null ? [] : [{ criterion: entry.criterion, score: entry.score }],
              ),
        findings,
        // Only a check that ran: a refused one is not "no break survived".
        mutation:
          counts === undefined || counts.ran === 0
            ? undefined
            : { ran: counts.ran, killed: counts.killed, survived: counts.survived },
        gaps: Math.min(gaps.length, 1000),
      }),
    },
  ];
  // Work already proposed and still open is not proposed twice (a review run again).
  const open = new Set(deferredView(state ?? {}).open.map((item) => item.title));
  for (const gap of propose) {
    if (open.has(gap.title)) continue;
    open.add(gap.title);
    events.push({
      type: DEFERRED_EVENT_TYPES.recorded,
      payload: {
        title: gap.title,
        detail: gap.detail,
        origin: "deliberate",
        owner: CREATOR_OWNER,
        locks: [],
      },
    });
  }
  return events;
}

export const reviewTestsCommand: Command<TestsView> = defineCommand<TestsView>({
  name: "review_tests",
  audience: "agent",
  description:
    "Review the tests of a story (`story`) or of the product: are they good, not only green. The engine does the work, you spend no token on it. `check` holds the three parts. `check.grid`: your graded review, whole: `reads` (the test files you read), `criteria` (one entry for each of active, assertions, determinism, isolation, readability, speed, data, risk: `ok`, `issues` or `not_applicable` with its `note`) and `findings` (`criterion`, `row`, `test`: path:line and its name, `reason`, `fix`); the rows are fixed (skipped, focused, no_assertion, tautology, self_mock, unreachable, shape_only, conditional, unawaited, hard_wait, wall_clock, uncontrolled, navigate_then_read, fragile_selector, shared_state, order_dependent, leftover, real_service, oversize, multi_concern, deep_nesting, ungrouped, vague_name, magic_value, slow, heavy_setup, real_data, repeated_payload, hidden_data, denied_untested, happy_path_only, wrong_level, raw_event) and carry their own weight: you never give a mark, the engine does (a mark per criterion, a global mark, a grade, a verdict). A grid that is not whole is refused with what is missing. `check.mutation` ({max, seconds, command}, all optional): the engine breaks the code the story changed (a comparison, a condition, a boolean, a constant, a return), one break at a time in a throwaway copy, and runs the test command the creator accepted (the one with {criterion}, else the declared `command` you name), up to `max` breaks (8, 30 at most) within `seconds` (300, 1 800 at most); a break no test noticed survives and is a finding (file, line, break). The creator's folder is never changed. Answers the marks, the counts of the check and `gaps`: the criteria and requirements with no test, whose test never failed, or whose tests killed no break, one line each. `check.propose`: records each hole as work to decide in the register of deferred work, one gesture each. Refused: INVALID_ARGUMENTS (`grid`: what is missing, `not_started`, `no_command_to_run`, `not_accepted`).",
  inputSchema: ReviewTestsInputSchema,
  async run(context, input) {
    const parsed = ReviewTestsInputSchema.safeParse(input);
    if (!parsed.success) return fail(invalidInput("review_tests", parsed.error));
    const value = { ...parsed.data, ...parsed.data.check };
    const target = await agentWriteContext(context, value.agent);
    if (target instanceof AgentPluggedError) return fail(target);
    try {
      if (value.grid !== undefined) {
        const problems = validateGrid(value.grid);
        if (problems.length > 0) {
          return fail(refuse("grid", `not whole (${problems.length}): ${problems.join("; ")}`));
        }
      }
      const state = await currentState(context);
      const scope = value.story ?? "product";
      const story = value.story === undefined ? undefined : storiesIn(state)[value.story];
      if (value.story !== undefined && story?.started === undefined) {
        return fail(refuse("story", "not_started"));
      }
      if (value.mutation !== undefined && value.story === undefined) {
        return fail(
          refuse("mutation", "the mutation check needs a story: its changes are what it breaks"),
        );
      }
      const workspace =
        story?.started === undefined || story.started.worktree === "."
          ? undefined
          : story.started.worktree;
      let mutation: MutationReport | undefined;
      if (value.mutation !== undefined && value.story !== undefined) {
        const made = await mutationOf(context, state, value.story, value.mutation);
        if (made instanceof AgentPluggedError) return fail(made);
        mutation = made;
      }
      let trace: StoryTrace | undefined;
      let only: string[] | undefined;
      if (value.story !== undefined) {
        trace = await criteriaTrace(context, state, value.story);
        const text = await storyText(context, state, value.story, (context.now ?? Date.now)());
        only = [...(text?.requirements ?? [])];
      }
      const requirements = await requirementStates(context, state, workspace, only);
      const gaps = testGaps({
        ...(value.story === undefined ? {} : { story: value.story }),
        ...(trace === undefined ? {} : { criteria: trace.criteria }),
        requirements,
        ...(mutation === undefined ? {} : { mutation }),
      });
      const mark = value.grid === undefined ? undefined : markGrid(value.grid);
      const commit =
        value.story === undefined
          ? undefined
          : await context.proofRunner
              ?.workingCopy(workspace)
              .then((copy) => copy.commit)
              .catch(() => undefined);
      const propose = value.propose === true ? gaps.slice(0, MAX_PROPOSED) : [];
      const record = value.grid !== undefined || mutation !== undefined || propose.length > 0;
      let proposed: number | undefined;
      if (record) {
        let written = 0;
        const writer = agentEventCommand({
          name: "review_tests",
          description: "",
          inputSchema: ReviewTestsInputSchema,
          needsState: () => true,
          events: (_value, current) => {
            const events = eventsOf(
              scope,
              commit,
              mark,
              value.grid?.findings.length,
              mutation,
              gaps,
              propose,
              current,
            );
            written = events.length - 1;
            return { events };
          },
        });
        const recorded = await writer.run(context, input);
        if (!recorded.ok) return fail(recorded.error);
        if (value.propose === true) proposed = written;
      }
      return ok(
        viewOf(
          scope,
          commit,
          mark,
          value.grid === undefined ? undefined : { findings: value.grid.findings.length },
          mutation,
          gaps,
          proposed,
        ),
      );
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    }
  },
});

/** The agents' commands of the quality of the tests, exposed as MCP actions after the others. */
export const qualityAgentCommands = [reviewTestsCommand] as const;
