import { AgentPluggedError } from "../errors.js";
import { loadMethodConfig } from "../init/method-config.js";
import type { WorkspaceFiles } from "../workspace-files.js";
import { engineCommand, mcpLaunch } from "./mcp.js";

/**
 * The command that runs the engine from a shell on this machine, as `method.yaml` declares it
 *: the creator's `mcp` launch, else `npx -y agentplugged@<engine_version>`. Undefined
 * when the method is not installed or its configuration is unreadable: the caller keeps the texts
 * as the engine wrote them.
 */
export async function resolveEngineCommand(files: WorkspaceFiles): Promise<string | undefined> {
  try {
    const loaded = await loadMethodConfig(files);
    if (loaded instanceof AgentPluggedError) return undefined;
    return engineCommand(
      mcpLaunch(loaded.config.engine_version, {
        ...(loaded.config.mcp === undefined ? {} : { override: loaded.config.mcp }),
      }),
    );
  } catch {
    return undefined;
  }
}
