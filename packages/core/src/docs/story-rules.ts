import {
  EPIC_DOCUMENT_ID_PATTERN,
  ErrorCode,
  epicIdOf,
  STORY_DOCUMENT_ID_PATTERN,
  STORY_SECTIONS,
  type StorySection,
} from "@agentplugged/protocol";
import { holdsRequirements } from "../spec/spec-kinds.js";
import type { DocsProblem, DocsWarning } from "./docs-base.js";
import {
  type Definition,
  type ParsedDocument,
  placeholdersOf,
  sectionText,
} from "./parse-document.js";

/**
 * The rules of a breakdown, as pure functions: the links of the stories and epics
 * (7), the coverage of the PRD's requirements (8), the dependency graph (9) and the frozen intents
 * (10).
 */

/**
 * A story file an approved `document` checkpoint lists, read from its Git blob (rule 10):
 * `read` (a story with an intent section), `no_intent` (Git holds the blob, but it holds no story
 * with an intent section) or `missing` (Git does not hold the blob: a shallow or partial clone, a
 * branch not fetched).
 */
export interface ApprovedStory {
  /** The approved `document` checkpoint (`G-…`). */
  readonly checkpoint: string;
  /** The path the checkpoint lists, normalised (`/`, from `.agentplugged/`). */
  readonly path: string;
  readonly blob: string;
  readonly state: "read" | "no_intent" | "missing";
  /** The story id the blob holds, when it holds a story. */
  readonly story: string | undefined;
  /** The approved intent (`intentOf`), when `read`. */
  readonly intent: string | undefined;
}

/** What rule 10 found: the problems, the warnings, and how many stories were compared. */
export interface IntentCheck {
  readonly problems: DocsProblem[];
  readonly warnings: DocsWarning[];
  readonly compared: number;
}

/** The heading of each section, as the templates write it (French titles are accepted too). */
const SECTION_HEADINGS: Readonly<Record<StorySection, string>> = {
  context: "## Context",
  intent: "## Intent",
  acceptance_criteria: "## Acceptance criteria",
  out_of_scope: "## Out of scope",
};

/** The prefixes of the requirements a breakdown must cover. */
const COVERED_PREFIXES = ["EF-", "ENF-"];

function problem(
  code: ErrorCode,
  messageKey: string,
  path: string,
  line: number,
  details: Record<string, unknown> = {},
): DocsProblem {
  return { code, message_key: messageKey, details: { path, line, ...details } };
}

/** A story's order: its epic, then its number, as numbers. */
export function storyOrder(id: string): readonly [number, number] {
  const [epic = "0", story = "0"] = id.split("-");
  return [Number(epic), Number(story)];
}

/** Negative when `a` comes before `b` in the breakdown. */
export function compareStories(a: string, b: string): number {
  const [ea, sa] = storyOrder(a);
  const [eb, sb] = storyOrder(b);
  return ea - eb || sa - sb;
}

/** The stories of the working copy: documents of kind `story` with a story id, first one wins. */
export function storiesOf(documents: readonly ParsedDocument[]): Map<string, ParsedDocument> {
  const stories = new Map<string, ParsedDocument>();
  for (const document of documents) {
    const id = document.id;
    if (document.kind?.value !== "story" || id === undefined) continue;
    if (!STORY_DOCUMENT_ID_PATTERN.test(id) || stories.has(id)) continue;
    stories.set(id, document);
  }
  return stories;
}

/** The epics of the working copy: documents of kind `epic` with an epic id, first one wins. */
function epicsOf(documents: readonly ParsedDocument[]): Map<string, ParsedDocument> {
  const epics = new Map<string, ParsedDocument>();
  for (const document of documents) {
    const id = document.id;
    if (document.kind?.value !== "epic" || id === undefined) continue;
    if (!EPIC_DOCUMENT_ID_PATTERN.test(id) || epics.has(id)) continue;
    epics.set(id, document);
  }
  return epics;
}

/** The sections of a document named `section` (any accepted title). */
function sectionsNamed(document: ParsedDocument, section: StorySection) {
  const titles: readonly string[] = STORY_SECTIONS[section];
  return document.sections.filter((candidate) => titles.includes(candidate.title));
}

/**
 * A story's intent as compared: the text (`sectionText`) of its intent sections, joined by a
 * blank line; empty without one.
 */
export function intentOf(document: ParsedDocument): string {
  return sectionsNamed(document, "intent")
    .map((section) => sectionText(section.lines))
    .join("\n\n");
}

