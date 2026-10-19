import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import { AgentPluggedError, type KeyStore, type WorkspaceFiles } from "@agentplugged/core";
import { ErrorCode } from "@agentplugged/protocol";

/** Folders an export never goes into: the method's own, and Git's. */
const FORBIDDEN_FOLDERS = new Set([".agentplugged", ".git"]);

function invalid(path: string, why: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
    reason: `--export ${path}: ${why}`,
  });
}

function inForbiddenFolder(folder: string): boolean {
  return folder
    .split(/[\\/]/)
    .concat(folder.split(sep))
    .some((segment) => FORBIDDEN_FOLDERS.has(segment.toLowerCase()));
}

/**
 * Where `history --export <path>` writes, resolved once here (`resolve(cwd, path)`): the file's
 * folder and its name, which core uses as given. Refused (`INVALID_ARGUMENTS`) when the folder
 * does not exist or is not a folder, when it lies inside a `.agentplugged` or `.git` folder (as
 * typed or once links are followed), when the target is a folder, or a link that leads nowhere
 * or to a folder. The path may lead outside the product's folder.
 */
export async function resolveExportTarget(
  cwd: string,
  path: string,
): Promise<{ files: WorkspaceFiles; name: string } | AgentPluggedError> {
  const absolute = resolve(cwd, path);
  const name = basename(absolute);
  const folder = dirname(absolute);
  let real: string;
  try {
    real = await realpath(folder);
    if (!(await stat(real)).isDirectory()) return invalid(path, "its folder is not a folder");
  } catch {
    return invalid(path, "its folder does not exist");
  }
  if (inForbiddenFolder(folder) || inForbiddenFolder(real) || FORBIDDEN_FOLDERS.has(name)) {
    return invalid(path, "never inside .agentplugged or .git");
  }
  const target = join(real, name);
  const info = await lstat(target).catch(() => undefined);
  if (info?.isDirectory()) return invalid(path, "it is a folder");
  if (info?.isSymbolicLink()) {
    const followed = await stat(target).catch(() => undefined);
    if (followed === undefined) return invalid(path, "it is a link that leads nowhere");
    if (followed.isDirectory()) return invalid(path, "it is a folder");
  }
  return { files: new NodeWorkspaceFiles(real), name };
}

function noKeychain(): Promise<never> {
  return Promise.reject(
    new Error("history and next read the journal only: they never touch a key"),
  );
}

/**
 * A key store that refuses every access: `history` and `next` open the journal without the
 * keychain, the product key included (they decrypt nothing).
 */
export const NO_KEYCHAIN: KeyStore = {
  readMachineSecret: noKeychain,
  writeMachineSecret: noKeychain,
  readHumanSecret: noKeychain,
  writeHumanSecret: noKeychain,
  readPresenceCredential: noKeychain,
  writePresenceCredential: noKeychain,
  readProductSecret: noKeychain,
  writeProductSecret: noKeychain,
  writeProductBackup: noKeychain,
  readProductBackup: noKeychain,
};
