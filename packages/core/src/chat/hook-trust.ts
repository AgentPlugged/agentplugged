import type { CommandContext } from "../command.js";
import { chatClientOf, isCodexClient, isCursorClient } from "./chat-proof.js";

/**
 * `hooks_untrusted` of `get_state`: Codex and Cursor run the project's hooks only once
 * the creator approved them, and give no sign when they did not. The sign the engine can read is
 * the chat's store: a message of the creator that this tool's hook recorded for this project. None
 * yet means the hooks never ran, so `get_state` says what to do, and Noah passes it on once.
 */
export interface HooksUntrusted {
  readonly tool: "codex" | "cursor";
  /** The exact gesture, to pass on in the creator's language. */
  readonly gesture: string;
  /** What does not work until it is done. */
  readonly missing: string;
}

const MISSING =
  "the creator's messages are not recorded as proof of their answers, and the hooks apply none of the product's rules (permissions, installations)";

/** The notice, or undefined: another tool, the hooks ran once already, or the store cannot say. */
export async function hooksUntrustedOf(
  context: CommandContext,
): Promise<HooksUntrusted | undefined> {
  try {
    const client = chatClientOf(context);
    const tool = isCodexClient(client) ? "codex" : isCursorClient(client) ? "cursor" : undefined;
    const project = context.chat?.project;
    const check = context.chat?.log?.hasMessageFrom;
    if (tool === undefined || project === undefined || check === undefined) return undefined;
    if (await check.call(context.chat?.log, project, tool)) return undefined;
    return {
      tool,
      gesture:
        tool === "codex"
          ? 'Codex asks the creator to approve the hooks of the project, once: in the VS Code extension, the "Review hooks" icon under the input box ("3 to approve"); in the terminal, `/hooks`. The folder must also be marked as trusted.'
          : 'Cursor runs the project\'s hooks only in a trusted workspace: accept "Trust" when Cursor asks, then restart Cursor once.',
      missing: MISSING,
    };
  } catch {
    return undefined;
  }
}
