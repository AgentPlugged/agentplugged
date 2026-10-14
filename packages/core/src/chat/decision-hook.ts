import { QUESTION_TOOL_MAX_QUESTIONS, QUESTION_TOOL_NAME } from "@agentplugged/protocol";
import { chatStoreHelpers, GENERATED_HEADER_SLASH, SESSION_CONTEXT_PREFIX } from "./prompt-hook.js";

/**
 * The Claude Code hook that records the creator's answers to the question tool:
 * a `PostToolUse` hook of type `command` (never `mcp_tool`: an agent could call an MCP tool
 * itself) on `AskUserQuestion`. Claude Code runs it after the creator answered in the conversation
 * window; it records, in the chat's store of the machine (`~/.agentplugged/chat/`, outside the
 * repository and the journal, kept 24 hours), the fingerprint of the questions the tool was asked
 * and the creator's answer to each, exactly as the tool returned them. The engine reads the
 * answer from that record alone (`chat.answer` and `chat.stack_answer` with `via: "question_tool"`),
 * and only when the questions are the ones it dictated.
 *
 * What the real tool gives (Claude Code 2.1.289, proved by a recording hook in a real session, see
 * the story's spec): `tool_input` = `{ questions: [{ question, header, options: [{ label,
 * description }], multiSelect }], answers: { "<question>": "<label or the creator's own words>" } }`
 * once the creator answered, and `tool_response` the same object. A question the creator
 * dismissed gives no `PostToolUse` at all (the tool call is refused). The same script also runs
 * before the tool (`PreToolUse`) and refuses a call whose input already carries `answers`: an agent
 * could otherwise write the answer itself. Never records anything for a headless session.
 */

/** Where `sync` writes the script, relative to the project. */
export const DECISION_HOOK_PATH = ".claude/hooks/agentplugged-decision.mjs";

/** The name agents may never run (`sync` denies `node …agentplugged-decision…`). */
export const DECISION_HOOK_NAME = "agentplugged-decision";

/** The command Claude Code runs, from the project's folder whatever the session's. */
export const DECISION_HOOK_COMMAND = `node "$CLAUDE_PROJECT_DIR/${DECISION_HOOK_PATH}"`;

/** How long Claude Code waits for the hook, in seconds. */
export const DECISION_HOOK_TIMEOUT = 10;

/** The longest answer or note kept. */
export const DECISION_ANSWER_MAX = 2000;

/**
 * The questions' fingerprint, in JavaScript: the same rule as `normalizeToolQuestions` and
 * `questionsDigest` (core), which a test runs against this text.
 */
export const DECISION_HOOK_HELPERS = `const text = (value) => (typeof value === "string" ? value : "");
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

function normalizeQuestions(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > ${QUESTION_TOOL_MAX_QUESTIONS}) return undefined;
  return raw.map((entry) => {
    const question = isObject(entry) ? entry : {};
    const options = Array.isArray(question.options) ? question.options : [];
    return {
      question: text(question.question),
      header: text(question.header),
      multiSelect: question.multiSelect === true,
      options: options.map((option) => {
        const value = isObject(option) ? option : {};
        return { label: text(value.label), description: text(value.description) };
      }),
    };
  });
}

// True when the tool was given fields the fingerprint does not cover (a preview, a kind…): the
// creator may have seen more than the engine dictated, so the engine will not read this record.
const QUESTION_KEYS = ["question", "header", "multiSelect", "options"];
const OPTION_KEYS = ["label", "description"];
function hasExtra(raw) {
  if (!Array.isArray(raw)) return false;
  return raw.some((entry) => {
    if (!isObject(entry)) return false;
    if (Object.keys(entry).some((key) => !QUESTION_KEYS.includes(key))) return true;
    return (Array.isArray(entry.options) ? entry.options : []).some(
      (option) => isObject(option) && Object.keys(option).some((key) => !OPTION_KEYS.includes(key)),
    );
  });
}

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return "{" + entries.map(([key, entry]) => JSON.stringify(key) + ":" + canonical(entry)).join(",") + "}";
  }
  return JSON.stringify(value);
}
`;

