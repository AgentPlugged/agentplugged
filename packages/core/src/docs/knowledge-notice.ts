import { workflowOf } from "../git/git-workflow.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import type { StoryWorkspace } from "../stories/story-workspace.js";
import type { WorkspaceFiles } from "../workspace-files.js";
import { readDocumentFiles } from "./docs-command.js";
import {
  comparablePath,
  type KnowledgePage,
  knowledgePages,
  type MergedStoryRef,
  mergedStoriesOf,
  staleKnowledgeSources,
  staleKnowledgeStories,
} from "./knowledge-freshness.js";

/**
 * The late notice: a page of the knowledge base that is behind a document the
 * creator validated or a merged story says so itself, in a block the engine writes right after
 * the header and takes away when the page is up to date. Deterministic: the engine writes it,
 * never an agent, and it touches nothing of the page outside this block.
 */
const BEGIN = /^<!-- agentplugged:late since=(\d{4}-\d{2}-\d{2}) -->$/;
const END = "<!-- /agentplugged:late -->";

/** Why a page is behind, as the notice says it. */
export interface LateReason {
  /** The merged stories the page lacks, in rank order. */
  readonly stories: readonly string[];
  /** The documents validated since the page was written (their paths). */
  readonly documents: readonly string[];
  /** Where to look: the files of those stories the page describes, else the page's own `code`. */
  readonly paths: readonly string[];
}

/** The date (UTC) of a clock reading. */
function dayOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** The notice for `reason` since `since`, as lines (without line ends). */
function noticeLines(reason: LateReason, since: string): string[] {
  const where = reason.paths.map((path) => `\`${path}\``).join(", ");
  const behind = [
    ...(reason.stories.length > 0 ? [`la story ${reason.stories.join(", ")}`] : []),
    ...reason.documents.map((path) => `le document \`${path}\``),
  ].join(" et sur ");
  const behindEn = [
    ...(reason.stories.length > 0 ? [`story ${reason.stories.join(", ")}`] : []),
    ...reason.documents.map((path) => `document \`${path}\``),
  ].join(" and ");
  const check = where === "" ? "le code concerné" : `le code de ${where}`;
  const checkEn = where === "" ? "the code concerned" : `the code of ${where}`;
  return [
    `<!-- agentplugged:late since=${since} -->`,
    `> Page en retard sur ${behind} depuis le ${since} : vérifie ${check} avant de t'y fier.`,
    `> Page behind ${behindEn} since ${since}: check ${checkEn} before relying on it.`,
    END,
  ];
}

/** Where the header of a page ends: the offset after its closing line, and the line ending. */
function afterHeader(text: string): { offset: number; eol: string } | undefined {
  const open = /^---[ \t]*(\r?\n)/.exec(text);
  if (open === null) return undefined;
  const eol = open[1] as string;
  const close = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(text.slice(open[0].length - eol.length));
  if (close === null) return undefined;
  return { offset: open[0].length - eol.length + close.index + close[0].length, eol };
}

/** The block of a page, when it holds a well-formed one: its offsets, line ending and date. */
function blockOf(
  text: string,
): { start: number; end: number; since: string; eol: string } | undefined {
  const header = afterHeader(text);
  if (header === undefined) return undefined;
  const lineEnd = text.indexOf("\n", header.offset);
  if (lineEnd === -1) return undefined;
  const first = text.slice(header.offset, lineEnd).replace(/\r$/, "");
  const match = BEGIN.exec(first);
  if (match === null) return undefined;
  const stop = text.indexOf(`${header.eol}${END}`, header.offset);
  if (stop === -1) return undefined;
  const end = stop + header.eol.length + END.length;
  const after = text.startsWith(header.eol, end) ? end + header.eol.length : end;
  return { start: header.offset, end: after, since: match[1] as string, eol: header.eol };
}

/**
 * The page with its late notice brought to `reason` (none: no notice). The date of an existing
 * notice is kept while the page stays behind. A page without a header, or whose notice is
 * mangled, is returned as it is.
 */
export function withLateNotice(text: string, reason: LateReason | undefined, now: number): string {
  const header = afterHeader(text);
  if (header === undefined) return text;
  const lineEnd = text.indexOf("\n", header.offset);
  const firstLine = lineEnd === -1 ? "" : text.slice(header.offset, lineEnd).replace(/\r$/, "");
  const existing = blockOf(text);
  if (existing === undefined && firstLine.startsWith("<!-- agentplugged:late")) return text;
  const bare =
    existing === undefined ? text : text.slice(0, existing.start) + text.slice(existing.end);
  if (reason === undefined) return bare;
  const lines = noticeLines(reason, existing?.since ?? dayOf(now));
  const block = lines.join(header.eol) + header.eol;
  const head = header.offset;
  const separator = bare.slice(0, head).endsWith("\n") ? "" : header.eol;
  return bare.slice(0, head) + separator + block + bare.slice(head);
}

/** The reasons every page behind is behind, by page path. */
export function lateReasons(
  pages: readonly KnowledgePage[],
  checkpoints: readonly CheckpointState[],
  merges: readonly MergedStoryRef[],
  now: number,
): Map<string, LateReason> {
  const reasons = new Map<
    string,
    { stories: Set<string>; documents: Set<string>; paths: Set<string> }
  >();
  const entry = (page: string) => {
    let found = reasons.get(page);
    if (found === undefined) {
      found = { stories: new Set(), documents: new Set(), paths: new Set() };
      reasons.set(page, found);
    }
    return found;
  };
  for (const stale of staleKnowledgeSources(pages, checkpoints, now)) {
    entry(stale.page).documents.add(comparablePath(stale.source));
  }
  for (const stale of staleKnowledgeStories(pages, merges)) {
    const found = entry(stale.page);
    found.stories.add(stale.story);
    for (const file of stale.files) found.paths.add(file);
  }
  const result = new Map<string, LateReason>();
  for (const [page, found] of reasons) {
    const code = pages.find((candidate) => candidate.path === page)?.code ?? [];
    result.set(page, {
      stories: [...found.stories],
      documents: [...found.documents].sort(),
      paths: found.paths.size > 0 ? [...found.paths].slice(0, 5) : code.slice(0, 5),
    });
  }
  return result;
}

