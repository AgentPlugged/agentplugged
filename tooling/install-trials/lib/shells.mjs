// The terminals the install trials type their commands into: the commands run as a
// creator types them, through the shell, not through a direct spawn. A shell the machine does not
// have is reported as missing, never silently skipped.

import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export const WINDOWS = process.platform === "win32";

/** Terminals by platform, the native one first. */
export const SHELLS_BY_PLATFORM = {
  win32: ["powershell", "pwsh", "cmd", "bash"],
  darwin: ["zsh", "bash", "sh"],
  linux: ["bash", "zsh", "sh"],
};

/** The terminals of the running platform, the native one first. */
export function shellsHere(platform = process.platform) {
  return SHELLS_BY_PLATFORM[platform] ?? SHELLS_BY_PLATFORM.linux;
}

/** The extensions Windows runs by name. */
function extensionsOf(env) {
  return WINDOWS ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The first folder-listed program `name` in `pathValue`; undefined when none. */
export function findOnPath(name, pathValue, env = process.env) {
  for (const dir of (pathValue ?? "").split(delimiter)) {
    if (dir.trim() === "") continue;
    for (const extension of extensionsOf(env)) {
      const candidate = join(dir, `${name}${extension}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** The absolute path of a terminal on this machine; undefined when it is not there. */
export function findShell(shell, env = process.env) {
  const pathValue = env.PATH ?? env.Path ?? "";
  if (shell === "cmd") {
    if (!WINDOWS) return undefined;
    const comspec = env.ComSpec ?? env.COMSPEC ?? "C:\\Windows\\System32\\cmd.exe";
    return isFile(comspec) ? comspec : undefined;
  }
  if (shell === "powershell") {
    if (!WINDOWS) return undefined;
    const root = env.SystemRoot ?? env.windir ?? "C:\\Windows";
    const known = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return isFile(known) ? known : findOnPath("powershell", pathValue, env);
  }
  if (shell === "bash" && WINDOWS) {
    // Git Bash, not the launcher of the Windows Subsystem for Linux that System32 holds.
    for (const base of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs")]) {
      if (!base) continue;
      const candidate = join(base, "Git", "bin", "bash.exe");
      if (isFile(candidate)) return candidate;
    }
    const found = findOnPath("bash", pathValue, env);
    return found !== undefined && !/[\\/]system32[\\/]/i.test(found) ? found : undefined;
  }
  return findOnPath(shell, pathValue, env);
}

const SIMPLE = /^[\w@%+=:,./\\-]+$/;

/** One argument, quoted for a terminal. */
export function quoteFor(shell, argument) {
  if (shell === "cmd") {
    // `%VAR%` is expanded even between quotes, and a backslash before the closing quote escapes it.
    if (/["%^&|<>]/.test(argument) || argument.endsWith("\\")) {
      throw new Error(`the argument ${JSON.stringify(argument)} cannot be quoted safely for cmd`);
    }
    return argument !== "" && SIMPLE.test(argument) ? argument : `"${argument}"`;
  }
  if (shell === "powershell" || shell === "pwsh") {
    if (argument !== "" && SIMPLE.test(argument)) return argument;
    return `'${argument.replaceAll("'", "''")}'`;
  }
  if (argument !== "" && SIMPLE.test(argument) && !argument.includes("\\")) return argument;
  return `'${argument.replaceAll("'", "'\\''")}'`;
}

/** A command as a creator types it in this terminal: the program, then its arguments. */
export function lineFor(shell, argv) {
  return argv.map((argument) => quoteFor(shell, argument)).join(" ");
}

/**
 * How to start this terminal on one command line: the program and its arguments, and whether
 * Windows must hand the arguments over as they are (`cmd`).
 */
export function shellInvocation(shell, shellPath, line) {
  switch (shell) {
    case "cmd":
      return { command: shellPath, args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
    case "powershell":
      return {
        command: shellPath,
        // No `-ExecutionPolicy`: the machine's own policy applies, as it does to a creator.
        args: ["-NoProfile", "-NonInteractive", "-Command", `${line}; exit $LASTEXITCODE`],
        verbatim: false,
      };
    case "pwsh":
      return {
        command: shellPath,
        args: ["-NoProfile", "-NonInteractive", "-Command", `${line}; exit $LASTEXITCODE`],
        verbatim: false,
      };
    default:
      return { command: shellPath, args: ["-c", line], verbatim: false };
  }
}

/** True when a folder holds one of these programs (by name, with the extensions of the system). */
export function folderHolds(dir, names, env = process.env) {
  if (!existsSync(dir)) return false;
  return names.some((name) => extensionsOf(env).some((extension) => isFile(join(dir, `${name}${extension}`))));
}
