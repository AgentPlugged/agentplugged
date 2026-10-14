import type { CreatorActionRecord } from "@agentplugged/protocol";
import { type SkipState, skipKey } from "../journey/journey-rules.js";
import { passComplete } from "../review/review-rules.js";
import { type StoryState, section } from "./agent-reducers.js";
import type { ProjectionDraft } from "./reducers.js";
import { closePass } from "./review-reducers.js";

/**
 * The steps of the journey the creator skipped: `state.skips`, by `skipKey`. A skip is
 * the effect of a `step_skip` creator's action carried out after the creator's answer (the chain of
 * proofs of every creator's action: the approval, then its execution), a resume the effect of a
 * `step_resume`. Neither is its own event: the creator's answer is the proof.
 */

const skipsOf = (draft: ProjectionDraft) => section<SkipState>(draft, "skips");

/** Who and when, as the creator's action reducer gives it. */
export interface SkipTarget {
  readonly reason: string;
  readonly by: string;
  readonly at: string;
  readonly event: string;
}

/**
 * Records the step as skipped. False, nothing changed, when it already is (the same step and story:
 * nothing to carry out) or when the action is not a skip.
 */
export function applyStepSkip(
  draft: ProjectionDraft,
  record: CreatorActionRecord,
  target: SkipTarget,
  source: string,
  checkpoint: string,
): boolean {
  if (record.kind !== "step_skip") return false;
  const skips = skipsOf(draft);
  const key = skipKey(record.step, record.story);
  if (Object.hasOwn(skips, key)) return false;
  skips[key] = {
    step: record.step,
    story: record.story ?? null,
    reason: target.reason,
    by: target.by,
    source,
    at: target.at,
    event: target.event,
    checkpoint,
  };
  if (record.step === "story_security") settleSecurityReviews(draft, record.story, target);
  return true;
}

/**
 * Once the creator skips the security review of a story (or of every story), a pass that only waited
 * for it is closed: its quality review is the review.
 */
function settleSecurityReviews(
  draft: ProjectionDraft,
  story: string | undefined,
  target: SkipTarget,
): void {
  const stories = (draft.state.stories as Record<string, StoryState> | undefined) ?? {};
  for (const [id, entry] of Object.entries(stories)) {
    if ((story !== undefined && id !== story) || entry.started === undefined) continue;
    if (entry.merged !== undefined || entry.status !== "in_review") continue;
    const last = entry.review?.passes.at(-1);
    if (last === undefined || last.complete || !passComplete(last, true)) continue;
    closePass(entry, last, target.at, target.event);
  }
}

/** Takes the step up again. False, nothing changed, when it was not skipped. */
export function applyStepResume(draft: ProjectionDraft, record: CreatorActionRecord): boolean {
  if (record.kind !== "step_resume") return false;
  const skips = skipsOf(draft);
  const key = skipKey(record.step, record.story);
  if (!Object.hasOwn(skips, key)) return false;
  delete skips[key];
  return true;
}
