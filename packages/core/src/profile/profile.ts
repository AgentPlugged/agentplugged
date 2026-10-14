import {
  type DeveloperSpecialty,
  type DomainId,
  INSTALL_MODES,
  type InstallMode,
  PERMISSION_MODES,
  type PermissionMode,
  type PhaseId,
  type Profile,
  ProfileSchema,
  VALIDATION_MODES,
  VALIDATION_POINTS,
  type ValidationMode,
  type ValidationPoint,
} from "@agentplugged/protocol";
import { AgentPluggedError } from "../errors.js";
import {
  editedMethodText,
  methodConfigInvalid,
  openMethodDocument,
} from "../init/method-config.js";
import {
  DEVELOPER_SPECIALTIES,
  DOMAIN_IDS,
  inactiveAgents,
  PHASE_IDS,
  PROFILE_PRESETS,
  type ProfilePresetId,
} from "./catalog.js";

/** What the creator changed on top of a preset. Omitted fields keep the preset's values. */
export interface ProfileAdjustments {
  readonly domains?: readonly DomainId[];
  readonly phases?: readonly PhaseId[];
  /**
   * Omitted: the preset's specialties, none without `code`, and `backend` and `frontend` when
   * `code` is on and the preset has none.
   */
  readonly specialties?: readonly DeveloperSpecialty[];
  /** The ceiling of stories built at once; omitted: none. */
  readonly max_parallel_stories?: number;
}

/** Catalog order, without duplicates. */
function ordered<T extends string>(catalog: readonly T[], values: readonly T[]): T[] {
  return catalog.filter((value) => values.includes(value));
}

/** The specialties a preset turns on with `code`: its own, or backend and frontend. */
function defaultSpecialties(preset: ProfilePresetId): readonly DeveloperSpecialty[] {
  const own = PROFILE_PRESETS[preset].specialties;
  return own.length > 0 ? own : ["backend", "frontend"];
}

/**
 * The profile obtained from a preset and the creator's adjustments. Explicit specialties are kept
 * as given: a list inconsistent with `code` is reported by validation (`profile.specialties`).
 */
export function resolveProfile(
  preset: ProfilePresetId,
  adjustments: ProfileAdjustments = {},
): Profile {
  const spec = PROFILE_PRESETS[preset];
  const domains = ordered(DOMAIN_IDS, adjustments.domains ?? spec.domains);
  const phases = ordered(PHASE_IDS, adjustments.phases ?? spec.phases);
  const specialties = ordered(
    DEVELOPER_SPECIALTIES,
    adjustments.specialties ?? (domains.includes("code") ? defaultSpecialties(preset) : []),
  );
  const ceiling = adjustments.max_parallel_stories;
  return {
    preset,
    domains,
    phases,
    specialties,
    ...(ceiling === undefined ? {} : { max_parallel_stories: ceiling }),
  };
}

/** Validates a profile given by a caller; the error points at `profile.<field>`. */
export function validateProfile(profile: unknown): Profile | AgentPluggedError {
  const result = ProfileSchema.safeParse(profile);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = ["profile", ...(issue?.path ?? []).map(String)];
  return methodConfigInvalid(path.join("."), issue?.message ?? "invalid");
}

/** Validates a validation level given by a caller; the error points at `validation.mode`. */
export function validateValidationMode(mode: unknown): ValidationMode | AgentPluggedError {
  return typeof mode === "string" && (VALIDATION_MODES as readonly string[]).includes(mode)
    ? (mode as ValidationMode)
    : methodConfigInvalid("validation.mode", `expected one of ${VALIDATION_MODES.join(", ")}`);
}

/** Validates an installs mode given by a caller; the error points at `installs.mode`. */
export function validateInstallMode(mode: unknown): InstallMode | AgentPluggedError {
  return typeof mode === "string" && (INSTALL_MODES as readonly string[]).includes(mode)
    ? (mode as InstallMode)
    : methodConfigInvalid("installs.mode", `expected one of ${INSTALL_MODES.join(", ")}`);
}

