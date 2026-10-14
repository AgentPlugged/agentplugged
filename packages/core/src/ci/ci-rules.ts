import type { CiStatus } from "@agentplugged/protocol";
import { courseHolds } from "../course/course-rules.js";
import { type FastTrackHold, fastTrackHold } from "../fast-track/fast-track-rules.js";
import { isSkipped } from "../journey/journey-rules.js";
import type { StoryState } from "../projection/agent-reducers.js";
import { storyIn } from "../projection/agent-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { type ReleaseHold, releaseHold } from "../requirements/requirement-rules.js";
import { storyReviewDone, untriagedFindings } from "../review/review-rules.js";
import { openDeviations } from "../trace/deviation-rules.js";
import type { WorkspaceFiles } from "../workspace-files.js";
import type { CiCheck } from "./ci-reader.js";

/**
 * The rules of a story's CI, pure: the status of a set of checks, the CI a story
 * stands on, and the merge gate (a green CI on the branch's head, read after the story was last
 * sent to review, a done review, and no open deviation from its requirements) that
 * holds back a story's merge checkpoint.
 */

/** A failed or cancelled check fails the CI; else a pending one keeps it pending; else it passes. */
export function ciStatusOf(checks: readonly CiCheck[]): CiStatus {
  if (checks.some((check) => check.state === "fail")) return "fail";
  if (checks.some((check) => check.state === "pending")) return "pending";
  return "pass";
}

/**
 * The CI a story stands on: the status of its last read, or `waived` (the creator accepted the
 * story without a readable CI); `stale` when that read covers another commit than the branch's
 * head (when known), or came before the story's last status other than `in_progress` (new work
 * sent to review since: declaring `in_progress` again after a failure keeps the failure);
 * `unknown` without any read. `skipped`: the creator skipped the story's CI, whatever
 * was read or not.
 */
export type StoryCiStatus = CiStatus | "waived" | "skipped" | "stale" | "unknown";

export function storyCiStatus(
  story: StoryState | undefined,
  head?: string,
  /** The creator skipped the story's CI (`isSkipped(state, "story_ci", story)`). */
  skipped = false,
): StoryCiStatus {
  if (skipped) return "skipped";
  const ci = story?.ci;
  if (ci === undefined) return "unknown";
  if (head !== undefined && ci.commit !== head) return "stale";
  const since = story?.status_by?.at;
  if (
    since !== undefined &&
    story?.status !== "in_progress" &&
    Date.parse(ci.at) < Date.parse(since)
  ) {
    return "stale";
  }
  return ci.status;
}

/** A CI that lets a story merge: green, waived by the creator or skipped by them. */
export const ciGreen = (status: StoryCiStatus) =>
  status === "pass" || status === "waived" || status === "skipped";

/**
 * Whether a story's review is done: by default `reviewDone`, from the projection's
 * review of the story. `REVIEW_NOT_DONE` always says no.
 */
export type ReviewDoneCondition = (
  state: Readonly<Record<string, unknown>>,
  story: string,
) => boolean;

export const REVIEW_NOT_DONE: ReviewDoneCondition = () => false;

/** Where a story stands before its merge. */
export interface MergeGate {
  /**
   * A green (or waived) CI on the branch's head, read since it went to review, a review, and no
   * open deviation.
   */
  readonly ready: boolean;
  readonly ci: StoryCiStatus;
  readonly review: boolean;
  /** The story's open deviations: any one keeps the gate closed. */
  readonly deviations: number;
  /**
   * The decisions of an open correction of course that this story still waits for: any
   * one keeps the gate closed, the change touching what the story builds.
   */
  readonly course?: number;
  /**
   * The checks of the gate the creator skipped: `ci`, `review` (and the sorting of
   * its findings), `security`, `trace`, `fast_track`. They are warnings, never a closed gate.
   */
  readonly skipped: readonly string[];
  /** Findings of its closed review passes not sorted yet: part of `review`. */
  readonly untriaged: number;
  /**
   * What the fast track holds back: a story in the fast track whose head the engine
   * did not read as a small change, or one that left it before the creator answered. Absent when it
   * holds nothing back.
   */
  readonly fast_track?: FastTrackHold;
}

/** What the merge gate may be given: the review condition, and the branch's head when read. */
export interface MergeGateOptions {
  readonly reviewDone?: ReviewDoneCondition;
  readonly head?: string;
}

/** The merge gate of a story, from the projection's state (`ProjectionState["state"]`). */
export function mergeGate(
  state: Readonly<Record<string, unknown>>,
  story: string,
  options: MergeGateOptions = {},
): MergeGate {
  const entry = storyIn(state, story);
  // What the creator skipped no longer closes the gate (it is listed in `skipped`).
  const ciSkipped = isSkipped(state, "story_ci", story);
  const reviewSkipped = isSkipped(state, "story_review", story);
  const securitySkipped = isSkipped(state, "story_security", story);
  const traceSkipped = isSkipped(state, "story_trace", story);
  const ci = storyCiStatus(entry, options.head, ciSkipped);
  const review =
    reviewSkipped ||
    (options.reviewDone === undefined
      ? storyReviewDone(entry, options.head, ciSkipped)
      : options.reviewDone(state, story));
  const deviations = traceSkipped ? 0 : openDeviations(state, story).length;
  const course = courseHolds(state, story);
  const untriaged = reviewSkipped ? 0 : untriagedFindings(entry).length;
  const checkpoints = Object.values(
    (state.checkpoints as Record<string, CheckpointState> | undefined) ?? {},
  );
  // A story the creator stopped on its way back from the fast track stays stopped: that was their
  // own answer, which a skip does not undo.
  const held = fastTrackHold(entry, checkpoints, story, options.head, ciSkipped);
  // With the CI skipped, nothing reads the branch again: an unverified fast track is no hold.
  const fast =
    (held !== "stopped" && isSkipped(state, "story_fast_track", story)) ||
    (held === "unverified" && ciSkipped)
      ? undefined
      : held;
  const skipped = [
    ...(ciSkipped ? ["ci"] : []),
    ...(reviewSkipped ? ["review"] : securitySkipped ? ["security"] : []),
    ...(traceSkipped ? ["trace"] : []),
    ...(held !== undefined && fast === undefined ? ["fast_track"] : []),
  ];
  return {
    ready: ciGreen(ci) && review && deviations === 0 && course === 0 && fast === undefined,
    ci,
    review,
    deviations,
    ...(course > 0 ? { course } : {}),
    untriaged,
    skipped,
    ...(fast === undefined ? {} : { fast_track: fast }),
  };
}

