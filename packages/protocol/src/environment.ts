import { z } from "zod";

/**
 * The environment of the machine: what the engine checks before the creator's first
 * « noah ? », and what an architecture asks of the machine later. The checks themselves are data
 * (`doctor.yaml`, shipped with the method); only their identifiers and the architecture's
 * `prerequisites` are typed here.
 */

/** The header field of the architecture document that declares what the stack asks of the machine. */
export const ARCHITECTURE_PREREQUISITES_FIELD = "prerequisites";

/** The identifier of a check: `git.identity`, `prerequisite.tool.docker`. */
export const ENVIRONMENT_CHECK_ID_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*){0,3}$/;

/** A check's identifier, as `check_environment` gives it and `environment_fix` names it. */
export const EnvironmentCheckIdSchema = z
  .string()
  .max(80)
  .regex(ENVIRONMENT_CHECK_ID_PATTERN, { message: "expected a check id such as git.identity" });

/** A command as a program finds it on the machine: `docker`, `node`, `supabase`; never a path. */
export const PrerequisiteCommandSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/, { message: "expected a command name, not a path" });

/** A version as `x`, `x.y` or `x.y.z`: what a tool must be at least. */
export const PrerequisiteVersionSchema = z
  .union([z.string(), z.number()])
  .transform(String)
  .pipe(
    z.string().regex(/^\d{1,6}(?:\.\d{1,6}){0,2}$/, {
      message: "expected a version such as 24 or 24.0.1",
    }),
  );

/** Most entries of each kind an architecture declares. */
export const MAX_PREREQUISITES = 50;

/**
 * What the stack decided asks of the machine, written by the architect in the header of the
 * architecture (`prerequisites`): tools (a command and the version it must be at least), ports
 * that must be free, a minimum of memory. Never a command to run: a document the engine reads
 * cannot make it start anything; the repair of such a point is always a set of steps to follow.
 */
export const PrerequisitesSchema = z.strictObject({
  tools: z
    .array(
      z.strictObject({
        name: PrerequisiteCommandSchema,
        min: PrerequisiteVersionSchema.optional(),
        /** Why the product needs it, in a few words (shown next to the point). */
        why: z.string().min(1).max(120).optional(),
      }),
    )
    .max(MAX_PREREQUISITES)
    .optional(),
  ports: z.array(z.int().min(1).max(65_535)).max(MAX_PREREQUISITES).optional(),
  memory_gb: z.number().positive().max(4096).optional(),
});
export type Prerequisites = z.infer<typeof PrerequisitesSchema>;
