import {
  CREATOR_OWNER,
  DEFERRED_EVENT_TYPES,
  ErrorCode,
  type GapDecision,
  MAX_REGISTERED_REQUIREMENTS,
  type ProjectionState,
  REQUIREMENT_EVENT_TYPES,
  type RecordProofInput,
  RecordProofInputSchema,
  type RequirementEntry,
  type RequirementProvedPayload,
  type SettleGapInput,
  SettleGapInputSchema,
  type SubmitAuditInput,
  SubmitAuditInputSchema,
  SyncRequirementsInputSchema,
} from "@agentplugged/protocol";
import {
  agentEventCommand,
  agentWriteContext,
  defined,
  type EventSpec,
  invalidInput,
  type RecordedEvent,
} from "../agent-activity/agent-commands.js";
import { type Command, type CommandContext, defineCommand, fail, ok } from "../command.js";
import { currentState } from "../deferred/deferred-commands.js";
import { deferredView } from "../deferred/deferred-rules.js";
import { AgentPluggedError } from "../errors.js";
import { type TestReference, testReferences } from "../trace/test-references.js";
import { readRegistry } from "./requirement-files.js";
import {
  ciProofProblem,
  gapPointProblem,
  gapSettled,
  measureResult,
  openGaps,
  proofIsStale,
  proofProblem,
  type RequirementItem,
  type RequirementsView,
  registerOf,
  requirementsView,
  sameRegistry,
  validateAuditReport,
} from "./requirement-rules.js";

type State = ProjectionState["state"];

export function invalid(command: string, field: string, reason: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
    command,
    field,
    reason: `${command}: ${field}: ${reason}`,
  });
}

function notFound(requirement: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.REQUIREMENT_NOT_FOUND, "error.requirement_not_found", {
    requirement,
  });
}

export function itemOf(state: State, id: string): RequirementItem | undefined {
  const register = registerOf(state);
  return register !== undefined && Object.hasOwn(register.items, id)
    ? register.items[id]
    : undefined;
}

/** The digest an event is made for; the zeros stand for a requirement `check` is about to refuse. */
export const UNKNOWN_DIGEST = "000000000000";

// ---------------------------------------------------------------------------------------------
// sync_requirements
// ---------------------------------------------------------------------------------------------

const registerRequirements = agentEventCommand<
  typeof SyncRequirementsInputSchema,
  { entries: RequirementEntry[] }
>({
  name: "sync_requirements",
  description: "Read the non-functional requirements into the register.",
  inputSchema: SyncRequirementsInputSchema,
  prepare: async (_input, context) => ({ entries: await readRegistry(context.files) }),
  events: (_input, _state, prepared) => ({
    events: [
      {
        type: REQUIREMENT_EVENT_TYPES.registered,
        payload: { items: prepared?.entries ?? [] },
      },
    ],
  }),
});

/** `sync_requirements`' answer: the register as it stands, and whether this call changed it. */
export interface RequirementsSynced {
  readonly changed: boolean;
  readonly register: RequirementsView | null;
  /**
   * The requirements the documents no longer state (removed, retired or its budget unreadable)
   * since the last read, at most 8: a gap that disappears this way is told, never silent.
   */
  readonly removed?: readonly string[];
}

/** The most requirements shown as removed. */
const MAX_REMOVED_SHOWN = 8;

/**
 * `sync_requirements`: reads the `ENF-n` of the PRD and the numbered
 * budgets of the architecture's decisions into the register, writes it to the journal when it
 * differs from what the journal holds (nothing is written otherwise), and answers with the register
 * in a bounded form: the counts, and the gaps by id. Opening a `release` point does the same.
 */
export const syncRequirementsCommand: Command<RequirementsSynced> =
  defineCommand<RequirementsSynced>({
    name: "sync_requirements",
    audience: "agent",
    description:
      "Read the non-functional requirements (ENF-n of the PRD, and the numbered budgets of the architecture's AD-n) into the product's register, with for each its pillar, the proof it expects and its state (proven, failed, without proof). Nothing is written when the register already says the same. Answers `register`: total, proven, failed, unproven, settled (risk accepted or deferred by the creator), `gaps` (id:why, at most 8) and `audits`. Run it before recording proofs and whenever the PRD or the architecture changed; opening a release point does it too.",
    inputSchema: SyncRequirementsInputSchema,
    async run(context, input) {
      const parsed = SyncRequirementsInputSchema.safeParse(input);
      if (!parsed.success) return fail(invalidInput("sync_requirements", parsed.error));
      const target = await agentWriteContext(context, parsed.data.agent);
      if (target instanceof AgentPluggedError) return fail(target);
      try {
        const entries = await readRegistry(context.files);
        if (entries.length > MAX_REGISTERED_REQUIREMENTS) {
          return fail(
            invalid(
              "sync_requirements",
              "documents",
              `${entries.length} requirements, at most ${MAX_REGISTERED_REQUIREMENTS} are kept: retire or merge some in the PRD`,
            ),
          );
        }
        const before = await currentState(context);
        const changed = !sameRegistry(entries, before);
        if (changed) {
          const written = await registerRequirements.run(context, input);
          if (!written.ok) return fail(written.error);
        }
        const kept = new Set(entries.map((entry) => entry.id));
        const removed = Object.keys(registerOf(before)?.items ?? {}).filter((id) => !kept.has(id));
        const after = await currentState(context);
        return ok({
          changed,
          register: requirementsView(after) ?? null,
          ...(removed.length === 0 ? {} : { removed: removed.slice(0, MAX_REMOVED_SHOWN) }),
        });
      } catch (error) {
        if (error instanceof AgentPluggedError) return fail(error);
        throw error;
      }
    },
  });

