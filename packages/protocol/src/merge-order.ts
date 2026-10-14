import { z } from "zod";
import { StoryIdSchema } from "./agent-activity.js";
import { BranchNameSchema, CheckpointIdSchema } from "./checkpoint.js";
import { RepositoryPathSchema } from "./merge.js";
import { AgentIdSchema } from "./method-config.js";
import { CommitIdSchema } from "./story.js";

/**
 * The order of the merges and the conflicts with the main branch. The engine
 * computes the order from the stories' dependency graph, then the sprint in force; it refuses a
 * merge out of order. A conflict with the main branch is qualified by the story's developer
 * before it is resolved on the story's branch: the engine reads the conflict itself and fixes a
 * ceiling the agent can keep or raise, never lower; a conflict of substance opens a `decision`
 * checkpoint with both versions and the agent's recommendation, which the creator settles. An
 * agent never merges, never orders, never rebases.
 */

/** Event types of the order of the merges, each at version 1. */
export const MERGE_ORDER_EVENT_TYPES = {
  /** The story's developer qualified a conflict of the story's branch with the main branch. */
  conflictQualified: "story.conflict_qualified",
  /** The merge checkpoint left open was refreshed for a story reviewed again on a new commit. */
  mergeRefreshed: "story.merge_refreshed",
} as const;

/** What the developer declares: a textual conflict (kept both sides), or one of substance. */
export const CONFLICT_KINDS = ["textual", "substantive"] as const;
export type ConflictKind = (typeof CONFLICT_KINDS)[number];

/**
 * What the engine reads of a conflicted file, from the lightest to the heaviest: `whitespace`
 * (both sides are the same code up to spaces and blank lines), `additions` (both sides add lines
 * at the same place), `both_modified` (both sides change the same lines), `large` (too much to be
 * textual), `structural` (no readable markers: a deletion, a rename, a binary file).
 */
export const CONFLICT_CLASSES = [
  "whitespace",
  "additions",
  "both_modified",
  "large",
  "structural",
] as const;
export type ConflictClass = (typeof CONFLICT_CLASSES)[number];

/** The classes that force a conflict of substance: no agent may call them textual. */
export const SUBSTANTIVE_CLASSES: ReadonlySet<ConflictClass> = new Set([
  "both_modified",
  "large",
  "structural",
]);

/** Most useful lines one side of a block may add and still be a textual addition. */
export const MAX_TEXTUAL_ADDITION_LINES = 20;
/** Most conflicting blocks of a conflict that can be textual, in all. */
export const MAX_TEXTUAL_HUNKS = 10;
/** Most blocks of a file before it is `large`. */
export const MAX_FILE_HUNKS = 10;
/** Most files a qualification records. */
export const MAX_CONFLICT_FILES = 100;

/** The answers of the creator to a conflict of substance (the options of its `decision`). */
export const CONFLICT_OPTIONS = ["keep_story", "keep_main", "combine"] as const;
export type ConflictOption = (typeof CONFLICT_OPTIONS)[number];

/** The checkpoint is not written by an agent: its id is filled by the journal. */
const ConflictFileSchema = z.strictObject({
  path: RepositoryPathSchema,
  class: z.enum(CONFLICT_CLASSES),
});
export type ConflictFile = z.infer<typeof ConflictFileSchema>;

const rationale = z.string().trim().min(1).max(600);

/** `payload` of `story.conflict_qualified` (its story is the envelope's). */
export const StoryConflictQualifiedPayloadSchema = z
  .strictObject({
    /** The main branch's commit read (`base_ref`'s tip). */
    main: CommitIdSchema,
    /** The head of the story's branch when it was read. */
    head: CommitIdSchema,
    base_ref: BranchNameSchema,
    kind: z.enum(CONFLICT_KINDS),
    files: z.array(ConflictFileSchema).max(MAX_CONFLICT_FILES),
    files_truncated: z.literal(true).optional(),
    rationale,
    /** The agent's recommendation, for a conflict of substance. */
    recommendation: z.enum(CONFLICT_OPTIONS).optional(),
    /** The `decision` checkpoint opened just before, for a conflict of substance. */
    checkpoint: CheckpointIdSchema.optional(),
  })
  .superRefine((value, context) => {
    const substantive = value.kind === "substantive";
    if (substantive !== (value.recommendation !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["recommendation"],
        message: "a recommendation goes with a conflict of substance, and only with it",
      });
    }
    if (substantive !== (value.checkpoint !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["checkpoint"],
        message: "a decision checkpoint goes with a conflict of substance, and only with it",
      });
    }
    if (!substantive) {
      if (value.files.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["files"],
          message: "a textual conflict names at least a file",
        });
      }
      value.files.forEach((file, index) => {
        if (!SUBSTANTIVE_CLASSES.has(file.class)) return;
        context.addIssue({
          code: "custom",
          path: ["files", index, "class"],
          message: "a conflict that is more than text cannot be called textual",
        });
      });
    }
    if (new Set(value.files.map((file) => file.path)).size !== value.files.length) {
      context.addIssue({ code: "custom", path: ["files"], message: "each file once" });
    }
  });
