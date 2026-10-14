import { ErrorCode } from "@agentplugged/protocol";
import { AgentPluggedError } from "../errors.js";
import type { WorkspaceFiles } from "../workspace-files.js";
import { METHOD_DIR } from "./layout.js";

/**
 * The channels, other than npm, through which a creator can reach the method: the
 * tool's own store installs a thin wrapper, and that wrapper has the creator run `init` with
 * `--channel <id>`. The method itself is always installed by `init`, never by the wrapper.
 * npm is the default and is not recorded: no file means `npx agentplugged init` was typed.
 */
export const INSTALL_CHANNELS = ["claude-plugin"] as const;
export type InstallChannel = (typeof INSTALL_CHANNELS)[number];

/**
 * Where the channel is noted: in `.agentplugged/.cache/`, which Git ignores (`init` writes that
 * rule), because the channel is a fact about this machine and this clone, not about the product.
 */
export const INSTALL_CHANNEL_PATH = `${METHOD_DIR}/.cache/install-channel`;

/** Validates a channel given by a caller (`init --channel`); the error points at the option. */
export function validateInstallChannel(channel: unknown): InstallChannel | AgentPluggedError {
  if (typeof channel === "string" && (INSTALL_CHANNELS as readonly string[]).includes(channel)) {
    return channel as InstallChannel;
  }
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
    reason: `init: --channel expects one of ${INSTALL_CHANNELS.join(", ")}`,
  });
}

/** Notes the channel of this install (after `init` created the folder). */
export async function writeInstallChannel(
  files: WorkspaceFiles,
  channel: InstallChannel,
): Promise<void> {
  await files.writeText(INSTALL_CHANNEL_PATH, `${channel}\n`);
}

/** The channel noted for this install; undefined when none (npm) or when the note is unknown. */
export async function readInstallChannel(
  files: WorkspaceFiles,
): Promise<InstallChannel | undefined> {
  if (!(await files.exists(INSTALL_CHANNEL_PATH))) return undefined;
  const text = (await files.readText(INSTALL_CHANNEL_PATH)).trim();
  return (INSTALL_CHANNELS as readonly string[]).includes(text)
    ? (text as InstallChannel)
    : undefined;
}
