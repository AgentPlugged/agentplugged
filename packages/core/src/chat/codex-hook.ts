import { CHAT_RETENTION_MS } from "@agentplugged/protocol";
import { ANTIGRAVITY_UNCHECKED_REASON } from "./antigravity-hook.js";
import {
  chatStoreHelpers,
  GENERATED_HEADER_SLASH,
  inputRepairHelpers,
  SESSION_CONTEXT_PREFIX,
} from "./prompt-hook.js";

/**
 * The Codex hooks of the project, in one generated script without dependency. Codex
 * reads project hooks from `.codex/config.toml` (`[[hooks.<Event>]]`), runs each as a `command`
 * with the hook's JSON on its standard input, and reads a JSON answer on its standard output. A
 * hook of a project runs only once the creator has reviewed and approved it (`/hooks`, once: Codex
 * records the approval against the hash of the hook's definition), and only in a project Codex
 * trusts.
 *
 * - `user-prompt` (`UserPromptSubmit`): the proof of the chat (same store and same rule
 *   as Claude Code's hook). Codex gives `session_id` and `prompt`: the script records
 *   what the creator typed in `~/.agentplugged/chat/` and tells the agent the session id to pass to
 *   `chat.answer`. It never blocks a message: any failure is ignored. A session that is not
 *   the creator's (one `codex exec` started, a sub-agent's thread) is never recorded.
 * - `pre-tool` (`PreToolUse`, on `Bash` and `apply_patch`): the permission rules of the product,
 *   asked of the engine (`agentplugged hook codex pre-tool`), which applies the lists written in
 *   Claude Code's settings. Codex hooks answer `allow` or `deny` only: the script denies, and lets
 *   the rest through (an `ask` rule is Codex's `prompt` rule, in `.codex/rules/`). It fails closed:
 *   a call the engine could not check is denied, except when Codex gives no usable input at all.
 * - `post-tool` (`PostToolUse`): records a read of external content (a network command, a tool of
 *   another MCP server): a trace in the journal, nothing is blocked.
 *
 * Agents may not run the script, write `.codex/` (Codex's sandbox protects it and `sync` denies it
 * too), write the chat's store, nor start Codex themselves.
 *
 * The hooks are declared in `.codex/config.toml`, one file the creator may own: it is then kept, and
 * `sync` writes the script and the policy no more (only the rules of commands).
 */

export const CODEX_HOOK_NAME = "agentplugged-codex";
export const CODEX_HOOK_PATH = `.codex/hooks/${CODEX_HOOK_NAME}.mjs`;
/** The rules and the engine's launch `sync` computed: read by the script and by the engine's hook. */
export const CODEX_POLICY_FILE = "agentplugged-policy.json";
export const CODEX_POLICY_PATH = `.codex/hooks/${CODEX_POLICY_FILE}`;
/** The rules of commands (`prefix_rule`) Codex applies itself, hooks or not. */
export const CODEX_RULES_PATH = ".codex/rules/agentplugged.rules";

/** How long Codex waits for one of our hooks, in seconds. */
export const CODEX_HOOK_TIMEOUT = 30;
export const CODEX_PROMPT_HOOK_TIMEOUT = 10;

/** What the agent is told: the engine could not check the tool call, so it is denied. */
export const CODEX_UNCHECKED_REASON = ANTIGRAVITY_UNCHECKED_REASON;

/** The tools the hooks look at: Codex names the shell `Bash` and its patch tool `apply_patch`. */
export const CODEX_PRE_MATCHER = "^(Bash|apply_patch)$";
export const CODEX_POST_MATCHER = "^(Bash|mcp__.*)$";

/**
 * The hooks declared in `.codex/config.toml`, in the order they are written: this order is part of
 * Codex's approval key (`<config>:<event label>:<group>:<handler>`), so a new hook goes last.
 * `label` is the event as Codex names it in that key and in the hash of a hook.
 */
export const CODEX_HOOK_DEFINITIONS: readonly {
  readonly event: "UserPromptSubmit" | "PreToolUse" | "PostToolUse";
  readonly label: "user_prompt_submit" | "pre_tool_use" | "post_tool_use";
  readonly script: "user-prompt" | "pre-tool" | "post-tool";
  readonly timeout: number;
  readonly matcher?: string;
}[] = [
  {
    event: "UserPromptSubmit",
    label: "user_prompt_submit",
    script: "user-prompt",
    timeout: CODEX_PROMPT_HOOK_TIMEOUT,
  },
  {
    event: "PreToolUse",
    label: "pre_tool_use",
    script: "pre-tool",
    timeout: CODEX_HOOK_TIMEOUT,
    matcher: CODEX_PRE_MATCHER,
  },
  {
    event: "PostToolUse",
    label: "post_tool_use",
    script: "post-tool",
    timeout: CODEX_HOOK_TIMEOUT,
    matcher: CODEX_POST_MATCHER,
  },
];

