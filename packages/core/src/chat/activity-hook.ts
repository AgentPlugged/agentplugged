import { REDACTED_SECRET } from "@agentplugged/protocol";
import { GENERATED_HEADER_SLASH } from "./prompt-hook.js";

/**
 * The Claude Code hook that tells a watching program what a session opened in the creator's own
 * terminal does: the files it reads and changes, the commands it runs and how they ended. It is a
 * `command` hook (never `mcp_tool`: an agent could call an MCP tool itself) on the file tools and
 * the shell tools. It only ever appends one line to a small file of the machine
 * (`~/.agentplugged/activity/`, readable by the user alone), then exits: no network port, no
 * answer to the tool, no decision. It never blocks, slows or breaks a session: every failure is
 * ignored, the exit code is always 0, and the file of a session stops growing past a fixed size
 * (a watching program that is not there leaves the lines unread, then they are deleted).
 *
 * It records nothing for a session that has no terminal (`claude -p`, the SDK): that is a session
 * a program started itself, and it already reads that session's own output, so nothing is counted
 * twice. A line holds no result of a command, no content of a file and no text of the conversation;
 * a line of text that looks like a secret is replaced as a whole before it is written.
 */

/** Where `sync` writes the script, relative to the project. */
export const ACTIVITY_HOOK_PATH = ".claude/hooks/agentplugged-activity.mjs";

/** The name agents may never run (`sync` denies `node …agentplugged-activity…`). */
export const ACTIVITY_HOOK_NAME = "agentplugged-activity";

/** The command Claude Code runs, from the project's folder whatever the session's. */
export const ACTIVITY_HOOK_COMMAND = `node "$CLAUDE_PROJECT_DIR/${ACTIVITY_HOOK_PATH}"`;

/** How long Claude Code waits for the hook, in seconds: the script itself takes a few milliseconds. */
export const ACTIVITY_HOOK_TIMEOUT = 3;

/** The folder of the lines, under the home folder. */
export const ACTIVITY_SPOOL_DIR = ".agentplugged/activity";

/** A session's file stops growing at this size, in bytes. */
export const ACTIVITY_FILE_MAX_BYTES = 262_144;

/** A file older than this is deleted when a new session starts, in milliseconds. */
export const ACTIVITY_RETENTION_MS = 3_600_000;

/** The longest text of a line (a command, a path). */
export const ACTIVITY_TEXT_MAX = 2000;

/** The tools the hook is called for before they run: files read or changed, shell commands. */
export const ACTIVITY_START_MATCHER = "Read|Edit|MultiEdit|Write|NotebookEdit|Bash|PowerShell";

/** The tools whose end the hook is told: the shell tools. */
export const ACTIVITY_END_MATCHER = "Bash|PowerShell";

/**
 * The shapes of text that look like a secret, as source of regular expressions. The same list as
 * the bridge's exit guard (a test of the bridge fails when the two differ).
 */
export const ACTIVITY_SECRET_SHAPES: readonly string[] = [
  String.raw`-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----`,
  String.raw`\bghp_[A-Za-z0-9]{30,}`,
  String.raw`\bgithub_pat_[A-Za-z0-9_]{22,}`,
  String.raw`\bglpat-[A-Za-z0-9_-]{20,}`,
  String.raw`\bsk-ant-[A-Za-z0-9_-]{20,}`,
  String.raw`\bnpm_[A-Za-z0-9]{30,}`,
  String.raw`\bAKIA[0-9A-Z]{16}\b`,
];

