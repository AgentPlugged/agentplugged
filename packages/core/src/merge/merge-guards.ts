import { gitBlobId } from "@agentplugged/crypto";
import type { StoryHeader } from "@agentplugged/protocol";
import {
  type ConflictKind,
  type ConflictOption,
  type ConflictUnverifiedReason,
  ErrorCode,
  type MergeFailure,
  type ProjectionState,
} from "@agentplugged/protocol";
import { mergeReady } from "../ci/ci-rules.js";
import type { CommandContext } from "../command.js";
import { parseDocumentFile } from "../docs/parse-document.js";
import { AgentPluggedError } from "../errors.js";
import { isSkipped } from "../journey/journey-rules.js";
import type { StoryConflict, StoryState } from "../projection/agent-reducers.js";
import { storiesIn } from "../projection/agent-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { checkpointsOf } from "../projection/checkpoint-reducers.js";
import { openMergeCheckpoint } from "../review/review-rules.js";
import {
  currentSprint,
  type SprintStory,
  sprintsOf,
  storyDoneAt,
} from "../sprints/sprint-rules.js";
import { readSprintStories } from "../sprints/sprint-stories.js";
import { oneLine } from "../stories/pull-request.js";
import { latestApprovedStoryBlob } from "../stories/story-start.js";
import { analyseConflict, checkResolution, keepRuleOf } from "./conflict-rules.js";
import { mergeOrder, mergeWaits, type OrderEntry, type ReadyStory } from "./merge-order.js";
import type { ConflictFileProbe, MergeProbe } from "./merge-probe.js";
import { addedMarkerFiles, storyFiles } from "./story-files.js";

/**
 * The checks of the order of the merges and of the conflicts a merge makes again before the forge
 * is asked: shared by the three channels of the creator's answer through `mergeStory`.
 * Nothing here merges, resolves or reorders: the engine reads Git and the journal, and refuses.
 */

type State = ProjectionState["state"];

/** The details a merge refusal adds to the common ones (`story`, `checkpoint`, `reason`). */
export interface MergeFailureDetails {
  readonly message?: string;
  readonly url?: string;
  readonly before?: string;
  readonly why?: string;
  readonly dependency?: string;
  readonly commit?: string;
  readonly files?: readonly string[];
}

/** `MERGE_FAILED` with the details of the order and the conflicts. */
export function mergeRefused(
  story: string,
  checkpoint: string,
  reason: MergeFailure,
  details: MergeFailureDetails = {},
): AgentPluggedError {
  const { message, files, ...rest } = details;
  return new AgentPluggedError(ErrorCode.MERGE_FAILED, `error.merge_failed.${reason}`, {
    story,
    checkpoint,
    reason,
    ...(message === undefined ? {} : { message: oneLine(message) }),
    ...(files === undefined ? {} : { files: files.slice(0, 10), files_count: files.length }),
    ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)),
  });
}

/** A story ready to merge, with the facts the order and its files need. */
export interface ReadyEntry extends ReadyStory {
  readonly story: StoryState;
}

/**
 * The dependencies of a story as the creator validated them: read in the approved version of its
 * file (the blob a `document` checkpoint approved), never in a working copy an agent may have
 * edited since. A story file that was never approved gives its working copy's header (it cannot
 * have started); one whose approved text cannot be read and differs from the working copy holds
 * the story back (`(unverified)`).
 */
async function approvedDependencies(
  context: CommandContext,
  checkpoints: readonly CheckpointState[],
  entry: SprintStory | undefined,
  now: number,
): Promise<readonly string[]> {
  if (entry === undefined) return [];
  const own = entry.declared_depends_on ?? entry.depends_on;
  const blob = latestApprovedStoryBlob(checkpoints, entry.path, now);
  if (blob === undefined) return own;
  const approved = await context.storyWorkspace?.readBlob(blob).catch(() => undefined);
  if (approved !== undefined) {
    const header = parseDocumentFile(entry.path, approved).header as StoryHeader | undefined;
    return header?.depends_on ?? [];
  }
  return gitBlobId(entry.bytes) === blob ? own : ["(unverified)"];
}

/**
 * The stories ready to merge: started, not merged, with their merge checkpoint open and their merge
 * gate open. `include` is a story the caller knows is ready (the one being merged).
 */