/**
 * The frame Codex's editor extension puts around a message when it adds the editor's context: the
 * context, then the request under a fixed heading. Only a text that opens with the context heading
 * and holds the request heading is cut at it; anything else is the prompt as given.
 */
const IDE_CONTEXT_OPEN = "# Context from my IDE setup:";
const IDE_REQUEST_HEADINGS = ["\n## My request for Codex:\n", "\n## My request:\n"] as const;

/**
 * The message the creator typed, out of a prompt that may carry the editor's context frame. The
 * request is what follows the LAST heading: the context before it may hold text an agent wrote in
 * a file (a forged heading there never starts the message).
 */
export function codexRequestText(prompt: string): string {
  if (!prompt.startsWith(IDE_CONTEXT_OPEN)) return prompt;
  let at = -1;
  let length = 0;
  for (const heading of IDE_REQUEST_HEADINGS) {
    const found = prompt.lastIndexOf(heading);
    if (found > at) {
      at = found;
      length = heading.length;
    }
  }
  return at === -1 ? prompt : prompt.slice(at + length);
}

/** The hook definitions of `.codex/config.toml`: one `command` per event, the same on every machine. */
export function codexHookCommands(): {
  readonly command: (event: string) => string;
  readonly commandWindows: (event: string) => string;
} {
  return {
    // Codex may be started from a sub-folder: the script is looked up from the repository's top.
    command: (event) => `node "$(git rev-parse --show-toplevel)/${CODEX_HOOK_PATH}" ${event}`,
    // Windows runs it from the session's folder (the project's top for the editor extension).
    commandWindows: (event) => `node "${CODEX_HOOK_PATH}" ${event}`,
  };
}

