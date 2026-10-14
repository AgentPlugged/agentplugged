import { wipeBytes } from "@agentplugged/crypto";
import {
  commonIdOf,
  ErrorCode,
  LESSON_EVENT_TYPES,
  type MethodConfig,
  PROMOTION_TITLE,
  type ProjectionState,
  PromoteLessonInputSchema,
  ProposePromotionInputSchema,
} from "@agentplugged/protocol";
import {
  agentEventCommand,
  agentWriteContext,
  invalidInput,
  projectWithKey,
  type RecordedEvent,
} from "../agent-activity/agent-commands.js";
import { checkpointPayload } from "../checkpoints/checkpoint-rules.js";
import { type CommandContext, defineCommand, fail, ok } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { forgetProductKey } from "../journal/product-key.js";
import { checkpointsOf } from "../projection/checkpoint-reducers.js";
import { sensitiveKey } from "../sensitive/sensitive-commands.js";
import type { CommonMemory } from "./common-memory.js";
import {
  type CommonEntry,
  memoryInvalid,
  openCommonKey,
  readCommonEntry,
  readLessonFile,
  writeCommonEntry,
} from "./memory-files.js";
import { anchorsOf, approved, lessonStatuses, memoryOf, promotionSummary } from "./memory-rules.js";

type State = ProjectionState["state"];

/** A cap on the entries of the common memory looked at in one call. */
const MAX_COMMON_ENTRIES = 500;

/** The ids of the active entries of this machine's common memory, or the reason it is unusable. */
async function activeCommonIds(context: CommandContext): Promise<Set<string>> {
  if (context.commonMemory === undefined) throw memoryInvalid("common_unavailable");
  const key = await openCommonKey(context);
  if (key === undefined) throw memoryInvalid("common_unavailable");
  try {
    const active = new Set<string>();
    for (const id of (await context.commonMemory.list()).slice(0, MAX_COMMON_ENTRIES)) {
      const read = await readCommonEntry(context.commonMemory, key, id);
      if (read.ok && read.entry.status === "active") active.add(id);
    }
    return active;
  } finally {
    await wipeBytes(key);
  }
}

/** What `propose_promotion` reads before the write: the active entries of the common memory. */
interface Prepared {
  readonly common: ReadonlySet<string>;
}

/**
 * `propose_promotion`: a lesson of this product proposed to the common memory of the
 * creator's products. One lesson, one checkpoint; the checkpoint carries the lesson's id and the
 * entries it replaces, in clear, and no text.
 */
export const proposePromotionCommand = agentEventCommand<
  typeof ProposePromotionInputSchema,
  Prepared
>({
  name: "propose_promotion",
  description:
    "Propose a lesson of this product to the common memory shared by all the creator's products on this machine: `lesson` is an active lesson id (from read_memory, `source: product`), `replaces` the ids of the active common entries (`source: common`) it supersedes: a lesson that contradicts a common one must replace it. One lesson per call, one `memory` checkpoint per promotion, never several at once. Refused with MEMORY_INVALID, nothing written: `lesson_unknown`, `already_promoted` (an active shared copy exists here), `promotion_pending`, `common_unknown` (a replaced entry is not active), `common_unavailable` (this machine has no machine key, or no common memory). Then present the lesson in full to the creator in the chat and ask once, since sharing it makes every product of theirs read it; nothing is shared until they approve (`answer_checkpoint`, then `promote_lesson`). Returns the checkpoint.",
  inputSchema: ProposePromotionInputSchema,
  needsState: () => true,
  async prepare(_input, context): Promise<Prepared> {
    return { common: await activeCommonIds(context) };
  },
  events(input) {
    return {
      events: [
        {
          type: "checkpoint.opened",
          payload: {
            ...checkpointPayload({
              type: "memory",
              risk: "medium",
              title: PROMOTION_TITLE,
              summary: promotionSummary(input.replaces?.length ?? 0),
            }),
            memory: {
              kind: "promotion",
              lesson: input.lesson,
              ...(input.replaces === undefined ? {} : { replaces: [...input.replaces] }),
            },
          },
        },
      ],
    };
  },
  check(input, state, { now, prepared }) {
    const checkpoints = checkpointsOf(state);
    const status = lessonStatuses(state, checkpoints, now);
    if (status.get(input.lesson) !== "active") {
      return memoryInvalid("lesson_unknown", { lesson: input.lesson });
    }
    const common = prepared?.common ?? new Set<string>();
    const anchors = anchorsOf(state);
    const copies = Object.hasOwn(anchors, input.lesson)
      ? (anchors[input.lesson]?.promoted ?? [])
      : [];
    if (copies.some((copy) => common.has(copy.common))) {
      return memoryInvalid("already_promoted", { lesson: input.lesson });
    }
    const pending = Object.values(checkpoints).some((checkpoint) => {
      const memory = memoryOf(checkpoint);
      return (
        memory?.kind === "promotion" &&
        memory.lesson === input.lesson &&
        (checkpoint.status === "open" ||
          // Approved, not carried out yet: a second one would share the lesson twice.
          ((checkpoint.memory_done ?? null) === null && approved(checkpoint, now)))
      );
    });
    if (pending) return memoryInvalid("promotion_pending", { lesson: input.lesson });
    const unknown = (input.replaces ?? []).find((id) => !common.has(id));
    if (unknown !== undefined) return memoryInvalid("common_unknown", { common: unknown });
    return undefined;
  },
});