/** Validates a permission mode given by a caller; the error points at `permissions.mode`. */
export function validatePermissionMode(mode: unknown): PermissionMode | AgentPluggedError {
  return typeof mode === "string" && (PERMISSION_MODES as readonly string[]).includes(mode)
    ? (mode as PermissionMode)
    : methodConfigInvalid("permissions.mode", `expected one of ${PERMISSION_MODES.join(", ")}`);
}

/**
 * Writes the permission mode (`permissions.mode`) into the text of `method.yaml`.
 * Comments and other keys are kept; the result is validated before being returned.
 */
export function writePermissionMode(
  text: string,
  mode: PermissionMode,
): string | AgentPluggedError {
  const document = openMethodDocument(text);
  if (document instanceof AgentPluggedError) return document;
  document.setIn(["permissions", "mode"], mode);
  return editedMethodText(document, text);
}

/**
 * Validates the points the creator keeps given by a caller: known points, each once;
 * the error points at `validation.points`. The result is in the catalog's order.
 */
export function validatePoints(points: unknown): ValidationPoint[] | AgentPluggedError {
  if (!Array.isArray(points)) {
    return methodConfigInvalid("validation.points", "expected a list of points");
  }
  const known: readonly string[] = VALIDATION_POINTS;
  const unknown = points.find((point) => typeof point !== "string" || !known.includes(point));
  if (unknown !== undefined) {
    return methodConfigInvalid(
      "validation.points",
      `expected points among ${VALIDATION_POINTS.join(", ")}`,
    );
  }
  if (new Set(points).size !== points.length) {
    return methodConfigInvalid("validation.points", "each point once");
  }
  return VALIDATION_POINTS.filter((point) => points.includes(point));
}

/**
 * Writes the points the creator keeps (`validation.points`) into the text of
 * `method.yaml`. Comments and other keys are kept; the result is validated before being returned.
 */
export function writePoints(
  text: string,
  points: readonly ValidationPoint[],
): string | AgentPluggedError {
  const document = openMethodDocument(text);
  if (document instanceof AgentPluggedError) return document;
  document.setIn(["validation", "points"], document.createNode([...points]));
  return editedMethodText(document, text);
}

/**
 * Writes the installs mode (`installs.mode`) into the text of `method.yaml`. Comments
 * and other keys are kept; the result is validated before being returned.
 */
export function writeInstallMode(text: string, mode: InstallMode): string | AgentPluggedError {
  const document = openMethodDocument(text);
  if (document instanceof AgentPluggedError) return document;
  document.setIn(["installs", "mode"], mode);
  return editedMethodText(document, text);
}

/**
 * Writes the validation level (`validation.mode`) into the text of `method.yaml`.
 * Comments and other keys are kept; the result is validated before being returned.
 */
export function writeValidationMode(
  text: string,
  mode: ValidationMode,
): string | AgentPluggedError {
  const document = openMethodDocument(text);
  if (document instanceof AgentPluggedError) return document;
  document.setIn(["validation", "mode"], mode);
  return editedMethodText(document, text);
}

/**
 * Writes the profile and the computed `agents.inactive` into the text of `method.yaml`. Comments
 * and other keys are kept; the result is validated before being returned.
 */
export function writeProfile(text: string, profile: Profile): string | AgentPluggedError {
  const valid = validateProfile(profile);
  if (valid instanceof AgentPluggedError) return valid;
  const document = openMethodDocument(text);
  if (document instanceof AgentPluggedError) return document;
  document.setIn(["profile", "preset"], valid.preset);
  document.setIn(["profile", "domains"], document.createNode([...valid.domains]));
  document.setIn(["profile", "phases"], document.createNode([...valid.phases]));
  document.setIn(["profile", "specialties"], document.createNode([...valid.specialties]));
  if (valid.max_parallel_stories === undefined) {
    document.deleteIn(["profile", "max_parallel_stories"]);
  } else {
    document.setIn(["profile", "max_parallel_stories"], valid.max_parallel_stories);
  }
  document.setIn(["agents", "inactive"], document.createNode(inactiveAgents(valid)));

  return editedMethodText(document, text);
}
