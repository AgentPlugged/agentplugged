import {
  DEFAULT_VALIDATION_MODE,
  type MethodConfig,
  type ValidationMode,
  type ValidationPoint,
  ValidationSettingsSchema,
} from "@agentplugged/protocol";
import { METHOD_CONFIG_PATH } from "../init/layout.js";
import type { MainBranchReader } from "../rules/main-branch.js";
import { methodSection } from "../rules/method-section.js";

/** The main branch's `validation` section could not be read: `strict` applies, by caution. */
export interface ValidationSettingsWarning {
  readonly kind: "main_validation_invalid";
  readonly branch: string;
}

/** The validation level in force, where it was read, and what went wrong reading it. */
export interface ResolvedValidationSettings {
  readonly mode: ValidationMode;
  /**
   * The points the creator keeps for themselves, or undefined while they have not
   * chosen: every point then waits for them. An unreadable section keeps every point too.
   */
  readonly points: readonly ValidationPoint[] | undefined;
  /** `main`: the main branch's `method.yaml`; `working_copy`: no main branch could be read. */
  readonly source: "main" | "working_copy";
  readonly warning: ValidationSettingsWarning | null;
  /**
   * The main branch read is the local one and it holds commits not published to the
   * remote (`ahead`): the settings apply, and Noah offers the creator to publish them. Null when
   * everything read is published.
   */
  readonly unpublished: UnpublishedMain | null;
}

/** The local main branch's commits the remote one lacks. */
export interface UnpublishedMain {
  readonly branch: string;
  readonly remote: string;
  readonly ahead: number;
}

/**
 * The `validation` section of a `method.yaml` text: undefined when absent, `"invalid"` when the
 * text or the section cannot be read.
 */
const validationOf = (text: string) => methodSection(text, "validation", ValidationSettingsSchema);

/**
 * The validation level in force, read like the rules: the main
 * branch's `method.yaml` (the local one when it holds commits not published yet) when one can be read (`chat` when it sets none); an unreadable section
 * there gives `strict` and a warning (failing closed: a level an agent might have broken never
 * loosens the checks). The working copy's only without a main branch, a reader, or when the read
 * fails (an invalid section there makes `method.yaml` itself invalid).
 */
export async function resolveValidationSettings(
  working: MethodConfig,
  reader: MainBranchReader | undefined,
): Promise<ResolvedValidationSettings> {
  if (reader !== undefined) {
    const read = await reader.read(METHOD_CONFIG_PATH).catch(() => undefined);
    if (read?.found === true) {
      const section = read.text === undefined ? undefined : validationOf(read.text);
      if (section === "invalid") {
        return {
          mode: "strict",
          points: undefined,
          source: "main",
          warning: { kind: "main_validation_invalid", branch: read.branch },
          unpublished: unpublishedOf(read),
        };
      }
      return {
        mode: section?.mode ?? DEFAULT_VALIDATION_MODE,
        points: section?.points,
        source: "main",
        warning: null,
        unpublished: unpublishedOf(read),
      };
    }
  }
  return {
    mode: working.validation?.mode ?? DEFAULT_VALIDATION_MODE,
    points: working.validation?.points,
    source: "working_copy",
    warning: null,
    unpublished: null,
  };
}

function unpublishedOf(read: {
  readonly branch: string;
  readonly unpublished?: { readonly remote: string; readonly ahead: number };
}): UnpublishedMain | null {
  return read.unpublished === undefined
    ? null
    : { branch: read.branch, remote: read.unpublished.remote, ahead: read.unpublished.ahead };
}
