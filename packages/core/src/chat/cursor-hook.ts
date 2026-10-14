import { CHAT_RETENTION_MS } from "@agentplugged/protocol";
import { ANTIGRAVITY_UNCHECKED_REASON } from "./antigravity-hook.js";
import {
  chatStoreHelpers,
  GENERATED_HEADER_SLASH,
  inputRepairHelpers,
  SESSION_CONTEXT_PREFIX,
} from "./prompt-hook.js";

/**
 * The Cursor hooks of the project, in one generated script without dependency. Cursor
 * reads the project's hooks from `.cursor/hooks.json` (only in a workspace the creator marked as
 * trusted, no other approval), runs each as a `command` from the project's root with the hook's JSON
 * on its standard input, and reads a JSON answer on its standard output. Every hook input carries
 * `session_id` (the conversation's id, `conversation_id` of the editor) and `hook_event_name`. What
 * follows was read in Cursor 3.23.12's own code and in its documentation (2026-10-07); the spec of
 * the story holds the sources.
 *
 * - `session-start` (`sessionStart`, which Cursor does not wait for) and `before-submit`
 *   (`beforeSubmitPrompt`): the proof of the chat (same store and same rule as Claude
 *   Code's hook). `before-submit` records what the creator typed in
 *   `~/.agentplugged/chat/`; both tell the agent the session id to pass to `chat.answer`
 *   (`additional_context`). A message is never blocked: any failure is ignored.
 * - `pre-tool` (`preToolUse`, on the file-writing tools `Write` and `Delete`, which Cursor's other
 *   editing tools reach too, on `WebFetch` and `WebSearch`, and, on `chat` (`answer`, `stack_answer`)
 *   ): the product's path and web rules, asked of the engine (`agentplugged hook
 *   cursor pre-tool`), and the session id written into the arguments of the answer tools
 *   (`updated_input`), so that an agent cannot give another one. Cursor ignores an `ask` here (only
 *   `deny` acts): a rule that asks before a write or a web access is not asked.
 * - `shell` (`beforeShellExecution`): the product's rules for a shell command, `ask` or `deny`
 *   (Cursor acts on both), and the gate of the installations.
 * - `post-tool` (`postToolUse` on `WebFetch` and `WebSearch`, `afterShellExecution`,
 *   `afterMCPExecution`): records a read of external content in the journal; nothing is blocked.
 *
 * Agents may not run the script, write `.cursor/` hooks (the generated roots are protected), write
 * the chat's store, nor start Cursor's agent (`cursor-agent`) themselves.
 *
 * The hooks are declared in `.cursor/hooks.json`, one file the creator may own: it is then kept, and
 * `sync` writes the script and the policy no more.
 */

export const CURSOR_HOOK_NAME = "agentplugged-cursor";
export const CURSOR_HOOK_PATH = `.cursor/hooks/${CURSOR_HOOK_NAME}.mjs`;
/** The hooks Cursor reads from the project. */
export const CURSOR_HOOKS_PATH = ".cursor/hooks.json";
/** The rules and the engine's launch `sync` computed: read by the script and by the engine's hook. */
const CURSOR_POLICY_FILE = "agentplugged-policy.json";
export const CURSOR_POLICY_PATH = `.cursor/hooks/${CURSOR_POLICY_FILE}`;

/** How long Cursor waits for one of our hooks, in seconds (its own default is 60). */
const HOOK_TIMEOUT = 30;
const PROMPT_HOOK_TIMEOUT = 10;

/** What the agent is told: the engine could not check the tool call, so it is denied. */
export const CURSOR_UNCHECKED_REASON = ANTIGRAVITY_UNCHECKED_REASON;

/** What the agent is told when the policy file is gone: the creator's `sync` writes it again. */
export const CURSOR_UNREADABLE_REASON = `AgentPlugged: the permission rules of this product are not readable (\`${CURSOR_POLICY_PATH}\`): the creator runs \`npx agentplugged sync\`.`;

/**
 * The tools the `preToolUse` hook looks at: `Write` and `Delete` (Cursor's editing tools, patches and
 * notebooks included, run through its `Write` tool), `WebFetch` and `WebSearch` (the `internet` rule
 * can deny them) and the engine's `chat` tool, whose actions `answer` and `stack_answer` take a
 * session id (the tools are grouped). Shell commands have their own hook, reads go
 * through `.cursorignore`.
 */
const PRE_MATCHER = "^(?:Write|Delete|WebFetch|WebSearch|MCP:chat)$";
const POST_MATCHER = "^(?:WebFetch|WebSearch)$";

/** The tools of the engine that take the conversation's session id (`MCP:<tool>`). */
const SESSION_TOOLS = ["chat"] as const;

/**
 * The actions of those tools that take no session id: every other action, an unknown one and an
 * input the hook cannot read included, gets the conversation's own session written in (fail closed).
 */
const NO_SESSION_ACTIONS = ["ask", "stack_open", "stack_ask"] as const;

