import { z } from "zod";

/** `.agentplugged/.cache/sync-manifest.json`: what the last `sync` generated. */
export const SyncManifestSchema = z.strictObject({
  format_version: z.literal(1),
  /** SHA-256 (hexadecimal) of each generated file, by workspace-relative path. */
  files: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
  /** Permission rules added by `sync` to `.claude/settings.json`. */
  permissions: z.array(z.string()),
  /** Permission rules added by `sync` to `.cursor/cli.json`. */
  cursor_permissions: z.array(z.string()).optional(),
  /**
   * What `sync` put in each JSON settings file (`.claude/settings.json`, `.cursor/cli.json`):
   * whether it created the file, and the keys it introduced (`permissions.deny`, ...). Used to
   * take back only its own additions when the tool leaves the `tools` list.
   */
  settings: z
    .record(z.string(), z.strictObject({ created: z.boolean(), keys: z.array(z.string()) }))
    .optional(),
  /**
   * The fingerprint (SHA-256, hexadecimal) of what `sync` generated from: the files of
   * `.agentplugged/agents/`, `skills/`, `overrides/agents/` and the sections of `method.yaml` it
   * reads. `next` says the method is out of sync when it no longer matches.
   */
  inputs: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  /**
   * The `allow` and `ask` rules `sync` added to each JSON settings file, by path, from the
   * permission rules. `permissions` and `cursor_permissions` hold the `deny` ones.
   */
  permission_lists: z
    .record(
      z.string(),
      z.strictObject({
        allow: z.array(z.string()).optional(),
        ask: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});

export type SyncManifest = z.infer<typeof SyncManifestSchema>;

/**
 * The part of `.claude/settings.json` that `sync` reads. Every other key is kept as is.
 */
export const ClaudeSettingsSchema = z.looseObject({
  permissions: z
    .looseObject({
      allow: z.array(z.string()).optional(),
      ask: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
    })
    .optional(),
});

export type ClaudeSettings = z.infer<typeof ClaudeSettingsSchema>;

/** The part of `.cursor/cli.json` that `sync` reads. Every other key is kept as is. */
export const CursorCliConfigSchema = z.looseObject({
  permissions: z
    .looseObject({
      allow: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
    })
    .optional(),
});

export type CursorCliConfig = z.infer<typeof CursorCliConfigSchema>;
