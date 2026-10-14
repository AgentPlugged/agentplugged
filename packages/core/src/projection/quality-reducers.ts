import { TEST_REVIEW_EVENT_TYPES, type TestsReviewedPayload } from "@agentplugged/protocol";
import { actingAgent, dictionary } from "./agent-reducers.js";
import type { Reducer } from "./reducers.js";

/** What the projection keeps of the latest review of the tests of a story, or of the product. */
export interface TestReviewRecord {
  readonly at: string;
  readonly by: string;
  readonly score: number | null;
  readonly grade: string | null;
  readonly verdict: string | null;
  /** The breaks no test noticed in the latest mutation check, or null when none ran. */
  readonly survived: number | null;
  readonly gaps: number;
}

/**
 * The reducers of the quality of the tests: `state.test_reviews`, the latest review of
 * each story (and of the product) with its marks and what the mutation check found. Written by an
 * agent only; nothing here decides anything, it is what a later review compares itself with.
 */
export const QUALITY_REDUCERS: Readonly<Record<string, Reducer>> = {
  [TEST_REVIEW_EVENT_TYPES.reviewed]: (draft, event) => {
    const by = actingAgent(event);
    if (by === undefined) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    const payload = event.payload as TestsReviewedPayload;
    let reviews = draft.state.test_reviews as Record<string, TestReviewRecord> | undefined;
    if (reviews === undefined) {
      reviews = dictionary<TestReviewRecord>();
      draft.state.test_reviews = reviews;
    }
    // A review of the grid only, or of the mutation check only, keeps what the other said before.
    const key = payload.story ?? "product";
    const before = reviews[key];
    reviews[key] = {
      at: event.at,
      by,
      score: payload.score ?? before?.score ?? null,
      grade: payload.grade ?? before?.grade ?? null,
      verdict: payload.verdict ?? before?.verdict ?? null,
      survived: payload.mutation?.survived ?? before?.survived ?? null,
      gaps: payload.gaps,
    };
  },
};
