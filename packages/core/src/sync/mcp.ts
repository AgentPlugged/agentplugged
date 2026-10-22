import { canonicalBytes, fromUtf8 } from "@agentplugged/crypto";
import { ErrorCode, type McpLaunch, type ToolId } from "@agentplugged/protocol";
import { AgentPluggedError } from "../errors.js";
import { normalizeText } from "../init/generated.js";
import { isRecord } from "../values.js";
import type { ClientId } from "./compatibility.js";
import type { SettingsRecord } from "./permissions.js";
import type { TargetGroup } from "./targets/common.js";

/** Name of the AgentPlugged MCP server in every tool's configuration. */
export const MCP_SERVER_NAME = "agentplugged";

/** Claude Code's project MCP servers (`mcpServers`), at the root of the project. */
export const CLAUDE_MCP_PATH = ".mcp.json";
/**
 * The file `sync` wrote for Antigravity CLI. Antigravity reads MCP servers from a
 * global file or from a plugin only, so this one was ignored: `sync` no longer writes it, and removes
 * the entry it added (`legacy`). The server is declared in the plugin (`targets/antigravity-plugin.ts`).
 */
export const ANTIGRAVITY_MCP_PATH = ".agents/mcp_config.json";
/**
 * The retired Gemini CLI's project settings. `sync` no longer writes it; an older installation may
 * still hold the entry an earlier `sync` added, which only the cleanup removes.
 */
export const GEMINI_SETTINGS_PATH = ".gemini/settings.json";
/** Cursor's project MCP servers (`mcpServers`), read by the editor and the Cursor CLI. */
export const CURSOR_MCP_PATH = ".cursor/mcp.json";

/**
 * Kimi Code CLI's project MCP servers (`mcpServers`, a stdio server being an entry with `command`),
 * read beside the user's own `~/.kimi-code/mcp.json`; the project entry wins on a name clash.
 */
export const KIMI_MCP_PATH = ".kimi-code/mcp.json";

/** A JSON file that declares MCP servers under `mcpServers`, and the tool that reads it. */
export interface McpJsonFile {
  readonly path: string;
  readonly client: ClientId;
  /** The `tools` entry of `method.yaml` that generates it. */
  readonly tool: ToolId;
  readonly group: TargetGroup;
  /** The tool's documentation gives a `type: "stdio"` field. */
  readonly typed: boolean;
  /**
   * The file holds the tool's other settings too: `sync` merges into it when it exists, never
   * creates it. Comments (JSONC) are accepted when it is read.
   */
  readonly existingOnly: boolean;
  /** `sync` no longer writes the entry: it only removes the one it recorded in an earlier run. */
  readonly legacy?: boolean;
}

/** The JSON MCP configurations of the targeted tools (Codex's is its generated TOML file). */
export const MCP_JSON_FILES: readonly McpJsonFile[] = [
  {
    path: CLAUDE_MCP_PATH,
    client: "claude-code",
    tool: "claude-code",
    group: "claude-code",
    typed: true,
    existingOnly: false,
  },
  {
    path: ANTIGRAVITY_MCP_PATH,
    client: "antigravity",
    tool: "antigravity",
    group: "antigravity",
    typed: false,
    existingOnly: false,
    legacy: true,
  },
  {
    path: CURSOR_MCP_PATH,
    client: "cursor",
    tool: "cursor",
    group: "cursor",
    typed: true,
    existingOnly: false,
  },
  {
    path: KIMI_MCP_PATH,
    client: "kimi",
    tool: "kimi",
    group: "kimi",
    // Kimi tells a stdio server by its `command`; no `type` field is documented.
    typed: false,
    existingOnly: false,
  },
];

/**
 * The retired Gemini CLI's settings file as the cleanup reads it: never part of the files `sync`
 * writes, and merged into only when it exists.
 */
export const LEGACY_GEMINI_SETTINGS: McpJsonFile = {
  path: GEMINI_SETTINGS_PATH,
  client: "antigravity",
  tool: "antigravity",
  group: "antigravity",
  typed: false,
  existingOnly: true,
  legacy: true,
};

/** How the AI tools start the server: a command and its arguments. */
export interface McpServerLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * The launch every tool's configuration declares: the creator's `mcp` of `method.yaml` when set
 * (for example a local build), else `npx -y agentplugged@<engine_version> mcp`, wrapped in
 * `cmd /c` when `sync` runs on Windows, where AI tools cannot start `npx` (`npx.cmd`) directly.
 */
