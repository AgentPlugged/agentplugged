import { z } from "zod";
import { StoryIdSchema } from "./agent-activity.js";
import { hasControlCharacter } from "./deferred.js";
import { AgentIdSchema, CI_FORGE_IDS } from "./method-config.js";
import { CommitIdSchema } from "./story.js";

/**
 * The CI of a story: `core` reads the checks of the story's pull request through the
 * forge's command-line tool (`gh`, `glab`), then writes `story.ci_reported`. A failed CI sends the
 * story back to its agent; a merge checkpoint waits for a green CI and a done review. When the CI
 * cannot be read at all, the creator may accept that, for the branch's commit, at the terminal
 * (`story.ci_waived`, signed by the creator's key).
 */

/** Event types of a story's CI, each at version 1. */
export const CI_EVENT_TYPES = {
  reported: "story.ci_reported",
  /** The creator accepts that a story's CI cannot be read, for one commit. */
  waived: "story.ci_waived",
} as const;

/** The forges whose CI the engine reads and generates. */
export const CI_FORGES = CI_FORGE_IDS;
export type CiForge = (typeof CI_FORGES)[number];

/** The status of a CI, all its checks taken together. */
export const CI_STATUSES = ["pass", "fail", "pending"] as const;
export type CiStatus = (typeof CI_STATUSES)[number];

/** Most checks one report counts, and most failed check names it lists (a marker included). */
export const MAX_CI_CHECKS = 1000;
export const MAX_CI_FAILED = 50;
/** Longest check name, in UTF-16 code units. */
export const MAX_CI_CHECK_NAME = 200;

/** A check's name: 1 to 200 characters, without control characters. */
export const CiCheckNameSchema = z
  .string()
  .min(1)
  .max(MAX_CI_CHECK_NAME)
  .refine((name) => !hasControlCharacter(name, false), { message: "control character" });

/** An `https://` address of at most 2048 characters, without control characters or spaces. */
export const CiUrlSchema = z
  .string()
  .max(2048)
  .regex(/^https:\/\/[^\s]+$/, { message: "expected an https:// address" })
  .refine((url) => !hasControlCharacter(url, false), { message: "control character" });

/** `payload` of `story.ci_reported` (its story is the envelope's). */
export const CiReportedPayloadSchema = z
  .strictObject({
    forge: z.enum(CI_FORGES),
    status: z.enum(CI_STATUSES),
    /**
     * How many checks were read. None yet is a CI that has not started on the commit
     * (just pushed, or run again): `pending`, never a pass.
     */
    checks: z.number().int().min(0).max(MAX_CI_CHECKS),
    /** The names of the failed checks: empty unless `status` is `fail`. */
    failed: z.array(CiCheckNameSchema).max(MAX_CI_FAILED),
    /** The pull request's (or merge request's) number. */
    pr: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    url: CiUrlSchema.optional(),
    /** The commit the checks ran on: the head of the story's branch when it was read. */
    commit: CommitIdSchema,
    /** When the forge was read (before the event was written). */
    read_at: z.iso.datetime(),
  })
  .refine((payload) => payload.status === "fail" || payload.failed.length === 0, {
    message: "failed checks are listed only when the CI failed",
    path: ["failed"],
  })
  .refine((payload) => payload.checks > 0 || payload.status === "pending", {
    message: "a CI with no check yet is pending",
    path: ["status"],
  });
export type CiReportedPayload = z.infer<typeof CiReportedPayloadSchema>;

/** Why the creator accepts a story without a readable CI: 1 to 500 characters. */
export const CiWaiverReasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((reason) => !hasControlCharacter(reason, false), { message: "control character" });

/** `payload` of `story.ci_waived` (its story is the envelope's), the creator's own event. */
export const CiWaivedPayloadSchema = z.strictObject({
  reason: CiWaiverReasonSchema,
  /** The head of the story's branch the waiver covers: a newer commit is not covered. */
  commit: CommitIdSchema,
});
export type CiWaivedPayload = z.infer<typeof CiWaivedPayloadSchema>;

/** Input of `check_ci`: `forge` forces the forge (GitHub or GitLab hosted elsewhere). */
export const CheckCiInputSchema = z.strictObject({
  agent: AgentIdSchema.max(64),
  story: StoryIdSchema,
  forge: z.enum(CI_FORGES).optional(),
});
export type CheckCiInput = z.infer<typeof CheckCiInputSchema>;

/** Why a story's CI cannot be read, waived or set up (`CI_UNAVAILABLE`). */
export const CI_UNAVAILABLE_REASONS = [
  "not_started",
  "done",
  "no_repository",
  "no_forge",
  "forge_cli_missing",
  "not_authenticated",
  "no_pull_request",
  "no_checks",
  "forge_failed",
  /** `ci setup`: the workspace is not the repository's top folder. */
  "not_repository_root",
  /** The forge's tool took more than its time limit. */
  "forge_timeout",
  /** The forge refused the repository: not found, or no permission. */
  "forge_access",
  /** The story's branch is not in this repository. */
  "no_branch",
  /** The checks ran on another commit than the head of the story's branch. */
  "head_mismatch",
  /** The story's status was declared again after the read: read it again. */
  "stale_read",
] as const;
export type CiUnavailableReason = (typeof CI_UNAVAILABLE_REASONS)[number];
