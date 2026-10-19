import { claudeCodeTranslator } from "./claude-code.js";
import type { Launcher, RunRequest, ToolAdapter, ToolRun, ToolTranslator } from "./contract.js";
import { startToolRun } from "./process-core.js";

export interface ToolAdapterOptions {
  readonly translator: ToolTranslator;
  readonly launcher: Launcher;
  /**
   * The environment the program is started with, and nothing else is inherited. The caller builds
   * it: it holds the program's own credential variable at most, never another tool's, and the
   * adapter never reads a credential of the tool.
   */
  readonly env: Readonly<Record<string, string>>;
  readonly platform?: NodeJS.Platform;
}

/** A `ToolAdapter` from a translator: the process core is shared, only the translator varies. */
export function createToolAdapter(options: ToolAdapterOptions): ToolAdapter {
  const { translator } = options;
  return {
    tool: translator.tool,
    capabilities: translator.capabilities,
    start(request: RunRequest): ToolRun {
      return startToolRun({
        translator,
        request,
        launcher: options.launcher,
        env: options.env,
        ...(options.platform === undefined ? {} : { platform: options.platform }),
      });
    },
  };
}

/** The adapter of Claude Code. */
export function createClaudeCodeAdapter(
  options: Omit<ToolAdapterOptions, "translator">,
): ToolAdapter {
  return createToolAdapter({ ...options, translator: claudeCodeTranslator });
}
