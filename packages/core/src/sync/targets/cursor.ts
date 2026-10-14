import { hookLaunch } from "../../chat/antigravity-hook.js";
import {
  CURSOR_HOOK_PATH,
  CURSOR_HOOKS_PATH,
  CURSOR_POLICY_PATH,
  renderCursorHookScript,
  renderCursorHooks,
} from "../../chat/cursor-hook.js";
import { GENERATED_HEADER } from "../../init/generated.js";
import type { AntigravityPolicy } from "../../trust/antigravity-policy.js";
import { type RenderInput, renderAgentFiles, type Target } from "./common.js";

export const CURSOR_DIR = ".cursor";
export const CURSOR_AGENTS_DIR = `${CURSOR_DIR}/agents`;
export const CURSOR_RULE_PATH = `${CURSOR_DIR}/rules/agentplugged.mdc`;
export const CURSOR_CLI_PATH = `${CURSOR_DIR}/cli.json`;
/** The files the agent may not reach, in the editor and the CLI: the creator's, `sync` keeps a block in it. */
export const CURSOR_IGNORE_PATH = ".cursorignore";

/** The always-applied rule that sends Cursor to the constitution. */
export function renderCursorRule(constitution: string): string {
  return `---
description: AgentPlugged method constitution
alwaysApply: true
---
${GENERATED_HEADER}
This project uses the AgentPlugged method. Read and follow \`${constitution}\` before any work.
`;
}

/**
 * Cursor sub-agents (`.cursor/agents/<name>.md`, which win over `.claude/agents` on a name clash)
 * and the rule `.cursor/rules/agentplugged.mdc`. Cursor reads `AGENTS.md` natively;
 * `.cursor/cli.json` is merged with the creator's file by `sync`.
 */
export function renderCursor(input: RenderInput): Target[] {
  const targets = renderAgentFiles(input, "cursor", CURSOR_AGENTS_DIR, "cursor");
  targets.push({
    path: CURSOR_RULE_PATH,
    content: renderCursorRule(input.constitution),
    group: "cursor",
  });
  return targets;
}

/**
 * The files of the hooks: the script, the policy it and the engine read (the product's
 * lists and the engine's launch) and `.cursor/hooks.json` that declares them. `sync` writes none of
 * them when the creator's own `.cursor/hooks.json` is kept: a script nothing runs is noise.
 */
export function renderCursorGuard(input: RenderInput, policy: AntigravityPolicy): Target[] {
  const launch = hookLaunch(input.mcpLaunch);
  return [
    { path: CURSOR_HOOK_PATH, content: renderCursorHookScript(), group: "cursor" },
    {
      path: CURSOR_POLICY_PATH,
      content: `${JSON.stringify({ ...policy, launch }, null, 2)}\n`,
      group: "cursor",
    },
    { path: CURSOR_HOOKS_PATH, content: renderCursorHooks(), group: "cursor" },
  ];
}
