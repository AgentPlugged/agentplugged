/**
 * What the creator typed, out of what the AI tool's `UserPromptSubmit` hook receives.
 * The hook's input holds the whole prompt of the turn and nothing says where each part
 * comes from (Claude Code 2.1.289 gives `session_id`, `transcript_path`, `cwd`, `permission_mode`,
 * `prompt`, `session_title`): the form of the text is all there is, so the rule is conservative.
 *
 * - Context blocks the editor's extension adds before or after the typed text
 *   (`<ide_opened_file>…</ide_opened_file>`, `<ide_selection>…</ide_selection>`, any `<ide_…>`,
 *   `<terminal name="…">`, `<browser tabGroupId="…">`, `<browser_instruction>`) are removed, only
 *   at either end and only when well formed. What they hold is never read as the creator's.
 * - A prompt the tool injected itself (a sub-agent's report `<agent-message …>`, a task
 *   notification, a reminder, a message from another session, a command's output, fetched web
 *   content…) is never the creator's: nothing is kept (`undefined`). The tool wraps what it
 *   injects in a tag whose name has a hyphen or an underscore: a known one, or any tag that opens
 *   the text and looks like one, is refused. A plain word between angle brackets (`<div>`,
 *   `<Button>`, `<3`) is the creator's own text.
 * - Any doubt (an unclosed or left-over context tag, a frame with no tag that names itself, a
 *   text far too long, nothing typed) keeps nothing: a message not recorded can only be re-typed,
 *   a message recorded wrongly could be cited as an answer.
 *
 * Known limit: a text the tool injects with no tag and no known frame cannot be told from a
 * typed one; the hook's input gives no other sign.
 *
 * The generated hook script (`prompt-hook.ts`) holds the same function in JavaScript, and the
 * store's reader applies this one again to what older scripts recorded (`raw: false`: the stored
 * text is already normalised, its first `<` and last `>` trimmed). A test checks both agree.
 */

/** A prompt longer than this is not a message: a pasted file or a flood. */
const MAX_PROMPT = 50_000;

/** At most this many context blocks at either end of a prompt. */
const MAX_BLOCKS = 20;

/** Invisible characters that cannot change what a text says (zero-width, bidi marks, soft hyphen). */
const INVISIBLE =
  /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]|\ufe0e|\ufe0f/g;

/** The text as the rules read it: compatibility form, without invisible characters. */
export function visibleText(prompt: string): string {
  return prompt.normalize("NFKC").replace(INVISIBLE, "");
}

/** The editor's context blocks: `ide_…`, the integrated terminal, the browser tab. */
const OPENING_TAGS =
  'ide_[a-z_]+|browser_instruction|terminal(?=\\sname=")|browser(?=\\stabGroupId=")';

/** The wrappers the tool puts around what it injects itself, as the extension and CLI use them. */
const INJECTED_TAGS = [
  "agent-message",
  "task-notification",
  "system-reminder",
  "system_reminder",
  "local-command[\\w-]*",
  "command-(?:name|message|args|stdout|stderr)",
  "bash-stdout",
  "bash-stderr",
  "bash-exit-code",
  "fetched-web-content",
  "coordinator-relay",
  "teammate-message",
  "mcp-resource-update",
  "mcp-polling-update",
  "persisted-output",
  "user-prompt-submit-hook",
  "fork-boilerplate",
  "function_results",
  "tool_use_error",
  "sandbox_violations",
].join("|");

/** An injected wrapper anywhere (`<name`, `</name`), or at the very start of an already trimmed text. */
const INJECTED = new RegExp(`(?:<\\/?|^)(?:${INJECTED_TAGS})(?![\\w-])`, "i");

