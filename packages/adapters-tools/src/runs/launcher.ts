import { readFile, stat } from "node:fs/promises";
import { win32 } from "node:path";
import { type Launcher, RunRequestInvalid } from "./contract.js";

/**
 * What to start for the command the machine has. A native executable is started as it is. On
 * Windows an npm-installed tool is a script (`.cmd`) that only forwards to the real program: the
 * real program is found in that script and started directly, so that no command interpreter ever
 * reads the instruction or the permission rules. A script whose target cannot be found is refused,
 * never run through a shell.
 */

const EXECUTABLE = new Set([".exe", ".com"]);
const SCRIPT = new Set([".cmd", ".bat"]);

/** `"%dp0%\relative\path.exe"` or `"%~dp0\relative\path.js"` inside an npm shim. */
const TARGET = /"(?:%dp0%|%~dp0)[\\/]+([^"%]+\.(?:exe|js|cjs|mjs))"/gi;

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function resolveLauncher(
  command: string,
  options: { readonly platform?: NodeJS.Platform; readonly nodePath?: string } = {},
): Promise<Launcher> {
  const windows = (options.platform ?? process.platform) === "win32";
  if (!windows) return { file: command, prefixArgs: [] };
  const ext = win32.extname(command).toLowerCase();
  if (EXECUTABLE.has(ext)) return { file: command, prefixArgs: [] };
  if (!SCRIPT.has(ext))
    throw new RunRequestInvalid("launcher: not a program this adapter can start");
  let text: string;
  try {
    text = await readFile(command, "utf8");
  } catch {
    throw new RunRequestInvalid("launcher: the script of the command cannot be read");
  }
  const base = win32.dirname(command);
  for (const match of text.matchAll(TARGET)) {
    const relative = match[1];
    if (relative === undefined) continue;
    const target = win32.join(base, relative);
    // The shim of a Node script also names Node itself next to it: not the program.
    if (win32.basename(target).toLowerCase() === "node.exe") continue;
    if (!(await isFile(target))) continue;
    if (win32.extname(target).toLowerCase() === ".exe") return { file: target, prefixArgs: [] };
    return { file: options.nodePath ?? process.execPath, prefixArgs: [target] };
  }
  throw new RunRequestInvalid("launcher: the program behind the script was not found");
}
