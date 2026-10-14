import { MAIN_SESSION_AGENT } from "@agentplugged/protocol";
import { ANTIGRAVITY_POLICY_PATH, ANTIGRAVITY_UNCHECKED_REASON } from "../chat/antigravity-hook.js";
import type { CommandContext } from "../command.js";
import { isRecord, isStrings } from "../values.js";
import { type AntigravityPolicy, parsePolicy } from "./antigravity-policy.js";
import {
  commandForms,
  commandMatches,
  isNetworkCommand,
  matchesAny,
  patternOf,
  subcommands,
} from "./command-match.js";
import { AgentSession } from "./session.js";
import { checkActionCommand, recordExternalReadCommand } from "./trust-commands.js";

/**
 * The permission rules of the product, applied before each tool Antigravity runs: what
 * the plugin's `PreToolUse` hook asks the engine (`agentplugged hook antigravity pre-tool`), and the
 * reads of external content its `PostToolUse` hook has the engine record.
 *
 * Antigravity reads no permission file from a project: its only guard is a hook that answers
 * `allow`, `ask` or `deny` (a hook with no answer is a denial). So `sync` writes the lists it writes
 * in Claude Code's `.claude/settings.json` (`policy.json`: the same `Bash(…)`, `Edit(…)`, `Read(…)`,
 * `WebFetch` and `WebSearch` rules, from the same functions) and this module applies them with the
 * engine's own command reader (`trust/command-match.ts`): `deny`, then `ask`, then the gate of
 * `check_action` for a high-risk command that is not denied. Never an `allow` that lifts the tool's
 * own prompt: an `allow` here only means the product has no objection.
 *
 * Best effort, like every rule of the product: a shell can reach a program another way, and the
 * path rules cover the file tools only (a command that writes is read by its words).
 */

/** One tool call of the hook's input: its name and its arguments. */
export interface AntigravityCall {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** The call of a hook's input (`toolCall`), or undefined when it has none. */
export function callOf(input: unknown): AntigravityCall | undefined {
  if (!isRecord(input) || !isRecord(input.toolCall)) return undefined;
  const { name, args } = input.toolCall;
  if (typeof name !== "string" || name === "") return undefined;
  return { name, args: isRecord(args) ? args : {} };
}

/** The answer of the pre-tool hook. `ask` and `deny` carry the reason the agent reads. */
export type GuardDecision =
  | { readonly decision: "allow" }
  | { readonly decision: "ask" | "deny"; readonly reason: string };

const ALLOW: GuardDecision = { decision: "allow" };
const deny = (reason: string): GuardDecision => ({ decision: "deny", reason });
const ask = (reason: string): GuardDecision => ({ decision: "ask", reason });

/** Tools that write a file, and those that read one (Antigravity's names, 1.2.16). */
const WRITE_TOOLS = new Set([
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "sed_file",
  "notebook_edit",
  "notebook_execution",
]);
const READ_TOOLS = new Set(["view_file", "list_dir", "grep_search", "find_by_name"]);
/** Tools that fetch a page or open one (`WebFetch`), and that search the web (`WebSearch`). */
const FETCH_TOOLS = new Set(["read_url_content", "open_browser_url", "browser_subagent"]);
const SEARCH_TOOLS = new Set(["search_web"]);
/** Tools that read a resource of an MCP server. */
const RESOURCE_TOOLS = new Set(["read_resource", "list_resources"]);
/** Tools that bring nothing to check. */
const NO_CHECK = new Set([
  "ask_question",
  "ask_permission",
  "ask_custom_permission",
  "command_status",
  "finish",
  "manage_task",
  "manage_inbox",
  "manage_subagents",
  "send_message",
  "wait",
  "wait_5_seconds",
  "list_permissions",
  "invoke_subagent",
  "define_subagent",
  "schedule",
  "list_plugin_accounts",
  "search_marketplace",
  "run_workflow",
  "call_mcp_tool",
]);

/** The arguments that name a path (a key holding `file`, `path`, `dir`, `folder`, `cwd`). */
const PATH_KEY = /file|path|dir|folder|cwd|source|dest|target/i;
/** What the agent writes in a call, never a path. */
const NOT_PATH = new Set([
  "toolAction",
  "toolSummary",
  "Description",
  "Instruction",
  "Prompt",
  "Message",
  "CodeContent",
  "ReplacementContent",
  "TargetContent",
]);

/** The paths a call names, as written. */
export function pathsOf(args: Readonly<Record<string, unknown>>): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (NOT_PATH.has(key) || !PATH_KEY.test(key)) continue;
    if (typeof value === "string" && value.trim() !== "") paths.push(value);
    else if (isStrings(value)) paths.push(...value.filter((path) => path.trim() !== ""));
  }
  return paths;
}

