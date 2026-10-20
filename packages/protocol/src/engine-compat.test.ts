import { describe, expect, it } from "vitest";
import { ErrorCode } from "./error-payload.js";
import type { EventEnvelope } from "./event-envelope.js";
import { currentEvent, EVENT_TYPE_REGISTRY, eventTypeUpgrade } from "./event-types.js";
import { eventConversion } from "./event-versions.js";

/**
 * The event types of the published engine 1.2.0, each with the version it wrote. Copied from that
 * release and never edited: a later engine keeps reading every one of them, at that version or
 * any older one. The types added since are listed apart, below.
 */
const ENGINE_1_2_0: Readonly<Record<string, number>> = {
  "device.registered": 1,
  "product.created": 1,
  "agent.status_reported": 2,
  "agent.instruction_given": 1,
  "agent.progress_reported": 1,
  "cost.reported": 2,
  "story.status_changed": 1,
  "agent.result_recorded": 1,
  "checkpoint.opened": 16,
  "checkpoint.measured": 1,
  "checkpoint.resolved": 1,
  "human.key_registered": 1,
  "human.presence_linked": 1,
  "human.key_endorsed": 1,
  "product.key_created": 1,
  "product.key_rotated": 1,
  "device.paired": 1,
  "device.revoked": 1,
  "device.root_certified": 1,
  "device.confirmed": 1,
  "trust.dismissed": 1,
  "bridge.primary_changed": 1,
  "order.applied": 1,
  "order.rejected": 1,
  "test.appended": 1,
  "method.migrated": 1,
  "session.external_read": 1,
  "write.refused": 1,
  "write.doubted": 1,
  "sprint.planned": 1,
  "deferred.recorded": 1,
  "deferred.closed": 1,
  "requirements.registered": 1,
  "requirement.proved": 2,
  "requirement.gap_settled": 1,
  "audit.reported": 1,
  "tests.reviewed": 1,
  "critique.reported": 1,
  "critique.proposed": 1,
  "critique.settled": 1,
  "hypothesis.closed": 1,
  "readiness.reported": 1,
  "readiness.settled": 1,
  "table.proposed": 1,
  "table.closed": 1,
  "course.opened": 1,
  "course.decided": 1,
  "course.closed": 1,
  "story.started": 1,
  "budget.threshold_reached": 1,
  "story.pr_opened": 1,
  "story.ci_reported": 1,
  "story.ci_waived": 1,
  "deviation.reported": 1,
  "deviation.resolved": 1,
  "story.reviewed": 1,
  "story.review_triaged": 1,
  "story.review_published": 1,
  "review.free_reviewed": 1,
  "checkpoint.answered": 2,
  "checkpoint.auto_applied": 1,
  "checkpoint.reopened": 1,
  "creator_action.executed": 12,
  "agent.delegated": 1,
  "memory.retrospective_proposed": 1,
  "lessons.recorded": 1,
  "lessons.promoted": 1,
  "checkpoint.elicited": 2,
  "checkpoint.web_answered": 2,
  "checkpoint.web_held": 2,
  "checkpoint.web_hold_cancelled": 1,
  "checkpoint.web_hold_failed": 1,
  "story.merged": 5,
  "git.workflow_set": 1,
  "git.released": 1,
  "story.fast_track_entered": 1,
  "story.fast_track_checked": 1,
  "story.fast_track_left": 1,
  "story.criterion_recorded": 1,
  "story.qa_reported": 1,
  "story.attempt_recorded": 1,
  "loop.stopped": 1,
  "loop.resumed": 1,
  "story.conflict_qualified": 1,
  "story.merge_refreshed": 1,
  "stack.opened": 1,
  "stack.answered": 2,
  "install.recorded": 1,
  "checkpoint.closed": 2,
  "checkpoint.decided": 1,
  "usage.measured": 2,
};

/** What engine 1.3.0 adds to the journal: three types, all additive and at version 1. */
const ADDED_IN_1_3_0 = ["exchange.summarized", "team.paused", "team.resumed"];

describe("an engine newer than 1.2.0 reads what 1.2.0 wrote", () => {
  it("keeps every type of 1.2.0, at its version or a newer one that converts the old", () => {
    for (const [type, version] of Object.entries(ENGINE_1_2_0)) {
      const spec = EVENT_TYPE_REGISTRY[type];
      expect(spec, `${type} is gone`).toBeDefined();
      expect(spec?.version, `${type} went back`).toBeGreaterThanOrEqual(version);
      for (let from = version; from < (spec?.version ?? 0); from++) {
        expect(eventConversion(type, from), `${type} v${from} has no conversion`).toBeDefined();
      }
    }
  });

  it("adds only the three types of the release, each at version 1", () => {
    const added = Object.keys(EVENT_TYPE_REGISTRY)
      .filter((type) => !(type in ENGINE_1_2_0))
      .sort();
    expect(added).toEqual(ADDED_IN_1_3_0);
    for (const type of added) expect(EVENT_TYPE_REGISTRY[type]?.version).toBe(1);
  });
});

describe("an engine 1.2.0 reads what a newer one wrote", () => {
  // The rule of 1.2.0, checked by running its own code on these three types: a type it does not
  // know answers UPGRADE_REQUIRED, nothing is projected nor written, the journal stays intact. The
  // bridge therefore never writes them to a product pinned to 1.2.0. What can be held here is the
  // other half: the release raises no version of a type 1.2.0 wrote (a version it does not read
  // would be refused the same way), and the three new types are unknown to it.
  it("meets no version of a type it wrote that it lacks: none was raised", () => {
    for (const [type, version] of Object.entries(ENGINE_1_2_0)) {
      expect(EVENT_TYPE_REGISTRY[type]?.version, type).toBe(version);
    }
  });

  it("meets only three types it does not know, refused as any unknown type is", () => {
    for (const type of ADDED_IN_1_3_0) expect(type in ENGINE_1_2_0).toBe(false);
    expect(eventTypeUpgrade("story.teleported", 1)?.code).toBe(ErrorCode.UPGRADE_REQUIRED);
  });

  it("is read by the new engine itself, at version 1", () => {
    for (const type of ADDED_IN_1_3_0) expect(eventTypeUpgrade(type, 1)).toBeUndefined();
    const event = { v: 1, type: "team.paused", payload: { reason: "creator" } };
    expect(currentEvent(event as unknown as EventEnvelope).ok).toBe(true);
  });
});
