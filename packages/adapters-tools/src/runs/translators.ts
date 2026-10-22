import { antigravityTranslator } from "./antigravity.js";
import { claudeCodeTranslator } from "./claude-code.js";
import { codexTranslator } from "./codex.js";
import type { RunToolId, ToolTranslator } from "./contract.js";
import { cursorTranslator } from "./cursor.js";
import { kimiTranslator } from "./kimi.js";

/** The translator of each tool the bridge can start. */
export const TRANSLATORS: Readonly<Record<RunToolId, ToolTranslator>> = {
  "claude-code": claudeCodeTranslator,
  codex: codexTranslator,
  antigravity: antigravityTranslator,
  cursor: cursorTranslator,
  kimi: kimiTranslator,
};

/** The translator of `tool`, or undefined for a tool the bridge does not start. */
export function translatorFor(tool: string): ToolTranslator | undefined {
  return Object.hasOwn(TRANSLATORS, tool) ? TRANSLATORS[tool as RunToolId] : undefined;
}
