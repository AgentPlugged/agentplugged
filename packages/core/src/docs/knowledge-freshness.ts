import { gitBlobId, utf8 } from "@agentplugged/crypto";
import {
  ErrorCode,
  ISSUE,
  type IssueName,
  KnowledgeCodeSchema,
  KnowledgeSourceSchema,
  KnowledgeStorySchema,
} from "@agentplugged/protocol";
import { documentOwner } from "../agents/agent-aliases.js";
import { reasonDetails } from "../errors.js";
import { METHOD_DIR } from "../init/layout.js";
import { approvedAt, byAnswer } from "../phases/phases.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import type { DocsProblem, DocsWarning, DocumentFile } from "./docs-base.js";
import { KNOWLEDGE_BASE_WRITER } from "./knowledge-base.js";
import { type ParsedDocument, parseDocumentFile } from "./parse-document.js";
import { warning } from "./story-rules.js";

/**
 * Freshness of the knowledge base. A page of the base records, in its header field
 * `sources`, the Git blob of each document of the method it was built from. When the creator
 * approves another version of that document (a `document` or `phase_end` checkpoint citing it),
 * and this branch holds that version, the page is behind it until Zoé updates it. Only the
 * documents of `.agentplugged/docs/` are tracked: the stories and the epics never are, and the
 * release notes, a dated history, track nothing. Pure: the caller reads the working copy and the
 * projection.
 */

/** The folder of the pages of the base, and of the method's documents they build on. */
const DOCS_PREFIX = `${METHOD_DIR}/docs/`;

/** The release notes: a dated history, never brought up to date with a living document. */
const RELEASE_NOTES_PREFIX = `${DOCS_PREFIX}release-notes/`;

/** The checkpoint types whose approval validates the documents they cite. */
const VALIDATING_TYPES: ReadonlySet<string> = new Set(["document", "phase_end"]);

/**
 * A path as read: `\` read as `/`, then from the `.agentplugged/` folder it names (a product in a
 * sub-folder of its repository cites `<folder>/.agentplugged/…`, an absolute path holds the
 * folders above it), else without its leading `./`. Case is kept: `pathKey` compares.
 */
export function comparablePath(path: string): string {
  const plain = path.replaceAll("\\", "/");
  const segments = plain.split("/");
  const at = segments.lastIndexOf(METHOD_DIR);
  if (at >= 0) return segments.slice(at).join("/");
  return plain.replace(/^(?:\.\/)+/, "");
}

/** A path as compared: `comparablePath`, without case (Windows and macOS ignore it). */
export function pathKey(path: string): string {
  return comparablePath(path).toLowerCase();
}

/** A page of the knowledge base: a Markdown file of `.agentplugged/docs/` owned by Zoé. */
export function isKnowledgePage(document: ParsedDocument): boolean {
  return (
    pathKey(document.path).startsWith(DOCS_PREFIX) &&
    document.owner !== undefined &&
    // A page written before the renaming names the former identifier.
    documentOwner(document.owner.value) === KNOWLEDGE_BASE_WRITER
  );
}

/** True for a page of the release notes: it tracks no document. */
function isReleaseNotes(path: string): boolean {
  return pathKey(path).startsWith(RELEASE_NOTES_PREFIX);
}

/**
 * A document a page builds on: its path (`comparablePath`), the blob the page recorded for it
 * (none: not recorded), and the blobs of its version in the working copy (none: absent).
 */
export interface TrackedSource {
  readonly path: string;
  readonly blob: string | undefined;
  readonly held: readonly string[];
}

/** A page of the base and the documents of the method it builds on. */
export interface KnowledgePage {
  readonly path: string;
  readonly tracked: readonly TrackedSource[];
  /**
   * The paths of the repository the page describes (its valid `code` entries): a path
   * that ends with `/` is a folder. Absent or empty: no code tracked.
   */
  readonly code?: readonly string[];
  /** The last merged story the page took in (`last_story`), when valid. */
  readonly last_story?: string;
}

/** One entry of `sources` as read: kept with its path, or refused with the reason. */
type SourceEntry =
  | { readonly ok: true; readonly path: string; readonly blob: string }
  | { readonly ok: false; readonly index: number; readonly issue: IssueName };

/**
 * The entries of a page's `sources`, one by one (`null` or absent: none). A valid entry names a
 * document of `.agentplugged/docs/` that is not a page of the base; `pages` holds the keys of the
 * pages. A value that is not a list is one refusal, at index -1.
 */
