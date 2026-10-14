import {
  CHECKPOINT_EVENT_TYPES,
  CONFLICT_OPTIONS,
  type ConflictFile,
  type ConflictKind,
  ErrorCode,
  GetMergeOrderInputSchema,
  MERGE_ORDER_EVENT_TYPES,
  type MergeConflictReason,
  type MergeWaitReason,
  type ProjectionState,
  QualifyMergeConflictInputSchema,
} from "@agentplugged/protocol";
import {
  agentEventCommand,
  agentWriteContext,
  defined,
  invalidInput,
  type RecordedEvent,
} from "../agent-activity/agent-commands.js";
import { checkpointPayload, truncate } from "../checkpoints/checkpoint-rules.js";
import { branchHead } from "../ci/ci-check.js";
import { type CommandContext, defineCommand, fail, ok } from "../command.js";
import { currentState } from "../deferred/deferred-commands.js";
import { AgentPluggedError } from "../errors.js";
import type { StoryState } from "../projection/agent-reducers.js";
import { storyIn } from "../projection/agent-reducers.js";
import { checkpointsOf } from "../projection/checkpoint-reducers.js";
import { type OpenConflict, openConflict } from "../projection/merge-order-reducers.js";
import { isStoryDeveloper } from "../review/review-rules.js";
import { storyDoneAt } from "../sprints/sprint-rules.js";
import {
  analyseConflict,
  CONFLICT_OPTION_TEXT,
  type ConflictAnalysis,
  conflictSummary,
  forcedFiles,
} from "./conflict-rules.js";
import { currentOrder, filesByStory } from "./merge-guards.js";
import { type MergeWait, mergeWaits } from "./merge-order.js";
import type { ConflictProbe } from "./merge-probe.js";

/**
 * The two tools of the order of the merges and the conflicts: `get_merge_order` reads
 * the queue the engine computed; `qualify_merge_conflict` records what the story's developer
 * declares of a conflict with the main branch, bounded by what the engine read of it, and opens
 * the creator's `decision` when the conflict is of substance. Neither merges, orders or resolves.
 */

const NO_COMMIT = "0".repeat(40);

/** `MERGE_CONFLICT`: nothing written. */
export function mergeConflictRefused(
  story: string,
  reason: MergeConflictReason,
  details: Readonly<Record<string, unknown>> = {},
): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.MERGE_CONFLICT, `error.merge_conflict.${reason}`, {
    story,
    reason,
    ...details,
  });
}

/** What `qualify_merge_conflict` read of Git before the write. */
interface QualifyReading {
  /** The branch's head now. */
  readonly current: string | undefined;
  /** The pair the conflict is between: the main branch's commit and the story's side. */
  readonly main: string | undefined;
  readonly head: string | undefined;
  readonly probe: ConflictProbe;
  readonly analysis: ConflictAnalysis | undefined;
  /** The conflict's blocks, kept for the summary of a conflict of substance. */
  readonly files: Extract<ConflictProbe, { status: "conflict" }>["files"];
  /** The merge commit that already resolved this conflict without it being qualified, if any. */
  readonly resolved_by?: string;
}

/**
 * Reads what merging the story's head into the main branch conflicts on, without writing. When the
 * branch merges cleanly because its developer already merged the main branch in and resolved a
 * conflict nobody qualified, that conflict is read from the merge commit's parents: it is qualified
 * after the fact, and the engine then verifies the resolution it finds.
 */
async function readConflict(
  context: CommandContext,
  id: string,
  story: StoryState | undefined,
): Promise<QualifyReading> {
  const unavailable: QualifyReading = {
    current: undefined,
    main: undefined,
    head: undefined,
    probe: { status: "unavailable" },
    analysis: undefined,
    files: [],
  };
  const started = story?.started;
  if (started === undefined) return unavailable;
  const current =
    context.storyWorkspace === undefined
      ? undefined
      : await branchHead(context.storyWorkspace, id, started.branch)
          .then((value) => (typeof value === "string" ? value : undefined))
          .catch(() => undefined);
  const probe = context.mergeProbe;
  if (current === undefined || probe === undefined) return { ...unavailable, current };
  const main = await probe.resolve(started.base_ref).catch(() => undefined);
  if (main === undefined) return { ...unavailable, current };
  const read = await probe.probe(main, current).catch(() => ({ status: "unavailable" as const }));
  if (read.status === "conflict") {
    return {
      current,
      main,
      head: current,
      probe: read,
      analysis: analyseConflict(read),
      files: read.files,
    };
  }
  if (read.status === "clean") {
    const qualified = new Set((story?.conflicts ?? []).map((entry) => entry.main));
    const merges = await probe.merges(started.base, current).catch(() => undefined);
    for (const merge of merges ?? []) {
      const [own, side] = merge.parents;
      if (merge.parents.length !== 2 || own === undefined || side === undefined) continue;
      if (qualified.has(side)) continue;
      const earlier = await probe
        .probe(side, own)
        .catch(() => ({ status: "unavailable" as const }));
      if (earlier.status !== "conflict") continue;
      return {
        current,
        main: side,
        head: own,
        probe: earlier,
        analysis: analyseConflict(earlier),
        files: earlier.files,
        resolved_by: merge.commit,
      };
    }
  }
  return { current, main, head: current, probe: read, analysis: undefined, files: [] };
}

