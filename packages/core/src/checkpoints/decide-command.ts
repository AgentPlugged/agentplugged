import {
  CHECKPOINT_DECIDED_EVENT_TYPES,
  type DecideCheckpointInput,
  DecideCheckpointInputSchema,
  ErrorCode,
  NOAH_AGENT,
  type ProjectionState,
} from "@agentplugged/protocol";
import {
  agentEventCommand,
  defined,
  type EventSpec,
  planned,
  project as projectListing,
  type RecordedEvent,
} from "../agent-activity/agent-commands.js";
import { withPendingMerge } from "../chat/answer-finish.js";
import {
  type ResolvedValidationSettings,
  resolveValidationSettings,
} from "../chat/validation-settings.js";
import { mergeHold } from "../ci/ci-rules.js";
import { defineCommand, fail, ok } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { storyFiles } from "../merge/story-files.js";
import {
  afterMerge,
  type MergeDone,
  type MergeResult,
  mergedEvent,
  mergeFailed,
  mergeStory,
  mergesOn,
  notePendingMerge,
  notRecorded,
  pendingMergeOf,
} from "../merge/story-merge.js";
import type { StoryState } from "../projection/agent-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { checkpointsOf } from "../projection/checkpoint-reducers.js";
import { mergeHead } from "../review/merge-head.js";
import { delegationOf, delegationVerdict, type NotDelegated } from "./point-rules.js";
import { answerable, resolutionProblem, statusAt } from "./resolution-rules.js";

/**
 * `decide_checkpoint`: the agent responsible for a point decides it, because the
 * creator did not keep that kind of point for themselves (`validation.points` of `method.yaml`).
 * Written as the agent (`actor.kind: agent`, `source: agent`), signed by the machine key, with the
 * reason: never as the creator. The creator can reopen it at any time (`answer_checkpoint`
 * `reopen`, quoting their words).
 */

/** What `decide_checkpoint` reads before the journal lock: the settings, the merge. */
interface DecidePrepared {
  readonly settings: ResolvedValidationSettings;
  /** The head of the story's branch, for its merge checkpoint, when Git reads it. */
  readonly head?: string;
  /** An approved story's merge checkpoint: the merge the engine did at the forge, or why not. */
  readonly merge?: MergeDone | AgentPluggedError;
}

/** What each reason a point is the creator's says, for the agent that tried to decide it. */
const WHY: Readonly<Record<NotDelegated, string>> = {
  not_configured:
    "the creator has not chosen which points they keep yet: every point waits for them (present it to them, and offer them to choose their points with request_creator_action profile)",
  escalation:
    "this point asks for the creator's own gesture or for their help (an action of theirs, a memory change, an installation, a blocked result, a conflict, a review loop): only they answer it",
  kept: "the creator keeps this kind of point for themselves: only they answer it",
  strict_high_risk:
    "the strict level keeps a high risk point for the creator (the terminal and their key)",
  reopened: "the creator reopened this point: it waits for their own answer",
  touches_settings:
    "this story changes .agentplugged/method.yaml, which holds the creator's own settings (their points, their level): only they merge it (escalate)",
  escalated: "an agent handed this point back to the creator: it waits for their own answer",
};

/** `INVALID_ARGUMENTS` that names why the point is not the agents' to decide. */
function reserved(checkpoint: string, why: NotDelegated): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
    command: "decide_checkpoint",
    field: "checkpoint",
    checkpoint,
    why,
    reason: `decide_checkpoint: checkpoint: ${WHY[why]}`,
  });
}

/**
 * The events `decide_checkpoint` writes, or why it is refused. Checked in this order, on the state
 * as it is when written:
 * 1. the checkpoint exists (`CHECKPOINT_NOT_FOUND`) and is open (`CHECKPOINT_NOT_OPEN`);
 * 2. the creator did not keep it: their settings leave it to the agents, it is no escalation, no
 *    action of theirs, not reopened by them, and not a high risk at the `strict` level
 *    (`INVALID_ARGUMENTS`, `why`);
 * 3. the decision fits it (an option it has, a note when it needs one: the reason), and its merge
 *    gate is open (`MERGE_NOT_READY`);
 * 4. an approved story's merge is done by the engine at the forge before the write, `story.merged`
 *    in it right after the decision (`mergeStory`).
 */
