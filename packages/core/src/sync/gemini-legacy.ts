import { sha256Hex } from "@agentplugged/crypto";
import { AgentPluggedError } from "../errors.js";
import { GENERATED_HEADER, isGenerated, normalizeText } from "../init/generated.js";
import { isRecord } from "../values.js";
import type { WorkspaceFiles } from "../workspace-files.js";
import { loadManifest, renderManifest, SYNC_MANIFEST_PATH } from "./manifest.js";
import {
  GEMINI_SETTINGS_PATH,
  isGeneratedMcpEntry,
  LEGACY_GEMINI_SETTINGS,
  MCP_SERVER_NAME,
  parseMcpFile,
  reconcileMcpFile,
  renderMcpFile,
} from "./mcp.js";
import type { SyncEntry, SyncResult, SyncWarning } from "./sync-command.js";

/**
 * Where an earlier `sync` wrote sub-agents for the retired Gemini CLI. `sync` no longer writes
 * there and never deletes there by itself: only the cleanup does, and only what it can prove it wrote.
 */
export const LEGACY_GEMINI_AGENTS_DIR = ".gemini/agents";

/** True for a sub-agent file of the retired Gemini CLI (a Markdown file in its agents folder). */
export function isLegacyGeminiAgent(path: string): boolean {
  return path.startsWith(`${LEGACY_GEMINI_AGENTS_DIR}/`) && path.endsWith(".md");
}

const ENTRY_KEY = `mcpServers.${MCP_SERVER_NAME}`;

/** The Markdown files of the retired Gemini CLI's agents folder, in path order. */
async function legacyAgentFiles(files: WorkspaceFiles): Promise<string[]> {
  return (await files.listFiles(LEGACY_GEMINI_AGENTS_DIR)).filter(isLegacyGeminiAgent);
}

/**
 * True when the project still holds something the retired Gemini CLI left: a sub-agent file that
 * carries the generated header, or the server entry an earlier `sync` recorded in its settings.
 * Nothing is read beyond that, and nothing is changed.
 */
export async function hasLegacyGeminiFiles(files: WorkspaceFiles): Promise<boolean> {
  for (const path of await legacyAgentFiles(files)) {
    if (isGenerated(await files.readText(path), GENERATED_HEADER)) return true;
  }
  const manifest = await loadManifest(files);
  return (
    manifest.settings?.[GEMINI_SETTINGS_PATH]?.keys.includes(ENTRY_KEY) === true &&
    (await files.exists(GEMINI_SETTINGS_PATH))
  );
}

/**
 * Removes what `sync` wrote for the retired Gemini CLI, and nothing else:
 * - a sub-agent file is removed when it carries the generated header and is as `sync` wrote it
 *   (its recorded hash, when the manifest has one);
 * - the `agentplugged` server entry is taken out of the settings when the manifest says `sync`
 *   added it, or when it has the shape `sync` writes; the settings file goes only when `sync`
 *   created it and nothing else is left in it.
 * What cannot be proven is listed and kept, and removed only when `confirmed`. A file without the
 * header is the creator's: it is left alone.
 */
