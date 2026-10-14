import type { FileBinding } from "@agentplugged/crypto";
import { ErrorCode, isSensitivePath, type SensitiveArea } from "@agentplugged/protocol";
import { AgentPluggedError } from "../errors.js";
import { METHOD_DIR } from "../init/layout.js";
import type { WorkspaceFiles } from "../workspace-files.js";

/**
 * The files of the Salle and of the memory: where they live, what their ciphertext
 * is bound to, and the checks every read and write makes first.
 */

/** The file's path in the workspace: `.agentplugged/<area>/<path>`, the path in NFC. */
export function workspacePath(area: SensitiveArea, path: string): string {
  return `${METHOD_DIR}/${area}/${path.normalize("NFC")}`;
}

/** What a file's ciphertext is bound to: its product and its workspace path (NFC). */
export function fileBinding(product: string, area: SensitiveArea, path: string): FileBinding {
  return { productId: product, path: workspacePath(area, path) };
}

function refused(command: string, reason: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
    command,
    field: "path",
    reason: `${command}: path: ${reason}`,
  });
}

/**
 * Refuses a path that leaves its area, or that a case-insensitive file system would mix up:
 * - a symbolic link (a junction on Windows) anywhere on the way, `.agentplugged` itself and the
 *   area's folder included, dangling or not;
 * - a name the tools refuse (`isSensitivePath`: `..`, device names, trailing dot or space…);
 * - a path that differs only by case from another file of the area.
 */
export async function checkSensitivePath(
  files: WorkspaceFiles,
  command: string,
  area: SensitiveArea,
  path: string,
): Promise<AgentPluggedError | undefined> {
  const normalized = path.normalize("NFC");
  if (!isSensitivePath(normalized)) return refused(command, "not a valid path inside the area");
  const isLink = files.isSymbolicLink?.bind(files);
  if (isLink !== undefined) {
    const parts = normalized.split("/");
    const steps = [METHOD_DIR, `${METHOD_DIR}/${area}`];
    for (let i = 1; i <= parts.length; i++) {
      steps.push(workspacePath(area, parts.slice(0, i).join("/")));
    }
    for (const step of steps) {
      let link: boolean;
      try {
        link = await isLink(step);
      } catch {
        link = true;
      }
      if (link) return refused(command, "a symbolic link or a junction leaves the area");
    }
  }
  const target = workspacePath(area, normalized);
  const lower = target.toLowerCase();
  for (const existing of await files.listFiles(`${METHOD_DIR}/${area}`)) {
    const other = existing.normalize("NFC");
    if (other !== target && other.toLowerCase() === lower) {
      return refused(command, `differs only by case from ${existing}`);
    }
  }
  return undefined;
}
