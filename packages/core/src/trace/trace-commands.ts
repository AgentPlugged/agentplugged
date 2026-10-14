import {
  DEVIATION_EVENT_TYPES,
  DeviationIdInputSchema,
  type DeviationNotReportableReason,
  DeviationReasonSchema,
  deviationIdOf,
  ErrorCode,
  GetTraceInputSchema,
  type ProjectionState,
  ReportDeviationInputSchema,
  type RequirementStatus,
  ResolveDeviationInputSchema,
  TracedRequirementInputSchema,
} from "@agentplugged/protocol";
import {
  agentEventCommand,
  defined,
  invalidInput,
  project,
  type RecordedEvent,
} from "../agent-activity/agent-commands.js";
import { type CommandContext, defineCommand, fail, ok } from "../command.js";
import { currentState, verified } from "../deferred/deferred-commands.js";
import { readDocumentFiles } from "../docs/docs-command.js";
import { type ParsedDocument, parseDocumentFile } from "../docs/parse-document.js";
import { storiesOf } from "../docs/story-rules.js";
import { AgentPluggedError } from "../errors.js";
import { datedAfter, humanTarget, trustedCreator, writeHuman } from "../human/human-commands.js";
import { localeSigner } from "../human/human-events.js";
import { METHOD_CONFIG_PATH } from "../init/layout.js";
import { loadMethodConfig } from "../init/method-config.js";
import { methodNotInstalled } from "../profile/profile-command.js";
import type { StoryState } from "../projection/agent-reducers.js";
import { deviationComment, type ForgePosting, forgeTarget } from "../review/review-forge.js";
import { oneLine } from "../stories/pull-request.js";
import {
  agentMayResolve,
  type Deviation,
  deviationResolutionProblem,
  findDeviation,
  openDeviation,
  openDeviations,
  storyDeveloper,
} from "./deviation-rules.js";
import { type TestReference, testReferences } from "./test-references.js";
import {
  type RequirementSummary,
  type RequirementTrace,
  statusCounts,
  type TraceInputs,
  tracedRequirements,
  tracedStoryStatus,
  traceRequirement,
  traceSummaries,
} from "./trace-rules.js";

function invalid(command: string, field: string, reason: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
    command,
    field,
    reason: `${command}: ${field}: ${reason}`,
  });
}

function notReportable(
  story: string,
  reason: DeviationNotReportableReason,
  extra: Record<string, unknown> = {},
): AgentPluggedError {
  return new AgentPluggedError(
    ErrorCode.DEVIATION_NOT_REPORTABLE,
    `error.deviation_not_reportable.${reason}`,
    { story, reason, ...extra },
  );
}

/** The story documents of the working copy, parsed: the stories a deviation may name. */
async function workingStories(context: CommandContext): Promise<Map<string, ParsedDocument>> {
  const files = await readDocumentFiles(context.files, true);
  return storiesOf(files.map((file) => parseDocumentFile(file.path, file.text)));
}

/** The requirements a story of the working copy cites, or undefined when it has none. */
interface ReportPrepared {
  readonly requirements: readonly string[] | undefined;
}

const reportDeviation = agentEventCommand<typeof ReportDeviationInputSchema, ReportPrepared>({
  name: "report_deviation",
  description:
    "Report a deviation: the delivered work of a started story drifts from requirements the story cites. Compare during the build and at the latest before the merge. Give the `story`, the `requirements` it drifts from (each listed in the story's `requirements`), a one-line `summary` of what differs, an optional `detail` (what the requirement says, what the code does, where: no control characters) and the `commit` you compared. The engine attaches it to the story's pull request when there is one, and posts it there as a comment (`forge_comment`: posted, skipped with the reason, or failed; the deviation stays recorded either way). Returns its id (`deviation`: V-…), stable and never reused. A story in review goes back to in_progress for its developer, and a story with an open deviation is not merged. Refused with DEVIATION_NOT_REPORTABLE: `unknown_story`, `not_linked` (a requirement the story does not cite), `not_started`, `done`. Once the fix is verified, the agent that reported it calls lift_deviation.",
  inputSchema: ReportDeviationInputSchema,
  needsState: () => true,
  replanned: true,
  prepare: async ({ story }, context) => {
    const document = (await workingStories(context)).get(story);
    return {
      requirements: document?.story?.requirements.map((requirement) => requirement.value),
    };
  },
  events: ({ story, requirements, summary, detail, commit }, state) => {
    const stories = (state?.stories as Record<string, StoryState> | undefined) ?? {};
    const pr = Object.hasOwn(stories, story) ? stories[story]?.pull_request?.number : undefined;
    return {
      events: [
        {
          type: DEVIATION_EVENT_TYPES.reported,
          story,
          payload: defined({ requirements: [...requirements], summary, detail, pr, commit }),
        },
      ],
    };
  },
  check: ({ story, requirements }, state, { prepared }) => {
    const cited = prepared?.requirements;
    if (cited === undefined) return notReportable(story, "unknown_story");
    const missing = requirements.find((requirement) => !cited.includes(requirement));
    if (missing !== undefined) return notReportable(story, "not_linked", { requirement: missing });
    const stories = (state.stories as Record<string, StoryState> | undefined) ?? {};
    const projected = Object.hasOwn(stories, story) ? stories[story] : undefined;
    if (tracedStoryStatus(state, story) === "done") return notReportable(story, "done");
    if (projected?.started === undefined) return notReportable(story, "not_started");
    return undefined;
  },
});

