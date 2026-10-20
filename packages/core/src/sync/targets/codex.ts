import type { ModelChoice } from "@agentplugged/protocol";
import { hookLaunch } from "../../chat/antigravity-hook.js";
import {
  CODEX_HOOK_DEFINITIONS,
  CODEX_HOOK_PATH,
  CODEX_POLICY_PATH,
  CODEX_RULES_PATH,
  codexHookCommands,
  renderCodexHookScript,
} from "../../chat/codex-hook.js";
import { GENERATED_HEADER_HASH } from "../../init/generated.js";
import { isInherit } from "../../models/model-table.js";
import type { AntigravityPolicy } from "../../trust/antigravity-policy.js";
import { renderAgentBody } from "../agent-render.js";
import { renderCodexRules } from "../codex-rules.js";
import {
  type ExtensionMcpServer,
  MCP_SERVER_NAME,
  type McpServerLaunch,
  usableExtensionServers,
  withEngineCommand,
} from "../mcp.js";
import type { CodexRuleSettings } from "../rule-permissions.js";
import { agentsOf, modelOf, type RenderInput, type Target } from "./common.js";

export const CODEX_DIR = ".codex";
export const CODEX_AGENTS_DIR = `${CODEX_DIR}/agents`;
export const CODEX_CONFIG_PATH = `${CODEX_DIR}/config.toml`;