function sourceEntries(document: ParsedDocument, pages: ReadonlySet<string>): SourceEntry[] {
  const value = document.sources?.value;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [{ ok: false, index: -1, issue: "docSource" }];
  if (value.length > 0 && isReleaseNotes(document.path)) {
    return [{ ok: false, index: -1, issue: "docSourceRelease" }];
  }
  return value.map((item, index): SourceEntry => {
    const parsed = KnowledgeSourceSchema.safeParse(item);
    if (!parsed.success) return { ok: false, index, issue: "docSource" };
    const path = comparablePath(parsed.data.path);
    const key = path.toLowerCase();
    if (!key.startsWith(DOCS_PREFIX) || key.split("/").includes("..")) {
      return { ok: false, index, issue: "docSourceOutside" };
    }
    if (pages.has(key) || isReleaseNotes(key)) return { ok: false, index, issue: "docSourcePage" };
    return { ok: true, path, blob: parsed.data.blob };
  });
}

/** The keys of the pages of the base among `documents`. */
function pageKeys(documents: readonly ParsedDocument[]): Set<string> {
  return new Set(documents.filter(isKnowledgePage).map((document) => pathKey(document.path)));
}

/** The Git blob ids of a text, as written and with LF line endings, in SHA-1 and SHA-256. */
export function blobIdsOf(text: string): string[] {
  const variants = new Set([text, text.replaceAll("\r\n", "\n")]);
  const ids: string[] = [];
  for (const variant of variants) {
    const bytes = utf8(variant);
    ids.push(gitBlobId(bytes, "sha1"), gitBlobId(bytes, "sha256"));
  }
  return ids;
}

/**
 * The pages of the base among `documents`, each with the documents it tracks: the valid entries
 * of its `sources`, and the documents of `.agentplugged/docs/` its `links` name by id, other pages
 * left out. The release notes track nothing. `textOf` gives the working copy's text of a document
 * by its path as listed, to tell which versions this branch holds.
 */
export function knowledgePagesOf(
  documents: readonly ParsedDocument[],
  textOf: (path: string) => string | undefined,
): KnowledgePage[] {
  const pages = pageKeys(documents);
  const byId = new Map<string, ParsedDocument>();
  const byKey = new Map<string, ParsedDocument>();
  for (const document of documents) {
    if (document.id !== undefined && !byId.has(document.id)) byId.set(document.id, document);
    const key = pathKey(document.path);
    if (!byKey.has(key)) byKey.set(key, document);
  }
  const held = new Map<string, readonly string[]>();
  const heldOf = (key: string): readonly string[] => {
    let ids = held.get(key);
    if (ids === undefined) {
      const document = byKey.get(key);
      const text = document === undefined ? undefined : textOf(document.path);
      ids = text === undefined ? [] : blobIdsOf(text);
      held.set(key, ids);
    }
    return ids;
  };
  const result: KnowledgePage[] = [];
  for (const page of documents) {
    if (!isKnowledgePage(page)) continue;
    const path = comparablePath(page.path);
    if (isReleaseNotes(path)) {
      // They track no document and describe no code, but `last_story` says which merged stories
      // the notes cover.
      const covered = KnowledgeStorySchema.safeParse(page.last_story?.value);
      result.push({ path, tracked: [], ...(covered.success ? { last_story: covered.data } : {}) });
      continue;
    }
    const tracked = new Map<string, { path: string; blob: string | undefined }>();
    for (const entry of sourceEntries(page, pages)) {
      if (entry.ok) tracked.set(entry.path.toLowerCase(), { path: entry.path, blob: entry.blob });
    }
    for (const link of page.links) {
      const linked = byId.get(link.value);
      if (linked === undefined || isKnowledgePage(linked)) continue;
      const linkedPath = comparablePath(linked.path);
      const key = linkedPath.toLowerCase();
      if (key.startsWith(DOCS_PREFIX) && !tracked.has(key)) {
        tracked.set(key, { path: linkedPath, blob: undefined });
      }
    }
    const sources = [...tracked.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, source]) => ({ ...source, held: heldOf(key) }));
    const code = codeEntries(page).flatMap((entry) => (entry.ok ? [entry.path] : []));
    const lastStory = KnowledgeStorySchema.safeParse(page.last_story?.value);
    result.push({
      path,
      tracked: sources,
      ...(code.length === 0 ? {} : { code }),
      ...(lastStory.success ? { last_story: lastStory.data } : {}),
    });
  }
  return result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** `knowledgePagesOf`, from the files as read (each parsed once). */
export function knowledgePages(files: readonly DocumentFile[]): KnowledgePage[] {
  const texts = new Map(files.map((file) => [file.path, file.text]));
  return knowledgePagesOf(
    files.map((file) => parseDocumentFile(file.path, file.text)),
    (path) => texts.get(path),
  );
}

/** The version of a document the creator approved last: the checkpoint and the blob it cites. */
export interface ValidatedVersion {
  readonly checkpoint: string;
  readonly blob: string;
}

