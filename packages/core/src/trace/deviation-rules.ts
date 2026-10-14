import { ErrorCode } from "@agentplugged/protocol";
import { AgentPluggedError } from "../errors.js";
import { byEvent, recordById, recordsOf } from "../registers.js";

/**
 * The deviations of a product, as the projection builds them: pure rules, read by
 * `get_state`, `trace`, `get_trace` and the merge gate. Every helper returns copies: the
 * projection's own objects never leave this module.
 */

/** How a deviation was lifted, by whom and why. */
export interface DeviationResolution {
  readonly reason: string;
  /** The agent that reported it, or the creator's device (`human:…`). */
  readonly by: string;
  readonly at: string;
  /** The ULID of the `deviation.resolved` event. */
  readonly event: string;
}

/** `state.deviations[id]`: a deviation of a story from requirements it cites. */
export interface Deviation {
  /** `V-` then the last 10 characters of the ULID of the event that reported it. */
  readonly id: string;
  readonly story: string;
  /** The requirements the delivered work drifts from, as reported. */
  readonly requirements: readonly string[];
  readonly summary: string;
  readonly detail: string | null;
  /** The story's pull request when it was reported, or null. */
  readonly pr: number | null;
  /** The commit compared, or null. */
  readonly commit: string | null;
  readonly status: "open" | "resolved";
  /** The agent that reported it. */
  readonly reported_by: string;
  readonly reported_at: string;
  /** The ULID of the `deviation.reported` event: the reporting order. */
  readonly event: string;
  readonly resolved: DeviationResolution | null;
}

/** A copy of a deviation, its lists and its resolution copied too. */
function copyOf(deviation: Deviation): Deviation {
  return {
    ...deviation,
    requirements: [...deviation.requirements],
    resolved: deviation.resolved === null ? null : { ...deviation.resolved },
  };
}

const recordOf = (state: Readonly<Record<string, unknown>>) =>
  recordsOf<Deviation>(state, "deviations");

/** Every deviation of a projection's state, copied, in reporting order. */
export function deviationsOf(state: Readonly<Record<string, unknown>>): Deviation[] {
  return Object.values(recordOf(state)).sort(byEvent).map(copyOf);
}

/** The open deviations, copied, in reporting order; of one story when `story` is given. */
export function openDeviations(
  state: Readonly<Record<string, unknown>>,
  story?: string,
): Deviation[] {
  return deviationsOf(state).filter(
    (deviation) =>
      deviation.status === "open" && (story === undefined || deviation.story === story),
  );
}

/** What `get_state` shows of the deviations. */
export interface DeviationView {
  /** The open deviations, in reporting order. */
  readonly open: readonly Deviation[];
  /** How many were resolved. */
  readonly resolved: number;
}

/** The deviations as `get_state` shows them: copies. */
export function deviationView(state: Readonly<Record<string, unknown>>): DeviationView {
  const all = deviationsOf(state);
  return {
    open: all.filter((deviation) => deviation.status === "open"),
    resolved: all.filter((deviation) => deviation.status === "resolved").length,
  };
}

/** The deviation `id` (canonical: `V-` and upper case), copied: else `DEVIATION_NOT_FOUND`. */
export function findDeviation(
  state: Readonly<Record<string, unknown>>,
  id: string,
): Deviation | AgentPluggedError {
  const record = recordOf(state);
  const deviation = recordById(record, id);
  if (deviation === undefined) {
    return new AgentPluggedError(ErrorCode.DEVIATION_NOT_FOUND, "error.deviation_not_found", {
      deviation: id,
    });
  }
  return copyOf(deviation);
}

/** The open deviation `id`, copied: else `DEVIATION_NOT_FOUND`, or `DEVIATION_NOT_OPEN`. */
export function openDeviation(
  state: Readonly<Record<string, unknown>>,
  id: string,
): Deviation | AgentPluggedError {
  const deviation = findDeviation(state, id);
  if (deviation instanceof AgentPluggedError) return deviation;
  if (deviation.status !== "open") {
    return new AgentPluggedError(ErrorCode.DEVIATION_NOT_OPEN, "error.deviation_not_open", {
      deviation: id,
      status: deviation.status,
    });
  }
  return deviation;
}

/**
 * True when `agent` may lift `deviation` (`lift_deviation`): the agent that reported it, unless
 * it is the story's developer (`developer`, the agent of its `story.started`): a developer never
 * lifts a deviation on its own work, even one it reported. The creator lifts any at the terminal
 * (`trace resolve`). The reducer applies the same rule. Agent ids are declared by the AI tools:
 * the rule holds for agents that keep their own id (the constitution says so).
 */
export function agentMayResolve(
  deviation: Pick<Deviation, "reported_by">,
  agent: string,
  developer: string | undefined,
): boolean {
  return agent === deviation.reported_by && agent !== developer;
}

/** The developer of a story: the agent of its `story.started`, when it started. */
export function storyDeveloper(
  state: Readonly<Record<string, unknown>>,
  story: string,
): string | undefined {
  const stories = state.stories as
    | Record<string, { readonly started?: { readonly agent: string } }>
    | undefined;
  if (stories === undefined || !Object.hasOwn(stories, story)) return undefined;
  return stories[story]?.started?.agent;
}

/**
 * `DEVIATION_RESOLUTION_IGNORED` unless the projection applied the resolution `event` to the
 * deviation `id`: the check a resolution runs once written.
 */
export function deviationResolutionProblem(
  state: Readonly<Record<string, unknown>>,
  id: string,
  event: string,
): AgentPluggedError | undefined {
  const deviation = findDeviation(state, id);
  if (!(deviation instanceof AgentPluggedError) && deviation.resolved?.event === event) {
    return undefined;
  }
  return new AgentPluggedError(
    ErrorCode.DEVIATION_RESOLUTION_IGNORED,
    "error.deviation_resolution_ignored",
    { deviation: id, event },
  );
}