/** What `promote_lesson` returns. */
export type LessonPromoted = RecordedEvent & {
  readonly common: string;
  readonly replaced: readonly string[];
};

const events = agentEventCommand<typeof PromoteLessonInputSchema>({
  name: "promote_lesson",
  description: "",
  inputSchema: PromoteLessonInputSchema,
  needsState: () => true,
  events(input, state) {
    const checkpoints = state === undefined ? {} : checkpointsOf(state);
    const lesson = Object.hasOwn(checkpoints, input.checkpoint)
      ? memoryOf(checkpoints[input.checkpoint])
      : undefined;
    return {
      events: [
        {
          type: LESSON_EVENT_TYPES.promoted,
          payload: {
            checkpoint: input.checkpoint,
            // A refused plan is never written: `check` refuses it first, under the journal lock.
            lesson: lesson?.kind === "promotion" ? lesson.lesson : "L-0000000000-1",
            common: commonIdOf(input.checkpoint),
          },
        },
      ],
    };
  },
  check(input, state, { now }) {
    const plan = promotionProblem(input.checkpoint, state, now);
    if (plan instanceof AgentPluggedError) return plan;
    // Done meanwhile (a concurrent call): never a second event.
    return plan.done
      ? memoryInvalid("already_recorded", { checkpoint: input.checkpoint })
      : undefined;
  },
});

/** The promotion an approved checkpoint asks, or why not. */
function promotionProblem(
  id: string,
  state: State,
  now: number,
):
  | { lesson: string; replaces: readonly string[]; done: boolean; active: boolean }
  | AgentPluggedError {
  const checkpoints = checkpointsOf(state);
  const checkpoint = Object.hasOwn(checkpoints, id) ? checkpoints[id] : undefined;
  const memory = memoryOf(checkpoint);
  if (checkpoint === undefined || memory?.kind !== "promotion") {
    return memoryInvalid("unknown_checkpoint", { checkpoint: id });
  }
  if (!approved(checkpoint, now)) {
    return memoryInvalid("not_approved", {
      checkpoint: id,
      status: checkpoint.resolution?.decision ?? checkpoint.status,
      decision: checkpoint.resolution?.decision ?? null,
    });
  }
  const done = (checkpoint.memory_done ?? null) !== null;
  const active = lessonStatuses(state, checkpoints, now).get(memory.lesson) === "active";
  if (!done && !active) return memoryInvalid("lesson_unknown", { lesson: memory.lesson });
  return { lesson: memory.lesson, replaces: memory.replaces ?? [], done, active };
}

/**
 * Writes what a promotion owes in the common memory: the entry (when it is missing here) and the
 * entries it replaces, passed to `superseded` (an entry already superseded by this promotion is
 * right as it is; one that is missing or no longer active is left alone). Idempotent.
 */
async function materialize(
  memory: CommonMemory,
  key: Uint8Array,
  entry: CommonEntry,
  replaces: readonly string[],
  writeEntry: boolean,
): Promise<void> {
  if (writeEntry) await writeCommonEntry(memory, key, entry);
  for (const id of replaces) {
    const old = await readCommonEntry(memory, key, id);
    if (!old.ok || old.entry.status !== "active") continue;
    await writeCommonEntry(memory, key, {
      ...old.entry,
      status: "superseded",
      superseded_by: entry.id,
    });
  }
}

/**
 * `promote_lesson`: once the creator approved a promotion, records `lessons.promoted`
 * (clear), then writes the lesson into the common memory of this machine (`~/.agentplugged/memory/`,
 * encrypted with the key derived from the machine key) and marks the entries it replaces. Like
 * `record_lessons`, it is safe to call again: on a promoted checkpoint it restores a missing entry,
 * only while the lesson is still active, without a second event.
 */