export function mcpLaunch(
  engineVersion: string,
  options: { readonly platform?: string; readonly override?: McpLaunch } = {},
): McpServerLaunch {
  if (options.override !== undefined) {
    return { command: options.override.command, args: [...(options.override.args ?? [])] };
  }
  const npx = ["-y", `${MCP_SERVER_NAME}@${engineVersion}`, "mcp"];
  return options.platform === "win32"
    ? { command: "cmd", args: ["/c", "npx", ...npx] }
    : { command: "npx", args: npx };
}

const PLAIN_TOKEN = /^[\w@./:=+,-]+$/;

/**
 * One word of a command line, double-quoted when it holds a space, a backslash (a Windows path:
 * Git Bash would eat it unquoted) or another special character.
 */
function commandWord(word: string): string {
  return PLAIN_TOKEN.test(word) ? word : `"${word.replace(/"/g, '\\"')}"`;
}

/**
 * The command that runs the engine from a shell on this machine: the launch the
 * tools' MCP configuration declares (`mcpLaunch`), without its `cmd /c` wrapper nor its trailing
 * `mcp`: `npx -y agentplugged@<version>`, or the creator's local launch (`node <path>/bin.js`).
 * `sync` writes it wherever the method says `npx agentplugged`, so the agents never guess a
 * launcher that does not work here (an unpublished package fails through `npx`).
 */
export function engineCommand(launch: McpServerLaunch): string {
  return engineWords(launch).map(commandWord).join(" ");
}

/** The words of `engineCommand`, unquoted: the launcher and its arguments. */
export function engineWords(launch: McpServerLaunch): string[] {
  let words = [launch.command, ...launch.args];
  if (words[0]?.toLowerCase() === "cmd" && words[1]?.toLowerCase() === "/c") words = words.slice(2);
  if (words.length > 1 && words[words.length - 1] === "mcp") words = words.slice(0, -1);
  return words;
}

const ENGINE_MENTION = /npx agentplugged(?![\w@-])/g;

/**
 * `text` with each `npx agentplugged` replaced by `engine` (`engineCommand`): the same words
 * with the launcher that works on this machine. A text without that phrase, and a text already
 * holding the engine command, are returned as they are.
 */
export function withEngineCommand(text: string, engine: string): string {
  return text.replace(ENGINE_MENTION, () => engine);
}

/** The server's entry under `mcpServers` for one tool. */
export function mcpServerEntry(
  file: McpJsonFile,
  launch: McpServerLaunch,
): Record<string, unknown> {
  return {
    ...(file.typed ? { type: "stdio" } : {}),
    command: launch.command,
    args: [...launch.args],
  };
}

const NPX_SHAPE = (args: readonly unknown[]) =>
  args.length === 3 &&
  args[0] === "-y" &&
  typeof args[1] === "string" &&
  args[1].startsWith(`${MCP_SERVER_NAME}@`) &&
  args[2] === "mcp";

/**
 * True for an entry of the shape `sync` writes by default, whatever the version it pins:
 * `npx -y agentplugged@<x> mcp`, or `cmd /c npx -y agentplugged@<x> mcp` (Windows). A JSON file
 * has no header: this shape, with the manifest, is how a generated entry is recognised.
 */
export function isGeneratedMcpEntry(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { command, args, ...rest } = value as Record<string, unknown>;
  const others = Object.keys(rest);
  if (others.some((key) => key !== "type") || (others.length > 0 && rest.type !== "stdio")) {
    return false;
  }
  if (!Array.isArray(args)) return false;
  if (command === "npx") return NPX_SHAPE(args);
  return command === "cmd" && args[0] === "/c" && args[1] === "npx" && NPX_SHAPE(args.slice(2));
}

type Json = Record<string, unknown>;

/** JSONC: `//` and `/* *\/` comments removed outside strings, and trailing commas. */
export function stripJsonComments(text: string): string {
  let output = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    const next = text[i + 1];
    if (inString) {
      output += char;
      if (char === "\\") {
        output += next ?? "";
        i++;
      } else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
    } else if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      output += "\n";
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    } else output += char;
  }
  return output.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * The creator's MCP file, parsed: an object whose `mcpServers`, when present, is an object.
 * `jsonc`: comments accepted (they are not written back).
 */
