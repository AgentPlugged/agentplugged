import { z } from "zod";

/**
 * The order of a device that lets the agents of a product run one more command: its first words
 * (`pnpm test`), written by the machine into the product's own settings for the tool. It is the
 * answer to a refusal the creator saw in the agent's log: one gesture, one signed order.
 */
export const ORDER_TYPE_COMMAND_ALLOW = "command.allow";

/** A command prefix: plain words, paths and options, nothing the tool's rule syntax could read as a pattern. */
export const COMMAND_PREFIX_PATTERN =
  /^(?:[A-Za-z0-9][A-Za-z0-9._/ -]{0,98}[A-Za-z0-9]|[A-Za-z0-9])$/u;

export const CommandAllowParamsSchema = z.strictObject({
  command: z.string().regex(COMMAND_PREFIX_PATTERN),
});
export type CommandAllowParams = z.infer<typeof CommandAllowParamsSchema>;

/** The codes the machine answers `command.allow` with when it cannot. */
export const COMMAND_ALLOW_CODES = {
  /** The product is not served by this machine, or the tool of its agents takes no such rule. */
  UNAVAILABLE: "ALLOW_UNAVAILABLE",
  /** The product's settings file cannot be read as JSON: nothing was changed. */
  SETTINGS_UNREADABLE: "ALLOW_SETTINGS_UNREADABLE",
  /** The settings file could not be written. */
  WRITE_FAILED: "ALLOW_WRITE_FAILED",
} as const;
export type CommandAllowCode = (typeof COMMAND_ALLOW_CODES)[keyof typeof COMMAND_ALLOW_CODES];