/**
 * The last validated version of each document, by `pathKey`: the blob cited by the last
 * `document` or `phase_end` checkpoint approved (a lifting decision, never a waiver), in the order
 * of the answers. An open, refused or changes-requested checkpoint validates nothing.
 */
export function validatedVersions(
  checkpoints: Iterable<CheckpointState>,
  now: number,
): Map<string, ValidatedVersion> {
  const versions = new Map<string, ValidatedVersion>();
  const approved = [...checkpoints]
    .filter((checkpoint) => VALIDATING_TYPES.has(checkpoint.type) && approvedAt(checkpoint, now))
    .sort(byAnswer);
  for (const checkpoint of approved) {
    for (const document of checkpoint.documents ?? []) {
      versions.set(pathKey(document.path), {
        checkpoint: checkpoint.id,
        blob: document.blob_sha.toLowerCase(),
      });
    }
  }
  return versions;
}

/** A page behind a validated document: `unrecorded` (no blob for it) or `stale` (another blob). */
export interface StaleSource {
  readonly page: string;
  readonly source: string;
  readonly reason: "stale" | "unrecorded";
  /** The checkpoint that approved the version the page lacks, and its blob. */
  readonly checkpoint: string;
  readonly blob: string;
  /** The blob the page recorded, when it recorded one. */
  readonly recorded: string | undefined;
}

/**
 * Every page–document pair where the page is behind the validated version, in page order. A
 * validated version counts only once this branch holds it: the working copy's document is that
 * blob (as written, or with LF line endings). Before the merge of the branch that validated it,
 * nothing is behind.
 */
export function staleKnowledgeSources(
  pages: readonly KnowledgePage[],
  checkpoints: Iterable<CheckpointState>,
  now: number,
): StaleSource[] {
  const versions = validatedVersions(checkpoints, now);
  const stale: StaleSource[] = [];
  for (const page of pages) {
    for (const source of page.tracked) {
      const version = versions.get(source.path.toLowerCase());
      if (version === undefined || source.blob === version.blob) continue;
      if (!source.held.includes(version.blob)) continue;
      stale.push({
        page: page.path,
        source: source.path,
        reason: source.blob === undefined ? "unrecorded" : "stale",
        checkpoint: version.checkpoint,
        blob: version.blob,
        recorded: source.blob,
      });
    }
  }
  return stale;
}

/** The warnings of `docs check` for the pages behind a validated document. */
export function staleKnowledgeWarnings(stale: readonly StaleSource[]): DocsWarning[] {
  return stale.map((entry) =>
    warning(entry.reason === "stale" ? "kb_stale" : "kb_source_unrecorded", {
      path: entry.page,
      source: entry.source,
      checkpoint: entry.checkpoint,
      blob: entry.blob,
      ...(entry.recorded === undefined ? {} : { recorded: entry.recorded }),
    }),
  );
}

/**
 * The refused entries of the `sources` of the pages of the base: header problems, one per entry
 * (`sources.<index>`), or one for the field when it is not a list or sits on release notes.
 */
export function knowledgeSourceProblems(documents: readonly ParsedDocument[]): DocsProblem[] {
  const pages = pageKeys(documents);
  const problems: DocsProblem[] = [];
  for (const document of documents) {
    const sources = document.sources;
    if (sources === undefined || !isKnowledgePage(document)) continue;
    for (const entry of sourceEntries(document, pages)) {
      if (entry.ok) continue;
      problems.push({
        code: ErrorCode.DOC_HEADER_INVALID,
        message_key: "error.doc_header_invalid",
        details: {
          path: document.path,
          line: sources.line,
          field: entry.index < 0 ? "sources" : `sources.${entry.index}`,
          ...reasonDetails(ISSUE[entry.issue]),
        },
      });
    }
  }
  return problems;
}

/** One entry of `code` as read: kept, or refused at its index (-1: not a list). */
type CodeEntry =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly index: number };

/** The entries of a page's `code`, one by one (`null` or absent: none). */
function codeEntries(document: ParsedDocument): CodeEntry[] {
  const value = document.code?.value;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [{ ok: false, index: -1 }];
  return value.map((item, index): CodeEntry => {
    const parsed = KnowledgeCodeSchema.safeParse(item);
    return parsed.success ? { ok: true, path: parsed.data } : { ok: false, index };
  });
}

/**
 * The refused `code` entries and `last_story` of the pages of the base: header
 * problems, one per entry (`code.<index>`), or one for the field.
 */
