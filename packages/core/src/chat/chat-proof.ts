import {
  ANTICIPATED_ANSWER_WINDOW_MS,
  CHAT_RETENTION_MS,
  type ChatMessageRef,
} from "@agentplugged/protocol";
import { ANTIGRAVITY_HOOK_PATH } from "./antigravity-hook.js";
import { normalizeChatText, quoteDigest } from "./chat-text.js";
import { CODEX_HOOK_PATH } from "./codex-hook.js";
import { CURSOR_HOOK_PATH } from "./cursor-hook.js";
import { PROMPT_HOOK_PATH } from "./prompt-hook.js";
import type { DecisionLog } from "./question-tool.js";

/**
 * The proof of the chat: the messages the creator typed or dictated, as
 * the AI tool's hook recorded them on this machine, outside the repository and the journal, and
 * the rule a quote must meet.
 */

/** One message of the creator, as the hook recorded it. */
export interface ChatMessage {
  /** The AI tool's session id. */
  readonly session: string;
  /** When the hook recorded it (ISO 8601, UTC). */
  readonly at: string;
  /** SHA-256 of its normalised text (`messageDigest`). */
  readonly digest: string;
  /** Its normalised text (possibly cut). */
  readonly text: string;
  /** The project folder of the session (`CLAUDE_PROJECT_DIR`), when the hook gave it. */
  readonly project?: string;
}

/**
 * Port through which the engine reads the creator's messages of one session: the store the hook
 * writes (`~/.agentplugged/chat/`). Read only: nothing in the engine writes it, and no MCP tool
 * reaches it. A missing store or session gives no message.
 */
export interface ChatLog {
  messages(session: string): Promise<readonly ChatMessage[]>;
  /**
   * True when the hook of one tool (`via`: `codex`, `cursor`) recorded at least one message for
   * this project: the proof that the creator approved the project's hooks. Absent:
   * the store cannot say.
   */
  hasMessageFrom?(project: string, via: string): Promise<boolean>;
}

/** What the engine knows of the chat proof, given by the surface (the MCP server). */
export interface ChatAccess {
  /** The creator's messages the hook recorded. Absent: none can be found. */
  readonly log?: ChatLog;
  /**
   * The creator's answers to the AI tool's question tool, as its hook recorded them.
   * Absent: none can be found.
   */
  readonly decisions?: DecisionLog;
  /**
   * The AI tool that started this server records the creator's messages with its hook (Claude
   * Code: the server's environment says it, `CLAUDECODE=1`). The MCP client's name says it too
   * (`claude-code`, `AgentSession.client`).
   */
  readonly hooked?: boolean;
  /**
   * The product's folder (the server's working folder): only the messages of a session of this
   * project count (`sameProject`), never a message sent for another product of the machine.
   */
  readonly project?: string;
  /**
   * True when the project holds the hook's script (`sync` targeted Claude Code). A tool with
   * hooks answers `hook_missing` without it: never `chat_unverified` in Claude Code.
   */
  readonly hookInstalled?: boolean;
}