/**
 * The frame Cursor puts around the creator's text in its transcripts (`<timestamp>…</timestamp>` then
 * `<user_query>…</user_query>`). The hook's `prompt` is the bare text; the frame is cut if it shows,
 * so that a message the creator typed is the same in both.
 */
const USER_QUERY =
  /^\s*(?:<timestamp>[^<]*<\/timestamp>\s*)?<user_query>\s*([\s\S]*?)\s*<\/user_query>\s*$/;

/** The message the creator typed, out of a prompt that may carry Cursor's transcript frame. */
export function cursorRequestText(prompt: string): string {
  const found = USER_QUERY.exec(prompt);
  return found === null ? prompt : (found[1] as string);
}

/** The hook definitions of `.cursor/hooks.json`: the same on every machine and every engine version. */
export function cursorHookCommand(event: string): string {
  // The project's hooks run from the project's root: the script is found from there.
  return `node ${CURSOR_HOOK_PATH} ${event}`;
}

/** The content of `.cursor/hooks.json` (the format of version 1). */
export function renderCursorHooks(): string {
  const hook = (event: string, timeout: number, extra: Record<string, unknown> = {}) => ({
    command: cursorHookCommand(event),
    timeout,
    ...extra,
  });
  const hooks = {
    version: 1,
    hooks: {
      sessionStart: [hook("session-start", PROMPT_HOOK_TIMEOUT)],
      beforeSubmitPrompt: [hook("before-submit", PROMPT_HOOK_TIMEOUT)],
      // A hook that crashes lets the action through unless it fails closed: the rules must hold.
      beforeShellExecution: [hook("shell", HOOK_TIMEOUT, { failClosed: true })],
      preToolUse: [hook("pre-tool", HOOK_TIMEOUT, { matcher: PRE_MATCHER, failClosed: true })],
      postToolUse: [hook("post-tool", HOOK_TIMEOUT, { matcher: POST_MATCHER })],
      afterShellExecution: [hook("post-tool", HOOK_TIMEOUT)],
      afterMCPExecution: [hook("post-tool", HOOK_TIMEOUT)],
    },
  };
  return `${JSON.stringify(hooks, null, 2)}\n`;
}