export async function readyStories(
  context: CommandContext,
  state: State,
  include?: string,
): Promise<ReadyEntry[]> {
  const stories = storiesIn(state);
  const checkpoints = Object.values(checkpointsOf(state));
  const files = await readSprintStories(context.files).catch(() => new Map());
  const now = (context.now ?? Date.now)();
  const ready: ReadyEntry[] = [];
  for (const [id, story] of Object.entries(stories)) {
    if (story.started === undefined || story.merged !== undefined) continue;
    const point = openMergeCheckpoint(checkpoints, id);
    if (point === undefined) continue;
    if (id !== include && !mergeReady(state, id)) continue;
    ready.push({
      id,
      opened: point.opened_event,
      depends_on: await approvedDependencies(context, checkpoints, files.get(id), now),
      story,
    });
  }
  return ready;
}

/** The done stories among `ids` (delivered: merged, or approved before the engine merged). */
export function doneStories(state: State, ids: Iterable<string>): Set<string> {
  const stories = storiesIn(state);
  const checkpoints = Object.values(checkpointsOf(state));
  const done = new Set<string>();
  for (const id of ids) {
    const story = Object.hasOwn(stories, id) ? stories[id] : undefined;
    if (storyDoneAt(checkpoints, id, story) !== undefined) done.add(id);
  }
  return done;
}

/** The stories of the sprint in force, in its order. */
export function sprintOrder(context: CommandContext, state: State): string[] {
  const now = (context.now ?? Date.now)();
  return (
    currentSprint(sprintsOf(state), checkpointsOf(state), now)?.stories.map((entry) => entry.id) ??
    []
  );
}

/** The order of the ready stories, and who is ready. */
export async function currentOrder(
  context: CommandContext,
  state: State,
  include?: string,
): Promise<{ ready: ReadyEntry[]; order: OrderEntry[] }> {
  const ready = await readyStories(context, state, include);
  const ids = new Set(ready.flatMap((entry) => [entry.id, ...entry.depends_on]));
  const order = mergeOrder({
    ready,
    done: doneStories(state, ids),
    sprint: sprintOrder(context, state),
  });
  return { ready, order };
}

/** The files each story of `ids` changes, by story; undefined for a story whose diff is unreadable. */
export async function filesByStory(
  context: CommandContext,
  ready: readonly ReadyEntry[],
  ids: readonly string[],
  own: { readonly id: string; readonly commit: string },
): Promise<Map<string, ReadonlySet<string> | undefined>> {
  const result = new Map<string, ReadonlySet<string> | undefined>();
  for (const id of ids) {
    const entry = ready.find((candidate) => candidate.id === id);
    const started = entry?.story.started;
    const commit = id === own.id ? own.commit : entry?.story.pull_request?.head;
    if (started === undefined || commit === undefined) {
      result.set(id, undefined);
      continue;
    }
    const read = await storyFiles(context, started, commit);
    result.set(id, read.known && !read.truncated ? new Set(read.files) : undefined);
  }
  return result;
}

/**
 * The order check of a merge: the story's dependencies that are not delivered nor ready
 * (`dependency_unmerged`), a loop (`dependency_cycle`), then the ready stories that merge first
 * (`out_of_order`: its ready dependencies, and the earlier ones that share a file with it).
 */
export async function orderProblem(
  context: CommandContext,
  state: State,
  story: string,
  checkpoint: string,
  head: string,
): Promise<AgentPluggedError | undefined> {
  // The creator skipped the order of the stories: it is a warning, never a refusal.
  if (isSkipped(state, "story_order", story)) return undefined;
  const { ready, order } = await currentOrder(context, state, story);
  const mine = order.find((entry) => entry.story === story);
  if (mine === undefined) return undefined;
  if (mine.cycle) return mergeRefused(story, checkpoint, "dependency_cycle");
  const dependency = mine.unmerged[0];
  if (dependency !== undefined) {
    return mergeRefused(story, checkpoint, "dependency_unmerged", { dependency });
  }
  const earlier = order.filter((entry) => entry.position > 0 && entry.position < mine.position);
  if (earlier.length === 0) return undefined;
  const files = await filesByStory(
    context,
    ready,
    [story, ...earlier.map((entry) => entry.story)],
    { id: story, commit: head },
  );
  const wait = mergeWaits(order, story, files)[0];
  return wait === undefined
    ? undefined
    : mergeRefused(story, checkpoint, "out_of_order", { before: wait.story, why: wait.why });
}

function unverified(
  story: string,
  checkpoint: string,
  why: ConflictUnverifiedReason,
  details: MergeFailureDetails = {},
): AgentPluggedError {
  return mergeRefused(story, checkpoint, "conflict_unverified", { ...details, why });
}

