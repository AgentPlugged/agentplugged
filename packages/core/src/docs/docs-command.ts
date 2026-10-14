import { DOCUMENT_DIRS, ErrorCode, NOAH_AGENT } from "@agentplugged/protocol";
import { FORMER_AGENT_IDS } from "../agents/agent-aliases.js";
import { type CommandContext, defineCommand, fail, ok } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { METHOD_CONFIG_PATH, METHOD_DIR } from "../init/layout.js";
import { loadMethodConfig } from "../init/method-config.js";
import { documentProblemIsWarning } from "../journey/journey-rules.js";
import { AGENT_DOMAINS } from "../profile/catalog.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { computeProjection } from "../projection/compute-projection.js";
import {
  type SpecGrowResult,
  type SpecPathResult,
  specGrow,
  specPath,
} from "../spec/spec-command.js";
import { type CostsFound, findCosts } from "../usage/product-costs.js";
import type { WorkspaceFiles } from "../workspace-files.js";
import { IDENTITY_PAGE_PATH, IDENTITY_PATH, STYLE_PATH } from "./brand-documents.js";
import { checkDocumentsDetailed, type DocsProblem, type DocumentsCheck } from "./check-docs.js";
import { renderDeckPage } from "./deck-page.js";
import type { DocsBase, DocsWarning, DocumentFile } from "./docs-base.js";
import { approvedStoryDocuments, frozenIntents } from "./frozen-intents.js";
import { type MergedStoryRef, mergedStoriesOf } from "./knowledge-freshness.js";
import { parseDocumentFile } from "./parse-document.js";
import { DECK_PAGE_PATH, DECK_PATH, deckStatus, pitchDocumentChecks } from "./pitch-documents.js";
import { findResearch, type ResearchFound, subjectWords } from "./research-find.js";
import { parsePlanWords, type ResearchPlanned } from "./research-plan.js";
import { type ApprovedStory, storiesOf, warning } from "./story-rules.js";
import { UX_MOCKUP_PATH } from "./ux-documents.js";

export const DOCS_ACTIONS = ["check", "path", "grow", "research", "slides", "costs"] as const;
export type DocsAction = (typeof DOCS_ACTIONS)[number];

/** Base compared with when `--base` is not given. */
export const DEFAULT_DOCS_BASE = "HEAD";

/** The folders holding the documents: `.agentplugged/docs`, `epics` and `stories`. */
export const DOCUMENT_PATHS = DOCUMENT_DIRS.map((dir) => `${METHOD_DIR}/${dir}`);

/** Why rules 4 to 6 were not applied. */
export type DocsWithoutBase = "no_repository" | "no_commit" | "no_documents";

export interface DocsCheckResult {
  /** Number of documents checked in the working copy. */
  readonly documents: number;
  /** The base compared with, when one was read. */
  readonly base: {
    readonly ref: string;
    readonly commit: string;
    readonly documents: number;
  } | null;
  /** Set when the comparison with a base was skipped (rules 1 to 3 only). */
  readonly withoutBase?: DocsWithoutBase;
  /** The frozen story intents actually compared with the working copy (rule 10). */
  readonly intents: { readonly compared: number };
  /**
   * The problems of the documents of a step the creator skipped (the brief, the PRD, a
   * story's contract, the check itself…): shown as warnings, they never fail the check.
   */
  readonly skipped: readonly DocsProblem[];
  /** What rule 10 could not verify: shown, never failing the check. */
  readonly warnings: readonly DocsWarning[];
  readonly problems: readonly DocsProblem[];
}

/** The inputs of rule 10, and what kept them from being read. */
interface IntentInputs {
  readonly approvals: ApprovedStory[];
  readonly onBranch: ReadonlySet<string> | undefined;
  readonly warnings: DocsWarning[];
  /** The checkpoints read from the journal, or undefined when it was unreadable. */
  readonly checkpoints?: CheckpointState[];
  /** The merged stories read from the journal. */
  readonly merges?: MergedStoryRef[];
  /** The projection's state: what the creator skipped. */
  readonly state?: Readonly<Record<string, unknown>>;
}

function reasonOf(error: unknown): string {
  if (error instanceof AgentPluggedError) {
    const reason = error.details.reason;
    return typeof reason === "string" ? `${error.code}: ${reason}` : error.code;
  }
  return error instanceof Error ? error.message : String(error);
}

