import {
  type ProjectionState,
  type ProofKind,
  type ProofResult,
  type ProofRun,
  REQUIREMENT_EVENT_TYPES,
  type RequirementBudget,
  RunProofCommandInputSchema,
} from "@agentplugged/protocol";
import {
  agentEventCommand,
  agentWriteContext,
  defined,
  type EventSpec,
  invalidInput,
} from "../agent-activity/agent-commands.js";
import { type Command, type CommandContext, defineCommand, fail, ok } from "../command.js";
import { currentState } from "../deferred/deferred-commands.js";
import { maskSecrets } from "../doctor/support-report.js";
import { AgentPluggedError, unexpected } from "../errors.js";
import { METHOD_DIR } from "../init/layout.js";
import {
  citingTests,
  invalid,
  itemOf,
  UNKNOWN_DIGEST,
} from "../requirements/requirement-commands.js";
import { measureResult } from "../requirements/requirement-rules.js";
import { proofDecisions, standingOf } from "./proof-accord.js";
import {
  type DeclaredProofCommand,
  PROOFS_PATH,
  readProofDeclaration,
} from "./proof-declaration.js";
import { parseCommandLine, runsCriteria } from "./proof-line.js";
import { lastLine, measuredAfter, safeOutput, usefulLines } from "./proof-output.js";
import {
  MAX_PROOF_OUTPUT_BYTES,
  type ProofRunner,
  type ProofRunResult,
  type WorkingCopy,
} from "./proof-runner.js";

/**
 * `run_proof_command`: the engine runs a command the project declares in
 * `.agentplugged/proofs.yaml`, once the creator accepted its exact line, and inscribes the proof
 * itself. Nothing an agent says about the result enters the journal: the exit code, the duration,
 * the commit tested, whether the copy was clean and a short, masked summary are the engine's own.
 * The agent gets the verdict, the duration and, on a failure, the few lines that matter; the whole
 * output stays in a local file outside the journal.
 */

type State = ProjectionState["state"];

/** The folder of the local files that keep the whole output of the runs. Ignored by Git. */
export const PROOF_RUNS_DIR = `${METHOD_DIR}/.cache/proof-runs`;
/** The most run files kept; the oldest go first. */
const MAX_KEPT_RUNS = 30;

/** A requirement the run will record a proof for, as the register held it when the run was planned. */
interface PlannedItem {
  readonly id: string;
  readonly kind: ProofKind;
  readonly budget: RequirementBudget | null;
  readonly digest: string;
}

/** What is checked before anything is started. */
interface Plan {
  readonly command: DeclaredProofCommand;
  readonly runner: ProofRunner;
  readonly items: readonly PlannedItem[];
  /** `id:why` for the requirements this command names that the engine cannot prove by running it. */
  readonly skipped: readonly string[];
}

/** What the run left, before it is turned into events. */
export interface Outcome {
  readonly result: ProofRunResult;
  readonly copy: WorkingCopy;
  /** The output as it may be kept and shown: cleaned, secrets masked. */
  readonly output: string;
  readonly log?: string;
  readonly measured?: number;
}

/** What `run_proof_command` answers. */
export interface ProofRunView {
  readonly command: string;
  /** True when the command exited with 0 within its time limit. */
  readonly ok: boolean;
  readonly ended: "exit" | "timeout" | "error";
  readonly exit: number | null;
  readonly seconds: number;
  /** The requirements the run proved, and those it failed. */
  readonly proved: readonly string[];
  readonly failed: readonly string[];
  /** `id:why`: named by the command but not provable by running it. */
  readonly skipped?: readonly string[];
  /** The working copy had changes not committed: the proof is for that state, not for the commit. */
  readonly unclean?: true;
  /** The lines that matter when it failed, at most 12 of 160 characters. */
  readonly lines?: readonly string[];
  /** The local file that keeps the whole output (secrets masked), outside the journal. */
  readonly log?: string;
}

function refuse(field: string, reason: string): AgentPluggedError {
  return invalid("run_proof_command", field, reason);
}

/** Why the engine cannot prove a requirement of the register by running a command, or undefined. */
async function unprovable(
  context: CommandContext,
  state: State,
  id: string,
): Promise<{ readonly item?: PlannedItem; readonly why?: string }> {
  const item = itemOf(state, id);
  if (item === undefined) return { why: "not_in_the_register" };
  if (item.proof === "review") return { why: "review_comes_from_an_audit" };
  if (item.proof === "ci") return { why: "ci_comes_from_the_ci" };
  if (item.proof === "measure" && item.budget === null) return { why: "no_budget" };
  if (item.proof === "test") {
    const tests = await citingTests(context, id);
    if (tests === null || tests.length === 0) return { why: "no_test_cites_it" };
  }
  return {
    item: { id, kind: item.proof, budget: item.budget, digest: item.digest },
  };
}