/** The script. It is the same for every product: the engine's launch is read from the policy file. */
export function renderCodexHookScript(): string {
  return String.raw`${GENERATED_HEADER_SLASH}
// Codex hooks of the agentplugged project: the proof of the chat (the messages the creator typed,
// recorded in ~/.agentplugged/chat/, kept ${CHAT_RETENTION_MS / 3_600_000} hours), the product's permission rules before a tool
// runs (asked of the engine) and the reads of external content after one. Never blocks a message:
// any failure of the proof is ignored; a tool the engine cannot check is denied. Agents never run
// it nor write its store.
${chatStoreHelpers()}${inputRepairHelpers()}import { spawnSync } from "node:child_process";
import { closeSync, openSync, readSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const POLICY = join(ROOT, ".codex", "hooks", ${JSON.stringify(CODEX_POLICY_FILE)});
const OURS = /^mcp__agentplugged__/;
// A prefilter: the engine decides what a network command is, this only spares it a start.
const NETWORK = /\b(?:curl|wget|gh|iwr|irm|invoke-webrequest|invoke-restmethod)\b|\bgit\b[^;&|\n]*\b(?:pull|fetch|clone)\b/i;
const UNCHECKED = ${JSON.stringify(CODEX_UNCHECKED_REASON)};
const IDE_CONTEXT_OPEN = ${JSON.stringify(IDE_CONTEXT_OPEN)};
const IDE_REQUEST_HEADINGS = ${JSON.stringify(IDE_REQUEST_HEADINGS)};

function answer(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
  process.exit(0);
}

function deny(reason) {
  answer({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
}

// The engine, started from the project's folder with the launch \x60sync\x60 wrote in the policy file.
function engine(event, stdin) {
  let launch;
  try {
    launch = JSON.parse(readFileSync(POLICY, "utf8")).launch;
  } catch {
    return undefined;
  }
  if (launch === null || typeof launch !== "object" || typeof launch.command !== "string" || !Array.isArray(launch.args)) return undefined;
  const run = spawnSync(launch.command, [...launch.args, "hook", "codex", event], {
    cwd: ROOT,
    input: stdin,
    encoding: "utf8",
    timeout: ${(CODEX_HOOK_TIMEOUT - 5) * 1000},
    windowsHide: true,
    maxBuffer: 1 << 20,
  });
  if (run.error || run.status !== 0) return undefined;
  try {
    const value = JSON.parse(run.stdout);
    return value !== null && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

function preTool(stdin) {
  // Any failure here denies: Codex lets a call through when a hook fails, so nothing may escape.
  try {
    const input = JSON.parse(stdin);
    const name = input !== null && typeof input === "object" && typeof input.tool_name === "string" ? input.tool_name : "";
    if (name === "") deny(UNCHECKED);
    if (OURS.test(name)) process.exit(0);
    const result = engine("pre-tool", stdin);
    if (result === undefined || (result.decision !== "allow" && result.decision !== "ask" && result.decision !== "deny")) deny(UNCHECKED);
    if (result.decision === "deny") deny(typeof result.reason === "string" ? result.reason : UNCHECKED);
  } catch {
    deny(UNCHECKED);
  }
  // Codex's hooks know no \x60ask\x60: the rule that asks is a \x60prompt\x60 rule of .codex/rules/.
  process.exit(0);
}

function postTool(stdin) {
  try {
    const input = JSON.parse(stdin);
    const name = typeof input.tool_name === "string" ? input.tool_name : "";
    const command = input.tool_input !== null && typeof input.tool_input === "object" ? String(input.tool_input.command ?? "") : "";
    if (OURS.test(name)) process.exit(0);
    if (name === "Bash" && !NETWORK.test(command)) process.exit(0);
    // The matcher gives only these two kinds; the check keeps the script right if it is widened.
    if (name === "Bash" || name.startsWith("mcp__")) engine("post-tool", stdin);
  } catch {}
  process.exit(0);
}

// The message the creator typed, out of a prompt that may carry the editor's context frame.
function requestText(prompt) {
  if (!prompt.startsWith(IDE_CONTEXT_OPEN)) return prompt;
  let at = -1;
  let length = 0;
  for (const heading of IDE_REQUEST_HEADINGS) {
    const found = prompt.lastIndexOf(heading);
    if (found > at) {
      at = found;
      length = heading.length;
    }
  }
  return at === -1 ? prompt : prompt.slice(at + length);
}

// A thread Codex opened for something else than the creator: a \x60codex exec\x60 run, a session an MCP
// client started, a sub-agent's thread. The rollout's first line names where the session comes from.
function creators(transcript) {
  try {
    if (typeof transcript !== "string" || !transcript.endsWith(".jsonl")) return true;
    // The first line only (it may be long: it holds the session's instructions), up to 4 MB.
    const fd = openSync(transcript, "r");
    let head = "";
    try {
      const chunk = Buffer.alloc(65536);
      while (head.length < 4194304 && !head.includes("\n")) {
        const read = readSync(fd, chunk, 0, chunk.length, null);
        if (read === 0) break;
        head += chunk.toString("utf8", 0, read);
      }
    } finally {
      closeSync(fd);
    }
    const meta = JSON.parse(head.split("\n")[0])?.payload;
    // Observed on Codex 0.160.1: the editor extension's session says source "vscode"; a \x60codex exec\x60 run
    // says "exec"; a sub-agent's thread has a source object ({ subagent: { thread_spawn: ... } }) and
    // thread_source "subagent".
    if (meta?.thread_source === "subagent") return false;
    const source = meta?.source;
    if (typeof source === "string") return !/^(?:exec|mcp)$/i.test(source.trim());
    return source === undefined || source === null;
  } catch {
    return true;
  }
}

function userPrompt(stdin) {
  let session = "";
  try {
    const input = JSON.parse(stdin);
    const id = typeof input.session_id === "string" ? input.session_id.trim() : "";
    if (/^[\x21-\x7e]{1,200}$/.test(id)) session = id;
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    const typed = creatorText(seen(requestText(prompt)));
    const text = typed === undefined ? "" : normalize(typed);
    if (session !== "" && text !== "" && creators(input.transcript_path)) {
      const dir = storeDir();
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const now = Date.now();
      const file = join(dir, sha256(session).slice(0, 32) + ".jsonl");
      prune(dir, file, now);
      const line = { v: 1, via: "codex", session, project: ROOT, at: new Date(now).toISOString(), digest: sha256(text), text: text.slice(0, MAX_TEXT) };
      appendFileSync(file, JSON.stringify(line) + "\n", { mode: 0o600 });
    }
  } catch {}
  if (session === "") process.exit(0);
  const context = "${SESSION_CONTEXT_PREFIX}" + session + " (pass it as session to chat.answer)";
  answer({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } });
}

const event = process.argv[2] ?? "";
let stdin = "";
try {
  stdin = readInput();
} catch {}
if (event === "pre-tool") preTool(stdin);
else if (event === "post-tool") postTool(stdin);
else if (event === "user-prompt") userPrompt(stdin);
else process.exit(0);
`;
}

/** A Codex session id as the hook stores it, or undefined (the script keeps the same shape). */
export function codexSessionIdOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  return /^[\x21-\x7e]{1,200}$/.test(id) ? id : undefined;
}
