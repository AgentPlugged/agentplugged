import { z } from "zod";
import { StoryIdSchema } from "./agent-activity.js";
import { RepositoryPathSchema } from "./merge.js";
import { AgentIdSchema } from "./method-config.js";
import { CommitIdSchema, StartStoryInputSchema } from "./story.js";

/**
 * The fast track. A small change skips framing and design, never the
 * review nor the creator's validation before the merge. It is a mode of the developer the story
 * goes to, carried by the story: there is no agent of the fast track. The developer enters it when
 * the story starts and declares what only they can know; the engine reads the rest in the
 * repository (the files the story touches, the dependency manifests, the migrations, the files of
 * an interface's contract) each time a pull request or a CI read records a commit, and sends the
 * story back to the full lane, with a checkpoint that explains it, when a criterion no longer
 * holds. The way back to the full lane is final.
 */

/** Event types of the fast track written by the engine, each at version 1. */
export const FAST_TRACK_EVENT_TYPES = {
  /** The story entered the fast track, in the write that started it. */
  entered: "story.fast_track_entered",
  /** The engine read the commit's changes against the criteria. */
  checked: "story.fast_track_checked",
  /** The story left the fast track for the full lane. */
  left: "story.fast_track_left",
} as const;

/** A small change touches fewer than this many files. */
export const FAST_TRACK_MAX_FILES = 5;

/** Most files one verification lists (the count is always complete). */
export const MAX_FAST_TRACK_FILES = 100;

/** What the engine reads in the repository, and why a commit does not fit the fast track. */
export const FAST_TRACK_ENGINE_REASONS = [
  /** `FAST_TRACK_MAX_FILES` files or more are touched. */
  "too_many_files",
  /** A dependency manifest or lockfile is touched: a dependency may be added. */
  "dependency_manifest",
  /** A file of a data migration is touched. */
  "migration",
  /** A file of an interface's contract (OpenAPI, protobuf, GraphQL schema, type declarations). */
  "interface_contract",
] as const;
export type FastTrackEngineReason = (typeof FAST_TRACK_ENGINE_REASONS)[number];

/** What the developer finds out while working, and declares when leaving the fast track. */
export const FAST_TRACK_AGENT_REASONS = [
  "ambiguous_intent",
  "irreversible_action",
  "growing_scope",
  "public_interface",
  "data_migration",
  "new_dependency",
] as const;
export type FastTrackAgentReason = (typeof FAST_TRACK_AGENT_REASONS)[number];

export const FAST_TRACK_REASONS = [
  ...FAST_TRACK_ENGINE_REASONS,
  ...FAST_TRACK_AGENT_REASONS,
] as const;
export type FastTrackReason = (typeof FAST_TRACK_REASONS)[number];

/**
 * What the developer declares on entering, because the repository cannot say: the goal has one
 * reading, nothing needed is irreversible, the public interface stays as it is. Each is `true`, or
 * the story does not enter the fast track.
 */
export const FastTrackDeclarationSchema = z.strictObject({
  single_reading: z.literal(true),
  reversible: z.literal(true),
  no_public_interface: z.literal(true),
});
export type FastTrackDeclaration = z.infer<typeof FastTrackDeclarationSchema>;

/** The change restated in one sentence, as the developer checks it against the criteria. */
export const FastTrackSummarySchema = z.string().trim().min(1).max(300);

/**
 * What `start_story` takes to start a story in the fast track. The three declarations are booleans
 * here so that the engine can say which one the developer could not make
 * (`FAST_TRACK_NOT_POSSIBLE`, `declaration`): only a complete declaration is ever recorded.
 */
export const FastTrackEntrySchema = z.strictObject({
  summary: FastTrackSummarySchema,
  declared: z.strictObject({
    single_reading: z.boolean(),
    reversible: z.boolean(),
    no_public_interface: z.boolean(),
  }),
});
export type FastTrackEntry = z.infer<typeof FastTrackEntrySchema>;

/** The declarations a developer could not make, by name (empty when the declaration is complete). */
export function missingDeclarations(declared: FastTrackEntry["declared"]): string[] {
  return (Object.keys(declared) as (keyof FastTrackEntry["declared"])[]).filter(
    (name) => declared[name] !== true,
  );
}

/** Input of `start_story`: a story starts, in the fast track when `fast_track` is given. */
export const StartStoryFastTrackInputSchema = StartStoryInputSchema.extend({
  fast_track: FastTrackEntrySchema.optional(),
});
export type StartStoryFastTrackInput = z.infer<typeof StartStoryFastTrackInputSchema>;

