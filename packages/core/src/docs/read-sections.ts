import { UX_ELEMENT_PATTERN } from "@agentplugged/protocol";
import type { DocumentFile } from "./docs-base.js";
import { type ParsedDocument, parseDocumentFile } from "./parse-document.js";
import { storiesOf } from "./story-rules.js";
import {
  anchorOf,
  citationsOf,
  type Passage,
  passageAt,
  resolveCitation,
  sourceDocuments,
} from "./story-sheet.js";
import { uxElementsOf } from "./ux-documents.js";

/**
 * Reading by section: the text of the passages an agent needs, never a whole document. A selector
 * is a requirement or decision identifier (`EF-3`, `AD-2`, `UX-1`), a section (`prd.md#glossary`)
 * or a group (`@requirements`, `@constraints`, `@journeys`, `@decisions`, `@stack`, `@screens`,
 * `@cited:<story>`). A bare document name gives its outline (the sections and their sizes), not its
 * text. Pure: the caller reads the files.
 */

/** Lines shown in all, in the reading `next` gives with a step. */
export const READING_MAX_LINES = 80;

/** Lines shown of one passage in the reading `next` gives with a step. */
export const READING_PASSAGE_LINES = 10;

/** Lines shown of one passage when it is asked for with `docs read`. */
export const READ_PASSAGE_LINES = 60;

/** Lines shown in all when passages are asked for with `docs read`. */
export const READ_MAX_LINES = 300;

/** A passage as given to an agent. */
export interface ReadPassage {
  readonly id: string;
  /** The document, from `.agentplugged/docs/`. */
  readonly source: string;
  readonly fingerprint: string;
  readonly text: string;
  /** Lines of the passage left out of `text`. */
  readonly more: number;
}

/** One section of a document's outline. */
export interface OutlineEntry {
  readonly selector: string;
  readonly title: string;
  readonly lines: number;
}

/** The sections of a document, which a bare document name gives instead of its text. */
export interface Outline {
  readonly source: string;
  readonly lines: number;
  readonly sections: readonly OutlineEntry[];
}

/** What a reading gives. */
export interface Reading {
  readonly passages: readonly ReadPassage[];
  /** Identifiers whose passage did not fit in the lines allowed: asked for with `docs read`. */
  readonly omitted: readonly string[];
  /** Selectors no document holds: told, never invented. */
  readonly not_found: readonly string[];
  readonly outlines: readonly Outline[];
}

export interface ReadLimits {
  /** Lines shown in all. */
  readonly total: number;
  /** Lines shown of one passage. */
  readonly passage: number;
}

/** The command that reads selectors, as typed. */
export function readCommand(selectors: readonly string[]): string {
  return `npx agentplugged docs read ${selectors.join(" ")}`.trimEnd();
}

type Documents = ReturnType<typeof sourceDocuments>;

function idsOf(documents: Documents, kind: string, prefixes: readonly string[]): string[] {
  const ids: string[] = [];
  for (const document of documents) {
    if (document.parsed.kind?.value !== kind) continue;
    for (const definition of document.parsed.definitions) {
      if (definition.retired || ids.includes(definition.id)) continue;
      if (prefixes.some((prefix) => definition.id.startsWith(`${prefix}-`))) {
        ids.push(definition.id);
      }
    }
  }
  return ids;
}

function screensOf(documents: Documents): string[] {
  const ids: string[] = [];
  for (const document of documents) {
    if (document.parsed.kind?.value !== "ux") continue;
    for (const element of uxElementsOf(document.raw)) {
      if (!element.retired && UX_ELEMENT_PATTERN.test(element.id)) ids.push(element.id);
    }
  }
  return ids;
}

/** The outline of the document `name`, undefined when none has that name. */
export function outlineOf(documents: Documents, name: string): Outline | undefined {
  const document = documents.find((candidate) => candidate.name === name);
  if (document === undefined) return undefined;
  const sections: OutlineEntry[] = [];
  let fence = false;
  document.lines.forEach((line, index) => {
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) fence = !fence;
    const heading = fence ? null : /^ {0,3}(#{2,3})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (heading === null) return;
    const title = heading[2] ?? "";
    const anchor = anchorOf(title);
    if (anchor === "" || sections.some((entry) => entry.selector === `${name}#${anchor}`)) return;
    sections.push({
      selector: `${name}#${anchor}`,
      title,
      lines: passageAt(document.lines, index).split("\n").length,
    });
  });
  return { source: name, lines: document.lines.length, sections };
}

