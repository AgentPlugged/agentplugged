import { randomBytes, toHex } from "@agentplugged/crypto";
import {
  lessonIdOf,
  MEMORY_EVENT_TYPES,
  type ProposeRetrospectiveInput,
  ProposeRetrospectiveInputSchema,
  retroIdOf,
  retroTitle,
  scopeLabel,
} from "@agentplugged/protocol";
import { agentEventCommand, type RecordedEvent } from "../agent-activity/agent-commands.js";
import { checkpointPayload } from "../checkpoints/checkpoint-rules.js";
import { type CommandContext, defineCommand, fail, ok } from "../command.js";
import type { StoryState } from "../projection/agent-reducers.js";
import { checkpointsOf } from "../projection/checkpoint-reducers.js";
import { sprintsOf } from "../sprints/sprint-rules.js";
import { readSprintStories } from "../sprints/sprint-stories.js";
import { memoryInvalid } from "./memory-files.js";
import {
  activeLessonIds,
  overflows,
  retroSummary,
  scopeFinished,
  scopeStatus,
  targetsOf,
} from "./memory-rules.js";

/** What `propose_retrospective` reads before the write: the stories, and a salt per lesson. */
interface Prepared {
  readonly storyIds: readonly string[];
  readonly salts: readonly string[];
}

/** What `propose_retrospective` returns: the checkpoint, the retrospective and its lessons' ids. */
export type RetrospectiveProposed = RecordedEvent & {
  readonly retrospective: string;
  readonly lessons: readonly string[];
};

const base = agentEventCommand<typeof ProposeRetrospectiveInputSchema, Prepared>({
  name: "propose_retrospective",
  description:
    'Propose the retrospective of a finished epic (`scope: { kind: "epic", id: "4" }`) or sprint (`{ kind: "sprint", id: "S-…" }`) to the creator: `summary` (what you looked at: state, history, deferred work, deviations, reviews), then `lessons` (title, text, optional `tags`, `agents` the lesson is for, `replaces` the active lessons it supersedes: a lesson that contradicts an active one must replace it), `retire` (an active lesson that is no longer true, with its reason) and `actions` (follow-ups, with an optional owner), at least one of them. Read `read_memory` first. The engine refuses with MEMORY_INVALID, nothing written: `unknown_scope`, `scope_not_finished` (a story of the epic is not done, or the sprint is running), `scope_taken` (a retrospective of this scope is open or approved), `lesson_unknown` (a lesson to replace or retire is not active here), `lesson_conflict` (one lesson replaced or retired twice), `memory_full`. Otherwise it writes, in one go, a `memory` checkpoint (counts only, never a text) and the encrypted proposal, and returns the checkpoint (`checkpoint`), the retrospective (`retrospective`) and the id of each lesson (`lessons`). Then present every lesson, retirement and action to the creator in the chat, and ask once; nothing is recorded until they approve (`answer_checkpoint`, then `record_lessons`). Needs the product key (PRODUCT_KEY_MISSING).',
  inputSchema: ProposeRetrospectiveInputSchema,
  needsState: () => true,
  async prepare(input, context: CommandContext): Promise<Prepared> {
    return {
      storyIds: [...(await readSprintStories(context.files)).keys()],
      salts: (input.lessons ?? []).map(() => toHex(randomBytes(16))),
    };
  },
  events(input, _state, prepared) {
    const lessons = input.lessons ?? [];
    const { ids } = targetsOf(lessons, input.retire ?? []);
    const replaced = new Set(lessons.flatMap((lesson) => lesson.replaces ?? []));
    return {
      own: 1,
      events: [
        {
          type: "checkpoint.opened",
          payload: {
            ...checkpointPayload({
              type: "memory",
              risk: "low",
              title: retroTitle(input.scope),
              summary: retroSummary({
                lessons: lessons.length,
                replaced: [...replaced],
                retired: ids.filter((id) => !replaced.has(id)),
                actions: input.actions?.length ?? 0,
              }),
            }),
            memory: { kind: "retrospective", scope: input.scope },
          },
        },
        {
          type: MEMORY_EVENT_TYPES.retrospectiveProposed,
          payload: {
            scope: input.scope,
            summary: input.summary,
            lessons: lessons.map((lesson, index) => ({
              ...lesson,
              salt: prepared?.salts[index] ?? "",
            })),
            retire: input.retire ?? [],
            actions: input.actions ?? [],
          },
          checkpointField: "checkpoint",
        },
      ],
    };
  },
  check(input, state, { now, prepared }) {
    const checkpoints = checkpointsOf(state);
    const found = scopeFinished(input.scope, {
      storyIds: prepared?.storyIds ?? [],
      stories: (state.stories as Record<string, StoryState> | undefined) ?? {},
      checkpoints,
      sprints: sprintsOf(state),
      now,
    });
    if (found === "unknown")
      return memoryInvalid("unknown_scope", { scope: scopeLabel(input.scope) });
    if (found === "running")
      return memoryInvalid("scope_not_finished", { scope: scopeLabel(input.scope) });
    const status = scopeStatus(Object.values(checkpoints), input.scope, now);
    if (status === "open" || status === "approved") {
      return memoryInvalid("scope_taken", { scope: scopeLabel(input.scope), status });
    }
    const lessons = input.lessons ?? [];
    const targets = targetsOf(lessons, input.retire ?? []);
    if (targets.duplicate) return memoryInvalid("lesson_conflict");
    const active = new Set(activeLessonIds(state, checkpoints, now));
    const unknown = targets.ids.find((id) => !active.has(id));
    if (unknown !== undefined) return memoryInvalid("lesson_unknown", { lesson: unknown });
    if (overflows(active.size, targets.ids.length, lessons.length)) {
      return memoryInvalid("memory_full", { active: active.size });
    }
    return undefined;
  },
});

/** `propose_retrospective`: see the description of the tool. */
export const proposeRetrospectiveCommand = defineCommand<RetrospectiveProposed>({
  ...base,
  async run(context, input) {
    const result = await base.run(context, input);
    if (!result.ok) return fail(result.error);
    const parsed: ProposeRetrospectiveInput = ProposeRetrospectiveInputSchema.parse(input);
    const retrospective = retroIdOf(result.value.id);
    return ok({
      ...result.value,
      retrospective,
      lessons: (parsed.lessons ?? []).map((_, index) => lessonIdOf(retrospective, index + 1)),
    });
  },
});
