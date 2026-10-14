import { isInherit } from "../../models/model-table.js";
import {
  agentsOf,
  modelFields,
  modelOf,
  type RenderInput,
  renderAgentFiles,
  renderMarkdownAgent,
  type Target,
} from "./common.js";

export const ANTIGRAVITY_AGENTS_DIR = ".agents/agents";
export const GEMINI_AGENTS_DIR = ".gemini/agents";
export const GEMINI_MD_PATH = "GEMINI.md";

/**
 * Antigravity CLI sub-agents (`.agents/agents/<name>.md`) and, for older installations, Gemini
 * CLI's (`.gemini/agents/<name>.md`). Both read `GEMINI.md`, which `sync` merges like
 * `CLAUDE.md`.
 */
export function renderAntigravity(input: RenderInput): Target[] {
  const targets = renderAgentFiles(input, "antigravity", ANTIGRAVITY_AGENTS_DIR, "antigravity");
  for (const agent of agentsOf(input)) {
    // With `inherit`, no `model` key: Gemini CLI then uses the session's model.
    const choice = modelOf(input, "gemini-cli", agent);
    targets.push({
      path: `${GEMINI_AGENTS_DIR}/${agent.name}.md`,
      content: renderMarkdownAgent(agent, {
        name: agent.name,
        description: agent.description,
        kind: "local",
        ...(isInherit(choice) ? {} : modelFields(choice)),
      }),
      group: "antigravity",
    });
  }
  return targets;
}
