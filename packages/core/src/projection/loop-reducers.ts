import {
  type AttemptRecordedPayload,
  HYPOTHESIS_KIND,
  LOOP_EVENT_TYPES,
  type LoopStoppedPayload,
  NOAH_AGENT,
} from "@agentplugged/protocol";
import { currentDeveloper } from "../agents/agent-aliases.js";
import {
  type AttemptRecord,
  isHypothesis,
  keptAttempts,
  type LoopState,
} from "../loop/loop-rules.js";
import { actingAgent, type StoryState, section } from "./agent-reducers.js";
import type { ProjectionDraft, Reducer } from "./reducers.js";

/**
 * The reducers of the bounded loop. `story.attempt_recorded` is an approach tried on
 * a story: accepted from the story's developer only, for a story started and not merged; a result
 * (`failed`, `green`) closes the approach started before it and nothing else. `loop.stopped` and
 * `loop.resumed` are Noah's: the loop is his, and a stop or a resumption any other agent wrote
 * is ignored (`invalid`).
 */

function refuse(draft: ProjectionDraft, id: string): void {
  draft.ignored.push({ id, reason: "invalid" });
}

function loopOf(draft: ProjectionDraft): LoopState {
  const existing = draft.state.loop as LoopState | undefined;
  if (existing !== undefined) return existing;
  const created: LoopState = { stopped: null };
  draft.state.loop = created;
  return created;
}

export const LOOP_REDUCERS: Readonly<Record<string, Reducer>> = {
  [LOOP_EVENT_TYPES.attempt]: (draft, event) => {
    const payload = event.payload as AttemptRecordedPayload;
    const stories = section<StoryState>(draft, "stories");
    const story =
      event.story !== undefined && Object.hasOwn(stories, event.story)
        ? stories[event.story]
        : undefined;
    const by = actingAgent(event);
    const started = story?.started;
    if (
      story === undefined ||
      started === undefined ||
      story.merged !== undefined ||
      by === undefined ||
      currentDeveloper(by) !== currentDeveloper(started.agent)
    ) {
      refuse(draft, event.id);
      return;
    }
    const records = story.attempts ?? [];
    // A hypothesis opens and closes on its own, apart from the approaches.
    const hypothesis = payload.kind === HYPOTHESIS_KIND;
    const last = records.filter((record) => isHypothesis(record) === hypothesis).at(-1);
    const open = last?.result === "started";
    // A start needs none in progress; a result closes the one in progress, which it names.
    if ((payload.result === "started") === open) {
      refuse(draft, event.id);
      return;
    }
    const record: AttemptRecord = {
      approach: payload.approach,
      result: payload.result,
      ...(payload.note === undefined ? {} : { note: payload.note }),
      ...(hypothesis ? { kind: HYPOTHESIS_KIND, confidence: payload.confidence ?? 5 } : {}),
      at: event.at,
      event: event.id,
    };
    story.attempts = keptAttempts([...records, record]);
  },
  [LOOP_EVENT_TYPES.stopped]: (draft, event) => {
    const payload = event.payload as LoopStoppedPayload;
    if (actingAgent(event) !== NOAH_AGENT) {
      refuse(draft, event.id);
      return;
    }
    loopOf(draft).stopped = {
      reason: payload.reason,
      subject: payload.subject ?? null,
      at: event.at,
      event: event.id,
    };
  },
  [LOOP_EVENT_TYPES.resumed]: (draft, event) => {
    if (actingAgent(event) !== NOAH_AGENT) {
      refuse(draft, event.id);
      return;
    }
    loopOf(draft).stopped = null;
  },
};
