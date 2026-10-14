import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The product's configuration, relative to its root. The same path as the core's
 * `METHOD_CONFIG_PATH`, written here so that the launcher of the MCP server (which loads as little
 * as it can) does not load the core to find the product.
 */
export const PRODUCT_CONFIG_PATH = ".agentplugged/method.yaml";

/**
 * The folder of the product a hook or the MCP server serves: `cwd` when it holds
 * `.agentplugged/method.yaml`, else the nearest folder above it that does. Antigravity CLI starts
 * the plugin's hooks and MCP server from the plugin's own folder (`.agents/plugins/agentplugged`),
 * inside the project. `cwd` itself when none is found.
 */
export function productRootOf(cwd: string): string {
  let folder = cwd;
  for (let level = 0; level < 16; level++) {
    if (existsSync(join(folder, PRODUCT_CONFIG_PATH))) return folder;
    const parent = dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  return cwd;
}
