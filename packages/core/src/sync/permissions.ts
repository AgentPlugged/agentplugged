import {
  type ClaudeSettings,
  ClaudeSettingsSchema,
  type CursorCliConfig,
  type CursorCliConfigSchema,
  ErrorCode,
} from "@agentplugged/protocol";
import { ANTIGRAVITY_HOOK_NAME } from "../chat/antigravity-hook.js";
import { CODEX_HOOK_NAME } from "../chat/codex-hook.js";
import { CURSOR_HOOK_NAME } from "../chat/cursor-hook.js";
import { DECISION_HOOK_NAME } from "../chat/decision-hook.js";
import { CHAT_STORE_DIR, PROMPT_HOOK_NAME } from "../chat/prompt-hook.js";
import { AgentPluggedError } from "../errors.js";
import { normalizeText } from "../init/generated.js";

export const CLAUDE_SETTINGS_SCHEMA_URL = "https://json.schemastore.org/claude-code-settings.json";

/**
 * What `deny` keeps (the creator's calibration: what counts is the trace in the journal,
 * not a wall of refusals). Only the gestures that destroy or give away something stay refused: the
 * secrets (`.env` files, keys, the logins of the forges and of the AI tools), the files that carry
 * these very rules (the method's configuration and constitution, the AI tools' settings and hooks),
 * the proof of the trace (the journal's branch and local store, the chat's store, the transcripts),
 * a merge that bypasses the validation (`gh pr merge`), and the destruction of a remote repository.
 * The force push, the push to the main branch, the mass deletions and the secret reads are the
 * rules of `rule-permissions.ts`, which the creator can tighten with `rules set`.
 */

/** Paths of `.agentplugged/` agents may not modify: the files that carry the rules. */
const PROTECTED_METHOD_PATHS = ["method.yaml", "AGENTS.md", "REFERENCE.md", "reference/**"];

/** The journal's local store, relative to the project root. */
const PROTECTED_GIT_PATHS = [".git/agentplugged/**"];

/** Shell commands agents may not run: `[command, arguments pattern]`. */
const FORBIDDEN_COMMANDS: ReadonlyArray<readonly [string, string]> = [
  // The journal is the trace: its branch is written by the engine only.
  ["git", "push *agentplugged/journal*"],
  ["git", "checkout agentplugged/journal*"],
  ["git", "switch agentplugged/journal*"],
  ["git", "branch*agentplugged/journal*"],
  ["git", "update-ref*agentplugged/journal*"],
  ["rm", "*.git/agentplugged*"],
  ["Remove-Item", "*.git*agentplugged*"],
  // A merge goes through the engine, once the creator validated it.
  ["gh", "pr merge*"],
  ["glab", "mr merge*"],
  ["glab", "mr accept*"],
  ["gh", "api*merge*"],
  ["gh", "api*-X DELETE*"],
  ["gh", "api*--method DELETE*"],
  ["gh", "alias*"],
  ["glab", "alias*"],
  // The forges' tokens, and the destruction of a remote repository.
  ["gh", "auth*"],
  ["glab", "auth*"],
  ["gh", "config get*"],
  ["glab", "config get*"],
  ["gh", "repo delete*"],
  ["glab", "repo delete*"],
  // The branch the rules are read from: never moved by an agent, or it would loosen them.
  ["git", "update-ref*refs/remotes*"],
  ["git", "remote set-head*"],
  ["git", "symbolic-ref*refs/remotes*"],
  // The proof of the creator's messages: the hooks that record them are
  // never run by an agent, nor another session of an AI tool, whose prompt they would record as the
  // creator's.
  ["node", `*${PROMPT_HOOK_NAME}*`],
  ["node", `*${DECISION_HOOK_NAME}*`],
  ["node", `*${ANTIGRAVITY_HOOK_NAME}*`],
  ["node", `*${CODEX_HOOK_NAME}*`],
  ["node", `*${CURSOR_HOOK_NAME}*`],
  // Pairing a device and managing devices: the creator's own gesture, at their
  // terminal. An agent that ran them would link a browser of its choosing; best-effort like every
  // rule here (a shell can still reach the program another way), and the commands are in no
  // MCP tool.
  ["agentplugged", "pair*"],
  ["agentplugged", "device*"],
  ["agentplugged-bridge", "*"],
  ["npx", "*agentplugged*pair*"],
  ["npx", "*agentplugged*device*"],
  ["claude", "*"],
  ["npx", "*@anthropic-ai/claude-code*"],
  ["agy", "*"],
  ["antigravity", "*"],
  ["codex", "*"],
  ["npx", "*@openai/codex*"],
  ["cursor-agent", "*"],
  ["npx", "*@google/antigravity*"],
];

