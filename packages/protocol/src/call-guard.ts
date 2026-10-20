import { z } from "zod";

/**
 * The guard before every tool call. A hook of the AI tool runs before each tool (`check_call`);
 * the engine refuses the call when the story it belongs to reached its budget, or when the team is
 * paused and the call would write, run a command or start an agent, and lets it through otherwise.
 * Values come as the hook substitutes them (`${tool_name}`): possibly empty, or left as `${…}` when
 * the hook's input has no such field; the engine reads them with that doubt. In doubt the call goes
 * through.
 */
export const CheckCallInputSchema = z.strictObject({
  /** The tool about to run (`Bash`, `Edit`, `mcp__<server>__<tool>`…). */
  tool: z.string().max(200),
  session: z.string().trim().min(1).max(200).optional(),
  cwd: z.string().max(2000).optional(),
  /** The kind of sub-agent that makes the call, when the tool says it (absent for the main session). */
  agent: z.string().max(200).optional(),
});
export type CheckCallInput = z.infer<typeof CheckCallInputSchema>;
