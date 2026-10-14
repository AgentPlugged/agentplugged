import type { CommandContext } from "../command.js";
import type { WorkspaceFiles } from "../workspace-files.js";
import { isAntigravityClient } from "./chat-proof.js";
import { DECISION_HOOK_PATH, isDecisionHook, renderDecisionHookScript } from "./decision-hook.js";

/**
 * The channels through which the engine can ask the creator a decision, in the
 * order it uses them: the AI tool's MCP form (`elicitation`), the AI tool's question tool
 * (`question_tool`, with the hook that records the answer), the chat (`chat`: « a, b ou c », then
 * `answer_checkpoint` with the creator's own words). Read from the session as it is at this call.
 */
export type DecisionChannel = "elicitation" | "question_tool" | "chat";

/**
 * What the form did in this session:
 * - `works`: the creator answered one;
 * - `untested`: the client announced forms and none was sent yet (the engine tries it first);
 * - `declined_by_client`: the client refused one at once, before a person could read it (the VS Code
 *   extension of Claude Code does): the engine does not send another;
 * - `unavailable`: the client did not announce forms.
 */
export type ElicitationState = "works" | "untested" | "declined_by_client" | "unavailable";

/**
 * The question tool: `available` (the tool has it here and the project holds the hook that records
 * the answer), `hook_missing` (the tool has it, the project lacks the hook: run `sync`),
 * `unavailable` (the tool has none in this session).
 */
export type QuestionToolState = "available" | "hook_missing" | "unavailable";

export interface DecisionChannels {
  /** The channels the engine can use now, in the order it tries them; `chat` is always last. */
  readonly available: readonly DecisionChannel[];
  readonly elicitation: ElicitationState;
  readonly question_tool: QuestionToolState;
}

/** True when the MCP client is Antigravity (its own hooks; no question tool of this kind). */
function antigravity(context: CommandContext): boolean {
  return context.conversation !== undefined || isAntigravityClient(context.session?.client);
}

/** Where `sync` writes the hooks of Claude Code. */
const SETTINGS_PATH = ".claude/settings.json";

/** A script as a file holds it: line endings as Git may have changed them are not a difference. */
const lf = (text: string) => text.replace(/\r\n/g, "\n");

/**
 * True when the project holds the hook that records the creator's answers to the question tool, as
 * `sync` writes it: the script, byte for byte (a script of an older engine, edited or replaced would
 * fingerprint the questions another way), and its two handlers (`PreToolUse`, `PostToolUse`) on
 * `AskUserQuestion` in the project's settings, hooks not all disabled. Anything unreadable: not
 * installed.
 */
export async function decisionHookInstalled(files: WorkspaceFiles): Promise<boolean> {
  try {
    if (!(await files.exists(DECISION_HOOK_PATH))) return false;
    if (lf(await files.readText(DECISION_HOOK_PATH)) !== lf(renderDecisionHookScript())) {
      return false;
    }
    if (!(await files.exists(SETTINGS_PATH))) return false;
    const settings = JSON.parse(await files.readText(SETTINGS_PATH)) as Record<string, unknown>;
    if (settings.disableAllHooks === true) return false;
    const hooks = settings.hooks as Record<string, unknown> | undefined;
    return ["PreToolUse", "PostToolUse"].every((event) => {
      const groups = hooks?.[event];
      return (
        Array.isArray(groups) &&
        groups.some(
          (group) =>
            typeof group === "object" &&
            group !== null &&
            (group as { matcher?: unknown }).matcher === "AskUserQuestion" &&
            Array.isArray((group as { hooks?: unknown }).hooks) &&
            ((group as { hooks: unknown[] }).hooks as unknown[]).some(isDecisionHook),
        )
      );
    });
  } catch {
    return false;
  }
}

/** The state of the question tool for this call. */
export async function questionToolState(context: CommandContext): Promise<QuestionToolState> {
  const access = context.questionTool;
  if (access === undefined || !access.available || antigravity(context)) return "unavailable";
  return (await decisionHookInstalled(context.files)) ? "available" : "hook_missing";
}

/** The channels of this call (`get_state`, `next`, `ask_creator`). */
export async function decisionChannels(context: CommandContext): Promise<DecisionChannels> {
  const port = context.creatorPrompt;
  const seen = context.session?.form;
  const elicitation: ElicitationState =
    port === undefined
      ? seen === "refused"
        ? "declined_by_client"
        : "unavailable"
      : seen === "refused"
        ? "declined_by_client"
        : seen === "works"
          ? "works"
          : "untested";
  const tool = await questionToolState(context);
  const available: DecisionChannel[] = [];
  if (elicitation === "works" || elicitation === "untested") available.push("elicitation");
  if (tool === "available") available.push("question_tool");
  available.push("chat");
  return { available, elicitation, question_tool: tool };
}