/** True when the document has at least one intent section. */
export function hasIntent(document: ParsedDocument): boolean {
  return sectionsNamed(document, "intent").length > 0;
}

/** A warning of `docs check`: shown, never failing the check. */
export function warning(reason: string, details: Record<string, unknown>): DocsWarning {
  return { reason, message_key: `docs.check.warning.${reason}`, details };
}

function isActive(current: ReadonlyMap<string, readonly Definition[]>, id: string): boolean {
  return (current.get(id) ?? []).some((definition) => !definition.retired);
}

/** Rule 7: the sections and the links of the stories and epics. */
function linkProblems(
  documents: readonly ParsedDocument[],
  stories: ReadonlyMap<string, ParsedDocument>,
  current: ReadonlyMap<string, readonly Definition[]>,
  owners: ReadonlySet<string>,
): DocsProblem[] {
  const problems: DocsProblem[] = [];
  const epics = epicsOf(documents);
  const dangling = (path: string, line: number, key: string, link: string, field: string) =>
    problems.push(
      problem(ErrorCode.DOC_LINK_DANGLING, `error.doc_link_dangling.${key}`, path, line, {
        link,
        field,
      }),
    );
  for (const document of documents) {
    const { path } = document;
    for (const value of document.outOfScope) {
      if (!isActive(current, value.value)) {
        dangling(path, value.line, "requirement", value.value, "out_of_scope");
      }
    }
    const kind = document.kind?.value;
    if (kind === "story" || kind === "epic") {
      // Template markers left behind: in the title, then in the body.
      const title = document.title;
      const markers = [
        ...(title === undefined
          ? []
          : placeholdersOf(title.value).map((marker) => ({ line: title.line, marker }))),
        ...document.placeholders,
      ];
      for (const { line, marker } of markers) {
        problems.push(
          problem(ErrorCode.DOC_PLACEHOLDER_LEFT, "error.doc_placeholder_left", path, line, {
            marker,
          }),
        );
      }
    }
    const story = document.story;
    if (story === undefined) continue;
    const reviewer = story.reviewer;
    if (reviewer !== undefined && reviewer.value !== "creator" && !owners.has(reviewer.value)) {
      problems.push(
        problem(ErrorCode.DOC_HEADER_INVALID, "error.doc_header_invalid", path, reviewer.line, {
          field: "reviewer",
          reason: `names no agent: ${reviewer.value}`,
          reason_key: "reason.doc_owner",
          owner: reviewer.value,
        }),
      );
    }
    // An epic that is not the one of the story's id is a header problem only: no second report.
    const ownEpic =
      document.id !== undefined && STORY_DOCUMENT_ID_PATTERN.test(document.id)
        ? epicIdOf(document.id)
        : undefined;
    const epic = story.epic;
    if (epic !== undefined && epic.value === ownEpic && !epics.has(epic.value)) {
      dangling(path, epic.line, "epic", epic.value, "epic");
    }
    for (const value of story.requirements) {
      if (!isActive(current, value.value)) {
        dangling(path, value.line, "requirement", value.value, "requirements");
      }
    }
    for (const value of story.dependsOn) {
      if (!stories.has(value.value)) dangling(path, value.line, "story", value.value, "depends_on");
    }
    for (const section of Object.keys(STORY_SECTIONS) as StorySection[]) {
      const found = sectionsNamed(document, section);
      const [first, second] = found;
      const reason =
        first === undefined
          ? "missing"
          : second !== undefined
            ? "duplicate"
            : sectionText(first.lines) === ""
              ? "empty"
              : undefined;
      if (reason === undefined) continue;
      const line = (second ?? first)?.line ?? 1;
      problems.push(
        problem(
          ErrorCode.STORY_SECTION_INVALID,
          `error.story_section_invalid.${reason}`,
          path,
          line,
          { section, heading: SECTION_HEADINGS[section], reason },
        ),
      );
    }
  }
  return problems;
}

/**
 * Rule 8, once at least one story exists: every active `EF-n` and `ENF-n` defined in a `prd`
 * document is in a story's `requirements` or an epic's `out_of_scope`.
 */
