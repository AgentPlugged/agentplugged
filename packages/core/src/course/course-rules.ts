import { sha256Hex } from "@agentplugged/crypto";
import {
  COURSE_KINDS,
  type CourseDecision,
  type CourseEntry,
  type CourseGesture,
  type CourseInput,
  type CourseStart,
  type CourseStoryStatus,
  MAX_COURSE_PROOFS,
  MAX_COURSE_STACK,
  MAX_COURSE_STARTS,
  parseCourseStart,
  type RequirementEntry,
} from "@agentplugged/protocol";
import { documentOwner } from "../agents/agent-aliases.js";
import { citedCriteria } from "../criteria/criterion-rules.js";
import { hypothesesOf, passageFound, refsOf } from "../critique/critique-rules.js";
import type { DocumentFile } from "../docs/docs-base.js";
import { comparablePath, isKnowledgePage, knowledgePages } from "../docs/knowledge-freshness.js";
import { type Definition, type ParsedDocument, parseDocumentFile } from "../docs/parse-document.js";
import { storiesOf } from "../docs/story-rules.js";
import type { StoryState } from "../projection/agent-reducers.js";
import {
  buildRegistry,
  registerOf,
  requirementProofState,
} from "../requirements/requirement-rules.js";
import { holdsDecisions, holdsRequirements } from "../spec/spec-kinds.js";
import { listedCriteria } from "../stories/pull-request-body.js";
import { storyDeveloper } from "../trace/deviation-rules.js";
import {
  type CandidateLine,
  type TestReference,
  testReferences,
} from "../trace/test-references.js";
import { tracedStoryStatus } from "../trace/trace-rules.js";

/**
 * The correction of course, as pure rules. The impact of a change is never guessed:
 * it is read from the documents (the definitions and the places that cite an identifier), the
 * stories (the `requirements` they cite, their criteria), the tests (the citations of a
 * requirement, the criteria `AC-<story>-<n>`), the register of proofs, the open hypotheses and the
 * pages of the base. The result is one stack, sorted from the most structuring, and the engine's
 * own check that everything is coherent again. No agent decides any of it.
 */

/** One element of the stack as the state keeps it: the entry, its number and what the creator decided. */
export interface CourseItem extends CourseEntry {
  readonly n: number;
  gesture: CourseGesture | null;
  reason: string | null;
  decided_at: string | null;
}

/** `state.courses[id]`. */
export interface CourseRecord {
  readonly id: string;
  readonly at: string;
  readonly by: string;
  readonly summary: string;
  readonly quote: string;
  readonly starts: readonly string[];
  readonly stack: CourseItem[];
  readonly more: number;
  readonly proofs: readonly string[];
  status: "open" | "closed";
  closed_at: string | null;
}

function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

// ---------------------------------------------------------------------------------------------
// The state
// ---------------------------------------------------------------------------------------------

/** `state.courses`, by id. */
export function coursesOf(state: Readonly<Record<string, unknown>>): Record<string, CourseRecord> {
  return (state.courses as Record<string, CourseRecord> | undefined) ?? {};
}

/** The course `id`, or undefined. */
export function courseById(
  state: Readonly<Record<string, unknown>>,
  id: string | undefined,
): CourseRecord | undefined {
  return id === undefined ? undefined : own(coursesOf(state), id);
}

/** The course that is open (one at a time), or undefined. */
export function openCourse(state: Readonly<Record<string, unknown>>): CourseRecord | undefined {
  return Object.values(coursesOf(state)).find((course) => course.status === "open");
}

/** The elements of a course still waiting for the creator's gesture. */
export function undecided(course: CourseRecord): CourseItem[] {
  return course.stack.filter((item) => item.gesture === null);
}

/**
 * How many decisions of the open course a story still waits for (its own element and its
 * criteria). While there is one, the story does not merge (the merge gate).
 */
