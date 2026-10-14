import {
  type AgentStoryStatus,
  MAX_SPRINT_CHECKPOINT_SUMMARY,
  MAX_SPRINT_USD,
  type SprintCapacity,
  type SprintProblemReason,
  type SprintStoryEntry,
} from "@agentplugged/protocol";
import { currentDeveloper } from "../agents/agent-aliases.js";
import { liftsBlocks, statusAt } from "../checkpoints/resolution-rules.js";
import { isBlobOf } from "../phases/design-review.js";
import { approvedAt, byAnswer } from "../phases/phases.js";
import type { StoryState } from "../projection/agent-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { byEvent } from "../registers.js";

/**
 * The rules of sprints, as pure functions: when a story is done, which sprint is in
 * force, how far it went, and whether a proposed sprint holds (`checkSprint`). The engine never
 * estimates anything: it adds up the budgets the stories carry and compares the capacity the
 * planner declared with the active agents.
 */

/** `state.sprints[id]`: a sprint as its `sprint.planned` event recorded it. */
export interface SprintState {
  /** `S-` then the last 10 characters of the ULID of its event. */
  readonly id: string;
  readonly goal: string;
  /** Its stories, in the order they are built, with their owner and budget when checked. */
  readonly stories: readonly SprintStoryEntry[];
  readonly capacity: SprintCapacity;
  readonly budget_usd: number;
  readonly budget_limit_usd: number | null;
  /** The `document` checkpoint that submits it to the creator, opened in the same write. */
  readonly checkpoint: string;
  /** The agent that proposed it. */
  readonly planned_by: string;
  readonly at: string;
  /** The ULID of its event: the order sprints were planned in. */
  readonly event: string;
}

/**
 * Where a sprint stands: `proposed` (its checkpoint open), `in_force` (the current sprint),
 * `superseded` (approved, then replaced by a sprint approved later), `refused` (its checkpoint
 * rejected or sent back for changes) or `waived` (its checkpoint waived, which `review` refuses
 *: an old journal only; never in force, never shown as refused).
 */
export type SprintStatus = "proposed" | "in_force" | "superseded" | "refused" | "waived";

/** Where a story of a sprint stands: done, its last status, or not started (`todo`). */
export type SprintStoryStatus = "done" | AgentStoryStatus | "todo";

/** A story of a sprint, with where it stands. */
export interface SprintStoryView extends SprintStoryEntry {
  readonly status: SprintStoryStatus;
}

