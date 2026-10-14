import { wipeBytes } from "@agentplugged/crypto";
import {
  ErrorCode,
  LESSON_EVENT_TYPES,
  type LessonsRecordedPayload,
  type MethodConfig,
  type ProjectionState,
  RecordLessonsInputSchema,
  type RetiredLesson,
} from "@agentplugged/protocol";
import {
  agentEventCommand,
  agentWriteContext,
  invalidInput,
  projectWithKey,
  type RecordedEvent,
} from "../agent-activity/agent-commands.js";
import { type CommandContext, defineCommand, fail, ok } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { forgetProductKey } from "../journal/product-key.js";
import { checkpointsOf } from "../projection/checkpoint-reducers.js";
import { sensitiveKey } from "../sensitive/sensitive-commands.js";
import {
  type CommonEntry,
  memoryInvalid,
  openCommonKey,
  readCommonEntry,
  readLessonFile,
  writeCommonEntry,
  writeLessonFile,
} from "./memory-files.js";
import {
  activeLessonIds,
  anchorsOf,
  approved,
  batchesOf,
  type LessonRecord,
  lessonRecord,
  memoryOf,
  type RetroLesson,
  type RetroState,
  recordDigest,
  retroOfCheckpoint,
} from "./memory-rules.js";

/** What recording decided: the lessons kept (with their record) and what they retire. */
interface RecordPlan {
  readonly retro: RetroState;
  readonly kept: readonly {
    readonly lesson: RetroLesson;
    readonly record: LessonRecord;
    readonly digest: string;
  }[];
  readonly retired: readonly RetiredLesson[];
  readonly excepted: readonly string[];
  /** Targets no longer active (retired meanwhile): left alone, said in the result. */
  readonly skipped: readonly string[];
}

type State = ProjectionState["state"];

/**
 * The plan to record an approved retrospective, or the refusal: the checkpoint is a retrospective's
 * and approved; `except` only leaves out, only under reservations; what is retired or replaced is
 * still active; the memory has room. Pure: read again under the journal lock.
 */
function recordPlan(
  input: { readonly checkpoint: string; readonly except?: readonly string[] | undefined },
  state: State,
  now: number,
): RecordPlan | AgentPluggedError {
  const checkpoints = checkpointsOf(state);
  const checkpoint = Object.hasOwn(checkpoints, input.checkpoint)
    ? checkpoints[input.checkpoint]
    : undefined;
  const memory = memoryOf(checkpoint);
  const retro = retroOfCheckpoint(state, input.checkpoint);
  if (checkpoint === undefined || memory?.kind !== "retrospective" || retro === undefined) {
    return memoryInvalid("unknown_checkpoint", { checkpoint: input.checkpoint });
  }
  if (!approved(checkpoint, now)) {
    return memoryInvalid("not_approved", {
      checkpoint: input.checkpoint,
      status: checkpoint.resolution?.decision ?? checkpoint.status,
      decision: checkpoint.resolution?.decision ?? null,
    });
  }
  if ((checkpoint.memory_done ?? null) !== null) {
    return memoryInvalid("already_recorded", { checkpoint: input.checkpoint });
  }
  const except = [...new Set(input.except ?? [])];
  const reserved = checkpoint.resolution?.decision === "approved_with_reservations";
  if (except.length > 0 && !reserved) {
    return memoryInvalid("except_not_allowed", {
      decision: checkpoint.resolution?.decision ?? null,
    });
  }
  // Reservations name what they leave out: an agent that forgets cannot record everything.
  if (reserved && input.except === undefined) {
    return memoryInvalid("except_required", { checkpoint: input.checkpoint });
  }
  const known = new Set([
    ...retro.lessons.map((lesson) => lesson.id),
    ...retro.retire.map((r) => r.lesson),
    ...retro.actions.map((action) => action.id),
  ]);
  const stranger = except.find((id) => !known.has(id));
  if (stranger !== undefined) return memoryInvalid("except_unknown", { lesson: stranger });
  const left = new Set(except);
  const kept = retro.lessons
    .filter((lesson) => !left.has(lesson.id))
    .map((lesson) => {
      const record = lessonRecord(retro, lesson);
      return { lesson, record, digest: recordDigest(record) };
    });
  const wanted: RetiredLesson[] = [
    ...kept.flatMap(({ lesson }) =>
      (lesson.replaces ?? []).map((target) => ({ lesson: target, by: lesson.id })),
    ),
    ...retro.retire
      .filter((entry) => !left.has(entry.lesson))
      .map((entry) => ({ lesson: entry.lesson })),
  ];
  // A target another retrospective retired since the proposal is left alone: an approved point
  // never stays impossible to record (it would stop `next` for good).
  const active = new Set(activeLessonIds(state, checkpoints, now));
  const retired = wanted.filter((entry) => active.has(entry.lesson));
  const skipped = wanted.filter((entry) => !active.has(entry.lesson)).map((entry) => entry.lesson);
  return { retro, kept, retired, excepted: except, skipped };
}