export function decidePlan(
  input: DecideCheckpointInput,
  state: ProjectionState["state"],
  prepared: DecidePrepared,
  now: number,
  /** `dry`: everything but the merge of an approved story (checked before the forge merges). */
  options: { readonly dry?: boolean } = {},
): EventSpec[] | AgentPluggedError {
  const checkpoints = checkpointsOf(state);
  const id = input.checkpoint;
  if (!Object.hasOwn(checkpoints, id)) {
    return new AgentPluggedError(ErrorCode.CHECKPOINT_NOT_FOUND, "error.checkpoint_not_found", {
      checkpoint: id,
    });
  }
  const checkpoint = checkpoints[id] as CheckpointState;
  if (!answerable(checkpoint, now)) {
    return new AgentPluggedError(ErrorCode.CHECKPOINT_NOT_OPEN, "error.checkpoint_not_open", {
      checkpoint: id,
      status: statusAt(checkpoint, now),
    });
  }
  if (input.agent === NOAH_AGENT) {
    return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
      command: "decide_checkpoint",
      field: "agent",
      reason:
        "decide_checkpoint: agent: Noah never decides a point: hand it to the agent `next` names",
    });
  }
  const verdict = delegationVerdict(checkpoint, delegationOf(prepared.settings));
  if (!verdict.delegated) return reserved(id, verdict.why);
  const story = checkpoint.story ?? undefined;
  // Handing the point back to the creator: nothing is answered, the point waits for them.
  if (input.decision === "escalate") {
    return [
      {
        type: CHECKPOINT_DECIDED_EVENT_TYPES.decided,
        story,
        payload: { checkpoint: id, decision: "escalate", reason: input.reason },
      },
    ];
  }
  if (input.decision === "option_chosen") {
    const ids = (checkpoint.options ?? []).map((option) => option.id);
    if (input.option === undefined || !ids.includes(input.option)) {
      return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
        command: "decide_checkpoint",
        field: "option",
        reason: `decide_checkpoint: option: expected one of ${ids.join(", ") || "(no option)"}`,
      });
    }
  }
  const held = resolutionProblem(
    {
      ...checkpoint,
      ...mergeHold(state, checkpoint, prepared.head === undefined ? {} : { head: prepared.head }),
    },
    {
      decision: input.decision,
      ...(input.option === undefined ? {} : { option: input.option }),
      note: input.reason,
    },
    now,
  );
  if (held !== undefined) return held;
  const decided: EventSpec = {
    type: CHECKPOINT_DECIDED_EVENT_TYPES.decided,
    story,
    payload: defined({
      checkpoint: id,
      decision: input.decision,
      option: input.option,
      reason: input.reason,
    }),
  };
  if (!mergesOn(checkpoint, input.decision)) return [decided];
  if (options.dry === true) return [decided];
  const merge =
    prepared.merge ??
    mergeFailed(story ?? "", id, "forge_failed", { message: "the merge was not prepared" });
  if (merge instanceof AgentPluggedError) return merge;
  return [decided, mergedEvent(merge, "agent")];
}

const decideEvents = agentEventCommand<typeof DecideCheckpointInputSchema, DecidePrepared>({
  name: "decide_checkpoint",
  description:
    "Decide a point the creator did not keep for themselves: see the command's own description.",
  inputSchema: DecideCheckpointInputSchema,
  needsState: () => true,
  replanned: true,
  async prepare(input, context, _agents, config): Promise<DecidePrepared> {
    const settings = await resolveValidationSettings(config, context.mainBranch);
    const prepared: DecidePrepared = { settings };
    if (context.journal === undefined) return prepared;
    // A pull request the creator already merged on the forge is recorded first.
    await (await import("../merge/forge-follow.js")).followForge(context, { force: true });
    const state = (await projectListing(context, config, await context.journal.list())).state;
    const checkpoint = checkpointsOf(state)[input.checkpoint];
    const head = await mergeHead(context, state, checkpoint);
    const withHead = head === undefined ? prepared : { ...prepared, head };
    // An approved story's merge checkpoint: once the decision passes every other check on the
    // state as it is, the engine merges at the forge; the write follows (as for the creator's).
    if (checkpoint !== undefined && mergesOn(checkpoint, input.decision)) {
      // A story that changes the creator's own settings is never merged by an agent's decision:
      // that merge would widen the delegation without them (the settings are read on the main branch).
      const started = (state.stories as Record<string, StoryState> | undefined)?.[
        checkpoint.story ?? ""
      ]?.started;
      if (started !== undefined && head !== undefined) {
        const read = await storyFiles(context, started, head);
        if (read.files.some((file) => /(^|\/)\.agentplugged\/method\.yaml$/.test(file))) {
          return { ...withHead, merge: reserved(checkpoint.id, "touches_settings") };
        }
      }
      const now = (context.now ?? Date.now)();
      const plan = decidePlan(input, state, withHead, now, { dry: true });
      if (plan instanceof AgentPluggedError) return { ...withHead, merge: plan };
      const merge =
        pendingMergeOf(checkpoint.id, context.mergeToken) ??
        (await mergeStory(context, config, state, checkpoint, head));
      if (!(merge instanceof AgentPluggedError)) notePendingMerge(merge, context.mergeToken);
      return { ...withHead, merge };
    }
    return withHead;
  },
  ...planned(decidePlan),
});