/** A sprint as agents and `next` see it. */
export interface SprintView {
  readonly id: string;
  readonly goal: string;
  readonly status: SprintStatus;
  readonly stories: readonly SprintStoryView[];
  readonly capacity: SprintCapacity;
  readonly budget_usd: number;
  readonly budget_limit_usd: number | null;
  readonly checkpoint: string;
  readonly planned_by: string;
  readonly at: string;
}

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * When the creator last approved a `story` checkpoint of this story (a decision that lifts its
 * blocks) after its last status: the story is done then. Undefined while it is not done.
 *
 * A `story` checkpoint that cites a story file validates that file (a `document`
 * checkpoint's job, opened with the wrong type): it marked the story `done` before any code was
 * written, and never ends it. Nor does the approval of a blocked result's point.
 */
export function storyDoneAt(
  checkpoints: readonly CheckpointState[],
  id: string,
  story: StoryState | undefined,
): string | undefined {
  // A started story is done (delivered) once the engine merged it, never by an
  // approval alone (a blocked result's checkpoint, an answer without its merge).
  if (story?.started !== undefined) return story.merged?.at;
  const since = story?.status_by?.at;
  let latest: string | undefined;
  for (const checkpoint of checkpoints) {
    const resolution = checkpoint.resolution;
    if (
      checkpoint.type !== "story" ||
      checkpoint.source === "blocked_result" ||
      (story?.status_by == null && citesStoryFile(checkpoint.documents ?? [])) ||
      checkpoint.story !== id ||
      checkpoint.status === "open" ||
      resolution === null ||
      !liftsBlocks(resolution.decision) ||
      (since !== undefined && Date.parse(resolution.at) < Date.parse(since))
    ) {
      continue;
    }
    if (latest === undefined || Date.parse(resolution.at) > Date.parse(latest)) {
      latest = resolution.at;
    }
  }
  return latest;
}

/** The sprints of a projection, by id (an empty dictionary when there are none). */
export function sprintsOf(state: Readonly<Record<string, unknown>>): Record<string, SprintState> {
  const value = state.sprints;
  return typeof value === "object" && value !== null ? (value as Record<string, SprintState>) : {};
}

/** The ids of the checkpoints the sprints name: a checkpoint submits one sprint at most. */
export function sprintCheckpoints(sprints: Readonly<Record<string, SprintState>>): Set<string> {
  return new Set(Object.values(sprints).map((sprint) => sprint.checkpoint));
}

/** The checkpoint of a sprint, when it is one its planner opened. */
function checkpointOf(
  sprint: SprintState,
  checkpoints: Readonly<Record<string, CheckpointState>>,
): CheckpointState | undefined {
  const checkpoint = own(checkpoints, sprint.checkpoint);
  return checkpoint !== undefined && checkpoint.opened_by === sprint.planned_by
    ? checkpoint
    : undefined;
}

/**
 * The sprint in force at `now`: among the sprints whose checkpoint the creator approved (a
 * lifting decision, never a waiver: `approvedAt`), the one answered last; undefined without one.
 */
export function currentSprint(
  sprints: Readonly<Record<string, SprintState>>,
  checkpoints: Readonly<Record<string, CheckpointState>>,
  now: number,
): SprintState | undefined {
  const approved = Object.values(sprints)
    .map((sprint) => ({ sprint, checkpoint: checkpointOf(sprint, checkpoints) }))
    .filter(
      (entry): entry is { sprint: SprintState; checkpoint: CheckpointState } =>
        entry.checkpoint !== undefined && approvedAt(entry.checkpoint, now),
    )
    .sort((a, b) => byAnswer(a.checkpoint, b.checkpoint) || byEvent(a.sprint, b.sprint));
  return approved.at(-1)?.sprint;
}

/** The sprint planned last, whatever its status; undefined without one. */
export function latestSprint(
  sprints: Readonly<Record<string, SprintState>>,
): SprintState | undefined {
  return Object.values(sprints).sort(byEvent).at(-1);
}

/** Where `sprint` stands at `now` (see `SprintStatus`). */
export function sprintStatus(
  sprint: SprintState,
  sprints: Readonly<Record<string, SprintState>>,
  checkpoints: Readonly<Record<string, CheckpointState>>,
  now: number,
): SprintStatus {
  const checkpoint = checkpointOf(sprint, checkpoints);
  if (checkpoint === undefined) return "refused";
  if (checkpoint.resolution?.decision === "waived") return "waived";
  if (statusAt(checkpoint, now) === "open") return "proposed";
  if (!approvedAt(checkpoint, now)) return "refused";
  return currentSprint(sprints, checkpoints, now)?.id === sprint.id ? "in_force" : "superseded";
}

/** Where each story of the sprint stands, in the sprint's order. */
export function sprintStories(
  sprint: SprintState,
  stories: Readonly<Record<string, StoryState>>,
  checkpoints: readonly CheckpointState[],
): SprintStoryView[] {
  return sprint.stories.map((entry) => {
    const story = own(stories, entry.id);
    const status: SprintStoryStatus =
      storyDoneAt(checkpoints, entry.id, story) !== undefined ? "done" : (story?.status ?? "todo");
    return { id: entry.id, owner: entry.owner, budget_usd: entry.budget_usd, status };
  });
}

/** A sprint as `get_state` shows it. */
export function sprintView(
  sprint: SprintState,
  context: {
    readonly sprints: Readonly<Record<string, SprintState>>;
    readonly checkpoints: Readonly<Record<string, CheckpointState>>;
    readonly stories: Readonly<Record<string, StoryState>>;
    readonly now: number;
  },
): SprintView {
  return {
    id: sprint.id,
    goal: sprint.goal,
    status: sprintStatus(sprint, context.sprints, context.checkpoints, context.now),
    stories: sprintStories(sprint, context.stories, Object.values(context.checkpoints)),
    capacity: { agents: [...sprint.capacity.agents], humans: sprint.capacity.humans },
    budget_usd: sprint.budget_usd,
    budget_limit_usd: sprint.budget_limit_usd,
    checkpoint: sprint.checkpoint,
    planned_by: sprint.planned_by,
    at: sprint.at,
  };
}

/** A story of the working copy, as a sprint needs it. */
export interface SprintStory {
  readonly id: string;
  /** Its path, from the product's root (`.agentplugged/stories/…`), with `/`. */
  readonly path: string;
  /**
   * `valid`: `docs check` finds nothing in it; `invalid`: it does (`faults`); `unreadable`: its
   * file could not be read.
   */
  readonly state: "valid" | "invalid" | "unreadable";
  /** The codes of the `docs check` problems that make it invalid, sorted. */
  readonly faults: readonly string[];
  /** Its bytes, as written: compared with the blob an approved checkpoint names. */
  readonly bytes: Uint8Array;
  /** Who builds it (an agent, or `creator`), when valid. */
  readonly owner: string | undefined;
  readonly budget_usd: number | undefined;
  readonly depends_on: readonly string[];
  /**
   * The dependencies its header declares, even when `docs check` refuses the story (a dependency
   * cycle, a dependency on itself): the order of the merges reads them.
   */
  readonly declared_depends_on?: readonly string[];
  /** Its branch (`feat/<id>-<slug>`), when valid. */
  readonly branch?: string | undefined;
}

/** A story file a checkpoint lists: under `.agentplugged/stories/`, Markdown in any case. */
const STORY_FILE = /(?:^|\/)\.agentplugged\/stories\/[^/].*\.md$/i;

/** True when one of the documents a checkpoint cites is a story file. */
export function citesStoryFile(documents: readonly { readonly path: string }[]): boolean {
  return documents.some((document) =>
    STORY_FILE.test(document.path.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "")),
  );
}