// ---------------------------------------------------------------------------------------------
// record_proof
// ---------------------------------------------------------------------------------------------

/** The tests that cite the requirement, read through the port; null when they cannot be read. */
export async function citingTests(
  context: CommandContext,
  requirement: string,
): Promise<ReadonlyArray<TestReference> | null> {
  const source = context.testReferences;
  if (source === undefined) return null;
  try {
    const read = await source.read();
    if (!read.found) return null;
    return testReferences(read.lines, read.files).filter(
      (reference) => reference.requirement === requirement,
    );
  } catch {
    return null;
  }
}

function provedPayload(
  input: RecordProofInput,
  item: RequirementItem | undefined,
): RequirementProvedPayload {
  const kind = item?.proof ?? "test";
  const measured = kind === "measure" ? input.measured : undefined;
  // A measure is decided against its budget, a CI by the read the engine holds (`check` made sure
  // it is green): the agent's `passed` is only for what the engine cannot see.
  const result =
    measured !== undefined && item?.budget != null
      ? measureResult(item.budget, measured)
      : kind === "ci" || input.passed === true
        ? "pass"
        : "fail";
  return {
    requirement: input.requirement,
    kind,
    result,
    source: input.source,
    ...(measured === undefined ? {} : { measured }),
    ...(measured !== undefined && item?.budget != null ? { budget: item.budget } : {}),
    entry: item?.digest ?? UNKNOWN_DIGEST,
  };
}

/**
 * `record_proof`: a proof for a requirement of the register, of the kind the register
 * expects of it, with its source, in the journal. A `test` must be a test that cites the
 * requirement (read in this working copy); an `analysis` or a `measure` must come from one of the
 * commands the project declares for it; a `measure` is compared with the budget by the engine, which
 * decides the result. A proof is valid only for what the requirement says now and only while no
 * story that covers it was delivered after it.
 */
export const recordProofCommand = agentEventCommand<
  typeof RecordProofInputSchema,
  ReadonlyArray<TestReference> | null
>({
  name: "record_proof",
  description:
    "Record the proof of a non-functional requirement of the register (ENF-n or AD-n; measure.requirements first, it says what each one expects). The proof is of the kind the register expects: `test` (source = path:line of a test that cites the requirement), `ci` (source = the id of a story whose CI the engine read: it decides from that read, give no `passed`), `analysis` (source = a command the project declares for it), `measure` (source = the declared command; give `measured` in the unit of the requirement's budget, the engine compares it with the budget and decides). A `review` proof is the audit's own (review.audit, `verified`). Otherwise give `passed` (true or false): the engine runs nothing, so it is the result of the project's own command that you ran. Never record a proof you did not get. A failed proof is a gap the creator settles before the release. A proof older than the delivery of a story that covers the requirement, or made for an older wording of it, no longer counts. Refused: REQUIREMENT_NOT_FOUND, INVALID_ARGUMENTS (`review_comes_from_an_audit`, `measured_expected`, `passed_expected`, `command_not_declared`, `no_test_cites_it`, `source_not_a_citing_test`, `no_ci_read`, `ci_not_green`, `source_not_a_covering_story`).",
  inputSchema: RecordProofInputSchema,
  needsState: () => true,
  replanned: true,
  prepare: async (input, context) => {
    const item = itemOf(await currentState(context), input.requirement);
    return item?.proof === "test" ? citingTests(context, input.requirement) : null;
  },
  events: (input, state) => ({
    events: [
      {
        type: REQUIREMENT_EVENT_TYPES.proved,
        payload: defined({
          ...provedPayload(
            input,
            state === undefined ? undefined : itemOf(state, input.requirement),
          ),
        }),
      },
    ],
  }),
  check: (input, state, { prepared }) => {
    const item = itemOf(state, input.requirement);
    if (item === undefined) return notFound(input.requirement);
    if (item.proof === "review") {
      return invalid("record_proof", "requirement", "review_comes_from_an_audit (review.audit)");
    }
    const standing = item.proved;
    if (
      standing !== null &&
      standing.origin === "engine" &&
      standing.result === "fail" &&
      standing.at >= item.since &&
      !proofIsStale(state, item, standing.at)
    ) {
      return invalid(
        "record_proof",
        "requirement",
        "engine_failure_stands (run it again: measure.run)",
      );
    }
    if (item.proof === "measure" && input.measured === undefined) {
      return invalid("record_proof", "measured", "measured_expected");
    }
    if (item.proof !== "measure" && item.proof !== "ci" && input.passed === undefined) {
      return invalid("record_proof", "passed", `passed_expected (a ${item.proof} proof)`);
    }
    const problem =
      item.proof === "ci"
        ? ciProofProblem(state, item, input.source)
        : proofProblem(
            item,
            { kind: item.proof, source: input.source, measured: input.measured },
            prepared ?? null,
          );
    return problem === undefined ? undefined : invalid("record_proof", "source", problem);
  },
});

