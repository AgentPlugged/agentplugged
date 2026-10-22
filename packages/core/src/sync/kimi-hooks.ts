/**
 * The hooks of Kimi Code CLI. Kimi declares them only as `[[hooks]]` in the user's own
 * `config.toml` (`~/.kimi-code/config.toml`, or `$KIMI_CODE_HOME/config.toml`); its documentation
 * names no project-level file. `sync` never writes outside the project, so these functions only
 * work on the text of that file: an explicit command (`kimi-hooks`) reads and writes it, and
 * touches nothing but the block between the two markers below.
 *
 * Pure text functions: no file is read or written here.
 */

/** The marker lines around the block of ours; everything between them is ours, the rest is the creator's. */
export const KIMI_HOOKS_BEGIN =
  "# agentplugged:begin hooks (managed by `agentplugged kimi-hooks`, do not edit; `kimi-hooks remove` takes them away)";
export const KIMI_HOOKS_END = "# agentplugged:end hooks";

/** What the user's file holds of ours: all current, the block of another engine version, or nothing. */
export type KimiHooksState = "installed" | "outdated" | "missing";

/** Seconds a hook may take before Kimi lets the call through. */
export const KIMI_HOOK_TIMEOUT = 30;

/**
 * The command Kimi runs before each tool call: the engine's hook for Kimi (`engine` is the words
 * that run the engine, with its version pinned, `npx -y agentplugged@<version>`).
 */
export function kimiHookCommand(engine: string, entry?: string): string {
  const npx = `${engine} hook kimi pre-tool`;
  // The engine that installs the hook, started directly: the `npx` words take over when its file
  // is gone (a program that does not exist ends without reading the hook's input, which the
  // second command then receives whole). A path with a quote cannot be written safely: `npx` only.
  return entry === undefined || entry === "" || /["\r\n]/.test(entry)
    ? npx
    : `node "${entry}" hook kimi pre-tool || ${npx}`;
}

/** The block of ours: one rule, `PreToolUse` on every tool. */
export function kimiHooksBlock(engine: string, entry?: string): string {
  const command = JSON.stringify(kimiHookCommand(engine, entry));
  return [
    KIMI_HOOKS_BEGIN,
    "[[hooks]]",
    'event = "PreToolUse"',
    `command = ${command}`,
    `timeout = ${KIMI_HOOK_TIMEOUT}`,
    KIMI_HOOKS_END,
  ].join("\n");
}

interface Located {
  readonly start: number;
  readonly end: number;
}

/** Where our block sits in the text (markers included), `null` when absent, `"broken"` when unbalanced. */
function locate(text: string): Located | null | "broken" {
  const start = text.indexOf(KIMI_HOOKS_BEGIN);
  const stop = text.indexOf(KIMI_HOOKS_END);
  if (start === -1 && stop === -1) return null;
  if (start === -1 || stop === -1 || stop < start) return "broken";
  if (text.indexOf(KIMI_HOOKS_BEGIN, start + 1) !== -1) return "broken";
  if (text.indexOf(KIMI_HOOKS_END, stop + 1) !== -1) return "broken";
  return { start, end: stop + KIMI_HOOKS_END.length };
}

/**
 * What the file holds of ours, for the engine `engine` runs: `installed` only when the block is
 * there and runs this very command; a block of another version is `outdated`.
 */
export function kimiHooksState(
  text: string | undefined,
  engine: string,
  entryExists: (path: string) => boolean = () => false,
): KimiHooksState {
  if (text === undefined) return "missing";
  const found = locate(text.replaceAll("\r\n", "\n"));
  if (found === null || found === "broken") return "missing";
  const block = text.replaceAll("\r\n", "\n").slice(found.start, found.end);
  if (block === kimiHooksBlock(engine)) return "installed";
  // The direct form is current while the file it names is still there.
  const path = directEntryOf(block);
  return path !== undefined && block === kimiHooksBlock(engine, path) && entryExists(path)
    ? "installed"
    : "outdated";
}

/** The path a block's command starts the engine from directly, when it does. */
function directEntryOf(block: string): string | undefined {
  const line = /^command = (".*")$/m.exec(block)?.[1];
  if (line === undefined) return undefined;
  try {
    const command: unknown = JSON.parse(line);
    return typeof command === "string"
      ? /^node "([^"]+)" hook kimi pre-tool \|\| /.exec(command)?.[1]
      : undefined;
  } catch {
    return undefined;
  }
}

/** Why the file cannot be changed safely. */
export type KimiHooksRefusal = "unbalanced_markers" | "inline_hooks";

/** A `hooks = …` key at the top level: the array of tables we append cannot coexist with it. */
const INLINE_HOOKS = /^\s*hooks\s*=/m;

export type KimiHooksEdit =
  | { readonly kind: "changed"; readonly text: string }
  | { readonly kind: "unchanged" }
  | { readonly kind: "refused"; readonly reason: KimiHooksRefusal };

/**
 * The file with our block installed (added after everything else, or replaced in place when an
 * older one is there). The creator's own text is kept byte for byte, line breaks included.
 */
export function withKimiHooks(
  text: string | undefined,
  engine: string,
  entry?: string,
): KimiHooksEdit {
  const block = kimiHooksBlock(engine, entry);
  if (text === undefined || text.trim() === "") return { kind: "changed", text: `${block}\n` };
  const crlf = text.includes("\r\n");
  const lf = text.replaceAll("\r\n", "\n");
  const found = locate(lf);
  if (found === "broken") return { kind: "refused", reason: "unbalanced_markers" };
  let next: string;
  if (found === null) {
    if (INLINE_HOOKS.test(lf)) return { kind: "refused", reason: "inline_hooks" };
    next = `${lf}${lf.endsWith("\n") ? "" : "\n"}\n${block}\n`;
  } else {
    if (lf.slice(found.start, found.end) === block) return { kind: "unchanged" };
    next = `${lf.slice(0, found.start)}${block}${lf.slice(found.end)}`;
  }
  return { kind: "changed", text: crlf ? next.replaceAll("\n", "\r\n") : next };
}

/**
 * The file without our block (and the blank line we put before it). `text: ""` means nothing else
 * was there. Anything else in the file stays as it is.
 */
export function withoutKimiHooks(text: string): KimiHooksEdit {
  const crlf = text.includes("\r\n");
  const lf = text.replaceAll("\r\n", "\n");
  const found = locate(lf);
  if (found === "broken") return { kind: "refused", reason: "unbalanced_markers" };
  if (found === null) return { kind: "unchanged" };
  let before = lf.slice(0, found.start);
  let after = lf.slice(found.end);
  if (after.startsWith("\n")) after = after.slice(1);
  // The blank line `withKimiHooks` added before the block goes with it.
  if (before.endsWith("\n\n")) before = before.slice(0, -1);
  const next = `${before}${after}`;
  const rest = next.trim() === "" ? "" : next;
  return { kind: "changed", text: crlf ? rest.replaceAll("\n", "\r\n") : rest };
}