/**
 * The conflict checks of a merge, from Git and the qualifications of the story's developer:
 * 1. the head still conflicts with the main branch (`conflict`);
 * 2. a conflict marker left in the story's changes (`conflict_markers`);
 * 3. the branch's history: rebased (the base commit is no ancestor of the head), an octopus merge
 *    or unreadable history: nothing to verify, nothing merged (`conflict_unverified`);
 * 4. each merge of the main branch into the story's branch that resolved a conflict must be
 *    covered by a qualification naming that main commit (`conflict_unqualified`), and its
 *    resolution, read at that merge commit, must keep what the declaration promised: both sides
 *    of a textual conflict, the creator's side of one of substance (`conflict_dropped`,
 *    `conflict_markers`, `conflict_unverified` `undecided`).
 * Without a Git port the forge alone judges (`not_mergeable`).
 */
export async function conflictProblem(
  context: CommandContext,
  state: State,
  story: string,
  checkpoint: string,
  head: string,
): Promise<AgentPluggedError | undefined> {
  const probe = context.mergeProbe;
  const entry = storiesIn(state)[story];
  const started = entry?.started;
  if (probe === undefined || entry === undefined || started === undefined) return undefined;
  const failed = (reason: MergeFailure, details?: MergeFailureDetails) =>
    mergeRefused(story, checkpoint, reason, details);
  const main = await probe.resolve(started.base_ref).catch(() => undefined);
  let reads = false;
  if (main !== undefined) {
    const now = await probe.probe(main, head).catch(() => ({ status: "unavailable" as const }));
    if (now.status === "conflict") {
      return failed("conflict", { files: now.files.map((file) => file.path) });
    }
    reads = now.status === "clean";
  }
  const diff = await context.storyDiff
    ?.diff(started.base, head, started.base_ref)
    .catch(() => undefined);
  if (context.storyDiff !== undefined && diff === undefined) {
    return unverified(story, checkpoint, "unreadable");
  }
  const markers = addedMarkerFiles(diff);
  if (markers.length > 0) return failed("conflict_markers", { files: markers });
  // A branch whose history was rewritten (a rebase, a replay of its commits on the main branch's
  // tip) hides the conflicts it settled: every commit already reviewed or checked must still be
  // in it.
  const known = new Set(
    [
      entry.pull_request?.head,
      entry.ci?.commit,
      ...(entry.review?.passes ?? []).map((pass) => pass.commit),
      ...(entry.conflicts ?? []).map((q) => q.head),
    ].filter((commit): commit is string => commit !== undefined && commit !== head),
  );
  for (const commit of [started.base, ...known]) {
    const ancestor = await probe.isAncestor(commit, head).catch(() => undefined);
    if (ancestor === false) return unverified(story, checkpoint, "rebased", { commit });
    if (ancestor === undefined && commit !== started.base) {
      return unverified(story, checkpoint, "unreadable", { commit });
    }
  }
  // Git that cannot merge in memory (older than 2.38) reads no conflict: the forge judges, unless
  // the developer qualified one (nothing could then be verified).
  if (!reads && (entry.conflicts ?? []).length === 0) return undefined;
  const merges = await probe.merges(started.base, head).catch(() => undefined);
  if (merges === undefined) return unverified(story, checkpoint, "unreadable");
  for (const merge of merges) {
    if (merge.parents.length > 2)
      return unverified(story, checkpoint, "octopus", { commit: merge.commit });
    const [own, mainSide] = merge.parents;
    if (own === undefined || mainSide === undefined) continue;
    // A merge made on the forge (the creator resolved a conflict there, updated the
    // branch) is their own gesture, part of the story: nothing to qualify, nothing foreign.
    if ((await probe.madeOnForge?.(merge.commit).catch(() => undefined)) === true) continue;
    // What the branch took in must be the main branch itself, not a commit made on the side.
    if (main !== undefined) {
      const onMain = await probe.isAncestor(mainSide, main).catch(() => undefined);
      if (onMain !== true) {
        return unverified(story, checkpoint, onMain === false ? "foreign" : "unreadable", {
          commit: merge.commit,
        });
      }
    }
    const again = await probe
      .probe(mainSide, own)
      .catch(() => ({ status: "unavailable" as const }));
    if (again.status === "unavailable") {
      return unverified(story, checkpoint, "unreadable", { commit: merge.commit });
    }
    if (again.status === "clean") {
      // A merge that settled nothing is the tree Git makes by itself: another one holds changes
      // of its author's (`-s ours` and the like).
      const [expected, actual] = await Promise.all([
        probe.mergedTree(mainSide, own).catch(() => undefined),
        probe.treeOf(merge.commit).catch(() => undefined),
      ]);
      if (expected === undefined || actual === undefined) {
        return unverified(story, checkpoint, "unreadable", { commit: merge.commit });
      }
      if (expected !== actual) {
        return unverified(story, checkpoint, "diverged", { commit: merge.commit });
      }
      continue;
    }
    const covering = await coveringOf(probe, entry.conflicts ?? [], mainSide);
    if (covering === undefined) {
      return failed("conflict_unqualified", {
        commit: merge.commit,
        files: again.files.map((file) => file.path),
      });
    }
    // The qualification covers this merge only for what it named: the conflict this merge
    // settled is read again; a textual one must still be text, and every file must have been
    // named (the creator never saw another one).
    const named = new Set(covering.files.map((file) => file.path));
    const unnamed = covering.files_truncated || again.files.some((file) => !named.has(file.path));
    if (unnamed || (covering.kind === "textual" && analyseConflict(again).ceiling !== "textual")) {
      return failed("conflict_unqualified", {
        commit: merge.commit,
        files: again.files.map((file) => file.path),
      });
    }
    const refused = await resolutionProblem(
      probe,
      state,
      story,
      checkpoint,
      covering,
      again.files,
      merge.commit,
      head,
    );
    if (refused !== undefined) return refused;
  }
  return undefined;
}

