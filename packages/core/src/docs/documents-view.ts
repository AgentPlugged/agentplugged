import {
  DOCS_DEVIATIONS_MAX,
  DOCS_DOCUMENTS_MAX,
  DOCS_REQUIREMENT_MAX_CHARS,
  DOCS_REQUIREMENTS_MAX,
  DOCS_TITLE_MAX_CHARS,
  DOCS_TRACE_MAX,
  DOCS_UNCOVERED_MAX,
  type DocStanding,
  type DocsDocument,
  type DocsEpic,
  type DocsListData,
  type DocsTraceData,
  epicIdOf,
  type RequirementStatus,
  TRACED_REQUIREMENT_PATTERN,
} from "@agentplugged/protocol";
import { approvedAt } from "../phases/phases.js";
import { checkpointsOf } from "../projection/checkpoint-reducers.js";
import { holdsRequirements } from "../spec/spec-kinds.js";
import { openDeviations } from "../trace/deviation-rules.js";
import type { TestReference } from "../trace/test-references.js";
import {
  compareRequirements,
  type TraceInputs,
  tracedRequirements,
  tracedStoryStatus,
  traceRequirement,
} from "../trace/trace-rules.js";
import type { DocumentFile } from "./docs-base.js";
import { type ParsedDocument, parseDocumentFile } from "./parse-document.js";
import { compareStories, epicsOf, storiesOf } from "./story-rules.js";

/**
 * The documents of a product as the web view reads them: pure rules over the document files of the
 * working copy and the projection's state. Everything that is computed is computed here, once: the
 * status of a requirement, how a document stands with the creator's approval, the breakdown and its
 * coverage. Nothing is written anywhere, and nothing here is guessed: a document whose header is
 * not valid is listed as `unknown` and its requirements are still traced.
 */

/** What the view reads: the document files, the projection's state, the tests' citations, the time. */
export interface DocumentsInputs {
  readonly files: readonly DocumentFile[];
  readonly state: Readonly<Record<string, unknown>>;
  /** The tests' citations, or null when the tests could not be read. */
  readonly references: readonly TestReference[] | null;
  readonly testsState: DocsListData["tests"];
  /** Milliseconds since the epoch: a waiver that ran out reads as open again. */
  readonly now: number;
  /** The files could not all be read (a limit, an unreadable folder): the lists may miss some. */
  readonly incomplete?: boolean;
}

const COVERED_PREFIXES = ["EF-", "ENF-"] as const;
const MAX_TITLE_SEARCH_LINES = 40;

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The path of a document as the checkpoints list it: from `.agentplugged/`, with `/`. */
function methodPath(path: string): string {
  const plain = path.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
  return /(?:^|\/)(\.agentplugged\/.+)$/.exec(plain)?.[1] ?? plain;
}

/**
 * How a document stands with the creator's approval: the latest `document` checkpoint that lists
 * it decides (open: to approve; a lifting decision: approved; changes asked; refused). None lists
 * it: `none`.
 */
export function documentStanding(
  path: string,
  state: Readonly<Record<string, unknown>>,
  now: number,
): DocStanding {
  const wanted = methodPath(path);
  const latest = Object.values(checkpointsOf(state))
    .filter(
      (checkpoint) =>
        checkpoint.type === "document" &&
        checkpoint.documents.some((document) => methodPath(document.path) === wanted),
    )
    .sort((a, b) =>
      a.opened_event < b.opened_event ? -1 : a.opened_event > b.opened_event ? 1 : 0,
    )
    .at(-1);
  if (latest === undefined) return "none";
  if (approvedAt(latest, now)) return "approved";
  if (latest.status === "open") return "to_approve";
  if (latest.status === "closed") return "none";
  switch (latest.resolution?.decision) {
    case "changes_requested":
      return "changes_requested";
    case "rejected":
      return "rejected";
    default:
      // A waiver, a choice among options: nothing that approves the document.
      return "to_approve";
  }
}

/** The first level 1 heading of the body, when the header gave no title. */
function headingOf(text: string): string | undefined {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  let start = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) start = end + 1;
  }
  let inFence = false;
  for (const line of lines.slice(start, start + MAX_TITLE_SEARCH_LINES)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const match = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (match?.[1] !== undefined) return oneLine(match[1]);
  }
  return undefined;
}

/** The order a product's documents are listed in: the method's own order, then the epics. */
const KIND_RANK: Readonly<Record<string, number>> = {
  brief: 0,
  prfaq: 1,
  prd: 2,
  ux: 3,
  architecture: 4,
  spec: 5,
};

function rankOf(document: DocsDocument): number {
  if (document.kind === "epic") return 90;
  return Object.hasOwn(KIND_RANK, document.kind) ? (KIND_RANK[document.kind] ?? 80) : 80;
}

