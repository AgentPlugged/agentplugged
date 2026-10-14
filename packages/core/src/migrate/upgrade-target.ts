import { ErrorCode, SemverSchema } from "@agentplugged/protocol";
import { AgentPluggedError } from "../errors.js";
import { compareSemver } from "../init/engine-check.js";

/** What `npx agentplugged@<version>` names when no engine newer than the running one is known. */
export const LATEST_ENGINE = "latest";

/**
 * The command an `UPGRADE_REQUIRED` of the journal suggests when nobody says which one was typed:
 * reading the journal again with the new engine. The registry replaces it with the creator's.
 */
export const UPGRADE_DEFAULT_COMMAND = "journal status";

/**
 * The engine to install: the newest of `candidates` (valid versions only) that is newer than the
 * running engine, else `latest`. Never an engine as old as the running one.
 */
export function upgradeTarget(engineVersion: string, candidates: ReadonlyArray<unknown>): string {
  let best: string | undefined;
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !SemverSchema.safeParse(candidate).success) continue;
    if (compareSemver(candidate, engineVersion) <= 0) continue;
    if (best === undefined || compareSemver(candidate, best) > 0) best = candidate;
  }
  return best ?? LATEST_ENGINE;
}

/** Messages of an unknown event without an engine to install: `<key>.install` names one. */
const UNNAMED_KEYS: ReadonlySet<string> = new Set([
  "error.event_upgrade_required",
  "error.event_type_upgrade_required",
]);

/**
 * An `UPGRADE_REQUIRED` (or `MIGRATION_REQUIRED`) of a command, refined by the registry, which
 * knows who asks, what was typed and the pinned engine:
 *
 * - `details.install`, the engine to install: the newest of the one named (by the journal or by
 *   `checkEngine`'s `version`) and the pinned one, when newer than the running engine, else
 *   `latest`;
 * - for the creator, `details.command` is the command as typed;
 * - for an agent (the MCP server), the message asks the creator to act (`<key>.agent` variants):
 *   an agent's tool name is never offered as a command to run.
 *
 * Any other error is returned as is.
 */
export function withUpgradeTarget(
  error: AgentPluggedError,
  options: {
    readonly engineVersion: string;
    readonly pinned: string | undefined;
    readonly command: string;
    readonly actor: "human" | "agent";
  },
): AgentPluggedError {
  // A session that still runs an engine older than the product's pin: for an agent, the
  // way out is the creator's one « oui » to the update (`next` carries `engine_update`), never a command.
  if (
    error.code === ErrorCode.ENGINE_VERSION_MISMATCH &&
    error.message_key === "error.engine_version_too_old" &&
    options.actor === "agent"
  ) {
    return new AgentPluggedError(error.code, "error.engine_version_too_old.agent", {
      ...error.details,
    });
  }
  if (error.code === ErrorCode.MIGRATION_REQUIRED) {
    return options.actor === "agent"
      ? new AgentPluggedError(error.code, "error.migration_required.agent", { ...error.details })
      : error;
  }
  if (error.code !== ErrorCode.UPGRADE_REQUIRED) return error;
  const details = error.details;
  const named =
    typeof details.install === "string"
      ? details.install
      : error.message_key === "error.upgrade_required"
        ? details.version
        : undefined;
  const install = upgradeTarget(options.engineVersion, [named, options.pinned]);
  if (options.actor === "agent") {
    return new AgentPluggedError(error.code, "error.upgrade_required.agent", {
      ...details,
      install,
      engine_version: options.engineVersion,
    });
  }
  if (error.message_key === "error.upgrade_required") {
    // `checkEngine`'s own: it already names the version and the command typed.
    return error;
  }
  const key = UNNAMED_KEYS.has(error.message_key)
    ? `${error.message_key}.install`
    : error.message_key;
  return new AgentPluggedError(error.code, key, {
    ...details,
    install,
    command: options.command,
  });
}
