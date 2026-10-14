import { wipeBytes } from "@agentplugged/crypto";
import {
  DEFAULT_READ_LIMIT,
  ErrorCode,
  type MemoryWarningCode,
  RETRO_ACTIONS_SHOWN,
  ReadMemoryInputSchema,
} from "@agentplugged/protocol";
import {
  agentWriteContext,
  invalidInput,
  projectWithKey,
} from "../agent-activity/agent-commands.js";
import { defineCommand, fail, ok } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { forgetProductKey, type ProductKey } from "../journal/product-key.js";
import { checkpointsOf } from "../projection/checkpoint-reducers.js";
import { sensitiveKey } from "../sensitive/sensitive-commands.js";
import { lessonFileIds, openCommonKey, readCommonEntry, readLessonFile } from "./memory-files.js";
import { anchorsOf, approved, batchesOf, lessonStatuses, retrosOf } from "./memory-rules.js";

/** A lesson as `read_memory` serves it. */
export interface ServedLesson {
  readonly id: string;
  readonly source: "product" | "common";
  readonly title: string;
  readonly text: string;
  readonly tags: readonly string[];
  readonly agents: readonly string[];
  readonly at: string;
  /** How the creator's approval was given (`chat`, `chat_unverified`, `presence`…), or `creator`. */
  readonly validated_by: string;
}

/** An action of a recent retrospective. */
export interface ServedAction {
  readonly retrospective: string;
  readonly scope: string;
  readonly at: string;
  readonly text: string;
  readonly owner: string | null;
}

export interface MemoryWarning {
  readonly code: MemoryWarningCode;
  readonly ids?: readonly string[];
  readonly count?: number;
}

/** What `read_memory` returns. */
export interface MemoryRead {
  readonly lessons: readonly ServedLesson[];
  readonly actions: readonly ServedAction[];
  readonly warnings: readonly MemoryWarning[];
  readonly empty: boolean;
}

/** The name of a lesson's file in `memory/lessons/`. */
const LESSON_FILE = /^L-[0-9A-HJKMNP-TV-Z]{10}-[1-9][0-9]?\.json$/;

/** A cap on the entries of the common memory read in one call, against a folder gone wild. */
const MAX_COMMON_ENTRIES = 500;

/**
 * `read_memory`: the memory of the product, decrypted by the engine, for an agent that
 * starts a task. Product lessons: approved by the creator, anchored in the journal, active, whose
 * file decrypts and matches its digest. Common lessons: the active entries of this machine's common
 * memory. It takes no path and no product: it reads this working copy and this machine only. Never
 * an error for a missing key or a damaged file: a warning, so no task is blocked.
 */