/** A page that is behind, and why (what `state.next` shows when its notice could not be written). */
export interface LatePage extends LateReason {
  readonly path: string;
}

/** Where the engine may commit the notices: the branch, and the port that commits. */
export interface NoticeCommitter {
  /** The branch the creator's workflow lets the engine commit on directly, or undefined. */
  readonly branch: string | undefined;
  readonly workspace: Pick<StoryWorkspace, "commitFiles"> | undefined;
}

/** What `syncLateNotices` did: the pages committed, and the pages behind with no notice in them. */
export interface NoticeSync {
  readonly committed: readonly string[];
  readonly pending: readonly LatePage[];
}

/** The commit message of the notices. */
export const NOTICE_COMMIT_MESSAGE = "Documentation: late notices of the knowledge base";

/**
 * Brings the late notice of every page of the base up to date: written on a page
 * that is behind, taken away from one that is not. The working copy is never left dirty: the
 * change is committed by the engine on the branch where the creator's workflow lets it commit
 * directly (a `direct` merge), in a commit of its own; anywhere else nothing is written, and the
 * pages behind come back as `pending`, for `state.next` to tell the agents. Never fails.
 */
export async function syncLateNotices(
  files: WorkspaceFiles,
  committer: NoticeCommitter,
  input: {
    readonly checkpoints: readonly CheckpointState[];
    readonly merges: readonly MergedStoryRef[];
    readonly now: number;
  },
): Promise<NoticeSync> {
  try {
    const documents = await readDocumentFiles(files, true);
    const pages = knowledgePages(documents);
    const reasons = lateReasons(pages, input.checkpoints, input.merges, input.now);
    const texts = new Map(documents.map((file) => [comparablePath(file.path), file]));
    const changes: { path: string; reason: LateReason | undefined }[] = [];
    const pending: LatePage[] = [];
    for (const page of pages) {
      const file = texts.get(comparablePath(page.path));
      if (file === undefined) continue;
      const reason = reasons.get(page.path);
      const next = withLateNotice(file.text, reason, input.now);
      if (next === file.text) continue;
      changes.push({ path: file.path, reason });
      if (reason !== undefined) pending.push({ path: page.path, ...reason });
    }
    if (changes.length === 0) return { committed: [], pending: [] };
    if (committer.branch === undefined || committer.workspace?.commitFiles === undefined) {
      return { committed: [], pending };
    }
    const outcome = await committer.workspace.commitFiles({
      branch: committer.branch,
      files: changes.map((change) => ({
        path: change.path,
        edit: (current: string) => withLateNotice(current, change.reason, input.now),
      })),
      message: NOTICE_COMMIT_MESSAGE,
    });
    return outcome.ok
      ? { committed: changes.map((change) => change.path), pending: [] }
      : { committed: [], pending };
  } catch {
    return { committed: [], pending: [] };
  }
}

/**
 * The branch the engine may commit the notices on directly (the creator's Git settings
 *): the one the stories land on, when the creator's workflow merges without a pull
 * request. With a pull request, the branch is the forge's to merge into: undefined.
 */
export function noticeBranchOf(state: Readonly<Record<string, unknown>>): string | undefined {
  const flow = workflowOf(state).resolved;
  return flow.merge === "direct" ? (flow.integration ?? flow.production) : undefined;
}

/**
 * The late notices of the pages a story puts behind, committed by the engine on `branch` (story
 * 3.41): the branch the story landed on right after a direct merge, or the story's own branch in its
 * worktree when it opens its pull request, so the notice arrives on the main branch with the merge.
 * `story` is not merged yet in the second case: it counts as the next merge, with `files` it
 * changed. Never fails; true when a commit was made.
 */
export async function commitNoticesWithStory(
  context: {
    readonly files: WorkspaceFiles;
    readonly storyWorkspace?: Pick<StoryWorkspace, "commitFiles"> | undefined;
    readonly now?: (() => number) | undefined;
  },
  state: Readonly<Record<string, unknown>>,
  story: {
    readonly id: string;
    /** The files it changed, or how to read them (only asked when a page describes some code). */
    readonly files: readonly string[] | (() => Promise<readonly string[]>);
  },
  branch: string,
): Promise<boolean> {
  try {
    if (typeof story.files === "function") {
      const described = knowledgePages(await readDocumentFiles(context.files, true)).some(
        (page) => (page.code ?? []).length > 0,
      );
      if (!described) return false;
    }
    const changed = typeof story.files === "function" ? await story.files() : story.files;
    const merges = mergedStoriesOf(state).filter((merge) => merge.story !== story.id);
    const seq = merges.reduce((top, merge) => Math.max(top, merge.seq), 0) + 1;
    const now = (context.now ?? Date.now)();
    const done = await syncLateNotices(
      context.files,
      { branch, workspace: context.storyWorkspace },
      {
        checkpoints: Object.values(
          (state.checkpoints as Record<string, CheckpointState> | undefined) ?? {},
        ),
        merges: [
          ...merges,
          { story: story.id, seq, files: changed, at: new Date(now).toISOString() },
        ],
        now,
      },
    );
    return done.committed.length > 0;
  } catch {
    return false;
  }
}