function coverageProblems(
  documents: readonly ParsedDocument[],
  stories: ReadonlyMap<string, ParsedDocument>,
): DocsProblem[] {
  if (stories.size === 0) return [];
  // Only the stories and epics kept (a valid id, the first of each id) cover a requirement.
  const covered = new Set<string>();
  for (const story of stories.values()) {
    for (const value of story.story?.requirements ?? []) covered.add(value.value);
  }
  for (const epic of epicsOf(documents).values()) {
    for (const value of epic.outOfScope) covered.add(value.value);
  }
  const problems: DocsProblem[] = [];
  const reported = new Set<string>();
  for (const document of documents) {
    if (!holdsRequirements(document.kind?.value)) continue;
    for (const definition of document.definitions) {
      const { id } = definition;
      if (definition.retired || covered.has(id) || reported.has(id)) continue;
      if (!COVERED_PREFIXES.some((prefix) => id.startsWith(prefix))) continue;
      reported.add(id);
      problems.push(
        problem(
          ErrorCode.REQ_NOT_COVERED,
          "error.req_not_covered",
          document.path,
          definition.line,
          {
            id,
          },
        ),
      );
    }
  }
  return problems;
}

/** The strongly connected components of the graph (Tarjan), each with more than one node. */
function cycles(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const found: string[][] = [];
  let next = 0;
  const visit = (node: string): void => {
    index.set(node, next);
    low.set(node, next);
    next += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of graph.get(node) ?? []) {
      if (!index.has(target)) {
        visit(target);
        low.set(node, Math.min(low.get(node) ?? 0, low.get(target) ?? 0));
      } else if (onStack.has(target)) {
        low.set(node, Math.min(low.get(node) ?? 0, index.get(target) ?? 0));
      }
    }
    if (low.get(node) !== index.get(node)) return;
    const component: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop();
      if (member === undefined) break;
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    const selfLoop = (graph.get(node) ?? []).includes(node);
    if (component.length > 1 || selfLoop) found.push(component.sort(compareStories));
  };
  for (const node of [...graph.keys()].sort(compareStories)) if (!index.has(node)) visit(node);
  return found;
}

/**
 * Rule 9: no story depends on a later one (same or higher order, itself excepted: that is a
 * cycle), and no stories depend on each other in a loop.
 */
function graphProblems(stories: ReadonlyMap<string, ParsedDocument>): DocsProblem[] {
  const problems: DocsProblem[] = [];
  const graph = new Map<string, string[]>();
  for (const [id, document] of stories) {
    const targets: string[] = [];
    for (const dependency of document.story?.dependsOn ?? []) {
      const target = dependency.value;
      if (!stories.has(target)) continue;
      targets.push(target);
      if (target !== id && compareStories(target, id) >= 0) {
        problems.push(
          problem(
            ErrorCode.STORY_DEPENDENCY_FORWARD,
            "error.story_dependency_forward",
            document.path,
            dependency.line,
            { story: id, dependency: target },
          ),
        );
      }
    }
    graph.set(id, targets);
  }
  for (const cycle of cycles(graph)) {
    const first = stories.get(cycle[0] ?? "");
    if (first === undefined) continue;
    const line = first.story?.dependsOn[0]?.line ?? first.idLine;
    problems.push(
      problem(ErrorCode.STORY_DEPENDENCY_CYCLE, "error.story_dependency_cycle", first.path, line, {
        cycle,
      }),
    );
  }
  return problems;
}

/** The story id a file name starts with (`1-2-sign-in.md` → `1-2`), the method's naming. */
export function idOfName(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const id = /^([1-9]\d{0,5}-[1-9]\d{0,5})(?![0-9])/.exec(name)?.[1];
  return id;
}

/**
 * The approvals of each story, in the order of the answers. An approval whose blob gives no story
 * id (missing, or not a story) takes the id another approval of the same path gives, else the id
 * of the story at that path in the working copy; without any, it stays apart (by path).
 */
function approvalsByStory(
  stories: ReadonlyMap<string, ParsedDocument>,
  approvals: readonly ApprovedStory[],
): { byStory: Map<string, ApprovedStory[]>; apart: ApprovedStory[] } {
  const idOfPath = new Map<string, string>();
  for (const story of stories.values()) {
    if (story.id !== undefined) idOfPath.set(story.path, story.id);
  }
  // An approval's own blob names its story better than the working copy does.
  for (const approval of approvals) {
    if (approval.story !== undefined) idOfPath.set(approval.path, approval.story);
  }
  const byStory = new Map<string, ApprovedStory[]>();
  const apart: ApprovedStory[] = [];
  for (const approval of approvals) {
    const id = approval.story ?? idOfPath.get(approval.path) ?? idOfName(approval.path);
    if (id === undefined) {
      apart.push(approval);
      continue;
    }
    const list = byStory.get(id);
    if (list) list.push(approval);
    else byStory.set(id, [approval]);
  }
  return { byStory, apart };
}