export function knowledgeCodeProblems(documents: readonly ParsedDocument[]): DocsProblem[] {
  const problems: DocsProblem[] = [];
  const problem = (document: ParsedDocument, line: number, field: string, issue: IssueName) =>
    problems.push({
      code: ErrorCode.DOC_HEADER_INVALID,
      message_key: "error.doc_header_invalid",
      details: { path: document.path, line, field, ...reasonDetails(ISSUE[issue]) },
    });
  for (const document of documents) {
    if (!isKnowledgePage(document)) continue;
    const code = document.code;
    if (code !== undefined) {
      for (const entry of codeEntries(document)) {
        if (!entry.ok) {
          problem(document, code.line, entry.index < 0 ? "code" : `code.${entry.index}`, "docCode");
        }
      }
    }
    const last = document.last_story;
    if (
      last !== undefined &&
      last.value !== null &&
      !KnowledgeStorySchema.safeParse(last.value).success
    ) {
      problem(document, last.line, "last_story", "docLastStory");
    }
  }
  return problems;
}

/** A merged story as the knowledge base reads it: its rank and the files it changed. */
export interface MergedStoryRef {
  readonly story: string;
  readonly seq: number;
  readonly files: readonly string[];
  /** It changed more files than recorded: every page with `code` may describe one of them. */
  readonly truncated?: boolean;
  /** When it was merged (ISO date), when recorded (the release notes it belongs to). */
  readonly at?: string;
  /** The weight of its code, when the journal kept it (duplicates absent when not looked for). */
  readonly weight?: {
    readonly added: number;
    readonly removed: number;
    readonly duplicates?: number;
  };
}

/** The merged stories of a projection (`state.stories[id].merged`), by rank. */
export function mergedStoriesOf(projection: Readonly<Record<string, unknown>>): MergedStoryRef[] {
  const stories = projection.stories;
  if (stories === null || typeof stories !== "object") return [];
  const merged: MergedStoryRef[] = [];
  for (const [story, entry] of Object.entries(stories as Record<string, unknown>)) {
    const record = (
      entry as {
        merged?: {
          seq?: unknown;
          files?: unknown;
          files_truncated?: unknown;
          at?: unknown;
          weight?: { added?: unknown; removed?: unknown; duplicates?: unknown };
        };
      } | null
    )?.merged;
    if (record === undefined || typeof record.seq !== "number" || !Array.isArray(record.files)) {
      continue;
    }
    merged.push({
      story,
      seq: record.seq,
      files: record.files.filter((file): file is string => typeof file === "string"),
      ...(record.files_truncated === true ? { truncated: true } : {}),
      ...(typeof record.at === "string" ? { at: record.at } : {}),
      ...(typeof record.weight?.added === "number" && typeof record.weight.removed === "number"
        ? {
            weight: {
              added: record.weight.added,
              removed: record.weight.removed,
              ...(typeof record.weight.duplicates === "number"
                ? { duplicates: record.weight.duplicates }
                : {}),
            },
          }
        : {}),
    });
  }
  return merged.sort((a, b) => a.seq - b.seq);
}

/** True when a file of the repository is one of a page's `code` paths, or inside one of its folders. */
function describes(code: readonly string[], file: string): boolean {
  const key = file.toLowerCase();
  return code.some((entry) => {
    const path = entry.toLowerCase();
    return path.endsWith("/") ? key.startsWith(path) : key === path;
  });
}

/** A page behind a merged story that changed the code it describes. */
export interface StaleStory {
  readonly page: string;
  readonly story: string;
  /** The story's files the page describes (at most 5). */
  readonly files: readonly string[];
}

/**
 * Every page–story pair where a story merged after the page's `last_story` (by rank; every merged
 * story when the page names none, or names a story not merged) changed a file of its `code`, in
 * page then rank order. A page without `code` is never behind a story.
 */
export function staleKnowledgeStories(
  pages: readonly KnowledgePage[],
  merges: readonly MergedStoryRef[],
): StaleStory[] {
  const stale: StaleStory[] = [];
  const rank = new Map(merges.map((merge) => [merge.story, merge.seq]));
  for (const page of pages) {
    const code = page.code ?? [];
    if (code.length === 0) continue;
    const since = page.last_story === undefined ? 0 : (rank.get(page.last_story) ?? 0);
    for (const merge of merges) {
      if (merge.seq <= since) continue;
      const files = merge.files.filter((file) => describes(code, file));
      if (files.length > 0 || merge.truncated === true)
        stale.push({ page: page.path, story: merge.story, files: files.slice(0, 5) });
    }
  }
  return stale;
}

/** The warnings of `docs check` for the pages behind a merged story. */
export function staleStoryWarnings(stale: readonly StaleStory[]): DocsWarning[] {
  return stale.map((entry) =>
    warning("kb_story", { path: entry.page, story: entry.story, files: entry.files.join(", ") }),
  );
}