// ---------------------------------------------------------------------------------------------
// settle_gap
// ---------------------------------------------------------------------------------------------

function gapTitle(input: SettleGapInput, item: RequirementItem | undefined): string {
  const subject = `${input.requirement}${item === undefined ? "" : ` — ${item.text}`}`;
  const title = input.option === "fix" ? `Fix ${subject}` : `Deferred: ${subject}`;
  return title.length <= 200 ? title : `${title.slice(0, 199)}…`;
}

/**
 * `settle_gap`: the creator's decision on a gap of the release gate, relayed by an
 * agent. The decision was taken at a `decision` point whose options were `fix`, `accept` and
 * `defer`; the engine checks that the creator answered it themselves, with that option. `accept`
 * lets the release go with the reason in the journal; `defer` names the version and puts the gap in
 * the register of deferred work; `fix` records a story to propose in the same register and keeps
 * the gate closed until the proof exists.
 */
export const settleGapCommand = agentEventCommand<typeof SettleGapInputSchema>({
  name: "settle_gap",
  description:
    "Record the creator's decision on a gap of a non-functional requirement, after they answered it at a `decision` point (open it with checkpoint.open: options `fix`, `accept`, `defer`; one point per gap, one gesture). Give the `requirement`, the `option` the creator chose (fix, accept or defer), the `checkpoint` (G-…) and their `reason` in their words (for `defer`, it names the version). `accept`: the release may go, the risk and its reason stay in the journal. `defer`: the gap goes to the register of deferred work with its reason and version. `fix`: a story to propose is recorded in the register (`deferred`), and the release stays closed until the proof exists. The point settles one gap only: its title names the requirement (\"Gap on ENF-3\"), it was opened after the requirement's latest proof, and it is used once. Refused with INVALID_ARGUMENTS when the creator did not answer that point themselves with that option, when it does not fit the requirement or was used, or when the requirement has no gap; REQUIREMENT_NOT_FOUND.",
  inputSchema: SettleGapInputSchema,
  needsState: () => true,
  replanned: true,
  events: (input, state) => {
    const item = state === undefined ? undefined : itemOf(state, input.requirement);
    const events: EventSpec[] = [
      {
        type: REQUIREMENT_EVENT_TYPES.gapSettled,
        payload: defined({
          requirement: input.requirement,
          decision: input.option as GapDecision,
          reason: input.reason,
          checkpoint: input.checkpoint,
        }),
      },
    ];
    if (input.option !== "accept") {
      events.push({
        type: DEFERRED_EVENT_TYPES.recorded,
        payload: defined({
          title: gapTitle(input, item),
          detail: input.reason.slice(0, 2000),
          origin: "deliberate",
          owner: CREATOR_OWNER,
          locks: [],
        }),
      });
    }
    return { events };
  },
  check: (input, state) => {
    const item = itemOf(state, input.requirement);
    if (item === undefined) return notFound(input.requirement);
    const refused = gapPointProblem(state, input.requirement, input.option, input.checkpoint);
    if (refused !== undefined) return invalid("settle_gap", "checkpoint", refused);
    const gap = openGaps(state).some((open) => open.item.id === input.requirement);
    if (!gap && !gapSettled(item)) {
      return invalid("settle_gap", "requirement", `${input.requirement} has no gap to settle`);
    }
    return undefined;
  },
});

// ---------------------------------------------------------------------------------------------
// submit_audit
// ---------------------------------------------------------------------------------------------