/**
 * Where the forges' command-line tools keep their login, when not in the system
 * keychain: Linux and the default (`~/.config`), Windows (`%APPDATA%`, `%LOCALAPPDATA%`) and macOS
 * (`~/Library/Application Support`). Agents never read them. A folder moved by `GH_CONFIG_DIR`,
 * `GLAB_CONFIG_DIR` or `XDG_CONFIG_HOME` is not covered: the rules cannot name a variable.
 */
const FORGE_LOGIN_PATHS = [
  "~/.config/gh/**",
  "~/.config/glab-cli/**",
  "~/AppData/Roaming/GitHub CLI/**",
  "~/AppData/Roaming/glab-cli/**",
  "~/AppData/Local/glab-cli/**",
  "~/Library/Application Support/glab-cli/**",
];

/** The logins of the AI tools (tokens, accounts): never read by an agent. */
const AI_TOOL_LOGIN_PATHS = [
  "~/.gemini/oauth_creds.json",
  "~/.gemini/google_accounts.json",
  "~/.claude/.credentials.json",
  "~/.codex/auth.json",
];

/**
 * The store of the creator's messages, the proof of the chat's answers: agents
 * never write it. Best-effort, like every rule: a shell can still reach the store another way; the
 * creator who wants more chooses the `strict` level.
 */
const CHAT_STORE_PATH = `~/${CHAT_STORE_DIR}/**`;

/**
 * What the engine's updates keep on the machine: the installed versions, the two
 * settings (the check of the registry, the automatic updates) and the registry's kept answer. Agents
 * never write them: what runs here and whether it updates without a yes is the creator's. Best-effort
 * like every rule: the engine alone installs a version, from the registry, after the creator's word.
 */
/**
 * What the pairing keeps on the machine: the root pinned for each product, and
 * the bridge's own folder (its link with the account, the pairing in progress, its state) on each
 * system (the logs of the bridge hold names and numbers only, never a secret). Agents neither read nor write them: an agent that rewrote the pin would choose who
 * is trusted, and one that read the pairing in progress would hold a secret of the link. Best-effort
 * like the others: only `agentplugged pair` writes them.
 */
const PAIRING_PATHS = [
  "~/.agentplugged/trust/**",
  "~/AppData/Local/AgentPlugged/bridge/**",
  "~/Library/Application Support/AgentPlugged/bridge/**",
  "~/.local/state/agentplugged/bridge/**",
] as const;

const ENGINE_UPDATE_PATHS = [
  "~/.agentplugged/engines/**",
  "~/.agentplugged/settings.json",
  "~/.agentplugged/update-check.json",
] as const;
export interface PermissionInputs {
  /** The root `AGENTS.md` is generated by agentplugged. */
  readonly rootAgentsGenerated: boolean;
  /** The root `CLAUDE.md` is generated by agentplugged. */
  readonly claudeMdGenerated: boolean;
  /** The root `GEMINI.md` is generated by agentplugged. */
  readonly geminiMdGenerated?: boolean;
  /** Folders of generated files (`.claude`, `.agents`, ...), protected as a whole. */
  readonly generatedRoots?: readonly string[];
  /** `.mcp.json` declares the `agentplugged` MCP server for Claude Code. */
  readonly mcpConfigGenerated?: boolean;
}

