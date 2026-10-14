import {
  COURSE_EVENT_TYPES,
  type CourseClosedPayload,
  type CourseDecidedPayload,
  type CourseOpenedPayload,
  courseIdOf,
} from "@agentplugged/protocol";
import { type CourseRecord, courseById, openCourse, undecided } from "../course/course-rules.js";
import { actingAgent, dictionary } from "./agent-reducers.js";
import type { Reducer } from "./reducers.js";

/**
 * The reducers of the correction of course: `state.courses`, by id, one course open
 * at a time. A course keeps the stack the engine computed and what the creator decided of each
 * element (the gesture, the reason, when). Every event is an agent's: the gestures are the
 * creator's, relayed with their words, which the event keeps. An event that does not fit the state
 * (a second course while one is open, an element already decided, a closing before everything is
 * decided) is ignored as `invalid`.
 */
export const COURSE_REDUCERS: Readonly<Record<string, Reducer>> = {
  [COURSE_EVENT_TYPES.opened]: (draft, event) => {
    const by = actingAgent(event);
    if (by === undefined || openCourse(draft.state) !== undefined) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    const payload = event.payload as CourseOpenedPayload;
    const id = courseIdOf(event.id);
    if (draft.state.courses === undefined) draft.state.courses = dictionary<CourseRecord>();
    (draft.state.courses as Record<string, CourseRecord>)[id] = {
      id,
      at: event.at,
      by,
      summary: payload.summary,
      quote: payload.quote,
      starts: payload.starts,
      stack: payload.stack.map((entry, index) => ({
        ...entry,
        n: index + 1,
        gesture: null,
        reason: null,
        decided_at: null,
      })),
      more: payload.more,
      proofs: payload.proofs,
      status: "open",
      closed_at: null,
    };
  },
  [COURSE_EVENT_TYPES.decided]: (draft, event) => {
    const payload = event.payload as CourseDecidedPayload;
    const course = courseById(draft.state, payload.course);
    if (actingAgent(event) === undefined || course === undefined || course.status !== "open") {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    let applied = 0;
    for (const decision of payload.decisions) {
      const item = course.stack[decision.n - 1];
      if (item === undefined || item.gesture !== null) continue;
      if (decision.gesture === "keep" && decision.reason === undefined) continue;
      if (
        decision.gesture === "retire" &&
        item.kind !== "requirement" &&
        item.kind !== "decision"
      ) {
        continue;
      }
      item.gesture = decision.gesture;
      item.reason = decision.reason ?? null;
      item.decided_at = event.at;
      applied += 1;
    }
    if (applied === 0) draft.ignored.push({ id: event.id, reason: "invalid" });
  },
  [COURSE_EVENT_TYPES.closed]: (draft, event) => {
    const payload = event.payload as CourseClosedPayload;
    const course = courseById(draft.state, payload.course);
    if (
      actingAgent(event) === undefined ||
      course === undefined ||
      course.status !== "open" ||
      undecided(course).length > 0
    ) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    course.status = "closed";
    course.closed_at = event.at;
  },
};