/**
 * What must hold before the command starts: it is declared, the creator accepted this very line
 * (never a pending, a modified or a refused one), there is a runner here, and at least one
 * requirement it names can be proved by running it.
 */
async function planRun(context: CommandContext, name: string): Promise<Plan | AgentPluggedError> {
  const declaration = await readProofDeclaration(context.files);
  if (declaration.kind === "none") {
    return refuse(
      "command",
      `no_command_declared: write ${PROOFS_PATH} (commands: name, run, proves), then ask the creator`,
    );
  }
  if (declaration.kind === "invalid") {
    return refuse("command", `${PROOFS_PATH} is not valid: ${declaration.problems.join("; ")}`);
  }
  const command = declaration.commands.find((entry) => entry.name === name);
  if (command === undefined) {
    return refuse(
      "command",
      `unknown_command:${name} (declared: ${declaration.commands.map((entry) => entry.name).join(", ")})`,
    );
  }
  if (runsCriteria(command.run)) {
    return refuse(
      "command",
      `runs_criteria:${name} (it runs the tests of a criterion: story.criterion)`,
    );
  }
  const state = await currentState(context);
  const standing = standingOf(command, proofDecisions(state));
  if (standing === "refused") {
    return refuse(
      "command",
      `refused_by_the_creator:${name} (change the line, or ask again naming it: guard.creator_action {kind: proof_commands, commands: [${name}]})`,
    );
  }
  if (standing === "pending") {
    return refuse(
      "command",
      `not_accepted:${name} (new or modified: ask the creator once for all such lines with guard.creator_action {kind: proof_commands})`,
    );
  }
  const runner = context.proofRunner;
  if (runner === undefined) return unexpected("the project's commands cannot be run here");
  const items: PlannedItem[] = [];
  const skipped: string[] = [];
  for (const id of command.proves) {
    const found = await unprovable(context, state, id);
    if (found.item !== undefined) items.push(found.item);
    else skipped.push(`${id}:${found.why ?? "unknown"}`);
  }
  if (items.length === 0) {
    return refuse("command", `nothing_to_prove: ${skipped.join(", ")}`);
  }
  return { command, runner, items, skipped };
}

/** The name of the local file of a run: the command and the time, sortable. */
function logPath(name: string, at: number): string {
  const stamp = new Date(at)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `${PROOF_RUNS_DIR}/${name}-${stamp}.log`;
}

/** Keeps the whole masked output in a local file; the oldest files go. Best effort: a failure keeps nothing. */
async function keepLog(
  context: CommandContext,
  command: DeclaredProofCommand,
  line: string,
  result: ProofRunResult,
  output: string,
): Promise<string | undefined> {
  try {
    let path = logPath(command.name, (context.now ?? Date.now)());
    // Two runs in the same second keep both.
    for (let again = 2; await context.files.exists(path); again += 1) {
      path = path.replace(/(?:-\d+)?\.log$/, `-${again}.log`);
    }
    const header = [
      `command: ${command.name}`,
      `line: ${maskSecrets(line)}`,
      `folder: ${command.cwd}`,
      `ended: ${result.ended}${result.exit === null ? "" : ` (exit ${result.exit})`} in ${result.ms} ms`,
      "",
    ].join("\n");
    await context.files.writeText(path, `${header}${output}\n`);
    await dropOldRuns(context, path);
    return path;
  } catch {
    return undefined;
  }
}

/** The time a run file was written, from its name: sortable. */
const stampOf = (file: string): string => /-(\d{8}T\d{6}Z)(?:-\d+)?\.log$/.exec(file)?.[1] ?? "";

/** Keeps the most recent runs, oldest out first, never the one just written. Best effort. */
async function dropOldRuns(context: CommandContext, keep: string): Promise<void> {
  try {
    const files = (await context.files.listFiles(PROOF_RUNS_DIR))
      .filter((file) => file.endsWith(".log") && file !== keep)
      .sort((a, b) =>
        stampOf(a) < stampOf(b) ? -1 : stampOf(a) > stampOf(b) ? 1 : a < b ? -1 : 1,
      );
    for (const old of files.slice(0, Math.max(0, files.length - (MAX_KEPT_RUNS - 1)))) {
      await context.files.remove(old);
    }
  } catch {
    // The folder keeps a few more files; the next run tries again.
  }
}

/** What differs when the engine runs the tests of a criterion. */
export interface RunOptions {
  /** The line to start, when it is not the declared one (the marks of a criterion written in). */
  readonly line?: string;
  /** The story's working copy, as `story.started` recorded it; the project's folder without. */
  readonly workspace?: string;
}

