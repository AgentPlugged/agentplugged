import {
  DEFAULT_INSTALL_MODE,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_VALIDATION_MODE,
  ErrorCode,
  type GitWorkflow,
  type InstallMode,
  type PermissionMode,
  type Profile,
  type ToolId,
  type ValidationMode,
  type ValidationPoint,
} from "@agentplugged/protocol";
import { defineCommand, fail, ok } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { sameGitWorkflow, validateGitWorkflow, writeGitWorkflow } from "../git/git-workflow.js";
import { METHOD_CONFIG_PATH } from "../init/layout.js";
import { loadMethodConfig } from "../init/method-config.js";
import type { WorkspaceFiles } from "../workspace-files.js";
import {
  validateInstallMode,
  validatePermissionMode,
  validatePoints,
  validateProfile,
  validateValidationMode,
  writeInstallMode,
  writePermissionMode,
  writePoints,
  writeProfile,
  writeValidationMode,
} from "./profile.js";

export interface ProfileResult {
  /** The profile recorded; undefined when only the validation level was given, and none is. */
  readonly profile: Profile | undefined;
  /** Profile found before the command, if any. */
  readonly previous: Profile | undefined;
  readonly action: "updated" | "unchanged";
  /**
   * The validation level after the command, and before it (undefined: absent, so
   * `chat`). Present when `method.yaml` holds one or the command gave one.
   */
  readonly validation?: {
    readonly mode: ValidationMode;
    readonly previous: ValidationMode | undefined;
  };
  /**
   * The installs mode after the command, and before it (undefined: absent, so
   * `validate`). Present when `method.yaml` holds one or the command gave one.
   */
  readonly installs?: {
    readonly mode: InstallMode;
    readonly previous: InstallMode | undefined;
  };
  /**
   * The points the creator keeps for themselves after the command, and before it
   * (undefined: not chosen yet, every point waited for them). Present when `method.yaml` holds
   * some or the command gave some.
   */
  readonly points?: {
    readonly points: readonly ValidationPoint[];
    readonly previous: readonly ValidationPoint[] | undefined;
  };
  /**
   * What the AI tool asks before it acts after the command, and before it (undefined:
   * absent, so `protected`). Present when `method.yaml` holds one or the command gave one.
   */
  readonly permissions?: {
    readonly mode: PermissionMode;
    readonly previous: PermissionMode | undefined;
  };
  /**
   * The creator's Git workflow after the command, and before it (undefined: none
   * chosen). Present when `method.yaml` holds one or the command gave one. `given` is true when
   * the command carried it, so that the caller records it in the journal.
   */
  readonly workflow?: {
    readonly workflow: GitWorkflow;
    readonly previous: GitWorkflow | undefined;
    readonly given: boolean;
  };
}

export interface ProfileState {
  /** True when `method.yaml` exists. */
  readonly installed: boolean;
  /** Recorded profile; undefined for a file written before profiles existed. */
  readonly profile: Profile | undefined;
  /** Recorded validation level; undefined when absent (`chat` applies). */
  readonly validation?: ValidationMode | undefined;
  /** Recorded installs mode; undefined when absent (`validate` applies). */
  readonly installs?: InstallMode | undefined;
  /** The points the creator keeps; undefined when they have not chosen. */
  readonly points?: readonly ValidationPoint[] | undefined;
  /** The Git workflow the creator chose; undefined when they have not chosen. */
  readonly git?: GitWorkflow | undefined;
  /** The AI tools `sync` generates for (the `tools` of `method.yaml`); undefined when not recorded. */
  readonly tools?: readonly ToolId[] | undefined;
  /** What the AI tool asks before it acts; undefined when absent (`protected`). */
  readonly permissions?: PermissionMode | undefined;
}

/** What `method.yaml` says about the profile and the validation level. An invalid file is reported. */
export async function readProfile(
  files: WorkspaceFiles,
): Promise<ProfileState | AgentPluggedError> {
  if (!(await files.exists(METHOD_CONFIG_PATH))) return { installed: false, profile: undefined };
  const loaded = await loadMethodConfig(files);
  return loaded instanceof AgentPluggedError
    ? loaded
    : {
        installed: true,
        profile: loaded.config.profile,
        validation: loaded.config.validation?.mode,
        installs: loaded.config.installs?.mode,
        points: loaded.config.validation?.points,
        git: loaded.config.git,
        tools: loaded.config.tools,
        permissions: loaded.config.permissions?.mode,
      };
}

function sameProfile(a: Profile, b: Profile): boolean {
  const key = (p: Profile) =>
    JSON.stringify([p.preset, p.domains, p.phases, p.specialties, p.max_parallel_stories ?? null]);
  return key(a) === key(b);
}

/** True when the recorded points are the ones chosen (the same set; absent is not chosen). */
function samePoints(
  recorded: readonly ValidationPoint[] | undefined,
  chosen: readonly ValidationPoint[],
): boolean {
  return (
    recorded !== undefined &&
    recorded.length === chosen.length &&
    chosen.every((point) => recorded.includes(point))
  );
}

export function methodNotInstalled(): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.METHOD_NOT_INSTALLED, "error.method_not_installed", {
    path: METHOD_CONFIG_PATH,
  });
}

/**
 * Records a new profile (`input.profile`) and,, the validation level
 * (`input.validation`: `chat`, `auto` or `strict`) and,, the installs mode
 * (`input.installs`: `visible` or `validate`). Any may come alone; without a profile, the
 * recorded one is kept. Only `method.yaml` is touched.
 */