/** The script. It is the same for every product: the engine's launch is read from the policy file. */
export function renderCursorHookScript(): string {
  return String.raw`${GENERATED_HEADER_SLASH}
// Cursor hooks of the agentplugged project: the proof of the chat (the messages the creator typed,
// recorded in ~/.agentplugged/chat/, kept ${CHAT_RETENTION_MS / 3_600_000} hours), the product's permission rules before a
// command or a file write (asked of the engine) and the reads of external content after one. Never
// blocks a message: any failure of the proof is ignored; a call the engine cannot check is denied.
// Agents never run it nor write its store.
${chatStoreHelpers()}${inputRepairHelpers()}import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const POLICY = join(ROOT, ".cursor", "hooks", ${JSON.stringify(CURSOR_POLICY_FILE)});
const OURS = /^(?:agentplugged_)?agentplugged$/;
const SESSION_TOOLS = ${JSON.stringify(SESSION_TOOLS.map((name) => `MCP:${name}`))};
const NO_SESSION_ACTIONS = ${JSON.stringify(NO_SESSION_ACTIONS)};
// The action a call of the grouped tool names, or "" when the input cannot be read.
function actionOf(input) {
  let given = input.tool_input;
  if (typeof given === "string") {
    try {
      given = JSON.parse(given);
    } catch {
      return "";
    }
  }
  return given !== null && typeof given === "object" && typeof given.action === "string" ? given.action : "";
}
// A prefilter: the engine decides what a network command is, this only spares it a start.
const NETWORK = /\b(?:curl|wget|gh|iwr|irm|invoke-webrequest|invoke-restmethod)\b|\bgit\b[^;&|\n]*\b(?:pull|fetch|clone)\b/i;
const UNCHECKED = ${JSON.stringify(CURSOR_UNCHECKED_REASON)};
const UNREADABLE = ${JSON.stringify(CURSOR_UNREADABLE_REASON)};
const USER_QUERY = ${USER_QUERY.toString()};

// Only ASCII goes back to Cursor: PowerShell reads our output in the console's code page.
function ascii(json) {
  let out = "";
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    out += code < 0x80 ? json[i] : "\\u" + code.toString(16).padStart(4, "0");
  }
  return out;
}

function answer(value) {
  process.stdout.write(ascii(JSON.stringify(value)) + "\n");
  process.exit(0);
}

function refuse(permission, reason) {
  answer({ permission, user_message: reason, agent_message: reason });
}

function sessionOf(input) {
  const id = input !== null && typeof input === "object" && typeof input.session_id === "string" ? input.session_id.trim() : "";
  return /^[\x21-\x7e]{1,200}$/.test(id) ? id : "";
}

// What the agent is told when a call is denied for want of a check: the policy is gone or unusable
// (the creator's sync writes it again), or the engine did not answer.
let why = UNCHECKED;

// The engine, started from the project's folder with the launch \x60sync\x60 wrote in the policy file.
function engine(event, stdin) {
  let launch;
  try {
    launch = JSON.parse(readFileSync(POLICY, "utf8")).launch;
  } catch {
    why = UNREADABLE;
    return undefined;
  }
  if (launch === null || typeof launch !== "object" || typeof launch.command !== "string" || !Array.isArray(launch.args)) {
    why = UNREADABLE;
    return undefined;
  }
  const run = spawnSync(launch.command, [...launch.args, "hook", "cursor", event], {
    cwd: ROOT,
    input: stdin,
    encoding: "utf8",
    timeout: ${(HOOK_TIMEOUT - 5) * 1000},
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

// The decision of the engine for a call: nothing (the call goes its way) or a refusal Cursor shows.
// Cursor acts on an \x60ask\x60 of a shell command only (its preToolUse ignores it): where it cannot ask, a
// rule that asks lets the call through, and the constitution has the agent ask the creator in the chat.
// Any failure here denies: with a hook that crashes Cursor lets the call through, so nothing may escape.
function decide(stdin, canAsk) {
  try {
    const result = engine("pre-tool", stdin);
    if (result === undefined || (result.decision !== "allow" && result.decision !== "ask" && result.decision !== "deny")) refuse("deny", why);
    const reason = typeof result.reason === "string" ? result.reason : UNCHECKED;
    if (result.decision === "deny") refuse("deny", reason);
    if (result.decision === "ask" && canAsk) refuse("ask", reason);
  } catch {
    refuse("deny", why);
  }
  answer({});
}

function preTool(stdin) {
  let input;
  try {
    input = JSON.parse(stdin);
  } catch {
    refuse("deny", UNCHECKED);
  }
  const name = input !== null && typeof input === "object" && typeof input.tool_name === "string" ? input.tool_name : "";
  if (name === "") refuse("deny", UNCHECKED);
  if (SESSION_TOOLS.includes(name) && !NO_SESSION_ACTIONS.includes(actionOf(input))) {
    // The session the agent passes is the conversation's own: nothing else is accepted.
    const session = sessionOf(input);
    if (session === "") refuse("deny", UNCHECKED);
    answer({ updated_input: { session } });
  }
  decide(stdin, false);
}

function postTool(stdin) {
  try {
    const input = JSON.parse(stdin);
    const event = input.hook_event_name;
    const command = typeof input.command === "string" ? input.command : "";
    if (event === "afterShellExecution" && !NETWORK.test(command)) process.exit(0);
    if (event === "afterMCPExecution" && OURS.test(String(input.mcp_server_name ?? ""))) process.exit(0);
    if (event === "postToolUse" && !/^(?:WebFetch|WebSearch)$/.test(String(input.tool_name ?? ""))) process.exit(0);
    engine("post-tool", stdin);
  } catch {}
  answer({});
}

// The message the creator typed: Cursor's transcript frame cut off if it shows.
function requestText(prompt) {
  const found = USER_QUERY.exec(prompt);
  return found === null ? prompt : found[1];
}

// A conversation Cursor opened for a sub-agent is not the creator's: its transcript sits in a
// \x60subagents\x60 folder of the conversation's own (agent-transcripts/<id>/subagents/).
function creators(transcript) {
  return !(typeof transcript === "string" && /[\\/]subagents[\\/]/i.test(transcript));
}

function context(session) {
  return "${SESSION_CONTEXT_PREFIX}" + session + " (pass it as session to chat.answer)";
}

function sessionStart(stdin) {
  let session = "";
  try {
    session = sessionOf(JSON.parse(stdin));
  } catch {}
  answer(session === "" ? { continue: true } : { continue: true, additional_context: context(session) });
}

function beforeSubmit(stdin) {
  let session = "";
  try {
    const input = JSON.parse(stdin);
    session = sessionOf(input);
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    const typed = creatorText(seen(requestText(prompt)));
    const text = typed === undefined ? "" : normalize(typed);
    if (session !== "" && text !== "" && creators(input.transcript_path)) {
      const dir = storeDir();
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const now = Date.now();
      const file = join(dir, sha256(session).slice(0, 32) + ".jsonl");
      prune(dir, file, now);
      const line = { v: 1, via: "cursor", session, project: ROOT, at: new Date(now).toISOString(), digest: sha256(text), text: text.slice(0, MAX_TEXT) };
      appendFileSync(file, JSON.stringify(line) + "\n", { mode: 0o600 });
    }
  } catch {}
  answer(session === "" ? { continue: true } : { continue: true, additional_context: context(session) });
}

const event = process.argv[2] ?? "";
let stdin = "";
try {
  stdin = readInput();
} catch {}
if (event === "shell") decide(stdin, true);
else if (event === "pre-tool") preTool(stdin);
else if (event === "post-tool") postTool(stdin);
else if (event === "before-submit") beforeSubmit(stdin);
else if (event === "session-start") sessionStart(stdin);
else answer({});
`;
}

/** A Cursor session id as the hook stores it, or undefined (the script keeps the same shape). */
export function cursorSessionIdOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  return /^[\x21-\x7e]{1,200}$/.test(id) ? id : undefined;
}