/** The script, the same for every product. */
export function renderDecisionHookScript(): string {
  return String.raw`${GENERATED_HEADER_SLASH}
// Claude Code hook of the question tool (agentplugged): after the creator answered the questions of
// ${QUESTION_TOOL_NAME}, records the fingerprint of the questions and each answer, as the tool returned
// them, in ~/.agentplugged/chat/, outside the repository and the journal, kept ${24} hours. Before the
// tool runs, refuses a call that already carries answers. chat.answer and chat.stack_answer (via the
// question tool) accept an answer only when it is one of these records, for questions the engine dictated.
// Never blocks anything else: any failure is ignored. Agents never run it nor write its store.
${chatStoreHelpers()}${DECISION_HOOK_HELPERS}
const MAX_ANSWER = ${DECISION_ANSWER_MAX};

// A session started without a terminal (claude -p, the SDK) has no creator answering.
function automatic() {
  return (process.env.CLAUDE_CODE_ENTRYPOINT ?? "").toLowerCase().startsWith("sdk");
}

const cut = (value) => [...value].slice(0, MAX_ANSWER).join("");

let refusal = "";
let context = "";
try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const id = typeof input.session_id === "string" ? input.session_id.trim() : "";
  const session = /^[\x21-\x7e]{1,200}$/.test(id) ? id : "";
  const toolInput = isObject(input.tool_input) ? input.tool_input : {};
  if (input.tool_name === "${QUESTION_TOOL_NAME}" && input.hook_event_name === "PreToolUse") {
    // The creator's answers come from the tool's own window, never from the call.
    if (Object.hasOwn(toolInput, "answers") || Object.hasOwn(toolInput, "annotations")) {
      refusal = "Do not pass answers or annotations: the creator answers in the tool's own window.";
    }
  } else if (input.tool_name === "${QUESTION_TOOL_NAME}" && input.hook_event_name === "PostToolUse") {
    // Only what the tool returned (tool_response), never the call's own input: an answer the agent
    // wrote is no answer. A dialog the tool closed by itself (a timeout) or left half answered
    // (a follow-up, a free response) is not a click either.
    const response = isObject(input.tool_response) ? input.tool_response : {};
    const given = isObject(response.answers) ? response.answers : undefined;
    const notes = isObject(response.annotations) ? response.annotations : {};
    const partial = ["afkTimeoutMs", "followUp", "response"].some((key) => Object.hasOwn(response, key));
    const questions = normalizeQuestions(toolInput.questions);
    const project = (process.env.CLAUDE_PROJECT_DIR ?? "").trim() || (typeof input.cwd === "string" ? input.cwd : "");
    if (session !== "" && project !== "" && given !== undefined && questions !== undefined && !partial && !automatic()) {
      const answers = [];
      for (const { question } of questions) {
        const answer = Object.hasOwn(given, question) ? text(given[question]).trim() : "";
        if (answer === "") continue;
        const note = isObject(notes[question]) ? text(notes[question].notes).trim() : "";
        answers.push({ question, answer: cut(answer), ...(note === "" ? {} : { notes: cut(note) }) });
      }
      if (answers.length > 0) {
        const dir = storeDir();
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const now = Date.now();
        const file = join(dir, sha256(session).slice(0, 32) + ".decisions.jsonl");
        prune(dir, file, now);
        const line = { v: 1, session, project, at: new Date(now).toISOString(), fingerprint: sha256(canonical(questions)), ...(hasExtra(toolInput.questions) ? { extra: true } : {}), answers };
        appendFileSync(file, JSON.stringify(line) + "\n", { mode: 0o600 });
        context = "${SESSION_CONTEXT_PREFIX}" + session + " (the creator's answer to the question tool was recorded; if these questions came from chat.ask or chat.stack_ask, call chat.answer or chat.stack_answer now with via question_tool and this session; never write the answer yourself)";
      }
    }
  }
} catch {}
if (refusal !== "") {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: refusal } }) + "\n");
} else if (context !== "") {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context } }) + "\n");
}
process.exit(0);
`;
}

/** The hook handler `sync` writes in `.claude/settings.json`, for `PreToolUse` and `PostToolUse`. */
export function decisionHookHandler(): Record<string, unknown> {
  return { type: "command", command: DECISION_HOOK_COMMAND, timeout: DECISION_HOOK_TIMEOUT };
}

/** True for our hook handler: a `command` hook that runs our script. */
export function isDecisionHook(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const handler = value as Record<string, unknown>;
  return (
    handler.type === "command" &&
    typeof handler.command === "string" &&
    handler.command.includes(`${DECISION_HOOK_NAME}.mjs`)
  );
}