/** The checkpoints of the projection computed again from the journal; none without Git. */
async function journalCheckpoints(context: CommandContext): Promise<{
  checkpoints: CheckpointState[];
  merges: MergedStoryRef[];
  state: Readonly<Record<string, unknown>>;
}> {
  if (context.journal === undefined) return { checkpoints: [], merges: [], state: {} };
  let productId: string | undefined;
  if (await context.files.exists(METHOD_CONFIG_PATH)) {
    const loaded = await loadMethodConfig(context.files);
    if (loaded instanceof AgentPluggedError) throw loaded;
    productId = loaded.config.product_id;
  }
  try {
    const listing = await context.journal.list();
    const state = await computeProjection(listing.events, {
      problems: listing.problems,
      head: listing.head,
      ...(productId === undefined ? {} : { product: productId }),
      allowTestTypes: context.allowTestTypes === true,
    });
    const record = state.state.checkpoints;
    return {
      checkpoints:
        typeof record === "object" && record !== null
          ? (Object.values(record) as CheckpointState[])
          : [],
      // The merged stories, for the pages behind one.
      merges: mergedStoriesOf(state.state),
      state: state.state,
    };
  } catch (error) {
    // A folder without Git has no journal: nothing was approved.
    if (error instanceof AgentPluggedError && error.code === ErrorCode.NOT_A_GIT_REPO) {
      return { checkpoints: [], merges: [], state: {} };
    }
    throw error;
  }
}

/**
 * The inputs of rule 10: the stories the creator approved in `document` checkpoints (projection
 * of the journal, then their blobs read through Git), and the approved blobs this branch held.
 * Never fails: a broken `method.yaml`, an unreadable journal, a missing Git or a failing history
 * read each become a warning, and the other rules run as usual.
 */
async function readIntentInputs(
  context: CommandContext,
  docsBase: DocsBase,
  current: readonly DocumentFile[],
): Promise<IntentInputs> {
  const warnings: DocsWarning[] = [];
  let checkpoints: CheckpointState[];
  let merges: MergedStoryRef[];
  let state: Readonly<Record<string, unknown>>;
  try {
    ({ checkpoints, merges, state } = await journalCheckpoints(context));
  } catch (error) {
    warnings.push(warning("unverified", { source: "journal", reason: reasonOf(error) }));
    return { approvals: [], onBranch: undefined, warnings };
  }
  const inputs = await readApprovedIntents(context, docsBase, current, checkpoints, warnings);
  return { ...inputs, checkpoints, merges, state };
}

/** Rule 10 from the checkpoints read: the approved stories, and the blobs this branch held. */
async function readApprovedIntents(
  context: CommandContext,
  docsBase: DocsBase,
  current: readonly DocumentFile[],
  checkpoints: readonly CheckpointState[],
  warnings: DocsWarning[],
): Promise<IntentInputs> {
  const { approved, mismatched } = approvedStoryDocuments(checkpoints, (context.now ?? Date.now)());
  for (const entry of mismatched) {
    warnings.push(warning("path_mismatch", { checkpoint: entry.checkpoint, path: entry.path }));
  }
  if (approved.length === 0) return { approvals: [], onBranch: undefined, warnings };
  let blobs: ReadonlyMap<string, string>;
  try {
    blobs = await docsBase.readBlobs([...new Set(approved.map((entry) => entry.blob))]);
  } catch (error) {
    warnings.push(warning("unverified", { source: "Git", reason: reasonOf(error) }));
    return { approvals: [], onBranch: undefined, warnings };
  }
  const approvals = frozenIntents(approved, blobs);
  // The history is read only for the approved stories gone from the working copy.
  const present = storiesOf(current.map((file) => parseDocumentFile(file.path, file.text)));
  const gone = approvals.filter(
    (entry) => entry.state === "read" && entry.story !== undefined && !present.has(entry.story),
  );
  if (gone.length === 0) return { approvals, onBranch: new Set(), warnings };
  try {
    const onBranch = await docsBase.blobsInHistory([...new Set(gone.map((entry) => entry.blob))]);
    return { approvals, onBranch, warnings };
  } catch (error) {
    warnings.push(warning("unverified", { source: "Git", reason: reasonOf(error) }));
    return { approvals, onBranch: undefined, warnings };
  }
}