/** The state of the product with the content this machine can decrypt, in memory only. */
async function keyedState(context: CommandContext, config: MethodConfig): Promise<State> {
  const journal = context.journal;
  if (journal === undefined) throw new Error("no journal is available here");
  const listing = await journal.list();
  return (await projectWithKey(context, config, listing)).projection.state;
}

const events = agentEventCommand<typeof RecordLessonsInputSchema>({
  name: "record_lessons",
  description: "",
  inputSchema: RecordLessonsInputSchema,
  needsState: () => true,
  keyed: true,
  events(input, state, _prepared, now) {
    const plan = state === undefined ? undefined : recordPlan(input, state, now);
    // A refused plan is never written: `check` refuses it first, under the journal lock.
    const ready = plan instanceof AgentPluggedError || plan === undefined ? undefined : plan;
    const payload: LessonsRecordedPayload = {
      checkpoint: input.checkpoint,
      retro: ready?.retro.id ?? "R-0000000000",
      lessons: (ready?.kept ?? []).map(({ lesson, digest }) => ({ id: lesson.id, digest })),
      retired: [...(ready?.retired ?? [])],
      excepted: [...(ready?.excepted ?? [])],
    };
    return { events: [{ type: LESSON_EVENT_TYPES.recorded, payload }] };
  },
  check(input, state, { now }) {
    const plan = recordPlan(input, state, now);
    return plan instanceof AgentPluggedError ? plan : undefined;
  },
});

/** What `record_lessons` returns: the event, the lessons now served, the lessons retired. */
export type LessonsRecorded = RecordedEvent & {
  readonly recorded: readonly string[];
  readonly retired: readonly string[];
  /** The files rewritten by a second call (a file lost or altered since the first). */
  readonly repaired: readonly string[];
  /** Lessons to retire or replace that were no longer active: left alone. */
  readonly skipped: readonly string[];
};

/**
 * Writes the files a recorded retrospective owes: each kept lesson (when its file is missing or
 * altered), and the common copies of the lessons that were retired or replaced. Idempotent: what
 * is right is left alone. Returns the lessons written.
 */
async function materialize(
  context: CommandContext,
  product: string,
  key: Uint8Array,
  state: State,
  lessons: readonly {
    readonly id: string;
    readonly record: LessonRecord;
    readonly digest: string;
  }[],
  retired: readonly RetiredLesson[],
): Promise<string[]> {
  const written: string[] = [];
  for (const { id, record, digest } of lessons) {
    const current = await readLessonFile(context, product, key, id, digest);
    if (current.ok) continue;
    await writeLessonFile(context, product, key, record);
    written.push(id);
  }
  const anchors = anchorsOf(state);
  const copies = retired.flatMap((entry) =>
    (Object.hasOwn(anchors, entry.lesson) ? (anchors[entry.lesson]?.promoted ?? []) : []).map(
      (promoted) => ({ common: promoted.common, by: entry.by }),
    ),
  );
  if (copies.length > 0 && context.commonMemory !== undefined) {
    const commonKey = await openCommonKey(context);
    if (commonKey !== undefined) {
      try {
        for (const copy of copies) {
          const read = await readCommonEntry(context.commonMemory, commonKey, copy.common);
          if (!read.ok || read.entry.status !== "active") continue;
          const next: CommonEntry = {
            ...read.entry,
            status: copy.by === undefined ? "retired" : "superseded",
            ...(copy.by === undefined ? {} : { superseded_by: copy.by }),
          };
          await writeCommonEntry(context.commonMemory, commonKey, next);
        }
      } finally {
        await wipeBytes(commonKey);
      }
    }
  }
  return written;
}

/**
 * `record_lessons`: once the creator approved a retrospective, records its lessons:
 * `lessons.recorded` (clear: ids and digests), then a file per lesson in `memory/lessons/`,
 * encrypted with the product key. Called again on a recorded retrospective, it rewrites the files
 * that are missing or altered, from the journal, without a second event.
 */
