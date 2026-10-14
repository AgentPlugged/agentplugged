import { ErrorCode, MAIN_SESSION_AGENT, NOAH_AGENT } from "@agentplugged/protocol";
import { AgentPluggedError } from "../errors.js";
import { METHOD_CONFIG_PATH } from "../init/layout.js";
import { loadMethodConfig } from "../init/method-config.js";
import { activeDefinitions, loadDefinitions } from "../sync/sync-command.js";
import type { WorkspaceFiles } from "../workspace-files.js";

export { NOAH_AGENT };

/**
 * Noah's contract with the engine: the only agent commands he calls.
 * He reads (`get_state`, `next`, `get_trace`, `read_sensitive`, `read_memory`), declares his activity
 * (`report_status`), records the creator's answers (`answer_checkpoint`, or `ask_creator` in the
 * AI tool's form), presents the checkpoints that wait as one stack and records the
 * answer (`open_stack`, `ask_stack`, `answer_stack`), hands work over
 * (`delegate`), reports what he read outside (`record_external_read`) and asks the creator for an
 * action reserved to them, such as creating an agent (`request_creator_action`), and asks the
 * engine to measure what the sessions consumed (`measure_usage`), and to read the state of
 * the machine (`check_environment`). He
 * never opens a checkpoint, starts or delivers a story, writes a result, a sprint, a cost or a
 * sensitive file: the agents who own that work do.
 */
export const NOAH_COMMANDS: ReadonlySet<string> = new Set([
  "get_state",
  "next",
  "get_trace",
  "read_sensitive",
  "read_memory",
  "report_status",
  "answer_checkpoint",
  "ask_creator",
  "open_stack",
  "ask_stack",
  "answer_stack",
  "delegate",
  "record_external_read",
  "request_creator_action",
  "measure_usage",
  "round_table",
  "check_environment",
  "loop",
]);

/** The message of each refusal: Noah, the main session while Noah is active, another agent. */
const ROLE_MESSAGES: Readonly<Record<string, string>> = {
  [NOAH_AGENT]: "error.role_forbidden.noah",
  [MAIN_SESSION_AGENT]: "error.role_forbidden.main_session",
};

/**
 * `ROLE_FORBIDDEN`: an agent's call outside its role; nothing is written. Noah outside his
 * contract, the main session under `main` while Noah is active (it is Noah), or another agent
 * handing work over (`delegate` is Noah's only), each with its text.
 */
export function roleForbidden(agent: string, command: string): AgentPluggedError {
  const key = ROLE_MESSAGES[agent] ?? "error.role_forbidden.not_router";
  return new AgentPluggedError(ErrorCode.ROLE_FORBIDDEN, key, { agent, command });
}

/**
 * True when Noah is installed and active for this product: the main session is then Noah. False
 * when anything cannot be read: the command reports its own error.
 */
export async function noahActive(files: WorkspaceFiles): Promise<boolean> {
  try {
    if (!(await files.exists(METHOD_CONFIG_PATH))) return false;
    const loaded = await loadMethodConfig(files);
    if (loaded instanceof AgentPluggedError) return false;
    const definitions = await loadDefinitions(files);
    if (definitions instanceof AgentPluggedError) return false;
    return activeDefinitions(definitions, loaded.config).some(
      (definition) => definition.kind === "agent" && definition.name === NOAH_AGENT,
    );
  } catch {
    return false;
  }
}

/**
 * Why an agent's call is outside its role, before it runs: Noah calling a command of no contract
 * of his, or the main session doing so under the reserved id `main` while Noah is active (the
 * main session is Noah then: `main` is no way around his contract). The agent id is read as the
 * commands read it, trimmed and without case, so no spelling gets around it. Undefined when the
 * call may run.
 */
export async function agentRoleProblem(
  command: string,
  input: Readonly<Record<string, unknown>>,
  files: WorkspaceFiles,
): Promise<AgentPluggedError | undefined> {
  if (NOAH_COMMANDS.has(command) || typeof input.agent !== "string") return undefined;
  const agent = input.agent.trim().toLowerCase();
  if (agent === NOAH_AGENT) return roleForbidden(NOAH_AGENT, command);
  if (agent === MAIN_SESSION_AGENT && (await noahActive(files))) {
    return roleForbidden(MAIN_SESSION_AGENT, command);
  }
  return undefined;
}
