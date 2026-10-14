import { z } from "zod";
import { StoryIdSchema } from "./agent-activity.js";
import { CheckpointIdSchema } from "./checkpoint.js";
import { GitBranchSchema } from "./git-workflow.js";
import { CommitIdSchema, FORGE_IDS, PullRequestUrlSchema } from "./story.js";

/**
 * The merge of a story. Once the creator approves a story's merge checkpoint
 * (`source: merge`), in the chat with one answer (a merge is undone by a
 * `git revert`, so it asks no confirmation), in the AI
 * tool's form, or at the terminal (the `strict` level's way), the
 * engine merges the story's pull request with the forge's tool the creator logged in, then writes
 * the answer and `story.merged` in one write, then removes the story's worktree. An agent never
 * merges: no tool merges without the creator's accepted answer.
 */

/** Event types of a story's merge, each at version 1. */
export const MERGE_EVENT_TYPES = {
  merged: "story.merged",
} as const;

/** How the forge merges: a merge commit (the default), squashed, or rebased. */
export const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];
export const DEFAULT_MERGE_METHOD: MergeMethod = "merge";

/**
 * The channel of the approval the merge follows: the chat, the AI tool's form, the terminal. Story
 * 3.28: `forge`, a merge the creator did on the forge itself (the pull request merged by hand),
 * which the engine recorded from what the forge shows: no approval to wait for, the forge's own
 * event is the proof (who merged it, when, on which commit). `agent`, the merge the
 * agent responsible decided because the creator did not keep the merges for themselves.
 */
export const MERGE_SOURCES = ["chat", "elicitation", "terminal", "forge", "agent"] as const;
export type MergeSource = (typeof MERGE_SOURCES)[number];

/** Most changed files one merge records (the knowledge base reads them). */
export const MAX_MERGED_FILES = 1000;

/** A path of the repository, relative to its top, with `/`, on one line: 1 to 500 characters. */
export const RepositoryPathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (path) =>
      ![...path].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f) &&
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.split("/").includes(".."),
    { message: "expected a path relative to the repository, with /" },
  );

/** The weight of a merged story's code. */
export const StoryWeightSchema = z.strictObject({
  added: z.number().int().min(0).max(100_000_000),
  removed: z.number().int().min(0).max(100_000_000),
  duplicates: z.number().int().min(0).max(100_000).optional(),
});
export type StoryWeightPayload = z.infer<typeof StoryWeightSchema>;

/** `payload` of `story.merged` (its story is the envelope's). */
export const StoryMergedPayloadSchema = z
  .strictObject({
    /**
     * The merge checkpoint the creator approved, in the same write. A merge recorded from the forge
     * (`source: forge`) has no approval: it names the merge checkpoint that was open, if any.
     */
    checkpoint: CheckpointIdSchema.optional(),
    /** The pull request's forge, number and address: absent for a merge the engine did itself (`direct`). */
    forge: z.enum(FORGE_IDS).optional(),
    pr: z.number().int().min(1).max(1_000_000_000).optional(),
    url: PullRequestUrlSchema.optional(),
    /**
     * The story reached its branch without a pull request, the creator having chosen
     * it (a merge by the engine, or work done on the integration branch itself). `into` is that
     * branch.
     */
    direct: z.literal(true).optional(),
    into: GitBranchSchema.optional(),
    /** The head merged: the commit reviewed and checked by the CI. */
    commit: CommitIdSchema,
    /** The commit the merge created on the main branch, when the forge gives it. */
    merge_commit: CommitIdSchema.optional(),
    method: z.enum(MERGE_METHODS),
    /** The files the story changed, relative to the repository (the knowledge base reads them). */
    files: z.array(RepositoryPathSchema).max(MAX_MERGED_FILES),
    /** More files changed than `files` holds. */
    files_truncated: z.literal(true).optional(),
    /**
     * The weight of the story's code, from its diff: lines of code added and removed
     * (tests, documents and lockfiles apart) and the duplicates the engine found in what it added.
     * Absent when the engine could not read the diff.
     */
    weight: StoryWeightSchema.optional(),
    source: z.enum(MERGE_SOURCES),
    /**
     * The forge had already merged it on the commit reviewed (a retry after a write refused, or a
     * merge done by hand): recorded without merging again.
     */
    already: z.literal(true).optional(),
    /** `forge` only: the account that merged the pull request on the forge. */
    merged_by: z.string().trim().min(1).max(200).optional(),
    /** `forge` only: when the forge says it was merged. */
    merged_at: z.iso.datetime().optional(),
  })
  .refine((payload) => new Set(payload.files).size === payload.files.length, {
    message: "each file once",
    path: ["files"],
  })
  .refine(
    (payload) =>
      payload.direct === true
        ? payload.forge === undefined && payload.pr === undefined && payload.url === undefined
        : payload.forge !== undefined &&
          payload.pr !== undefined &&
          payload.url !== undefined &&
          payload.into === undefined,
    {
      message:
        "a merge through a pull request names its forge, number and address; a direct one names none and the branch it reached",
      path: ["direct"],
    },
  )
  .refine(
    (payload) =>
      payload.source === "forge"
        ? payload.merged_by !== undefined && payload.merged_at !== undefined
        : payload.checkpoint !== undefined &&
          payload.merged_by === undefined &&
          payload.merged_at === undefined,
    {
      message:
        "a merge recorded from the forge says who merged it and when; any other names its approved checkpoint",
      path: ["source"],
    },
  );