const qualify = agentEventCommand<typeof QualifyMergeConflictInputSchema, QualifyReading>({
  name: "qualify_merge_conflict",
  description:
    "Qualify a conflict between your story's branch and the main branch BEFORE you resolve it: you are the story's developer. `kind`: `textual` (the two sides only add lines at the same place, or differ by spaces: keep both) or `substantive` (the two sides change the same logic: the creator chooses). The engine reads the conflict itself (Git, nothing written) and fixes a ceiling you may keep or raise, never lower: both sides on the same lines, a large addition, a deleted, renamed or binary file is `substantive` whatever you say (MERGE_CONFLICT forced_substantive), and at most 10 blocks in all may be textual. A conflict you cannot prove textual, you declare `substantive` (MERGE_CONFLICT unprovable). `rationale`: why, in your words (at most 600 characters). For `substantive`, give your `recommendation` (`keep_story`, `keep_main` or `combine`): the engine opens a `decision` checkpoint with both versions of each block (sensitive lines never shown) and your recommendation, which blocks the story's return to review; the creator chooses. Either way the story goes back to in_progress, to you. THEN resolve it on your story's branch by merging the main branch into it (`git merge <main branch>`), never by `git rebase` nor by rewriting the history: for a textual conflict keep every line of both sides; for a conflict of substance apply the creator's option (`keep_story`: the story's lines where the versions differ; `keep_main`: the main branch's; `combine`: both). Commit, push, update the pull request (open_pull_request), and send the story to review again: the CI and the review must cover the new commit. At the merge the engine reads the branch again and refuses (MERGE_FAILED conflict_unqualified, conflict_dropped, conflict_markers, conflict_unverified) a resolution it cannot match to a qualification, that lost a line it promised to keep, or that left a conflict marker. Refused with MERGE_CONFLICT, nothing written: a `reason` says why.",
  inputSchema: QualifyMergeConflictInputSchema,
  needsState: () => true,
  prepare: async ({ story: id }, context) => {
    const state = await currentState(context);
    return readConflict(context, id, storyIn(state, id));
  },
  events: ({ story, kind, rationale, recommendation }, state, prepared) => {
    const entry = state === undefined ? undefined : storyIn(state, story);
    const started = entry?.started;
    const files: ConflictFile[] = [...(prepared?.analysis?.files ?? [])];
    const payload = defined({
      main: prepared?.main ?? NO_COMMIT,
      head: prepared?.head ?? NO_COMMIT,
      base_ref: started?.base_ref ?? "main",
      kind,
      files,
      files_truncated: prepared?.analysis?.files_truncated === true ? true : undefined,
      rationale,
      recommendation,
    });
    if (kind === "textual" || recommendation === undefined) {
      return { events: [{ type: MERGE_ORDER_EVENT_TYPES.conflictQualified, story, payload }] };
    }
    const refused =
      entry === undefined || state === undefined
        ? undefined
        : openConflict(entry, checkpointsOf(state));
    const refusedDecision =
      refused?.phase === "refused" ? (refused.conflict.checkpoint ?? undefined) : undefined;
    return {
      own: 1,
      events: [
        {
          type: CHECKPOINT_EVENT_TYPES.opened,
          story,
          payload: {
            ...checkpointPayload({
              type: "decision",
              risk: "medium",
              title: truncate(`Conflict on story ${story}: which version?`, 120),
              summary: conflictSummary({
                story,
                main: prepared?.main ?? NO_COMMIT,
                head: prepared?.head ?? NO_COMMIT,
                rationale,
                recommendation,
                files: (prepared?.files ?? []).map((file, index) => ({
                  path: file.path,
                  class: prepared?.analysis?.files[index]?.class ?? "structural",
                  hunks: file.hunks,
                })),
                files_truncated: prepared?.analysis?.files_truncated === true,
              }),
              options: CONFLICT_OPTIONS.map((id) => ({ id, ...CONFLICT_OPTION_TEXT[id] })),
              recommendation,
              blocks: [{ action: "story.review", story }],
              ...(refusedDecision === undefined ? {} : { supersedes: refusedDecision }),
            }),
            source: "merge_conflict" as const,
          },
        },
        {
          type: MERGE_ORDER_EVENT_TYPES.conflictQualified,
          story,
          payload,
          checkpointField: "checkpoint",
        },
      ],
    };
  },
  check: ({ agent, story: id, kind }, state, { prepared }) => {
    const story = storyIn(state, id);
    if (story === undefined) return mergeConflictRefused(id, "unknown_story");
    if (story.started === undefined) return mergeConflictRefused(id, "not_started");
    const checkpoints = checkpointsOf(state);
    if (
      story.merged !== undefined ||
      storyDoneAt(Object.values(checkpoints), id, story) !== undefined
    ) {
      return mergeConflictRefused(id, "done");
    }
    if (!isStoryDeveloper(story, agent)) {
      return mergeConflictRefused(id, "not_developer", {
        agent,
        developer: story.started.agent,
      });
    }
    const open = openConflict(story, checkpoints);
    // A decision the creator refused is asked again as a conflict of substance: its answer then
    // lifts the block of the first one too. Anything else still waits.
    if (open !== undefined && (open.phase !== "refused" || kind === "textual")) {
      return mergeConflictRefused(id, "already_open", {
        phase: open.phase,
        ...(open.conflict.checkpoint === null ? {} : { checkpoint: open.conflict.checkpoint }),
      });
    }
    if (prepared?.current === undefined) {
      return mergeConflictRefused(id, "branch_missing", { branch: story.started.branch });
    }
    if (prepared.probe.status === "clean") return mergeConflictRefused(id, "no_conflict");
    if (prepared.probe.status === "unavailable") {
      return kind === "textual" ? mergeConflictRefused(id, "unprovable") : undefined;
    }
    if (kind === "textual" && prepared.analysis?.ceiling !== "textual") {
      const forced = prepared.analysis === undefined ? [] : forcedFiles(prepared.analysis);
      return mergeConflictRefused(id, "forced_substantive", {
        files: forced.slice(0, 10).map((file) => `${file.path} (${file.class})`),
        files_count: forced.length,
        truncated: prepared.analysis?.files_truncated === true,
      });
    }
    return undefined;
  },
});

