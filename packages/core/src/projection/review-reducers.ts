import {
  type EventEnvelope,
  type FreeReviewedPayload,
  findingIdOf,
  MAIN_SESSION_AGENT,
  NOAH_AGENT,
  REVIEW_EVENT_TYPES,
  reviewIdOf,
  SECURITY_REASONS,
  type StoryReviewedPayload,
  type StoryReviewPublishedPayload,
  type StoryReviewTriagedPayload,
} from "@agentplugged/protocol";
import { ciGreen, storyCiStatus } from "../ci/ci-rules.js";
import type { DeferredItem } from "../deferred/deferred-rules.js";
import { isSkipped } from "../journey/journey-rules.js";
import {
  currentPass,
  findFinding,
  isStoryDeveloper,
  passComplete,
  passOutcome,
  type ReviewPass,
  reviewVerdictOf,
} from "../review/review-rules.js";
import { agentOf, type StoryState, section, startedStory } from "./agent-reducers.js";
import type { Reducer } from "./reducers.js";

/**
 * The agent of an event, `main` and Noah excluded: a review is never the main session's, whose
 * assistant does no agent's work.
 */
function reviewerOf(event: EventEnvelope): string | undefined {
  return event.actor.kind === "agent" &&
    event.actor.agent !== MAIN_SESSION_AGENT &&
    event.actor.agent !== NOAH_AGENT
    ? event.actor.agent
    : undefined;
}

/**
 * Closes a pass whose reviews are all in (`passComplete`): its outcome, and, for a failed review, the
 * story back to its developer. Also used when the creator skips the security review of a story
 * while its quality review waits for it.
 */
export function closePass(story: StoryState, pass: ReviewPass, at: string, event: string): void {
  pass.complete = true;
  pass.completed_at = at;
  pass.closed_by = event;
  pass.outcome = passOutcome(pass);
  if (pass.outcome === "changes_requested" && story.started !== undefined) {
    story.status = "in_progress";
    // Never before the status it replaces (a clock behind the review's).
    const since = story.status_by?.at;
    const when = since !== undefined && Date.parse(since) > Date.parse(at) ? since : at;
    story.status_by = { agent: story.started.agent, at: when };
  }
}

/** Why a `story.reviewed` cannot apply to the story as it stands, or undefined. */
function reviewProblem(
  story: StoryState | undefined,
  agent: string | undefined,
  payload: StoryReviewedPayload,
  /** The creator skipped the story's CI: the review is not bound to a CI's commit. */
  ciSkipped: boolean,
): string | undefined {
  if (agent === undefined || story === undefined) return "invalid";
  if (story.status !== "in_review") return "invalid";
  // Independent: never the story's developer.
  if (isStoryDeveloper(story, agent)) return "invalid";
  // On a green (or waived) CI of the very commit reviewed.
  if (!ciGreen(storyCiStatus(story, undefined, ciSkipped))) return "invalid";
  if (!ciSkipped && story.ci?.commit !== payload.commit) return "invalid";
  // The verdict follows from the findings, never from the event's word.
  if (payload.verdict !== reviewVerdictOf(payload.findings)) return "invalid";
  // A security review only for a story that concerns security.
  if (payload.kind === "security" && payload.security.reasons.length === 0) return "invalid";
  const pass = currentPass(story, payload.commit);
  if (pass === undefined) return undefined;
  if (pass.complete || pass.reviews[payload.kind] !== undefined) return "invalid";
  // Two reviews of one pass come from two agents.
  if (Object.values(pass.reviews).some((review) => review?.by === agent)) return "invalid";
  return undefined;
}

/** What the projection keeps of a free review: the latest ones, bounded. */
export interface FreeReviewRecord {
  readonly id: string;
  readonly by: string;
  readonly at: string;
  readonly source: string;
  readonly intent: string;
  readonly commit: string;
  readonly verdict: string;
  readonly findings: number;
  readonly blocking: number;
  readonly refuted: number;
  readonly silent: readonly string[];
}

/** Free reviews kept in the state, the latest ones (the journal keeps them all). */
export const FREE_REVIEWS_KEPT = 20;

/**
 * The reducers of a story's independent review, `stories[id].review`.
 * - `story.reviewed`, by an agent other than `main` and the story's developer, on a story in
 *   review whose CI is green (or waived) on the commit reviewed, joins its pass (the same stay in
 *   review, the same commit) or opens the next one. A pass closes once its quality review is in,
 *   and its security review when it needs one; closed with a failed review, a story in review goes
 *   back to `in_progress`, given by its developer. Ignored (`invalid`): any other actor or story,
 *   a kind already given in the pass, both kinds by one agent.
 * - `story.review_triaged`, by the story's developer: each finding of a closed pass gets its
 *   decision and root cause, once. Ignored: another actor, an unknown finding, one of an open pass
 *   or already sorted, an item of deferred work unknown or not linked to the story.
 * - `story.review_published` marks one review of a closed pass posted on the pull request, once.
 */