/** The script, the same for every product. */
export function renderActivityHookScript(): string {
  return String.raw`${GENERATED_HEADER_SLASH}
// Claude Code PreToolUse / PostToolUse / PostToolUseFailure hook (agentplugged): appends one line
// per file read, file change or shell command of a session opened in the terminal to
// ~/.agentplugged/activity/, so that a program on this machine can show the session. Never blocks,
// never answers, never fails: any error is ignored and the exit code is always 0.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_FILE = ${ACTIVITY_FILE_MAX_BYTES};
const RETENTION_MS = ${ACTIVITY_RETENTION_MS};
const MAX_TEXT = ${ACTIVITY_TEXT_MAX};
const REDACTED = ${JSON.stringify(REDACTED_SECRET)};
const SHAPES = ${JSON.stringify(ACTIVITY_SECRET_SHAPES)}.map((source) => new RegExp(source));
const KEY_BEGIN = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;
const KEY_END = /-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;
const FILE_TOOLS = { Read: "read", Edit: "edit", MultiEdit: "edit", Write: "edit", NotebookEdit: "edit" };

// A session started without a terminal (claude -p, the SDK) is read by the program that started it.
const automatic = () => (process.env.CLAUDE_CODE_ENTRYPOINT ?? "").toLowerCase().startsWith("sdk");

// Every line that looks like a secret is replaced as a whole, a private key block from its first
// line to its last; the text is cut only afterwards, so a secret is never cut in two.
function safe(text) {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    if (KEY_BEGIN.test(lines[index])) {
      let last = index;
      for (let next = index; next < Math.min(lines.length, index + 200); next++) {
        last = next;
        if (KEY_END.test(lines[next])) break;
      }
      for (let at = index; at <= last; at++) lines[at] = REDACTED;
      index = last;
    } else if (SHAPES.some((shape) => shape.test(lines[index]))) {
      lines[index] = REDACTED;
    }
  }
  return lines.join("\n").slice(0, MAX_TEXT);
}

function prune(dir, now) {
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      const file = join(dir, name);
      if (now - statSync(file).mtimeMs > RETENTION_MS) unlinkSync(file);
    } catch {}
  }
}

try {
  if (!automatic()) {
    const input = JSON.parse(readFileSync(0, "utf8"));
    const session = typeof input.session_id === "string" ? input.session_id.trim() : "";
    const id = typeof input.tool_use_id === "string" ? input.tool_use_id.trim() : "";
    const project = (process.env.CLAUDE_PROJECT_DIR ?? "").trim() || (typeof input.cwd === "string" ? input.cwd : "");
    const tool = typeof input.tool_name === "string" ? input.tool_name : "";
    const event = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
    const data = typeof input.tool_input === "object" && input.tool_input !== null ? input.tool_input : {};
    let line;
    if (event === "PreToolUse") {
      if (tool in FILE_TOOLS) {
        const target = tool === "NotebookEdit" ? data.notebook_path : data.file_path;
        if (typeof target === "string" && target !== "") line = { kind: FILE_TOOLS[tool], target: safe(target) };
      } else if ((tool === "Bash" || tool === "PowerShell") && typeof data.command === "string" && data.command !== "") {
        line = { kind: "command", target: safe(data.command) };
      }
    } else if (event === "PostToolUse" || event === "PostToolUseFailure") {
      if (tool === "Bash" || tool === "PowerShell") line = { kind: "result", ok: event === "PostToolUse" };
    }
    if (line !== undefined && /^[\x21-\x7e]{1,200}$/.test(session) && /^[\x21-\x7e]{1,200}$/.test(id) && project !== "") {
      const dir = join(homedir(), ${JSON.stringify(ACTIVITY_SPOOL_DIR.split("/")[0])}, ${JSON.stringify(ACTIVITY_SPOOL_DIR.split("/")[1])});
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, createHash("sha256").update(session, "utf8").digest("hex").slice(0, 32) + ".jsonl");
      if (!existsSync(file)) prune(dir, Date.now());
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {}
      if (size < MAX_FILE) {
        const text = JSON.stringify({ v: 1, at: new Date().toISOString(), project: project.slice(0, 1024), session, id, ...line });
        appendFileSync(file, text + "\n", { mode: 0o600 });
      }
    }
  }
} catch {}
process.exit(0);
`;
}

/** The hook handler `sync` writes in `.claude/settings.json`. */
export function activityHookHandler(): Record<string, unknown> {
  return { type: "command", command: ACTIVITY_HOOK_COMMAND, timeout: ACTIVITY_HOOK_TIMEOUT };
}

/** True for our hook handler: a `command` hook that runs our script. */
export function isActivityHook(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const handler = value as Record<string, unknown>;
  return (
    handler.type === "command" &&
    typeof handler.command === "string" &&
    handler.command.includes(`${ACTIVITY_HOOK_NAME}.mjs`)
  );
}

/** The events the hook is registered on. */
const ACTIVITY_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure"] as const;

/**
 * True when the text of a project's `.claude/settings.json` registers the hook on its three events
 * and does not switch all hooks off. Anything unreadable: not registered.
 */
export function settingsHaveActivityHook(settingsText: string): boolean {
  try {
    const settings = JSON.parse(settingsText) as Record<string, unknown>;
    if (settings.disableAllHooks === true) return false;
    const hooks = settings.hooks as Record<string, unknown> | undefined;
    return ACTIVITY_EVENTS.every((event) => {
      const groups = hooks?.[event];
      return (
        Array.isArray(groups) &&
        groups.some((group) => {
          const hooksOfGroup = (group as { hooks?: unknown } | null)?.hooks;
          return Array.isArray(hooksOfGroup) && hooksOfGroup.some(isActivityHook);
        })
      );
    });
  } catch {
    return false;
  }
}
