import { ANTIGRAVITY_UNCHECKED_REASON } from "../chat/antigravity-hook.js";
import { isRecord } from "../values.js";
import type { AntigravityCall, GuardFlavor } from "./antigravity-guard.js";

/**
 * The permission rules of the product applied before each tool Kimi Code CLI runs: what the user's
 * `PreToolUse` hook asks the engine (`agentplugged hook kimi pre-tool`). The rules are the ones of
 * Antigravity's guard (`antigravity-guard.ts`), applied to Kimi's tool calls: this module only says
 * what a Kimi call is and what differs for the tool.
 *
 * Kimi's documentation gives a hook's input as the common fields (`hook_event_name`, `session_id`,
 * `cwd`…) plus `tool_input`, and names neither the tool nor the fields of its input beyond
 * `tool_input.command`. The call is therefore read by its shape: an input with a `command` is a
 * shell command, any other input is looked at by the path-like fields it carries.
 */

/** The policy `sync` writes in the project (the lists of Claude Code's settings): the hook reads it there. */
export const KIMI_POLICY_PATH = ".kimi-code/agentplugged-policy.json";

/** The call of a Kimi hook's input, or undefined when it carries no `tool_input`. */
export function kimiCallOf(input: unknown): AntigravityCall | undefined {
  if (!isRecord(input) || !isRecord(input.tool_input)) return undefined;
  const args = input.tool_input;
  const cwd = typeof input.cwd === "string" && input.cwd.trim() !== "" ? input.cwd : undefined;
  if (typeof args.command === "string" && args.command.trim() !== "") {
    return {
      name: "run_command",
      args: { CommandLine: args.command, ...(cwd === undefined ? {} : { Cwd: cwd }) },
    };
  }
  return { name: "kimi_tool", args };
}

/** The Kimi session behind a hook's input, for the journal. */
export function kimiSessionOf(input: unknown): string | undefined {
  if (!isRecord(input) || typeof input.session_id !== "string") return undefined;
  const id = input.session_id.trim();
  return /^[\x21-\x7e]{1,200}$/.test(id) ? id : undefined;
}

/**
 * The tool name `check_call` reads (the pause holds a shell command and a write): Kimi names none in
 * a hook's input, so a command is `Bash`, an input that names a path is `Edit`, the rest is left
 * unnamed and goes through.
 */
export function kimiCallTool(call: AntigravityCall): string {
  if (call.name === "run_command") return "Bash";
  return Object.keys(call.args).some((key) => /file|path/i.test(key)) ? "Edit" : "";
}

/** What differs for Kimi: where the policy is, what a command may not touch. */
export const KIMI_FLAVOR: GuardFlavor = {
  policyPath: KIMI_POLICY_PATH,
  // The chat's store, Kimi's settings (they hold the hooks), its sessions, and the policy itself.
  guardedText:
    /\.agentplugged[\\/](?:chat|method\.yaml)|\.kimi-code(?:[\\/](?:sessions|config\.toml|hooks|agentplugged)|[\s"'`]|$)|agentplugged-policy\.json|kimi-hooks/i,
  agentPrograms: new Set<string>(),
  startsAgentReason:
    "AgentPlugged: an agent never starts a Kimi session (what it wrote there would pass for a message of the creator).",
  guardedReason:
    "AgentPlugged: agents never write Kimi's settings (they hold the product's hooks), its sessions nor the store of the creator's messages.",
  unreadableReason: `AgentPlugged: the permission rules of this product are not readable (\`.kimi-code/agentplugged-policy.json\`): the creator runs \`npx agentplugged sync\`.`,
  uncheckedReason: ANTIGRAVITY_UNCHECKED_REASON,
};