/** A control character written as a TOML `\uXXXX` escape. */
function escapeControl(char: string): string {
  return `\\u${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** A TOML basic string on one line: `"..."`, every special character escaped. */
export function tomlString(text: string): string {
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are escaped here.
    .replace(/[\u0000-\u001F\u007F]/g, escapeControl);
  return `"${escaped}"`;
}

/**
 * A TOML multi-line basic string: `"""` then a line break (trimmed by TOML), the text, `"""`.
 * Backslashes and quotes are escaped, so no `"""` can close it early; line feeds and tabs stay.
 */
export function tomlMultiline(text: string): string {
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are escaped here.
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, escapeControl);
  return `"""\n${escaped}"""`;
}

/** `.codex/agents/<name>.toml`: a Codex agent, named in plain language by the creator. */
export function renderCodexAgent(
  name: string,
  description: string,
  body: string,
  choice?: ModelChoice,
): string {
  // With `inherit`, model and effort are left out: the agent runs on the session's model.
  const model: string[] = [];
  if (choice !== undefined && !isInherit(choice)) {
    model.push(`model = ${tomlString(choice.model)}`);
    if (choice.effort !== undefined) {
      model.push(`model_reasoning_effort = ${tomlString(choice.effort)}`);
    }
  }
  return [
    GENERATED_HEADER_HASH,
    `name = ${tomlString(name)}`,
    `description = ${tomlString(description)}`,
    ...model,
    `developer_instructions = ${tomlMultiline(body)}`,
    "",
  ].join("\n");
}

/**
 * The hooks of the project, in `.codex/config.toml` (`[[hooks.<Event>]]`): the proof of
 * the chat before each message, the product's rules before a shell command or a patch, the reads of
 * outside content after a command or a tool of another MCP server. The definitions are the same on
 * every machine and every engine version (the engine's launch is in the policy file): Codex records
 * its approval against the hash of a definition, so an update of the engine asks nothing again.
 * Observed on Codex 0.160.1 (2026-10-06, `hooks/list` of its app server): the hash covers the
 * command of the platform, the timeout and the matcher, never the script; the approval is kept
 * under the key `<config path>:<event>:<group>:<handler>`, so a hook put BEFORE another of the same event changes
 * the other's key and asks again: a new hook goes last, and nothing here is edited lightly (the
 * test `codex-sync.test.ts` pins this text).
 */
export function renderCodexHooks(): string {
  const { command, commandWindows } = codexHookCommands();
  const hook = (event: string, script: string, timeout: number, matcher?: string): string =>
    [
      `[[hooks.${event}]]`,
      ...(matcher === undefined ? [] : [`matcher = ${tomlString(matcher)}`]),
      "",
      `[[hooks.${event}.hooks]]`,
      'type = "command"',
      `command = ${tomlString(command(script))}`,
      `command_windows = ${tomlString(commandWindows(script))}`,
      `timeout = ${timeout}`,
      "",
    ].join("\n");
  return CODEX_HOOK_DEFINITIONS.map((def) =>
    hook(def.event, def.script, def.timeout, def.matcher),
  ).join("\n");
}

/**
 * `approval_policy` as Codex's `config.toml` reads it. A bare `never` refuses every approval
 * request, the forms an MCP server asks for (elicitation) included: observed on Codex 0.160.1
 * (2026-10-06), the engine's `ask_creator` is declined without the editor ever seeing it. The
 * granular form refuses what asks the creator to leave the sandbox (commands, `prompt` rules,
 * permission requests, skills) and keeps only the forms: nothing blocks the night, and a decision
 * at daytime is a click. `codex exec` runs with `never` whatever the file says, and declines forms.
 */
export function codexApprovalToml(policy: "never" | "on-request"): string {
  if (policy !== "never") return `"${policy}"`;
  return "{ granular = { mcp_elicitations = true, rules = false, sandbox_approval = false, request_permissions = false, skill_approval = false } }";
}

/**
 * Project settings: writes stay in the project's folder (the sandbox), Codex asks nothing while
 * agents edit on their own (no approval, written by `codexApprovalToml`; `on-request` otherwise), the
 * `agentplugged` MCP server is started by `launch` (the pinned engine through npx by default) and its
 * tools run without approval, and the hooks of the project (`renderCodexHooks`). Codex reads this
 * file only for a project marked as trusted, and runs the hooks once the creator approved them.
 */
export function renderCodexConfig(
  launch: McpServerLaunch,
  rules?: CodexRuleSettings,
  extensionServers: readonly ExtensionMcpServer[] = [],
): string {
  const args = launch.args.map(tomlString).join(", ");
  // The permission rules: the sandbox follows `edit_code`, network and web search
  // follow `internet`; nothing is asked while agents edit on their own.
  const sandbox = rules?.sandboxMode ?? "workspace-write";
  const approval = codexApprovalToml(rules?.approvalPolicy ?? "on-request");
  const webSearch = rules?.webSearch === undefined ? "" : `web_search = "${rules.webSearch}"\n`;
  // `[sandbox_workspace_write]` (read only in `workspace-write`): the network when `internet` is
  // `allow`, and the folder of the stories' working copies, which sit next to the project.
  const roots = sandbox === "workspace-write" ? (rules?.writableRoots ?? []) : [];
  const section = [
    ...(rules?.networkAccess === true ? ["network_access = true"] : []),
    ...(roots.length === 0 ? [] : [`writable_roots = [${roots.map(tomlString).join(", ")}]`]),
  ];
  const network =
    section.length === 0 ? "" : `\n[sandbox_workspace_write]\n${section.join("\n")}\n`;
  // The servers a program built on the engine asks for, beside the engine's own.
  const extras = usableExtensionServers(extensionServers)
    .map(
      (extra) =>
        `\n[mcp_servers.${extra.name}]\ncommand = ${tomlString(extra.launch.command)}\nargs = [${extra.launch.args.map(tomlString).join(", ")}]\ndefault_tools_approval_mode = "approve"\n`,
    )
    .join("");
  return `${GENERATED_HEADER_HASH}
sandbox_mode = "${sandbox}"
approval_policy = ${approval}
${webSearch}${network}
[mcp_servers.${MCP_SERVER_NAME}]
command = ${tomlString(launch.command)}
args = [${args}]
default_tools_approval_mode = "approve"
${extras}
${renderCodexHooks()}`;
}

/**
 * The files of the hooks and of the rules: the script, the policy it and the engine
 * read (the product's lists and the engine's launch), and `.codex/rules/agentplugged.rules`. `policy`
 * is what `sync` computed for the permission rules. Without `hooks` (the creator's own
 * `config.toml` declares none of ours), only the rules of commands are written.
 */
export function renderCodexGuard(
  input: RenderInput,
  policy: AntigravityPolicy,
  hooks = true,
): Target[] {
  const rules: Target = {
    path: CODEX_RULES_PATH,
    content: renderCodexRules(
      policy.rules,
      policy.main_branch,
      input.codexRules?.approvalPolicy ?? "on-request",
    ),
    group: "codex",
  };
  if (!hooks) return [rules];
  const launch = hookLaunch(input.mcpLaunch);
  return [
    { path: CODEX_HOOK_PATH, content: renderCodexHookScript(), group: "codex" },
    {
      path: CODEX_POLICY_PATH,
      content: `${JSON.stringify({ ...policy, launch }, null, 2)}\n`,
      group: "codex",
    },
    rules,
  ];
}

/** Codex files: one agent per active agent, and `.codex/config.toml`. Codex reads `AGENTS.md`. */
export function renderCodex(input: RenderInput): Target[] {
  const targets: Target[] = agentsOf(input).map((agent) => ({
    path: `${CODEX_AGENTS_DIR}/${agent.name}.toml`,
    content: renderCodexAgent(
      agent.name,
      agent.description,
      withEngineCommand(renderAgentBody(agent), input.engineCommand),
      modelOf(input, "codex", agent),
    ),
    group: "codex",
  }));
  targets.push({
    path: CODEX_CONFIG_PATH,
    content: renderCodexConfig(input.mcpLaunch, input.codexRules, input.extensionServers),
    group: "codex",
  });
  return targets;
}
