import {
  COURSE_EVENT_TYPES,
  COURSE_KINDS,
  type CourseInput,
  CourseInputSchema,
  type CourseStep,
  courseIdOf,
  ErrorCode,
  type ProjectionState,
} from "@agentplugged/protocol";
import { agentEventCommand, invalidInput } from "../agent-activity/agent-commands.js";
import { type CommandContext, defineCommand, fail, ok } from "../command.js";
import { currentState } from "../deferred/deferred-commands.js";
import { readDocumentFiles } from "../docs/docs-command.js";
import { AgentPluggedError } from "../errors.js";
import {
  type CourseRecord,
  checkCourse,
  computeImpact,
  courseById,
  courseIsCoherent,
  handoffs,
  type Impact,
  type ImpactInputs,
  leftLines,
  openCourse,
  validateDecisions,
} from "./course-rules.js";

type State = ProjectionState["state"];

/** What an opening computed before the write: the impact, or the starts that name nothing. */
interface Prepared {
  readonly impact: Impact | undefined;
  readonly unknown: readonly string[];
}

function invalid(step: string, reason: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
    command: "correct_course",
    field: step,
    reason: `correct_course: ${step}: ${reason}`,
  });
}

/** What the impact reads in the working copy and the tests, once. */
async function readInputs(context: CommandContext, state: State): Promise<ImpactInputs> {
  const files = await readDocumentFiles(context.files, true);
  let tests: ImpactInputs["tests"] = null;
  try {
    const read = await context.testReferences?.read();
    if (read?.found === true) tests = { lines: read.lines, files: read.files };
  } catch {
    // The tests could not be read: the impact says nothing of them, never a failure.
  }
  return { files, state, tests };
}

/** The course a call is about: its `item`, else the one that is open. */
function targetOf(state: State, item: string | undefined): CourseRecord | undefined {
  return item === undefined ? openCourse(state) : courseById(state, item);
}

/** What is wrong with a call, as codes; empty when it is whole and fits the state. */
function problemsOf(input: CourseInput, state: State, prepared: Prepared | undefined): string[] {
  switch (input.step) {
    case "open": {
      const problems: string[] = [];
      if (input.summary === undefined) problems.push("summary: the change, one line");
      if (input.starts === undefined) problems.push("starts: what the change touches");
      if (input.quote === undefined) problems.push("quote: the creator's words");
      const open = openCourse(state);
      if (open !== undefined)
        problems.push(`${open.id}: a course is already open, finish it first`);
      for (const start of prepared?.unknown ?? []) problems.push(`${start}: not found`);
      return problems;
    }
    case "decide":
      return validateDecisions(targetOf(state, input.item), input);
    case "close": {
      const course = targetOf(state, input.item);
      if (course === undefined) return ["course: unknown"];
      return course.status === "open" ? [] : ["course: closed"];
    }
    default:
      return targetOf(state, input.item) === undefined ? ["course: none open"] : [];
  }
}

/** The refusal of a call that is not whole or does not fit the state, or undefined. */
function whole(
  input: CourseInput,
  state: State,
  prepared: Prepared | undefined,
): AgentPluggedError | undefined {
  const problems = problemsOf(input, state, prepared);
  if (problems.length === 0) return undefined;
  return invalid(input.step, `not whole (${problems.length}): ${problems.slice(0, 20).join(", ")}`);
}

