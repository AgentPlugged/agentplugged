import { type RenderInput, renderAgentFiles, type Target } from "./common.js";

export const ANTIGRAVITY_AGENTS_DIR = ".agents/agents";
export const GEMINI_MD_PATH = "GEMINI.md";

/**
 * Antigravity CLI sub-agents (`.agents/agents/<name>.md`). Antigravity CLI reads `GEMINI.md`,
 * which `sync` merges like `CLAUDE.md`. Every file carries the generated header, the mark of its
 * origin.
 */
export function renderAntigravity(input: RenderInput): Target[] {
  return renderAgentFiles(input, "antigravity", ANTIGRAVITY_AGENTS_DIR, "antigravity");
}
