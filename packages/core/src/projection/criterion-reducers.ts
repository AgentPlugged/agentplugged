import { CRITERION_EVENT_TYPES, type CriterionRecordedPayload } from "@agentplugged/protocol";
import { currentDeveloper } from "../agents/agent-aliases.js";
import type { CriterionRecord, CriterionRun } from "../criteria/criterion-rules.js";
import { proofDecisions } from "../proofs/proof-accord.js";
import { actingAgent, agentOf, dictionary, type StoryState, section } from "./agent-reducers.js";
import type { ProjectionDraft, Reducer } from "./reducers.js";

/**
 * The reducer of the criteria of a story: `story.criterion_recorded` is a run of the
 * test of a criterion, or the declaration that it cannot be tested through the interface. Accepted
 * from the story's developer only, for a story started and not merged. A run the engine made carries
 * the command the creator accepted (its fingerprint is in the journal's decisions, under that name)
 * and an end that is a verdict: the command exited, 0 for green and any other code for red; a command
 * stopped at its time limit or never started says nothing about the criterion. Ignored (`invalid`)
 * otherwise.
 *
 * Per criterion: a failing run opens the cycle (`red`, and clears what came before); the latest
 * passing run after it is the `green`; a passing run with no failure before it is `passed` only, a
 * test that was never seen failing.
 */

function refuse(draft: ProjectionDraft, id: string): void {
  draft.ignored.push({ id, reason: "invalid" });
}

function storyOf(draft: ProjectionDraft, id: string | undefined): StoryState | undefined {
  if (id === undefined) return undefined;
  const stories = section<StoryState>(draft, "stories");
  return Object.hasOwn(stories, id) ? stories[id] : undefined;
}

/** True when the engine's run is a verdict that agrees with the result the event states. */
function verdictAgrees(payload: CriterionRecordedPayload): boolean {
  const run = payload.run;
  if (run === undefined) return true;
  if (run.ended !== "exit" || run.exit === null) return false;
  return (run.exit === 0) === (payload.result === "green");
}

export const CRITERION_REDUCERS: Readonly<Record<string, Reducer>> = {
  [CRITERION_EVENT_TYPES.recorded]: (draft, event) => {
    const payload = event.payload as CriterionRecordedPayload;
    const story = storyOf(draft, event.story);
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
    const run = payload.run;
    if (run !== undefined) {
      const accepted = proofDecisions(draft.state).accepted.get(run.fingerprint);
      if (accepted === undefined || accepted.name !== run.command || !verdictAgrees(payload)) {
        refuse(draft, event.id);
        return;
      }
    }
    agentOf(draft, event);
    story.criteria ??= dictionary<CriterionRecord>();
    const criteria = story.criteria;
    const key = String(payload.criterion);
    const record: CriterionRecord = Object.hasOwn(criteria, key)
      ? (criteria[key] as CriterionRecord)
      : { runs: 0 };
    criteria[key] = record;
    if (payload.result === "untestable") {
      record.untestable = {
        reason: payload.reason ?? "",
        at: event.at,
        event: event.id,
      };
      return;
    }
    // A run lifts the declaration: the criterion turned out to be testable.
    delete record.untestable;
    record.runs += 1;
    const seen: CriterionRun = {
      origin: payload.origin,
      test: payload.test ?? run?.command ?? "",
      commit: payload.commit ?? run?.commit ?? null,
      clean: payload.clean ?? run?.clean ?? null,
      at: event.at,
      event: event.id,
    };
    if (payload.result === "red") {
      record.red = seen;
      delete record.green;
      delete record.passed;
    } else if (record.red !== undefined) {
      // The latest passing run after the failure: a green made before the code was committed is
      // replaced by the one made after it.
      record.green = seen;
    } else if (record.red === undefined && record.green === undefined) {
      record.passed ??= seen;
    }
  },
};