const recordCourse = agentEventCommand<typeof CourseInputSchema, Prepared>({
  name: "correct_course",
  description: "Record a change of course, the creator's gestures on its stack, or its closing.",
  inputSchema: CourseInputSchema,
  needsState: () => true,
  prepare: async (input, context) => {
    if (input.step !== "open" || input.starts === undefined)
      return { impact: undefined, unknown: [] };
    const computed = computeImpact(
      input.starts,
      await readInputs(context, await currentState(context)),
    );
    return "unknown" in computed
      ? { impact: undefined, unknown: computed.unknown }
      : { impact: computed, unknown: [] };
  },
  events: (input, state, prepared) => {
    // A call that is not whole is refused before anything is written.
    const refused = whole(input, state ?? {}, prepared);
    if (refused !== undefined) throw refused;
    if (input.step === "open") {
      const impact = prepared?.impact as Impact;
      return {
        events: [
          {
            type: COURSE_EVENT_TYPES.opened,
            payload: {
              summary: input.summary,
              quote: input.quote,
              starts: input.starts,
              stack: impact.stack,
              more: impact.more,
              proofs: impact.proofs,
            },
          },
        ],
      };
    }
    const course = targetOf(state ?? {}, input.item);
    if (input.step === "decide") {
      return {
        events: [
          {
            type: COURSE_EVENT_TYPES.decided,
            payload: { course: course?.id, decisions: input.items, quote: input.quote },
          },
        ],
      };
    }
    return { events: [{ type: COURSE_EVENT_TYPES.closed, payload: { course: course?.id } }] };
  },
  check: (input, state, { prepared }) => whole(input, state, prepared),
});

/** What `plan.course` answers, by step; only what the next gesture needs. */
export interface CourseResult {
  readonly course?: string;
  /** The stack the creator reads, the most structuring first; at most 12 lines. */
  readonly stack?: readonly string[];
  /** Elements past the lines shown (or past what the stack holds). */
  readonly more?: number;
  /** How many elements of each kind. */
  readonly kinds?: Readonly<Record<string, number>>;
  /** Requirements whose proof goes stale. */
  readonly proofs?: readonly string[];
  /** Stories under way that do not merge before their decision, with their developer. */
  readonly blocked?: readonly string[];
  /** Decide: the gestures counted. */
  readonly decided?: Readonly<Record<string, number>>;
  /** Decide: who writes the updates, and what. */
  readonly handoff?: readonly { readonly owner: string; readonly refs: readonly string[] }[];
  /** What is left to decide. */
  readonly left?: number;
  /** Close: true once everything is coherent; else the problems, and nothing is written. */
  readonly closed?: boolean;
  readonly problems?: readonly string[];
  readonly problems_more?: number;
}

/** The most lines of the stack one answer shows. */
const SHOWN = 12;

/** The answer to an opening: the stack as the creator reads it, bounded. */
export function openedAnswer(course: CourseRecord): CourseResult {
  const left = leftLines(course, SHOWN);
  const kinds: Record<string, number> = {};
  for (const kind of COURSE_KINDS) {
    const count = course.stack.filter((item) => item.kind === kind).length;
    if (count > 0) kinds[kind] = count;
  }
  const blocked = course.stack
    .filter((item) => item.kind === "story" && item.status === "in_progress")
    .map((item) => `${item.ref}${item.developer === undefined ? "" : ` (${item.developer})`}`);
  return {
    course: course.id,
    stack: left.lines,
    ...(left.more + course.more > 0 ? { more: left.more + course.more } : {}),
    kinds,
    ...(course.proofs.length > 0 ? { proofs: course.proofs } : {}),
    ...(blocked.length > 0 ? { blocked: blocked.slice(0, SHOWN) } : {}),
    left: course.stack.filter((item) => item.gesture === null).length,
  };
}

async function resultOf(
  context: CommandContext,
  input: CourseInput,
  step: CourseStep,
  eventId: string,
  state: State,
): Promise<CourseResult> {
  const course =
    step === "open" ? courseById(state, courseIdOf(eventId)) : targetOf(state, input.item);
  if (course === undefined) return {};
  switch (step) {
    case "open":
      return openedAnswer(course);
    case "show": {
      const left = leftLines(course, SHOWN);
      const check = checkCourse(course, await readDocumentFiles(context.files, true), state);
      return {
        course: course.id,
        stack: left.lines,
        ...(left.more > 0 ? { more: left.more } : {}),
        left: check.left,
        ...(check.problems.length > 0 ? { problems: check.problems } : {}),
      };
    }
    case "decide": {
      const decided: Record<string, number> = {};
      for (const decision of input.items ?? []) {
        decided[decision.gesture] = (decided[decision.gesture] ?? 0) + 1;
      }
      const left = leftLines(course, SHOWN);
      return {
        course: course.id,
        decided,
        handoff: handoffs(course, input.items ?? []),
        left: course.stack.filter((item) => item.gesture === null).length,
        ...(left.lines.length > 0 ? { stack: left.lines } : {}),
        ...(left.more > 0 ? { more: left.more } : {}),
      };
    }
    default:
      return { course: course.id, closed: course.status === "closed" };
  }
}

