import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  AgentPluggedError,
  type ConfirmationPrompt,
  type InitProductKey,
  type KeyExportResult,
  type KeyImportResult,
  type KeySealResult,
  type LocalWarning,
  type PassphrasePrompt,
} from "@agentplugged/core";
import type { Translate } from "@agentplugged/i18n";
import { ErrorCode } from "@agentplugged/protocol";
import type { Prompter } from "./prompt.js";

/**
 * The product key at the terminal: the secret prompts of `key export` and
 * `key import`, the export file, and what the commands and `init` did. The key itself is never
 * printed: only its `key_id`, and its export under the passphrase.
 */

const PROMPT_KEYS = {
  new: "key.passphrase.new",
  again: "key.passphrase.again",
  enter: "key.passphrase.enter",
  export: "key.passphrase.export",
} as const satisfies Record<PassphrasePrompt, string>;

function cancelled(): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.CANCELLED, "error.cancelled");
}

/** Asks a secret without echoing it; the end of the input cancels (`CANCELLED`). */
export function passphraseAsker(
  t: Translate,
  prompter: () => Prompter,
): (prompt: PassphrasePrompt) => Promise<string> {
  return async (prompt) => {
    const answer = await prompter().askSecret(t(PROMPT_KEYS[prompt]));
    if (answer === undefined) throw cancelled();
    return answer;
  };
}

/** Asks a visible confirmation (« je confirme »); the end of the input cancels. */
export function confirmationAsker(
  t: Translate,
  prompter: () => Prompter,
): (prompt: ConfirmationPrompt) => Promise<string> {
  return async (prompt) => {
    const answer = await prompter().ask(
      t("key.import.confirm_replace", { held_key_id: prompt.held_key_id, key_id: prompt.key_id }),
    );
    if (answer === undefined) throw cancelled();
    return answer;
  };
}

/** The text of an export given with `--in <file>`: `UNEXPECTED` when it cannot be read. */
export async function readExportFile(cwd: string, path: string): Promise<string> {
  try {
    return await readFile(resolve(cwd, path), "utf8");
  } catch (error) {
    throw new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
      reason: `key import --in ${path}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/** The root of the Git repository holding `cwd` (the folder with `.git`), or `cwd` itself. */
function repositoryRoot(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}

function inside(root: string, target: string): boolean {
  const fold = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);
  const path = relative(fold(root), fold(target));
  // Another drive gives an absolute path: outside.
  return path === "" || !(path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path));
}

/**
 * `--out <file>`: refused inside the repository (it would be committed) and when the file exists
 * (never overwritten). Checked before the passphrase is asked.
 */
export async function checkExportTarget(cwd: string, path: string): Promise<string> {
  const target = resolve(cwd, path);
  const refuse = (reason: string) =>
    new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
      reason: `key export --out ${path}: ${reason}`,
    });
  if (inside(repositoryRoot(cwd), target)) {
    throw refuse("inside the repository, where it could be committed: choose a file outside it");
  }
  if (existsSync(target)) throw refuse("the file exists: choose a new file");
  return target;
}

/**
 * Writes the export to `--out <file>`: created, never replaced (`wx`), readable by this account
 * only where the system honours the mode (`0600`; on Windows, no ACL is set: the file inherits
 * its folder's).
 */
export async function writeExportFile(cwd: string, path: string, text: string): Promise<string> {
  const target = await checkExportTarget(cwd, path);
  try {
    await writeFile(target, `${text}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    throw new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
      reason: `key export --out ${path}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  return target;
}

/** What `key export`, `key import` or `key seal` did. `file`: where `--out` wrote the export. */
export function formatProductKey(
  t: Translate,
  result: KeyExportResult | KeyImportResult | KeySealResult,
  file?: string,
): string {
  if (result.action === "seal") return formatSeal(t, result);
  if (result.action === "export") {
    const lines = [t("key.export.done", { key_id: result.key_id })];
    if (file === undefined) lines.push("", result.exported, "");
    else lines.push(t("key.export.file", { path: file }));
    lines.push(t("key.export.hint"), "");
    return lines.join("\n");
  }
  const done = result.status === "already" ? "key.import.already" : "key.import.done";
  const lines = [t(done, { key_id: result.key_id })];
  if (result.replaced !== undefined) {
    lines.push(t("key.import.replaced", { held_key_id: result.replaced }));
  }
  return `${lines.join("\n")}\n`;
}

function formatSeal(t: Translate, result: KeySealResult): string {
  if (result.files.length === 0) return `${t("key.seal.none")}\n`;
  const lines = [t("key.seal.title", { key_id: result.key_id })];
  for (const file of result.files) {
    const status =
      file.status === "skipped"
        ? t("key.seal.skipped", { reason: file.reason ?? "" })
        : t(file.status === "sealed" ? "key.seal.sealed" : "key.seal.already");
    lines.push(`  ${t("key.seal.line", { status, path: file.path })}`);
  }
  return `${lines.join("\n")}\n`;
}

/** A warning of this machine about the product key (never in `state.json`). */
export function formatLocalKeyWarning(
  t: Translate,
  warning: Exclude<LocalWarning, { code: "history_rewritten" }>,
): string {
  return warning.code === "sensitive_unreadable"
    ? t("journal.warning.sensitive_unreadable", { count: warning.count })
    : t("journal.warning.keychain_unavailable", { reason: warning.reason });
}

/** What `init` did with the product key: created, held, or to import from another machine. */
export function formatInitProductKey(t: Translate, productKey: InitProductKey): string[] {
  const keyId = productKey.key_id ?? "";
  const journalKeyId = productKey.journal_key_id ?? "";
  switch (productKey.status) {
    case "keychain_unavailable":
      return [
        t("init.product_key.keychain_unavailable", { reason: productKey.publishReason ?? "" }),
      ];
    case "keychain_full":
      return [
        t("init.product_key.keychain_full"),
        t("error.keychain_full", { reason: productKey.publishReason ?? "" }),
      ];
    case "failed":
      return [t("init.product_key.failed", { reason: productKey.publishReason ?? "" })];
    case "sync_first":
      return [t("init.product_key.sync_first", { remote: productKey.remote ?? "" })];
    case "missing":
      return [t("init.product_key.missing", { key_id: journalKeyId })];
    case "mismatch":
      return [t("init.product_key.mismatch", { key_id: keyId, journal_key_id: journalKeyId })];
    default: {
      const lines = [
        t(productKey.status === "created" ? "init.product_key.created" : "init.product_key.ready", {
          key_id: keyId,
        }),
      ];
      if (productKey.published === "written") lines.push(t("init.product_key.published"));
      else if (productKey.published === "no_repo") lines.push(t("init.product_key.no_repo"));
      else if (productKey.published === "failed") {
        lines.push(
          t("init.product_key.publish_failed", { reason: productKey.publishReason ?? "" }),
        );
      }
      if (productKey.status === "created") lines.push(t("init.product_key.export_hint"));
      return lines;
    }
  }
}
