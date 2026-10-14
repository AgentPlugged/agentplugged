import {
  REQUIREMENT_STATUSES,
  type RequirementStatus,
  TRACED_REQUIREMENT_PATTERN,
} from "@agentplugged/protocol";
import type { Definition, ParsedDocument } from "../docs/parse-document.js";
import { compareStories, storiesOf } from "../docs/story-rules.js";
import type { StoryState } from "../projection/agent-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { holdsRequirements } from "../spec/spec-kinds.js";
import { type SprintStoryStatus, storyDoneAt } from "../sprints/sprint-rules.js";
import { type Deviation, deviationsOf } from "./deviation-rules.js";
import type { TestReference } from "./test-references.js";

/**
 * Traceability, as pure rules: each `EF-n` and `ENF-n` of a `prd` document, linked at
 * read time to the stories of the working copy that cite it (`requirements`), their status in the
 * projection, their pull requests, the tests that cite it and the deviations recorded on it, with
 * the status that follows. Nothing here is written anywhere.
 */

/** A story that cites a requirement, with where it stands. */
export interface TracedStory {
  readonly id: string;
  /** Its title, or null when its header has none. */
  readonly title: string | null;
  readonly path: string;
  /** Done, its last status, or not started (`todo`). */
  readonly status: SprintStoryStatus;
}

/** The pull request of a story that cites a requirement. */
export interface TracedPullRequest {
  readonly story: string;
  readonly forge: string;
  readonly number: number;
  readonly url: string;
}

/** A requirement with everything linked to it. */
export interface RequirementTrace {
  readonly id: string;
  /** The text of its definition, as written. */
  readonly text: string;
  readonly path: string;
  readonly line: number;
  readonly retired: boolean;
  readonly status: RequirementStatus;
  readonly stories: readonly TracedStory[];
  /**
   * The tests that cite it (`line` 0: the file's name), or empty when the tests could not be read.
   */
  readonly tests: readonly { readonly path: string; readonly line: number }[];
  readonly pull_requests: readonly TracedPullRequest[];
  /** Its deviations, open and resolved, in reporting order. */
  readonly deviations: readonly Deviation[];
}

/** A requirement as the overview shows it. */
export interface RequirementSummary {
  readonly id: string;
  readonly text: string;
  readonly status: RequirementStatus;
  readonly stories: readonly string[];
  /** The test files that cite it, or null when the tests could not be read. */
  readonly tests: number | null;
  readonly pull_requests: number;
  /** Its open deviations. */
  readonly deviations: number;
}

/** What the trace reads: the documents, the projection's state and the tests' citations. */
export interface TraceInputs {
  readonly documents: readonly ParsedDocument[];
  readonly state: Readonly<Record<string, unknown>>;
  /** The tests' citations, or null when the tests could not be read. */
  readonly references: readonly TestReference[] | null;
}

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function recordOf<T>(state: Readonly<Record<string, unknown>>, key: string): Record<string, T> {
  const value = state[key];
  return typeof value === "object" && value !== null ? (value as Record<string, T>) : {};
}

/** Requirement order: `EF` before `ENF`, then by number. */
export function compareRequirements(a: string, b: string): number {
  const [pa = "", na = "0"] = a.split("-");
  const [pb = "", nb = "0"] = b.split("-");
  if (pa !== pb) return pa < pb ? -1 : 1;
  return Number(na) - Number(nb);
}

/**
 * The traced requirements of the `prd` documents, by id: the first active definition, else the
 * first retired one (a retired requirement keeps its id).
 */
export function tracedRequirements(documents: readonly ParsedDocument[]): Map<string, Definition> {
  const found = new Map<string, Definition>();
  for (const document of documents) {
    if (!holdsRequirements(document.kind?.value)) continue;
    for (const definition of document.definitions) {
      if (!TRACED_REQUIREMENT_PATTERN.test(definition.id)) continue;
      const known = found.get(definition.id);
      if (known === undefined || (known.retired && !definition.retired)) {
        found.set(definition.id, definition);
      }
    }
  }
  return found;
}

