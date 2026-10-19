import { QUESTION_TOOL_NAME, type RuleAction, type RuleValue } from "@agentplugged/protocol";
import {
  ACTIVITY_END_MATCHER,
  ACTIVITY_START_MATCHER,
  activityHookHandler,
  isActivityHook,
} from "../chat/activity-hook.js";
import { decisionHookHandler, isDecisionHook } from "../chat/decision-hook.js";
import { isPromptHook, promptHookHandler } from "../chat/prompt-hook.js";
import { toolInputOf } from "../mcp-tools.js";
import { NETWORK_COMMANDS } from "../trust/command-match.js";
import { isRecord } from "../values.js";
import { MCP_SERVER_NAME } from "./mcp.js";
import { claudeActionRules } from "./rule-permissions.js";

/**
 * The Claude Code hooks of the trace (calibrated), in
 * `.claude/settings.json`. Each one is an `mcp_tool` hook: Claude Code calls a tool of the
 * session's own `agentplugged` MCP server, without starting a process. `PostToolUse` after a web
 * fetch, a web search, a network command (`curl`, `wget`, `gh`, `git pull`/`fetch`/`clone`) or a
 * tool of another MCP server records the read (`record_external_read`) in the journal: a trace,
 * nothing is blocked for it. `PreToolUse` before an installation, when its rule is not `deny`, asks
 * the gate (`check_action`), which records it in the activity (`installs.mode: visible`) or opens
 * the creator's validation (`validate`), one handler per pattern (`if`). An `if` cannot leave out
 * the engine's own `npx agentplugged …`: `check_action` lets it through. Only shell commands are
 * gated: file tools (Read, Edit, Write) stay governed by the deny rules alone.
 * Hooks are best-effort, like the rules: a server that is not connected lets the tool's own rules
 * decide. Claude Code's `if` cannot read what a command holds (a here-document, a quoted
 * string): it may call a hook for a harmless command. So `record_external_read` and
 * `check_action` read the command again (`trust/command-match.ts`, `NETWORK_COMMANDS` lives
 * there too) and ignore it when it fetches nothing from outside, or matches no rule.
 *
 * Two `command` hooks on the question tool (`AskUserQuestion`): `PostToolUse` records
 * the creator's answer, `PreToolUse` refuses a call that already carries answers
 * (`chat/decision-hook.ts`).
 *
 * A `UserPromptSubmit` hook of type `command` (never `mcp_tool`): it runs the
 * generated script that records the creator's messages, the proof of the chat's answers
 * (`chat/prompt-hook.ts`).
 *
 * A `command` hook on the file and shell tools, before and after them (`chat/activity-hook.ts`):
 * it appends a line to a small file of the machine so that a program there can show what a session
 * opened in the creator's terminal does. It never answers the tool.
 */

type Json = Record<string, unknown>;

/** The tools our hooks call, which mark a hook handler as ours. */
const HOOK_TOOLS: ReadonlySet<string> = new Set([
  // The grouped tool, and the one-action tools older `sync` runs wrote (replaced).
  "guard",
  "record_external_read",
  "check_action",
]);

/** The events our hooks use. */
export const TRUST_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
] as const;
export type TrustHookEvent = (typeof TRUST_HOOK_EVENTS)[number];

/** One matcher group of `hooks.<event>` (`UserPromptSubmit` has no matcher). */
export interface HookGroup {
  readonly matcher?: string;
  readonly hooks: readonly Json[];
}

export type TrustHooks = Readonly<Record<TrustHookEvent, readonly HookGroup[]>>;

/** How long Claude Code waits for one of our hooks, in seconds. */
const HOOK_TIMEOUT = 30;

/** A value Claude Code substitutes from the hook's input: `${tool_input.url}`. */
export function hookValue(path: string): string {
  return `\${${path}}`;
}

/**
 * Every tool of another MCP server (Claude Code names them `mcp__<server>__<tool>`), except ours
 * and the editor's (`ide`, `claude-vscode`), which bring nothing from outside. Every other server
 * marks the session, even one that reads only local data: by caution.
 */