/** What `qualify_merge_conflict` returns: the event, the kind, the files, the checkpoint. */
export interface ConflictQualified extends RecordedEvent {
  readonly story: string;
  readonly kind: ConflictKind;
  readonly files: readonly ConflictFile[];
}

export const qualifyMergeConflictCommand = defineCommand<ConflictQualified>({
  ...qualify,
  async run(context, input) {
    const result = await qualify.run(context, input);
    if (!result.ok) return result;
    const parsed = QualifyMergeConflictInputSchema.parse(input);
    const conflict = storyIn(await currentState(context), parsed.story)?.conflicts?.at(-1);
    return ok({
      ...result.value,
      story: parsed.story,
      kind: parsed.kind,
      files: (conflict?.files ?? []) as ConflictFile[],
    });
  },
});

/** One story of the queue as `get_merge_order` shows it. */
export interface MergeQueueEntry {
  readonly story: string;
  /** 1-based; 0 for a story in a dependency cycle. */
  readonly position: number;
  /** How many files it changes, or null when Git cannot read them here. */
  readonly files: number | null;
  /** The stories that merge first, and why. */
  readonly waits_for: readonly MergeWait[];
  /** Why it cannot merge before anything else is done, or null. */
  readonly blocked: "dependency_unmerged" | "dependency_cycle" | null;
  readonly dependency: string | null;
  /** What merging its head into the main branch would conflict on, as the engine reads it. */
  readonly conflict: {
    readonly status: "clean" | "conflict" | "unknown";
    readonly ceiling: ConflictKind | null;
    readonly files: readonly ConflictFile[];
  };
}