/** `payload` of `story.fast_track_entered` (its story is the envelope's). */
export const FastTrackEnteredPayloadSchema = z.strictObject({
  /** The developer of the story: the agent `story.started` names. */
  agent: AgentIdSchema.max(64),
  summary: FastTrackSummarySchema,
  declared: FastTrackDeclarationSchema,
});
export type FastTrackEnteredPayload = z.infer<typeof FastTrackEnteredPayloadSchema>;

/** `payload` of `story.fast_track_checked`: what the engine read of one commit's changes. */
export const FastTrackCheckedPayloadSchema = z
  .strictObject({
    commit: CommitIdSchema,
    /** The files touched since the branch's base; a renamed file counts both of its paths. */
    count: z.number().int().min(0).max(1_000_000),
    files: z.array(RepositoryPathSchema).max(MAX_FAST_TRACK_FILES),
    /** More files are touched than `files` lists. */
    files_truncated: z.literal(true).optional(),
    ok: z.boolean(),
    /** Why the commit does not fit: empty if and only if `ok`. */
    reasons: z.array(z.enum(FAST_TRACK_ENGINE_REASONS)).max(FAST_TRACK_ENGINE_REASONS.length),
  })
  .refine((payload) => payload.ok === (payload.reasons.length === 0), {
    message: "ok if and only if there is no reason",
    path: ["ok"],
  })
  .refine((payload) => new Set(payload.reasons).size === payload.reasons.length, {
    message: "each reason once",
    path: ["reasons"],
  });
export type FastTrackCheckedPayload = z.infer<typeof FastTrackCheckedPayloadSchema>;

/** Who sends the story back to the full lane: the engine's check, or the developer. */
export const FAST_TRACK_LEAVERS = ["engine", "agent"] as const;
export type FastTrackLeaver = (typeof FAST_TRACK_LEAVERS)[number];

/** A free text of 1 to 1000 characters. */
export const FastTrackDetailSchema = z.string().trim().min(1).max(1000);

/** `payload` of `story.fast_track_left`. */
export const FastTrackLeftPayloadSchema = z
  .strictObject({
    by: z.enum(FAST_TRACK_LEAVERS),
    reasons: z.array(z.enum(FAST_TRACK_REASONS)).min(1).max(FAST_TRACK_REASONS.length),
    detail: FastTrackDetailSchema.optional(),
    /** The commit the engine's check read, when it is the engine that leaves. */
    commit: CommitIdSchema.optional(),
  })
  .refine((payload) => new Set(payload.reasons).size === payload.reasons.length, {
    message: "each reason once",
    path: ["reasons"],
  })
  .refine(
    (payload) =>
      payload.reasons.every((reason) =>
        payload.by === "engine"
          ? (FAST_TRACK_ENGINE_REASONS as readonly string[]).includes(reason)
          : (FAST_TRACK_AGENT_REASONS as readonly string[]).includes(reason),
      ),
    { message: "the engine gives its reasons, the developer theirs", path: ["reasons"] },
  );
export type FastTrackLeftPayload = z.infer<typeof FastTrackLeftPayloadSchema>;

/** Input of `leave_fast_track`: the developer sends their story back to the full lane. */
export const LeaveFastTrackInputSchema = z.strictObject({
  agent: AgentIdSchema.max(64),
  story: StoryIdSchema,
  reasons: z
    .array(z.enum(FAST_TRACK_AGENT_REASONS))
    .min(1)
    .max(FAST_TRACK_AGENT_REASONS.length)
    .refine((reasons) => new Set(reasons).size === reasons.length, { message: "each reason once" }),
  /** What was found, for the creator: it goes in the checkpoint. */
  detail: FastTrackDetailSchema,
});
export type LeaveFastTrackInput = z.infer<typeof LeaveFastTrackInputSchema>;

/** The options of the checkpoint that explains the way back to the full lane. */
export const FAST_TRACK_OPTIONS = { fullLane: "full_lane", stop: "stop" } as const;

/** Why the fast track cannot be entered or left (`FAST_TRACK_NOT_POSSIBLE`), nothing written. */
export const FAST_TRACK_REFUSALS = [
  /** The story is unknown or was never started. */
  "not_started",
  "not_builder",
  "not_fast_track",
  "already_left",
  "done",
  /** The declaration is not complete. */
  "declaration",
  /** A story already started cannot enter the fast track. */
  "already_started",
] as const;
export type FastTrackRefusal = (typeof FAST_TRACK_REFUSALS)[number];
