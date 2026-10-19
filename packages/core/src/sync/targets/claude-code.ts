import { ACTIVITY_HOOK_PATH, renderActivityHookScript } from "../../chat/activity-hook.js";
import { DECISION_HOOK_PATH, renderDecisionHookScript } from "../../chat/decision-hook.js";
import { PROMPT_HOOK_PATH, renderPromptHookScript } from "../../chat/prompt-hook.js";
import { disallowedToolsFor } from "../agent-tools.js";
import { isDeveloper } from "../developers.js";
import {
  agentsOf,
  modelFields,
  modelOf,
  type RenderInput,
  renderMarkdownAgent,
  renderSkillFolders,
  type Target,
} from "./common.js";

export const CLAUDE_DIR = ".claude";
export const CLAUDE_SKILLS_DIR = `${CLAUDE_DIR}/skills`;
export const CLAUDE_AGENTS_DIR = `${CLAUDE_DIR}/agents`;
export const CLAUDE_SETTINGS_PATH = `${CLAUDE_DIR}/settings.json`;
export const CLAUDE_MD_PATH = "CLAUDE.md";

/**
 * Claude Code files: the skill folders `.claude/skills/<name>/` (called with `/<name>`) and, for
 * each agent, the sub-agent `.claude/agents/<name>.md` (called with `@agent-<name>`), with the
 * model of its tier. A developer's sub-agent also runs in a worktree of its own
 * (`isolation: worktree`): two instances of one developer never share a working
 * copy. `CLAUDE.md` and `.claude/settings.json` are merged with the creator's files by `sync`.
 * The script of the `UserPromptSubmit` hook records the creator's messages, the
 * proof of the chat's answers: `.claude/hooks/agentplugged-prompt.mjs`. The script of the question
 * tool's hook records the creator's answers to it: `.claude/hooks/agentplugged-decision.mjs`. The script of the activity hook tells what a session
 * opened in the creator's terminal does: `.claude/hooks/agentplugged-activity.mjs`.
 */
export async function renderClaudeCode(input: RenderInput): Promise<Target[]> {
  const targets = await renderSkillFolders(input, CLAUDE_SKILLS_DIR, "claude-code");
  const developers = new Set(input.definitions.filter(isDeveloper).map((d) => d.name));
  for (const agent of agentsOf(input)) {
    // A sub-agent is not given the tools of the engine its work never calls.
    const denied = await disallowedToolsFor(input, agent);
    targets.push({
      path: `${CLAUDE_AGENTS_DIR}/${agent.name}.md`,
      content: renderMarkdownAgent(agent, {
        name: agent.name,
        description: agent.description,
        ...modelFields(modelOf(input, "claude-code", agent), "effort"),
        ...(developers.has(agent.name) ? { isolation: "worktree" } : {}),
        ...(denied.length === 0 ? {} : { disallowedTools: denied.join(", ") }),
      }),
      group: "claude-code",
    });
  }
  targets.push({ path: PROMPT_HOOK_PATH, content: renderPromptHookScript(), group: "claude-code" });
  // The script that records the creator's answers to the question tool.
  targets.push({
    path: DECISION_HOOK_PATH,
    content: renderDecisionHookScript(),
    group: "claude-code",
  });
  // The script that tells what a session opened in the creator's terminal does.
  targets.push({
    path: ACTIVITY_HOOK_PATH,
    content: renderActivityHookScript(),
    group: "claude-code",
  });
  return targets;
}
