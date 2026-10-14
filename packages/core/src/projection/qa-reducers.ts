import {
  criterionId,
  QA_COMMAND,
  QA_EVENT_TYPES,
  type QaReportedPayload,
  qaProofBelongs,
} from "@agentplugged/protocol";
import { currentDeveloper } from "../agents/agent-aliases.js";
import { proofDecisions } from "../proofs/proof-accord.js";
import type { QaRecord, QaResult } from "../qa/qa-rules.js";
import { actingAgent, agentOf, type StoryState, section } from "./agent-reducers.js";
import type { ProjectionDraft, Reducer } from "./reducers.js";

/**
 * The reducer of the acceptance QA of a story: `story.qa_reported` is the closed report
 * of an agent who is not the story's developer, for a story started and not merged. Each proof lies
 * in the proofs folder and carries its criterion's id; a result the engine played carries the
 * command the creator accepted under the name `qa` (its fingerprint is in the journal's decisions)
 * and a verdict that agrees with how it ended: passed on exit 0, failed on another exit code,
 * blocked otherwise or when no proof file was kept. Ignored (`invalid`) otherwise. The report
 * replaces the previous one whole.
 */

function refuse(draft: ProjectionDraft, id: string): void {
  draft.ignored.push({ id, reason: "invalid" });
}

function storyOf(draft: ProjectionDraft, id: string | undefined): StoryState | undefined {
  if (id === undefined) return undefined;
  const stories = section<StoryState>(draft, "stories");
  return Object.hasOwn(stories, id) ? stories[id] : undefined;
}

/** True when the result agrees with how the engine's run ended. */
function agrees(result: QaReportedPayload["results"][number]): boolean {
  const run = result.run;
  if (run === undefined) return true;
  const exited = run.ended === "exit" && run.exit !== null;
  if (result.verdict === "passed") return exited && run.exit === 0;
  if (result.verdict === "failed") return exited && run.exit !== 0;
  return true;
}

export const QA_REDUCERS: Readonly<Record<string, Reducer>> = {
  [QA_EVENT_TYPES.reported]: (draft, event) => {
    const payload = event.payload as QaReportedPayload;
    const story = storyOf(draft, event.story);
    const by = actingAgent(event);
    const started = story?.started;
    if (
      story === undefined ||
      started === undefined ||
      event.story === undefined ||
      story.merged !== undefined ||
      by === undefined ||
      currentDeveloper(by) === currentDeveloper(started.agent)
    ) {
      refuse(draft, event.id);
      return;
    }
    const accepted = proofDecisions(draft.state).accepted;
    for (const result of payload.results) {
      const id = criterionId(event.story, result.criterion);
      const run = result.run;
      const lawful =
        result.proofs.every((proof) => qaProofBelongs(proof.path, id)) &&
        agrees(result) &&
        (run === undefined ||
          (run.command === QA_COMMAND && accepted.get(run.fingerprint)?.name === QA_COMMAND));
      if (!lawful) {
        refuse(draft, event.id);
        return;
      }
    }
    agentOf(draft, event);
    const results: Record<string, QaResult> = Object.create(null);
    for (const result of payload.results) {
      results[String(result.criterion)] = {
        verdict: result.verdict,
        origin: result.origin,
        proofs: result.proofs,
        observed: result.observed ?? null,
      };
    }
    const outside: Record<string, string> = Object.create(null);
    for (const entry of payload.outside) outside[String(entry.criterion)] = entry.reason;
    const record: QaRecord = {
      at: event.at,
      by,
      event: event.id,
      commit: payload.commit ?? null,
      clean: payload.clean ?? null,
      results,
      outside,
    };
    story.qa = record;
  },
};
