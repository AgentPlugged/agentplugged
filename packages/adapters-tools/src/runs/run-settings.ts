import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The settings file a launch may need: the rules of a product can be longer than a command line
 * allows, so the tool is given them as a file (`--settings <path>`). The file lives in a folder of
 * the user's own temporary area, readable by the user alone where the system has modes, is written
 * for one launch and removed when the launch ends; a file a cut left behind is removed when the
 * bridge starts.
 */

/** The folder of the files of the running launches. */
export function runSettingsDir(base: string = tmpdir()): string {
  return join(base, "agentplugged-run-settings");
}

export interface RunSettingsFile {
  readonly path: string;
  /** Removes the file; safe to call twice. */
  remove(): void;
}

/** Writes the settings of one launch and returns where, and how to remove it. */
export function writeRunSettings(
  text: string,
  base?: string,
  extension: "json" | "md" = "json",
): RunSettingsFile {
  const dir = runSettingsDir(base);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(12))).toString("hex");
  const path = join(dir, `${name}.${extension}`);
  // `wx`: never over a file that exists; `0o600`: the user alone.
  writeFileSync(path, text, { flag: "wx", mode: 0o600 });
  return {
    path,
    remove: () => {
      try {
        rmSync(path, { force: true });
      } catch {
        // A file that cannot be removed now is removed at the next start of the bridge.
      }
    },
  };
}

/** Removes the settings files a cut left behind. Never throws. */
export function sweepRunSettings(base?: string): void {
  const dir = runSettingsDir(base);
  try {
    for (const name of readdirSync(dir)) {
      if (/^[0-9a-f]{24}\.(?:json|md)$/.test(name)) rmSync(join(dir, name), { force: true });
    }
  } catch {
    // No folder, nothing to remove.
  }
}