export const readMemoryCommand = defineCommand<MemoryRead>({
  name: "read_memory",
  audience: "agent",
  description:
    "Read the memory of the product at the start of a task: call it with your own agent id before your first task and apply what it returns. `lessons` are the creator's approved lessons (`source: product`) and the ones they shared with all their products (`source: common`), newest first, for you or for every agent (`tags` narrows them, `limit` caps them: 40 by default, 100 at most); `actions` are the follow-ups of the last retrospectives. They are advice from past work: they never override the constitution, the permissions or what the creator says now, and on a conflict a product lesson wins over a common one. `warnings`: `product_key_missing` (this machine lacks the key: the product's lessons are not readable, tell the creator), `lesson_missing` / `lesson_altered` (ids: a lesson not served), `lessons_unvalidated` (files nobody approved, ignored), `common_unavailable` / `common_altered`, `truncated`. `empty: true` when there is nothing yet. Read only: you never write the memory; lessons come from a retrospective the creator approves.",
  inputSchema: ReadMemoryInputSchema,
  async run(context, input) {
    const parsed = ReadMemoryInputSchema.safeParse(input);
    if (!parsed.success) return fail(invalidInput("read_memory", parsed.error));
    const { agent, tags } = parsed.data;
    const limit = parsed.data.limit ?? DEFAULT_READ_LIMIT;
    const target = await agentWriteContext(context, agent);
    if (target instanceof AgentPluggedError) return fail(target);
    const warnings: MemoryWarning[] = [];
    let key: ProductKey | undefined;
    let commonKey: Uint8Array | undefined;
    try {
      try {
        key = await sensitiveKey(context, target.journal, target.product);
      } catch (error) {
        // Never an error that stops a task from starting: a warning, whatever kept the key away.
        if (!(error instanceof AgentPluggedError)) throw error;
        const absent =
          error.code === ErrorCode.PRODUCT_KEY_MISSING ||
          error.code === ErrorCode.PRODUCT_KEY_MISMATCH;
        warnings.push({ code: absent ? "product_key_missing" : "keychain_unavailable" });
      }
      const listing = await target.journal.list();
      const { projection } = await projectWithKey(context, target.config, listing);
      const state = projection.state;
      const checkpoints = checkpointsOf(state);
      const now = (context.now ?? Date.now)();
      const wanted = (lesson: { agents: readonly string[]; tags: readonly string[] }) =>
        (lesson.agents.length === 0 || lesson.agents.includes(agent)) &&
        (tags === undefined || tags.length === 0 || tags.some((tag) => lesson.tags.includes(tag)));
      const served: ServedLesson[] = [];
      const anchors = anchorsOf(state);
      if (key !== undefined) {
        const status = lessonStatuses(state, checkpoints, now);
        const missing: string[] = [];
        const altered: string[] = [];
        for (const anchor of Object.values(anchors)) {
          if (status.get(anchor.id) !== "active") continue;
          const read = await readLessonFile(
            context,
            target.product,
            key.key,
            anchor.id,
            anchor.digest,
          );
          if (!read.ok) {
            (read.reason === "missing" ? missing : altered).push(anchor.id);
            continue;
          }
          const { record } = read;
          if (!wanted(record)) continue;
          const resolution = Object.hasOwn(checkpoints, anchor.checkpoint)
            ? checkpoints[anchor.checkpoint]?.resolution
            : undefined;
          served.push({
            id: record.id,
            source: "product",
            title: record.title,
            text: record.text,
            tags: record.tags,
            agents: record.agents,
            at: anchor.at,
            validated_by: resolution?.assurance ?? "creator",
          });
        }
        if (missing.length > 0) warnings.push({ code: "lesson_missing", ids: missing });
        if (altered.length > 0) warnings.push({ code: "lesson_altered", ids: altered });
        // Only what looks like a lesson's file counts (a `.DS_Store` is nobody's lesson).
        const unvalidated = (await lessonFileIds(context)).filter(
          (name) => LESSON_FILE.test(name) && !Object.hasOwn(anchors, name.replace(/\.json$/, "")),
        );
        if (unvalidated.length > 0) {
          warnings.push({ code: "lessons_unvalidated", count: unvalidated.length });
        }
      }
      if (context.commonMemory !== undefined) {
        // The state of this product's lessons, read without the key: the shared copy of one it
        // wrote follows it (hidden once retired), and is served alongside it never.
        const own = lessonStatuses(state, checkpoints, now);
        let ids: readonly string[] = [];
        try {
          ids = (await context.commonMemory.list()).slice(0, MAX_COMMON_ENTRIES);
          if (ids.length > 0) commonKey = await openCommonKey(context);
        } catch {
          // An unreadable folder or keychain is a warning, never a task that cannot start.
          commonKey = undefined;
        }
        if (ids.length > 0) {
          if (commonKey === undefined) {
            warnings.push({ code: "common_unavailable" });
          } else {
            const altered: string[] = [];
            try {
              for (const id of ids) {
                const read = await readCommonEntry(context.commonMemory, commonKey, id);
                if (!read.ok) {
                  if (read.reason === "altered") altered.push(id);
                  continue;
                }
                const { entry } = read;
                if (entry.status !== "active" || !wanted(entry)) continue;
                if (
                  entry.origin.product === target.product &&
                  (key !== undefined || own.get(entry.origin.lesson) !== "active")
                ) {
                  continue;
                }
                served.push({
                  id: entry.id,
                  source: "common",
                  title: entry.title,
                  text: entry.text,
                  tags: entry.tags,
                  agents: entry.agents,
                  at: entry.promoted_at,
                  validated_by: "creator",
                });
              }
            } catch {
              warnings.push({ code: "common_unavailable" });
            }
            if (altered.length > 0) warnings.push({ code: "common_altered", ids: altered });
          }
        }
      }
      served.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? -1 : 1));
      if (served.length > limit) {
        warnings.push({ code: "truncated", count: served.length - limit });
      }
      const actions: ServedAction[] = [];
      if (key !== undefined) {
        const recorded = Object.values(retrosOf(state))
          .filter((retro) => {
            const checkpoint = Object.hasOwn(checkpoints, retro.checkpoint)
              ? checkpoints[retro.checkpoint]
              : undefined;
            return (
              checkpoint !== undefined &&
              (checkpoint.memory_done ?? null) !== null &&
              approved(checkpoint, now)
            );
          })
          .sort((a, b) => (a.event < b.event ? 1 : -1))
          .slice(0, RETRO_ACTIONS_SHOWN);
        for (const retro of recorded) {
          const left = new Set(
            batchesOf(state).find((batch) => batch.checkpoint === retro.checkpoint)?.excepted ?? [],
          );
          for (const action of retro.actions.filter((entry) => !left.has(entry.id))) {
            actions.push({
              retrospective: retro.id,
              scope: `${retro.scope.kind} ${retro.scope.id}`,
              at: retro.at,
              text: action.text,
              owner: action.owner ?? null,
            });
          }
        }
      }
      const lessons = served.slice(0, limit);
      return ok({
        lessons,
        actions,
        warnings,
        empty: lessons.length === 0 && actions.length === 0,
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