/** What `decide_checkpoint` returns: the decision recorded, and the story merged when it was one. */
export type DecideRecorded = RecordedEvent & {
  /** The story the engine merged once its merge checkpoint was approved. */
  readonly merged?: MergeResult;
};

/**
 * `decide_checkpoint`: records the decision of the agent responsible for a point the creator did
 * not keep. See `decidePlan` for what it refuses; nothing is written on a refusal and
 * the point stays open.
 */
export const decideCheckpointCommand = defineCommand<DecideRecorded>({
  name: decideEvents.name,
  audience: "agent",
  description:
    "Decide a point of validation that the creator did not keep for themselves. The creator chooses the points that wait for them (`validation.points` in `get_state` and `next`: `fixed`); any other point is decided by the agent responsible for it, without waiting: when `next` gives the step `point_decision`, or when you opened such a point yourself, read it (`get_state`, the documents it cites), then call this with your `agent`, the `checkpoint` (G-…), your `decision` (`approved`, `approved_with_reservations`, `rejected`, `changes_requested`, or `option_chosen` with `option`) and your `reason`, in one or two sentences: it is written in the journal, shown to the creator in the morning summary, and they can reopen it at any time. When you cannot or should not decide it (a merge the forge refuses and no agent can fix, a point beyond your remit), call it with `escalate` and your reason: the point then waits for the creator. Decide on the merits, as a reviewer would: approve what meets its criteria, refuse or send back what does not; never approve to make the work go on. You never answer for the creator: a point they keep (`fixed`), an action of theirs, a memory change, an installation to validate, a blocked result, a conflict, a review loop, a point they reopened, and, at the strict level, a high risk, stay theirs (INVALID_ARGUMENTS with the `why`). Deciding a story's merge checkpoint as `approved` makes the engine merge the story's pull request itself, in the order of the graph (as when the creator approves it): its gate (green CI, review done) must be open first (MERGE_NOT_READY). Refused, nothing written: CHECKPOINT_NOT_FOUND, CHECKPOINT_NOT_OPEN, INVALID_ARGUMENTS, MERGE_NOT_READY, MERGE_FAILED.",
  inputSchema: DecideCheckpointInputSchema,
  async run(context, input) {
    // A merge done at the forge by this call is recorded with the decision, or said not recorded.
    const raw = (input as { checkpoint?: unknown }).checkpoint;
    const { result, merge } = await withPendingMerge(context, raw, (merging) =>
      decideEvents.run(merging, input),
    );
    if (!result.ok) {
      // A merge nobody can do (the forge refuses, the story touches the settings): the point goes
      // back to the creator with the reason, so that `next` does not offer it again and again.
      if (
        result.error.code === ErrorCode.MERGE_FAILED ||
        result.error.code === ErrorCode.INVALID_ARGUMENTS
      ) {
        const details = result.error.toPayload().details as Record<string, unknown>;
        if (result.error.code === ErrorCode.MERGE_FAILED || details.why === "touches_settings") {
          await decideEvents.run(context, {
            agent: (input as { agent?: string }).agent,
            checkpoint: raw,
            decision: "escalate",
            reason:
              `The merge cannot be done by an agent: ${String(details.reason ?? details.why ?? result.error.code)}`.slice(
                0,
                900,
              ),
          });
        }
      }
      return merge === undefined || !(result.error instanceof AgentPluggedError)
        ? result
        : fail(notRecorded(merge, result.error));
    }
    if (merge === undefined) return ok(result.value);
    return ok({ ...result.value, merged: await afterMerge(context, merge) });
  },
});