function documentOf(
  parsed: ParsedDocument,
  text: string,
  state: Readonly<Record<string, unknown>>,
  now: number,
): DocsDocument {
  const kind = parsed.kind?.value ?? "unknown";
  const title = parsed.title?.value ?? headingOf(text);
  const defined = holdsRequirements(kind)
    ? parsed.definitions.filter((definition) => TRACED_REQUIREMENT_PATTERN.test(definition.id))
        .length
    : undefined;
  const links = parsed.links.map((link) => link.value).slice(0, 40);
  return {
    path: parsed.path,
    kind: cut(kind, 32),
    ...(parsed.id === undefined ? {} : { id: parsed.id }),
    ...(title === undefined || title === ""
      ? {}
      : { title: cut(oneLine(title), DOCS_TITLE_MAX_CHARS) }),
    ...(parsed.owner === undefined ? {} : { owner: parsed.owner.value }),
    standing: documentStanding(parsed.path, state, now),
    ...(defined === undefined || defined === 0 ? {} : { requirements: defined }),
    ...(links.length === 0 ? {} : { links }),
  };
}

function storyTitle(document: ParsedDocument): string | undefined {
  const title = document.title?.value;
  return title === undefined || title === ""
    ? undefined
    : cut(oneLine(title), DOCS_TITLE_MAX_CHARS);
}

/** The breakdown: the epics, each with its stories in order, where they stand and what they depend on. */
function breakdownOf(
  documents: readonly ParsedDocument[],
  state: Readonly<Record<string, unknown>>,
): DocsEpic[] {
  const stories = storiesOf(documents);
  const epics = epicsOf(documents);
  const ids = new Set<string>(epics.keys());
  for (const id of stories.keys()) ids.add(epicIdOf(id));
  const number = (id: string): number => Number(id.slice("epic-".length));
  return [...ids]
    .sort((a, b) => number(a) - number(b))
    .map((id) => {
      const epic = epics.get(id);
      const title = epic === undefined ? undefined : (epic.title?.value ?? undefined);
      return {
        id,
        ...(title === undefined || title === ""
          ? {}
          : { title: cut(oneLine(title), DOCS_TITLE_MAX_CHARS) }),
        ...(epic === undefined ? {} : { path: epic.path }),
        out_of_scope: (epic?.outOfScope ?? []).map((value) => value.value).slice(0, 200),
        stories: [...stories.entries()]
          .filter(([story]) => epicIdOf(story) === id)
          .sort(([a], [b]) => compareStories(a, b))
          .map(([story, document]) => {
            const title = storyTitle(document);
            return {
              id: story,
              ...(title === undefined ? {} : { title }),
              status: tracedStoryStatus(state, story),
              depends_on: (document.story?.dependsOn ?? [])
                .map((value) => value.value)
                .slice(0, 40),
              requirements: (document.story?.requirements ?? [])
                .map((value) => value.value)
                .filter((value) => TRACED_REQUIREMENT_PATTERN.test(value))
                .slice(0, 40),
            };
          }),
      };
    });
}

/**
 * The coverage of the requirements by the breakdown: the active functional and non-functional
 * requirements, those a story carries, those an epic leaves aside, and the others. Undefined while
 * no story exists (nothing is uncovered yet, the breakdown has not been made).
 */
function coverageOf(
  documents: readonly ParsedDocument[],
  active: readonly string[],
): DocsListData["coverage"] {
  const stories = storiesOf(documents);
  if (stories.size === 0) return undefined;
  const inStories = new Set<string>();
  for (const story of stories.values()) {
    for (const value of story.story?.requirements ?? []) inStories.add(value.value);
  }
  const leftAside = new Set<string>();
  for (const epic of epicsOf(documents).values()) {
    for (const value of epic.outOfScope) leftAside.add(value.value);
  }
  const counted = active.filter((id) => COVERED_PREFIXES.some((prefix) => id.startsWith(prefix)));
  const covered = counted.filter((id) => inStories.has(id));
  const aside = counted.filter((id) => !inStories.has(id) && leftAside.has(id));
  const uncovered = counted.filter((id) => !inStories.has(id) && !leftAside.has(id));
  return {
    total: counted.length,
    covered: covered.length,
    out_of_scope: aside.length,
    uncovered: uncovered.slice(0, DOCS_UNCOVERED_MAX),
  };
}

function traceInputs(inputs: DocumentsInputs, documents: readonly ParsedDocument[]): TraceInputs {
  return { documents, state: inputs.state, references: inputs.references };
}

function countsOf(statuses: readonly RequirementStatus[]): DocsListData["counts"] {
  const counts = { todo: 0, in_development: 0, in_review: 0, delivered: 0, deviation: 0 };
  for (const status of statuses) counts[status] += 1;
  return counts;
}

