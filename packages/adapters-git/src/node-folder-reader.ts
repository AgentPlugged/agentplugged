import { lstat, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { FolderReader, WorkspaceFiles } from "@agentplugged/core";
import { NodeWorkspaceFiles } from "./node-workspace-files.js";

/** A path as it is compared: one separator, no trailing one, no Windows long-path prefix. */
function keyOf(path: string): string {
  const text = path
    .replaceAll("\\", "/")
    .replace(/^\/\/\?\//, "")
    .replace(/\/+$/, "");
  return process.platform === "win32" ? text.toLowerCase() : text;
}

/**
 * True when `path` or one of its parents is a symbolic link (or a junction). On Windows, a real
 * path can differ from the path asked without any link on the way: a short name (`RUNNER~1`) is
 * spelled in full by `realpath`. Elsewhere, a different real path always comes from a link.
 */
async function throughLink(path: string): Promise<boolean> {
  if (process.platform !== "win32") return true;
  for (let current = path; ; ) {
    if ((await lstat(current)).isSymbolicLink()) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Opens the working copy of a story as read-only files: only a real folder. The folder
 * must exist, must not be a symbolic link (nor a junction), and none of its parents may be one: its
 * real path is the very path `core` asked (a link that leaves the working copy would make the engine
 * read one folder while the shell installs in another). Anything else is undefined.
 */
export class NodeFolderReader implements FolderReader {
  async open(absolute: string): Promise<WorkspaceFiles | undefined> {
    const path = resolve(absolute);
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
      if (keyOf(await realpath(path)) !== keyOf(path) && (await throughLink(path))) {
        return undefined;
      }
    } catch {
      return undefined;
    }
    return new NodeWorkspaceFiles(path);
  }
}