/** A document of the three folders: a Markdown file, at any depth. */
export function isDocumentPath(path: string): boolean {
  return (
    DOCUMENT_PATHS.some((dir) => path.startsWith(`${dir}/`)) && path.toLowerCase().endsWith(".md")
  );
}

function invalid(reason: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", { reason });
}

/**
 * Agents a document may name as owner: the catalog's, those installed in the product, and the
 * former team's: a document written before the renaming keeps its owner.
 */
export async function knownOwners(files: WorkspaceFiles): Promise<Set<string>> {
  const owners = new Set<string>([...Object.keys(AGENT_DOMAINS), ...FORMER_AGENT_IDS]);
  const prefix = `${METHOD_DIR}/agents/`;
  for (const path of await files.listFiles(`${METHOD_DIR}/agents`)) {
    const id = path.slice(prefix.length).split("/")[0];
    if (id && path.slice(prefix.length).includes("/")) owners.add(id);
  }
  // Noah, the main session's assistant, owns no deliverable.
  owners.delete(NOAH_AGENT);
  return owners;
}

/**
 * The documents of the working copy, as `docs check` and `next` read them (the same
 * set): the Markdown files of `.agentplugged/{docs,epics,stories}/`, at any depth, symbolic links
 * left out. A file that cannot be read fails the read, unless `skipUnreadable` (`next`, a read
 * that never fails on one document).
 */
export async function readDocumentFiles(
  files: WorkspaceFiles,
  skipUnreadable = false,
): Promise<DocumentFile[]> {
  const documents: DocumentFile[] = [];
  for (const dir of DOCUMENT_PATHS) {
    for (const path of await files.listFiles(dir)) {
      if (!isDocumentPath(path)) continue;
      // A symbolic link is never a document, here as in the base (Git stores it as a link).
      if ((await files.isSymbolicLink?.(path)) === true) continue;
      const read = files.readText(path);
      const text = skipUnreadable ? await read.catch(() => undefined) : await read;
      if (text !== undefined) documents.push({ path, text });
    }
  }
  return documents;
}

/**
 * The pages of the UX mock-ups: every file of `ux-mockups/`, by path, with the text
 * of the `.html` ones (a file of another kind, or a symbolic link, has an empty text: the check
 * names it). Read for the check only; a file that cannot be read fails the read unless
 * `skipUnreadable`.
 */
export async function readMockupFiles(
  files: WorkspaceFiles,
  skipUnreadable = false,
): Promise<Map<string, string>> {
  const pages = new Map<string, string>();
  for (const listed of await files.listFiles(UX_MOCKUP_PATH.slice(0, -1))) {
    const path = listed.replaceAll("\\", "/");
    if (!path.startsWith(UX_MOCKUP_PATH)) continue;
    // Whatever else stands in the folder is named by the check, never read nor followed: a file
    // that is not a page (`x.svg`, `x.htm`) or a link is as wrong there as a page that is unsafe.
    if (!path.endsWith(".html") || (await files.isSymbolicLink?.(listed)) === true) {
      pages.set(path, "");
      continue;
    }
    const read = files.readText(listed);
    const text = skipUnreadable ? await read.catch(() => undefined) : await read;
    if (text !== undefined) pages.set(path, text);
  }
  return pages;
}

/** True when the file, or a folder above it, is a symbolic link: nothing is read through one. */
async function linked(files: WorkspaceFiles, path: string): Promise<boolean> {
  const parts = path.split("/");
  for (let end = 1; end <= parts.length; end += 1) {
    if ((await files.isSymbolicLink?.(parts.slice(0, end).join("/"))) === true) return true;
  }
  return false;
}

/**
 * The files the identity binds: its page, and the style files of the code it lists in
 * `style_files`. A file that is missing, a link or a path that leaves the project is not read: the
 * check names it. Nothing is read when the identity is not there.
 */
