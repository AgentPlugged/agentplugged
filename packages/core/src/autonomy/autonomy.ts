import {
  AUTONOMY_POINTS,
  AUTONOMY_PRESETS,
  type AutonomyDial,
  type AutonomyDialState,
  type AutonomyReading,
  autonomyDialOf,
  DEFAULT_INSTALL_MODE,
  DEFAULT_VALIDATION_MODE,
  type InstallMode,
  type MethodConfig,
  type ProductAutonomy,
  RULE_ACTIONS,
  type RuleAction,
  type RuleTable,
  type RuleValue,
  VALIDATION_POINTS,
  type ValidationMode,
  type ValidationPoint,
} from "@agentplugged/protocol";
import { resolveValidationSettings } from "../chat/validation-settings.js";
import { AgentPluggedError } from "../errors.js";
import { METHOD_CONFIG_PATH } from "../init/layout.js";
import { loadMethodConfig } from "../init/method-config.js";
import {
  validateInstallMode,
  validatePoints,
  validateValidationMode,
  writeInstallMode,
  writePoints,
  writeValidationMode,
} from "../profile/profile.js";
import type { MainBranchReader } from "../rules/main-branch.js";
import { resolveRules } from "../rules/resolve-rules.js";
import { allowedValues, ruleLocked, withDefaults } from "../rules/rule-table.js";
import { writeRule } from "../rules/rules-command.js";
import { resolveInstallSettings } from "../trust/install-settings.js";
import type { WorkspaceFiles } from "../workspace-files.js";

/**
 * The autonomy dial, on a product's files. The dial is a preset over settings the engine already
 * has (see `AUTONOMY_PRESETS`): this module only writes them with the engine's own writers and
 * reads them back; it holds no rule of its own. A notch never touches a locked rule, the commands
 * that erase data, the merge, the release or the publications.
 */

/** What the engine records now for the settings the dial moves. */
function recordedReading(config: MethodConfig): AutonomyReading {
  const rules = withDefaults(config.rules);
  return {
    mode: config.validation?.mode ?? DEFAULT_VALIDATION_MODE,
    installs: config.installs?.mode ?? DEFAULT_INSTALL_MODE,
    points: config.validation?.points,
    rules: { install_dependency: rules.install_dependency, internet: rules.internet },
  };
}

/** The text of `method.yaml` once the dial is on `dial`: every setting of the notch, nothing else. */
export function dialedText(
  text: string,
  config: MethodConfig,
  dial: AutonomyDial,
): string | AgentPluggedError {
  const preset = AUTONOMY_PRESETS[dial];
  const reading = recordedReading(config);
  let next = text;

  const mode = validateValidationMode(preset.mode);
  if (mode instanceof AgentPluggedError) return mode;
  if (mode !== reading.mode) {
    const written = writeValidationMode(next, mode);
    if (written instanceof AgentPluggedError) return written;
    next = written;
  }

  const installs = validateInstallMode(preset.installs);
  if (installs instanceof AgentPluggedError) return installs;
  if (installs !== reading.installs) {
    const written = writeInstallMode(next, installs);
    if (written instanceof AgentPluggedError) return written;
    next = written;
  }

  // The dial's own points follow the notch; every other point stays as it was, and a creator who
  // had not chosen yet keeps every point (the dial never hands the merge to the agents).
  const base: readonly ValidationPoint[] = reading.points ?? VALIDATION_POINTS;
  const wanted = VALIDATION_POINTS.filter((point) =>
    (AUTONOMY_POINTS as readonly string[]).includes(point)
      ? (preset.kept as readonly string[]).includes(point)
      : base.includes(point),
  );
  const points = validatePoints(wanted);
  if (points instanceof AgentPluggedError) return points;
  const same =
    reading.points !== undefined &&
    reading.points.length === points.length &&
    points.every((point) => reading.points?.includes(point));
  if (!same) {
    const written = writePoints(next, points);
    if (written instanceof AgentPluggedError) return written;
    next = written;
  }

  for (const [action, value] of Object.entries(preset.rules) as [RuleAction, RuleValue][]) {
    const written = writeRule(next, action, value);
    if (written instanceof AgentPluggedError) return written;
    next = written;
  }
  return next;
}

