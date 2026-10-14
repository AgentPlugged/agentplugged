import { type SyncManifest, SyncManifestSchema } from "@agentplugged/protocol";
import { METHOD_DIR } from "../init/layout.js";
import type { WorkspaceFiles } from "../workspace-files.js";

export const SYNC_MANIFEST_PATH = `${METHOD_DIR}/.cache/sync-manifest.json`;

export const EMPTY_MANIFEST: SyncManifest = { format_version: 1, files: {}, permissions: [] };

/**
 * What the last `sync` generated. The manifest is a cache: a missing or unreadable one is treated
 * as empty, and generated files are then recognised by their header alone.
 */
export async function loadManifest(files: WorkspaceFiles): Promise<SyncManifest> {
  if (!(await files.exists(SYNC_MANIFEST_PATH))) return EMPTY_MANIFEST;
  try {
    const result = SyncManifestSchema.safeParse(
      JSON.parse(await files.readText(SYNC_MANIFEST_PATH)),
    );
    return result.success ? result.data : EMPTY_MANIFEST;
  } catch {
    return EMPTY_MANIFEST;
  }
}

export function renderManifest(manifest: SyncManifest): string {
  const files = Object.fromEntries(
    Object.entries(manifest.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return `${JSON.stringify({ ...manifest, files }, null, 2)}\n`;
}