export const REVIEW_REDUCERS: Readonly<Record<string, Reducer>> = {
  [REVIEW_EVENT_TYPES.reviewed]: (draft, event) => {
    const payload = event.payload as StoryReviewedPayload;
    const agent = reviewerOf(event);
    const story = agent === undefined ? undefined : startedStory(draft, event);
    const problem = reviewProblem(
      story,
      agent,
      payload,
      isSkipped(draft.state, "story_ci", event.story),
    );
    if (problem !== undefined || story === undefined || agent === undefined) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    agentOf(draft, event);
    story.review ??= { passes: [] };
    const review = story.review;
    let pass = currentPass(story, payload.commit);
    if (pass === undefined) {
      // A pass left open (a new commit, a new stay in review) is closed as it stands: its
      // findings are sorted like any other, and a failed review counts in the loop.
      const left = review.passes.at(-1);
      if (left !== undefined && !left.complete && Object.keys(left.reviews).length > 0) {
        left.complete = true;
        left.completed_at = event.at;
        left.outcome = passOutcome(left);
      }
      pass = {
        number: (review.passes.at(-1)?.number ?? 0) + 1,
        since: story.status_by?.at ?? event.at,
        commit: payload.commit,
        reviews: {},
        security: payload.security,
        complete: false,
        outcome: null,
        completed_at: null,
        closed_by: null,
        published: {},
      } satisfies ReviewPass;
      review.passes.push(pass);
    }
    pass.reviews[payload.kind] = {
      id: reviewIdOf(event.id),
      kind: payload.kind,
      event: event.id,
      by: agent,
      at: event.at,
      verdict: payload.verdict,
      summary: payload.summary,
      ...(payload.silent === undefined || payload.silent.length === 0
        ? {}
        : { silent: payload.silent }),
      ...(payload.ruled === undefined ? {} : { ruled: payload.ruled }),
      ...(payload.refuted === undefined
        ? {}
        : {
            refutedBlocking: payload.refuted.filter((entry) => entry.severity === "blocking")
              .length,
          }),
      findings: payload.findings.map((finding, index) => ({
        ...finding,
        id: findingIdOf(event.id, index + 1),
        triage: null,
      })),
    };
    // Never lowered by a later review: the reasons add up.
    const reasons = SECURITY_REASONS.filter(
      (reason) =>
        pass.security.reasons.includes(reason) || payload.security.reasons.includes(reason),
    );
    pass.security =
      payload.security.unavailable === true ? { reasons, unavailable: true } : { reasons };
    if (!passComplete(pass, isSkipped(draft.state, "story_security", event.story))) return;
    closePass(story, pass, event.at, event.id);
  },
  [REVIEW_EVENT_TYPES.freeReviewed]: (draft, event) => {
    const payload = event.payload as FreeReviewedPayload;
    const agent = reviewerOf(event);
    // A review of a change with no story. The verdict follows from the findings, never
    // from the event's word, and it belongs to no story.
    if (
      agent === undefined ||
      event.story !== undefined ||
      payload.verdict !== reviewVerdictOf(payload.findings)
    ) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    agentOf(draft, event);
    const reviews = section<FreeReviewRecord>(draft, "free_reviews");
    const id = reviewIdOf(event.id);
    reviews[id] = {
      id,
      by: agent,
      at: event.at,
      source: payload.source,
      intent: payload.intent,
      commit: payload.commit,
      verdict: payload.verdict,
      findings: payload.findings.length,
      blocking: payload.findings.filter((finding) => finding.severity === "blocking").length,
      refuted: payload.ruled?.refuted ?? 0,
      silent: payload.silent ?? [],
    };
    for (const old of Object.keys(reviews).slice(0, -FREE_REVIEWS_KEPT)) delete reviews[old];
  },
  [REVIEW_EVENT_TYPES.triaged]: (draft, event) => {
    const payload = event.payload as StoryReviewTriagedPayload;
    const agent = event.actor.kind === "agent" ? event.actor.agent : undefined;
    const story = agent === undefined ? undefined : startedStory(draft, event);
    const id = event.story as string;
    const deferred = (draft.state.deferred as Record<string, DeferredItem> | undefined) ?? {};
    const valid =
      agent !== undefined &&
      story !== undefined &&
      isStoryDeveloper(story, agent) &&
      payload.items.every((item) => {
        const found = findFinding(story, item.finding);
        if (found === undefined || !found.pass.complete || found.finding.triage !== null) {
          return false;
        }
        if (item.deferred === undefined) return true;
        const entry = Object.hasOwn(deferred, item.deferred) ? deferred[item.deferred] : undefined;
        return (
          entry !== undefined &&
          entry.status === "open" &&
          (entry.story === id || entry.locks.includes(id))
        );
      });
    if (!valid || story === undefined || agent === undefined) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    agentOf(draft, event);
    for (const item of payload.items) {
      const found = findFinding(story, item.finding);
      if (found === undefined) continue;
      found.finding.triage = {
        decision: item.decision,
        root_cause: item.root_cause,
        reason: item.reason ?? null,
        deferred: item.deferred ?? null,
        by: agent,
        at: event.at,
        event: event.id,
      };
    }
  },
  [REVIEW_EVENT_TYPES.published]: (draft, event) => {
    const payload = event.payload as StoryReviewPublishedPayload;
    const agent = event.actor.kind === "agent" ? event.actor.agent : undefined;
    // A story done since keeps its posting: the forge took it (never posted again).
    const stories = draft.state.stories as Record<string, StoryState> | undefined;
    const story =
      agent === undefined || event.story === undefined || stories === undefined
        ? undefined
        : Object.hasOwn(stories, event.story)
          ? stories[event.story]
          : undefined;
    const pass = story?.review?.passes.find((entry) => entry.number === payload.pass);
    if (
      agent === undefined ||
      pass === undefined ||
      !pass.complete ||
      pass.reviews[payload.kind] === undefined ||
      pass.published[payload.kind] !== undefined
    ) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    agentOf(draft, event);
    pass.published[payload.kind] = {
      forge: payload.forge,
      pr: payload.pr,
      comments: payload.comments,
      notes: payload.notes,
      by: agent,
      at: event.at,
      event: event.id,
    };
  },
};
