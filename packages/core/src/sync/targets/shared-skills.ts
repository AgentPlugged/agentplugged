import { type RenderInput, renderSkillFolders, type Target } from "./common.js";

export const SHARED_SKILLS_DIR = ".agents/skills";

/**
 * `.agents/skills/<name>/`, read by Codex, Antigravity CLI and Cursor: written once,
 * whatever the number of tools that read it.
 */
export function renderSharedSkills(input: RenderInput): Promise<Target[]> {
  return renderSkillFolders(input, SHARED_SKILLS_DIR, "shared");
}