/** Where the paths of the rules are read from: the project's folder and the home folder. */
export interface GuardPlace {
  readonly root: string;
  readonly home: string;
  /**
   * The path as the file system names it (Windows short names `AGENTP~1`, junctions and links
   * settled): given by the surface, which can read the disk; `core` reads none. A rule is tried on
   * the path as written and on this one.
   */
  readonly resolve?: (path: string) => string;
}

/**
 * A path as the rules compare it: forward slashes, lower case, no trailing slash, and the spellings
 * Windows reads as the same file given one form: `file:///` URLs (percent escapes decoded), the
 * `\\?\` and `\\.\` prefixes, a drive reached through an administrative share
 * (`\\localhost\C$\…`).
 */
function slashes(path: string): string {
  let text = path.trim();
  if (/^file:/i.test(text)) {
    try {
      text = decodeURIComponent(text);
    } catch {
      // Left as written: the escapes stay, and match nothing.
    }
  }
  text = text
    .replace(/^file:\/+(?=[A-Za-z]:)/i, "")
    .replace(/^file:\/\//i, "")
    .replaceAll("\\", "/")
    // `//?/C:/x`, `//./C:/x`, `//host/C$/x`: the drive's own path.
    .replace(/^\/\/[?.]\/(?:UNC\/[^/]+\/)?/i, "")
    .replace(/^\/\/[^/]+\/([a-z])\$(?=\/|$)/i, "$1:");
  return text
    .replace(/\/+/g, "/")
    .replace(/(.)\/+$/, "$1")
    .toLowerCase();
}

/**
 * One segment of a path as Windows reads it: no alternate data stream (`method.yaml::$DATA`,
 * `method.yaml:stream`), no trailing dots or blanks (`method.yaml.` is `method.yaml`).
 */
function segmentOf(part: string): string {
  const colon = part.indexOf(":");
  const name = colon === -1 ? part : part.slice(0, colon);
  return name.replace(/[. ]+$/, "");
}

/** The absolute form of a path, `.` and `..` settled (no file system is read). */
export function absolutePath(path: string, place: GuardPlace): string {
  let text = slashes(path);
  if (text === "~" || text.startsWith("~/")) text = `${slashes(place.home)}${text.slice(1)}`;
  else if (!/^(?:[a-z]:)?\//.test(text)) text = `${slashes(place.root)}/${text}`;
  const drive = /^[a-z]:/.exec(text)?.[0] ?? "";
  const parts: string[] = [];
  for (const raw of text.slice(drive.length).split("/")) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") {
      parts.pop();
      continue;
    }
    const part = segmentOf(raw);
    if (part !== "") parts.push(part);
  }
  return `${drive}/${parts.join("/")}`;
}

/** A glob (`**`, `*`, `?`) as a regular expression over a lower-case relative path. */
function globOf(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] as string;
    if (char === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "s");
}

/**
 * True when a rule's path (`/.agentplugged/agents/**` from the project's root, `~/.ssh/**` from the
 * home folder, `**\/.env*` anywhere) covers `path`.
 */