/** True when the story may be presented for its merge: green CI, done review, no deviation. */
export function mergeReady(
  state: Readonly<Record<string, unknown>>,
  story: string,
  options: MergeGateOptions = {},
): boolean {
  return mergeGate(state, story, options).ready;
}

/**
 * A merge checkpoint held back: an open `story` checkpoint of a started story (`story.started`)
 * whose merge gate is closed, or that the engine did not open as its merge checkpoint. `review` neither lists nor approves it; `next` never asks the
 * creator to answer it (one that blocks stays in `waiting`). A refused one, or a `story`
 * checkpoint of a story never started, is not held.
 */
export function heldMergeCheckpoint(
  state: Readonly<Record<string, unknown>>,
  checkpoint: Pick<CheckpointState, "type" | "story" | "status"> & {
    readonly source?: CheckpointState["source"];
  },
  options: MergeGateOptions = {},
): boolean {
  if (checkpoint.type !== "story" || checkpoint.story === null) return false;
  if (checkpoint.status !== "open") return false;
  if (storyIn(state, checkpoint.story)?.started === undefined) return false;
  // On a started story, only the engine's merge checkpoint is ever presented as a merge;
  // another `story` checkpoint an agent opened would end the story under a title of its own
  // choosing: held for good, it can only be refused.
  const source = checkpoint.source ?? null;
  // The point a `blocked` result opened is never a merge point. It asks the creator
  // about the block, and the review of the story never waits for its merge gate: held, it made the
  // review wait for the point and the point wait for the review.
  if (source === "blocked_result") return false;
  if (source !== "merge") return true;
  return !mergeReady(state, checkpoint.story, options);
}

/**
 * The `merge` field `resolutionProblem` refuses to approve: present only for a held merge
 * checkpoint, with where its story stands.
 */
export function mergeHold(
  state: Readonly<Record<string, unknown>>,
  checkpoint: Pick<CheckpointState, "type" | "story" | "status"> & {
    readonly source?: CheckpointState["source"];
    readonly phase?: CheckpointState["phase"];
  },
  options: MergeGateOptions = {},
): {
  merge?: {
    story: string;
    ci: StoryCiStatus;
    review: boolean;
    deviations: number;
    course?: number;
    untriaged: number;
    fast_track?: FastTrackHold;
  };
  release?: ReleaseHold;
} {
  // A release point (a release, or the end of the delivery phase) is held while a
  // requirement has no valid proof (or a failed one) the creator did not settle. A point whose
  // waiver ran out can be answered again: it is held as an open one is.
  if (
    checkpoint.type === "release" ||
    (checkpoint.type === "phase_end" && checkpoint.phase === "delivery")
  ) {
    const held =
      checkpoint.status === "open" || checkpoint.status === "waived"
        ? releaseHold(state)
        : undefined;
    return held === undefined ? {} : { release: held };
  }
  if (checkpoint.story === null || !heldMergeCheckpoint(state, checkpoint, options)) return {};
  const gate = mergeGate(state, checkpoint.story, options);
  return {
    merge: {
      story: checkpoint.story,
      ci: gate.ci,
      review: gate.review,
      deviations: gate.deviations,
      ...(gate.course === undefined ? {} : { course: gate.course }),
      untriaged: gate.untriaged,
      ...(gate.fast_track === undefined ? {} : { fast_track: gate.fast_track }),
    },
  };
}

/** Files and folders that hold a CI, at the repository's top: never written over. */
export const CI_CONFIG_PATHS = [
  ".gitlab-ci.yml",
  ".circleci/config.yml",
  "azure-pipelines.yml",
  "bitbucket-pipelines.yml",
  "Jenkinsfile",
  ".travis.yml",
  ".drone.yml",
  ".woodpecker.yml",
  ".woodpecker",
  ".buildkite",
] as const;

/** GitHub Actions' folder: a `.yml` or `.yaml` file directly in it is a workflow. */
export const GITHUB_WORKFLOWS_DIR = ".github/workflows";

/** True for a workflow of GitHub Actions: a YAML file directly in its folder. */
export function isWorkflowFile(path: string): boolean {
  const prefix = `${GITHUB_WORKFLOWS_DIR}/`;
  if (!path.startsWith(prefix)) return false;
  const name = path.slice(prefix.length);
  return !name.includes("/") && /\.ya?ml$/i.test(name);
}

/**
 * The CI files of the workspace's root, in a stable order: empty when it has none. A path that
 * cannot be read (a file where a folder is expected) counts as absent.
 */
export async function existingCi(files: WorkspaceFiles): Promise<string[]> {
  const found = (await files.listFiles(GITHUB_WORKFLOWS_DIR).catch(() => [])).filter(
    isWorkflowFile,
  );
  for (const path of CI_CONFIG_PATHS) {
    if (await files.exists(path).catch(() => false)) found.push(path);
  }
  return found;
}
