import { z } from "zod";
import { StoryIdSchema } from "./agent-activity.js";
import { BranchNameSchema } from "./checkpoint.js";
import { AgentIdSchema } from "./method-config.js";

/**
 * Starting a story: `core` checks that the story may start, creates its branch
 * (`feat/<id>-<slug>`) from the main branch and a Git worktree of its own, next to the repository,
 * then writes `story.started`. The story is then in progress. The worktree is named by its path
 * relative to the main repository's folder, never an absolute path: the journal is shared.
 */

/** Event types of a story's lifecycle written by the engine, each at version 1. */
export const STORY_EVENT_TYPES = {
  started: "story.started",
  /** A story's pull request opened or its text replaced. */
  prOpened: "story.pr_opened",
} as const;

/** Who builds a story: an agent, `main` or `creator` (the format of a document's `owner`). */
const BuilderSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/** A Git commit id: 40 (SHA-1) or 64 (SHA-256) lowercase hexadecimal characters. */
export const CommitIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, {
  message: "expected a commit id (40 or 64 lowercase hexadecimal characters)",
});

/**
 * A worktree's path relative to the main repository's folder, with `/`: never absolute, never
 * a drive, never a backslash, at most 1024 characters.
 */
export const RelativeWorktreeSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !/^[A-Za-z]:/.test(path) &&
      ![...path].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f),
    { message: "expected a relative path with /" },
  );

/** `payload` of `story.started` (its story is the envelope's). */
export const StoryStartedPayloadSchema = z.strictObject({
  /** Who builds it: the calling agent (MCP), or the story's owner (CLI). */
  agent: BuilderSchema,
  branch: BranchNameSchema,
  /** The commit the branch starts from. */
  base: CommitIdSchema,
  /** The main branch read: `main`, `origin/main`… */
  base_ref: BranchNameSchema,
  /** The worktree, relative to the main repository's folder (`../<repo>.worktrees/<id>`). */
  worktree: RelativeWorktreeSchema,
});
export type StoryStartedPayload = z.infer<typeof StoryStartedPayloadSchema>;

/** Input of `start_story`. */
export const StartStoryInputSchema = z.strictObject({
  agent: AgentIdSchema.max(64),
  story: StoryIdSchema,
});
export type StartStoryInput = z.infer<typeof StartStoryInputSchema>;

/** Why a story cannot start (`STORY_NOT_STARTABLE`), in the order they are checked. */
export const STORY_START_REASONS = [
  "unknown_story",
  "unreadable",
  "invalid_story",
  "not_validated",
  "done",
  "already_started",
  "started_elsewhere",
  "not_in_sprint",
  "dependency_open",
  "branch_name",
  "no_main_branch",
  "not_on_main",
  "branch_exists",
  "branch_checked_out",
  /** A story built on the branch it lands on, whose main folder is on another branch. */
  "base_not_checked_out",
  "worktree_path_taken",
  /** An agent that is not the story's builder (its owner, or the sprint's capacity). */
  "not_builder",
  /** A story started by another agent: only that agent resumes it. */
  "started_by_other",
  /** A bare repository, or a main working tree at a file system root. */
  "unsupported_repository",
  /** The branch and worktree were created, but the start could not be recorded. */
  "not_recorded",
  /**
   * The profile's ceiling of stories built at once (`max_parallel_stories`) is
   * reached: the story waits until one of them is done.
   */
  "parallel_limit",
  /** The creator paused the team: no agent starts or takes up a story until they resume it. */
  "team_paused",
] as const;
export type StoryStartReason = (typeof STORY_START_REASONS)[number];

/** The branch a story must have: `feat/<id>-<slug>`, the slug in lowercase words. */
export function isStoryBranch(id: string, branch: string): boolean {
  if (!branch.startsWith(`feat/${id}-`)) return false;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(branch.slice(`feat/${id}-`.length));
}

/**
 * Delivering a story: `core` pushes the story's branch, never the main branch, then
 * opens or updates its pull request through the forge's command-line tool the creator already
 * logged in (`gh`, `glab`), with a text it renders the same way every time. Never a cost in the
 * event: it stays encrypted in the journal.
 */