export const profileCommand = defineCommand<ProfileResult>({
  name: "profile",
  async run({ files }, input) {
    if (
      input.profile === undefined &&
      input.validation === undefined &&
      input.installs === undefined &&
      input.points === undefined &&
      input.workflow === undefined &&
      input.permissions === undefined
    ) {
      return fail(
        new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
          reason: "profile",
        }),
      );
    }
    if (!(await files.exists(METHOD_CONFIG_PATH))) {
      return fail(methodNotInstalled());
    }
    const loaded = await loadMethodConfig(files);
    if (loaded instanceof AgentPluggedError) return fail(loaded);
    const previous = loaded.config.profile;
    const given = input.profile ?? previous;
    // A file from before the profiles: the validation level alone is written all the same.
    const profile = given === undefined ? undefined : validateProfile(given);
    if (profile instanceof AgentPluggedError) return fail(profile);
    const mode =
      input.validation === undefined ? undefined : validateValidationMode(input.validation);
    if (mode instanceof AgentPluggedError) return fail(mode);
    const installMode =
      input.installs === undefined ? undefined : validateInstallMode(input.installs);
    if (installMode instanceof AgentPluggedError) return fail(installMode);
    const chosenPoints = input.points === undefined ? undefined : validatePoints(input.points);
    if (chosenPoints instanceof AgentPluggedError) return fail(chosenPoints);
    const chosenWorkflow =
      input.workflow === undefined ? undefined : validateGitWorkflow(input.workflow);
    if (chosenWorkflow instanceof AgentPluggedError) return fail(chosenWorkflow);
    const chosenPermissions =
      input.permissions === undefined ? undefined : validatePermissionMode(input.permissions);
    if (chosenPermissions instanceof AgentPluggedError) return fail(chosenPermissions);
    const previousPermissions = loaded.config.permissions?.mode;
    const previousWorkflow = loaded.config.git;
    const previousPoints = loaded.config.validation?.points;
    const previousInstalls = loaded.config.installs?.mode;
    const previousMode = loaded.config.validation?.mode;
    const validation =
      mode === undefined
        ? previousMode === undefined
          ? {}
          : { validation: { mode: previousMode, previous: previousMode } }
        : { validation: { mode, previous: previousMode } };
    const installs =
      installMode === undefined
        ? previousInstalls === undefined
          ? {}
          : { installs: { mode: previousInstalls, previous: previousInstalls } }
        : { installs: { mode: installMode, previous: previousInstalls } };

    const points =
      chosenPoints === undefined
        ? previousPoints === undefined
          ? {}
          : { points: { points: previousPoints, previous: previousPoints } }
        : { points: { points: chosenPoints, previous: previousPoints } };

    // Same values as recorded (validation guarantees `agents.inactive` matches them): the file is
    // left untouched, even when its layout differs from what would be written.
    let text = loaded.text;
    if (profile !== undefined && (previous === undefined || !sameProfile(previous, profile))) {
      const written = writeProfile(text, profile);
      if (written instanceof AgentPluggedError) return fail(written);
      text = written;
    }
    // Absent is `chat`: choosing `chat` then changes nothing, and the file is left as is.
    if (mode !== undefined && mode !== (previousMode ?? DEFAULT_VALIDATION_MODE)) {
      const written = writeValidationMode(text, mode);
      if (written instanceof AgentPluggedError) return fail(written);
      text = written;
    }
    // Absent is `validate`: choosing `validate` then changes nothing.
    if (installMode !== undefined && installMode !== (previousInstalls ?? DEFAULT_INSTALL_MODE)) {
      const written = writeInstallMode(text, installMode);
      if (written instanceof AgentPluggedError) return fail(written);
      text = written;
    }
    // The points, written in the catalog's order; the same set again changes nothing.
    if (chosenPoints !== undefined && !samePoints(previousPoints, chosenPoints)) {
      const written = writePoints(text, chosenPoints);
      if (written instanceof AgentPluggedError) return fail(written);
      text = written;
    }
    // The Git workflow, whole; the same one again changes nothing.
    if (chosenWorkflow !== undefined && !sameGitWorkflow(previousWorkflow, chosenWorkflow)) {
      const written = writeGitWorkflow(text, chosenWorkflow);
      if (written instanceof AgentPluggedError) return fail(written);
      text = written;
    }
    // Absent is `protected`; choosing `protected` then changes nothing.
    if (
      chosenPermissions !== undefined &&
      chosenPermissions !== (previousPermissions ?? DEFAULT_PERMISSION_MODE)
    ) {
      const written = writePermissionMode(text, chosenPermissions);
      if (written instanceof AgentPluggedError) return fail(written);
      text = written;
    }
    const permissions =
      chosenPermissions === undefined
        ? previousPermissions === undefined
          ? {}
          : { permissions: { mode: previousPermissions, previous: previousPermissions } }
        : { permissions: { mode: chosenPermissions, previous: previousPermissions } };
    const workflowResult =
      chosenWorkflow === undefined
        ? previousWorkflow === undefined
          ? {}
          : {
              workflow: {
                workflow: previousWorkflow,
                previous: previousWorkflow,
                given: false,
              },
            }
        : {
            workflow: { workflow: chosenWorkflow, previous: previousWorkflow, given: true },
          };
    if (text === loaded.text) {
      return ok({
        profile,
        previous,
        action: "unchanged",
        ...validation,
        ...installs,
        ...points,
        ...permissions,
        ...workflowResult,
      });
    }
    await files.writeText(METHOD_CONFIG_PATH, text);
    return ok({
      profile,
      previous,
      action: "updated",
      ...validation,
      ...installs,
      ...points,
      ...permissions,
      ...workflowResult,
    });
  },
});
