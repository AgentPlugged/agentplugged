import { MCP_SERVER_NAME } from "../sync/mcp.js";
import type { BudgetCeiling } from "./budget-rules.js";

/**
 * The pure rules of the guard before every tool call: which calls the team's pause holds, and the
 * words of a refusal. A refusal is one line: the cause in plain words, what the creator can do in
 * one gesture, and what the agent must not do. Never a command for the creator to type.
 */

/** The prefix of the tools of the engine's own server: never refused (an agent must be able to conclude). */
export const OWN_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** The tools a pause holds for an agent of a story: they write, run a command, or start an agent. */
export const PAUSE_HELD_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
  "PowerShell",
  "Task",
  "Agent",
]);

/** The tools that start an agent: held for every session, Noah's included. */
export const LAUNCH_TOOLS: ReadonlySet<string> = new Set(["Task", "Agent"]);

/**
 * Whether the pause holds a call: an agent of a story (a sub-agent, or a session in the working
 * copy of a story) is held for every writing tool; the main session only for starting an agent, so
 * that Noah keeps talking and the creator keeps working in their own terminal.
 */
export function pauseHolds(tool: string, bound: boolean): boolean {
  if (tool.startsWith(OWN_TOOL_PREFIX)) return false;
  return bound ? PAUSE_HELD_TOOLS.has(tool) : LAUNCH_TOOLS.has(tool);
}

/** Dollars as the creator reads them: `$2.00`. */
export function usdText(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** The refusal of a call while the team is paused. */
export function pausedMessage(reason: "creator" | "emergency_stop"): string {
  const by =
    reason === "emergency_stop"
      ? "stopped by the creator (emergency stop)"
      : "paused by the creator";
  return `AgentPlugged held this call: the team is ${by}, so nothing new starts or is written. Read state.next if you need to see it, tell the coordinator you are held, then wait: the creator resumes everyone in one gesture. Do not work around it with another tool or command.`;
}

/**
 * The refusal of a call once the story reached its budget. `kind`: `pending` (the checkpoint waits
 * for the creator), `stopped` (the creator stopped the story at its budget) or `reached` (this call
 * is the one that found the ceiling gone over).
 */
export function budgetMessage(
  story: string,
  kind: "pending" | "stopped" | "reached",
  ceiling: BudgetCeiling | undefined,
): string {
  const amount =
    ceiling?.usd === null || ceiling === undefined ? "" : ` of ${usdText(ceiling.usd)}`;
  const cause =
    kind === "stopped"
      ? `the creator stopped story ${story} at its budget${amount}`
      : `story ${story} reached its budget${amount}`;
  const next =
    kind === "stopped"
      ? "It goes on only once a sprint approved later takes it again."
      : "A checkpoint is open for the creator, who can raise the budget, let the story go on without one, or stop it, in one gesture from the web view or the phone.";
  return `AgentPlugged stopped this call: ${cause}. ${next} Do not work around it with another tool or command: end with story.result partial and say what is left.`;
}