export const OTHER_MCP_MATCHER = `^mcp__(?!(?:${MCP_SERVER_NAME}|ide|claude-vscode)__)`;

/**
 * A hook that calls an engine command. The server publishes grouped tools: the call is
 * written as the tool and action that reach `command` (`guard` with `action: "check"`), with the
 * command's own `action` field published as `what`.
 */
function handler(
  command: string,
  fields: Json,
  condition?: string,
  timeout: number = HOOK_TIMEOUT,
): Json {
  const grouped = toolInputOf(command, fields);
  if (grouped === undefined) throw new Error(`no tool reaches the command ${command}`);
  return {
    type: "mcp_tool",
    server: MCP_SERVER_NAME,
    tool: grouped.tool,
    ...(condition === undefined ? {} : { if: condition }),
    input: grouped.input,
    timeout,
  };
}

/**
 * How long Claude Code waits for the guard before a write, in seconds: the engine itself gives up
 * after a few hundred milliseconds (`WRITE_GUARD_BUDGET_MS`); this is the fence around it.
 */
export const WRITE_HOOK_TIMEOUT = 5;

/**
 * The file tools the guard before a write reads, each with the field of its input that
 * holds the path and the one that holds what is written (`MultiEdit`: the list of edits, which the
 * engine reads as the text Claude Code substitutes for it).
 */
const WRITE_TOOLS: ReadonlyArray<{ tool: string; path: string; text: string }> = [
  { tool: "Write", path: "file_path", text: "content" },
  { tool: "Edit", path: "file_path", text: "new_string" },
  { tool: "MultiEdit", path: "file_path", text: "edits" },
  { tool: "NotebookEdit", path: "notebook_path", text: "new_source" },
];

/** The two tools that run a shell command in Claude Code: both carry it in `tool_input.command`. */
const SHELL_MATCHER = "Bash|PowerShell";

/**
 * The `if` conditions of a hook on the shell tools: each `Bash(x)` condition and its
 * `PowerShell(x)` twin, as a condition matches the calls of one tool only.
 */
function shellConditions(conditions: readonly string[]): string[] {
  return conditions.flatMap((condition) => [
    condition,
    `PowerShell${condition.slice("Bash".length)}`,
  ]);
}

