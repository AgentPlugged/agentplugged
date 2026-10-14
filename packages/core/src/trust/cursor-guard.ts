import {
  CURSOR_HOOK_NAME,
  CURSOR_POLICY_PATH,
  CURSOR_UNCHECKED_REASON,
  CURSOR_UNREADABLE_REASON,
  cursorSessionIdOf,
} from "../chat/cursor-hook.js";
import { isRecord } from "../values.js";
import type { AntigravityCall, GuardFlavor } from "./antigravity-guard.js";

/**
 * The permission rules of the product applied before each command and each file write Cursor runs
 *: what the project's hooks ask the engine (`agentplugged hook cursor pre-tool`), and the
 * reads of external content its post hooks have the engine record. The rules are the ones of
 * Antigravity's guard (`antigravity-guard.ts`), applied to Cursor's calls: this module only says what
 * a Cursor call is (a shell command, the file a write names, a read of the outside) and what differs
 * for the tool. The shapes of the inputs are those of Cursor 3.23.12 (its own code, 2026-10-07):
 * `beforeShellExecution` gives `command` and `cwd`; `preToolUse` on `Write` gives `file_path` and
 * `content`, on `Delete` `file_path`; `postToolUse` on `WebFetch` gives `url`; `afterMCPExecution`
 * gives `mcp_server_name` and `tool_name`.
 */

/**
 * A path as Cursor gives it. Its workspace folders are URI paths (`/c:/Users/me/project`): the
 * leading slash before a drive letter is not part of the Windows path.
 */
function pathOf(value: string): string {
  return value.replace(/^\/(?=[A-Za-z]:[\\/])/, "");
}

/**
 * The call of a Cursor hook's input, in the vocabulary of the guard (`run_command`, `write_to_file`:
 * the rules were written for Antigravity first). A call that cannot be read (a shell command that is
 * no text, a `Write` or a `Delete` that names no file) is `undefined`: the hook denies it, never lets
 * it through unseen. A tool the guard has nothing to say about is a call without paths (`none`).
 */
export function cursorCallOf(input: unknown): AntigravityCall | undefined {
  if (!isRecord(input)) return undefined;
  const event = input.hook_event_name;
  if (event === "beforeShellExecution" || event === "afterShellExecution") {
    if (typeof input.command !== "string") return undefined;
    const cwd = typeof input.cwd === "string" && input.cwd.trim() !== "" ? input.cwd : undefined;
    return {
      name: "run_command",
      args: { CommandLine: input.command, ...(cwd === undefined ? {} : { Cwd: pathOf(cwd) }) },
    };
  }
  if (event === "afterMCPExecution") {
    return {
      name: "call_mcp_tool",
      args: {
        ServerName: typeof input.mcp_server_name === "string" ? input.mcp_server_name : "",
        ToolName: typeof input.tool_name === "string" ? input.tool_name : "",
      },
    };
  }
  const name = input.tool_name;
  if (typeof name !== "string" || name === "") return undefined;
  const args = isRecord(input.tool_input) ? input.tool_input : {};
  if (name === "WebFetch") {
    return {
      name: "read_url_content",
      args: typeof args.url === "string" ? { Url: args.url } : {},
    };
  }
  if (name === "WebSearch") return { name: "search_web", args: {} };
  const file = args.file_path;
  if (typeof file === "string" && file.trim() !== "") {
    return { name: "write_to_file", args: { TargetFile: [pathOf(file)] } };
  }
  // The two tools whose input was read in Cursor's code: one that names no file is not let through.
  return name === "Write" || name === "Delete" ? undefined : { name: "none", args: {} };
}

/** The conversation behind a hook's input, for the journal. */
export function cursorSessionOf(input: unknown): string | undefined {
  return isRecord(input) ? cursorSessionIdOf(input.session_id) : undefined;
}

/** What differs for Cursor: where the policy is, what a command may not touch, who may not be started. */
export const CURSOR_FLAVOR: GuardFlavor = {
  policyPath: CURSOR_POLICY_PATH,
  // The chat's store, the transcripts and chats Cursor keeps, and the hook's own files.
  guardedText: new RegExp(
    String.raw`\.agentplugged[\\/]chat|\.cursor[\\/](?:projects|chats|hooks|rules|cli\.json|cli-config\.json|sandbox\.json)|\.cursorignore|${CURSOR_HOOK_NAME}|agentplugged-policy\.json`,
    "i",
  ),
  agentPrograms: new Set(["cursor-agent"]),
  startsAgentReason:
    "AgentPlugged: an agent never starts a Cursor agent session (what it wrote there would pass for a message of the creator).",
  guardedReason:
    "AgentPlugged: agents never write the product's Cursor hooks and rules, Cursor's transcripts nor the store of the creator's messages.",
  unreadableReason: CURSOR_UNREADABLE_REASON,
  uncheckedReason: CURSOR_UNCHECKED_REASON,
  guardsShellReads: true,
};