export async function readBrandFiles(
  files: WorkspaceFiles,
  documents: readonly DocumentFile[],
  skipUnreadable = false,
): Promise<Map<string, string>> {
  const read = new Map<string, string>();
  const identity = documents.find((file) => file.path === IDENTITY_PATH);
  if (identity === undefined) return read;
  const listed = parseDocumentFile(identity.path, identity.text).style_files?.value;
  const wanted = [IDENTITY_PAGE_PATH];
  for (const entry of (Array.isArray(listed) ? listed : [listed]).slice(0, 20)) {
    if (typeof entry === "string" && STYLE_PATH.test(entry)) wanted.push(entry);
  }
  for (const path of wanted) {
    if (!(await files.exists(path)) || (await linked(files, path))) continue;
    const text = files.readText(path);
    const found = skipUnreadable ? await text.catch(() => undefined) : await text;
    if (found !== undefined) read.set(path, found);
  }
  return read;
}

/** The answer of `docs slides`: the page written next to the deck. */
export interface DeckDrawn {
  readonly page: "deck";
  readonly path: string;
  readonly slides: number;
  readonly notes: number;
  /** What of the deck is not on the page: its other sections, the text before the first slide. */
  readonly notDrawn: readonly string[];
  /** Whether the deck is validated, changed since, still a draft, or unknown (no journal). */
  readonly deck: string;
}

/**
 * `docs slides`: draws the deck of the launch as one page of HTML next to it. A deck that `docs
 * check` would refuse (header, slides, notes, template markers left) is not drawn. Writes the page
 * only; the deck is read, never changed.
 */
async function drawDeck(context: CommandContext) {
  if (!(await context.files.exists(DECK_PATH))) {
    return fail(invalid(`docs slides: no deck (${DECK_PATH})`));
  }
  // A link is never followed to read or to write: not the deck, not its page.
  for (const path of [DECK_PATH, DECK_PAGE_PATH]) {
    if ((await context.files.isSymbolicLink?.(path)) === true) {
      return fail(invalid(`docs slides: ${path} is a symbolic link`));
    }
  }
  const text = await context.files.readText(DECK_PATH);
  const parsed = parseDocumentFile(DECK_PATH, text);
  const checked = pitchDocumentChecks({ documents: [parsed], textOf: () => text });
  if (checked.problems.length > 0) {
    return fail(invalid(`docs slides: ${DECK_PATH} has problems, run docs check`));
  }
  let state = "unknown";
  try {
    const { checkpoints } = await journalCheckpoints(context);
    state = deckStatus(text, checkpoints, (context.now ?? Date.now)()).state;
  } catch {
    // No readable journal: the page is drawn all the same, and says it does not know.
  }
  const page = renderDeckPage(text);
  await context.files.writeText(DECK_PAGE_PATH, page.html);
  return ok<DeckDrawn>({
    page: "deck",
    path: DECK_PAGE_PATH,
    slides: page.slides,
    notes: page.notes,
    notDrawn: page.notDrawn,
    deck: state,
  });
}

const MAX_AGE_WORD = /^max_age=([1-9]\d{0,3})$/;

/**
 * `docs research <subject words> [max_age=<days>]`: the research pages of the knowledge base about
 * the subject, most recent first, one bounded line each. Reads, writes nothing.
 */
async function researchFind(context: CommandContext, words: readonly string[]) {
  // `docs research questions=<n>` (or `report=<characters>`) announces the three
  // efforts and their tokens before any sub-agent starts.
  const planned = parsePlanWords(words);
  if (planned !== undefined) {
    return "invalid" in planned
      ? fail(invalid(planned.invalid))
      : ok<ResearchPlanned>(planned.plan);
  }
  const ages = words.flatMap((word) => MAX_AGE_WORD.exec(word)?.[1] ?? []);
  const subject = words.filter((word) => !word.startsWith("max_age=")).join(" ");
  const malformed = words.some((word) => word.startsWith("max_age=") && !MAX_AGE_WORD.test(word));
  if (ages.length > 1 || malformed) {
    return fail(invalid(`docs research ${words.join(" ")} (max_age=<days>)`));
  }
  if (subjectWords(subject).length === 0) return fail(invalid("docs research <subject>"));
  const pages = (await readDocumentFiles(context.files, true)).map((file) => ({
    document: parseDocumentFile(file.path, file.text),
    text: file.text,
  }));
  return ok<ResearchFound>(
    findResearch({
      pages,
      subject,
      now: (context.now ?? Date.now)(),
      ...(ages[0] === undefined ? {} : { maxAgeDays: Number(ages[0]) }),
    }),
  );
}

