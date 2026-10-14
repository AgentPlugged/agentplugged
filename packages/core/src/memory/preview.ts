import type { MethodConfig } from "@agentplugged/protocol";
import { projectWithKey } from "../agent-activity/agent-commands.js";
import type { CommandContext } from "../command.js";
import { forgetProductKey, readHeldProductKey } from "../journal/product-key.js";
import type { JournalListing } from "../journal/state-store.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { readLessonFile } from "./memory-files.js";
import { anchorsOf, memoryOf, retroOfCheckpoint } from "./memory-rules.js";

/**
 * What a change of the memory contains, for the creator to read where the engine shows it (the
 * `review` card): the checkpoint holds counts only, and what an agent says in the chat is the
 * agent's word. The engine decrypts the content itself, with the product key of this machine.
 */
export type MemoryPreview =
  | {
      readonly kind: "retrospective";
      readonly summary: string;
      readonly lessons: readonly {
        readonly id: string;
        readonly title: string;
        readonly text: string;
        readonly agents: readonly string[];
        readonly replaces: readonly string[];
      }[];
      readonly retire: readonly { readonly lesson: string; readonly reason: string }[];
      readonly actions: readonly {
        readonly id: string;
        readonly text: string;
        readonly owner: string | null;
      }[];
    }
  | {
      readonly kind: "promotion";
      readonly lesson: {
        readonly id: string;
        readonly title: string;
        readonly text: string;
        readonly agents: readonly string[];
      } | null;
      readonly replaces: readonly string[];
    };

/**
 * The previews of the open `memory` checkpoints among `checkpoints`, by checkpoint id: none when
 * this machine lacks the product key (the card then says it cannot show the content).
 */
export async function memoryPreviews(
  context: CommandContext,
  config: MethodConfig,
  product: string,
  listing: JournalListing,
  checkpoints: readonly CheckpointState[],
): Promise<Record<string, MemoryPreview>> {
  const wanted = checkpoints.filter((checkpoint) => memoryOf(checkpoint) !== undefined);
  const previews: Record<string, MemoryPreview> = {};
  if (wanted.length === 0) return previews;
  const keys = context.keys ?? context.human?.keys;
  if (keys === undefined) return previews;
  const key = await readHeldProductKey(keys, product).catch(() => undefined);
  if (key === undefined) return previews;
  try {
    const { projection } = await projectWithKey(context, config, listing);
    const state = projection.state;
    for (const checkpoint of wanted) {
      const memory = memoryOf(checkpoint);
      if (memory?.kind === "retrospective") {
        const retro = retroOfCheckpoint(state, checkpoint.id);
        if (retro === undefined) continue;
        previews[checkpoint.id] = {
          kind: "retrospective",
          summary: retro.summary,
          lessons: retro.lessons.map((lesson) => ({
            id: lesson.id,
            title: lesson.title,
            text: lesson.text,
            agents: lesson.agents ?? [],
            replaces: lesson.replaces ?? [],
          })),
          retire: retro.retire.map((entry) => ({ ...entry })),
          actions: retro.actions.map((action) => ({
            id: action.id,
            text: action.text,
            owner: action.owner ?? null,
          })),
        };
      } else if (memory?.kind === "promotion") {
        const anchors = anchorsOf(state);
        const anchor = Object.hasOwn(anchors, memory.lesson) ? anchors[memory.lesson] : undefined;
        const read =
          anchor === undefined
            ? undefined
            : await readLessonFile(context, product, key.key, anchor.id, anchor.digest);
        previews[checkpoint.id] = {
          kind: "promotion",
          lesson:
            read?.ok === true
              ? {
                  id: read.record.id,
                  title: read.record.title,
                  text: read.record.text,
                  agents: read.record.agents,
                }
              : null,
          replaces: memory.replaces ?? [],
        };
      }
    }
  } finally {
    await forgetProductKey(key);
  }
  return previews;
}