export function courseHolds(state: Readonly<Record<string, unknown>>, story: string): number {
  const course = openCourse(state);
  if (course === undefined) return 0;
  return undecided(course).filter(
    (item) =>
      (item.kind === "story" && item.ref === story) ||
      (item.kind === "criterion" && item.ref.startsWith(`${story}#`)),
  ).length;
}

// ---------------------------------------------------------------------------------------------
// The stack the creator reads
// ---------------------------------------------------------------------------------------------

const LINE_MAX = 140;
const cut = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** One line of the stack: `3. story · 4-3 — in progress, cites EF-3`. */
export function stackLine(item: Pick<CourseItem, "n" | "kind" | "ref" | "why">): string {
  return cut(`${item.n}. ${item.kind} · ${item.ref} — ${item.why}`, LINE_MAX);
}

/** The lines of what is left to decide, in the stack's order, at most `max`. */
export function leftLines(course: CourseRecord, max: number): { lines: string[]; more: number } {
  const left = undecided(course);
  return { lines: left.slice(0, max).map(stackLine), more: Math.max(0, left.length - max) };
}

/** What `get_state` and `next` say of an open course; bounded. */
export interface CourseView {
  readonly id: string;
  readonly summary: string;
  readonly left: number;
  readonly total: number;
  /** The first elements left to decide, one line each. */
  readonly stack: readonly string[];
  readonly more?: number;
  /** The stories under way the change touches whose decision is not taken: they do not merge. */
  readonly blocked?: readonly string[];
}

const SHOWN = 5;

/** The open course as `get_state` shows it, or undefined without one. */
export function courseView(state: Readonly<Record<string, unknown>>): CourseView | undefined {
  const course = openCourse(state);
  if (course === undefined) return undefined;
  const left = undecided(course);
  const shown = leftLines(course, SHOWN);
  const blocked = [
    ...new Set(
      left
        .filter((item) => item.kind === "story" && item.status === "in_progress")
        .map((item) => `${item.ref}${item.developer === undefined ? "" : ` (${item.developer})`}`),
    ),
  ];
  return {
    id: course.id,
    summary: cut(course.summary, 120),
    left: left.length,
    total: course.stack.length,
    stack: shown.lines,
    ...(shown.more > 0 ? { more: shown.more } : {}),
    ...(blocked.length > 0 ? { blocked: blocked.slice(0, SHOWN) } : {}),
  };
}

/** What `next` adds while a course is open: the creator decides the rest, the stories wait. */
export interface CourseNote {
  readonly id: string;
  readonly left: number;
  readonly blocked?: readonly string[];
}

/** The note `next` carries for an open course, or undefined: no stack, `plan.course` shows it. */
export function courseNote(state: Readonly<Record<string, unknown>>): CourseNote | undefined {
  const view = courseView(state);
  if (view === undefined) return undefined;
  return {
    id: view.id,
    left: view.left,
    ...(view.blocked === undefined ? {} : { blocked: view.blocked }),
  };
}

// ---------------------------------------------------------------------------------------------
// The impact, computed
// ---------------------------------------------------------------------------------------------

/** What the impact reads: the documents of the working copy, the state, the tests' lines. */
export interface ImpactInputs {
  readonly files: readonly DocumentFile[];
  readonly state: Readonly<Record<string, unknown>>;
  /** The lines the tests' port read, or null when the tests could not be read. */
  readonly tests: {
    readonly lines: readonly CandidateLine[];
    readonly files: readonly string[];
  } | null;
}

/** The result of the computation: the stack, what it could not hold, the stale proofs. */
export interface Impact {
  readonly stack: CourseEntry[];
  readonly more: number;
  readonly proofs: string[];
}

/** The order of the stories in the stack: under way first, they are the ones that block. */
const STORY_RANK: Readonly<Record<CourseStoryStatus, number>> = {
  in_progress: 0,
  todo: 1,
  done: 2,
};

function rankOf(entry: CourseEntry): number {
  return COURSE_KINDS.indexOf(entry.kind) * 10 + STORY_RANK[entry.status ?? "todo"];
}

