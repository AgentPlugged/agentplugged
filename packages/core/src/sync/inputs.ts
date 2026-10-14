import { canonicalBytes, sha256Hex } from "@agentplugged/crypto";
import { parse } from "yaml";
import { METHOD_CONFIG_PATH, METHOD_DIR } from "../init/layout.js";
import type { WorkspaceFiles } from "../workspace-files.js";

/** Folders whose files `sync` generates from: any change, addition or deletion counts. */
export const SYNC_INPUT_DIRS = [
  `${METHOD_DIR}/agents`,
  `${METHOD_DIR}/skills`,
  `${METHOD_DIR}/overrides/agents`,
  `${METHOD_DIR}/overrides/skills`,
] as const;

/**
 * A person's own layer of a skill's customisation is never rendered, so it is not an
 * input: it is ignored by Git, and counting it would put every other teammate out of sync.
 */
const PERSONAL_LAYER = ".local.yaml";

/** Sections of `method.yaml` that change what `sync` generates (the pinned engine is in its texts). */
export const SYNC_CONFIG_KEYS = [
  "profile",
  "agents",
  "tools",
  "models",
  "mcp",
  "rules",
  "engine_version",
] as const;

async function fileHash(files: WorkspaceFiles, path: string): Promise<string> {
  try {
    return sha256Hex(await files.readBytes(path));
  } catch {
    return sha256Hex(await files.readText(path));
  }
}

/** The sections of `method.yaml` `sync` reads, as written (an unreadable file counts as text). */
async function configSections(files: WorkspaceFiles): Promise<unknown> {
  if (!(await files.exists(METHOD_CONFIG_PATH))) return null;
  const text = await files.readText(METHOD_CONFIG_PATH);
  try {
    const value: unknown = parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return { text };
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      SYNC_CONFIG_KEYS.filter((key) => Object.hasOwn(record, key) && record[key] !== undefined).map(
        (key) => [key, record[key]],
      ),
    );
  } catch {
    return { text };
  }
}

/**
 * The fingerprint (SHA-256, hexadecimal) of what `sync` generates from: every file of
 * `.agentplugged/agents/`, `skills/` and `overrides/agents/` (path and content) and the sections
 * of `method.yaml` it reads. `sync` records it in its manifest; `next` computes it again and says
 * the method is out of sync when they differ. No date is involved: an identical rewrite changes
 * nothing.
 */
export async function syncInputsFingerprint(files: WorkspaceFiles): Promise<string> {
  const inputs: Record<string, string> = {};
  for (const dir of SYNC_INPUT_DIRS) {
    for (const path of await files.listFiles(dir)) {
      if (dir.endsWith("overrides/skills") && path.endsWith(PERSONAL_LAYER)) continue;
      inputs[path] = await fileHash(files, path);
    }
  }
  const config = await configSections(files);
  try {
    return sha256Hex(canonicalBytes({ files: inputs, config }));
  } catch {
    // A value without a JSON form (a YAML oddity): the sections as text instead.
    return sha256Hex(canonicalBytes({ files: inputs, config: JSON.stringify(config) ?? null }));
  }
}