/**
 * The qualification that covers a merge of the main branch `mainSide` into the story's branch: one
 * read on that commit or on one it contains (the main branch moved on since), the most demanding
 * first: a conflict of substance (its latest) before a textual one, so that a textual declaration
 * never replaces what the creator was asked.
 */
async function coveringOf(
  probe: MergeProbe,
  conflicts: readonly StoryConflict[],
  mainSide: string,
): Promise<StoryConflict | undefined> {
  const candidates: StoryConflict[] = [];
  for (const q of conflicts) {
    if (
      q.main === mainSide ||
      (await probe.isAncestor(q.main, mainSide).catch(() => undefined)) === true
    ) {
      candidates.push(q);
    }
  }
  return candidates.reverse().find((q) => q.kind === "substantive") ?? candidates[0];
}

/**
 * Reads the resolution a merge commit made of the conflict a qualification named, and checks it
 * kept what the qualification promised (at that merge commit, or at the branch's head).
 */
async function resolutionProblem(
  probe: MergeProbe,
  state: State,
  story: string,
  checkpoint: string,
  conflict: StoryConflict,
  settled: readonly ConflictFileProbe[],
  resolution: string,
  head: string,
): Promise<AgentPluggedError | undefined> {
  let option: ConflictOption | undefined;
  if (conflict.kind === "substantive") {
    const decision =
      conflict.checkpoint === null ? undefined : checkpointsOf(state)[conflict.checkpoint];
    const answer = decision?.resolution;
    if (answer?.decision !== "option_chosen") return unverified(story, checkpoint, "undecided");
    option = answer.option as ConflictOption;
  }
  const kind: ConflictKind = conflict.kind;
  const keep = keepRuleOf(kind, option);
  // The resolution is read at the merge commit that made it; a later commit of the branch that
  // repaired a loss (or edited the lines on purpose) is read too: either one holding what was
  // promised is enough.
  const check = async (commit: string) => {
    const resolved = new Map<string, string | undefined>();
    for (const file of settled) {
      resolved.set(file.path, await probe.show(commit, file.path).catch(() => undefined));
    }
    return checkResolution({ files: settled, keep, resolved });
  };
  const atMerge = await check(resolution);
  if (atMerge.ok) return undefined;
  if ((await check(head)).ok) return undefined;
  return mergeRefused(
    story,
    checkpoint,
    atMerge.why === "markers" ? "conflict_markers" : "conflict_dropped",
    { files: atMerge.files, commit: resolution },
  );
}

/** The order and conflict checks of a merge, in this order; undefined when the merge may go on. */
export async function coherenceProblem(
  context: CommandContext,
  state: State,
  story: string,
  checkpoint: string,
  head: string,
): Promise<AgentPluggedError | undefined> {
  return (
    (await orderProblem(context, state, story, checkpoint, head)) ??
    (await conflictProblem(context, state, story, checkpoint, head))
  );
}