export function parseMcpFile(text: string, path: string, jsonc = false): Json | AgentPluggedError {
  const invalid = (reason: string) =>
    new AgentPluggedError(ErrorCode.SETTINGS_INVALID, "error.settings_invalid", { path, reason });
  let data: unknown;
  try {
    const normalized = normalizeText(text);
    data = JSON.parse(jsonc ? stripJsonComments(normalized) : normalized);
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }
  if (!isRecord(data)) return invalid("(root): expected an object");
  if (data.mcpServers !== undefined && !isRecord(data.mcpServers)) {
    return invalid("mcpServers: expected an object");
  }
  return data;
}

/** What becomes of one MCP file. */
export interface McpFileOutcome {
  /** The content to write; undefined: delete the file; `same`: nothing to write. */
  readonly next: Json | undefined | "same";
  /** What to keep in the manifest; undefined when `sync` no longer owns anything there. */
  readonly record: SettingsRecord | undefined;
  /** The file holds another `agentplugged` server, the creator's: left as is. */
  readonly conflict: boolean;
  /** Extension servers (by name) whose entry is the creator's: left as is. */
  readonly extraConflicts?: readonly string[];
}

/** Equal JSON values, whatever the order of their keys. */
const sameJson = (a: unknown, b: unknown) =>
  fromUtf8(canonicalBytes(a ?? null)) === fromUtf8(canonicalBytes(b ?? null));

const ENTRY_KEY = `mcpServers.${MCP_SERVER_NAME}`;

/**
 * The server declared in one MCP file, under the rules of the settings files
 * While the tool is targeted, the entry `mcpServers.agentplugged` is created or brought to
 * the launch declared now; an entry is ours when the manifest says `sync` added it, when it has
 * the default shape (`isGeneratedMcpEntry`) or when it is the launch declared now; any other is
 * the creator's: a conflict, left as is. Only the keys `sync` actually added are recorded (a file
 * created now owns both). Once the tool leaves the list, an entry `sync` added is removed (and
 * `mcpServers` when `sync` added it and it is left empty), and a file `sync` created is deleted
 * when nothing remains; without a record, nothing is touched.
 */
function reconcileMainEntry(
  file: McpJsonFile,
  current: Json | undefined,
  targeted: boolean,
  launch: McpServerLaunch,
  previous: SettingsRecord | undefined,
): McpFileOutcome {
  const servers = isRecord(current?.mcpServers) ? current.mcpServers : undefined;
  const existing = servers === undefined ? undefined : servers[MCP_SERVER_NAME];
  const hasEntry = servers !== undefined && Object.hasOwn(servers, MCP_SERVER_NAME);
  const entry = mcpServerEntry(file, launch);
  if (targeted) {
    if (current === undefined && file.existingOnly) {
      return { next: "same", record: undefined, conflict: false };
    }
    const recorded = previous?.keys.includes(ENTRY_KEY) === true;
    if (hasEntry && !recorded && !isGeneratedMcpEntry(existing) && !sameJson(existing, entry)) {
      return { next: "same", record: undefined, conflict: true };
    }
    let record: SettingsRecord;
    if (current === undefined) record = { created: true, keys: ["mcpServers", ENTRY_KEY] };
    else {
      const introduced = [
        ...(current.mcpServers === undefined ? ["mcpServers"] : []),
        ...(hasEntry ? [] : [ENTRY_KEY]),
      ];
      const keys = [...new Set([...(previous?.keys ?? []), ...introduced])];
      record = { created: previous?.created ?? false, keys };
    }
    if (hasEntry && sameJson(existing, entry)) return { next: "same", record, conflict: false };
    const base: Json = current === undefined ? {} : (JSON.parse(JSON.stringify(current)) as Json);
    base.mcpServers = {
      ...(isRecord(base.mcpServers) ? base.mcpServers : {}),
      [MCP_SERVER_NAME]: entry,
    };
    return { next: base, record, conflict: false };
  }
  if (current === undefined || previous === undefined) {
    return { next: "same", record: undefined, conflict: false };
  }
  if (!hasEntry || !previous.keys.includes(ENTRY_KEY)) {
    return { next: "same", record: undefined, conflict: false };
  }
  const result = JSON.parse(JSON.stringify(current)) as Json;
  const remaining = { ...(result.mcpServers as Json) };
  delete remaining[MCP_SERVER_NAME];
  if (Object.keys(remaining).length === 0 && previous.keys.includes("mcpServers")) {
    delete result.mcpServers;
  } else result.mcpServers = remaining;
  const empty = Object.keys(result).length === 0;
  return {
    next: previous.created && empty ? undefined : result,
    record: undefined,
    conflict: false,
  };
}

