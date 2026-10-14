import { TOOL_CATALOG, type ToolId, type ToolSpec } from "./catalog.js";
import type { Editor, ToolProbe } from "./tool-probe.js";

/** What revealed a tool. */
export type ToolSource =
  | { readonly kind: "command"; readonly command: string }
  | { readonly kind: "extension"; readonly editor: Editor }
  | { readonly kind: "editor"; readonly command: string };

export interface DetectedTool {
  readonly id: ToolId;
  /** Product name to show; "Gemini CLI" when only the former command was found. */
  readonly name: string;
  readonly found: boolean;
  /** `x.y.z`, with its suffix if any; undefined when absent or not recognized. */
  readonly version: string | undefined;
  readonly versionRecognized: boolean;
  readonly sources: readonly ToolSource[];
  /** Found only as an extension or editor: the bridge will need the command-line tool. */
  readonly cliMissingForBridge: boolean;
  /** Files `sync` generates to drive this tool. */
  readonly driveFiles: readonly string[];
  /**
   * The folder its command was found in when that folder is not on `PATH`: the
   * engine uses the tool, an editor opened before the installation may not see it.
   */
  readonly offPath?: string;
}

const VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z][0-9A-Za-z.-]*)?/;

/** First `x.y.z` of a text, with its suffix (`-alpha.21`), or undefined. */
export function parseVersion(text: string | undefined): string | undefined {
  const match = text === undefined ? null : VERSION_PATTERN.exec(text);
  if (!match) return undefined;
  const suffix = (match[4] ?? "").replace(/[.-]+$/, "");
  return `${match[1]}.${match[2]}.${match[3]}${suffix}`;
}

/** Orders two versions returned by `parseVersion`; a release beats its pre-releases. */
export function compareVersions(a: string, b: string): number {
  const split = (version: string) => {
    const dash = version.indexOf("-");
    const core = dash === -1 ? version : version.slice(0, dash);
    return { parts: core.split(".").map(Number), suffix: dash === -1 ? "" : version.slice(dash) };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < 3; i++) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (left.suffix === right.suffix) return 0;
  if (left.suffix === "") return 1;
  if (right.suffix === "") return -1;
  return left.suffix.localeCompare(right.suffix, "en", { numeric: true });
}

/** Runs a probe step; a crash counts as "nothing found". */
async function safely<T>(step: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await step();
  } catch {
    return fallback;
  }
}

async function findCommand(
  probe: ToolProbe,
  names: readonly string[],
): Promise<{ name: string; output: string; path: string; onPath: boolean } | undefined> {
  if (names.length === 0) return undefined;
  const match = await safely(() => probe.which(names), undefined);
  if (!match) return undefined;
  const output = await safely(() => probe.version(match.path), undefined);
  // A command whose probe fails is treated as absent.
  return output === undefined
    ? undefined
    : { name: match.name, output, path: match.path, onPath: match.onPath !== false };
}

/** The folder of a path, with either separator. */
function dirnameOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut <= 0 ? path : path.slice(0, cut);
}

async function detectOne(probe: ToolProbe, spec: ToolSpec): Promise<DetectedTool> {
  const [command, extensions, editor] = await Promise.all([
    findCommand(probe, spec.commands),
    spec.extensionPrefix === undefined
      ? Promise.resolve([])
      : safely(() => probe.extensions(spec.extensionPrefix ?? ""), []),
    findCommand(probe, spec.editorCommand === undefined ? [] : [spec.editorCommand]),
  ]);

  const sources: ToolSource[] = [];
  const versions: (string | undefined)[] = [];
  if (command) {
    sources.push({ kind: "command", command: command.name });
    versions.push(parseVersion(command.output));
  }
  const editors = new Set(extensions.map((extension) => extension.editor));
  for (const name of ["vscode", "cursor"] as const) {
    if (editors.has(name)) sources.push({ kind: "extension", editor: name });
  }
  if (extensions.length > 0) {
    const readable = extensions
      .map((extension) => parseVersion(extension.version))
      .filter((version): version is string => version !== undefined)
      .sort(compareVersions);
    versions.push(readable.at(-1));
  }
  if (editor) {
    sources.push({ kind: "editor", command: editor.name });
    versions.push(parseVersion(editor.output));
  }

  const found = sources.length > 0;
  // The command's version wins, then the extension's, then the editor's. An unreadable command
  // output is reported as such, never covered by another source's version.
  const version = command ? versions[0] : versions.find((candidate) => candidate !== undefined);
  const name = (command && spec.commandNames?.[command.name]) ?? spec.name;
  return {
    id: spec.id,
    name,
    found,
    version,
    versionRecognized: version !== undefined,
    sources: sources,
    cliMissingForBridge: found && command === undefined,
    driveFiles: spec.driveFiles,
    ...(command !== undefined && !command.onPath ? { offPath: dirnameOf(command.path) } : {}),
  };
}

/**
 * Looks for every known AI tool, in parallel. Never fails: a probe that crashes, fails or
 * times out leaves the tool "not found". Nothing is persisted: `sync` detects again.
 */
export function detectTools(
  probe: ToolProbe,
  catalog: readonly ToolSpec[] = TOOL_CATALOG,
): Promise<DetectedTool[]> {
  return Promise.all(catalog.map((spec) => detectOne(probe, spec)));
}