export const recordLessonsCommand = defineCommand<LessonsRecorded>({
  name: "record_lessons",
  audience: "agent",
  description:
    "Record the lessons of a retrospective the creator approved: `checkpoint` is its `memory` checkpoint (from propose_retrospective). With `approved_with_reservations`, `except` is required (an empty list when the reservations leave nothing out: `except_required` otherwise) and lists the ids the creator wants left out: lessons, lessons the retrospective retires, actions (`R-…-A1`); it only ever removes, and is refused with `approved` (`except_not_allowed`). A lesson to retire or replace that is no longer active is left alone (`skipped`). Refused with MEMORY_INVALID, nothing written: `unknown_checkpoint`, `not_approved` (open, refused, or another decision), `already_recorded`, `except_unknown`, `except_required`, `except_not_allowed`. It writes `lessons.recorded` (identifiers and digests, no text) and one encrypted file per lesson in `memory/lessons/`; a lesson replaced or retired stops being served, its shared copy too. If the files fail after the event, call it again on the same checkpoint: it rewrites the missing ones, no second event (`repaired`). Returns `recorded` (the lessons now served, from this retrospective) and `retired`. Tell the creator in one line what was recorded.",
  inputSchema: RecordLessonsInputSchema,
  async run(context, input) {
    const parsed = RecordLessonsInputSchema.safeParse(input);
    if (!parsed.success) return fail(invalidInput("record_lessons", parsed.error));
    const target = await agentWriteContext(context, parsed.data.agent);
    if (target instanceof AgentPluggedError) return fail(target);
    let key: Awaited<ReturnType<typeof sensitiveKey>> | undefined;
    try {
      key = await sensitiveKey(context, target.journal, target.product);
      const now = (context.now ?? Date.now)();
      const before = await keyedState(context, target.config);
      const done = Object.hasOwn(checkpointsOf(before), parsed.data.checkpoint)
        ? checkpointsOf(before)[parsed.data.checkpoint]?.memory_done
        : undefined;
      if (done !== undefined && done !== null) {
        // Recorded already: only a repair of the files, from the journal.
        const checkpoint = checkpointsOf(before)[parsed.data.checkpoint];
        const retro = retroOfCheckpoint(before, parsed.data.checkpoint);
        const batch = batchesOf(before).find(
          (entry) => entry.checkpoint === parsed.data.checkpoint,
        );
        if (checkpoint === undefined || retro === undefined || batch === undefined) {
          return fail(memoryInvalid("unknown_checkpoint", { checkpoint: parsed.data.checkpoint }));
        }
        if (!approved(checkpoint, now)) {
          return fail(
            memoryInvalid("not_approved", {
              checkpoint: parsed.data.checkpoint,
              status: "not approved",
            }),
          );
        }
        const anchors = anchorsOf(before);
        const owed = retro.lessons
          .filter((lesson) => Object.hasOwn(anchors, lesson.id))
          .map((lesson) => ({
            id: lesson.id,
            record: lessonRecord(retro, lesson),
            digest: anchors[lesson.id]?.digest ?? "",
          }));
        const repaired = await materialize(
          context,
          target.product,
          key.key,
          before,
          owed,
          batch.retired,
        );
        return ok({
          id: done.event,
          type: LESSON_EVENT_TYPES.recorded,
          at: done.at,
          checkpoint: parsed.data.checkpoint,
          recorded: owed.map((entry) => entry.id),
          retired: batch.retired.map((entry) => entry.lesson),
          repaired,
          skipped: [],
        });
      }
      const plan = recordPlan(parsed.data, before, now);
      if (plan instanceof AgentPluggedError) return fail(plan);
      const written = await events.run(context, input);
      if (!written.ok) return fail(written.error);
      try {
        await materialize(
          context,
          target.product,
          key.key,
          before,
          plan.kept.map(({ lesson, record, digest }) => ({ id: lesson.id, record, digest })),
          plan.retired,
        );
      } catch (error) {
        // The lessons are recorded: say so, and how to finish.
        return fail(
          new AgentPluggedError(ErrorCode.UNEXPECTED, "error.memory_files_failed", {
            checkpoint: parsed.data.checkpoint,
            reason: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      return ok({
        ...written.value,
        checkpoint: parsed.data.checkpoint,
        recorded: plan.kept.map(({ lesson }) => lesson.id),
        retired: plan.retired.map((entry) => entry.lesson),
        repaired: [],
        skipped: [...plan.skipped],
      });
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    } finally {
      await forgetProductKey(key);
    }
  },
});