export async function cleanLegacyGemini(
  files: WorkspaceFiles,
  confirmed: boolean,
): Promise<SyncResult> {
  const manifest = await loadManifest(files);
  const entries: SyncEntry[] = [];
  const warnings: SyncWarning[] = [];
  const removed: string[] = [];
  const nextFiles = { ...manifest.files };
  let listed = 0;
  const unproven = (path: string) => {
    listed++;
    warnings.push({ kind: "gemini_unproven", path });
  };

  for (const path of await legacyAgentFiles(files)) {
    const text = normalizeText(await files.readText(path));
    const recorded = manifest.files[path];
    if (!isGenerated(text, GENERATED_HEADER)) {
      // Not ours, unless the manifest says it was and the creator took it: then it is listed.
      if (recorded !== undefined) unproven(path);
      continue;
    }
    // With a manifest that lists files, a file it does not know is not proven to be ours.
    const proven =
      recorded === undefined
        ? Object.keys(manifest.files).length === 0
        : recorded === sha256Hex(text);
    if (!proven && !confirmed) {
      unproven(path);
      continue;
    }
    await files.remove(path);
    delete nextFiles[path];
    removed.push(path);
    entries.push({ path, action: "deleted", group: "antigravity" });
  }

  const nextSettings = { ...manifest.settings };
  if (await files.exists(GEMINI_SETTINGS_PATH)) {
    const text = await files.readText(GEMINI_SETTINGS_PATH);
    const value = parseMcpFile(text, GEMINI_SETTINGS_PATH, true);
    const entry = value instanceof AgentPluggedError ? undefined : mcpEntryOf(value);
    if (value instanceof AgentPluggedError) {
      // Unreadable settings are the creator's: listed, never rewritten.
      unproven(GEMINI_SETTINGS_PATH);
    } else if (entry !== undefined) {
      const record = manifest.settings?.[GEMINI_SETTINGS_PATH];
      const recorded = record?.keys.includes(ENTRY_KEY) === true;
      // Rewriting strict JSON would drop the creator's comments: that needs a confirmation.
      const strictJson = isStrictJson(text);
      if (
        (recorded || isGeneratedMcpEntry(entry.value) || confirmed) &&
        (strictJson || confirmed)
      ) {
        const previous = recorded ? record : { created: false, keys: [ENTRY_KEY] };
        const outcome = reconcileMcpFile(
          LEGACY_GEMINI_SETTINGS,
          value,
          false,
          { command: "npx", args: [] },
          previous,
        );
        if (outcome.next === undefined) {
          await files.remove(GEMINI_SETTINGS_PATH);
          removed.push(GEMINI_SETTINGS_PATH);
        } else if (outcome.next !== "same") {
          await files.writeText(GEMINI_SETTINGS_PATH, renderMcpFile(outcome.next, text));
        }
        entries.push({
          path: GEMINI_SETTINGS_PATH,
          action: outcome.next === undefined ? "deleted" : "updated",
          group: "antigravity",
        });
        delete nextSettings[GEMINI_SETTINGS_PATH];
      } else unproven(GEMINI_SETTINGS_PATH);
    } else delete nextSettings[GEMINI_SETTINGS_PATH];
  } else delete nextSettings[GEMINI_SETTINGS_PATH];

  // The folders the removals left empty go too; a folder that still holds anything stays.
  for (const folder of [LEGACY_GEMINI_AGENTS_DIR, ".gemini"]) {
    if (!removed.some((path) => path.startsWith(`${folder}/`))) continue;
    if ((await files.exists(folder)) && (await files.listFiles(folder)).length === 0) {
      try {
        await files.remove(folder);
      } catch {
        // A folder the creator keeps (for example with empty sub-folders) stays.
      }
    }
  }

  const { settings: _settings, ...rest } = manifest;
  const next = renderManifest({
    ...rest,
    files: nextFiles,
    ...(Object.keys(nextSettings).length > 0 ? { settings: nextSettings } : {}),
  });
  if (await files.exists(SYNC_MANIFEST_PATH)) {
    if ((await files.readText(SYNC_MANIFEST_PATH)) !== next) {
      await files.writeText(SYNC_MANIFEST_PATH, next);
    }
  }

  return {
    entries,
    warnings,
    tools: [],
    fallbacks: [],
    codexTrustReminder: false,
    cursorHooksReminder: false,
    preferredTools: [],
    geminiCleanup: { listed },
  };
}

/** The `agentplugged` server entry of a settings file, when it declares one. */
function mcpEntryOf(value: Record<string, unknown>): { value: unknown } | undefined {
  const servers = value.mcpServers;
  if (!isRecord(servers) || !Object.hasOwn(servers, MCP_SERVER_NAME)) return undefined;
  return { value: servers[MCP_SERVER_NAME] };
}

/** True when the text is plain JSON, with no comment nor trailing comma to lose on a rewrite. */
function isStrictJson(text: string): boolean {
  try {
    JSON.parse(normalizeText(text));
    return true;
  } catch {
    return false;
  }
}
