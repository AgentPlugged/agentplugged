import {
  CI_EVENT_TYPES,
  type CiForge,
  type CiReportedPayload,
  type CiStatus,
  type CiWaivedPayload,
  type EventEnvelope,
  MACHINE_DEVICE_PATTERN,
} from "@agentplugged/protocol";
import { isSkipped } from "../journey/journey-rules.js";
import { storyDoneAt } from "../sprints/sprint-rules.js";
import { agentOf, type StoryState, storyById } from "./agent-reducers.js";
import type { CheckpointState } from "./checkpoint-reducers.js";
import { untrustedAnswer } from "./human-reducers.js";
import type { ProjectionDraft, Reducer } from "./reducers.js";

/**
 * `state.stories[id].ci`: the last CI read of the story's pull request, or the
 * creator's acceptance of a story whose CI cannot be read (`waived`), for one commit.
 */
export interface StoryCi {
  readonly status: CiStatus | "waived";
  /** The forge read; absent for a waiver. */
  readonly forge?: CiForge;
  readonly checks: number;
  readonly failed: readonly string[];
  readonly pr?: number;
  readonly url?: string;
  /** The head of the story's branch it covers. */
  readonly commit: string;
  /** When the forge was read, or the waiver given: compared with the story's last status. */
  readonly at: string;
  readonly event: string;
  /** Who read it (the agent, or the machine `machine:…` for the CLI), or the creator's device. */
  readonly by: string;
  /** Why the creator accepted the story without its CI (a waiver only). */
  readonly reason?: string;
}

/** The story an event of its CI may change: started and not done, else undefined. */
export function openStory(draft: ProjectionDraft, event: EventEnvelope): StoryState | undefined {
  const stories = draft.state.stories as Record<string, StoryState> | undefined;
  const id = event.story;
  if (id === undefined || stories === undefined || !Object.hasOwn(stories, id)) return undefined;
  const story = storyById(draft, id);
  const checkpoints = Object.values(
    (draft.state.checkpoints as Record<string, CheckpointState> | undefined) ?? {},
  );
  if (story.started === undefined || storyDoneAt(checkpoints, id, story) !== undefined) {
    return undefined;
  }
  return story;
}

/**
 * The reducers of a story's CI.
 * - `story.ci_reported` records the last read (`ci`). A failed CI sends a story in review back to
 *   `in_progress`, given by the agent that builds it (its `story.started`): `next` relaunches that
 *   agent on the same branch. A blocked story stays blocked, a story in progress stays in progress.
 *   Ignored (`invalid`): an actor that is neither an agent nor a machine's system, an event without
 *   a story, a story never started, a story done.
 * - `story.ci_waived`, the creator's own event, records that the creator accepts the story without
 *   a readable CI for one commit. Ignored: a signer the product does not trust, a story never
 *   started or done.
 */
export const CI_REDUCERS: Readonly<Record<string, Reducer>> = {
  [CI_EVENT_TYPES.reported]: (draft: ProjectionDraft, event) => {
    const payload = event.payload as CiReportedPayload;
    const agent = event.actor.kind === "agent" ? event.actor.agent : undefined;
    const device =
      event.actor.kind === "system" && MACHINE_DEVICE_PATTERN.test(event.actor.device)
        ? event.actor.device
        : undefined;
    const by = agent ?? device;
    const story = by === undefined ? undefined : openStory(draft, event);
    if (by === undefined || story === undefined) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    const started = story.started as NonNullable<StoryState["started"]>;
    if (agent !== undefined) agentOf(draft, event);
    story.ci = {
      status: payload.status,
      forge: payload.forge,
      checks: payload.checks,
      failed: [...payload.failed],
      ...(payload.pr === undefined ? {} : { pr: payload.pr }),
      ...(payload.url === undefined ? {} : { url: payload.url }),
      commit: payload.commit,
      at: payload.read_at,
      event: event.id,
      by,
    };
    if (
      payload.status === "fail" &&
      story.status === "in_review" &&
      !isSkipped(draft.state, "story_ci", event.story)
    ) {
      story.status = "in_progress";
      story.status_by = { agent: started.agent, at: event.at };
    }
  },
  [CI_EVENT_TYPES.waived]: (draft: ProjectionDraft, event) => {
    const payload = event.payload as CiWaivedPayload;
    const refusal = event.actor.kind === "human" ? untrustedAnswer(draft, event) : "invalid";
    if (refusal !== undefined) {
      draft.ignored.push({ id: event.id, reason: refusal });
      return;
    }
    const applied = applyCiWaiver(draft, event.story, {
      commit: payload.commit,
      reason: payload.reason,
      at: event.at,
      event: event.id,
      by: event.actor.device,
    });
    if (!applied) draft.ignored.push({ id: event.id, reason: "invalid" });
  },
};

/**
 * The creator's acceptance of a story without a readable CI, for one commit: the effect of
 * `story.ci_waived` at the terminal and of a `ci_waive` the creator approved from the chat (story
 * 2.16). False, nothing changed, when the story is not started or done.
 */
export function applyCiWaiver(
  draft: ProjectionDraft,
  id: string | undefined,
  waiver: {
    readonly commit: string;
    readonly reason: string;
    readonly at: string;
    readonly event: string;
    readonly by: string;
  },
): boolean {
  const story = id === undefined ? undefined : openStory(draft, { story: id } as EventEnvelope);
  if (story === undefined) return false;
  story.ci = {
    status: "waived",
    checks: 0,
    failed: [],
    commit: waiver.commit,
    at: waiver.at,
    event: waiver.event,
    by: waiver.by,
    reason: waiver.reason,
  };
  return true;
}