/** The documents, the requirements with their status, the breakdown and the coverage. */
export function documentsList(inputs: DocumentsInputs): Omit<DocsListData, "op"> {
  const parsed = inputs.files.map((file) => ({
    file,
    document: parseDocumentFile(file.path, file.text),
  }));
  const documents = parsed.map((entry) => entry.document);
  const listed = parsed
    .filter((entry) => !entry.file.path.includes("/stories/"))
    .map((entry) => documentOf(entry.document, entry.file.text, inputs.state, inputs.now))
    .sort((a, b) => {
      const byRank = rankOf(a) - rankOf(b);
      if (byRank !== 0) return byRank;
      if (a.kind === "epic" && b.kind === "epic") {
        const epic = (id: string | undefined) => Number((id ?? "").replace(/\D+/g, "")) || 0;
        const byNumber = epic(a.id) - epic(b.id);
        if (byNumber !== 0) return byNumber;
      }
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
  const trace = traceInputs(inputs, documents);
  const defined = [...tracedRequirements(documents).entries()].sort(([a], [b]) =>
    compareRequirements(a, b),
  );
  const traced = defined.map(([id, definition]) => traceRequirement(id, definition, trace));
  const active = traced.filter((entry) => !entry.retired);
  const references = inputs.references;
  const open = openDeviations(inputs.state);
  const requirementsCut = traced.length > DOCS_REQUIREMENTS_MAX;
  const documentsCut = listed.length > DOCS_DOCUMENTS_MAX;
  const coverage = coverageOf(
    documents,
    active.map((entry) => entry.id),
  );
  return {
    documents: listed.slice(0, DOCS_DOCUMENTS_MAX),
    truncated: documentsCut || requirementsCut || inputs.incomplete === true,
    requirements: traced.slice(0, DOCS_REQUIREMENTS_MAX).map((entry) => ({
      id: entry.id,
      text: cut(oneLine(entry.text), DOCS_REQUIREMENT_MAX_CHARS),
      path: entry.path,
      retired: entry.retired,
      status: entry.status,
      stories: entry.stories.map((story) => story.id).slice(0, DOCS_TRACE_MAX),
      tests: references === null ? null : new Set(entry.tests.map((test) => test.path)).size,
      pull_requests: entry.pull_requests.length,
      deviations: entry.deviations.filter((deviation) => deviation.status === "open").length,
    })),
    counts: countsOf(active.map((entry) => entry.status)),
    tests: inputs.testsState,
    deviations: open.slice(0, DOCS_DEVIATIONS_MAX).map((deviation) => ({
      id: deviation.id,
      story: deviation.story,
      requirements: [...deviation.requirements].slice(0, 20),
      summary: cut(oneLine(deviation.summary), DOCS_TITLE_MAX_CHARS),
      reported_by: deviation.reported_by,
      reported_at: deviation.reported_at,
    })),
    epics: breakdownOf(documents, inputs.state),
    ...(coverage === undefined ? {} : { coverage }),
  };
}

/** Everything linked to one requirement, or undefined when no `prd` or `spec` document defines it. */
export function requirementTrace(
  inputs: DocumentsInputs,
  id: string,
): Omit<DocsTraceData, "op"> | undefined {
  const documents = inputs.files.map((file) => parseDocumentFile(file.path, file.text));
  const definition = tracedRequirements(documents).get(id);
  if (definition === undefined) return undefined;
  const entry = traceRequirement(id, definition, traceInputs(inputs, documents));
  return {
    requirement: {
      id: entry.id,
      text: cut(oneLine(entry.text), DOCS_REQUIREMENT_MAX_CHARS),
      path: entry.path,
      line: Math.max(1, entry.line),
      retired: entry.retired,
      status: entry.status,
      stories: entry.stories.slice(0, DOCS_TRACE_MAX).map((story) => ({
        id: story.id,
        ...(story.title === null || story.title === ""
          ? {}
          : { title: cut(oneLine(story.title), DOCS_TITLE_MAX_CHARS) }),
        status: story.status,
      })),
      tests: entry.tests.slice(0, DOCS_TRACE_MAX).map((test) => ({
        path: test.path,
        line: test.line,
      })),
      pull_requests: entry.pull_requests.slice(0, DOCS_TRACE_MAX).map((pull) => ({
        story: pull.story,
        number: pull.number,
      })),
      deviations: entry.deviations.slice(0, DOCS_TRACE_MAX).map((deviation) => ({
        id: deviation.id,
        story: deviation.story,
        requirements: [...deviation.requirements].slice(0, 20),
        summary: cut(oneLine(deviation.summary), DOCS_TITLE_MAX_CHARS),
        reported_by: deviation.reported_by,
        reported_at: deviation.reported_at,
        status: deviation.status,
        ...(deviation.detail === null ? {} : { detail: cut(deviation.detail, 2000) }),
        ...(deviation.resolved === null
          ? {}
          : {
              resolved: {
                reason: cut(deviation.resolved.reason, 2000),
                by: deviation.resolved.by,
                at: deviation.resolved.at,
              },
            }),
      })),
    },
    tests_state: inputs.testsState,
  };
}