/**
 * An MCP server that a program built on the engine asks `sync` to declare next to `agentplugged`
 * in the tools' MCP files. The engine does not know what it serves: it writes the entry, records
 * it, brings it to the launch given now and removes it when it is no longer given.
 */
export interface ExtensionMcpServer {
  readonly name: string;
  readonly launch: McpServerLaunch;
}

/** The name of an extension server: lowercase letters, digits, `_` and `-`, not `agentplugged`. */
export const EXTENSION_SERVER_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

/** The servers of a request that can be declared: a valid name, never the engine's own. */
export function usableExtensionServers(
  extras: readonly ExtensionMcpServer[],
): readonly ExtensionMcpServer[] {
  return extras.filter(
    (extra) => extra.name !== MCP_SERVER_NAME && EXTENSION_SERVER_NAME.test(extra.name),
  );
}

const SERVERS_PREFIX = "mcpServers.";
/**
 * Beside each recorded extension entry, the manifest keeps what `sync` wrote there
 * (`mcpEntry.<name>=<canonical JSON>`), so that an entry the creator replaced since is told from
 * the one `sync` wrote: the first is never rewritten nor removed.
 */
const WRITTEN_PREFIX = "mcpEntry.";

const writtenKey = (name: string, entry: unknown): string =>
  `${WRITTEN_PREFIX}${name}=${fromUtf8(canonicalBytes(entry))}`;

const isWrittenKeyOf = (key: string, name: string): boolean =>
  key.startsWith(`${WRITTEN_PREFIX}${name}=`);

/** What `sync` wrote for `name`, from the record; undefined for a record that predates it. */
function writtenEntry(keys: readonly string[], name: string): unknown {
  const key = keys.find((item) => isWrittenKeyOf(item, name));
  if (key === undefined) return undefined;
  try {
    return JSON.parse(key.slice(`${WRITTEN_PREFIX}${name}=`.length)) as unknown;
  } catch {
    return undefined;
  }
}

/** True while the entry in the file is still the one `sync` wrote (or cannot be told apart). */
function stillOurs(keys: readonly string[], name: string, found: unknown): boolean {
  const written = writtenEntry(keys, name);
  return written === undefined || sameJson(written, found);
}

/**
 * Takes out of the result what dropping extension entries left empty: an `mcpServers` that `sync`
 * introduced, and a file that `sync` created.
 */
function tidyServers(
  next: Json | undefined | "same",
  current: Json | undefined,
  previous: SettingsRecord | undefined,
): Json | undefined | "same" {
  const target = next === "same" ? current : next;
  if (target === undefined || !isRecord(target.mcpServers)) return next;
  if (Object.keys(target.mcpServers).length > 0) return next;
  if (previous?.keys.includes("mcpServers") !== true) return next;
  const { mcpServers: _gone, ...rest } = target;
  if (Object.keys(rest).length === 0 && previous.created) return undefined;
  return rest;
}

/**
 * `reconcileMainEntry` for the `agentplugged` server, then the same rules for each extension
 * server: while the tool is targeted, an entry is created or brought to the launch given now; an
 * entry is ours when the manifest recorded it or when it is exactly the launch given now, any
 * other is the creator's (`extraConflicts`, left as is). An entry `sync` recorded and that is no
 * longer given is removed, and all of them are once the tool leaves the list. Without extension
 * servers (given or recorded) it is exactly `reconcileMainEntry`.
 */
