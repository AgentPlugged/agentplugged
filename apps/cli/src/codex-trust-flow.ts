import {
  AgentPluggedError,
  type CodexUserConfig,
  codexHookHashes,
  codexTrustSupported,
  planCodexTrust,
  renderCodexHooks,
  type WorkspaceFiles,
} from "@agentplugged/core";
import type { Translate } from "@agentplugged/i18n";
import { ErrorCode } from "@agentplugged/protocol";
import { GoBack } from "./menu.js";
import { askYesNo, type Prompter } from "./prompt.js";

const CODEX_CONFIG = ".codex/config.toml";

/**
 * Codex runs the project's hooks only once the creator approved them (layer 2). After
 * `init` or `sync` wrote them, this offers to do that approval for the creator: one question at
 * the keyboard, the default is no, and nothing is written without a yes. Never when nobody can
 * answer (a script, `--yes`, a pipe), never on a platform where Codex's hash was not checked, never
 * when the project's `.codex/config.toml` is the creator's own and declares other hooks. The user's
 * `config.toml` of Codex is merged: the approvals of this project are added, nothing else changes.
 * Returns what to say, or undefined when there is nothing to say.
 */
export async function offerCodexTrust(options: {
  readonly t: Translate;
  readonly interactive: boolean;
  readonly platform: string | undefined;
  readonly projectRoot: string;
  readonly files: WorkspaceFiles;
  readonly userConfig: CodexUserConfig;
  readonly prompter: () => Prompter;
}): Promise<string | undefined> {
  const { t } = options;
  if (!options.interactive || !codexTrustSupported(options.platform)) return undefined;
  try {
    // Only hooks `sync` wrote: the project's file holds them exactly.
    if (!(await options.files.exists(CODEX_CONFIG))) return undefined;
    if (!(await options.files.readText(CODEX_CONFIG)).includes(renderCodexHooks())) {
      return undefined;
    }
    const file = options.userConfig.path;
    const current = await options.userConfig.read();
    const plan = planCodexTrust({
      projectRoot: options.projectRoot,
      platform: options.platform,
      userConfig: current,
    });
    if (!plan.ok) {
      return plan.reason === "unsupported" ? undefined : t("sync.codex_trust.refused", { file });
    }
    // Everything already approved: nothing to ask.
    if (plan.entries.every((entry) => entry.change === "keep")) return undefined;
    const count = String(codexHookHashes().length);
    let yes = false;
    try {
      yes = await askYesNo(
        t,
        options.prompter(),
        t("sync.codex_trust.ask", { count, file }),
        false,
      );
    } catch (error) {
      // Escape or the end of the input is a no.
      if (!(error instanceof GoBack) && !isCancelled(error)) throw error;
    }
    if (!yes) return t("sync.codex_trust.declined");
    try {
      // Codex writes this file too (a folder it trusts, a hook approved by hand) while the question
      // waits: the file is read again and merged again right before the write.
      const latest = await options.userConfig.read();
      const final =
        latest === current
          ? plan
          : planCodexTrust({
              projectRoot: options.projectRoot,
              platform: options.platform,
              userConfig: latest,
            });
      if (!final.ok) return t("sync.codex_trust.refused", { file });
      if (final.entries.some((entry) => entry.change !== "keep")) {
        await options.userConfig.write(final.text);
      }
    } catch (error) {
      return t("sync.codex_trust.failed", {
        file,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return t("sync.codex_trust.done", { count, file });
  } catch {
    // The approval is a convenience: any failure leaves the creator the gesture in Codex.
    return t("sync.codex_trust.declined");
  }
}

function isCancelled(error: unknown): boolean {
  return error instanceof AgentPluggedError && error.code === ErrorCode.CANCELLED;
}