/** Runs the command and keeps what it said. Never throws: a command that cannot start is a result. */
export async function execute(
  context: CommandContext,
  command: DeclaredProofCommand,
  runner: ProofRunner,
  options: RunOptions = {},
): Promise<Outcome> {
  const line = options.line ?? command.run;
  const copy = await runner.workingCopy(options.workspace).catch((): WorkingCopy => ({}));
  const parsed = parseCommandLine(line);
  const started = (context.now ?? Date.now)();
  const result = await runner
    .run({
      line,
      argv: parsed.kind === "argv" ? parsed.argv : null,
      cwd: command.cwd,
      ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
      timeoutMs: command.timeout * 1000,
      maxOutputBytes: MAX_PROOF_OUTPUT_BYTES,
    })
    .catch(
      (error: unknown): ProofRunResult => ({
        ended: "error",
        exit: null,
        ms: Math.max(0, (context.now ?? Date.now)() - started),
        head: "",
        tail: "",
        omitted: 0,
        detail: error instanceof Error ? error.message : "the command could not be started",
      }),
    );
  const output = safeOutput(result);
  const log = await keepLog(context, command, line, result, output);
  const measured =
    command.measured_after === undefined
      ? undefined
      : measuredAfter(output, command.measured_after);
  return {
    result,
    copy,
    output,
    ...(log === undefined ? {} : { log }),
    ...(measured === undefined ? {} : { measured }),
  };
}

export function passed(result: ProofRunResult): boolean {
  return result.ended === "exit" && result.exit === 0;
}

/** The short account of a run, for the journal: what failed, or what a passing run said last. */
export function summaryOf(command: DeclaredProofCommand, outcome: Outcome): string {
  const { result } = outcome;
  if (result.ended === "timeout") {
    return `stopped after ${command.timeout} s, its time limit`;
  }
  if (result.ended === "error") {
    return `could not be started: ${maskSecrets(result.detail ?? "unknown cause").slice(0, 200)}`;
  }
  const text = passed(result)
    ? lastLine(outcome.output) || "passed"
    : usefulLines(outcome.output).join("\n") || `exit ${result.exit ?? "?"}`;
  return text.length <= 700 ? text : `${text.slice(0, 699)}…`;
}

/** The note of a failed proof: the first line that matters. */
function noteOf(plan: Plan, outcome: Outcome): string | undefined {
  if (passed(outcome.result)) return undefined;
  const first = summaryOf(plan.command, outcome).split("\n")[0] ?? "";
  const note = `${plan.command.name} failed: ${first}`;
  return note.length <= 500 ? note : `${note.slice(0, 499)}…`;
}

export function runOf(command: DeclaredProofCommand, outcome: Outcome): ProofRun {
  const { result, copy } = outcome;
  return {
    command: command.name,
    fingerprint: command.fingerprint,
    ended: result.ended,
    exit: result.exit,
    ms: Math.min(Math.max(0, Math.round(result.ms)), 86_400_000),
    ...(copy.commit === undefined ? {} : { commit: copy.commit }),
    ...(copy.clean === undefined ? {} : { clean: copy.clean }),
    summary: summaryOf(command, outcome),
  };
}

/** The result recorded for one requirement: the exit code, and for a measure with a reading, the budget. */
function resultFor(
  item: PlannedItem,
  plan: Plan,
  outcome: Outcome,
): { result: ProofResult; measured?: number; budget?: RequirementBudget; note?: string } {
  const exitNote = noteOf(plan, outcome);
  const ok = passed(outcome.result);
  const prefix = plan.command.measured_after;
  if (item.kind !== "measure" || item.budget === null || prefix === undefined) {
    return { result: ok ? "pass" : "fail", ...(exitNote === undefined ? {} : { note: exitNote }) };
  }
  if (outcome.measured === undefined) {
    return {
      result: "fail",
      note: ok ? `no number after "${prefix}" in the output` : (exitNote ?? "failed"),
    };
  }
  const verdict = ok ? measureResult(item.budget, outcome.measured) : "fail";
  return {
    result: verdict,
    measured: outcome.measured,
    budget: item.budget,
    ...(exitNote === undefined ? {} : { note: exitNote }),
  };
}

/** The events: one proof per requirement, marked as the engine's, each carrying the run. */
function provedEvents(plan: Plan, outcome: Outcome): EventSpec[] {
  const run = runOf(plan.command, outcome);
  return plan.items.map((item) => {
    const decided = resultFor(item, plan, outcome);
    return {
      type: REQUIREMENT_EVENT_TYPES.proved,
      payload: defined({
        requirement: item.id,
        kind: item.kind,
        result: decided.result,
        source: `engine:${plan.command.name}`,
        measured: decided.measured,
        budget: decided.budget,
        note: decided.note,
        entry: item.digest,
        commit: outcome.copy.commit,
        origin: "engine",
        run,
      }),
    };
  });
}