/** Moves the dial of the product in `files` to `dial`; says whether `method.yaml` changed. */
export async function setAutonomyDial(
  files: WorkspaceFiles,
  dial: AutonomyDial,
): Promise<{ readonly written: boolean } | AgentPluggedError> {
  const loaded = await loadMethodConfig(files);
  if (loaded instanceof AgentPluggedError) return loaded;
  const text = dialedText(loaded.text, loaded.config, dial);
  if (text instanceof AgentPluggedError) return text;
  if (text === loaded.text) return { written: false };
  await files.writeText(METHOD_CONFIG_PATH, text);
  return { written: true };
}

/**
 * Sets the rule of one kind of action. A locked action only takes its locked value, and the commands
 * that erase data are never allowed: anything else is refused (`RULE_LOCKED`), whoever asks.
 */
export async function setPermissionRule(
  files: WorkspaceFiles,
  action: RuleAction,
  value: RuleValue,
): Promise<{ readonly written: boolean } | AgentPluggedError> {
  if (!allowedValues(action).includes(value)) return ruleLocked(action, value);
  const loaded = await loadMethodConfig(files);
  if (loaded instanceof AgentPluggedError) return loaded;
  const text = writeRule(loaded.text, action, value);
  if (text instanceof AgentPluggedError) return text;
  if (text === loaded.text) return { written: false };
  await files.writeText(METHOD_CONFIG_PATH, text);
  return { written: true };
}

/** The recorded settings and what is in force, for the report. The proposal's marks are the machine's. */
export type AutonomyState = Omit<ProductAutonomy, "threshold" | "snoozed">;

function sameKept(
  a: readonly ValidationPoint[] | undefined,
  b: readonly ValidationPoint[] | undefined,
): boolean {
  const left = a ?? VALIDATION_POINTS;
  const right = b ?? VALIDATION_POINTS;
  return left.length === right.length && left.every((point) => right.includes(point));
}

/**
 * What `method.yaml` records for the dial, and, when the engine does not read it yet (it reads the
 * main branch), what is in force. An invalid file is an error the caller reports.
 */
export async function readAutonomyState(
  files: WorkspaceFiles,
  reader: MainBranchReader | undefined,
): Promise<AutonomyState | AgentPluggedError> {
  const loaded = await loadMethodConfig(files);
  if (loaded instanceof AgentPluggedError) return loaded;
  const { config } = loaded;
  const recorded = recordedReading(config);
  const resolved = await resolveRules(config, reader);
  const settings = await resolveValidationSettings(config, reader);
  const installs = await resolveInstallSettings(config, reader);
  const inForceReading: AutonomyReading = {
    mode: settings.mode,
    installs: installs.mode,
    points: settings.points,
    rules: {
      install_dependency: resolved.rules.install_dependency,
      internet: resolved.rules.internet,
    },
  };
  const rules = Object.fromEntries(
    RULE_ACTIONS.map((action) => [action, resolved.working[action]]),
  ) as RuleTable;
  const dial: AutonomyDialState = autonomyDialOf(recorded);
  const forceDial: AutonomyDialState = autonomyDialOf(inForceReading);
  const differing = RULE_ACTIONS.filter((action) => resolved.rules[action] !== rules[action]);
  const pending =
    forceDial !== dial ||
    differing.length > 0 ||
    settings.mode !== recorded.mode ||
    installs.mode !== recorded.installs ||
    !sameKept(settings.points, recorded.points);
  return {
    dial,
    mode: recorded.mode as ValidationMode,
    installs: recorded.installs as InstallMode,
    kept: [...(recorded.points ?? VALIDATION_POINTS)],
    rules,
    ...(pending
      ? {
          in_force: {
            dial: forceDial,
            rules: Object.fromEntries(differing.map((action) => [action, resolved.rules[action]])),
          },
        }
      : {}),
  };
}