/**
 * Whether each story was validated: `validated` when an approved `document` checkpoint (never a
 * waiver) lists a story file whose blob is the working copy's file, as written or with LF line
 * endings; `changed` when one listed its path at another blob only (the file changed since);
 * `never` otherwise. The blob names the content wherever it was committed, so the branch a
 * checkpoint names adds nothing once the content is the same.
 */
export function validationOf(
  documents: ReadonlyMap<string, SprintStory>,
  checkpoints: Iterable<CheckpointState>,
  now: number,
): Map<string, "validated" | "changed" | "never"> {
  const listed: { path: string; blob: string }[] = [];
  for (const checkpoint of checkpoints) {
    // A `story` point that cites story files was a validation opened with the wrong type.
    const validating =
      checkpoint.type === "document" ||
      (checkpoint.type === "story" && citesStoryFile(checkpoint.documents ?? []));
    if (!validating || !approvedAt(checkpoint, now)) continue;
    for (const document of checkpoint.documents) {
      const path = document.path.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
      if (!STORY_FILE.test(path)) continue;
      listed.push({ path: path.toLowerCase(), blob: document.blob_sha.toLowerCase() });
    }
  }
  const result = new Map<string, "validated" | "changed" | "never">();
  for (const story of documents.values()) {
    if (story.state === "unreadable") {
      result.set(story.id, "never");
      continue;
    }
    const path = story.path.toLowerCase();
    const samePath = listed.filter((entry) => entry.path.endsWith(path));
    const validated = listed.some((entry) => isBlobOf(entry.blob, story.bytes));
    result.set(story.id, validated ? "validated" : samePath.length > 0 ? "changed" : "never");
  }
  return result;
}

/** The ids of the stories `validationOf` finds validated. */
export function validatedStories(
  documents: ReadonlyMap<string, SprintStory>,
  checkpoints: Iterable<CheckpointState>,
  now: number,
): Set<string> {
  return new Set(
    [...validationOf(documents, checkpoints, now)]
      .filter(([, state]) => state === "validated")
      .map(([id]) => id),
  );
}

/** One rule a proposed sprint breaks. */
export interface SprintProblem {
  readonly reason: SprintProblemReason;
  readonly story?: string;
  readonly dependency?: string;
  readonly agent?: string;
  readonly checkpoint?: string;
  /** `not_validated`: `never` validated, or `changed` since; `invalid_story`: the codes. */
  readonly why?: string;
  readonly budget_usd?: number;
  readonly limit?: number;
  /** `budget_out_of_range`: the range, in US dollars, the budget had to stay in. */
  readonly low?: number;
  readonly high?: number;
  /** `too_long`: what does not fit (`summary`, or `stories` for the generated lines alone). */
  readonly field?: string;
  /** `too_long`: the most characters it may hold (0 when nothing of the planner's fits). */
  readonly max?: number;
}