function viewOf(plan: Plan, outcome: Outcome): ProofRunView {
  const { result, copy } = outcome;
  const decided = plan.items.map(
    (item) => [item.id, resultFor(item, plan, outcome).result] as const,
  );
  const lines = passed(result) ? [] : usefulLines(outcome.output);
  return {
    command: plan.command.name,
    ok: passed(result),
    ended: result.ended,
    exit: result.exit,
    seconds: Math.round(result.ms / 100) / 10,
    proved: decided.filter(([, verdict]) => verdict === "pass").map(([id]) => id),
    failed: decided.filter(([, verdict]) => verdict === "fail").map(([id]) => id),
    ...(plan.skipped.length === 0 ? {} : { skipped: plan.skipped }),
    ...(copy.clean === false ? { unclean: true as const } : {}),
    ...(lines.length === 0 ? {} : { lines }),
    ...(outcome.log === undefined ? {} : { log: outcome.log }),
  };
}

/**
 * `run_proof_command`: plans (declared, accepted as it stands, provable), runs the command through
 * the runner, then writes one proof per requirement it proves, in one write, after checking under
 * the journal's lock that the creator's accord still holds and that the register did not change
 * while the command ran. A command that fails, is stopped at its time limit or cannot start
 * records failed proofs: a gap, never a proof.
 */
export const runProofCommand: Command<ProofRunView> = defineCommand<ProofRunView>({
  name: "run_proof_command",
  audience: "agent",
  description:
    "Run a command the project declares in .agentplugged/proofs.yaml (name, run, cwd, timeout, proves: ENF-n or AD-n) and let the engine inscribe the proof itself: exit code, duration, commit tested, a short masked summary; the proof is marked `engine`, an agent's `reported`. Only a line the creator accepted as it stands runs: a new or modified one is refused (`not_accepted`; ask once for all with guard.creator_action {kind: proof_commands}), a refused one stays refused. No shell when the line is a program and its arguments, in the project's folder, without secrets in the environment, stopped with its processes at its time limit. Answers `ok`, `ended`, `exit`, `seconds`, `proved`, `failed`, `skipped` (id:why, not provable by running: review, ci, no test cites it, no budget), `unclean` (changes not committed) and, when it failed, `lines` (at most 12); the whole output stays in `log`, a local file outside the journal. A timeout or a failure records failed proofs (a gap the creator settles). Refused: INVALID_ARGUMENTS (`no_command_declared`, `unknown_command`, `not_accepted`, `refused_by_the_creator`, `nothing_to_prove`, `register_changed_during_the_run`).",
  inputSchema: RunProofCommandInputSchema,
  async run(context, input) {
    const parsed = RunProofCommandInputSchema.safeParse(input);
    if (!parsed.success) return fail(invalidInput("run_proof_command", parsed.error));
    const target = await agentWriteContext(context, parsed.data.agent);
    if (target instanceof AgentPluggedError) return fail(target);
    try {
      const plan = await planRun(context, parsed.data.command);
      if (plan instanceof AgentPluggedError) return fail(plan);
      let outcome: Outcome | undefined;
      const writer = agentEventCommand<typeof RunProofCommandInputSchema, Outcome>({
        name: "run_proof_command",
        description: "",
        inputSchema: RunProofCommandInputSchema,
        needsState: () => true,
        prepare: async (_value, writing) => {
          outcome = await execute(writing, plan.command, plan.runner);
          return outcome;
        },
        events: (_value, _state, prepared) => ({
          events: provedEvents(plan, prepared as Outcome),
        }),
        // Under the journal's lock: the accord holds, and the register is the one the run was for.
        check: (_value, state) => {
          const standing = standingOf(plan.command, proofDecisions(state));
          if (standing !== "accepted")
            return refuse("command", `not_accepted:${plan.command.name}`);
          for (const item of plan.items) {
            if ((itemOf(state, item.id)?.digest ?? UNKNOWN_DIGEST) !== item.digest) {
              return refuse("command", `register_changed_during_the_run:${item.id}`);
            }
          }
          return undefined;
        },
      });
      const written = await writer.run(context, input);
      if (!written.ok) return fail(written.error);
      if (outcome === undefined) throw new Error("run_proof_command: the command did not run");
      return ok(viewOf(plan, outcome));
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    }
  },
});

/** The agents' commands of the proofs the engine produces, exposed as MCP actions after the others. */
export const proofAgentCommands = [runProofCommand] as const;
