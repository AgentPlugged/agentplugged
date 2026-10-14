import { ErrorCode, METHOD_FORMAT_VERSION, SemverSchema } from "@agentplugged/protocol";
import { parseDocument } from "yaml";
import { AgentPluggedError } from "../errors.js";
import type { WorkspaceFiles } from "../workspace-files.js";
import { METHOD_CONFIG_PATH } from "./layout.js";

export interface EngineCheckOptions {
  /** Version of the running engine. */
  readonly engineVersion: string;
  /** `--engine-any`: run even when `method.yaml` pins another engine version. */
  readonly engineAny?: boolean;
  /** `init --upgrade-engine`: the pinned version is about to be replaced by the running one. */
  readonly upgrade?: boolean;
  /** `migrate`: an older `format_version` is what the command is for (no `MIGRATION_REQUIRED`). */
  readonly migrate?: boolean;
  /** The command as the creator typed it (`sync`, `agent edit iris`…), for the message. */
  readonly command: string;
}

export interface EngineCheck {
  /** The engine version pinned in `method.yaml`, when the file exists and names a valid one. */
  readonly pinned: string | undefined;
  /** True when the pinned version differs and `--engine-any` let the command run anyway. */
  readonly overridden: boolean;
  /** True when the running engine is older than the pinned one. */
  readonly older: boolean;
}

const NOTHING_PINNED: EngineCheck = { pinned: undefined, overridden: false, older: false };

/** The version pinned by the development CLI, never published: `npx` cannot run it. */
export const DEV_ENGINE_VERSION = "0.0.0";

/** Semver precedence (semver.org 2.0.0, item 11): negative when `a` < `b`. Build is ignored. */
export function compareSemver(a: string, b: string): number {
  const split = (version: string) => {
    const [core = "", pre] = (version.split("+")[0] ?? "").split(/-(.*)/s);
    return { core: core.split(".").map(Number), pre: pre === undefined ? [] : pre.split(".") };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const diff = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  // A pre-release comes before its release.
  if (x.pre.length === 0 && y.pre.length === 0) return 0;
  if (x.pre.length === 0) return 1;
  if (y.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Math.sign(Number(p) - Number(q));
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** The engine version `method.yaml` pins in the repository's main working folder, if readable. */
async function mainCheckoutPin(files: WorkspaceFiles): Promise<string | undefined> {
  try {
    const text = await files.readMainCheckoutText?.(METHOD_CONFIG_PATH);
    if (text === undefined) return undefined;
    const version = (parseDocument(text).toJS() as { engine_version?: unknown } | null)
      ?.engine_version;
    return SemverSchema.safeParse(version).success ? (version as string) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Checks, before anything is written, that the running engine may work on this product:
 * a `format_version` newer than the engine knows stops with `UPGRADE_REQUIRED`, an older one with
 * `MIGRATION_REQUIRED` (but for `migrate`), and another
 * pinned `engine_version` stops with `ENGINE_VERSION_MISMATCH` unless `--engine-any` or
 * `init --upgrade-engine` is given. A missing or unreadable `method.yaml` passes: the command
 * reports it itself.
 */
export async function checkEngine(
  files: WorkspaceFiles,
  options: EngineCheckOptions,
): Promise<EngineCheck | AgentPluggedError> {
  if (!(await files.exists(METHOD_CONFIG_PATH))) return NOTHING_PINNED;
  let raw: unknown;
  try {
    const document = parseDocument(await files.readText(METHOD_CONFIG_PATH));
    if (document.errors.length > 0) return NOTHING_PINNED;
    raw = document.toJS();
  } catch {
    return NOTHING_PINNED;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return NOTHING_PINNED;
  const config = raw as Record<string, unknown>;

  const pinned = SemverSchema.safeParse(config.engine_version).success
    ? (config.engine_version as string)
    : undefined;
  const format = config.format_version;
  if (typeof format === "number" && Number.isInteger(format) && format > METHOD_FORMAT_VERSION) {
    return new AgentPluggedError(ErrorCode.UPGRADE_REQUIRED, "error.upgrade_required", {
      path: METHOD_CONFIG_PATH,
      format_version: format,
      supported: METHOD_FORMAT_VERSION,
      engine_version: options.engineVersion,
      // A pinned engine newer than this one knows the format; otherwise the latest one does.
      version:
        pinned !== undefined && compareSemver(pinned, options.engineVersion) > 0
          ? pinned
          : "latest",
      command: options.command,
    });
  }
  // Only `migrate` brings an older format forward: never another command, never on its own.
  if (
    typeof format === "number" &&
    Number.isInteger(format) &&
    format >= 0 &&
    format < METHOD_FORMAT_VERSION &&
    options.migrate !== true
  ) {
    return new AgentPluggedError(ErrorCode.MIGRATION_REQUIRED, "error.migration_required", {
      path: METHOD_CONFIG_PATH,
      format_version: format,
      supported: METHOD_FORMAT_VERSION,
      engine_version: options.engineVersion,
      command: options.command,
    });
  }
  if (pinned === undefined || pinned === options.engineVersion) {
    return { pinned, overridden: false, older: false };
  }
  // A story's working copy is made from the committed files: an engine update not committed yet
  // is only in the main working folder. The pin that folder holds counts for the copy.
  if (
    !options.upgrade &&
    !options.engineAny &&
    compareSemver(options.engineVersion, pinned) > 0 &&
    (await mainCheckoutPin(files)) === options.engineVersion
  ) {
    return { pinned, overridden: false, older: false };
  }
  const details = {
    path: METHOD_CONFIG_PATH,
    pinned,
    engine_version: options.engineVersion,
    command: options.command,
  };
  // An older engine never replaces the pin, nor runs without --engine-any: the product needs
  // the pinned engine or a later one.
  const older = compareSemver(options.engineVersion, pinned) < 0;
  if (older && (options.upgrade || !options.engineAny)) {
    return new AgentPluggedError(
      ErrorCode.ENGINE_VERSION_MISMATCH,
      "error.engine_version_too_old",
      details,
    );
  }
  if (options.upgrade) return { pinned, overridden: false, older };
  if (options.engineAny) return { pinned, overridden: true, older };
  // The development CLI's pin cannot be run with npx: only the upgrade is offered.
  const key =
    pinned === DEV_ENGINE_VERSION
      ? "error.engine_version_mismatch.dev_pin"
      : "error.engine_version_mismatch";
  return new AgentPluggedError(ErrorCode.ENGINE_VERSION_MISMATCH, key, details);
}