/** What `checkSprint` needs. */
export interface CheckSprintInput {
  /** The proposed stories, in order. */
  readonly stories: readonly string[];
  readonly capacity: SprintCapacity;
  readonly budget_limit_usd?: number | undefined;
  /** The planner's summary, which shares the checkpoint's summary with the generated lines. */
  readonly summary: string;
  /** The stories of the working copy, by id. */
  readonly documents: ReadonlyMap<string, SprintStory>;
  /** Whether each story was validated (`validationOf`); absent: `never`. */
  readonly validation: ReadonlyMap<string, "validated" | "changed" | "never">;
  /** Stories already done (`storyDoneAt`). */
  readonly done: ReadonlySet<string>;
  /** The active agents of the product. */
  readonly agents: ReadonlySet<string>;
  /** The checkpoint of the last proposed sprint, while it is still open. */
  readonly openProposal?: string | undefined;
  /**
   * The range a story's budget must stay in: three times off what the product
   * measured, or off the method's reference. Absent: no guard (tests of other rules).
   */
  readonly budgetRange?: { readonly low: number; readonly high: number } | undefined;
}

/** Dollars rounded to the micro-dollar: sums stay readable, and the same on every machine. */
const dollars = (value: number) => Math.round(value * 1e6) / 1e6;

const USD = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  useGrouping: false,
});

/** `$1.50` for 1.5 US dollars: two decimals, never a scientific notation. */
export function formatUsd(value: number): string {
  return `$${USD.format(value)}`;
}

/**
 * The budget of a sprint: the sum of the `budget_usd` its stories carry, each story once, rounded
 * to the micro-dollar. A story without a valid header counts for nothing.
 */
export function sprintBudget(
  stories: readonly string[],
  documents: ReadonlyMap<string, SprintStory>,
): number {
  let total = 0;
  for (const id of new Set(stories)) total = dollars(total + (documents.get(id)?.budget_usd ?? 0));
  return total;
}

/** The stories of a sprint as recorded: id, owner and budget, from the checked working copy. */
export function sprintEntries(
  stories: readonly string[],
  documents: ReadonlyMap<string, SprintStory>,
): SprintStoryEntry[] {
  return stories.map((id) => {
    const story = documents.get(id);
    return { id, owner: story?.owner ?? "creator", budget_usd: story?.budget_usd ?? 0 };
  });
}

/**
 * The generated lines of a sprint's checkpoint summary: the stories in order with their owner
 * and budget, the total, the ceiling and the capacity. Never cut: what the creator approves is
 * what the journal records.
 */
export function sprintGeneratedLines(input: {
  readonly stories: readonly string[];
  readonly documents: ReadonlyMap<string, SprintStory>;
  readonly capacity: SprintCapacity;
  readonly budget_usd: number;
  readonly budget_limit_usd?: number | undefined;
}): string {
  const lines = sprintEntries(input.stories, input.documents).map(
    (entry, index) => `${index + 1}. ${entry.id} (${entry.owner}, ${formatUsd(entry.budget_usd)})`,
  );
  const agents = input.capacity.agents.length === 0 ? "none" : input.capacity.agents.join(", ");
  const limit =
    input.budget_limit_usd === undefined ? "" : ` (ceiling ${formatUsd(input.budget_limit_usd)})`;
  return [
    "Stories, in order:",
    ...lines,
    "",
    `Total estimate: ${formatUsd(input.budget_usd)}${limit}`,
    "These amounts are estimates (not costs) in US dollars at the API's public prices, from the product's finished stories or the method's reference.",
    `Capacity: agents ${agents}; humans ${input.capacity.humans}`,
  ].join("\n");
}

/** Between the planner's summary and the generated lines. */
const SUMMARY_SEPARATOR = "\n\n";

/** The checkpoint's summary: the planner's text, then the generated lines, whole. */
export function sprintCheckpointSummary(summary: string, generated: string): string {
  return `${summary}${SUMMARY_SEPARATOR}${generated}`;
}

/**
 * Checks a proposed sprint, every rule, in the order of the stories: each story exists, can be
 * read, passes `docs check`, was validated at its current content and is not done, appears once,
 * and each of its dependencies is done or comes earlier in the sprint; the capacity names active
 * agents, is not empty and covers the owner of each story (`creator` needs a human); the total of
 * the budgets stays under the ceiling and under what a sprint records; the checkpoint's summary
 * holds the generated lines and the planner's text whole; no earlier proposal waits for the
 * creator. Returns every problem, and the total.
 */