/** Natural order of two refs: identifiers by prefix then number, stories by epic then story. */
function compareRefs(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true });
}

/** A mark of a text, to tell later whether it changed. */
export function signatureOf(text: string): string {
  return sha256Hex(text.normalize("NFC").replace(/\s+/g, " ").trim()).slice(0, 12);
}

/** The story's status when the course opens. */
export function courseStoryStatus(
  state: Readonly<Record<string, unknown>>,
  story: string,
): CourseStoryStatus {
  const status = tracedStoryStatus(state, story);
  if (status === "done") return "done";
  const stories = state.stories as Record<string, StoryState> | undefined;
  const started = own(stories, story)?.started !== undefined;
  return started || status !== "todo" ? "in_progress" : "todo";
}

/** The definition of an identifier: the first active one, else the first retired one. */
function definitionOf(
  documents: readonly ParsedDocument[],
  id: string,
): { definition: Definition; document: ParsedDocument } | undefined {
  let found: { definition: Definition; document: ParsedDocument } | undefined;
  for (const document of documents) {
    if (document.kind?.value === "story") continue;
    if (!holdsRequirements(document.kind?.value) && !holdsDecisions(document.kind?.value)) continue;
    for (const definition of document.definitions) {
      if (definition.id !== id) continue;
      if (found === undefined || (found.definition.retired && !definition.retired)) {
        found = { definition, document };
      }
    }
  }
  return found;
}

function ownerOf(document: ParsedDocument | undefined): string | undefined {
  const owner = document?.owner?.value;
  return owner === undefined ? undefined : documentOwner(owner);
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The lines of a text that name the identifier `id`, numbered from 1 (code fences included). */
function mentions(text: string, id: string): number[] {
  const pattern = new RegExp(`(?<![\\w-])${id}(?!\\d)`, "i");
  const lines: number[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (pattern.test(line)) lines.push(index + 1);
  });
  return lines;
}

function lineList(lines: readonly number[]): string {
  const shown = lines.slice(0, 3).join(", ");
  return lines.length > 3 ? `${shown}…` : shown;
}

function plural(n: number, word: string): string {
  if (n === 1) return `1 ${word}`;
  const many = word === "story" ? "stories" : word === "criterion" ? "criteria" : `${word}s`;
  return `${n} ${many}`;
}

/** The starts that name nothing the documents hold, as the creator typed them. */
export interface UnknownStarts {
  readonly unknown: readonly string[];
}

/**
 * The impact of a change, from the elements it starts at. Undefined elements are returned as
 * `unknown` (nothing is guessed). The stack is sorted from the most structuring (decisions, then
 * requirements, passages, documents that cite them, stories under way, to do, done, criteria,
 * hypotheses, pages), and cut at `MAX_COURSE_STACK`; the rest is counted.
 */
