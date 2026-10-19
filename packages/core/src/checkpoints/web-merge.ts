import type { CommandContext } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { loadMethodConfig } from "../init/method-config.js";
import { afterMerge, mergeFailed, mergeStory } from "../merge/story-merge.js";
import { mergeHead } from "../review/merge-head.js";
import type { WebMerging } from "./web-answer.js";

/**
 * The merge of a story the creator approved from the web view, done by the engine itself: the
 * same `mergeStory` the chat and the terminal use (the commit reviewed only, in the order of the
 * graph, with the forge's tool the creator logged in on this machine, never a token of the
 * web view's). The browser never talks to the forge: its signed order reaches the machine, and
 * the machine merges once the undo window is over.
 *
 * `context` is the engine's own context for the product's folder: its files, its journal, the
 * Git and forge adapters. Nothing here decides anything the engine does not already decide.
 */
export function engineMerging(context: CommandContext): WebMerging {
  return {
    head: (point, state) => mergeHead(context, state, point).catch(() => undefined),
    async merge(point, state, head) {
      try {
        const loaded = await loadMethodConfig(context.files);
        if (loaded instanceof AgentPluggedError) return loaded;
        return await mergeStory(context, loaded.config, state, point, head);
      } catch (error) {
        if (error instanceof AgentPluggedError) return error;
        return mergeFailed(point.story ?? "", point.id, "forge_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    async merged(merge) {
      // The story is delivered: its working copy goes, never forced, never a failure of the answer.
      await afterMerge(context, merge);
    },
  };
}
