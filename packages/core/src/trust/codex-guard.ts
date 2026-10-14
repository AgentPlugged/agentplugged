import { MAIN_SESSION_AGENT } from "@agentplugged/protocol";
import {
  CODEX_HOOK_NAME,
  CODEX_POLICY_PATH,
  CODEX_UNCHECKED_REASON,
  codexSessionIdOf,
} from "../chat/codex-hook.js";
import type { CommandContext } from "../command.js";
import { isRecord } from "../values.js";
import type { AntigravityCall, GuardFlavor } from "./antigravity-guard.js";
import { isNetworkCommand } from "./command-match.js";
import { recordExternalReadCommand } from "./trust-commands.js";

/**
 * The permission rules of the product applied before each tool Codex runs: what the
 * project's `PreToolUse` hook asks the engine (`agentplugged hook codex pre-tool`), and the reads of
 * external content its `PostToolUse` hook has the engine record. The rules are the ones of
 * Antigravity's guard (`antigravity-guard.ts`), applied to Codex's tool calls: this module only says
 * what a Codex call is (a shell command, the files a patch touches) and what differs for the tool.
 */

/** The files a patch (`apply_patch`) adds, updates, deletes or moves, as the patch names them. */
export function patchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const found = /^\s*\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$/.exec(line);
    if (found !== null) paths.push(found[1] as string);
  }
  return paths;
}

/** A path as a command line gives it: absolute, or from the home folder, or from `cwd`. */
const isAbsolute = (path: string) => /^(?:[A-Za-z]:)?[\\/]|^~/.test(path);

/** The text of a shell command: Codex gives a string, or the words of the program it runs. */
function commandText(command: unknown): string | undefined {
  if (typeof command === "string") return command;
  if (Array.isArray(command) && command.every((word) => typeof word === "string")) {
    const words = command as string[];
    // `["bash", "-lc", "git push"]`: the script is the last word.
    return /^-\w*c$/.test(words.at(-2) ?? "") ? words.at(-1) : words.join(" ");
  }
  return undefined;
}

/**
 * The call of a Codex hook's input, in the vocabulary of the guard (`run_command`, `write_to_file`:
 * the rules were written for Antigravity first): `Bash` is a shell command (`tool_input.command`, run
 * from `workdir` or the session's `cwd`), `apply_patch` writes the files its patch names (from the
 * session's `cwd` when they are relative), any other tool is looked at by its arguments. A call that
 * cannot be read (a command that is no text, a patch that names no file) is `undefined`: the hook
 * denies it, never lets it through unseen.
 */
export function codexCallOf(input: unknown): AntigravityCall | undefined {
  if (!isRecord(input)) return undefined;
  const name = input.tool_name;
  if (typeof name !== "string" || name === "") return undefined;
  const args = isRecord(input.tool_input) ? input.tool_input : {};
  const session = typeof input.cwd === "string" && input.cwd.trim() !== "" ? input.cwd : undefined;
  if (name === "Bash") {
    const command = commandText(args.command);
    if (command === undefined) return undefined;
    const workdir = [args.workdir, args.cwd, session].find(
      (value): value is string => typeof value === "string" && value.trim() !== "",
    );
    return {
      name: "run_command",
      args: { CommandLine: command, ...(workdir === undefined ? {} : { Cwd: workdir }) },
    };
  }
  if (name === "apply_patch") {
    const named = patchPaths(typeof args.command === "string" ? args.command : "");
    if (named.length === 0) return undefined;
    return {
      name: "write_to_file",
      args: {
        TargetFile: named.map((path) =>
          session === undefined || isAbsolute(path) ? path : `${session}/${path}`,
        ),
      },
    };
  }
  return { name, args };
}

/** The Codex session behind a hook's input, for the journal. */
export function codexSessionOf(input: unknown): string | undefined {
  return isRecord(input) ? codexSessionIdOf(input.session_id) : undefined;
}

/** What differs for Codex: where the policy is, what a command may not touch, who may not be started. */
export const CODEX_FLAVOR: GuardFlavor = {
  policyPath: CODEX_POLICY_PATH,
  // The chat's store, the transcripts and history Codex keeps, and the hook's own files.
  guardedText: new RegExp(
    String.raw`\.agentplugged[\\/]chat|\.codex[\\/](?:sessions|archived_sessions|history|config\.toml|hooks|rules)|${CODEX_HOOK_NAME}|agentplugged-policy\.json`,
    "i",
  ),
  agentPrograms: new Set(["codex"]),
  startsAgentReason:
    "AgentPlugged: an agent never starts a Codex session (what it wrote there would pass for a message of the creator).",
  guardedReason:
    "AgentPlugged: agents never write the product's Codex hooks, Codex's transcripts nor the store of the creator's messages.",
  unreadableReason: `AgentPlugged: the permission rules of this product are not readable (\`${CODEX_POLICY_PATH}\`): the creator runs \`npx agentplugged sync\`.`,
  uncheckedReason: CODEX_UNCHECKED_REASON,
  guardsShellReads: true,
};

/** What a read of external content is called in the journal: Claude Code's names, for one record. */
function readOf(
  call: AntigravityCall,
  tool: string,
): { tool: string; source?: string } | undefined {
  if (tool === "Bash") {
    const command = call.args.CommandLine;
    return typeof command === "string" && isNetworkCommand(command)
      ? { tool: "Bash", source: command }
      : undefined;
  }
  if (tool.startsWith("mcp__") && !tool.startsWith("mcp__agentplugged__")) return { tool };
  return undefined;
}

/**
 * Records the read a Codex tool call made of external content: a network command or a
 * tool of another MCP server, a trace in the journal, nothing is blocked for it. Never
 * throws: a read that could not be recorded is tried again by the next call.
 */
export async function recordCodexRead(
  context: CommandContext,
  input: unknown,
  session: string | undefined,
): Promise<void> {
  const call = codexCallOf(input);
  const tool = isRecord(input) && typeof input.tool_name === "string" ? input.tool_name : "";
  if (call === undefined) return;
  const read = readOf(call, tool);
  if (read === undefined) return;
  try {
    // No session object: the journal is the memory between two hooks, which are two processes.
    const { session: _none, ...bare } = context;
    await recordExternalReadCommand.run(
      { ...bare, actor: "agent" },
      {
        tool: read.tool,
        ...(read.source === undefined ? {} : { source: read.source }),
        session: session ?? "",
        agent: MAIN_SESSION_AGENT,
      },
    );
  } catch {
    // Best effort, like the Claude Code hook.
  }
}