/** The hooks `sync` writes for Claude Code, from the rules in force. */
export function claudeTrustHooks(
  rules: Readonly<Record<RuleAction, RuleValue>>,
  mainBranch?: string,
): TrustHooks {
  const session = hookValue("session_id");
  const pre: HookGroup[] = [];
  const conditions =
    rules.install_dependency === "deny"
      ? []
      : shellConditions(
          claudeActionRules("install_dependency", mainBranch).filter((entry) =>
            entry.startsWith("Bash("),
          ),
        );
  if (conditions.length > 0) {
    pre.push({
      matcher: SHELL_MATCHER,
      hooks: conditions.map((condition) =>
        handler(
          "check_action",
          {
            action: "install_dependency",
            command: hookValue("tool_input.command"),
            session,
            cwd: hookValue("cwd"),
          },
          condition,
        ),
      ),
    });
  }
  // Before a file is written, the engine checks the secret rule, the story's scope and
  // the architecture's checkable decisions; in doubt it lets the write through.
  for (const { tool, path, text } of WRITE_TOOLS) {
    pre.push({
      matcher: tool,
      hooks: [
        handler(
          "check_write",
          {
            tool,
            path: hookValue(`tool_input.${path}`),
            text: hookValue(`tool_input.${text}`),
            session,
            cwd: hookValue("cwd"),
          },
          undefined,
          WRITE_HOOK_TIMEOUT,
        ),
      ],
    });
  }
  const post: HookGroup[] = [
    {
      matcher: "WebFetch",
      hooks: [
        handler("record_external_read", {
          tool: "WebFetch",
          source: hookValue("tool_input.url"),
          session,
        }),
      ],
    },
    {
      matcher: "WebSearch",
      hooks: [handler("record_external_read", { tool: "WebSearch", session })],
    },
    {
      matcher: SHELL_MATCHER,
      hooks: shellConditions(NETWORK_COMMANDS).map((condition) =>
        handler(
          "record_external_read",
          {
            // The hook's `if` names the shell tool, so it also tells which one ran.
            tool: condition.startsWith("PowerShell(") ? "PowerShell" : "Bash",
            source: hookValue("tool_input.command"),
            session,
          },
          condition,
        ),
      ),
    },
    {
      matcher: OTHER_MCP_MATCHER,
      hooks: [handler("record_external_read", { tool: hookValue("tool_name"), session })],
    },
  ];
  // The proof of the chat: a command hook, run for each message of the creator.
  const prompt: HookGroup[] = [{ hooks: [promptHookHandler()] }];
  // The creator's answers to the question tool: recorded after it, and no answer
  // written by the call itself before it.
  const question: HookGroup = { matcher: QUESTION_TOOL_NAME, hooks: [decisionHookHandler()] };
  // What a session opened in the creator's terminal does: one line before each file or shell
  // tool, one after each shell command (its end, well or not).
  const activity = activityHookHandler();
  return {
    PreToolUse: [...pre, question, { matcher: ACTIVITY_START_MATCHER, hooks: [activity] }],
    PostToolUse: [...post, question, { matcher: ACTIVITY_END_MATCHER, hooks: [activity] }],
    PostToolUseFailure: [{ matcher: ACTIVITY_END_MATCHER, hooks: [activity] }],
    UserPromptSubmit: prompt,
  };
}

/**
 * A hook handler `sync` wrote: an `mcp_tool` hook of the `agentplugged` server, one of ours, or
 * the command hook that runs our script.
 */
export function isTrustHook(value: unknown): boolean {
  return (
    (isRecord(value) &&
      value.type === "mcp_tool" &&
      value.server === MCP_SERVER_NAME &&
      typeof value.tool === "string" &&
      HOOK_TOOLS.has(value.tool)) ||
    isPromptHook(value) ||
    isDecisionHook(value) ||
    isActivityHook(value)
  );
}

/**
 * The settings with our hooks brought to `hooks` (undefined: removed). The creator's hooks are
 * kept, in their order; ours are recognised by their shape, removed, then added again at the end
 * of each event's list. A group, a list or `hooks` itself is removed only when removing ours left
 * it empty. A `hooks` that is not an object, or an event that is not a list, is left as is.
 */
export function withTrustHooks<T extends object>(settings: T, hooks: TrustHooks | undefined): T {
  const result = JSON.parse(JSON.stringify(settings)) as Json;
  const current = result.hooks;
  if (current !== undefined && !isRecord(current)) return result as T;
  const target: Json = current === undefined ? {} : current;
  let removedAny = false;
  for (const event of TRUST_HOOK_EVENTS) {
    const ours = hooks?.[event] ?? [];
    const existing = target[event];
    if (existing !== undefined && !Array.isArray(existing)) continue;
    let removed = false;
    const kept: unknown[] = [];
    for (const group of (existing as unknown[] | undefined) ?? []) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        kept.push(group);
        continue;
      }
      const others = group.hooks.filter((entry) => !isTrustHook(entry));
      if (others.length === group.hooks.length) kept.push(group);
      else {
        removed = true;
        if (others.length > 0) kept.push({ ...group, hooks: others });
      }
    }
    const next = [
      ...kept,
      ...ours.map((group) =>
        group.matcher === undefined
          ? { hooks: group.hooks }
          : { matcher: group.matcher, hooks: group.hooks },
      ),
    ];
    if (next.length > 0) target[event] = next;
    else if (removed) delete target[event];
    removedAny ||= removed;
  }
  if (Object.keys(target).length > 0) result.hooks = target;
  else if (current !== undefined && removedAny) delete result.hooks;
  return result as T;
}