export function pathMatches(pattern: string, path: string, place: GuardPlace): boolean {
  // The path as written and as the file system names it. A folder is covered when what it holds
  // is (`grep_search` on `~/.ssh` reads `~/.ssh/**`).
  const named = [path];
  try {
    const resolved = place.resolve?.(path);
    if (resolved !== undefined) named.push(resolved);
  } catch {
    // The disk could not say: the path as written.
  }
  const forms = named.flatMap((entry) => {
    const absolute = absolutePath(entry, place);
    return [absolute, `${absolute}/`];
  });
  // The base too, as written and as the file system names it: a project reached through a short
  // name (`RUNNER~1`) or a link has its files named under the other spelling once settled.
  const rooted = (base: string, glob: string): boolean => {
    const bases = [base];
    try {
      const resolved = place.resolve?.(base);
      if (resolved !== undefined) bases.push(resolved);
    } catch {
      // The disk could not say: the base as written.
    }
    return bases.some((entry) => {
      const from = `${slashes(entry)}/`;
      return forms.some(
        (form) =>
          (form === from || form.startsWith(from)) && globOf(glob).test(form.slice(from.length)),
      );
    });
  };
  if (pattern.startsWith("~/")) return rooted(place.home, slashes(pattern.slice(2)));
  if (pattern.startsWith("/")) return rooted(place.root, slashes(pattern.slice(1)));
  return forms.some((form) => globOf(slashes(pattern)).test(form.slice(1)));
}

/** The `kind(argument)` of a rule, or the bare name (`WebFetch`). */
function parseRule(rule: string): { kind: string; argument: string } {
  const match = /^([A-Za-z]+)\((.*)\)$/s.exec(rule);
  return match === null
    ? { kind: rule, argument: "" }
    : { kind: match[1] as string, argument: match[2] as string };
}

/** What a call is, for the rules. */
type Kind =
  | { readonly kind: "shell"; readonly command: string; readonly cwd?: string }
  | {
      readonly kind: "paths";
      readonly write: boolean;
      readonly read: boolean;
      readonly paths: string[];
    }
  | { readonly kind: "web"; readonly tool: "WebFetch" | "WebSearch" }
  | { readonly kind: "none" };

function classify(call: AntigravityCall): Kind {
  const { name, args } = call;
  if (name === "run_command") {
    return {
      kind: "shell",
      command: typeof args.CommandLine === "string" ? args.CommandLine : "",
      ...(typeof args.Cwd === "string" && args.Cwd.trim() !== "" ? { cwd: args.Cwd } : {}),
    };
  }
  // Text typed into a command that is already running reaches a shell too: every text it carries,
  // whatever the argument is called.
  if (name === "send_command_input") {
    const typed = Object.entries(args)
      .filter(
        ([key, value]) => typeof value === "string" && !NOT_PATH.has(key) && !/id$/i.test(key),
      )
      .map(([, value]) => value as string);
    return { kind: "shell", command: typed.join("\n") };
  }
  if (FETCH_TOOLS.has(name)) return { kind: "web", tool: "WebFetch" };
  if (SEARCH_TOOLS.has(name)) return { kind: "web", tool: "WebSearch" };
  if (NO_CHECK.has(name) || RESOURCE_TOOLS.has(name)) return { kind: "none" };
  // A tool we do not know that carries a command (a renamed shell tool): a shell.
  const carried = Object.entries(args).find(
    ([key, value]) =>
      typeof value === "string" && /command|cmdline|script|shell/i.test(key) && !NOT_PATH.has(key),
  );
  if (carried !== undefined && !WRITE_TOOLS.has(name) && !READ_TOOLS.has(name)) {
    return { kind: "shell", command: carried[1] as string };
  }
  const paths = pathsOf(args);
  const write = WRITE_TOOLS.has(name);
  const read = READ_TOOLS.has(name);
  // A tool we do not know that names a path: checked as writing and as reading.
  if (paths.length > 0)
    return { kind: "paths", write: write || !read, read: read || !write, paths };
  return { kind: "none" };
}

