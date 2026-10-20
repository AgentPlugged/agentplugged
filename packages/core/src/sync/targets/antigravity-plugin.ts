import {
  ANTIGRAVITY_HOOK_PATH,
  ANTIGRAVITY_HOOKS_PATH,
  ANTIGRAVITY_MCP_CONFIG_PATH,
  ANTIGRAVITY_PLUGIN_DIR,
  ANTIGRAVITY_PLUGIN_MANIFEST_PATH,
  ANTIGRAVITY_PLUGIN_MARKER,
  ANTIGRAVITY_PLUGIN_NAME,
  ANTIGRAVITY_POLICY_PATH,
  antigravityHooks,
  renderAntigravityHookScript,
} from "../../chat/antigravity-hook.js";
import { normalizeText } from "../../init/generated.js";
import { type AntigravityPolicy, renderPolicy } from "../../trust/antigravity-policy.js";
import { MCP_SERVER_NAME, usableExtensionServers } from "../mcp.js";
import type { RenderInput, Target } from "./common.js";

/**
 * Antigravity CLI's project plugin: `.agents/plugins/agentplugged/`. Antigravity reads
 * MCP servers and hooks from a global file or from a plugin only, never from a project's own
 * `.agents/mcp_config.json` (the file `sync` wrote before this story was ignored). The plugin
 * carries the same server and launcher as the other tools (`mcp_config.json`), the hooks that apply
 * the product's rules and prove the chat (`hooks.json`, the script, `policy.json`), and a manifest
 * (`plugin.json`) whose description marks the folder as generated: only a folder with that mark, or
 * an empty one, is ever rewritten.
 *
 * The JSON files have no header of their own: they are owned by the plugin's folder as a whole
 * (its `plugin.json` carries the mark) and by their hash in the manifest.
 */
export const ANTIGRAVITY_PLUGIN_FILES = [
  ANTIGRAVITY_PLUGIN_MANIFEST_PATH,
  ANTIGRAVITY_MCP_CONFIG_PATH,
  ANTIGRAVITY_HOOKS_PATH,
  ANTIGRAVITY_POLICY_PATH,
  ANTIGRAVITY_HOOK_PATH,
] as const;

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** The plugin's files; `policy` is what `sync` computed for the permission rules. */
export function renderAntigravityPlugin(input: RenderInput, policy: AntigravityPolicy): Target[] {
  const folder = ANTIGRAVITY_PLUGIN_DIR;
  const target = (path: string, content: string): Target => ({
    path,
    content,
    group: "antigravity",
    folder,
  });
  return [
    target(
      ANTIGRAVITY_PLUGIN_MANIFEST_PATH,
      json({ name: ANTIGRAVITY_PLUGIN_NAME, description: ANTIGRAVITY_PLUGIN_MARKER }),
    ),
    target(
      ANTIGRAVITY_MCP_CONFIG_PATH,
      json({
        mcpServers: {
          [MCP_SERVER_NAME]: { command: input.mcpLaunch.command, args: [...input.mcpLaunch.args] },
          ...Object.fromEntries(
            usableExtensionServers(input.extensionServers ?? []).map((extra) => [
              extra.name,
              { command: extra.launch.command, args: [...extra.launch.args] },
            ]),
          ),
        },
      }),
    ),
    target(ANTIGRAVITY_HOOKS_PATH, json(antigravityHooks())),
    target(ANTIGRAVITY_POLICY_PATH, renderPolicy(policy)),
    target(ANTIGRAVITY_HOOK_PATH, renderAntigravityHookScript(input.mcpLaunch)),
  ];
}

/** True for a `plugin.json` that carries the mark of a generated plugin. */
export function isGeneratedPluginManifest(text: string): boolean {
  try {
    const value = JSON.parse(normalizeText(text)) as unknown;
    return (
      typeof value === "object" &&
      value !== null &&
      (value as { description?: unknown }).description === ANTIGRAVITY_PLUGIN_MARKER
    );
  } catch {
    return false;
  }
}
