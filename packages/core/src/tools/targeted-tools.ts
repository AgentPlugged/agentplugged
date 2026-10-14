import { type MethodConfig, TOOL_IDS, type ToolId } from "@agentplugged/protocol";
import type { DetectedTool } from "./detect-tools.js";

/** Tools found on the machine, or all of them when none is found (the method works anyway). */
export function toolsFromDetection(detected: readonly DetectedTool[]): ToolId[] {
  const found = TOOL_IDS.filter((id) => detected.some((tool) => tool.id === id && tool.found));
  return found.length > 0 ? found : [...TOOL_IDS];
}

/**
 * The tools `sync` generates files for: the `tools` list of `method.yaml`, or, in a file written
 * before that list existed, the detected tools. Returned in catalog order.
 */
export function targetedTools(
  config: MethodConfig,
  detect: () => Promise<readonly DetectedTool[]>,
): Promise<ToolId[]> {
  if (config.tools !== undefined) {
    const listed = config.tools;
    return Promise.resolve(TOOL_IDS.filter((id) => listed.includes(id)));
  }
  return detect().then(toolsFromDetection);
}