/**
 * A path rule before it is written in a tool's syntax: `project` paths are relative to the
 * project root; `glob` and `home` paths are written as is.
 */
interface PathRule {
  readonly kind: "project" | "glob" | "home";
  readonly path: string;
}

interface ProtectedPaths {
  readonly write: readonly PathRule[];
  readonly read: readonly PathRule[];
}

const project = (path: string): PathRule => ({ kind: "project", path });

/** The files that hold secrets: never read, never overwritten by an agent. */
const SECRET_FILES = ["**/.env", "**/.env.local", "**/.env.*.local", "**/.env.production*"];

/**
 * The secret files as `.gitignore` patterns (Cursor's `.cursorignore`): the same files,
 * matched at any depth without the leading `**\/`.
 */
export function secretIgnorePatterns(): string[] {
  return SECRET_FILES.map((path) => path.replace(/^\*\*\//, ""));
}

/** What agents may not write or read, whatever the tool. */
function protectedPaths({
  rootAgentsGenerated,
  claudeMdGenerated,
  geminiMdGenerated = false,
  generatedRoots = [".claude"],
  mcpConfigGenerated = false,
}: PermissionInputs): ProtectedPaths {
  const secrets = SECRET_FILES.map((path): PathRule => ({ kind: "glob", path }));
  const write: PathRule[] = PROTECTED_METHOD_PATHS.map((path) => project(`.agentplugged/${path}`));
  for (const root of generatedRoots) write.push(project(`${root}/**`));
  // Cursor's `.cursorignore` holds the block that keeps the secrets from its agent: an
  // agent that rewrote it would read them.
  if (generatedRoots.includes(".cursor")) write.push(project(".cursorignore"));
  if (rootAgentsGenerated) write.push(project("AGENTS.md"));
  if (claudeMdGenerated) write.push(project("CLAUDE.md"));
  if (geminiMdGenerated) write.push(project("GEMINI.md"));
  // An agent must not change the server it reports through.
  if (mcpConfigGenerated) write.push(project(".mcp.json"));
  write.push(
    ...secrets,
    { kind: "home", path: "~/.ssh/**" },
    { kind: "home", path: CHAT_STORE_PATH },
    ...ENGINE_UPDATE_PATHS.map((path): PathRule => ({ kind: "home", path })),
    ...PAIRING_PATHS.map((path): PathRule => ({ kind: "home", path })),
  );
  // A hook of the user's settings could answer the engine's forms in the creator's
  // place (`Elicitation`, `ElicitationResult`); the project's settings are generated already.
  write.push({ kind: "home", path: "~/.claude/settings.json" });
  // Antigravity's own settings (`~/.gemini/config`: a global hook, a disabled plugin, a
  // permission granted for good), the folders it reads hooks, plugins and instructions from (every
  // `.agents/` between the working folder and the project's root, and the home folder's own), and
  // the conversations' transcripts it writes, from which the creator's messages are proved.
  write.push(
    { kind: "home", path: "~/.gemini/config/**" },
    { kind: "home", path: "~/.gemini/settings.json" },
    { kind: "glob", path: "**/.agents/**" },
    { kind: "home", path: "~/.agents/**" },
    { kind: "glob", path: "**/.system_generated/**" },
  );
  for (const path of PROTECTED_GIT_PATHS) write.push(project(path));
  // Secrets: these, and only these, are kept as reads.
  const read: PathRule[] = [
    { kind: "home", path: "~/.ssh/**" },
    ...secrets,
    ...FORGE_LOGIN_PATHS.map((path): PathRule => ({ kind: "home", path })),
    ...AI_TOOL_LOGIN_PATHS.map((path): PathRule => ({ kind: "home", path })),
    ...PAIRING_PATHS.map((path): PathRule => ({ kind: "home", path })),
  ];
  return { write, read };
}

/**
 * The commands agents may never run, as `{ command, args }` patterns (the same list as the `Bash(…)`
 * and `Shell(…)` deny rules): Codex's rules of commands write those a prefix can say.
 */
export function forbiddenShellPatterns(): { command: string; args: string }[] {
  return FORBIDDEN_COMMANDS.map(([command, args]) => ({ command, args }));
}

/**
 * `deny` rules of the Claude Code permission profile. Paths starting with `/` are relative to the
 * project root (project settings). `Edit(...)` rules cover Claude Code's file-editing tools only:
 * a write made by a shell command (`Bash`) is not covered by path rules.
 */
export function denyRules(inputs: PermissionInputs): string[] {
  const { write, read } = protectedPaths(inputs);
  const path = (rule: PathRule) => (rule.kind === "project" ? `/${rule.path}` : rule.path);
  return [
    ...write.map((rule) => `Edit(${path(rule)})`),
    ...read.map((rule) => `Read(${path(rule)})`),
    ...FORBIDDEN_COMMANDS.map(([command, args]) => `Bash(${command} ${args})`),
  ];
}

/**
 * `deny` rules of `.cursor/cli.json`, the same as Claude Code's in Cursor CLI syntax: relative
 * paths are scoped to the workspace, `Shell(command:arguments)` matches a command and its
 * arguments.
 */
export function cursorDenyRules(inputs: PermissionInputs): string[] {
  const { write, read } = protectedPaths(inputs);
  return [
    ...write.map((rule) => `Write(${rule.path})`),
    ...read.map((rule) => `Read(${rule.path})`),
    ...FORBIDDEN_COMMANDS.map(([command, args]) => `Shell(${command}:${args})`),
  ];
}

function settingsInvalid(path: string, reason: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.SETTINGS_INVALID, "error.settings_invalid", {
    path,
    reason,
  });
}

/**
 * Parses a JSON settings file of the creator (`.claude/settings.json`, `.cursor/cli.json`);
 * `SETTINGS_INVALID` when it cannot be used.
 */
export function parseSettings(
  text: string,
  path: string,
  schema: typeof ClaudeSettingsSchema | typeof CursorCliConfigSchema = ClaudeSettingsSchema,
): ClaudeSettings | CursorCliConfig | AgentPluggedError {
  let data: unknown;
  try {
    data = JSON.parse(normalizeText(text));
  } catch (error) {
    return settingsInvalid(path, error instanceof Error ? error.message : String(error));
  }
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue && issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
  return settingsInvalid(path, `${field}: ${issue?.message ?? "invalid"}`);
}

/** How a settings file is created and what `sync` adds besides its rules. */
export interface SettingsFlavor {
  /** Keys of a file created by `sync`. */
  readonly base: Readonly<Record<string, unknown>>;
  /** Extra `permissions` keys set while the tool is targeted. */
  readonly extra: Readonly<Record<string, unknown>>;
  /**
   * Keys (`permissions.<name>`) an earlier run introduced and this one no longer wants: removed
   * while the tool stays targeted, but only when `sync` introduced them and their value is still
   * the one it wrote (the creator's own are never touched).
   */
  readonly released?: Readonly<Record<string, unknown>>;
}

export const CLAUDE_FLAVOR: SettingsFlavor = {
  base: { $schema: CLAUDE_SETTINGS_SCHEMA_URL },
  extra: { disableBypassPermissionsMode: "disable" },
};

/**
 * Claude Code's settings by permission mode. `protected`: the mode that removes the
 * tool's questions is turned off in the project. `free`: it is not (and the key an earlier run
 * wrote is released): the creator may use it in their tool; the engine never switches it on.
 */
export function claudeFlavor(mode: "protected" | "free" | undefined): SettingsFlavor {
  return mode === "free"
    ? { base: CLAUDE_FLAVOR.base, extra: {}, released: CLAUDE_FLAVOR.extra }
    : CLAUDE_FLAVOR;
}

export const CURSOR_FLAVOR: SettingsFlavor = { base: {}, extra: {} };

type Settings = ClaudeSettings | CursorCliConfig;

/** The permission lists `sync` writes: `deny` (always, while targeted), `allow` and `ask`. */
export const PERMISSION_LISTS = ["deny", "allow", "ask"] as const;
export type PermissionList = (typeof PERMISSION_LISTS)[number];
export type PermissionLists = Partial<Record<PermissionList, readonly string[]>>;

/** The tool is targeted while `sync` produces `deny` rules for it. */
function targeted(rules: PermissionLists): boolean {
  return (rules.deny?.length ?? 0) > 0;
}

/**
 * Our rules merged into the settings: in each list, rules added, rules we added before and no
 * longer produce removed; and the flavor's extra keys set (only while the tool is targeted).
 * `allow` and `ask` appear only when they hold a rule, or already existed. Every other key and
 * rule is kept, in its order.
 */
export function mergeSettings<T extends Settings>(
  current: T | undefined,
  rules: PermissionLists,
  previouslyOurs: PermissionLists,
  flavor: SettingsFlavor = CLAUDE_FLAVOR,
): T {
  const result: Record<string, unknown> =
    current === undefined
      ? { ...flavor.base }
      : (JSON.parse(JSON.stringify(current)) as Record<string, unknown>);
  const permissions: Record<string, unknown> = {
    ...((result.permissions as Record<string, unknown> | undefined) ?? {}),
  };
  for (const list of PERMISSION_LISTS) {
    const ours = rules[list] ?? [];
    const produced = new Set(ours);
    const dropped = new Set((previouslyOurs[list] ?? []).filter((rule) => !produced.has(rule)));
    const existing = permissions[list] as string[] | undefined;
    // A key another tool's schema gives another meaning (Cursor has no `ask` list) is kept as is.
    if (existing !== undefined && !Array.isArray(existing)) continue;
    const merged = (existing ?? []).filter((rule) => !dropped.has(rule));
    for (const rule of ours) if (!merged.includes(rule)) merged.push(rule);
    if (list === "deny" || existing !== undefined || merged.length > 0) permissions[list] = merged;
  }
  if (targeted(rules)) Object.assign(permissions, flavor.extra);
  result.permissions = permissions;
  return result as T;
}

/** What `sync` put in a settings file, kept in the manifest. */
export interface SettingsRecord {
  /** `sync` created the file. */
  readonly created: boolean;
  /** Keys `sync` introduced: `$schema`, `permissions`, `permissions.deny`, ... */
  readonly keys: readonly string[];
}

/** Keys `sync` may introduce in a settings file, deepest last. */
function trackedKeys(flavor: SettingsFlavor): string[] {
  return [
    ...Object.keys(flavor.base),
    "permissions",
    ...PERMISSION_LISTS.map((list) => `permissions.${list}`),
    ...Object.keys(flavor.extra).map((key) => `permissions.${key}`),
  ];
}

function hasKey(settings: Settings | undefined, key: string): boolean {
  let node: unknown = settings;
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object" || !Object.hasOwn(node, part)) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return true;
}

export interface SettingsOutcome<T> {
  /** The settings to write; undefined when the file must be deleted. */
  readonly settings: T | undefined;
  /** What to keep in the manifest; undefined once the tool left the list. */
  readonly record: SettingsRecord | undefined;
}

const LIST_KEYS = new Set(PERMISSION_LISTS.map((list) => `permissions.${list}`));

/**
 * The settings after this run. While the tool is targeted (`deny` rules produced), our rules are
 * merged and the keys `sync` introduces are recorded. Once it leaves the list, our rules are
 * removed, then the keys `sync` introduced (a list and `permissions` only when left empty), and a
 * file `sync` created is deleted when nothing remains in it.
 */
export function reconcileSettings<T extends Settings>(
  current: T | undefined,
  rules: PermissionLists,
  previouslyOurs: PermissionLists,
  flavor: SettingsFlavor,
  previous: SettingsRecord | undefined,
): SettingsOutcome<T> {
  const merged = mergeSettings(current, rules, previouslyOurs, flavor);
  if (targeted(rules)) {
    // A key an earlier run introduced and this flavor releases goes, if it is still as it wrote it.
    const released: string[] = [];
    const permissions = (merged as Record<string, unknown>).permissions as
      | Record<string, unknown>
      | undefined;
    for (const [name, value] of Object.entries(flavor.released ?? {})) {
      const key = `permissions.${name}`;
      if (
        permissions !== undefined &&
        previous?.keys.includes(key) &&
        permissions[name] === value
      ) {
        delete permissions[name];
        released.push(key);
      }
    }
    const introduced = trackedKeys(flavor).filter(
      (key) => hasKey(merged, key) && !hasKey(current, key),
    );
    const keys = [
      ...new Set([
        ...(previous?.keys ?? []).filter((key) => !released.includes(key)),
        ...introduced,
      ]),
    ];
    return {
      settings: merged,
      record: { created: previous?.created ?? current === undefined, keys },
    };
  }
  if (previous === undefined) {
    // Rules removed; without a record of what sync added, nothing else is touched.
    const permissions = (merged as Record<string, unknown>).permissions as Record<string, unknown>;
    for (const list of PERMISSION_LISTS) {
      if (!hasKey(current, `permissions.${list}`)) delete permissions[list];
    }
    if (!hasKey(current, "permissions") && Object.keys(permissions).length === 0) {
      delete (merged as Record<string, unknown>).permissions;
    }
    return { settings: merged, record: undefined };
  }
  const result = merged as Record<string, unknown>;
  const permissions = (result.permissions ?? {}) as Record<string, unknown>;
  for (const key of [...trackedKeys(flavor)].reverse()) {
    if (!previous.keys.includes(key)) continue;
    if (LIST_KEYS.has(key)) {
      const list = key.slice("permissions.".length);
      const value = permissions[list];
      if (Array.isArray(value) && value.length === 0) delete permissions[list];
    } else if (key === "permissions") {
      if (Object.keys(permissions).length === 0) delete result.permissions;
    } else if (key.startsWith("permissions.")) {
      delete permissions[key.slice("permissions.".length)];
    } else {
      delete result[key];
    }
  }
  const empty = Object.keys(result).length === 0;
  return { settings: previous.created && empty ? undefined : (result as T), record: undefined };
}

/**
 * Rules sync can call its own after the merge, list by list: those it produces, except a rule the
 * creator already had in that list before sync ever added it (sync must never remove it later).
 */
export function ownedRules(
  current: Settings | undefined,
  rules: PermissionLists,
  previouslyOurs: PermissionLists,
): Record<PermissionList, string[]> {
  const owned = { deny: [] as string[], allow: [] as string[], ask: [] as string[] };
  const permissions = current?.permissions as Record<string, unknown> | undefined;
  for (const list of PERMISSION_LISTS) {
    const value = permissions?.[list];
    const existing = new Set(Array.isArray(value) ? (value as string[]) : []);
    const ours = new Set(previouslyOurs[list] ?? []);
    owned[list] = (rules[list] ?? []).filter((rule) => !existing.has(rule) || ours.has(rule));
  }
  return owned;
}

/** Text written for the settings, following the existing file's line endings. */
export function renderSettings(settings: Settings, previousText?: string): string {
  const text = `${JSON.stringify(settings, null, 2)}\n`;
  return previousText?.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text;
}
