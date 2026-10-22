/** A command prefix: words, paths and options only; nothing the tool's rule syntax could read as a pattern. */
const PREFIX = /^(?:[A-Za-z0-9][A-Za-z0-9._/ -]{0,98}[A-Za-z0-9]|[A-Za-z0-9])$/u;

/** Programs that run any code, or reach the network or the disk widely: never offered, never allowed. */
const NEVER_ALLOWED = new Set([
  ...["bash", "sh", "zsh", "fish", "dash", "cmd", "powershell", "pwsh"],
  ...["node", "deno", "bun", "perl", "ruby", "php"],
  ...["npx", "bunx", "pnpx", "env", "eval", "exec", "xargs", "sudo", "doas", "ssh", "docker"],
  ...["find", "dd", "rm", "del", "rmdir", "rd", "chmod", "chown", "mkfs", "curl", "wget", "nc"],
]);
/** Programs that need a second word, which must not be one that runs another program. */
const NEEDS_SUBCOMMAND = new Set(["pnpm", "npm", "yarn", "git"]);
const RUNS_ANOTHER = new Set(["dlx", "exec", "x", "create", "run-script", "config", "init"]);

/** Why a refused command has no button: it runs anything, Git was given a folder, or a sub-command is missing. */
export type RefusalReason = "runs_anything" | "git_folder" | "subcommand";

/**
 * Why a refused command line is not offered to the creator, from its first two words. Undefined
 * when no useful reason can be told (an odd line); never throws.
 */
export function refusalReason(
  first: string,
  second: string | undefined,
): RefusalReason | undefined {
  const program = first
    .split("/")
    .pop()
    ?.toLowerCase()
    .replace(/\.(?:exe|cmd|bat|com)$/u, "");
  if (program === undefined || program === "") return undefined;
  if (NEVER_ALLOWED.has(program) || /^python[0-9.]*$/u.test(program)) return "runs_anything";
  if (program === "git" && second === "-C") return "git_folder";
  if (NEEDS_SUBCOMMAND.has(program)) {
    return second !== undefined && RUNS_ANOTHER.has(second.toLowerCase())
      ? "runs_anything"
      : "subcommand";
  }
  return undefined;
}

/**
 * Whether a command prefix may be offered to the creator to allow to the agents: plain words, not
 * a program that runs any code, and for a package manager or Git a real sub-command (never `pnpm`
 * alone or `pnpm dlx`).
 */
export function isAllowableCommand(prefix: string): boolean {
  if (!PREFIX.test(prefix)) return false;
  const words = prefix.split(" ").filter((word) => word !== "");
  const program = (words[0] ?? "")
    .split("/")
    .pop()
    ?.toLowerCase()
    .replace(/\.(?:exe|cmd|bat|com)$/u, "");
  if (program === undefined || program === "") return false;
  if (NEVER_ALLOWED.has(program) || /^python[0-9.]*$/u.test(program)) return false;
  if (NEEDS_SUBCOMMAND.has(program)) {
    const second = words[1]?.toLowerCase();
    return second !== undefined && !RUNS_ANOTHER.has(second);
  }
  return true;
}