/** One folder, whatever its separators, its case or its trailing separator. */
function folderKey(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

/** True when two folders are the same project (separators and case left aside). */
export function sameProject(a: string, b: string): boolean {
  return folderKey(a) === folderKey(b);
}

/** The MCP client Antigravity CLI announces (`antigravity-client`, version 1.2.16). */
export function isAntigravityClient(name: string | undefined): boolean {
  return name !== undefined && /^antigravity(?:[- _](?:client|cli))?$/i.test(name.trim());
}

/**
 * The MCP clients Codex announces (`codex-mcp-client`, and the names of its editor extension, its
 * app and its terminal: `codex_vscode`, `Codex Desktop`…): a name that starts with `codex`.
 */
export function isCodexClient(name: string | undefined): boolean {
  return name !== undefined && /^codex(?:[- _.].*)?$/i.test(name.trim());
}

/**
 * The MCP client of the Cursor editor (`cursor-vscode`, Cursor 3.23.12). Only the editor: its
 * `beforeSubmitPrompt` hook records the creator's messages. The Cursor CLI (`cursor-agent`) does not
 * emit that hook in the versions seen (forum, 2026-08-21): whatever name it announces is not a hooked
 * client, and an answer given in the chat is recorded unverified there.
 */
export function isCursorClient(name: string | undefined): boolean {
  return name !== undefined && /^cursor-vscode$/i.test(name.trim());
}

/**
 * The MCP clients whose tool has a hook `sync` writes that records the creator's messages: Claude
 * Code (`UserPromptSubmit`), Antigravity CLI (`PreInvocation`, which reads the transcript, story
 * 3.22), Codex (`UserPromptSubmit` of the project's hooks) and the Cursor editor
 * (`beforeSubmitPrompt` of the project's hooks).
 */
export function isHookedClient(name: string | undefined): boolean {
  return (
    (name !== undefined && /^claude[- _]?code$/i.test(name.trim())) ||
    isAntigravityClient(name) ||
    isCodexClient(name) ||
    isCursorClient(name)
  );
}

/**
 * The AI tool a call comes from, for the chat's proof: Antigravity when the call names its
 * conversation (`CommandContext.conversation`: a field its client sets, whatever name it announced
 * or none), else the MCP client's name.
 */
export function chatClientOf(context: {
  readonly conversation?: string | undefined;
  readonly session?: { readonly client: string | undefined } | undefined;
}): string | undefined {
  return context.conversation === undefined ? context.session?.client : "antigravity-client";
}

/**
 * The session whose messages can prove an answer. Antigravity names the conversation a
 * call comes from (`CommandContext.conversation`): the session the agent gives must be that one,
 * else nothing proves the answer (`undefined`: the messages of another conversation, a sub-agent's
 * or a session an agent started itself are never read). Without a conversation (Claude Code), the
 * session the agent gave.
 */
export function proofSession(
  given: string | undefined,
  conversation: string | undefined,
): string | undefined {
  if (given === undefined || conversation === undefined) return given;
  // The conversation as the client names it: the hook recorded the messages under that spelling.
  return given.trim().toLowerCase() === conversation.trim().toLowerCase()
    ? conversation.trim()
    : undefined;
}

/**
 * The session whose messages prove an answer, for a call: `proofSession`, and nothing
 * at all from an Antigravity client whose call names no conversation (a client that sends no
 * `_meta`, another server in front): the session an agent gives is then its own word.
 */
export function proofSessionOf(
  context: {
    readonly conversation?: string | undefined;
    readonly session?: { readonly client: string | undefined } | undefined;
  },
  given: string | undefined,
): string | undefined {
  if (context.conversation === undefined && isAntigravityClient(context.session?.client)) {
    return undefined;
  }
  return proofSession(given, context.conversation);
}

/** The file whose presence says the project holds the hook of that client (`hookInstalled`). */
export function chatHookPath(name: string | undefined): string {
  if (isCodexClient(name)) return CODEX_HOOK_PATH;
  if (isCursorClient(name)) return CURSOR_HOOK_PATH;
  return isAntigravityClient(name) ? ANTIGRAVITY_HOOK_PATH : PROMPT_HOOK_PATH;
}

/** Why a quote is refused (`hook_missing`: the tool has hooks, the project lacks the script). */
export type QuoteRefusal = "no_message" | "before_opening" | "already_cited" | "hook_missing";

/** What a quote proves: the message found, or why none. */
export type QuoteMatch =
  | { readonly ok: true; readonly message: ChatMessage }
  | { readonly ok: false; readonly reason: QuoteRefusal };

/** A message, as cited in the journal: its digest and date. */
export const refOf = (message: ChatMessage): ChatMessageRef => ({
  digest: message.digest,
  at: message.at,
});

/** The key of a cited message: one message answers one checkpoint at most. */
export const citedKey = (ref: ChatMessageRef) => `${ref.digest}@${Date.parse(ref.at)}`;

/**
 * The message a quote proves: a whole message of the session (same normalised text), recorded
 * after `after` (milliseconds: the checkpoint's opening), at most `CHAT_RETENTION_MS` before `now`, and not cited by an answer already
 * accepted (`cited`, `citedKey`). The earliest such message wins. A part of a message never
 * matches: it could reverse its meaning (« ne valide pas » is not « valide »).
 *
 * The creator agreed to exactly the decision the point then asks, a few
 * minutes before it opened (the agent had announced it): a message up to
 * `ANTICIPATED_ANSWER_WINDOW_MS` before the opening counts.
 */
export function matchQuote(
  messages: readonly ChatMessage[],
  quote: string,
  options: {
    readonly after: number;
    readonly now: number;
    readonly cited: ReadonlySet<string>;
    readonly anticipated?: boolean;
  },
): QuoteMatch {
  if (normalizeChatText(quote) === "") return { ok: false, reason: "no_message" };
  const digest = quoteDigest(quote);
  const same = messages
    .filter((message) => message.digest === digest)
    .filter((message) => {
      const at = Date.parse(message.at);
      return !Number.isNaN(at) && at <= options.now && options.now - at <= CHAT_RETENTION_MS;
    });
  if (same.length === 0) return { ok: false, reason: "no_message" };
  const from = options.after - (options.anticipated === true ? ANTICIPATED_ANSWER_WINDOW_MS : 0);
  const after = same.filter((message) => Date.parse(message.at) > from);
  if (after.length === 0) return { ok: false, reason: "before_opening" };
  const free = after.filter((message) => !options.cited.has(citedKey(refOf(message))));
  if (free.length === 0) return { ok: false, reason: "already_cited" };
  // An agreement given before the opening is the closest one to it (« oui » says many things).
  const latest = options.anticipated === true;
  return {
    ok: true,
    message: free.reduce((chosen, message) =>
      Date.parse(message.at) < Date.parse(chosen.at) !== latest ? message : chosen,
    ),
  };
}