export function computeImpact(
  starts: readonly string[],
  inputs: ImpactInputs,
): Impact | UnknownStarts {
  const documents = inputs.files.map((file) => parseDocumentFile(file.path, file.text));
  const stories = storiesOf(documents);
  const textOf = new Map(inputs.files.map((file) => [file.path, file.text]));
  const references: readonly TestReference[] =
    inputs.tests === null ? [] : testReferences(inputs.tests.lines, inputs.tests.files);
  const entries = new Map<string, CourseEntry>();
  const add = (entry: CourseEntry) => {
    const key = `${entry.kind}|${entry.ref}`;
    if (!entries.has(key)) entries.set(key, entry);
  };
  const unknown: string[] = [];
  const ids: string[] = [];
  const touchedDocuments = new Set<string>();
  const touchedStories = new Set<string>();

  /** The test files that cite criterion `n` of a story. */
  const testFiles = (story: string, n: number): number => {
    if (inputs.tests === null) return 0;
    const places = citedCriteria(story, inputs.tests.lines, inputs.tests.files).get(n) ?? [];
    return new Set(places.map((place) => place.split(":")[0])).size;
  };

  /** A story's criteria, and the test files that cite them (`AC-<story>-<n>`) or the given files. */
  const storyFacts = (story: string, extra: ReadonlySet<string> = new Set()): string => {
    const document = stories.get(story) as ParsedDocument;
    const cited = new Set(extra);
    if (inputs.tests !== null) {
      for (const places of citedCriteria(story, inputs.tests.lines, inputs.tests.files).values()) {
        for (const place of places) cited.add(place.split(":")[0] ?? place);
      }
    }
    return `${plural(listedCriteria(document).length, "criterion")}, ${plural(cited.size, "test file")}`;
  };

  const storyEntry = (story: string, why: string): void => {
    const document = stories.get(story);
    if (document === undefined) return;
    touchedStories.add(story);
    const status = courseStoryStatus(inputs.state, story);
    const developer = status === "in_progress" ? storyDeveloper(inputs.state, story) : undefined;
    const owner = ownerOf(document);
    add({
      kind: "story",
      ref: story,
      why: cut(`${status === "todo" ? "to do" : status.replace("_", " ")} · ${why}`, 200),
      status,
      ...(developer === undefined ? {} : { developer }),
      ...(owner === undefined ? {} : { owner }),
    });
  };

  for (const text of starts.slice(0, MAX_COURSE_STARTS)) {
    const start: CourseStart | undefined = parseCourseStart(text);
    if (start === undefined) {
      unknown.push(text);
      continue;
    }
    if (start.kind === "id") {
      const found = definitionOf(documents, start.id);
      if (found === undefined) {
        unknown.push(text);
        continue;
      }
      if (!ids.includes(start.id)) ids.push(start.id);
      touchedDocuments.add(comparablePath(found.document.path));
      const owner = ownerOf(found.document);
      add({
        kind: start.id.startsWith("AD-") ? "decision" : "requirement",
        ref: start.id,
        why: cut(
          `${fileName(found.document.path)}:${found.definition.line}, the change starts here`,
          200,
        ),
        sig: signatureOf(found.definition.text),
        ...(owner === undefined ? {} : { owner }),
      });
    } else if (start.kind === "story") {
      if (!stories.has(start.story)) {
        unknown.push(text);
        continue;
      }
      storyEntry(start.story, `the change starts here, ${storyFacts(start.story)}`);
    } else if (start.kind === "criterion") {
      const document = stories.get(start.story);
      if (document === undefined || start.n > listedCriteria(document).length) {
        unknown.push(text);
        continue;
      }
      touchedStories.add(start.story);
      const owner = ownerOf(document);
      add({
        kind: "criterion",
        ref: `${start.story}#${start.n}`,
        why: cut(
          `criterion ${start.n} of story ${start.story}, the change starts here, ${plural(testFiles(start.story, start.n), "test file")}`,
          200,
        ),
        status: courseStoryStatus(inputs.state, start.story),
        ...(owner === undefined ? {} : { owner }),
      });
    } else {
      const file = inputs.files.find(
        (candidate) => comparablePath(candidate.path) === `.agentplugged/docs/${start.document}.md`,
      );
      if (file === undefined || !passageFound(file.text, start.passage)) {
        unknown.push(text);
        continue;
      }
      touchedDocuments.add(comparablePath(file.path));
      const owner = ownerOf(documents.find((document) => document.path === file.path));
      add({
        kind: "passage",
        ref: cut(`${start.document}#${start.passage}`, 160),
        why: `${fileName(file.path)}, the change starts here`,
        ...(owner === undefined ? {} : { owner }),
      });
      // The identifiers a passage names are touched too: the trace goes on from them.
      for (const id of refsOf(start.passage)) {
        if (ids.includes(id)) continue;
        const found = definitionOf(documents, id);
        if (found === undefined) continue;
        ids.push(id);
        add({
          kind: id.startsWith("AD-") ? "decision" : "requirement",
          ref: id,
          why: `named by the passage, ${fileName(found.document.path)}:${found.definition.line}`,
          sig: signatureOf(found.definition.text),
          ...(ownerOf(found.document) === undefined ? {} : { owner: ownerOf(found.document) }),
        });
        touchedDocuments.add(comparablePath(found.document.path));
      }
    }
  }
  if (unknown.length > 0) return { unknown };

  const register = registerOf(inputs.state);
  const proofs: string[] = [];
  for (const id of ids) {
    const defining = definitionOf(documents, id);
    // The stories that cite it in their header or name it in their text.
    const cited: string[] = [];
    for (const [story, document] of stories) {
      const header = (document.story?.requirements ?? []).some((value) => value.value === id);
      const text = textOf.get(document.path);
      if (header || (text !== undefined && mentions(text, id).length > 0)) cited.push(story);
    }
    const tests = new Set(
      references
        .filter((reference) => reference.requirement === id)
        .map((reference) => reference.path),
    );
    const item = register === undefined ? undefined : own(register.items, id);
    const proven =
      item !== undefined &&
      item.proved !== null &&
      requirementProofState(inputs.state, item).state !== "unproven";
    if (proven && proofs.length < MAX_COURSE_PROOFS) proofs.push(id);
    const entry = entries.get(`${id.startsWith("AD-") ? "decision" : "requirement"}|${id}`);
    if (entry !== undefined) {
      entries.set(`${entry.kind}|${entry.ref}`, {
        ...entry,
        why: cut(
          `${entry.why}; ${plural(cited.length, "story")}, ${plural(tests.size, "test file")}${proven ? ", its proof goes stale" : ""}`,
          200,
        ),
      });
    }
    for (const story of cited) {
      storyEntry(story, `cites ${id}, ${storyFacts(story, tests)}`);
    }
    // The documents (other than the one that defines it) that name it.
    for (const file of inputs.files) {
      const document = documents.find(
        (candidate) => candidate.path === file.path,
      ) as ParsedDocument;
      if (document.kind?.value === "story" || isKnowledgePage(document)) continue;
      if (defining !== undefined && defining.document.path === file.path) continue;
      const lines = mentions(file.text, id);
      if (lines.length === 0) continue;
      touchedDocuments.add(comparablePath(file.path));
      const owner = ownerOf(document);
      add({
        kind: "document",
        ref: comparablePath(file.path),
        why: cut(`names ${id} (line ${lineList(lines)})`, 200),
        ...(owner === undefined ? {} : { owner }),
      });
    }
  }
  // A story the creator started from also touches the pages that took it in.
  for (const hypothesis of Object.values(hypothesesOf(inputs.state))) {
    const hit = hypothesis.refs.find((ref) => ids.includes(ref));
    if (hit === undefined) continue;
    add({
      kind: "hypothesis",
      ref: hypothesis.id,
      why: cut(`${hypothesis.claim} (names ${hit})`, 200),
      owner: hypothesis.by,
    });
  }
  // The pages of the base built on a touched document, naming an identifier, or that took in a
  // touched story. Their `code` says what they describe.
  const pages = knowledgePages(inputs.files);
  for (const page of pages) {
    const sources = page.tracked.some((source) =>
      touchedDocuments.has(comparablePath(source.path)),
    );
    const story = page.last_story !== undefined && touchedStories.has(page.last_story);
    const text = inputs.files.find((file) => comparablePath(file.path) === page.path)?.text ?? "";
    const named = ids.find((id) => mentions(text, id).length > 0);
    if (!sources && !story && named === undefined) continue;
    add({
      kind: "page",
      ref: page.path,
      why: cut(
        `${sources ? "built on a touched document" : story ? `took in story ${page.last_story}` : `names ${named}`}${page.code === undefined ? "" : `, describes ${page.code.slice(0, 2).join(", ")}`}`,
        200,
      ),
      owner: "zoe",
    });
  }

  const marked = [...entries.values()].map((entry): CourseEntry => {
    if (entry.sig !== undefined) return entry;
    const text = elementText(entry, documents, inputs.files);
    return text === undefined ? entry : { ...entry, sig: signatureOf(text) };
  });
  const sorted = marked.sort((a, b) => rankOf(a) - rankOf(b) || compareRefs(a.ref, b.ref));
  // The stories under way are never the ones cut: a story left out of the stack would merge.
  const held = sorted.filter((entry) => entry.kind === "story" && entry.status === "in_progress");
  const rest = sorted.filter((entry) => !held.includes(entry));
  const room = Math.max(0, MAX_COURSE_STACK - held.length);
  const kept = [...rest.slice(0, room), ...held.slice(0, MAX_COURSE_STACK)].sort(
    (a, b) => rankOf(a) - rankOf(b) || compareRefs(a.ref, b.ref),
  );
  return {
    stack: kept,
    more: Math.max(0, sorted.length - kept.length),
    proofs,
  };
}

