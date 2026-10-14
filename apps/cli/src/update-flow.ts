import {
  type CommandContext,
  type EngineUpdates,
  engineTargetOf,
  installAndPin,
} from "@agentplugged/core";
import type { Translate } from "@agentplugged/i18n";

/**
 * `agentplugged update`: the creator's own way to what a « oui » to Noah does. Without
 * option it asks the registry now, installs the version it announces in its own folder (the running
 * one is never replaced) and brings the product to it; open sessions move to it at their next call.
 * `--check on|off` and `--auto on|off` set the two settings of this machine.
 */

export interface UpdateEnvironment {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly engineVersion: string;
  readonly files: CommandContext["files"];
  readonly updates: EngineUpdates;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** `on` or `off` (also `true`, `false`, `yes`, `no`, `oui`, `non`); undefined for anything else. */
function toggle(value: string | undefined): boolean | undefined {
  const word = value?.trim().toLowerCase();
  if (word === "on" || word === "true" || word === "yes" || word === "oui") return true;
  if (word === "off" || word === "false" || word === "no" || word === "non") return false;
  return undefined;
}

/** Runs `agentplugged update` and returns its exit code. */
export async function runUpdate(environment: UpdateEnvironment, t: Translate): Promise<number> {
  let check: boolean | undefined;
  let auto: boolean | undefined;
  const { args } = environment;
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    const value = toggle(args[i + 1]);
    if ((option === "--check" || option === "--auto") && value !== undefined) {
      if (option === "--check") check = value;
      else auto = value;
      i++;
    } else {
      environment.stderr(`${t("update.usage", { argument: String(option) })}\n`);
      return 1;
    }
  }
  const { updates } = environment;
  if (check !== undefined || auto !== undefined) {
    const saved = await updates.saveSettings({
      ...(check === undefined ? {} : { check }),
      ...(auto === undefined ? {} : { auto }),
    });
    environment.stdout(
      `${t(saved.check ? "update.settings.check_on" : "update.settings.check_off")}\n${t(saved.auto ? "update.settings.auto_on" : "update.settings.auto_off")}\n`,
    );
    return 0;
  }
  const context = {
    files: environment.files,
    engineVersion: environment.engineVersion,
    engineUpdates: updates,
    actor: "human",
  } as CommandContext;
  const checking = (await updates.settings()).check;
  if (checking) await updates.refresh({ force: true });
  const target = await engineTargetOf(context);
  if (target === undefined) {
    environment.stdout(
      `${t(checking ? "update.up_to_date" : "update.check_off", { version: environment.engineVersion })}\n`,
    );
    return 0;
  }
  environment.stdout(`${t("update.installing", { version: target.version })}\n`);
  const moved = await installAndPin(context, target.version);
  if (!moved.ok) {
    environment.stderr(
      `${t("update.failed", { reason: moved.reason, message: moved.message ?? "" })}\n`,
    );
    return 1;
  }
  environment.stdout(
    `${t(moved.product === "updated" ? "update.done" : "update.done_pinned", { version: target.version })}\n`,
  );
  return 0;
}