/** Programs that only read: a command that names a protected folder is allowed to read it. */
const READERS = new Set([
  "cat",
  "type",
  "get-content",
  "gc",
  "ls",
  "dir",
  "get-childitem",
  "gci",
  "head",
  "tail",
  "grep",
  "rg",
  "findstr",
  "select-string",
  "sls",
  "wc",
  "stat",
  "test-path",
  "get-item",
  "get-itemproperty",
  "where",
  "which",
  "get-command",
  "gcm",
]);

/**
 * What a shell command may never name unless it only reads: the transcripts, the chat's store, the
 * product's own plugin (its hooks, its rules, its script: whoever writes them lifts the guard) and
 * Antigravity's settings and its program (`agy.exe`, its folder: copying it under another name would
 * hide a session an agent starts). The path rules cover the file tools; this covers the commands
 * that write the same places (a best effort: a path built piece by piece is not read).
 */
const GUARDED_TEXT =
  /\.system_generated|\.agentplugged[\\/]chat|\.agents(?![\w-])|\.gemini|agy\.exe/i;

/** The word that names a program, without quotes, directory or extension. */
function programName(word: string): string {
  const bare = word.replace(/^[&'"]+|['"]+$/g, "");
  const name = bare.split(/[\\/]/).pop() ?? "";
  return name.replace(/\.(?:exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

/** Antigravity itself, or what launches a program given by name. */
const AGENT_PROGRAMS: ReadonlySet<string> = new Set(["agy", "antigravity"]);
const LAUNCHERS = new Set([
  "start",
  "start-process",
  "saps",
  "call",
  "invoke-expression",
  "iex",
  "invoke-command",
  "icm",
  "npx",
  "pnpx",
  "bunx",
  "env",
  "sudo",
  "nohup",
  "cmd",
  "powershell",
  "pwsh",
  "sh",
  "bash",
  // Package managers and wrappers that run a program they are given (`pnpm dlx @openai/codex`).
  "pnpm",
  "yarn",
  "npm",
  "timeout",
  "time",
  "xargs",
  "command",
  "exec",
]);

/** Programs that put a file's content on the screen or in another place: a read of what they are given. */
const SHELL_READERS = new Set([
  "cat",
  "type",
  "get-content",
  "gc",
  "head",
  "tail",
  "grep",
  "rg",
  "findstr",
  "select-string",
  "sls",
  "wc",
  "less",
  "more",
  "sed",
  "awk",
  "base64",
  "cp",
  "copy",
  "scp",
  "xxd",
  "strings",
  "cut",
  "sort",
  "tar",
  "zip",
  "openssl",
  "curl",
  "wget",
  "iwr",
  "irm",
]);

/** A word of a command as a path: quotes and redirections off, the home folder spelled `~`. */
function pathWord(word: string): string {
  return word
    .replace(/^[<>@&'"]+|['"]+$/g, "")
    .replace(/^(?:\$HOME|\$env:USERPROFILE|%USERPROFILE%|\$\{HOME\})(?=[\\/]|$)/i, "~");
}

/**
 * The rule of `Read(…)` (the secrets) that a reading program names in a shell command, if any: the
 * file tools are checked by their path, and a shell reads the same files by their name.
 */
function secretRead(
  list: readonly string[],
  command: string,
  place: GuardPlace,
): { rule: string; path: string } | undefined {
  const rules = list.map(parseRule).filter((entry) => entry.kind === "Read");
  if (rules.length === 0) return undefined;
  for (const part of subcommands(command)) {
    const words = (commandForms(part).at(-1) ?? part).split(/\s+/).filter((word) => word !== "");
    if (!SHELL_READERS.has(programName(words[0] ?? ""))) continue;
    for (const word of words.slice(1)) {
      const path = pathWord(word);
      if (path === "" || path.startsWith("-")) continue;
      const found = rules.find((rule) => pathMatches(rule.argument, path, place));
      if (found !== undefined) return { rule: `Read(${found.argument})`, path };
    }
  }
  return undefined;
}

/**
 * True when a command starts an Antigravity session (`agy -p`): a session an agent starts itself
 * would carry what the agent wrote as if the creator had typed it. The program may be a path, a
 * quoted word, or what a launcher is given.
 */
export function startsAgent(
  command: string,
  programs: ReadonlySet<string> = AGENT_PROGRAMS,
): boolean {
  for (const part of subcommands(command)) {
    const words = (commandForms(part).at(-1) ?? part).split(/\s+/).filter((word) => word !== "");
    const first = programName(words[0] ?? "");
    if (programs.has(first)) return true;
    if (LAUNCHERS.has(first) && words.slice(1, 4).some((word) => programs.has(programName(word)))) {
      return true;
    }
  }
  return false;
}

/**
 * True when every part of the command is a program that only reads, with no redirection: a reader
 * that writes through `>` or `>>` (`cat a > file`) writes.
 */
function onlyReads(command: string): boolean {
  const parts = subcommands(command);
  return (
    parts.length > 0 &&
    parts.every(
      (part) => READERS.has(programName(part.split(/\s+/)[0] ?? "")) && !part.includes(">"),
    )
  );
}

/** The rule of a list that covers a shell command, a path or a web tool, if any. */
function listed(
  list: readonly string[],
  call: Kind,
  place: GuardPlace,
): { rule: string; path?: string } | undefined {
  for (const rule of list) {
    const { kind, argument } = parseRule(rule);
    if (call.kind === "shell" && kind === "Bash") {
      const pattern = patternOf(rule);
      if (
        pattern !== undefined &&
        subcommands(call.command).some((part) => matchesAny(part, [pattern]))
      ) {
        return { rule };
      }
    } else if (call.kind === "paths") {
      const wanted = (kind === "Edit" || kind === "Write") && call.write;
      if (!wanted && !(kind === "Read" && call.read)) continue;
      const path = call.paths.find((entry) => pathMatches(argument, entry, place));
      if (path !== undefined) return { rule, path };
    } else if (call.kind === "web" && kind === call.tool) {
      return { rule };
    }
  }
  return undefined;
}

/**
 * What differs between the tools whose hook this guard serves: the text a command may not name
 * unless it only reads, the programs that start a session of the tool, the file holding the policy,
 * and the words of the refusals.
 */
export interface GuardFlavor {
  readonly policyPath: string;
  readonly guardedText: RegExp;
  readonly agentPrograms: ReadonlySet<string>;
  readonly startsAgentReason: string;
  readonly guardedReason: string;
  readonly unreadableReason: string;
  readonly uncheckedReason: string;
  /** A shell command that reads a file the `Read(…)` rules protect is denied (Codex reads by shell only). */
  readonly guardsShellReads?: boolean;
}

const ANTIGRAVITY_FLAVOR: GuardFlavor = {
  policyPath: ANTIGRAVITY_POLICY_PATH,
  guardedText: GUARDED_TEXT,
  agentPrograms: AGENT_PROGRAMS,
  startsAgentReason:
    "AgentPlugged: an agent never starts an Antigravity session (what it wrote there would pass for a message of the creator).",
  guardedReason:
    "AgentPlugged: agents never write the product's Antigravity plugin, Antigravity's settings or program, the conversations' transcripts nor the store of the creator's messages.",
  unreadableReason:
    "AgentPlugged: the permission rules of this product are not readable (`policy.json` of the Antigravity plugin): the creator runs `npx agentplugged sync`.",
  uncheckedReason: ANTIGRAVITY_UNCHECKED_REASON,
};

/**
 * What the product's rules say of a call, without the gate: `deny` (a rule of the deny list, a
 * session of Antigravity an agent would start, a command that touches the transcripts or the chat's
 * store), `ask` (a rule of the ask list), else `allow`.
 */
export function policyDecision(
  policy: AntigravityPolicy,
  call: AntigravityCall,
  place: GuardPlace,
  flavor: GuardFlavor = ANTIGRAVITY_FLAVOR,
): GuardDecision {
  const kind = classify(call);
  if (kind.kind === "none") return ALLOW;
  if (kind.kind === "shell") {
    if (startsAgent(kind.command, flavor.agentPrograms)) return deny(flavor.startsAgentReason);
    // The folder the command runs in counts as a word of it: `Set-Content policy.json` run from
    // the plugin's folder names no guarded path.
    const where = `${kind.cwd ?? ""}\n${kind.command}`;
    const protectedFolder =
      kind.cwd !== undefined &&
      policy.deny.some((rule) => {
        const { kind: ruleKind, argument } = parseRule(rule);
        // Not the blanket `Edit(/**)` of an `edit_code` rule that denies: every command would stop.
        return (
          ruleKind === "Edit" &&
          argument !== "/**" &&
          pathMatches(argument, kind.cwd as string, place)
        );
      });
    if ((flavor.guardedText.test(where) || protectedFolder) && !onlyReads(kind.command)) {
      return deny(flavor.guardedReason);
    }
  }
  if (kind.kind === "shell" && flavor.guardsShellReads === true) {
    const secret = secretRead(policy.deny, kind.command, place);
    if (secret !== undefined) {
      return deny(
        `AgentPlugged: the permission rules deny this action on ${secret.path} (${secret.rule}).`,
      );
    }
  }
  const denied = listed(policy.deny, kind, place);
  if (denied !== undefined) {
    return deny(
      denied.path === undefined
        ? `AgentPlugged: the permission rules deny this action (${denied.rule}).`
        : `AgentPlugged: the permission rules deny this action on ${denied.path} (${denied.rule}).`,
    );
  }
  const asked = listed(policy.ask, kind, place);
  if (asked !== undefined) {
    return ask(
      asked.path === undefined
        ? `AgentPlugged: the permission rules ask the creator first (${asked.rule}).`
        : `AgentPlugged: the permission rules ask the creator first for ${asked.path} (${asked.rule}).`,
    );
  }
  return ALLOW;
}

/** What `sync` wrote and the engine read: the policy and where the project is. */
export interface GuardEnvironment {
  readonly place: GuardPlace;
  /** The Antigravity conversation: the session id the gate and the reads are recorded under. */
  readonly conversation: string | undefined;
  /** The tool the hook serves; Antigravity's by default. */
  readonly flavor?: GuardFlavor;
}

/** The answer of `check_action` as a decision: nothing (`{}`) lets the policy decide. */
function gateDecision(answer: unknown): GuardDecision | undefined {
  if (!isRecord(answer) || !isRecord(answer.hookSpecificOutput)) return undefined;
  const { permissionDecision, permissionDecisionReason } = answer.hookSpecificOutput;
  const reason = typeof permissionDecisionReason === "string" ? permissionDecisionReason : "";
  return permissionDecision === "deny" ? deny(reason) : undefined;
}

/**
 * The gate of the installations (`check_action`): when the rule of the
 * installations is not `deny` and the command matches its patterns, the same decision as Claude
 * Code's hook (recorded in the activity, or validated at the `validate` mode). The session is the
 * Antigravity conversation: what it read is a trace in the journal, by the conversation's id, as it
 * is for a Claude Code session.
 */
async function gate(
  context: CommandContext,
  policy: AntigravityPolicy,
  command: string,
  cwd: string | undefined,
  conversation: string | undefined,
  flavor: GuardFlavor,
): Promise<GuardDecision> {
  const session = new AgentSession((context.now ?? Date.now)());
  session.learn(conversation);
  const gated: CommandContext = { ...context, actor: "agent", session };
  if (
    policy.rules.install_dependency === "deny" ||
    !commandMatches("install_dependency", command, policy.main_branch)
  ) {
    return ALLOW;
  }
  const result = await checkActionCommand.run(gated, {
    action: "install_dependency",
    command,
    session: conversation ?? "",
    ...(cwd === undefined ? {} : { cwd }),
  });
  if (!result.ok) return deny(flavor.uncheckedReason);
  return gateDecision(result.value) ?? ALLOW;
}

/**
 * The decision for one tool call: the product's rules, then the gate of a shell command. Fails
 * closed: a policy that is missing or unreadable denies (`sync` writes it), as does a gate that
 * could not finish.
 */
export async function guardToolCall(
  context: CommandContext,
  call: AntigravityCall,
  environment: GuardEnvironment,
): Promise<GuardDecision> {
  const flavor = environment.flavor ?? ANTIGRAVITY_FLAVOR;
  let policy: AntigravityPolicy | undefined;
  try {
    policy = (await context.files.exists(flavor.policyPath))
      ? parsePolicy(await context.files.readText(flavor.policyPath))
      : undefined;
  } catch {
    policy = undefined;
  }
  if (policy === undefined) return deny(flavor.unreadableReason);
  const decision = policyDecision(policy, call, environment.place, flavor);
  if (decision.decision === "deny") return decision;
  const kind = classify(call);
  if (kind.kind !== "shell") return decision;
  try {
    const cwd = typeof call.args.Cwd === "string" ? call.args.Cwd : undefined;
    const gated = await gate(context, policy, kind.command, cwd, environment.conversation, flavor);
    if (gated.decision === "deny") return gated;
    return decision.decision === "ask" ? decision : gated;
  } catch {
    return deny(flavor.uncheckedReason);
  }
}

/** What a read of external content is called in the journal: Claude Code's names, for one record. */
function readOf(call: AntigravityCall): { tool: string; source?: string } | undefined {
  const { name, args } = call;
  if (name === "read_url_content" || name === "open_browser_url") {
    return { tool: "WebFetch", ...(typeof args.Url === "string" ? { source: args.Url } : {}) };
  }
  if (name === "search_web") return { tool: "WebSearch" };
  if (name === "run_command" && typeof args.CommandLine === "string") {
    return isNetworkCommand(args.CommandLine)
      ? { tool: "Bash", source: args.CommandLine }
      : undefined;
  }
  if (name === "call_mcp_tool") {
    const server = typeof args.ServerName === "string" ? args.ServerName : "";
    const tool = typeof args.ToolName === "string" ? args.ToolName : "tool";
    if (server === "" || /^(?:agentplugged_)?agentplugged$/.test(server)) return undefined;
    return { tool: `mcp__${server}__${tool}` };
  }
  if (RESOURCE_TOOLS.has(name)) return { tool: `mcp__resource__${name}` };
  if (
    name === "browser_subagent" ||
    name === "read_browser_page" ||
    name === "execute_browser_javascript" ||
    name === "capture_browser_console_logs"
  ) {
    return { tool: name };
  }
  return undefined;
}

/**
 * Records the read a tool call made of external content: a trace in the journal,
 * nothing is blocked for it. Written once per tool and source (the journal tells whether it
 * is already there). Never throws: a read that could not be recorded is tried again by the next call.
 */
export async function recordToolRead(
  context: CommandContext,
  call: AntigravityCall,
  conversation: string | undefined,
): Promise<void> {
  const read = readOf(call);
  if (read === undefined) return;
  try {
    // No session object: the journal is the memory between two hooks, which are two processes.
    const { session: _none, ...bare } = context;
    await recordExternalReadCommand.run(
      { ...bare, actor: "agent" },
      {
        tool: read.tool,
        ...(read.source === undefined ? {} : { source: read.source }),
        session: conversation ?? "",
        agent: MAIN_SESSION_AGENT,
      },
    );
  } catch {
    // Best effort, like the Claude Code hook.
  }
}