/**
 * Rule 10: the intent of each story the creator approved in a `document` checkpoint is unchanged.
 * `approvals` come in the order of the answers: the last approval of a story is the reference.
 * - Its blob is read: the intents are compared (`changed`). A story gone from the working copy is
 *   `removed` when this branch's history held an approved blob of it (`onBranch`); otherwise this
 *   branch never had it, and a warning says so (`not_on_branch`).
 * - Its blob holds no story with an intent section: `no_intent`, never an empty intent frozen.
 * - Git does not hold its blob: a warning (`blob_missing`); the last earlier approval Git holds is
 *   compared instead, and a difference is only a warning (the newer approval may allow it).
 * `onBranch` undefined: the history could not be read; a missing story is then a warning.
 */
export function checkIntents(
  stories: ReadonlyMap<string, ParsedDocument>,
  approvals: readonly ApprovedStory[],
  onBranch: ReadonlySet<string> | undefined,
): IntentCheck {
  const problems: DocsProblem[] = [];
  const warnings: DocsWarning[] = [];
  let compared = 0;
  const details = (story: string | null, entry: ApprovedStory, reason: string) => ({
    story,
    checkpoint: entry.checkpoint,
    reason,
    approved_path: entry.path,
    blob: entry.blob,
  });
  const report = (
    path: string,
    line: number,
    story: string | null,
    entry: ApprovedStory,
    reason: string,
  ) =>
    problems.push(
      problem(
        ErrorCode.STORY_INTENT_CHANGED,
        `error.story_intent_changed.${reason}`,
        path,
        line,
        details(story, entry, reason),
      ),
    );
  const { byStory, apart } = approvalsByStory(stories, approvals);
  for (const entry of apart) {
    if (entry.state === "missing") {
      warnings.push(
        warning("blob_missing", {
          story: null,
          checkpoint: entry.checkpoint,
          path: entry.path,
          blob: entry.blob,
        }),
      );
    } else {
      report(entry.path, 1, null, entry, "no_intent");
    }
  }
  for (const [id, list] of byStory) {
    const latest = list[list.length - 1];
    if (latest === undefined) continue;
    const document = stories.get(id);
    const intentLine = (doc: ParsedDocument) => sectionsNamed(doc, "intent")[0]?.line ?? doc.idLine;
    if (latest.state === "no_intent") {
      report(document?.path ?? latest.path, 1, id, latest, "no_intent");
      continue;
    }
    let reference = latest;
    if (latest.state === "missing") {
      warnings.push(
        warning("blob_missing", {
          story: id,
          checkpoint: latest.checkpoint,
          path: latest.path,
          blob: latest.blob,
        }),
      );
      const older = [...list].reverse().find((entry) => entry.state === "read");
      if (older === undefined) continue;
      reference = older;
    }
    if (document === undefined) {
      const held = list.some(
        (entry) => entry.state === "read" && onBranch?.has(entry.blob) === true,
      );
      if (held) report(reference.path, 1, id, reference, "removed");
      else {
        warnings.push(
          warning(onBranch === undefined ? "history_unreadable" : "not_on_branch", {
            story: id,
            checkpoint: reference.checkpoint,
            path: reference.path,
          }),
        );
      }
      continue;
    }
    compared += 1;
    if (intentOf(document) === reference.intent) continue;
    if (reference === latest) report(document.path, intentLine(document), id, reference, "changed");
    else {
      warnings.push(
        warning("intent_unverified", {
          story: id,
          checkpoint: latest.checkpoint,
          older: reference.checkpoint,
          path: document.path,
        }),
      );
    }
  }
  return { problems, warnings, compared };
}

/** Rules 7 to 10 on the documents of the working copy. */
export function breakdownProblems(
  documents: readonly ParsedDocument[],
  current: ReadonlyMap<string, readonly Definition[]>,
  owners: ReadonlySet<string>,
  approvals: readonly ApprovedStory[],
  onBranch: ReadonlySet<string> | undefined,
): IntentCheck {
  const stories = storiesOf(documents);
  const intents = checkIntents(stories, approvals, onBranch);
  return {
    problems: [
      ...linkProblems(documents, stories, current, owners),
      ...coverageProblems(documents, stories),
      ...graphProblems(stories),
      ...intents.problems,
    ],
    warnings: intents.warnings,
    compared: intents.compared,
  };
}
