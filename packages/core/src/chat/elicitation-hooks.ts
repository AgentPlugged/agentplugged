import { isDecisionHook } from "./decision-hook.js";

/**
 * Hooks of the AI tool that could answer the engine's forms in the creator's place:
 * Claude Code runs `Elicitation` hooks when an MCP server asks for a form, and `ElicitationResult`
 * hooks before the answer goes back; either may answer or change it alone (`accept` with content).
 * When one could apply to the `agentplugged` server, the engine never asks in a form: the answer
 * would not be the creator's click.
 */

/** The hook events that can answer, or change, a form's answer. */
export const ELICITATION_HOOK_EVENTS = ["Elicitation", "ElicitationResult"] as const;

/**
 * True when a hook entry's matcher may select `server`: no matcher, an empty one or `*` selects
 * every server; otherwise the matcher is a regular expression on the server's name, and one that
 * cannot be read counts as selecting it (caution).
 */
function selects(matcher: unknown, server: string): boolean {
  if (matcher === undefined || matcher === null) return true;
  if (typeof matcher !== "string") return true;
  const text = matcher.trim();
  if (text === "" || text === "*") return true;
  try {
    return new RegExp(text).test(server);
  } catch {
    return true;
  }
}

/**
 * True when the parsed settings of the AI tool (`settings.json`) hold an `Elicitation` or
 * `ElicitationResult` hook that may apply to `server`. Anything that cannot be read as the
 * settings' shape, under those events, counts as such a hook (caution).
 */
export function elicitationHookIn(settings: unknown, server: string): boolean {
  return hookIn(
    settings,
    ELICITATION_HOOK_EVENTS,
    server,
    (commands) => Array.isArray(commands) && commands.length === 0,
  );
}

/**
 * True when the settings hold, under one of `events`, a hook that may apply to `target`, unless
 * `harmless` says its commands change nothing. A shape that cannot be read counts as a hook.
 */
function hookIn(
  settings: unknown,
  events: readonly string[],
  target: string,
  harmless: (commands: unknown) => boolean,
): boolean {
  if (typeof settings !== "object" || settings === null) return false;
  const hooks = (settings as { hooks?: unknown }).hooks;
  if (typeof hooks !== "object" || hooks === null) return false;
  for (const event of events) {
    const entries = (hooks as Record<string, unknown>)[event];
    if (entries === undefined || entries === null) continue;
    if (!Array.isArray(entries)) return true;
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) return true;
      const { matcher, hooks: commands } = entry as { matcher?: unknown; hooks?: unknown };
      if (harmless(commands)) continue;
      if (selects(matcher, target)) return true;
    }
  }
  return false;
}

/**
 * Hooks that could answer the question tool in the creator's place: a `PreToolUse` hook
 * may allow the call with an input of its own (answers included), a `PermissionRequest` hook may
 * allow it for the creator. Ours (the question tool's hook, which only records and refuses answers
 * in a call) never counts.
 */
export const QUESTION_TOOL_HOOK_EVENTS = ["PreToolUse", "PermissionRequest"] as const;

/**
 * True when the parsed settings of the AI tool hold, under `PreToolUse` or `PermissionRequest`, a
 * hook of another maker that may apply to `tool` (the question tool's name). Anything that cannot be
 * read as the settings' shape under those events counts as such a hook (caution).
 */
export function questionToolHookIn(settings: unknown, tool: string): boolean {
  return hookIn(
    settings,
    QUESTION_TOOL_HOOK_EVENTS,
    tool,
    (commands) => Array.isArray(commands) && commands.every((command) => isDecisionHook(command)),
  );
}