/** A conflict a story's developer qualified that is still open. */
export interface OpenConflictEntry {
  readonly story: string;
  readonly phase: OpenConflict["phase"];
  readonly kind: ConflictKind;
  readonly checkpoint: string | null;
  readonly option: string | null;
  readonly files: readonly ConflictFile[];
}

/** What `get_merge_order` gives. */
export interface MergeOrderRead {
  readonly queue: readonly MergeQueueEntry[];
  readonly open_conflicts: readonly OpenConflictEntry[];
}

function waitReason(reason: MergeWaitReason): MergeWaitReason {
  return reason;
}

async function readQueue(
  context: CommandContext,
  state: ProjectionState["state"],
  only: string | undefined,
): Promise<MergeOrderRead> {
  const { ready, order } = await currentOrder(context, state);
  const files = await filesByStory(
    context,
    ready,
    order.map((entry) => entry.story),
    { id: "", commit: "" },
  );
  const queue: MergeQueueEntry[] = [];
  for (const entry of order) {
    if (only !== undefined && entry.story !== only) continue;
    const story = ready.find((candidate) => candidate.id === entry.story)?.story;
    const mine = files.get(entry.story);
    const reading = await readConflict(context, entry.story, story);
    const status =
      reading.probe.status === "unavailable"
        ? "unknown"
        : reading.probe.status === "clean"
          ? "clean"
          : "conflict";
    queue.push({
      story: entry.story,
      position: entry.position,
      files: mine === undefined ? null : mine.size,
      waits_for: mergeWaits(order, entry.story, files).map((wait) => ({
        story: wait.story,
        why: waitReason(wait.why),
      })),
      blocked: entry.cycle
        ? "dependency_cycle"
        : entry.unmerged.length > 0
          ? "dependency_unmerged"
          : null,
      dependency: entry.unmerged[0] ?? null,
      conflict: {
        status,
        ceiling: reading.analysis?.ceiling ?? null,
        files: reading.analysis?.files ?? [],
      },
    });
  }
  const checkpoints = checkpointsOf(state);
  const open: OpenConflictEntry[] = [];
  for (const [id, story] of Object.entries((state.stories as Record<string, StoryState>) ?? {})) {
    if (only !== undefined && id !== only) continue;
    const found = openConflict(story, checkpoints);
    if (found === undefined) continue;
    open.push({
      story: id,
      phase: found.phase,
      kind: found.conflict.kind,
      checkpoint: found.conflict.checkpoint,
      option: found.option,
      files: found.conflict.files as ConflictFile[],
    });
  }
  return { queue, open_conflicts: open };
}

export const getMergeOrderCommand = defineCommand<MergeOrderRead>({
  name: "get_merge_order",
  audience: "agent",
  description:
    "Read the order in which the stories ready to merge will merge, as the engine computed it: the dependency graph of the stories first (a story merges after its dependencies), then the sprint in force, then the opening of the merge checkpoint, then the story's number. Each story of the `queue` has its `position`, the number of files it changes, `waits_for` (the stories that merge before it: `dependency`, or `overlap` when they share a file), `blocked` (`dependency_unmerged` with its `dependency`, or `dependency_cycle`) and what merging it into the main branch would conflict on (`conflict`: `clean`, `conflict` with the files and their class, or `unknown` when Git cannot read it here, and the `ceiling`: `textual` when its developer may qualify it so, `substantive` when only the creator may settle it). `open_conflicts` lists the conflicts a developer qualified that are still open. Give `story` to read one story. You read; you never order, merge or resolve: the engine refuses a merge out of order, and the order changes only with the stories' dependencies or the sprint, which the creator validates. Present the queue to the creator and hand a story in conflict to its developer, who calls qualify_merge_conflict.",
  inputSchema: GetMergeOrderInputSchema,
  async run(context, input) {
    const parsed = GetMergeOrderInputSchema.safeParse(input);
    if (!parsed.success) return fail(invalidInput("get_merge_order", parsed.error));
    try {
      const target = await agentWriteContext(context, parsed.data.agent);
      if (target instanceof AgentPluggedError) return fail(target);
      return ok(await readQueue(context, await currentState(context), parsed.data.story));
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    }
  },
});

/** The tools of the order of the merges and the conflicts, exposed as MCP tools. */
export const mergeOrderAgentCommands = [getMergeOrderCommand, qualifyMergeConflictCommand] as const;