export const promoteLessonCommand = defineCommand<LessonPromoted>({
  name: "promote_lesson",
  audience: "agent",
  description:
    "Share a lesson with all the creator's products on this machine once they approved its promotion: `checkpoint` is the `memory` checkpoint of propose_promotion. It re-reads the lesson (decrypted, checked against its digest), records the promotion, writes the shared entry and supersedes the active entries it replaces. Refused with MEMORY_INVALID, nothing written: `unknown_checkpoint`, `not_approved`, `lesson_unknown` (no longer active), `lesson_altered` (its file does not match the journal), `common_unavailable`. If the files fail after the record (`error.memory_files_failed`), call it again on the same checkpoint: it restores them, with no second event. Returns `common` (the shared entry's id) and `replaced`. Tell the creator in one line.",
  inputSchema: PromoteLessonInputSchema,
  async run(context, input) {
    const parsed = PromoteLessonInputSchema.safeParse(input);
    if (!parsed.success) return fail(invalidInput("promote_lesson", parsed.error));
    const target = await agentWriteContext(context, parsed.data.agent);
    if (target instanceof AgentPluggedError) return fail(target);
    let key: Awaited<ReturnType<typeof sensitiveKey>> | undefined;
    let commonKey: Uint8Array | undefined;
    try {
      key = await sensitiveKey(context, target.journal, target.product);
      const now = (context.now ?? Date.now)();
      const state = await keyedState(context, target.config);
      const plan = promotionProblem(parsed.data.checkpoint, state, now);
      if (plan instanceof AgentPluggedError) return fail(plan);
      const memory = context.commonMemory;
      commonKey = await openCommonKey(context).catch(() => undefined);
      if (memory === undefined || commonKey === undefined) {
        return fail(memoryInvalid("common_unavailable"));
      }
      const common = commonIdOf(parsed.data.checkpoint);
      const anchors = anchorsOf(state);
      const anchor = Object.hasOwn(anchors, plan.lesson) ? anchors[plan.lesson] : undefined;
      // Promoted already, and the lesson retired since: nothing to restore, nothing to rewrite.
      if (plan.done && (!plan.active || anchor === undefined)) {
        const done = checkpointsOf(state)[parsed.data.checkpoint]?.memory_done;
        return ok({
          id: done?.event ?? "",
          type: LESSON_EVENT_TYPES.promoted,
          at: done?.at ?? "",
          checkpoint: parsed.data.checkpoint,
          common,
          replaced: [],
        });
      }
      if (anchor === undefined)
        return fail(memoryInvalid("lesson_unknown", { lesson: plan.lesson }));
      const read = await readLessonFile(context, target.product, key.key, anchor.id, anchor.digest);
      if (!read.ok) return fail(memoryInvalid("lesson_altered", { lesson: plan.lesson }));
      let recorded: { id: string; at: string; type: string };
      let promotedAt: string;
      if (plan.done) {
        const done = checkpointsOf(state)[parsed.data.checkpoint]?.memory_done;
        recorded = { id: done?.event ?? "", at: done?.at ?? "", type: LESSON_EVENT_TYPES.promoted };
        promotedAt = done?.at ?? new Date(now).toISOString();
      } else {
        const written = await events.run(context, input);
        if (!written.ok) return fail(written.error);
        recorded = written.value;
        promotedAt = written.value.at;
      }
      const entry: CommonEntry = {
        v: 1,
        id: common,
        status: "active",
        title: read.record.title,
        text: read.record.text,
        tags: read.record.tags,
        agents: read.record.agents,
        origin: {
          product: target.product,
          lesson: plan.lesson,
          checkpoint: parsed.data.checkpoint,
        },
        promoted_at: promotedAt,
      };
      try {
        const existing = await readCommonEntry(memory, commonKey, common);
        await materialize(memory, commonKey, entry, plan.replaces, !existing.ok);
      } catch (error) {
        // The promotion is recorded: say so, and how to finish.
        return fail(
          new AgentPluggedError(ErrorCode.UNEXPECTED, "error.memory_files_failed", {
            checkpoint: parsed.data.checkpoint,
            reason: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      return ok({
        ...recorded,
        checkpoint: parsed.data.checkpoint,
        common,
        replaced: [...plan.replaces],
      });
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    } finally {
      await forgetProductKey(key);
      if (commonKey !== undefined) await wipeBytes(commonKey);
    }
  },
});

/** The state of the product with the content this machine can decrypt, in memory only. */
async function keyedState(context: CommandContext, config: MethodConfig): Promise<State> {
  const journal = context.journal;
  if (journal === undefined) {
    throw new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
      reason: "no journal is available here",
    });
  }
  const listing = await journal.list();
  return (await projectWithKey(context, config, listing)).projection.state;
}