export type StoryConflictQualifiedPayload = z.infer<typeof StoryConflictQualifiedPayloadSchema>;

/** `payload` of `story.merge_refreshed` (its story is the envelope's). */
export const StoryMergeRefreshedPayloadSchema = z.strictObject({
  /** The story's merge checkpoint, still open. */
  checkpoint: CheckpointIdSchema,
  /** The review pass that closed on the new commit. */
  pass: z.number().int().min(1).max(1000),
  /** The head reviewed. */
  commit: CommitIdSchema,
  /** The checkpoint's new summary, as the engine composed it. */
  summary: z.string().trim().min(1).max(2000),
  /** The walk through the change inside that summary, as the engine composed it. */
  walkthrough: z
    .string()
    .trim()
    .min(1)
    .max(900)
    .regex(/^[^\p{Cc}]+$/u, { message: "expected one line, without control characters" })
    .optional(),
});
export type StoryMergeRefreshedPayload = z.infer<typeof StoryMergeRefreshedPayloadSchema>;

/** Input of `qualify_merge_conflict`. */
export const QualifyMergeConflictInputSchema = z
  .strictObject({
    agent: AgentIdSchema.max(64),
    story: StoryIdSchema,
    kind: z.enum(CONFLICT_KINDS),
    rationale,
    recommendation: z.enum(CONFLICT_OPTIONS).optional(),
  })
  .superRefine((value, context) => {
    if ((value.kind === "substantive") !== (value.recommendation !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["recommendation"],
        message: "give your recommendation for a conflict of substance, and only for it",
      });
    }
  });
export type QualifyMergeConflictInput = z.infer<typeof QualifyMergeConflictInputSchema>;

/** Input of `get_merge_order`. */
export const GetMergeOrderInputSchema = z.strictObject({
  agent: AgentIdSchema.max(64),
  story: StoryIdSchema.optional(),
});
export type GetMergeOrderInput = z.infer<typeof GetMergeOrderInputSchema>;

/**
 * Why a conflict cannot be qualified (`MERGE_CONFLICT`), nothing written: the story is unknown, not
 * started or done, the caller is not its developer, the branch's head cannot be read, the branch
 * merges cleanly (`no_conflict`), a textual conflict is asked above the engine's ceiling
 * (`forced_substantive`), the engine cannot read the conflict here (`unprovable`: only a conflict
 * of substance is accepted), or a qualification still waits (`already_open`).
 */
export const MERGE_CONFLICT_REASONS = [
  "unknown_story",
  "not_started",
  "done",
  "not_developer",
  "branch_missing",
  "no_conflict",
  "forced_substantive",
  "unprovable",
  "already_open",
] as const;
export type MergeConflictReason = (typeof MERGE_CONFLICT_REASONS)[number];

/** Why a merge waits for another story (`get_merge_order`). */
export const MERGE_WAIT_REASONS = ["dependency", "overlap"] as const;
export type MergeWaitReason = (typeof MERGE_WAIT_REASONS)[number];

/** Why a conflict's resolution cannot be verified (`MERGE_FAILED` `conflict_unverified`). */
export const CONFLICT_UNVERIFIED_REASONS = [
  "rebased",
  "octopus",
  "unreadable",
  "undecided",
  "diverged",
  "foreign",
] as const;
export type ConflictUnverifiedReason = (typeof CONFLICT_UNVERIFIED_REASONS)[number];