export function checkSprint(input: CheckSprintInput): {
  problems: SprintProblem[];
  budget_usd: number;
} {
  const problems: SprintProblem[] = [];
  if (input.openProposal !== undefined) {
    problems.push({ reason: "proposal_open", checkpoint: input.openProposal });
  }
  const { agents: capacityAgents, humans } = input.capacity;
  for (const agent of capacityAgents) {
    if (!input.agents.has(agent)) problems.push({ reason: "agent_inactive", agent });
  }
  if (capacityAgents.length === 0 && humans === 0) problems.push({ reason: "no_capacity" });
  const position = new Map<string, number>();
  input.stories.forEach((id, index) => {
    if (!position.has(id)) position.set(id, index);
  });
  const seen = new Set<string>();
  input.stories.forEach((id, index) => {
    if (seen.has(id)) {
      problems.push({ reason: "duplicate_story", story: id });
      return;
    }
    seen.add(id);
    const story = input.documents.get(id);
    if (story === undefined) {
      problems.push({ reason: "unknown_story", story: id });
      return;
    }
    if (story.state === "unreadable") {
      problems.push({ reason: "unreadable", story: id });
      return;
    }
    if (story.state === "invalid") {
      problems.push({ reason: "invalid_story", story: id, why: story.faults.join(", ") });
      return;
    }
    const validation = input.validation.get(id) ?? "never";
    if (validation !== "validated") {
      problems.push({ reason: "not_validated", story: id, why: validation });
    }
    if (input.done.has(id)) problems.push({ reason: "done", story: id });
    for (const dependency of story.depends_on) {
      if (input.done.has(dependency)) continue;
      const at = position.get(dependency);
      if (at === undefined) {
        problems.push({ reason: "dependency_missing", story: id, dependency });
      } else if (at > index) {
        problems.push({ reason: "dependency_later", story: id, dependency });
      }
    }
    // A story owned by a developer the renaming retired goes to its successor.
    const owner = story.owner === undefined ? undefined : currentDeveloper(story.owner);
    const covered =
      owner === undefined || (owner === "creator" ? humans > 0 : capacityAgents.includes(owner));
    if (!covered) problems.push({ reason: "owner_unavailable", story: id, agent: owner });
    // A budget three times off what was measured (or the method's reference) is a
    // guess, not an estimate: refused before the creator sees it.
    const range = input.budgetRange;
    if (range !== undefined && story.budget_usd !== undefined) {
      if (story.budget_usd < range.low || story.budget_usd > range.high) {
        problems.push({
          reason: "budget_out_of_range",
          story: id,
          budget_usd: story.budget_usd,
          low: range.low,
          high: range.high,
        });
      }
    }
  });
  const total = sprintBudget(input.stories, input.documents);
  const limit = Math.min(input.budget_limit_usd ?? MAX_SPRINT_USD, MAX_SPRINT_USD);
  if (total > limit) problems.push({ reason: "over_budget", budget_usd: total, limit });
  const generated = sprintGeneratedLines({
    stories: input.stories,
    documents: input.documents,
    capacity: input.capacity,
    budget_usd: total,
    budget_limit_usd: input.budget_limit_usd,
  });
  const room = MAX_SPRINT_CHECKPOINT_SUMMARY - generated.length - SUMMARY_SEPARATOR.length;
  if (room < 1) {
    problems.push({ reason: "too_long", field: "stories", max: 0 });
  } else if (input.summary.length > room) {
    problems.push({ reason: "too_long", field: "summary", max: room });
  }
  return { problems, budget_usd: total };
}

/** The story a problem names, else its agent, dependency or checkpoint. */
function describe(problem: SprintProblem): string {
  switch (problem.reason) {
    case "over_budget":
      return `over_budget: total ${formatUsd(problem.budget_usd ?? 0)} above ${formatUsd(problem.limit ?? 0)}`;
    case "budget_out_of_range":
      return `budget_out_of_range: ${problem.story} is budgeted ${formatUsd(problem.budget_usd ?? 0)}, more than three times off what this product measured or the method's reference (${formatUsd(problem.low ?? 0)} to ${formatUsd(problem.high ?? 0)}): read the estimates in get_state \`usage.estimates\`, one story at a time, and correct its budget_usd`;
    case "no_capacity":
      return "no_capacity: the capacity names no agent and no human";
    case "too_long":
      return problem.field === "summary"
        ? `too_long: the summary holds ${problem.max} characters at most next to the generated lines`
        : "too_long: the generated lines alone do not fit the checkpoint; plan fewer stories";
    default:
      return [
        problem.reason,
        problem.story,
        problem.dependency ?? problem.agent ?? problem.checkpoint,
        problem.why === undefined || problem.why === "" ? undefined : `(${problem.why})`,
      ]
        .filter((part) => part !== undefined)
        .join(" ");
  }
}

/** The line of `SPRINT_INVALID` for its problems: the first that names a story, else the first. */
export function firstSprintProblem(problems: readonly SprintProblem[]): string {
  const first = problems.find((problem) => problem.story !== undefined) ?? problems[0];
  return first === undefined ? "" : describe(first);
}