/**
 * The text an element of the stack stands for, to tell later whether it changed: the file of a
 * story, a criterion, a document, a passage or a page (a requirement or a decision has its own
 * mark, its definition). Undefined for a hypothesis, which no file holds.
 */
function elementText(
  entry: Pick<CourseEntry, "kind" | "ref">,
  documents: readonly ParsedDocument[],
  files: readonly DocumentFile[],
): string | undefined {
  let path: string | undefined;
  if (entry.kind === "story" || entry.kind === "criterion") {
    path = storiesOf(documents).get(entry.ref.split("#")[0] ?? "")?.path;
  } else if (entry.kind === "passage") {
    const name = entry.ref.split("#")[0] ?? "";
    path = files.find(
      (file) => comparablePath(file.path) === `.agentplugged/docs/${name}.md`,
    )?.path;
  } else if (entry.kind === "document" || entry.kind === "page") {
    path = files.find((file) => comparablePath(file.path) === entry.ref)?.path;
  }
  return path === undefined ? undefined : files.find((file) => file.path === path)?.text;
}

// ---------------------------------------------------------------------------------------------
// The gestures
// ---------------------------------------------------------------------------------------------

/** What is wrong with the creator's gestures on a course, as short codes; empty when whole. */
export function validateDecisions(
  course: CourseRecord | undefined,
  input: Pick<CourseInput, "items" | "quote">,
): string[] {
  if (course === undefined) return ["course: unknown"];
  if (course.status !== "open") return ["course: closed"];
  const problems: string[] = [];
  if (input.quote === undefined) problems.push("quote: the creator's words");
  const seen = new Set<number>();
  for (const decision of input.items ?? []) {
    const item = course.stack[decision.n - 1];
    if (item === undefined) problems.push(`${decision.n}: not in the stack`);
    else if (item.gesture !== null) problems.push(`${decision.n}: already decided`);
    else if (seen.has(decision.n)) problems.push(`${decision.n}: twice`);
    else if (decision.gesture === "keep" && decision.reason === undefined) {
      problems.push(`${decision.n}: keep needs a reason`);
    } else if (
      decision.gesture === "retire" &&
      item.kind !== "requirement" &&
      item.kind !== "decision"
    ) {
      problems.push(`${decision.n}: only a requirement or a decision is retired`);
    }
    seen.add(decision.n);
  }
  if ((input.items ?? []).length === 0) problems.push("items: at least one gesture");
  return problems;
}

