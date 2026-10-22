export const packageName = "@agentplugged/adapters-tools";

export { installedEntry, isReleaseVersion } from "./engine-store.js";
export { NodeEngineUpdates } from "./node-engine-updates.js";
export { NodeEvalAgent, type NodeEvalAgentOptions } from "./node-eval-agent.js";
export {
  MAX_COPY_BYTES,
  MAX_COPY_FILES,
  NodeMutationLab,
  type NodeMutationLabOptions,
} from "./node-mutation-lab.js";
export { NodeProofRunner, type NodeProofRunnerOptions } from "./node-proof-runner.js";
export { NodeToolProbe, type NodeToolProbeOptions } from "./node-tool-probe.js";
export {
  claudeProjectFolder,
  NodeUsageTraces,
  type NodeUsageTracesOptions,
} from "./node-usage-traces.js";
export {
  createAdapterFor,
  createClaudeCodeAdapter,
  createToolAdapter,
  type ToolAdapterOptions,
} from "./runs/adapter.js";
export { antigravityTranslator } from "./runs/antigravity.js";
export { claudeCodeTranslator } from "./runs/claude-code.js";
export { codexTranslator } from "./runs/codex.js";
export { isAllowableCommand } from "./runs/command-allow.js";
export {
  type Launcher,
  type LaunchPlan,
  type LineTranslator,
  type McpPlan,
  type PermissionPlan,
  type RunBilling,
  type RunContext,
  type RunEvent,
  type RunLimits,
  type RunOutcome,
  type RunRequest,
  RunRequestInvalid,
  type RunResult,
  type RunToolId,
  type RunUsage,
  type ToolAction,
  type ToolAdapter,
  type ToolCapabilities,
  type ToolRun,
  type ToolTranslator,
} from "./runs/contract.js";
export { cursorTranslator } from "./runs/cursor.js";
export { kimiExitFailure, kimiTranslator } from "./runs/kimi.js";
export { resolveLauncher } from "./runs/launcher.js";
export { LineSplitter } from "./runs/lines.js";
export {
  DEFAULT_MAX_DURATION_MS,
  type StartToolRunOptions,
  startToolRun,
} from "./runs/process-core.js";
export { runSettingsDir, sweepRunSettings, writeRunSettings } from "./runs/run-settings.js";
export { chooseShell, type ShellProbe } from "./runs/shell.js";
export {
  canContinueSession,
  canKeepWarm,
  canLaunchSubAgents,
  canNameSession,
  canReportContext,
  canStreamText,
  canTakeLiveInput,
  type TerminalCommand,
  terminalCommandFor,
} from "./runs/terminal.js";
export { TRANSLATORS, translatorFor } from "./runs/translators.js";