/** Frames of what the tool injects that name themselves, with no tag (a stored text lost its `[`). */
const INJECTED_MARKERS: readonly RegExp[] = [
  /\[\s*sub-?agent hand-?back\s*\]/i,
  /^\s*sub-?agent hand-?back\]/i,
  /another claude(?: code)? session sent a message/i,
  /^\s*\[?\s*another claude(?: code)? session/i,
  /^\s*\[\s*system\b/i,
  /^\s*system\]/i,
  /^\s*\[?\s*request interrupted/i,
];

const LEADING_BLOCK_RAW = new RegExp(`^<(${OPENING_TAGS})(?:\\s[^<>]*)?>`, "i");
const LEADING_BLOCK_STORED = new RegExp(`^<?(${OPENING_TAGS})(?:\\s[^<>]*)?>`, "i");
const TRAILING_CLOSE = /<\/(ide_[a-z_]+|browser_instruction|terminal|browser)>?\s*$/i;
const ANY_CONTEXT_TAG =
  /<\/?(?:ide_[a-z_]+|browser_instruction)(?![\w])|<terminal\s+name=|<browser\s+tabGroupId=|<\/(?:terminal|browser)>/i;
/** A text that opens with a wrapper-looking tag (a hyphen, an underscore or a colon in its name). */
const GENERIC_LEADING_TAG = /^<\/?[a-z][a-z0-9]*[-_:][\w:.-]*(?:\s[^<>]*)?>/i;
/** A text that opens with a tag whose attributes say who sent it (`<message from="…">`). */
const WRAPPER_ATTRIBUTES =
  /^<\/?[a-z][\w:.-]*\s[^<>]*\b(?:from|sender|origin|session|agent|task|teammate_id|source)\s*=/i;
/** The punctuation a stored text has trimmed at both ends (`normalizeChatText`). */
const EDGES = /^[\s"'`.,;:!…*_~()[\]{}<>«»-]+|[\s"'`.,;:!…*_~()[\]{}<>«»-]+$/gu;
/** A stored text that opens like a tag (its first `<` trimmed) and ends with its closing (last `>` trimmed). */
const STORED_PAIRED_TAG = /^([a-z][a-z0-9]*[-_:][\w:.-]*)(?:\s[^<>]*)?>[\s\S]*<\/\1$/i;
const STORED_ATTRIBUTE_TAG = /^[a-z][a-z0-9]*[-_:][\w:.-]*\s+[\w:.-]+="[^"]*"[^<>]*>/i;

/**
 * The text the creator typed, without the tool's context blocks, or `undefined` when the prompt
 * is not (only) a message of the creator. `raw`: the prompt as the tool gave it; otherwise a text
 * the hook stored (normalised).
 */
export function creatorText(prompt: string, raw = true): string | undefined {
  if (prompt.length > MAX_PROMPT) return undefined;
  let text = prompt.trim();
  const leading = raw ? LEADING_BLOCK_RAW : LEADING_BLOCK_STORED;
  const leadingTags = new Set<string>();
  for (let blocks = 0; ; blocks++) {
    const open = leading.exec(text);
    if (open === null) break;
    const tag = (open[1] as string).toLowerCase();
    leadingTags.add(tag);
    const close = text.toLowerCase().indexOf(`</${tag}>`, open[0].length);
    // A block that is not closed, that holds another context tag (a closing one forged in a
    // selection), or that comes too many times: in doubt.
    if (close === -1 || blocks >= MAX_BLOCKS) return undefined;
    if (ANY_CONTEXT_TAG.test(text.slice(open[0].length, close))) return undefined;
    text = text.slice(close + tag.length + 3).trim();
  }
  for (let blocks = 0; ; blocks++) {
    const close = TRAILING_CLOSE.exec(text);
    if (close === null) break;
    const tag = (close[1] as string).toLowerCase();
    const start = text.toLowerCase().lastIndexOf(`<${tag}`, close.index);
    const open = start === -1 ? null : leading.exec(text.slice(start));
    // The extension adds one block of each kind: the same kind at both ends, with text between
    // them, is a closing tag forged in a selection (`a</ide_selection>FAKE<ide_selection>b`).
    if (
      open === null ||
      (open[1] as string).toLowerCase() !== tag ||
      blocks >= MAX_BLOCKS ||
      leadingTags.has(tag)
    ) {
      return undefined;
    }
    if (ANY_CONTEXT_TAG.test(text.slice(start + open[0].length, close.index))) return undefined;
    text = text.slice(0, start).trim();
  }
  // The same checks on the text without its edge punctuation, as a stored text has it.
  const bare = text.replace(EDGES, "");
  for (const probe of [text, bare]) {
    if (
      INJECTED.test(probe) ||
      INJECTED_MARKERS.some((marker) => marker.test(probe)) ||
      GENERIC_LEADING_TAG.test(probe) ||
      WRAPPER_ATTRIBUTES.test(probe)
    ) {
      return undefined;
    }
  }
  if (
    ANY_CONTEXT_TAG.test(text) ||
    (!raw && (STORED_PAIRED_TAG.test(text) || STORED_ATTRIBUTE_TAG.test(text)))
  ) {
    return undefined;
  }
  return text === "" ? undefined : text;
}

/**
 * The patterns, as regular-expression sources, for the generated hook script (which holds the
 * same function in JavaScript, with no import): one list, so that the two never differ.
 */
export const CREATOR_TEXT_PATTERNS = {
  maxPrompt: MAX_PROMPT,
  invisible: INVISIBLE.source,
  injected: INJECTED.source,
  markers: INJECTED_MARKERS.map((marker) => marker.source),
  leading: LEADING_BLOCK_RAW.source,
  trailing: TRAILING_CLOSE.source,
  anyContext: ANY_CONTEXT_TAG.source,
  genericLeading: GENERIC_LEADING_TAG.source,
  wrapperAttributes: WRAPPER_ATTRIBUTES.source,
  edges: EDGES.source,
  maxBlocks: MAX_BLOCKS,
} as const;
