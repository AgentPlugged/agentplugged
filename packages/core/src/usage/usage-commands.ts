import { ErrorCode, MeasureUsageInputSchema } from "@agentplugged/protocol";
import { agentWriteContext, invalidInput } from "../agent-activity/agent-commands.js";
import { defineCommand, fail, ok } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { type MeasureOutcome, measureProduct } from "./measure-product.js";

/** What `measure_usage` answers: the outcome of the reading, nothing to read back from an agent. */
export type MeasureUsageResult = MeasureOutcome;

/**
 * `measure_usage`: the engine reads the traces of the AI tools on this machine, ties
 * each session to its story and writes what is new or changed to the journal. Nothing an agent
 * says goes into it: the agent only asks for the reading. Noah calls it when a story or a sprint
 * ends, and the engine also does it when an agent submits a result.
 */
export const measureUsageCommand = defineCommand<MeasureUsageResult>({
  name: "measure_usage",
  audience: "agent",
  description:
    "Have the engine measure what the AI tool's sessions consumed: it reads the traces the tool keeps on this machine (Claude Code's transcripts; Codex's rollouts; Antigravity's conversations), ties each session to its story and each part of it to its agent, its phase and its work from what was written in the journal, and writes what is new or changed. You declare nothing: the tokens, the models and the time are the engine's reading, never an agent's word. The engine already does it when an agent submits a result: call it when a story or a sprint ends, to read again the sessions still running (your own among them). Nothing of it is shown to the creator: it is kept in the journal. `skipped` counts the traces it could not read. `available: false`: no trace to read here (an AI tool the engine cannot read: Cursor keeps no token count); `readable: false`: this machine holds no product key, nothing is written.",
  inputSchema: MeasureUsageInputSchema,
  async run(context, input) {
    const parsed = MeasureUsageInputSchema.safeParse(input);
    if (!parsed.success) return fail(invalidInput("measure_usage", parsed.error));
    const target = await agentWriteContext(context, parsed.data.agent);
    if (target instanceof AgentPluggedError) return fail(target);
    try {
      return ok(await measureProduct(context, target));
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      return fail(
        new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  },
});