/** The agents that write the updates the creator asked for, with the elements to hand them. */
export function handoffs(
  course: CourseRecord,
  decisions: readonly CourseDecision[],
): { owner: string; refs: string[] }[] {
  const byOwner = new Map<string, string[]>();
  for (const decision of decisions) {
    if (decision.gesture === "keep") continue;
    const item = course.stack[decision.n - 1];
    if (item === undefined) continue;
    const owner = item.owner ?? "creator";
    const refs = byOwner.get(owner) ?? [];
    refs.push(`${decision.gesture === "retire" ? "retire " : ""}${item.ref}`);
    byOwner.set(owner, refs);
  }
  return [...byOwner.entries()].map(([owner, refs]) => ({ owner, refs: refs.slice(0, 12) }));
}

// ---------------------------------------------------------------------------------------------
// The check that everything is coherent again
// ---------------------------------------------------------------------------------------------

/** The most problems one answer lists. */
export const MAX_PROBLEMS = 12;

/** What the engine finds of a course: what is left to decide, and what is still incoherent. */
export interface CourseCheck {
  readonly left: number;
  readonly problems: readonly string[];
  readonly more: number;
}

/**
 * The engine's check: no story cites a requirement that is retired, every identifier decided
 * `retire` is marked retired (and not removed), and no proof stays valid for a requirement whose
 * text changed (the register is synchronized with the documents). Pure.
 */
