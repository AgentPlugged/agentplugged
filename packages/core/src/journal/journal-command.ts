import { ErrorCode } from "@agentplugged/protocol";
import { defineCommand, fail, ok } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { METHOD_CONFIG_PATH } from "../init/layout.js";
import { loadMethodConfig } from "../init/method-config.js";
import { type ProjectStateResult, projectState } from "../projection/project-state.js";
import { type JournalSyncResult, syncJournal } from "./journal-sync.js";

export const JOURNAL_ACTIONS = ["sync", "status"] as const;
export type JournalAction = (typeof JOURNAL_ACTIONS)[number];

function invalid(reason: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", { reason });
}

function unavailable(what: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
    reason: `no ${what} is available here`,
  });
}

/**
 * `journal sync [--remote <name>] [--recreate-remote]`: brings the remote's journal into the
 * local one and sends it the local events it lacks (`syncJournal`, through `context.journalSync`).
 * `journal status`: the state of the product projected from the journal (`projectState`, through
 * `context.journal`), written to `.agentplugged/.cache/state.json`.
 */
export const journalCommand = defineCommand<JournalSyncResult | ProjectStateResult>({
  name: "journal",
  async run(context, input) {
    const { action, remote, recreate_remote: recreate } = input;
    if (action === "status") {
      if (remote !== undefined) return fail(invalid("journal status: --remote"));
      if (recreate !== undefined) return fail(invalid("journal status: --recreate-remote"));
      if (context.journal === undefined) return fail(unavailable("journal"));
      // The product is pinned by `method.yaml` when it names one; an invalid file is reported.
      let productId: string | undefined;
      if (await context.files.exists(METHOD_CONFIG_PATH)) {
        const loaded = await loadMethodConfig(context.files);
        if (loaded instanceof AgentPluggedError) return fail(loaded);
        productId = loaded.config.product_id;
      }
      // The product key, when this machine holds it: the sensitive content is projected too.
      const keys = context.keys ?? context.human?.keys;
      try {
        return ok(
          await projectState(context.journal, context.files, {
            ...(productId === undefined ? {} : { productId }),
            allowTestTypes: context.allowTestTypes === true,
            ...(keys === undefined ? {} : { keys }),
          }),
        );
      } catch (error) {
        if (error instanceof AgentPluggedError) return fail(error);
        throw error;
      }
    }
    if (action !== "sync") {
      const typed = ["journal", ...(typeof action === "string" ? [action] : [])].join(" ");
      return fail(invalid(`${typed} (${JOURNAL_ACTIONS.join(", ")})`));
    }
    if (remote !== undefined && (typeof remote !== "string" || remote.trim() === "")) {
      return fail(invalid("--remote"));
    }
    if (recreate !== undefined && typeof recreate !== "boolean") {
      return fail(invalid("--recreate-remote"));
    }
    if (context.journalSync === undefined) return fail(unavailable("journal synchronisation"));
    try {
      return ok(
        await syncJournal(context.journalSync, { remote, recreateRemote: recreate === true }),
      );
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    }
  },
});
