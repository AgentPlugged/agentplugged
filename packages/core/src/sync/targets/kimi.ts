import type { AntigravityPolicy } from "../../trust/antigravity-policy.js";
import { KIMI_POLICY_PATH } from "../../trust/kimi-guard.js";
import { disallowedToolsFor } from "../agent-tools.js";
import { agentsOf, type RenderInput, renderMarkdownAgent, type Target } from "./common.js";

export const KIMI_DIR = ".kimi-code";
export const KIMI_AGENTS_DIR = `${KIMI_DIR}/agents`;

/**
 * Kimi Code CLI sub-agents (`.kimi-code/agents/<name>.md`: YAML frontmatter, the body is the
 * system prompt). The file has no `model` field (unknown fields are ignored), so none is written:
 * the agents run on the session's model. As in Claude Code, a sub-agent is not given the tools of
 * the engine its work never calls (`disallowedTools`, MCP tools named `mcp__<server>__<tool>`).
 * Skills are the shared `.agents/skills/` folders, read by Kimi as well; the constitution
 * (`AGENTS.md`) and the MCP file need no generation here.
 */
export async function renderKimi(input: RenderInput): Promise<Target[]> {
  const targets: Target[] = [];
  for (const agent of agentsOf(input)) {
    const denied = await disallowedToolsFor(input, agent);
    targets.push({
      path: `${KIMI_AGENTS_DIR}/${agent.name}.md`,
      content: renderMarkdownAgent(agent, {
        name: agent.name,
        description: agent.description,
        ...(denied.length === 0 ? {} : { disallowedTools: denied }),
      }),
      group: "kimi",
    });
  }
  return targets;
}

/**
 * The product's permission lists for the hook of the user's Kimi settings (`kimi-hooks install`):
 * the hook reads them here, in the project, when it runs. Written whether or not the hook is
 * installed, so that installing it later needs nothing more than the command.
 */
export function renderKimiGuard(policy: AntigravityPolicy): Target[] {
  return [
    {
      path: KIMI_POLICY_PATH,
      content: `${JSON.stringify(policy, null, 2)}\n`,
      group: "kimi",
    },
  ];
}
