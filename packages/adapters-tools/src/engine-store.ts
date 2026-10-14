import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the versions of the engine live on this machine: one folder per version under
 * `~/.agentplugged/engines/<version>/`, each holding the npm package `agentplugged` of that version
 * and its dependencies. A version is never replaced in place: on Windows a running engine locks its
 * native keychain module, so a new version always goes to a folder of its own.
 */

/** The name of the package, on the registry and in each folder. */
export const ENGINE_PACKAGE = "agentplugged";

/**
 * A release version: `1.2.3`, never a range, a path or a tag. It names a folder and an npm
 * package, so nothing else may pass (no `..`, no separator).
 */
const RELEASE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

/** True for an exact release version (a pre-release is never installed by the engine). */
export function isReleaseVersion(version: unknown): version is string {
  return typeof version === "string" && version.length <= 32 && RELEASE_VERSION.test(version);
}

/** The folder of the engine's per-machine files: `~/.agentplugged`. */
export function agentpluggedHome(home: string = homedir()): string {
  return join(home, ".agentplugged");
}

/** The folder that holds every installed version. */
export function enginesDir(home: string = homedir()): string {
  return join(agentpluggedHome(home), "engines");
}

/** The folder of one version (the version must be a release version). */
export function engineDir(version: string, home: string = homedir()): string {
  if (!isReleaseVersion(version)) throw new Error(`not a release version: ${String(version)}`);
  return join(enginesDir(home), version);
}

/** The package's own folder inside a version's folder. */
export function packageDir(folder: string): string {
  return join(folder, "node_modules", ENGINE_PACKAGE);
}

/** The program to run for a version's folder: its CLI entry (`dist/bin.js`). */
export function engineEntry(folder: string): string {
  return join(packageDir(folder), "dist", "bin.js");
}

/**
 * True when `folder` holds the package `agentplugged` of exactly `version`, whole enough to run: its
 * manifest names the package and the version, and its entry exists. Never a reason to throw.
 */
export function isInstalledEngine(folder: string, version: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(packageDir(folder), "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    return (
      manifest.name === ENGINE_PACKAGE &&
      manifest.version === version &&
      existsSync(engineEntry(folder))
    );
  } catch {
    return false;
  }
}

/** The entry of an installed version, or undefined when it is not (whole) there. */
export function installedEntry(version: string, home: string = homedir()): string | undefined {
  if (!isReleaseVersion(version)) return undefined;
  const folder = engineDir(version, home);
  return isInstalledEngine(folder, version) ? engineEntry(folder) : undefined;
}
