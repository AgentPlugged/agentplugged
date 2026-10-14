import { z } from "zod";

/**
 * The identifiers of the requirements and of the commands that prove them
 * In a module of their own so that the schemas that name them need not import each other.
 */

/** A requirement the register holds: an `ENF-n` of the PRD, or an `AD-n` that carries a budget. */
export const REGISTERED_REQUIREMENT_PATTERN = /^(?:ENF|AD)-[1-9]\d*$/;

/** A requirement id as stored. */
export const RegisteredRequirementIdSchema = z.string().regex(REGISTERED_REQUIREMENT_PATTERN, {
  message: "expected ENF-n or AD-n, for example ENF-3",
});

/** A requirement id as typed (`enf-3`, spaces): trimmed, in upper case, then checked. */
export const RegisteredRequirementInputSchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(RegisteredRequirementIdSchema);

/** The name of a command the project declares for its proofs: `tests`, `lint`, `p95-api`. */
export const PROOF_COMMAND_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;
