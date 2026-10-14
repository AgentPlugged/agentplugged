import type {
  AgentPluggedError,
  CommandContext,
  CommandRegistry,
  TrustResult,
} from "@agentplugged/core";
import type { Translate } from "@agentplugged/i18n";
import { askYesNo, type Prompter } from "./prompt.js";

/**
 * `trust dismiss` at the terminal: the way out of `SECURITY_ROOT_CHANGED`. It
 * names the event that raised the alert, asks one question (« Écarter cet événement ? o/N »,
 * default no) and only then asks core to publish the dismissal. Nothing else is ever dismissed,
 * and the command has nothing to do unless something is wrong.
 */

function text(t: Translate, result: TrustResult): string {
  if (result.status === "none") {
    return `${t(result.pinned ? "trust.dismiss.none" : "trust.dismiss.no_pin")}\n`;
  }
  if (result.status === "list") {
    return [
      t("trust.dismiss.title", { count: result.faults.length }),
      ...result.faults.map(
        (fault) =>
          `  ${t("trust.dismiss.line", { device: fault.device, id: fault.id, at: fault.at })}`,
      ),
      "",
    ].join("\n");
  }
  return `${t(result.cleared ? "trust.dismiss.done" : "trust.dismiss.still")}\n`;
}

/** Runs `trust dismiss`; returns the exit code (the error is reported by `reportError`). */
export async function runTrustDismiss(
  t: Translate,
  prompter: Prompter,
  registry: CommandRegistry,
  context: CommandContext,
  io: {
    readonly stdout: (text: string) => void;
    readonly reportError: (error: AgentPluggedError) => void;
  },
): Promise<number> {
  const listed = await registry.run("trust", context, { action: "dismiss" });
  if (!listed.ok) {
    io.reportError(listed.error);
    return 1;
  }
  const value = listed.value as TrustResult;
  io.stdout(text(t, value));
  if (value.status !== "list") return 0;
  const yes = await askYesNo(
    t,
    prompter,
    t(value.faults.length === 1 ? "trust.dismiss.ask.one" : "trust.dismiss.ask.many"),
  );
  if (!yes) {
    io.stdout(`${t("trust.dismiss.kept")}\n`);
    return 0;
  }
  const done = await registry.run("trust", context, {
    action: "dismiss",
    confirm: true,
    events: value.faults.map((fault) => fault.hash),
  });
  if (!done.ok) {
    io.reportError(done.error);
    return 1;
  }
  io.stdout(text(t, done.value as TrustResult));
  return 0;
}