/** The identifiers and sections a selector stands for, in order. */
function expand(
  selector: string,
  documents: Documents,
  stories: ReadonlyMap<string, ParsedDocument>,
): string[] {
  switch (selector) {
    case "@requirements":
      return idsOf(documents, "prd", ["EF", "ENF"]);
    case "@constraints":
      return idsOf(documents, "prd", ["ENF"]);
    case "@journeys":
      return idsOf(documents, "prd", ["PU"]);
    case "@decisions":
      return idsOf(documents, "architecture", ["AD"]);
    case "@screens":
      return screensOf(documents);
    case "@stack": {
      const architecture = documents.find(
        (document) => document.parsed.kind?.value === "architecture",
      );
      return architecture === undefined
        ? []
        : ["stack", "conventions"].map((anchor) => `${architecture.name}#${anchor}`);
    }
    default: {
      const cited = /^@cited:(.+)$/.exec(selector);
      if (cited === null) return [selector];
      const story = stories.get(cited[1] ?? "");
      if (story === undefined) return [];
      const stack = new Set(expand("@stack", documents, stories));
      return citationsOf(story, documents).filter((id) => !stack.has(id));
    }
  }
}

/**
 * The passages the selectors name, within `limits`: each passage cut to `limits.passage` lines, and
 * the ones that no longer fit in `limits.total` left out and named in `omitted`.
 */
export function readSelectors(
  files: readonly DocumentFile[],
  selectors: readonly string[],
  limits: ReadLimits,
): Reading {
  const documents = sourceDocuments(files);
  const stories = storiesOf(
    files
      .filter((file) => file.path.replaceAll("\\", "/").includes("/stories/"))
      .map((file) => parseDocumentFile(file.path, file.text)),
  );
  const passages: ReadPassage[] = [];
  const omitted: string[] = [];
  const notFound: string[] = [];
  const outlines: Outline[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const selector of selectors) {
    if (/^[\w./-]+\.md$/.test(selector)) {
      const outline = outlineOf(documents, selector);
      if (outline === undefined) notFound.push(selector);
      else outlines.push(outline);
      continue;
    }
    const ids = expand(selector, documents, stories);
    if (ids.length === 0 && (!selector.startsWith("@") || selector.startsWith("@cited:"))) {
      notFound.push(selector);
    }
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const found: Passage | undefined = resolveCitation(id, documents);
      if (found === undefined) {
        notFound.push(id);
        continue;
      }
      const all = found.text.split("\n");
      const left = limits.total - used;
      if (left < Math.min(all.length, 2)) {
        omitted.push(id);
        continue;
      }
      const shown = all.slice(0, Math.min(limits.passage, left));
      used += shown.length;
      passages.push({
        id,
        source: found.source,
        fingerprint: found.fingerprint,
        text: shown.join("\n"),
        more: all.length - shown.length,
      });
    }
  }
  return { passages, omitted, not_found: notFound, outlines };
}

/**
 * What each downstream agent reads to do its work, by agent: the passages it needs instead of the
 * documents. A developer has none here: its story sheet holds the passages it cites.
 */
export const READING_PLAN: Readonly<Record<string, readonly string[]>> = {
  izzy: ["@requirements", "@journeys", "@decisions", "@screens"],
  alex: ["@requirements", "@journeys", "@screens"],
  stella: ["@requirements", "@journeys"],
  tess: ["@requirements", "@decisions", "@stack"],
  chloe: ["@constraints", "@decisions", "@stack"],
  omar: ["@decisions", "@stack"],
  quentin: ["@cited"],
};

/** The selectors an agent reads for a step; `@cited` becomes its story's. */
export function readingSelectors(agent: string, story: string | null): string[] {
  const plan = READING_PLAN[agent] ?? [];
  return plan.flatMap((selector) =>
    selector === "@cited" ? (story === null ? [] : [`@cited:${story}`]) : [selector],
  );
}

/** What `next` gives with a step: the passages the agent reads, and how to ask for more. */
export interface StepReading {
  readonly passages: readonly Pick<ReadPassage, "id" | "source" | "text" | "more">[];
  readonly omitted: readonly string[];
  /** The command that reads the rest. */
  readonly command: string;
}

/** The reading of `agent` for a step, from the documents as they stand; undefined when none. */
export function stepReading(
  files: readonly DocumentFile[],
  agent: string,
  story: string | null,
): StepReading | undefined {
  const selectors = readingSelectors(agent, story);
  if (selectors.length === 0) return undefined;
  const reading = readSelectors(files, selectors, {
    total: READING_MAX_LINES,
    passage: READING_PASSAGE_LINES,
  });
  if (reading.passages.length === 0 && reading.omitted.length === 0) return undefined;
  const left = [
    ...reading.omitted,
    ...reading.passages.filter((found) => found.more > 0).map((found) => found.id),
  ];
  return {
    passages: reading.passages.map(({ id, source, text, more }) => ({ id, source, text, more })),
    omitted: reading.omitted,
    command: readCommand(left.length > 0 ? left : selectors),
  };
}