/** The forges whose command-line tool opens a pull request. */
export const FORGE_IDS = ["github", "gitlab"] as const;
export type ForgeId = (typeof FORGE_IDS)[number];

/** What a pull request's text says of the tests: the agent's report, or nothing reported. */
export const PULL_REQUEST_TEST_STATUSES = ["passed", "failed", "not_run", "not_reported"] as const;
export type PullRequestTestStatus = (typeof PULL_REQUEST_TEST_STATUSES)[number];

/** A story holds at most this many acceptance criteria in a pull request. */
export const MAX_PULL_REQUEST_CRITERIA = 100;

/** A web address without credentials, whitespace nor control characters: `https://`, `http://`. */
export const PullRequestUrlSchema = z
  .string()
  .max(2048)
  .regex(/^https?:\/\/[^/@\s]+(?:\/\S*)?$/, {
    message: "expected an http(s) address without credentials",
  })
  .refine(
    (url) => ![...url].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f),
  );

/** `payload` of `story.pr_opened` (its story is the envelope's). */
export const StoryPrOpenedPayloadSchema = z.strictObject({
  forge: z.enum(FORGE_IDS),
  number: z.number().int().min(1).max(1_000_000_000),
  url: PullRequestUrlSchema,
  /** `opened`: created now; `updated`: an open one whose title and text were replaced. */
  action: z.enum(["opened", "updated"]),
  branch: BranchNameSchema,
  /** The branch it targets: the main branch's name (`main`). */
  base: BranchNameSchema,
  /** The commit pushed. */
  head: CommitIdSchema,
  /** One box per acceptance criterion, in the story's order: checked or not. */
  criteria: z.array(z.boolean()).max(MAX_PULL_REQUEST_CRITERIA),
  tests: z.enum(PULL_REQUEST_TEST_STATUSES),
  tests_summary: z.string().trim().min(1).max(1000).optional(),
  /** The SHA-256 of the text rendered, lowercase hexadecimal. */
  body_sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type StoryPrOpenedPayload = z.infer<typeof StoryPrOpenedPayloadSchema>;

/** Input of `open_pull_request`: the agent's own report of its criteria and tests. */
export const OpenPullRequestInputSchema = z.strictObject({
  agent: AgentIdSchema.max(64),
  story: StoryIdSchema,
  /** One entry per acceptance criterion of the story, in its order: met or not. */
  criteria: z.array(z.boolean()).max(MAX_PULL_REQUEST_CRITERIA),
  tests: z.strictObject({
    status: z.enum(["passed", "failed", "not_run"]),
    summary: z.string().trim().min(1).max(1000),
  }),
});
export type OpenPullRequestInput = z.infer<typeof OpenPullRequestInputSchema>;

/** Why a pull request cannot open (`PULL_REQUEST_NOT_OPENABLE`), in the order they are checked. */
export const PULL_REQUEST_REASONS = [
  "unknown_story",
  "not_started",
  "not_builder",
  "done",
  "not_validated",
  "unreadable",
  "criteria_count",
  "tests_not_passed",
  "branch_missing",
  "no_commits",
  "already_merged",
  /** The creator's workflow has no pull request (a direct merge, or no story branch). */
  "not_wanted",
] as const;
export type PullRequestReason = (typeof PULL_REQUEST_REASONS)[number];

/** Why the forge is not linked (`FORGE_NOT_LINKED`): nothing pushed. */
export const FORGE_LINK_REASONS = [
  "no_remote",
  "unknown_forge",
  "cli_missing",
  "not_logged_in",
] as const;
export type ForgeLinkReason = (typeof FORGE_LINK_REASONS)[number];

/** Why the push or the forge failed (`PULL_REQUEST_FAILED`). */
export const PULL_REQUEST_FAILURES = [
  "push_rejected",
  "push_failed",
  "forge_failed",
  /** The pull request exists, but `story.pr_opened` could not be written: run it again. */
  "not_recorded",
] as const;
export type PullRequestFailure = (typeof PULL_REQUEST_FAILURES)[number];