export function checkCourse(
  course: CourseRecord,
  files: readonly DocumentFile[],
  state: Readonly<Record<string, unknown>>,
): CourseCheck {
  const documents = files.map((file) => parseDocumentFile(file.path, file.text));
  const problems: string[] = [];
  const registry: readonly RequirementEntry[] = buildRegistry(documents, files);
  const register = registerOf(state);
  // The identifiers the documents of the requirements and the decisions define, retired or not.
  const retired = new Set<string>();
  const active = new Set<string>();
  for (const document of documents) {
    if (document.kind?.value === "story") continue;
    if (!holdsRequirements(document.kind?.value) && !holdsDecisions(document.kind?.value)) continue;
    for (const definition of document.definitions) {
      (definition.retired ? retired : active).add(definition.id);
    }
  }
  for (const item of course.stack) {
    if (
      item.gesture === null ||
      (item.gesture === "keep" && item.kind !== "requirement" && item.kind !== "decision")
    ) {
      continue;
    }
    if (item.kind === "requirement" || item.kind === "decision") {
      const found = definitionOf(documents, item.ref);
      if (found === undefined) {
        problems.push(`${item.ref}: removed, mark it retired (it stays, never reused)`);
        continue;
      }
      if (item.gesture === "retire") {
        if (!found.definition.retired) problems.push(`${item.ref}: not marked retired yet`);
        else if (register !== undefined && own(register.items, item.ref) !== undefined) {
          problems.push(
            `${item.ref}: retired, the register of proofs is behind (measure.requirements)`,
          );
        }
      } else if (item.gesture === "update") {
        const changed = item.sig !== undefined && signatureOf(found.definition.text) !== item.sig;
        const held = register === undefined ? undefined : own(register.items, item.ref);
        const current = registry.find((entry) => entry.id === item.ref);
        if (item.sig !== undefined && !changed) {
          problems.push(
            `${item.ref}: marked update, its text is unchanged (keep it, or change it)`,
          );
        } else if (held !== undefined && current !== undefined && held.digest !== current.digest) {
          problems.push(
            `${item.ref}: changed, its proof still counts, the register is behind (measure.requirements)`,
          );
        }
      }
      continue;
    }
    // A story, a criterion, a document, a passage or a page marked update: its file must have changed.
    if (item.gesture === "update" && item.sig !== undefined) {
      const text = elementText(item, documents, files);
      if (text === undefined) problems.push(`${item.ref}: not found any more`);
      else if (signatureOf(text) === item.sig) {
        problems.push(`${item.ref}: marked update, nothing changed yet (keep it, or change it)`);
      }
    }
  }
  for (const [story, document] of storiesOf(documents)) {
    for (const value of document.story?.requirements ?? []) {
      if (retired.has(value.value) && !active.has(value.value)) {
        problems.push(`story ${story}: cites ${value.value}, which is retired`);
      } else if (!retired.has(value.value) && !active.has(value.value)) {
        problems.push(`story ${story}: cites ${value.value}, which no document defines`);
      }
    }
  }
  return {
    left: undecided(course).length,
    problems: problems.slice(0, MAX_PROBLEMS),
    more: Math.max(0, problems.length - MAX_PROBLEMS),
  };
}

/** True when the course may close: everything decided and coherent. */
export function courseIsCoherent(check: CourseCheck): boolean {
  return check.left === 0 && check.problems.length === 0 && check.more === 0;
}
