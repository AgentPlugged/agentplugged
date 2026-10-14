export const packageName = "@agentplugged/mcp";

export {
  type AgentServerOptions,
  createAgentServer,
  DRAIN_TIMEOUT_MS,
  type ErrorText,
  MCP_SERVER_NAME,
  PendingCalls,
  type RunOptions,
  runAgentServer,
} from "./server.js";
export { MAX_DESCRIPTION, publishedTools, TOOL_DESCRIPTIONS } from "./tool-groups.js";