/**
 * `report_deviation`: written, then read back. An id already taken (the last 10 characters of two
 * ULIDs alike) leaves the new event ignored: it is written again, with a fresh id, up to 3 times.
 */
const reportDeviationVerified = verified(reportDeviation, (written, state) => {
  const found = findDeviation(state, deviationIdOf(written.id));
  return !(found instanceof AgentPluggedError) && found.event === written.id ? "ok" : "retry";
});

/**
 * Posts a deviation as a comment on its story's pull request, by the engine
 * with the forge's tool the creator logged in. Never a failure of `report_deviation`: the
 * deviation stays recorded, and the result says what happened on the forge.
 */
async function postDeviation(context: CommandContext, id: string): Promise<ForgePosting> {
  const state = await currentState(context);
  const deviation = findDeviation(state, id);
  if (deviation instanceof AgentPluggedError)
    return { status: "skipped", reason: "no_pull_request" };
  const stories = (state.stories as Record<string, StoryState> | undefined) ?? {};
  const story = Object.hasOwn(stories, deviation.story) ? stories[deviation.story] : undefined;
  const target = await forgeTarget(context, story);
  if ("status" in target) return target;
  const comment = target.forge.comment?.bind(target.forge);
  if (comment === undefined) return { status: "skipped", reason: "no_forge" };
  await comment(
    target.repository,
    target.number,
    deviationComment({
      id,
      requirements: deviation.requirements,
      summary: deviation.summary,
      detail: deviation.detail ?? undefined,
      commit: deviation.commit ?? undefined,
    }),
  );
  return { status: "posted", forge: target.repository.forge, pr: target.number };
}

/** `report_deviation`'s result: the deviation, and its comment on the pull request. */
export interface DeviationReported extends RecordedEvent {
  readonly forge_comment?: ForgePosting;
}

/**
 * `report_deviation`: written, then read back (an id already taken: written again, up to 3
 * times), then posted on the story's pull request.
 */
export const reportDeviationCommand = defineCommand<DeviationReported>({
  ...reportDeviationVerified,
  async run(context, input) {
    const result = await reportDeviationVerified.run(context, input);
    if (!result.ok || result.value.deviation === undefined) return result;
    const forge_comment = await postDeviation(context, result.value.deviation).catch(
      (error: unknown): ForgePosting => ({
        status: "failed",
        message: oneLine(error instanceof Error ? error.message : String(error)),
      }),
    );
    return ok({ ...result.value, forge_comment });
  },
});

const resolveDeviation = agentEventCommand({
  name: "lift_deviation",
  description:
    "Lift a deviation you reported, once you verified the fix on the story's branch: its id (`deviation`: V-…, from report_deviation, get_state `deviations` or get_trace) and how it was fixed (`reason`, no control characters). Only the agent that reported it lifts it, and never the story's developer (else DEVIATION_NOT_ALLOWED); the creator may lift any at the terminal. Refused with DEVIATION_NOT_FOUND for an unknown id, DEVIATION_NOT_OPEN for one already resolved; DEVIATION_RESOLUTION_IGNORED when the journal does not apply it (run it again once the journal is synced).",
  inputSchema: ResolveDeviationInputSchema,
  events: ({ deviation, reason }) => ({
    events: [{ type: DEVIATION_EVENT_TYPES.resolved, payload: { deviation, reason } }],
  }),
  check: ({ agent, deviation }, state) => {
    const found = openDeviation(state, deviation);
    if (found instanceof AgentPluggedError) return found;
    if (agentMayResolve(found, agent, storyDeveloper(state, found.story))) return undefined;
    return new AgentPluggedError(ErrorCode.DEVIATION_NOT_ALLOWED, "error.deviation_not_allowed", {
      deviation,
      agent,
      reported_by: found.reported_by,
    });
  },
});

/** `lift_deviation`: written, then read back: still open, `DEVIATION_RESOLUTION_IGNORED`. */
export const resolveDeviationCommand = verified(resolveDeviation, (written, state, input) => {
  const id = DeviationIdInputSchema.parse(input.deviation);
  return deviationResolutionProblem(state, id, written.id) ?? "ok";
});