export type StoryMergedPayload = z.infer<typeof StoryMergedPayloadSchema>;

/**
 * Why the engine could not merge (`MERGE_FAILED`): no pull request recorded, closed without a
 * merge, on another commit than the one reviewed at the forge, refused by the forge (a conflict,
 * a protected branch, a review the forge requires), the tool failed, merged but the write was
 * refused (call again: the merge is then recorded), the head of the story's branch could not be
 * read here (the gate needs it), or a method the forge's API cannot ask for (`rebase` on GitLab,
 * whose project settings decide it).
 */
export const MERGE_FAILURES = [
  "no_pull_request",
  "pull_request_closed",
  "head_moved",
  "not_mergeable",
  "forge_failed",
  "not_recorded",
  "head_unreadable",
  "method_unsupported",
  "other_repository",
  // The order of the merges and the conflicts with the main branch.
  "out_of_order",
  "dependency_unmerged",
  "dependency_cycle",
  "conflict",
  "conflict_dropped",
  "conflict_markers",
  "conflict_unqualified",
  "conflict_unverified",
  // A merge the engine does itself, the creator having chosen no pull request. The
  // branch to merge into is not here (`base_missing`), is checked out with changes not committed
  // (`base_dirty`), the two histories conflict (`direct_conflict`), or Git refused (`direct_failed`).
  "base_missing",
  "base_dirty",
  "direct_conflict",
  "direct_failed",
  // The pull request merges into another branch than the one the creator's workflow names now (the
  // workflow changed since it was opened): it is updated first (`open_pull_request`).
  "base_changed",
] as const;
export type MergeFailure = (typeof MERGE_FAILURES)[number];

/** What becomes of the story's worktree after its merge. */
export const WORKTREE_OUTCOMES = ["removed", "absent", "kept"] as const;
export type WorktreeOutcome = (typeof WORKTREE_OUTCOMES)[number];

/**
 * Why a worktree was kept: changes not committed (`dirty`), its branch checked out in another
 * folder than the story's own (`other_folder`: never removed, it may be the creator's), the
 * engine runs inside it (`in_use`), Git failed, or no Git here to remove it (`unavailable`).
 */
export const WORKTREE_KEPT_REASONS = [
  "dirty",
  "other_folder",
  "in_use",
  "failed",
  "unavailable",
] as const;
export type WorktreeKeptReason = (typeof WORKTREE_KEPT_REASONS)[number];

/** The header field of a page of the knowledge base that names the code it describes. */
export const KNOWLEDGE_CODE_FIELD = "code";
/** The header field of a page that names the last merged story it took in. */
export const KNOWLEDGE_STORY_FIELD = "last_story";

/**
 * One entry of `code` of a page of the knowledge base: a path of the repository the
 * page describes; one that ends with `/` is a folder.
 */
export const KnowledgeCodeSchema = RepositoryPathSchema;

/** `last_story` of a page of the knowledge base: the last merged story it took in. */
export const KnowledgeStorySchema = StoryIdSchema;
