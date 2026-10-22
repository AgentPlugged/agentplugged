import { existsSync } from "node:fs";
import { win32 } from "node:path";

/**
 * The one shell a Claude Code run keeps for its agents' commands. On Windows the tool uses a
 * Unix-like shell when Git for Windows is installed and offers PowerShell besides; without it,
 * PowerShell is the only shell. Anywhere else there is the Unix-like shell. The run keeps that
 * one and cuts the other (`RunRequest.shell`), so the plan's rules are written for one syntax.
 */

export interface ShellProbe {
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Whether a file exists; the real file system when absent. */
  readonly exists?: (path: string) => boolean;
}

/** The places Git for Windows puts its Unix-like shell, from the folders the system names. */
function gitBashCandidates(env: Readonly<Record<string, string | undefined>>): string[] {
  const found: string[] = [];
  const override = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (override !== undefined && override !== "") found.push(override);
  for (const key of ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]) {
    const root = env[key];
    if (root !== undefined && root !== "") found.push(win32.join(root, "Git", "bin", "bash.exe"));
  }
  const local = env.LOCALAPPDATA;
  if (local !== undefined && local !== "") {
    found.push(win32.join(local, "Programs", "Git", "bin", "bash.exe"));
  }
  // Git is on the path as <root>\cmd\git.exe (or <root>\bin\git.exe): its shell is beside it.
  for (const folder of (env.PATH ?? env.Path ?? "").split(";")) {
    const parts = folder.replace(/[\\/]+$/u, "").split(/[\\/]/u);
    const last = parts.at(-1)?.toLowerCase();
    // Only the `cmd` folder is Git's own; a `bin` folder may be another toolset's.
    if (last === "cmd" && parts.length > 2) {
      found.push(win32.join(parts.slice(0, -1).join("\\"), "bin", "bash.exe"));
    }
  }
  return found;
}

export function chooseShell(probe: ShellProbe = {}): "bash" | "powershell" {
  const platform = probe.platform ?? process.platform;
  if (platform !== "win32") return "bash";
  const env = probe.env ?? process.env;
  const exists = probe.exists ?? existsSync;
  return gitBashCandidates(env).some((path) => {
    try {
      return exists(path);
    } catch {
      return false;
    }
  })
    ? "bash"
    : "powershell";
}