/** How the tests were read: all of them, only the first lines, or not at all (no Git here). */
export interface TraceTests {
  readonly status: "read" | "truncated" | "unavailable";
  /** The citations of requirements found in test files. */
  readonly references: number;
}

/** `trace`, `get_trace` without a requirement: every active requirement and its status. */
export interface TraceOverview {
  readonly action: "overview";
  readonly requirements: readonly RequirementSummary[];
  /** How many requirements stand at each status. */
  readonly counts: Readonly<Record<RequirementStatus, number>>;
  /** The open deviations, in reporting order. */
  readonly deviations: readonly Deviation[];
  readonly tests: TraceTests;
}

/** `trace <EF-n>`, `get_trace` with a requirement: everything linked to it. */
export interface TraceDetail {
  readonly action: "requirement";
  readonly requirement: RequirementTrace;
  readonly tests: TraceTests;
}

/** `trace resolve`: the resolution written. */
export interface TraceResolved {
  readonly action: "resolve";
  readonly deviation: string;
  readonly story: string;
  readonly summary: string;
  readonly event: { readonly id: string; readonly at: string };
}

export type TraceResult = TraceOverview | TraceDetail | TraceResolved;

/** The projection's state, read only: an empty state without a journal or outside Git. */
async function readState(context: CommandContext): Promise<ProjectionState["state"]> {
  if (context.journal === undefined) return {};
  try {
    return await currentState(context);
  } catch (error) {
    if (error instanceof AgentPluggedError && error.code === ErrorCode.NOT_A_GIT_REPO) return {};
    throw error;
  }
}

/** The tests' citations through the port: never a failure, `unavailable` without it. */
async function readTests(
  context: CommandContext,
): Promise<{ references: TestReference[] | null; status: TraceTests["status"] }> {
  const source = context.testReferences;
  if (source === undefined) return { references: null, status: "unavailable" };
  try {
    const read = await source.read();
    if (!read.found) return { references: null, status: "unavailable" };
    return {
      references: testReferences(read.lines, read.files),
      status: read.truncated ? "truncated" : "read",
    };
  } catch {
    return { references: null, status: "unavailable" };
  }
}

/**
 * The trace of the product, read only (no key, nothing written): every active requirement, or the
 * one `requirement` (`REQUIREMENT_NOT_FOUND` when no `prd` document defines it).
 */
async function readTrace(
  context: CommandContext,
  requirement: string | undefined,
): Promise<TraceOverview | TraceDetail | AgentPluggedError> {
  if (!(await context.files.exists(METHOD_CONFIG_PATH))) return methodNotInstalled();
  const loaded = await loadMethodConfig(context.files);
  if (loaded instanceof AgentPluggedError) return loaded;
  const files = await readDocumentFiles(context.files, true);
  const documents = files.map((file) => parseDocumentFile(file.path, file.text));
  const state = await readState(context);
  const tests = await readTests(context);
  const inputs: TraceInputs = { documents, state, references: tests.references };
  const testView: TraceTests = {
    status: tests.status,
    references: tests.references?.length ?? 0,
  };
  if (requirement !== undefined) {
    const definition = tracedRequirements(documents).get(requirement);
    if (definition === undefined) {
      return new AgentPluggedError(ErrorCode.REQUIREMENT_NOT_FOUND, "error.requirement_not_found", {
        requirement,
      });
    }
    return {
      action: "requirement",
      requirement: traceRequirement(requirement, definition, inputs),
      tests: testView,
    };
  }
  const requirements = traceSummaries(inputs);
  return {
    action: "overview",
    requirements,
    counts: statusCounts(requirements),
    deviations: openDeviations(state),
    tests: testView,
  };
}

/**
 * `get_trace`: the trace of the product, read only. Without `requirement`, every
 * active `EF-n` and `ENF-n` with its status; with it, the stories, tests, pull requests and
 * deviations linked to that requirement.
 */
export const getTraceCommand = defineCommand<TraceOverview | TraceDetail>({
  name: "get_trace",
  audience: "agent",
  description:
    "Read the traceability of the product, computed at read time, nothing written. Without `requirement`: every active EF-n and ENF-n of the PRD with its status (todo, in_development, in_review, delivered, deviation), its stories, how many tests and pull requests, its open deviations, and the open deviations. With `requirement` (EF-n or ENF-n): its text, its stories with their status, the tests that cite it (path:line), the pull requests of its stories, and its deviations, open and resolved. A test cites a requirement by writing its id in its name or in a comment (EF-18, or EF_18 where a name takes no dash), in a test file; the tests are read in this working copy. REQUIREMENT_NOT_FOUND when the PRD does not define it.",
  inputSchema: GetTraceInputSchema,
  async run(context, input) {
    const parsed = GetTraceInputSchema.safeParse(input);
    if (!parsed.success) return fail(invalidInput("get_trace", parsed.error));
    let requirement: string | undefined;
    if (parsed.data.requirement !== undefined) {
      const typed = TracedRequirementInputSchema.safeParse(parsed.data.requirement);
      if (!typed.success) {
        return fail(invalid("get_trace", "requirement", "expected EF-n or ENF-n"));
      }
      requirement = typed.data;
    }
    try {
      const result = await readTrace(context, requirement);
      return result instanceof AgentPluggedError ? fail(result) : ok(result);
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    }
  },
});

const FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  overview: new Set(["action"]),
  requirement: new Set(["action", "requirement"]),
  resolve: new Set(["action", "deviation", "reason"]),
};

/**
 * `trace`, the creator's command:
 * - `{ action: "overview" }`: every active requirement with its status. Read only.
 * - `{ action: "requirement", requirement }`: everything linked to one requirement. Read only.
 * - `{ action: "resolve", deviation, reason }`: arguments checked first (`INVALID_ARGUMENTS`),
 *   then `deviation.resolved` written, signed by the creator's key (`locale`), at an interactive
 *   terminal only (`REVIEW_NOT_INTERACTIVE`). Never creates a key (`HUMAN_KEY_MISSING`), refuses a
 *   key the product does not trust (`HUMAN_KEY_UNENDORSED`), an unknown deviation
 *   (`DEVIATION_NOT_FOUND`) or a resolved one (`DEVIATION_NOT_OPEN`), checked again under the
 *   journal lock. Dated after the report, then read back: not applied,
 *   `DEVIATION_RESOLUTION_IGNORED`.
 * Never exposed to agents.
 */
export const traceCommand = defineCommand<TraceResult>({
  name: "trace",
  async run(context, input) {
    const action = String(input.action ?? "overview");
    const fields = Object.hasOwn(FIELDS, action) ? FIELDS[action] : undefined;
    if (fields === undefined) {
      return fail(invalid("trace", "action", `${action} (overview, requirement, resolve)`));
    }
    const extra = Object.keys(input).find((field) => !fields.has(field));
    if (extra !== undefined) return fail(invalid("trace", extra, "unknown"));
    try {
      if (action !== "resolve") {
        let requirement: string | undefined;
        if (action === "requirement") {
          const typed = TracedRequirementInputSchema.safeParse(input.requirement);
          if (!typed.success) {
            return fail(
              invalid("trace", "requirement", `${String(input.requirement)} (EF-n or ENF-n)`),
            );
          }
          requirement = typed.data;
        }
        const result = await readTrace(context, requirement);
        return result instanceof AgentPluggedError ? fail(result) : ok(result);
      }
      const id = DeviationIdInputSchema.safeParse(input.deviation);
      if (!id.success) {
        return fail(invalid("trace", "deviation", "expected V- then 10 characters"));
      }
      const reason = DeviationReasonSchema.safeParse(input.reason);
      if (!reason.success) {
        return fail(invalid("trace", "reason", "1 to 1000 characters, without control characters"));
      }
      const target = await humanTarget(context, "trace");
      if (target instanceof AgentPluggedError) return fail(target);
      const creator = await trustedCreator(context, target);
      if (creator instanceof AgentPluggedError) return fail(creator);
      const { key, state } = creator;
      const deviation = openDeviation(state, id.data);
      if (deviation instanceof AgentPluggedError) return fail(deviation);
      // Dated after the report: a clock behind it never puts the resolution first.
      const dated = datedAfter(context, deviation.reported_at);
      const [event] = (
        await writeHuman(
          dated,
          target,
          key,
          [
            {
              type: DEVIATION_EVENT_TYPES.resolved,
              payload: { deviation: deviation.id, reason: reason.data },
              signer: localeSigner(key),
            },
          ],
          async (written) => {
            const current = await project(context, target.config, written);
            const still = openDeviation(current.state, id.data);
            if (still instanceof AgentPluggedError) throw still;
          },
        )
      ).filter((written) => written.type === DEVIATION_EVENT_TYPES.resolved);
      if (event === undefined) throw new Error("trace: nothing was written");
      const applied = deviationResolutionProblem(
        await currentState(context),
        deviation.id,
        event.id,
      );
      if (applied !== undefined) return fail(applied);
      return ok({
        action: "resolve",
        deviation: deviation.id,
        story: deviation.story,
        summary: deviation.summary,
        event: { id: event.id, at: event.at },
      });
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    }
  },
});

/** The agents' tools of the traceability, exposed as MCP tools after the others. */
export const traceAgentCommands = [
  reportDeviationCommand,
  resolveDeviationCommand,
  getTraceCommand,
] as const;