export function reconcileMcpFile(
  file: McpJsonFile,
  current: Json | undefined,
  targeted: boolean,
  launch: McpServerLaunch,
  previous: SettingsRecord | undefined,
  extras: readonly ExtensionMcpServer[] = [],
): McpFileOutcome {
  const recordedExtras = (previous?.keys ?? [])
    .filter((key) => key.startsWith(SERVERS_PREFIX) && key !== ENTRY_KEY)
    .map((key) => key.slice(SERVERS_PREFIX.length));
  const wanted = targeted ? usableExtensionServers(extras) : [];
  if (wanted.length === 0 && recordedExtras.length === 0) {
    return reconcileMainEntry(file, current, targeted, launch, previous);
  }
  // 1. Recorded entries that are no longer given go away first, unless the creator replaced them
  // since: such an entry is theirs now, left as it is, and forgotten by the manifest.
  const kept = new Set(wanted.map((extra) => extra.name));
  const dropped = recordedExtras.filter((name) => !kept.has(name));
  const previousKeys = previous?.keys ?? [];
  const removable = dropped.filter((name) => {
    if (current === undefined || !isRecord(current.mcpServers)) return false;
    if (!Object.hasOwn(current.mcpServers, name)) return false;
    return stillOurs(previousKeys, name, current.mcpServers[name]);
  });
  let base = current;
  if (removable.length > 0 && current !== undefined && isRecord(current.mcpServers)) {
    const servers = { ...current.mcpServers };
    for (const name of removable) delete servers[name];
    base = { ...current, mcpServers: servers };
  }
  const trimmed =
    previous === undefined
      ? undefined
      : {
          ...previous,
          keys: previous.keys.filter(
            (key) => !dropped.some((n) => key === SERVERS_PREFIX + n || isWrittenKeyOf(key, n)),
          ),
        };
  // 2. The `agentplugged` entry, as ever.
  const main = reconcileMainEntry(file, base, targeted, launch, trimmed);
  let working: Json | undefined = main.next === "same" ? base : main.next;
  let record = main.record;
  // A file that must not be created (and does not exist) gets nothing.
  if (wanted.length === 0 || (base === undefined && file.existingOnly)) {
    return {
      next: tidyServers(working === current ? main.next : working, current, previous),
      record,
      conflict: main.conflict,
    };
  }
  // 3. The extension entries given now.
  const servers: Json = isRecord(working?.mcpServers) ? { ...working.mcpServers } : {};
  const introduced: string[] = [];
  const extraConflicts: string[] = [];
  const forgotten: string[] = [];
  const rewritten: string[] = [];
  let changed = false;
  for (const extra of wanted) {
    const key = SERVERS_PREFIX + extra.name;
    const entry = mcpServerEntry(file, extra.launch);
    const exists = Object.hasOwn(servers, extra.name);
    const recorded = trimmed?.keys.includes(key) === true;
    if (exists && sameJson(servers[extra.name], entry)) {
      if (recorded) {
        introduced.push(key, writtenKey(extra.name, entry));
        rewritten.push(extra.name);
      }
      continue;
    }
    // An entry the creator replaced since `sync` wrote it is theirs: left as it is, forgotten.
    if (exists && (!recorded || !stillOurs(trimmed?.keys ?? [], extra.name, servers[extra.name]))) {
      extraConflicts.push(extra.name);
      forgotten.push(extra.name);
      continue;
    }
    servers[extra.name] = entry;
    introduced.push(key, writtenKey(extra.name, entry));
    rewritten.push(extra.name);
    changed = true;
  }
  if (changed) working = { ...(working ?? {}), mcpServers: servers };
  if (introduced.length > 0 || forgotten.length > 0) {
    const stale = (key: string): boolean =>
      forgotten.some((n) => key === SERVERS_PREFIX + n || isWrittenKeyOf(key, n)) ||
      rewritten.some((n) => isWrittenKeyOf(key, n));
    const keys = [
      ...new Set([...(record?.keys ?? []).filter((key) => !stale(key)), ...introduced]),
    ];
    record =
      keys.length === 0
        ? undefined
        : { created: record?.created ?? trimmed?.created ?? current === undefined, keys };
  }
  const next = changed || working !== current ? working : main.next;
  return {
    next: next === current ? "same" : next,
    record,
    conflict: main.conflict,
    ...(extraConflicts.length > 0 ? { extraConflicts } : {}),
  };
}

/** Text written for an MCP file, following the existing file's line endings. */
export function renderMcpFile(content: Json, previousText?: string): string {
  const text = `${JSON.stringify(content, null, 2)}\n`;
  return previousText?.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text;
}
