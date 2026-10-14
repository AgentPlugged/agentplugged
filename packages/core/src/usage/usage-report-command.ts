import { projectWithKey } from "../agent-activity/agent-commands.js";
import { defineCommand, fail, ok } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { METHOD_CONFIG_PATH } from "../init/layout.js";
import { loadMethodConfig } from "../init/method-config.js";
import { methodNotInstalled } from "../profile/profile-command.js";
import { parseUsageAsk, type UsageReport, usageReport } from "./usage-report.js";

/**
 * `usage [--by story|step|skill|agent|session] [--story <e-s>] [--since <day>] [--until <day>]
 * [--session <tool>:<id>] [--json]`: what the AI tools consumed, read from the
 * measures the engine already wrote in the journal. Reads, writes nothing, costs the agent
 * nothing, and is no tool of the MCP server (the creator's command). Tokens and the origin of each
 * figure; the only cost is the estimate of a story, said so.
 */
export const usageCommand = defineCommand<UsageReport>({
  name: "usage",
  async run(context, input) {
    const ask = parseUsageAsk(input);
    if (ask instanceof AgentPluggedError) return fail(ask);
    if (!(await context.files.exists(METHOD_CONFIG_PATH))) return fail(methodNotInstalled());
    const loaded = await loadMethodConfig(context.files);
    if (loaded instanceof AgentPluggedError) return fail(loaded);
    if (context.journal === undefined) {
      return fail(methodNotInstalled());
    }
    try {
      const listing = await context.journal.list();
      const { projection, warnings } = await projectWithKey(context, loaded.config, listing);
      return ok(
        await usageReport(context, loaded.config, ask, {
          state: projection.state,
          unreadable: warnings.some((warning) => warning.code === "sensitive_unreadable"),
          events: listing.events,
        }),
      );
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    }
  },
});
