import { z } from "zod";
import { SemverSchema } from "./method-config.js";

/**
 * Migrations of the format of `.agentplugged/`: `npx agentplugged migrate` brings a
 * product to the format the running engine knows (`METHOD_FORMAT_VERSION`), pins that engine,
 * and records it in the journal. Nothing of the journal is ever rewritten.
 */

/** Event types of the format, each at version 1. */
export const METHOD_EVENT_TYPES = {
  /** The product moved to another format, or pinned another engine (`migrate`). */
  migrated: "method.migrated",
} as const;

/** Identifier of a migration step: lowercase kebab-case, stable once shipped. */
export const MigrationStepIdSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/**
 * `payload` of `method.migrated`: the formats before and after, the engines pinned before (null
 * when none was) and after, and the steps applied, in order: one per format crossed (none when
 * only the engine changed). An event that changes nothing (same format, same engine) is refused.
 */
export const MethodMigratedPayloadSchema = z
  .strictObject({
    from_format: z.int().min(0),
    to_format: z.int().min(0),
    from_engine: SemverSchema.nullable(),
    to_engine: SemverSchema,
    steps: z.array(MigrationStepIdSchema).max(1000),
  })
  .refine((payload) => payload.to_format >= payload.from_format, { path: ["to_format"] })
  .refine((payload) => payload.steps.length === payload.to_format - payload.from_format, {
    path: ["steps"],
  })
  .refine(
    (payload) =>
      payload.to_format !== payload.from_format || payload.from_engine !== payload.to_engine,
    { path: ["to_engine"] },
  );

export type MethodMigratedPayload = z.infer<typeof MethodMigratedPayloadSchema>;
