import { z } from "zod";

/**
 * The installations the approved architecture plans. The architecture document
 * (`.agentplugged/docs/architecture.md`) declares, in its header, the dependencies and tools the
 * product is built on, by ecosystem; the engine never guesses it. Every installation follows the
 * creator's setting (`installs.mode`): `visible` (the default: no validation, recorded
 * in the activity and the journal, with whether the architecture plans it) or `validate` (one
 * validation per installation; a planned or plainly official one is of a medium risk, which a stack
 * may group).
 */

/** Event type of a planned installation let through and recorded, at version 1. */
export const INSTALL_EVENT_TYPES = {
  recorded: "install.recorded",
} as const;

/**
 * The ecosystems a declaration names, each with the package managers that install from its
 * official registry: `npm` (npm, pnpm, yarn, bun), `pypi` (pip, uv, poetry), `crates` (cargo),
 * `go` (go), `rubygems` (gem, bundler), `packagist` (composer). Identifiers are stable.
 */
export const DEPENDENCY_ECOSYSTEMS = [
  "npm",
  "pypi",
  "crates",
  "go",
  "rubygems",
  "packagist",
] as const;
export type DependencyEcosystem = (typeof DEPENDENCY_ECOSYSTEMS)[number];

/** The header field of the architecture document that declares the planned dependencies. */
export const ARCHITECTURE_DEPENDENCIES_FIELD = "dependencies";

/** Most names declared for one ecosystem. */
export const MAX_DECLARED_DEPENDENCIES = 500;

/**
 * A package or tool name as a registry knows it: `react`, `@scope/pkg`, `Django`,
 * `github.com/spf13/cobra`, `vendor/package`. No whitespace, quote, shell character or version.
 */
export const PackageNameSchema = z
  .string()
  .min(1)
  .max(214)
  .regex(/^(?:@[A-Za-z0-9][A-Za-z0-9._~+-]*\/)?[A-Za-z0-9][A-Za-z0-9._/+~-]*$/, {
    message:
      "expected a package name (letters, digits and . _ - / + ~, a leading @scope/), without a version",
  });

/** The dependencies an architecture declares, by ecosystem: `npm: [react, supabase]`. */
export const DependenciesSchema = z.partialRecord(
  z.enum(DEPENDENCY_ECOSYSTEMS),
  z.array(PackageNameSchema).max(MAX_DECLARED_DEPENDENCIES),
);
export type Dependencies = z.infer<typeof DependenciesSchema>;

/** How an installation reached the gate: a hook of the AI tool, or an agent's `request_action`. */
export const INSTALL_VIA = ["hook", "request"] as const;

/**
 * `payload` of `install.recorded`: a planned installation the engine let through without asking
 * (`installs.mode: visible`), so that it shows in the product's activity. `packages` are the names
 * installed (none for an installation of the manifest's own dependencies, `manifest: true`).
 */
export const InstallRecordedPayloadSchema = z.strictObject({
  /** `other` for an installation the engine could not read. */
  ecosystem: z.enum([...DEPENDENCY_ECOSYSTEMS, "other"]),
  manager: z.string().regex(/^[a-z][a-z0-9.+-]{0,31}$/),
  packages: z.array(PackageNameSchema).max(50),
  manifest: z.boolean(),
  via: z.enum(INSTALL_VIA),
  /** Whether the approved architecture plans the installation; absent before. */
  planned: z.boolean().optional(),
  /**
   * The engine could not read what the command installs (a URL, a path, a Git source, another
   * registry): recorded all the same, nothing is installed out of sight.
   */
  unreadable: z.boolean().optional(),
});
export type InstallRecordedPayload = z.infer<typeof InstallRecordedPayloadSchema>;