/** Where a story stands: done, its last status, or not started. */
export function tracedStoryStatus(
  state: Readonly<Record<string, unknown>>,
  id: string,
): SprintStoryStatus {
  const story = own(recordOf<StoryState>(state, "stories"), id);
  const checkpoints = Object.values(recordOf<CheckpointState>(state, "checkpoints"));
  if (storyDoneAt(checkpoints, id, story) !== undefined) return "done";
  return story?.status ?? "todo";
}

/**
 * The status of a requirement: `deviation` while an open deviation names it; else `todo` without a
 * story or with none started nor done; `delivered` when every story is done; `in_review` when
 * every story not done is in review; else `in_development`.
 */
export function requirementStatus(
  stories: readonly SprintStoryStatus[],
  openDeviations: number,
): RequirementStatus {
  if (openDeviations > 0) return "deviation";
  if (stories.every((status) => status === "todo")) return "todo";
  if (stories.every((status) => status === "done")) return "delivered";
  if (stories.every((status) => status === "done" || status === "in_review")) return "in_review";
  return "in_development";
}

/** Everything linked to the requirement `id`, whose definition is `definition`. */
export function traceRequirement(
  id: string,
  definition: Definition,
  inputs: TraceInputs,
): RequirementTrace {
  const documents = storiesOf(inputs.documents);
  const stories = [...documents.entries()]
    .filter(([, document]) =>
      (document.story?.requirements ?? []).some((requirement) => requirement.value === id),
    )
    .map(([story]) => story)
    .sort(compareStories);
  const projected = recordOf<StoryState>(inputs.state, "stories");
  const traced: TracedStory[] = stories.map((story) => {
    const document = documents.get(story) as ParsedDocument;
    return {
      id: story,
      title: document.title?.value ?? null,
      path: document.path,
      status: tracedStoryStatus(inputs.state, story),
    };
  });
  const pullRequests: TracedPullRequest[] = [];
  for (const story of stories) {
    const pr = own(projected, story)?.pull_request;
    if (pr !== undefined) {
      pullRequests.push({ story, forge: pr.forge, number: pr.number, url: pr.url });
    }
  }
  const deviations = deviationsOf(inputs.state).filter((deviation) =>
    deviation.requirements.includes(id),
  );
  const open = deviations.filter((deviation) => deviation.status === "open").length;
  return {
    id,
    text: definition.text,
    path: definition.path,
    line: definition.line,
    retired: definition.retired,
    status: requirementStatus(
      traced.map((story) => story.status),
      open,
    ),
    stories: traced,
    tests: (inputs.references ?? [])
      .filter((reference) => reference.requirement === id)
      .map((reference) => ({ path: reference.path, line: reference.line })),
    pull_requests: pullRequests,
    deviations,
  };
}

/** Every active traced requirement, in order, with its summary. */
export function traceSummaries(inputs: TraceInputs): RequirementSummary[] {
  return [...tracedRequirements(inputs.documents).entries()]
    .filter(([, definition]) => !definition.retired)
    .sort(([a], [b]) => compareRequirements(a, b))
    .map(([id, definition]) => {
      const trace = traceRequirement(id, definition, inputs);
      return {
        id,
        text: trace.text,
        status: trace.status,
        stories: trace.stories.map((story) => story.id),
        tests:
          inputs.references === null ? null : new Set(trace.tests.map((test) => test.path)).size,
        pull_requests: trace.pull_requests.length,
        deviations: trace.deviations.filter((deviation) => deviation.status === "open").length,
      };
    });
}

/** How many requirements stand at each status. */
export function statusCounts(
  summaries: readonly RequirementSummary[],
): Record<RequirementStatus, number> {
  const counts = Object.fromEntries(REQUIREMENT_STATUSES.map((status) => [status, 0])) as Record<
    RequirementStatus,
    number
  >;
  for (const summary of summaries) counts[summary.status] += 1;
  return counts;
}