/**
 * `docs check [--base <ref>]`: checks the headers of the documents of `.agentplugged/{docs,epics,
 * stories}/`, then compares their requirement identifiers with the base (`HEAD` by default, read
 * through `context.docsBase`). Writes nothing. The problems are in the result: the surface fails
 * when there is at least one.
 */
export const docsCommand = defineCommand<
  | DocsCheckResult
  | SpecPathResult
  | SpecGrowResult
  | ResearchFound
  | ResearchPlanned
  | DeckDrawn
  | CostsFound
>({
  name: "docs",
  async run(context, input) {
    const { action, base } = input;
    // The short path's choice, and carrying its spec over to the full path.
    if (action === "path") {
      return specPath(Array.isArray(input.words) ? input.words.map(String) : []);
    }
    if (action === "grow") return specGrow(context);
    // What was already searched about a subject.
    if (action === "research") {
      return researchFind(context, Array.isArray(input.words) ? input.words.map(String) : []);
    }
    // The deck drawn.
    if (action === "slides") return drawDeck(context);
    // What the product costs to build, as an estimate, and when it pays for itself.
    if (action === "costs") {
      return findCosts(context, Array.isArray(input.words) ? input.words.map(String) : []);
    }
    if (action !== "check") {
      const typed = ["docs", ...(typeof action === "string" ? [action] : [])].join(" ");
      return fail(invalid(`${typed} (${DOCS_ACTIONS.join(", ")})`));
    }
    if (
      base !== undefined &&
      (typeof base !== "string" || base.trim() === "" || base.startsWith("-"))
    ) {
      return fail(invalid(`--base ${String(base)}`));
    }
    if (context.docsBase === undefined) {
      return fail(
        new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
          reason: "no base reader is available here",
        }),
      );
    }
    const ref = base ?? DEFAULT_DOCS_BASE;
    const current = await readDocumentFiles(context.files);
    const owners = await knownOwners(context.files);
    const mockups = await readMockupFiles(context.files);
    const brandFiles = await readBrandFiles(context.files, current);
    const read = await context.docsBase.read(ref, DOCUMENT_PATHS);
    if (!read.found && read.reason === "unknown_ref") {
      return fail(invalid(`--base ${ref}: unknown revision`));
    }
    const inputs = await readIntentInputs(context, context.docsBase, current);
    const checkpoints = inputs.checkpoints;
    const intentInput = {
      mockups,
      brandFiles,
      approvals: inputs.approvals,
      onBranch: inputs.onBranch,
      // The pages of the knowledge base behind a validated document.
      ...(checkpoints === undefined
        ? {}
        : {
            validations: {
              checkpoints,
              now: (context.now ?? Date.now)(),
              ...(inputs.merges === undefined ? {} : { merges: inputs.merges }),
            },
          }),
    };
    // The problems of what the creator skipped are warnings, never a failure.
    const aside = (problem: DocsProblem) =>
      inputs.state !== undefined &&
      documentProblemIsWarning(inputs.state, String(problem.details.path ?? ""));
    const outcome = (checked: DocumentsCheck) => ({
      intents: { compared: checked.compared },
      warnings: [...inputs.warnings, ...checked.warnings],
      problems: checked.problems.filter((problem) => !aside(problem)),
      skipped: checked.problems.filter(aside),
    });
    if (!read.found) {
      const withoutBase: DocsWithoutBase =
        read.reason === "no_commit" ? "no_commit" : "no_repository";
      return ok({
        documents: current.length,
        base: null,
        withoutBase,
        ...outcome(checkDocumentsDetailed({ current, owners, ...intentInput })),
      });
    }
    const baseFiles = read.files.filter((file) => isDocumentPath(file.path));
    return ok({
      documents: current.length,
      base: { ref, commit: read.commit, documents: baseFiles.length },
      ...(baseFiles.length === 0 ? { withoutBase: "no_documents" as const } : {}),
      ...outcome(
        checkDocumentsDetailed({ current, base: baseFiles, baseRef: ref, owners, ...intentInput }),
      ),
    });
  },
});