/**
 * `plan.course`: the correction of course, in four steps of one action. `open` takes
 * what the creator changes (their words, the elements it touches) and answers the stack the
 * engine computed by the trace; `decide` records the creator's gesture on each element (update,
 * retire, keep); `show` says what is left and what is still incoherent; `close` checks that the
 * documents, the stories and the proofs are coherent again, and writes nothing while they are not.
 * Nothing here rewrites a document: the author does, on the creator's gesture.
 */
export const courseCommand = defineCommand<CourseResult>({
  name: "correct_course",
  audience: "agent",
  description:
    "Correct the course when the creator changes their mind (skill correct-course); four steps (`step`). Open: `starts` (what it touches, 1 to 8: EF-n, ENF-n, AD-n, a story 4-3, a criterion 4-3#2, a passage prd#Heading), `summary` (the change, one line) and the creator's words in `quote`; the engine reads the trace and answers `course` (C-…), `stack` (the elements to decide, the most structuring first, one line each), `blocked` (stories under way: they do not merge before their decision), `proofs` (going stale). Decide: `item` C-…, `items` (`n`, `gesture`: update, retire for a requirement or a decision (the id stays, marked retired), or keep with a `reason`) and `quote`; answers `handoff`: who writes each update. Show: `item` alone: what is left and what is still incoherent. Close: `item`: the engine checks that no story cites a retired requirement and no proof of a changed requirement stays valid; `closed` true, else `problems` and nothing is written. Never decide without the creator's words, never rewrite their text.",
  inputSchema: CourseInputSchema,
  async run(context, input) {
    const parsed = CourseInputSchema.safeParse(input);
    if (!parsed.success) return fail(invalidInput("correct_course", parsed.error));
    const step = parsed.data.step as CourseStep;
    if (step === "show") {
      const state = await currentState(context);
      const problems = problemsOf(parsed.data, state, undefined);
      if (problems.length > 0) return fail(invalid(step, problems.join(", ")));
      return ok(await resultOf(context, parsed.data, step, "", state));
    }
    if (step === "close") {
      const state = await currentState(context);
      const problems = problemsOf(parsed.data, state, undefined);
      if (problems.length > 0) return fail(invalid(step, problems.join(", ")));
      const course = targetOf(state, parsed.data.item) as CourseRecord;
      const check = checkCourse(course, await readDocumentFiles(context.files, true), state);
      if (!courseIsCoherent(check)) {
        return ok({
          course: course.id,
          closed: false,
          left: check.left,
          ...(check.problems.length > 0 ? { problems: check.problems } : {}),
          ...(check.more > 0 ? { problems_more: check.more } : {}),
        });
      }
    }
    const written = await recordCourse.run(context, input);
    if (!written.ok) return fail(written.error);
    // A journal that already holds another open course does not apply an opening: say so.
    if (
      step === "open" &&
      courseById(await currentState(context), courseIdOf(written.value.id)) === undefined
    ) {
      return fail(invalid(step, "not applied: a course is already open"));
    }
    return ok(
      await resultOf(context, parsed.data, step, written.value.id, await currentState(context)),
    );
  },
});

/** The agents' commands of the correction of course, exposed as an MCP action after the others. */
export const courseAgentCommands = [courseCommand] as const;