function sliced(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The events an audit report writes: the report, the proofs it makes, the stories it proposes. */
function auditEvents(input: SubmitAuditInput, state: State | undefined): EventSpec[] {
  const events: EventSpec[] = [
    {
      type: REQUIREMENT_EVENT_TYPES.audited,
      payload: defined({
        pillars: input.results.map((result) => ({
          pillar: result.pillar,
          verdict: result.verdict,
          findings: input.findings.filter((finding) => finding.pillar === result.pillar).length,
          reads: result.reads.length,
        })),
        commit: input.commit,
      }),
    },
  ];
  const proof = (
    requirement: string,
    result: "pass" | "fail",
    source: string,
    note?: string,
  ): EventSpec => ({
    type: REQUIREMENT_EVENT_TYPES.proved,
    payload: defined({
      requirement,
      kind: "review",
      result,
      source: sliced(source, 300),
      note: note === undefined ? undefined : sliced(note, 500),
      entry:
        (state === undefined ? undefined : itemOf(state, requirement))?.digest ?? UNKNOWN_DIGEST,
      commit: input.commit,
    }),
  });
  const failed = new Set<string>();
  for (const finding of input.findings) {
    if (finding.action !== "gap" || finding.requirement === undefined) continue;
    if (failed.has(finding.requirement)) continue;
    failed.add(finding.requirement);
    events.push(
      proof(finding.requirement, "fail", `audit:${finding.pillar} ${finding.where}`, finding.what),
    );
  }
  for (const result of input.results) {
    for (const id of result.verified ?? []) {
      if (!failed.has(id)) events.push(proof(id, "pass", `audit:${result.pillar}`, result.summary));
    }
  }
  // A story already proposed and still open is not proposed twice (an audit run again).
  const open = new Set(deferredView(state ?? {}).open.map((item) => item.title));
  for (const finding of input.findings) {
    if (finding.action !== "story") continue;
    const title = sliced(`[audit ${finding.pillar}] ${finding.what}`, 200);
    if (open.has(title)) continue;
    open.add(title);
    events.push({
      type: DEFERRED_EVENT_TYPES.recorded,
      payload: defined({
        title,
        detail: sliced(
          `${finding.where}${finding.fix === undefined ? "" : ` — ${finding.fix}`}`,
          2000,
        ),
        origin: "deliberate",
        owner: CREATOR_OWNER,
        locks: [],
      }),
    });
  }
  return events;
}

/**
 * `submit_audit`: the report of an audit of one pillar or several, in a fixed form
 * the engine validates and refuses with the whole list of what is missing. Each pillar says what it
 * read (at least one file, 40 at most: an audit reads a pillar, not the repository), its verdict
 * and the requirements it found tenable (each becomes a proof of kind `review`). A finding that
 * fails a requirement becomes a failed proof, which is a gap for the release gate; a finding that
 * is a story to propose goes to the register of deferred work; a note stays in the report.
 */
export const submitAuditCommand: Command<RecordedEvent> = agentEventCommand<
  typeof SubmitAuditInputSchema
>({
  name: "submit_audit",
  description:
    "Submit the report of an audit by pillar (skill audit-pillars): one `results` entry per audited pillar (`pillar`: quality, architecture, security, dependencies, performance, tests, interface or accessibility; `verdict`: pass, issues or not_applicable; `reads`: the files read for it, 1 to 40; `summary`; `verified`: the requirements ENF-n or AD-n whose expected proof is a review that this pillar, with a `pass` verdict and its reads, found tenable, each recorded as a review proof; any other proof is recorded with measure.proof) and the `findings` (pillar, severity, `where`: path or path:line, `what`, `fix` unless minor, `action`: gap for a requirement it fails (name `requirement`), story for work to propose, note for a minor finding only). The engine refuses a report that is not whole with the list of what is missing. A gap finding is a failed proof the creator settles before the release; a story finding goes to the register of deferred work. Read-only for the code.",
  inputSchema: SubmitAuditInputSchema,
  needsState: () => true,
  replanned: true,
  events: (input, state) => ({ events: auditEvents(input, state) }),
  check: (input, state) => {
    const register = registerOf(state);
    const known = new Map(
      Object.values(register?.items ?? {}).map((item) => [item.id, item.proof] as const),
    );
    const problems = validateAuditReport(input, known);
    if (problems.length === 0) return undefined;
    return invalid(
      "submit_audit",
      "report",
      `not whole (${problems.length}): ${problems.slice(0, 20).join(", ")}${
        register === undefined && problems.some((p) => p.includes("unknown"))
          ? " — the register is empty: call measure.requirements first"
          : ""
      }`,
    );
  },
});

/** The agents' commands of the requirements, exposed as MCP actions after the others. */
export const requirementAgentCommands = [
  syncRequirementsCommand,
  recordProofCommand,
  settleGapCommand,
  submitAuditCommand,
] as const;
